import { accessSync, constants, readFileSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";

/**
 * Configuration discovery result.
 */
export interface ConfigDiscovery {
  /** Path to the discovered .q/ directory, or null */
  vDir: string | null;
  /** Resolved project root */
  projectRoot: string;
  /** Whether the project is a Qode-initialized project */
  initialized: boolean;
}

/**
 * Walk up from `cwd` to find the nearest `.q/` directory.
 * Returns the directory path and whether it has a config.toml.
 */
export function discoverConfig(cwd: string): ConfigDiscovery {
  let current = resolve(cwd);

  while (true) {
    const vDir = resolve(current, ".q");
    try {
      accessSync(vDir, constants.R_OK);
      const configToml = resolve(vDir, "config.toml");
      let initialized = false;
      try {
        accessSync(configToml, constants.R_OK);
        initialized = true;
      } catch {
        // config.toml doesn't exist yet
      }
      return { vDir, projectRoot: current, initialized };
    } catch {
      // No .q/ here
    }

    const parent = dirname(current);
    if (parent === current) {
      return { vDir: null, projectRoot: cwd, initialized: false };
    }
    current = parent;
  }
}

/**
 * Get the user-global Qode home directory ($HOME/.Q).
 */
export function getQHome(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? resolve(sep, "home");
  return resolve(home, ".Q");
}

/**
 * Load the project-level .q/config.toml if it exists.
 */
export function loadProjectConfig(vDir: string): Record<string, unknown> | null {
  try {
    const configPath = resolve(vDir, "config.toml");
    const raw = readFileSync(configPath, "utf-8");
    return { _raw: raw, _path: configPath };
  } catch {
    return null;
  }
}