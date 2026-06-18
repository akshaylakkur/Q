/**
 * Plugin CLI subcommand — `q-cli plugin install|remove|list`
 *
 * Manages plugins from the command line.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { PluginManager, type PluginStatus } from "@qode-agent/runtime";

/**
 * Register the `q-cli plugin` subcommand with Commander.
 */
export function registerPluginCommand(prog: Command): void {
  const pluginCmd = prog
    .command("plugin")
    .description("Manage plugins (install, remove, list)")
    .summary("Manage Qode plugins");

  pluginCmd
    .command("install <url-or-path>")
    .description("Install a plugin from a tarball URL or local directory")
    .action(async (source: string) => {
      try {
        const pm = await createPluginManagerForCli();
        const manifest = await pm.install(source);
        console.log(chalk.green(`✓ Installed plugin: ${manifest.name} v${manifest.version}`));
        console.log(chalk.dim(`  Type: ${manifest.type}`));
        console.log(chalk.dim(`  Description: ${manifest.description}`));
      } catch (err) {
        console.error(chalk.red("Install failed:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  pluginCmd
    .command("remove <name>")
    .alias("rm")
    .description("Remove an installed plugin")
    .action(async (name: string) => {
      try {
        const pm = await createPluginManagerForCli();
        await pm.remove(name);
        console.log(chalk.green(`✓ Removed plugin: ${name}`));
      } catch (err) {
        console.error(chalk.red("Remove failed:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  pluginCmd
    .command("list")
    .alias("ls")
    .description("List installed plugins")
    .action(async () => {
      try {
        const pm = await createPluginManagerForCli();
        await pm.activateAll();

        const statuses = pm.getStatus();
        if (statuses.length === 0) {
          console.log(chalk.dim("No plugins installed."));
          console.log(chalk.dim("Run 'q-cli plugin install <url>' to add one."));
          return;
        }

        // Table header
        console.log(
          [
            chalk.bold.white("Name".padEnd(20)),
            chalk.bold.white("Version".padEnd(10)),
            chalk.bold.white("Status".padEnd(10)),
            chalk.bold.white("Type".padEnd(8)),
            chalk.bold.white("Tools"),
          ].join(""),
        );

        // Table rows
        for (const p of statuses) {
          const statusBadge = formatStatusBadge(p.status);
          console.log(
            [
              chalk.white(p.name.padEnd(20)),
              chalk.dim(p.version.padEnd(10)),
              statusBadge.padEnd(10),
              chalk.dim(p.type.padEnd(8)),
              chalk.dim(String(p.toolCount)),
            ].join(""),
          );
        }

        // Summary line
        const active = statuses.filter((s) => s.status === "active").length;
        const error = statuses.filter((s) => s.status === "error").length;
        console.log();
        console.log(chalk.dim(`${statuses.length} plugin(s) — ${active} active, ${error} error`));
      } catch (err) {
        console.error(chalk.red("List failed:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

/**
 * Format a plugin status as a colored badge.
 */
function formatStatusBadge(status: PluginStatus["status"]): string {
  switch (status) {
    case "active":
      return chalk.green("● active");
    case "inactive":
      return chalk.gray("○ inactive");
    case "error":
      return chalk.red("○ error");
  }
}

/**
 * Create a minimal PluginManager for CLI-only execution.
 * Uses lazy dynamic imports to avoid bootstrapping the full TUI dependency chain.
 */
async function createPluginManagerForCli(): Promise<PluginManager> {
  // For CLI-only operations (install, remove, list), we create stub objects
  // since the full Agent/ToolManager/McpConnectionManager chain isn't available.
  const stubSkillRegistry = await createStubSkillRegistry();
  const stubMcpManager = await createStubMcpManager();
  const stubToolManager = await createStubToolManager();

  return new PluginManager(stubSkillRegistry, stubMcpManager, stubToolManager);
}

async function createStubSkillRegistry(): Promise<import("@qode-agent/runtime").SkillRegistry> {
  const { SkillRegistry } = await import("@qode-agent/runtime");
  return new SkillRegistry();
}

async function createStubMcpManager(): Promise<import("@qode-agent/runtime").McpConnectionManager> {
  const { McpConnectionManager } = await import("@qode-agent/runtime");
  return new McpConnectionManager();
}

async function createStubToolManager(): Promise<import("@q/agent-core").ToolManager> {
  const { ToolManager } = await import("@q/agent-core");
  const { LocalQmain } = await import("@q/qmain");
  const stubAgent = {
    runtime: { qmain: new LocalQmain() },
    config: { cwd: process.cwd(), model: "stub", systemPrompt: "", thinkingLevel: "none" as const },
    id: "stub-cli-agent",
    type: "root" as const,
    subagentHost: {} as any,
    backgroundManager: {
      list: () => [],
      readOutput: async () => ({ preview: "" }),
      stop: async () => {},
    },
    context: {} as any,
    turn: {} as any,
    permissionManager: {} as any,
    planMode: {} as any,
    usageRecorder: {} as any,
    records: {} as any,
    blobStore: undefined,
    injection: {} as any,
    skills: {} as any,
    mcp: {} as any,
    hooks: {} as any,
    telemetry: {} as any,
    configData: { type: "openai" },
    homedir: process.env.HOME ?? "/tmp",
  } as any;
  return new ToolManager(stubAgent);
}