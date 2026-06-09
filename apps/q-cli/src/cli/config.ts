import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { discoverConfig } from "./config-discover.js";
import { ConfigStore } from "../config/store.js";
import { findProjectConfig, parseTomlFile } from "../config/resolver.js";
import { getByDotPath, setByDotPath } from "../config/merge.js";

/**
 * `q-cli config` — Configuration management.
 *
 * Sub-actions:
 *  - show   — Print the current merged configuration as TOML
 *  - show:raw — Print the raw config file content
 *  - edit   — Open the config file in $EDITOR
 *  - set    — Set a config value (dot-notation key=value) in session config
 *  - get    - Get a resolved config value (dot-notation key)
 *  - path   — Show the path to the config file
 */
export async function configCommand(
  action: string,
  options?: { key?: string; value?: string; file?: string },
): Promise<void> {
  const cwd = process.cwd();
  const discovery = discoverConfig(cwd);

  // Initialize ConfigStore for resolved config operations
  const store = ConfigStore.getInstance();
  if (!store.isInitialized) {
    store.initialize(cwd);
  }

  switch (action) {
    case "show": {
      const toml = store.serializeToToml();
      console.log(chalk.bold("Resolved configuration:"));
      if (store.getResolved().projectConfigPath) {
        console.log(chalk.dim(`  Project config: ${store.getResolved().projectConfigPath}`));
      }
      if (store.getResolved().userConfigPath) {
        console.log(chalk.dim(`  User config: ${store.getResolved().userConfigPath}`));
      }
      if (store.getResolved().sessionConfigPath) {
        console.log(chalk.dim(`  Session config: ${store.getResolved().sessionConfigPath}`));
      }
      console.log();
      console.log(toml);
      break;
    }

    case "show:raw": {
      if (!discovery.vDir) {
        console.log(chalk.yellow("⚠ No .q/ directory found. Run 'q-cli init' first."));
        return;
      }
      const configPath = resolve(discovery.vDir, "config.toml");
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, "utf-8");
        console.log(chalk.bold("Current configuration:"));
        console.log(chalk.dim(`  File: ${configPath}`));
        console.log();
        console.log(content);
      } else {
        console.log(chalk.yellow("⚠ No config.toml found. Run 'q-cli init' first."));
      }
      break;
    }

    case "edit": {
      if (!discovery.vDir) {
        console.log(chalk.yellow("⚠ No .q/ directory found. Run 'q-cli init' first."));
        return;
      }
      const configPath = resolve(discovery.vDir, "config.toml");
      const editor = process.env.EDITOR ?? process.env.VISUAL ?? "nano";
      console.log(chalk.dim(`  Opening ${configPath} with ${editor}...`));
      const { execSync } = await import("node:child_process");
      try {
        execSync(`${editor} "${configPath}"`, { stdio: "inherit" });
        console.log(chalk.green("✓ Configuration saved."));
        // Reload config store
        store.reload();
        console.log(chalk.dim("  Config reloaded with hot-reload."));
      } catch {
        console.log(chalk.yellow("⚠ Editor exited with error."));
      }
      break;
    }

    case "set": {
      if (!options?.key) {
        console.log(chalk.red("✗ Usage: q-cli config set <key> <value>"));
        console.log(chalk.dim("  Example: q-cli config set providers.openai.apiKey sk-..."));
        console.log(chalk.dim("  This writes to .q/session.toml (session-level override)."));
        return;
      }
      if (!discovery.vDir) {
        console.log(chalk.yellow("⚠ No .q/ directory found. Run 'q-cli init' first."));
        return;
      }

      // Parse the value (try JSON first, fall back to string)
      let parsedValue: unknown = options.value ?? "";
      if (options.value) {
        try {
          parsedValue = JSON.parse(options.value);
        } catch {
          parsedValue = options.value;
        }
      }

      try {
        const config = store.setSessionValue(options.key, parsedValue);
        console.log(chalk.green(`✓ ${options.key} = ${JSON.stringify(parsedValue)}`));
        console.log(chalk.dim("  Written to .q/session.toml (session-level override)."));
      } catch (err) {
        console.log(chalk.red(`✗ Failed to set config value: ${(err as Error).message}`));
      }
      break;
    }

    case "get": {
      if (!options?.key) {
        console.log(chalk.red("✗ Usage: q-cli config get <key>"));
        console.log(chalk.dim("  Example: q-cli config get providers.openai.apiKey"));
        return;
      }
      const value = store.getByPath(options.key);
      if (value === undefined) {
        console.log(chalk.yellow(`⚠ Key '${options.key}' not found in resolved config.`));
      } else {
        console.log(JSON.stringify(value, null, 2));
      }
      break;
    }

    case "path": {
      if (!discovery.vDir) {
        console.log(chalk.yellow("⚠ No .q/ directory found."));
        return;
      }
      console.log(resolve(discovery.vDir, "config.toml"));
      break;
    }

    default:
      console.log(chalk.red(`✗ Unknown config action: ${action}`));
      console.log(chalk.dim("  Available actions: show, show:raw, edit, set, get, path"));
  }
}

/**
 * Register the `q-cli config` command with Commander.
 */
export function registerConfigCommand(prog: Command): void {
  prog
    .command("config")
    .description("Manage configuration")
    .argument("<action>", "Action: show | show:raw | edit | set | get | path")
    .option("--key <key>", "Configuration key (dot notation, e.g. providers.openai.apiKey)")
    .option("--value <value>", "Configuration value")
    .action(async (action: string, opts: { key?: string; value?: string; file?: string }) => {
      await configCommand(action, opts).catch((err: Error) => {
        console.error(chalk.red("Config command error:"), err.message);
        process.exit(1);
      });
    });
}
