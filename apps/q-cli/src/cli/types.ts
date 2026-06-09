import { z } from "zod";

/**
 * Zod schema for all CLI options, providing validation and defaults.
 */
export const CliOptionsSchema = z
  .object({
    // Session flags
    session: z.string().optional().describe("Resume a specific session by ID"),
    continue: z.boolean().optional().describe("Continue the last session"),

    // Permission flags
    yolo: z.boolean().optional().describe("Auto-approve all actions"),
    auto: z.boolean().optional().describe("Auto permission mode"),

    // Model
    model: z.string().optional().describe("Override the LLM model"),

    // Prompt / interaction mode
    prompt: z.string().optional().describe("Non-interactive prompt mode"),
    plan: z.boolean().optional().describe("Enter plan mode on startup"),

    // Memory / embeddings
    noEmbeddings: z.boolean().optional().describe("Disable vector embeddings, use BM25 fallback only"),

    // Setup / onboarding
    setup: z.boolean().optional().describe("Re-run the initial setup wizard"),

    // Output
    outputFormat: z
      .enum(["text", "json", "stream-json"])
      .default("text")
      .describe("Output format for non-interactive mode"),

    // TUI mode
    tui: z.boolean().optional().describe("Force TUI mode (default when interactive)"),

    // Directories
    skillsDirs: z.array(z.string()).default([]).describe("Additional skill directories (repeatable)"),
    cwd: z.string().optional().describe("Working directory (defaults to process.cwd())"),
  })
  .refine(
    (data) => {
      // --session and --continue are mutually exclusive
      if (data.session && data.continue) return false;
      return true;
    },
    { message: "Cannot specify both --session and --continue" },
  )
  .refine(
    (data) => {
      // --yolo and --auto are mutually exclusive
      if (data.yolo && data.auto) return false;
      return true;
    },
    { message: "Cannot specify both --yolo and --auto" },
  )
  .refine(
    (data) => {
      // --prompt and --plan are mutually exclusive (plan mode is interactive)
      if (data.prompt && data.plan) return false;
      return true;
    },
    { message: "Cannot specify --prompt with --plan" },
  );

/** Parsed and validated CLI options */
export type CliOptions = z.infer<typeof CliOptionsSchema>;

/** Default CLI options */
export const defaultCliOptions: CliOptions = {
  outputFormat: "text",
  skillsDirs: [],
};

/**
 * Validate raw CLI options against the schema.
 * Returns a validated object or throws a structured error.
 */
export function parseCliOptions(raw: Record<string, unknown>): CliOptions {
  // Normalize Commander-style flags to our schema keys
  const normalized: Record<string, unknown> = { ...raw };

  // Commander passes arrays for repeatable flags
  if (Array.isArray(normalized.skillsDirs)) {
    normalized.skillsDirs = normalized.skillsDirs;
  } else {
    normalized.skillsDirs = normalized.skillsDirs ? [String(normalized.skillsDirs)] : [];
  }

  return CliOptionsSchema.parse(normalized);
}
