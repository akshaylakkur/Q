/**
 * Loop-specific error types and helpers.
 *
 * ── SAFEGUARDS ───────────────────────────────────────────────────────────
 *
 * - ContextOverflowError: raised when the LLM provider indicates the
 *   conversation context window has been exceeded. The retry layer will
 *   detect this and skip the request (rather than retrying uselessly)
 *   so the orchestrator can compact memory or start a fresh context.
 *
 * - TurnTimeoutError: raised when an entire turn exceeds a global timeout
 *   ceiling. This prevents a single turn from blocking the daemon forever.
 */

export class LoopError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopError";
    this.code = code;
  }
}

export class MaxStepsExceededError extends LoopError {
  readonly maxSteps: number;
  constructor(maxSteps: number) {
    super("MAX_STEPS_EXCEEDED", `Max steps (${maxSteps}) exceeded`);
    this.name = "MaxStepsExceededError";
    this.maxSteps = maxSteps;
  }
}

/**
 * Error raised when the LLM provider indicates the context window
 * has been exceeded. This is a non-retryable error — retrying with
 * the same context will produce the same result. The orchestrator
 * should compact memory, truncate history, or start a fresh turn.
 */
export class ContextOverflowError extends LoopError {
  constructor(message: string) {
    super("CONTEXT_OVERFLOW", message);
    this.name = "ContextOverflowError";
  }
}

/**
 * Error raised when an entire turn exceeds the global timeout ceiling.
 */
export class TurnTimeoutError extends LoopError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super("TURN_TIMEOUT", `Turn exceeded the global timeout of ${timeoutMs}ms`);
    this.name = "TurnTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export function isMaxStepsExceededError(error: unknown): boolean {
  return error instanceof MaxStepsExceededError;
}

export function createMaxStepsExceededError(maxSteps: number): MaxStepsExceededError {
  return new MaxStepsExceededError(maxSteps);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Detect whether an error indicates the LLM context window was exceeded.
 * Matches against common provider error messages.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /context.*exceeded/i,
  /context.*too long/i,
  /context.*overflow/i,
  /too many tokens/i,
  /maximum.*context/i,
  /token.*limit.*exceeded/i,
  /request.*too large/i,
  /content.*length.*exceeded/i,
  /prompt.*too long/i,
  /input.*too long/i,
  /maximum.*length.*exceeded/i,
];

export function isContextOverflowError(error: unknown): boolean {
  if (error instanceof ContextOverflowError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Detect whether an error is a transient network/http failure that
 * can be retried safely.
 */
const RETRYABLE_NETWORK_PATTERNS = [
  /fetch failed/i,
  /network error/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket.*hang.?up/i,
  /connection.*(refused|reset|closed)/i,
  /timeout/i,
  /429/i,
  /503/i,
  /502/i,
  /500/i,
  /too many requests/i,
  /rate limit/i,
  /service unavailable/i,
  /bad gateway/i,
  /internal server error/i,
  /temporary.*glitch/i,
  /transient.*error/i,
  /retry.*later/i,
];

export function isRetryableNetworkError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (isContextOverflowError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_NETWORK_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Check if the LLM provider's response indicates a context window overflow.
 * Provider-specific finish reasons can signal this.
 */
export function isProviderContextOverflow(finishReason?: string): boolean {
  if (!finishReason) return false;
  return /context.*(length|exceeded|overflow)/i.test(finishReason);
}
