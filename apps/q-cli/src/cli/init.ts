import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

/**
 * `q-cli init` — Initialize .q/ directory in the current project.
 *
 * Creates the project-level .q/ directory with:
 *  - .q/config.toml (default configuration)
 *  - .q/mcp.json (MCP server definitions)
 *  - .q/skills/ (project-specific skills directory)
 *  - .q/plugins/ (project-specific plugins directory)
 */
export async function initCommand(cwd: string): Promise<void> {
  const vDir = resolve(cwd, ".q");
  const configToml = resolve(vDir, "config.toml");
  const mcpJson = resolve(vDir, "mcp.json");
  const skillsDir = resolve(vDir, "skills");
  const pluginsDir = resolve(vDir, "plugins");

  // Check if already initialized
  if (existsSync(vDir)) {
    console.log(chalk.yellow("⚠ This project already has a .q/ directory."));
    console.log(chalk.dim("  Run 'q-cli doctor' to verify the setup."));
    console.log(chalk.dim("  Edit .q/config.toml to adjust configuration."));
    return;
  }

  // Create directory structure
  mkdirSync(vDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });

  // Default config.toml
  const defaultConfig = `# Qode Project Configuration
# ==========================
# This file is the project-level configuration for Qode.
# Settings here override user-global defaults in $HOME/.Q/config.toml.

[providers]
  # Add your LLM provider configurations here.
  # Example for OpenAI-compatible:
  # [providers.openai]
  # type = "openai"
  # apiKey = "sk-..."  # Or set Q_PROVIDER_OPENAI_API_KEY env var
  # baseUrl = "https://api.openai.com/v1"

[models]
  # Define model aliases for quick access.
  # [models.default]
  # provider = "openai"
  # name = "gpt-4o"
  # maxContextSize = 128000

[orchestrator]
  # maxParallelAgents = 8
  # defaultMode = "auto"
  # convergenceTimeout = 60000
  # taskTimeout = 300000

[memory]
  # episodicRecallMaxCount = 500
  # ltpmEnabled = true
  # compactionTriggerRatio = 0.75
`;

  writeFileSync(configToml, defaultConfig, "utf-8");

  // Default mcp.json
  const defaultMcp = JSON.stringify(
    {
      mcpServers: {
        // Example MCP server config:
        // "my-server": {
        //   type: "stdio",
        //   command: "npx",
        //   args: ["-y", "@modelcontextprotocol/server-filesystem"],
        // }
      },
    },
    null,
    2,
  );

  writeFileSync(mcpJson, defaultMcp + "\n", "utf-8");

  // Success output
  console.log(chalk.green("✓ Initialized project at " + resolve(cwd)));
  console.log();
  console.log(chalk.dim("  Created structure:"));
  console.log(chalk.dim("  .q/"));
  console.log(chalk.dim("  ├── config.toml     — Project configuration"));
  console.log(chalk.dim("  ├── mcp.json        — MCP server definitions"));
  console.log(chalk.dim("  ├── skills/         — Project-specific skills"));
  console.log(chalk.dim("  └── plugins/        — Project-specific plugins"));
  console.log();
  console.log(chalk.cyan("Next steps:"));
  console.log(chalk.dim("  1. Edit .q/config.toml to add your LLM provider API key"));
  console.log(chalk.dim("  2. Run q-cli doctor to verify your setup"));
  console.log(chalk.dim("  3. Run q-cli to start the interactive session"));
}

/**
 * Register the `q-cli init` command with Commander.
 */
export function registerInitCommand(prog: Command): void {
  prog
    .command("init")
    .description("Initialize .q/ directory in the current project")
    .option("--cwd <path>", "Working directory (defaults to current directory)")
    .action(async (opts: { cwd?: string }) => {
      const cwd = opts.cwd ?? process.cwd();
      await initCommand(cwd).catch((err: Error) => {
        console.error(chalk.red("Init command error:"), err.message);
        process.exit(1);
      });
    });
}
