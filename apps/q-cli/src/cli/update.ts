import chalk from "chalk";
import type { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getQHome } from "./config-discover.js";

/**
 * `q-cli update` — Check for updates against CDN.
 *
 * Reads the current version from package.json, checks the
 * Qode CDN manifest for a newer version, and displays the result.
 */
export async function updateCommand(): Promise<void> {
  const currentVersion = "0.1.0";
  const updateCacheDir = resolve(getQHome(), "cache");
  const updateCacheFile = resolve(updateCacheDir, "update-check.json");

  console.log(chalk.bold("Qode — Update Check"));
  console.log();
  console.log(chalk.dim(`  Current version: v${currentVersion}`));

  // Read cached update info
  let cached: { version?: string; checkedAt?: string } = {};
  try {
    const cachedRaw = readFileSync(updateCacheFile, "utf-8");
    cached = JSON.parse(cachedRaw);
  } catch {
    // No cached update info
  }

  // Check for updates from CDN
  const cdnUrl = "https://v.sh/api/latest-version";

  try {
    const response = await fetch(cdnUrl);
    if (response.ok) {
      const data = (await response.json()) as { version: string };
      const latestVersion = data.version;

      if (latestVersion !== currentVersion) {
        console.log(chalk.green(`\n  ✓ Update available: v${latestVersion}`));
        console.log(chalk.cyan(`  Run: curl -fsSL https://v.sh/install.sh | bash`));
      } else {
        console.log(chalk.dim("\n  ✓ You're on the latest version."));
      }

      // Cache the result
      try {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(updateCacheDir, { recursive: true });
        writeFileSync(updateCacheFile, JSON.stringify({ version: latestVersion, checkedAt: new Date().toISOString() }), "utf-8");
      } catch {
        // Cache write failure is non-critical
      }
    } else {
      console.log(chalk.yellow("\n  ⚠ Could not check for updates."));
      if (cached.version) {
        console.log(chalk.dim(`  Last known version: v${cached.version}`));
        console.log(chalk.dim(`  Checked at: ${cached.checkedAt}`));
      }
    }
  } catch {
    console.log(chalk.yellow("\n  ⚠ Network error checking for updates."));
    if (cached.version) {
      console.log(chalk.dim(`  Last known version: v${cached.version}`));
    }
  }
}

/**
 * Register the `q-cli update` command with Commander.
 */
export function registerUpdateCommand(prog: Command): void {
  prog
    .command("update")
    .description("Check for updates to V")
    .action(async () => {
      await updateCommand().catch((err: Error) => {
        console.error(chalk.red("Update command error:"), err.message);
        process.exit(1);
      });
    });
}
