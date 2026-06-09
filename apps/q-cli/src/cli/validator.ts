import type { CliOptions } from "./types.js";

/**
 * Result of option validation.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Additional validation beyond what Zod's refinements cover.
 * Checks for logical conflicts and environment-specific issues.
 */
export function validateOptions(opts: CliOptions): ValidationResult {
  const errors: string[] = [];

  // Session ID format check
  if (opts.session && !/^[\w-]+$/.test(opts.session)) {
    errors.push("Invalid session ID format. Use alphanumeric characters, underscores, or hyphens.");
  }

  // Model name format check
  if (opts.model && !/^[\w./:-]+$/.test(opts.model)) {
    errors.push("Invalid model name format.");
  }

  // Output format with prompt requirement
  if (opts.outputFormat !== "text" && !opts.prompt) {
    errors.push("Non-text output formats require --prompt.");
  }

  // Skills dirs existence hint (just warn, don't fail)
  // We only check format validity

  return {
    valid: errors.length === 0,
    errors,
  };
}
