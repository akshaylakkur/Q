/**
 * LLM chat retry logic with exponential backoff.
 */

import type { LoopEventDispatcher } from "./events.js";
import type { LLM, LLMChatParams, LLMChatResponse } from "./llm.js";

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

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await llm.chat(params);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= maxAttempts - 1) break;

      const isAbort = isAbortError(error);
      if (isAbort) throw error;

      if (!llm.isRetryableError?.(error)) {
        throw error;
      }

      dispatchEvent({
        type: "step.retrying",
        turnId,
        step: currentStep,
        stepUuid,
        failedAttempt: attempt + 1,
        nextAttempt: attempt + 2,
        maxAttempts,
        delayMs: Math.min(300 * 2 ** attempt, 5000),
        errorName: lastError.name ?? "Error",
        errorMessage: lastError.message,
      });

      // Wait before retrying (exponential backoff)
      const delay = Math.min(300 * 2 ** attempt, 5000);
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("LLM chat failed after retries");
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
