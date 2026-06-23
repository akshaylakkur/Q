import chalk from "chalk";
import type { Command } from "commander";

/**
 * `q-cli connect` — Connect to a running daemon.
 *
 * Full implementation in Step 41.
 */
export async function connectCommand(
  url: string,
  options?: { name?: string; key?: string },
): Promise<void> {
  console.log(chalk.bold("V Connect"));
  console.log(chalk.dim("  Connecting to a running daemon — not yet implemented."));
  console.log();

  console.log(chalk.dim(`  Daemon URL: ${url}`));
  if (options?.name) {
    console.log(chalk.dim(`  Display name: ${options.name}`));
  }

  console.log();
  console.log(chalk.yellow("⚠ This command will be implemented in Step 41."));
}

/**
 * Register the `q-cli connect` command with Commander.
 */
export function registerConnectCommand(prog: Command): void {
  prog
    .command("connect")
    .description("Connect to a running daemon")
    .argument("<url>", "Daemon URL (unix socket path or http://host:port)")
    .option("--name <name>", "Your display name")
    .option("--key <key>", "Authentication key for the daemon")
    .action(async (url: string, opts: { name?: string; key?: string }) => {
      await connectCommand(url, opts).catch((err) => {
        console.error(chalk.red("Connect command error:"), err);
      });
    });
}
