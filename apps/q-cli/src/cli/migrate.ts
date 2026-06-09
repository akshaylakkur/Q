import chalk from "chalk";
import type { Command } from "commander";
import { getQHome } from "./config-discover.js";
import { existsSync, readdirSync, copyFileSync, cpSync, statSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `q-cli migrate` — Migration from kimi-code / V format.
 *
 * Copies data from ~/.kimi/ or ~/.V/ to $HOME/.Q/ preserving:
 *  - Config (kimi.toml / config.toml)
 *  - Sessions
 *  - Skills
 */
export async function migrateCommand(): Promise<void> {
  const targetDir = getQHome();

  console.log(chalk.bold("Qode — Migration"));
  console.log();

  // ── Try source candidates ─────────────────────────────────────
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/home";
  const candidates = [
    // Check V first (more recent active config), then kimi-code (legacy)
    { path: resolve(home, ".V"), label: "V" },
    { path: resolve(home, ".kimi"), label: "kimi-code" },
  ];

  const source = candidates.find((c) => existsSync(c.path));
  if (!source) {
    console.log(chalk.yellow("⚠ No ~/.kimi/ or ~/.V/ directory found."));
    console.log(chalk.dim("  Nothing to migrate."));
    return;
  }

  console.log(chalk.cyan("  Source:"), `${source.path} (${source.label})`);
  console.log(chalk.cyan("  Target:"), targetDir);
  console.log();

  // Ensure target directory exists
  mkdirSync(targetDir, { recursive: true });

  // Migrate config
  const legacyConfigNames = ["kimi.toml", "config.toml"];
  for (const name of legacyConfigNames) {
    const src = resolve(source.path, name);
    if (existsSync(src)) {
      const dest = resolve(targetDir, "config.toml");
      copyFileSync(src, dest);
      console.log(chalk.green(`  ✓ Migrated ${name} → config.toml`));
      break;
    }
  }

  // Migrate sessions
  const sourceSessions = resolve(source.path, "sessions");
  if (existsSync(sourceSessions)) {
    const targetSessions = resolve(targetDir, "sessions");
    mkdirSync(targetSessions, { recursive: true });
    const entries = readdirSync(sourceSessions);
    let count = 0;
    for (const entry of entries) {
      const src = resolve(sourceSessions, entry);
      const dest = resolve(targetSessions, entry);
      try {
        if (statSync(src).isDirectory()) {
          cpSync(src, dest, { recursive: true });
        } else {
          copyFileSync(src, dest);
        }
        count++;
      } catch {
        // skip problematic entries
      }
    }
    console.log(chalk.green(`  ✓ Migrated ${count} session files`));
  }

  // Migrate skills
  const sourceSkills = resolve(source.path, "skills");
  if (existsSync(sourceSkills)) {
    const targetSkills = resolve(targetDir, "skills");
    mkdirSync(targetSkills, { recursive: true });
    try {
      const entries = readdirSync(sourceSkills);
      for (const entry of entries) {
        const src = resolve(sourceSkills, entry);
        const dest = resolve(targetSkills, entry);
        copyFileSync(src, dest);
      }
      console.log(chalk.green(`  ✓ Migrated ${entries.length} skills`));
    } catch {
      console.log(chalk.dim("  ⚡ Skills directory migrated as-is"));
    }
  }

  console.log();
  console.log(chalk.green("✓ Migration complete."));
  console.log(chalk.dim(`  Data from ${source.label} has been copied to ${targetDir}`));
  console.log(chalk.dim("  The original directory has been preserved."));
}

/**
 * Register the `q-cli migrate` command with Commander.
 */
export function registerMigrateCommand(prog: Command): void {
  prog
    .command("migrate")
    .description("Migrate settings from kimi-code or V format to Qode")
    .action(async () => {
      await migrateCommand().catch((err: Error) => {
        console.error(chalk.red("Migrate command error:"), err.message);
        process.exit(1);
      });
    });
}