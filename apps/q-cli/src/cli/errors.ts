import chalk from "chalk";

/**
 * Structured error for startup failures.
 */
export class StartupError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "StartupError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Known startup error codes.
 */
export const StartupErrorCodes = {
  CONFIG_MISSING: "CONFIG_MISSING",
  INVALID_SESSION: "INVALID_SESSION",
  NETWORK_ERROR: "NETWORK_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  MISSING_PROVIDER: "MISSING_PROVIDER",
  PERMISSION_ERROR: "PERMISSION_ERROR",
} as const;

/**
 * Format a startup error for display.
 */
export function formatStartupError(error: unknown): string {
  if (error instanceof StartupError) {
    const lines: string[] = [];
    lines.push(chalk.red("✗ Startup Error:"));
    lines.push(chalk.white(`  ${error.message}`));
    if (error.hint) {
      lines.push(chalk.dim(`  Hint: ${error.hint}`));
    }
    if (error.code) {
      lines.push(chalk.dim(`  Code: ${error.code}`));
    }
    return lines.join("\n");
  }

  if (error instanceof Error) {
    return chalk.red(`✗ Error: ${error.message}`);
  }

  return chalk.red(`✗ Unknown error: ${String(error)}`);
}

/**
 * Format a warning message.
 */
export function formatWarning(message: string): string {
  return chalk.yellow(`⚠ ${message}`);
}

/**
 * Format a success message.
 */
export function formatSuccess(message: string): string {
  return chalk.green(`✓ ${message}`);
}
