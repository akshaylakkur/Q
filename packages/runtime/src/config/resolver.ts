/**
 * Config — Config file discovery and resolution.
 *
 * Walks up from cwd to find .q/config.toml, loads all four tiers,
 * and produces a merged VConfig.
 */
import { accessSync, constants, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseToml, stringify } from "smol-toml";
import {
  safeParseVConfig,
  type VConfig,
  type ConfigSource,
  ConfigTier,
} from "./schema.js";
import { deepMerge } from "./merge.js";
import { DEFAULT_CONFIG_TOML } from "./defaults.js";

/**
 * Result of config resolution.
 */
export interface ResolvedConfig {
  /** Fully merged configuration */
  config: VConfig;
  /** Sources that were merged (in order) */
  sources: ConfigSource[];
  /** Path to the project-level .q/config.toml (may be null) */
  projectConfigPath: string | null;
  /** Path to the user-global config (may be null) */
  userConfigPath: string | null;
  /** Path to the session-level config (may be null) */
  sessionConfigPath: string | null;
}

/**
 * Walk up from cwd to find the nearest `.q/config.toml`.
 *
 * @param cwd - The directory to start searching from
 * @returns The path to the project config file, or null if not found
 */
export function findProjectConfig(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const configPath = resolve(current, ".q", "config.toml");
    try {
      accessSync(configPath, constants.R_OK);
      return configPath;
    } catch {
      // not here
    }
    const parent = dirname(current);
    if (parent === current) break; // hit filesystem root
    current = parent;
  }
  return null;
}

/**
 * Get the user-global Qode config path ($HOME/.Q/config.toml).
 */
export function getUserConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/home";
  return resolve(home, ".Q", "config.toml");
}

/**
 * Get the session-level config path (<projectDir>/.q/session.toml).
 */
export function getSessionConfigPath(vDir: string): string {
  return resolve(vDir, "session.toml");
}

/**
 * Parse a TOML file from disk into a raw record.
 * Returns an empty object on parse failure.
 */
export function parseTomlFile(filePath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseToml(raw) as Record<string, unknown>;
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Load a single config tier from file.
 * If the file doesn't exist or is null, returns an empty source.
 */
export function loadConfigFile(
  filePath: string | null,
  tier: ConfigTier,
  label: string,
): ConfigSource {
  if (!filePath || !existsSync(filePath)) {
    return { tier, label, filePath: undefined, raw: {} };
  }
  const raw = parseTomlFile(filePath);
  return { tier, label, filePath, raw };
}

/**
 * Load the built-in defaults.
 */
export function loadDefaults(): ConfigSource {
  const parsed = parseToml(DEFAULT_CONFIG_TOML) as Record<string, unknown>;
  return { tier: ConfigTier.Defaults, label: "defaults", filePath: undefined, raw: parsed };
}

/**
 * Load all config tiers and merge them into a single VConfig.
 *
 * Resolution order (highest priority last):
 * 1. Built-in defaults
 * 2. User-global ($HOME/.Q/config.toml)
 * 3. Project-level (<cwd>/.q/config.toml)
 * 4. Session-level (<projectDir>/.q/session.toml)
 */
export function resolveConfig(cwd?: string): ResolvedConfig {
  const resolvedCwd = resolve(cwd ?? process.cwd());

  // 1. Built-in defaults
  const defaults = loadDefaults();

  // 2. User-global — loadConfigFile handles non-existent files
  const userConfigPath = getUserConfigPath();
  const userSource = loadConfigFile(userConfigPath, ConfigTier.User, "user");

  // 3. Project-level — walk up from cwd
  const projectConfigPath = findProjectConfig(resolvedCwd);
  const projectSource = loadConfigFile(projectConfigPath, ConfigTier.Project, "project");

  // 4. Session-level — only if project config exists
  let sessionConfigPath: string | null = null;
  if (projectConfigPath) {
    const vDir = dirname(projectConfigPath);
    sessionConfigPath = getSessionConfigPath(vDir);
  }
  const sessionSource = loadConfigFile(sessionConfigPath, ConfigTier.Session, "session");

  // Merge in order (later sources override earlier)
  const sources = [defaults, userSource, projectSource, sessionSource];
  const merged = sources.reduce<Record<string, unknown>>(
    (acc, source) => deepMerge(acc, source.raw),
    {},
  );

  // Validate with Zod
  const parseResult = safeParseVConfig(merged);

  let config: VConfig;
  if (parseResult.success) {
    config = parseResult.data;
  } else {
    // Fall back to defaults on validation failure, log the error
    const defaultsResult = safeParseVConfig(parseToml(DEFAULT_CONFIG_TOML) as Record<string, unknown>);
    config = defaultsResult.success
      ? defaultsResult.data
      : ({} as VConfig);
    console.error(
      `[V Config] Warning: Configuration validation failed: ${(parseResult.error as Error).message}`,
    );
  }

  return {
    config,
    sources,
    projectConfigPath,
    userConfigPath: existsSync(userConfigPath) ? userConfigPath : null,
    sessionConfigPath: sessionConfigPath && existsSync(sessionConfigPath) ? sessionConfigPath : null,
  };
}

/**
 * Write session config values to the session TOML file.
 * The vDir parameter should be the path to the .q/ directory.
 * Creates the .q/ directory if it doesn't exist.
 */
export function writeSessionConfig(
  vDir: string,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const sessionConfigPath = getSessionConfigPath(vDir);
  const dir = dirname(sessionConfigPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Read existing session config
  let current: Record<string, unknown> = {};
  if (existsSync(sessionConfigPath)) {
    current = parseTomlFile(sessionConfigPath);
  }

  // Deep-merge updates
  const merged = deepMerge(current, updates);

  // Serialize and write
  const tomlStr = stringify(merged as Record<string, unknown>);
  writeFileSync(sessionConfigPath, tomlStr, "utf-8");

  return merged;
}

/**
 * Read the session config.
 */
export function readSessionConfig(vDir: string): Record<string, unknown> {
  const sessionConfigPath = getSessionConfigPath(vDir);
  if (!existsSync(sessionConfigPath)) {
    return {};
  }
  return parseTomlFile(sessionConfigPath);
}
