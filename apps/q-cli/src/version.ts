/**
 * Read the CLI version from package.json at runtime.
 * Falls back to "0.0.0-dev" if the file can't be found.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

export function getCliVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    // Try multiple locations for the package.json
    const candidates = [
      // When running from dist/ (bundled)
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
      // When running from src/ (dev mode via tsx)
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
      // When installed globally via npm
      resolve(process.cwd(), "node_modules", "@qode-agent", "cli", "package.json"),
    ];

    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg.version) {
          cachedVersion = pkg.version;
          return cachedVersion;
        }
      }
    }
  } catch {
    // fall through
  }

  cachedVersion = "0.0.0-dev";
  return cachedVersion;
}
