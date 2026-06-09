/**
 * Config — ConfigStore singleton with change events.
 *
 * Provides a cached resolved config in memory with event emitter
 * for hot-reload notifications.
 */
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import {
  resolveConfig,
  writeSessionConfig,
  readSessionConfig,
  type ResolvedConfig,
} from "./resolver.js";
import { deepClone, getByDotPath, setByDotPath } from "./merge.js";
import type { VConfig } from "./schema.js";
import { stringify } from "smol-toml";

/**
 * Events emitted by ConfigStore.
 */
export interface ConfigStoreEvents {
  /** Fired when the resolved config changes (after hot-reload). */
  change: (config: VConfig, changedKeys: string[]) => void;
  /** Fired when a specific key changes. */
  "change:key": (key: string, value: unknown) => void;
}

/**
 * ConfigStore — Singleton in-memory cache of the resolved config.
 *
 * Usage:
 * ```ts
 * const store = ConfigStore.getInstance();
 * store.initialize(cwd);
 * const config = store.get();
 * ```
 */
export class ConfigStore {
  private static instance: ConfigStore | null = null;

  private _config: VConfig | null = null;
  private _resolved: ResolvedConfig | null = null;
  private _cwd: string | null = null;
  private _initialized = false;
  private _emitter = new EventEmitter();

  private constructor() {
    // Singleton — use getInstance()
  }

  /**
   * Get the ConfigStore singleton.
   */
  static getInstance(): ConfigStore {
    if (!ConfigStore.instance) {
      ConfigStore.instance = new ConfigStore();
    }
    return ConfigStore.instance;
  }

  /**
   * Reset the singleton (useful for testing).
   */
  static resetInstance(): void {
    ConfigStore.instance = null;
  }

  /**
   * Initialize the store by resolving config from the given cwd.
   */
  initialize(cwd?: string): ResolvedConfig {
    this._cwd = cwd ?? process.cwd();
    this._resolved = resolveConfig(this._cwd);
    this._config = deepClone(this._resolved.config);
    this._initialized = true;
    return this._resolved;
  }

  /**
   * Re-resolve the config (e.g., after a file change).
   * Returns the list of changed dot-notation keys.
   */
  reload(): ResolvedConfig {
    if (!this._cwd) {
      throw new Error("ConfigStore not initialized. Call initialize() first.");
    }

    const previousConfig = this._config;
    this._resolved = resolveConfig(this._cwd);
    this._config = deepClone(this._resolved.config);

    if (previousConfig) {
      const changedKeys = this.diffConfigs(previousConfig, this._config);
      if (changedKeys.length > 0) {
        this._emitter.emit("change", this._config, changedKeys);
        for (const key of changedKeys) {
          const value = getByDotPath(this._config as unknown as Record<string, unknown>, key);
          this._emitter.emit("change:key", key, value);
        }
      }
    }

    return this._resolved;
  }

  /**
   * Get the current resolved config.
   */
  get(): VConfig {
    if (!this._config) {
      throw new Error("ConfigStore not initialized. Call initialize() first.");
    }
    return this._config;
  }

  /**
   * Get the resolved config with metadata.
   */
  getResolved(): ResolvedConfig {
    if (!this._resolved) {
      throw new Error("ConfigStore not initialized. Call initialize() first.");
    }
    return this._resolved;
  }

  /**
   * Get a specific config value by dot-notation path.
   */
  getByPath(key: string): unknown {
    if (!this._config) {
      throw new Error("ConfigStore not initialized. Call initialize() first.");
    }
    return getByDotPath(this._config as unknown as Record<string, unknown>, key);
  }

  /**
   * Get the working directory used for config resolution.
   */
  getCwd(): string | null {
    return this._cwd;
  }

  /**
   * Whether the store has been initialized.
   */
  get isInitialized(): boolean {
    return this._initialized;
  }

  // ─── Event emitter ──────────────────────────────────────────────────────

  on<K extends keyof ConfigStoreEvents>(
    event: K,
    listener: ConfigStoreEvents[K],
  ): this {
    this._emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof ConfigStoreEvents>(
    event: K,
    listener: ConfigStoreEvents[K],
  ): this {
    this._emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  // ─── Mutation (session config) ───────────────────────────────────────────

  /**
   * Write a config value to the session config file.
   * Returns the updated merged config.
   */
  setSessionValue(key: string, value: unknown): VConfig {
    if (!this._resolved) {
      throw new Error("ConfigStore not initialized. Call initialize() first.");
    }

    const projectConfigPath = this._resolved.projectConfigPath;
    if (!projectConfigPath) {
      throw new Error("No project config found. Run 'q-cli init' first.");
    }

    const vDir = dirname(projectConfigPath);

    // Build the nested update object from dot-notation key
    const update: Record<string, unknown> = {};
    setByDotPath(update, key, value);

    // Write to session config
    writeSessionConfig(vDir, update);

    // Reload the merged config
    return this.reload().config;
  }

  /**
   * Get the session config as a raw record.
   */
  getSessionConfig(): Record<string, unknown> {
    if (!this._resolved?.projectConfigPath) {
      return {};
    }
    const vDir = dirname(this._resolved.projectConfigPath);
    return readSessionConfig(vDir);
  }

  /**
   * Serialize the full merged config to TOML string.
   */
  serializeToToml(): string {
    if (!this._config) {
      return "";
    }
    // Strip the `raw` catch-all since it contains unrecognized keys
    const { raw: _raw, ...configForSerialization } = this._config as unknown as Record<string, unknown>;
    return stringify(configForSerialization as Record<string, unknown>);
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  /**
   * Diff two configs and return dot-notation keys that changed.
   * Uses JSON-stringify comparison for object values to correctly
   * detect deep (and shallow) object equality.
   */
  private diffConfigs(oldCfg: VConfig, newCfg: VConfig): string[] {
    const changed: string[] = [];
    this.deepDiff(
      oldCfg as unknown as Record<string, unknown>,
      newCfg as unknown as Record<string, unknown>,
      "",
      changed,
    );
    return changed;
  }

  private deepDiff(
    oldObj: Record<string, unknown>,
    newObj: Record<string, unknown>,
    prefix: string,
    changed: string[],
  ): void {
    const allKeys = new Set([
      ...Object.keys(oldObj),
      ...Object.keys(newObj),
    ]);

    for (const key of allKeys) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      const oldVal = oldObj[key];
      const newVal = newObj[key];

      // Deep equality check via JSON stringify for objects/arrays
      if (typeof oldVal === "object" && typeof newVal === "object") {
        if (JSON.stringify(oldVal) === JSON.stringify(newVal)) {
          continue;
        }
        // Both are plain objects → recurse
        if (isPlainObject(oldVal) && isPlainObject(newVal)) {
          this.deepDiff(
            oldVal as Record<string, unknown>,
            newVal as Record<string, unknown>,
            fullKey,
            changed,
          );
        } else {
          changed.push(fullKey);
        }
      } else if (oldVal !== newVal) {
        changed.push(fullKey);
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return false;
  if (typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
