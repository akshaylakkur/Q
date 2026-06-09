import type { RetryConfig } from "./types.js";

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 5000,
  multiplier: 2,
};

/**
 * Calculate delay with exponential backoff and jitter.
 * delay = min(baseDelay * multiplier^(attempt), maxDelay) * random(0.5, 1.0)
 */
export function calculateDelay(
  attempt: number,
  config: RetryConfig,
): number {
  const exponential = config.baseDelayMs * config.multiplier ** attempt;
  const capped = Math.min(exponential, config.maxDelayMs);
  // Randomized jitter: multiply by random value between 0.5 and 1.0
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.floor(capped * jitter);
}

/**
 * Execute an async function with exponential backoff retry logic.
 * Retries on network errors, rate limits (429), server errors (5xx),
 * and timeout errors.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config?: Partial<RetryConfig>,
): Promise<T> {
  const retryConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < retryConfig.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if we've exhausted all attempts
      if (attempt >= retryConfig.maxAttempts - 1) {
        break;
      }

      // Don't retry on abort errors
      if (isAbortError(error)) {
        throw error;
      }

      // Don't retry on 4xx errors except 429 (rate limit)
      if (isNonRetryableClientError(error)) {
        throw error;
      }

      // Wait before retrying
      const delay = calculateDelay(attempt, retryConfig);
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("Retry failed");
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return false;
}

function isNonRetryableClientError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    // 429 (rate limit) should be retried
    if (status === 429) return false;
    // Other 4xx errors should not be retried
    if (status >= 400 && status < 500) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
