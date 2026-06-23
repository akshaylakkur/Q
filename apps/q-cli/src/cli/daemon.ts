import chalk from "chalk";
import type { Command } from "commander";

/**
 * `q-cli daemon` — Start long-running server mode.
 *
 * Full implementation in Step 40.
 */
export async function daemonCommand(options: {
  port?: string;
}): Promise<void> {
  console.log(chalk.bold("V Daemon"));
  console.log(chalk.dim("  Long-running server mode — not yet implemented."));
  console.log();

  if (options.port) {
    console.log(chalk.dim(`  Requested port: ${options.port}`));
  }

  console.log();
  console.log(chalk.yellow("⚠ This command will be implemented in Step 40."));
  console.log(chalk.dim("  For now, use 'q-cli' without arguments for interactive mode."));
}

/**
 * Register the `q-cli daemon` command with Commander.
 */
export function registerDaemonCommand(prog: Command): void {
  prog
    .command("daemon")
    .description("Start long-running server mode")
    .option("-p, --port <port>", "TCP port for the daemon to listen on")
    .action(async (opts: { port?: string }) => {
      await daemonCommand(opts).catch((err: Error) => {
        console.error(chalk.red("Daemon command error:"), err.message);
        process.exit(1);
      });
    });
}
