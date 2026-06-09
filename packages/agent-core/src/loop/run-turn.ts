/**
 * Turn-level loop for a stateless agent run.
 *
 * Owns convergence across steps: abort checks at loop boundaries, max-step
 * enforcement, usage aggregation, optional continuation after non-tool stops,
 * and final TurnResult mapping.
 */

import type { TokenUsage } from "@q/qprovs";

import {
  createMaxStepsExceededError,
  errorMessage,
  isAbortError,
  isMaxStepsExceededError,
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

  try {
    while (true) {
      signal.throwIfAborted();

      if (steps >= maxSteps) {
        throw createMaxStepsExceededError(maxSteps);
      }

      steps += 1;
      activeStep = steps;
      const stepResult = await executeLoopStep({
        turnId,
        signal,
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
        signal,
        llm,
      });
      if (!shouldContinue?.continue) {
        break;
      }
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      dispatchEvent(makeInterruptedEvent("aborted", steps, activeStep));
      return { stopReason: "aborted", steps, usage };
    }
    const reason: LoopInterruptReason = isMaxStepsExceededError(error)
      ? "max_steps"
      : "error";
    dispatchEvent(makeInterruptedEvent(reason, steps, activeStep, errorMessage(error)));
    throw error;
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
