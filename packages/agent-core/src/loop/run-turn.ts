/**
 * Turn-level loop for a stateless agent run.
 *
 * Owns convergence across steps: abort checks at loop boundaries, max-step
 * enforcement, usage aggregation, optional continuation after non-tool stops,
 * and final TurnResult mapping.
 *
 * ── SAFEGUARDS ───────────────────────────────────────────────────────────
 *
 * 1. Global turn timeout: if the entire turn (multiple LLM calls + tool
 *    executions) exceeds MAX_TURN_TIMEOUT_MS, the turn is aborted and
 *    reported as a TurnTimeoutError. This prevents a single runaway turn
 *    from blocking the daemon indefinitely (as happened when a Bash
 *    command hung for 62 minutes).
 *
 * 2. Context overflow recovery: if a ContextOverflowError is caught at
 *    the turn level, we emit an interrupt event and return gracefully
 *    instead of crashing the whole daemon. The orchestrator can then
 *    compact memory and retry with reduced context.
 *
 * 3. Error isolation: non-abort errors from tool executions or LLM calls
 *    are caught and dispatched as interrupt events so the orchestrator
 *    can decide whether to retry, skip, or abort the entire session.
 */

import type { TokenUsage } from "@q/qprovs";

import {
  createMaxStepsExceededError,
  errorMessage,
  isAbortError,
  isContextOverflowError,
  isMaxStepsExceededError,
  ContextOverflowError,
  TurnTimeoutError,
} from "./errors.js";
import type { LoopInterruptReason, LoopEventDispatcher, LoopTurnInterruptedEvent } from "./events.js";
import type { LLM } from "./llm.js";
import { executeLoopStep } from "./turn-step.js";
import type {
  ExecutableTool,
  LoopHooks,
  LoopMessageBuilder,
  LoopTerminalStepStopReason,
  LoopTurnStopReason,
  TurnResult,
} from "./types.js";

const DEFAULT_MAX_STEPS = 1000;

/**
 * Global timeout for a single turn (1 hour 18 minutes = 4,680,000ms).
 * If a turn runs longer than this, it is aborted to prevent the
 * daemon from getting stuck on a hung command or infinite tool loop.
 */
const MAX_TURN_TIMEOUT_MS = 4_680_000;

export interface RunTurnInput {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly llm: LLM;
  readonly buildMessages: LoopMessageBuilder;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: { warn: (msg: string, ctx?: unknown) => void } | undefined;
  readonly maxSteps?: number | undefined;
  readonly maxRetryAttempts?: number;
}

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0 };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
      : {}),
    ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) }
      : {}),
  };
}

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const {
    turnId,
    signal,
    llm,
    buildMessages,
    dispatchEvent,
    tools,
    hooks,
    log,
    maxSteps = DEFAULT_MAX_STEPS,
    maxRetryAttempts,
  } = input;

  let usage: TokenUsage = emptyUsage();
  let steps = 0;
  let stopReason: LoopTurnStopReason = "end_turn";
  let activeStep: number | undefined;

  const recordStepUsage = (stepUsage: TokenUsage): void => {
    usage = addUsage(usage, stepUsage);
  };

  // ── SAFEGUARD: Global turn timeout ─────────────────────────────────────
  // Create a per-turn AbortController that fires if the entire turn
  // exceeds MAX_TURN_TIMEOUT_MS. This catches hung Bash commands, infinite
  // tool loops, and any other situation where the turn doesn't make progress.
  const turnTimeoutController = new AbortController();
  const turnTimeoutTimer = setTimeout(() => {
    turnTimeoutController.abort(new TurnTimeoutError(MAX_TURN_TIMEOUT_MS));
  }, MAX_TURN_TIMEOUT_MS);

  // If the parent signal aborts, also abort our turn timeout.
  const onParentAbort = (): void => {
    turnTimeoutController.abort();
  };
  signal.addEventListener("abort", onParentAbort, { once: true });

  // Combine the parent signal and the turn timeout signal into one.
  // If either fires, the combined signal aborts.
  const turnSignal = combineAbortSignals(signal, turnTimeoutController.signal);

  try {
    while (true) {
      // ── SAFEGUARD: Check turn timeout before each step ───────────────
      if (turnTimeoutController.signal.aborted) {
        throw turnTimeoutController.signal.reason ?? new TurnTimeoutError(MAX_TURN_TIMEOUT_MS);
      }

      turnSignal.throwIfAborted();

      if (steps >= maxSteps) {
        throw createMaxStepsExceededError(maxSteps);
      }

      steps += 1;
      activeStep = steps;
      const stepResult = await executeLoopStep({
        turnId,
        signal: turnSignal,
        buildMessages,
        dispatchEvent,
        llm,
        tools,
        hooks,
        log,
        currentStep: steps,
        maxRetryAttempts,
        recordUsage: recordStepUsage,
      });
      activeStep = undefined;

      if (stepResult.stopReason === "tool_use") {
        continue;
      }

      const terminalStopReason: LoopTerminalStepStopReason = stepResult.stopReason;
      stopReason = terminalStopReason;

      const shouldContinue = await hooks?.shouldContinueAfterStop?.({
        turnId,
        stepNumber: steps,
        usage: stepResult.usage,
        stopReason: terminalStopReason,
        signal: turnSignal,
        llm,
      });
      if (!shouldContinue?.continue) {
        break;
      }
    }
  } catch (error) {
    // ── SAFEGUARD: Context overflow at turn level ───────────────────────
    // If the LLM call failed due to context overflow, emit an interrupt
    // and return gracefully so the orchestrator can compact memory and
    // retry with reduced context, rather than crashing the daemon.
    if (isContextOverflowError(error)) {
      dispatchEvent(makeInterruptedEvent("context_overflow", steps, activeStep, errorMessage(error)));
      return { stopReason: "context_overflow", steps, usage };
    }

    if (isAbortError(error) || turnSignal.aborted) {
      const reason: LoopInterruptReason = turnTimeoutController.signal.aborted
        ? "turn_timeout"
        : "aborted";
      dispatchEvent(makeInterruptedEvent(reason, steps, activeStep, errorMessage(error)));
      return { stopReason: reason === "turn_timeout" ? "turn_timeout" : "aborted", steps, usage };
    }

    const reason: LoopInterruptReason = isMaxStepsExceededError(error)
      ? "max_steps"
      : "error";
    dispatchEvent(makeInterruptedEvent(reason, steps, activeStep, errorMessage(error)));
    throw error;
  } finally {
    // ── SAFEGUARD: Always clean up the turn timeout timer ──────────────
    clearTimeout(turnTimeoutTimer);
    try {
      signal.removeEventListener("abort", onParentAbort);
    } catch {
      // ignore
    }
  }

  return { stopReason, steps, usage };
}

function makeInterruptedEvent(
  reason: LoopInterruptReason,
  attemptedSteps: number,
  activeStep: number | undefined,
  message?: string | undefined,
): LoopTurnInterruptedEvent {
  return {
    type: "turn.interrupted",
    reason,
    attemptedSteps,
    ...(activeStep !== undefined ? { activeStep } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Combine two AbortSignals into a single signal that aborts when either
 * of the source signals aborts.
 */
function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener("abort", () => {
      controller.abort(sig.reason);
    }, { once: true });
  }
  return controller.signal;
}
