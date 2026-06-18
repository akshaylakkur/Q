/**
 * LLM chat retry logic with exponential backoff.
 *
 * ── SAFEGUARDS ───────────────────────────────────────────────────────────
 *
 * 1. Context overflow detection: if the LLM provider signals a context
 *    window overflow, we DO NOT retry — retrying with the same messages
 *    will produce the same overflow. Instead, we surface a
 *    ContextOverflowError immediately so the orchestrator can compact
 *    memory or reduce context before the next turn.
 *
 * 2. Retryable network errors: transient failures (fetch failed, 429,
 *    503, ECONNRESET, etc.) are retried with exponential backoff.
 *    Non-retryable errors (auth failures, invalid requests, etc.) are
 *    surfaced immediately.
 *
 * 3. Max attempts: configurable, defaults to 3. After exhausting all
 *    attempts, the last error is thrown (or a ContextOverflowError if
 *    all failures were context overflows).
 *
 * 4. Exponentially backed-off delay: 300ms, 600ms, 1200ms, etc., capped
 *    at 5 seconds between retries.
 */

import {
  isAbortError,
  isContextOverflowError,
  isRetryableNetworkError,
  ContextOverflowError,
} from "./errors.js";
import type { LoopEventDispatcher } from "./events.js";
import type { LLM, LLMChatParams, LLMChatResponse, ToolCallDelta } from "./llm.js";

export interface ChatWithRetryInput {
  readonly llm: LLM;
  readonly params: LLMChatParams;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  readonly maxAttempts?: number;
  readonly log?: { warn: (msg: string, ctx?: unknown) => void } | undefined;
}

export async function chatWithRetry(
  input: ChatWithRetryInput,
): Promise<LLMChatResponse> {
  const {
    llm,
    params,
    dispatchEvent,
    turnId,
    currentStep,
    stepUuid,
    maxAttempts = 3,
  } = input;

  let lastError: Error | undefined;
  let sawContextOverflow = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await llm.chat(params);

      // ── SAFEGUARD: Detect provider-side context overflow ────────────────
      // Some providers return a successful response but indicate context
      // overflow via the finish reason. We treat this as a non-retryable
      // error to avoid useless retries.
      if (isProviderContextOverflow(response)) {
        throw new ContextOverflowError(
          "Provider indicated context window was exceeded (finish reason). " +
          "The messages array should be compacted before retrying.",
        );
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // ── SAFEGUARD: Context overflow — skip retries immediately ─────────
      // Retrying with the same oversized context will produce the same
      // overflow. Surface the error so the orchestrator can compact memory
      // or reduce context before the next turn.
      if (isContextOverflowError(error)) {
        sawContextOverflow = true;
        dispatchEvent({
          type: "step.retrying",
          turnId,
          step: currentStep,
          stepUuid,
          failedAttempt: attempt + 1,
          nextAttempt: 0, // signal that retries are skipped
          maxAttempts,
          delayMs: 0,
          errorName: "ContextOverflowError",
          errorMessage: lastError.message,
        });
        break; // skip remaining retries
      }

      // ── SAFEGUARD: Abort errors — never retry ──────────────────────────
      if (isAbortError(error)) {
        throw error;
      }

      // ── SAFEGUARD: Non-retryable errors — surface immediately ──────────
      // Check the LLM's own retryability classifier first, then fall back
      // to our generic rules.
      const isRetryable = llm.isRetryableError?.(error) ?? isRetryableNetworkError(error);
      if (!isRetryable) {
        throw error;
      }

      // Last attempt — don't bother sleeping, just exit the loop
      if (attempt >= maxAttempts - 1) break;

      // ── SAFEGUARD: Exponential backoff with jitter ─────────────────────
      const delayMs = Math.min(300 * 2 ** attempt, 5000);
      const jitter = Math.random() * 200; // add up to 200ms of jitter

      dispatchEvent({
        type: "step.retrying",
        turnId,
        step: currentStep,
        stepUuid,
        failedAttempt: attempt + 1,
        nextAttempt: attempt + 2,
        maxAttempts,
        delayMs: delayMs + jitter,
        errorName: lastError.name ?? "Error",
        errorMessage: lastError.message,
      });

      await sleep(delayMs + jitter);
    }
  }

  // ── SAFEGUARD: If we saw a context overflow, throw that even if there
  // were earlier retryable failures — the overflow is the actionable error.
  if (sawContextOverflow) {
    throw lastError ?? new ContextOverflowError("Context window exceeded (no retries attempted)");
  }

  throw lastError ?? new Error("LLM chat failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks whether the LLM response indicates a provider-side context
 * window overflow via finish reason or raw finish reason.
 */
function isProviderContextOverflow(response: LLMChatResponse): boolean {
  const fr = response.providerFinishReason;
  const raw = response.rawFinishReason;
  const check = (reason: string | undefined): boolean => {
    if (!reason) return false;
    return /context.*(length|exceeded|overflow)/i.test(reason);
  };
  return check(fr) || check(raw);
}
