/**
 * Config — TOML loading and parsing.
 *
 * Handles reading TOML files from disk, parsing with smol-toml,
 * and converting raw parsed objects to Zod-validated configs.
 *
 * @deprecated Use resolver.ts functions instead (resolveConfig, etc.)
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { DEFAULT_CONFIG_TOML } from "./defaults.js";
import { deepMerge, deepClone } from "./merge.js";
import {
  parseVConfig,
  type VConfig,
  type ConfigSource,
  ConfigTier,
} from "./schema.js";

/**
 * Parse and validate a raw TOML record into a VConfig.
 * Unknown keys are captured in the `raw` field.
 *
 * @param raw - The raw parsed TOML object
 * @returns A validated VConfig
 */
export function parseAndValidate(raw: Record<string, unknown>): VConfig {
  return parseVConfig(raw);
}

/**
 * Try to parse a config object, returning null on failure.
 *
 * @param raw - The raw parsed TOML object
 * @returns A validated VConfig, or null if parsing fails
 */
export function tryParseAndValidate(raw: Record<string, unknown>): VConfig | null {
  try {
    return parseVConfig(raw);
  } catch {
    return null;
  }
}

/**
 * Load the built-in defaults as a VConfig.
 */
export function loadDefaults(): VConfig {
  const raw = parseToml(DEFAULT_CONFIG_TOML) as Record<string, unknown>;
  return parseVConfig(raw);
}

/**
 * Load and parse a TOML file from disk.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function loadTomlFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");
    const parsed = parseToml(content);
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Write a VConfig (or partial record) to a TOML file.
 * Only writes the keys present in the record.
 */
export function writeTomlFile(
  filePath: string,
  data: Record<string, unknown>,
): void {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const toml = stringifyToml(data);
  writeFileSync(filePath, toml, "utf-8");
}

/**
 * Resolve user-global config path: $HOME/.Q/config.toml
 */
export function getUserConfigPath(homedir?: string): string {
  const home = homedir ?? process.env.HOME ?? process.env.USERPROFILE ?? "/home";
  return resolve(home, ".Q", "config.toml");
}

/**
 * Resolve project-level config path: <projectRoot>/.q/config.toml
 */
export function getProjectConfigPath(projectRoot: string): string {
  return resolve(projectRoot, ".v", "config.toml");
}

/**
 * Resolve session config path: <projectRoot>/.q/session.toml
 */
export function getSessionConfigPath(projectRoot: string): string {
  return resolve(projectRoot, ".v", "session.toml");
}

/**
 * Load all config sources for a given project root.
 * Returns sources in order from lowest to highest priority.
 */
export function loadAllSources(
  projectRoot: string,
  homedir?: string,
): ConfigSource[] {
  const sources: ConfigSource[] = [];

  // 1. Built-in defaults
  sources.push({
    tier: ConfigTier.Defaults,
    label: "built-in defaults",
    raw: parseToml(DEFAULT_CONFIG_TOML) as Record<string, unknown>,
  });

  // 2. User-global config
  const userPath = getUserConfigPath(homedir);
  const userRaw = loadTomlFile(userPath);
  if (userRaw) {
    sources.push({
      tier: ConfigTier.User,
      label: `user (${userPath})`,
      filePath: userPath,
      raw: userRaw,
    });
  }

  // 3. Project-level config
  const projectPath = getProjectConfigPath(projectRoot);
  const projectRaw = loadTomlFile(projectPath);
  if (projectRaw) {
    sources.push({
      tier: ConfigTier.Project,
      label: `project (${projectPath})`,
      filePath: projectPath,
      raw: projectRaw,
    });
  }

  // 4. Session-level config
  const sessionPath = getSessionConfigPath(projectRoot);
  const sessionRaw = loadTomlFile(sessionPath);
  if (sessionRaw) {
    sources.push({
      tier: ConfigTier.Session,
      label: `session (${sessionPath})`,
      filePath: sessionPath,
      raw: sessionRaw,
    });
  }

  return sources;
}

/**
 * Merge multiple config sources into a single raw record.
 * Sources are merged in order (later sources override earlier ones).
 */
export function mergeSources(sources: ConfigSource[]): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const source of sources) {
    merged = deepMerge(merged, deepClone(source.raw));
  }
  return merged;
}

/**
 * Full resolution: load all sources, merge them, and validate.
 * Returns the validated VConfig.
 */
export function resolveConfig(
  projectRoot: string,
  homedir?: string,
): VConfig {
  const sources = loadAllSources(projectRoot, homedir);
  const merged = mergeSources(sources);
  return parseVConfig(merged);
}
