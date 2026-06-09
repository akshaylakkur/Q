/**
 * Executes one provider step.
 */

import { randomUUID } from "node:crypto";

import type { TokenUsage } from "@q/qprovs";

import type { LoopEventDispatcher } from "./events.js";
import type { LLM, LLMChatParams, LLMChatResponse, ToolCallDelta } from "./llm.js";
import { chatWithRetry } from "./retry.js";
import { runToolCallBatch, type ToolCallStepContext } from "./tool-call.js";
import type { ExecutableTool, LoopHooks, LoopMessageBuilder, LoopStepStopReason } from "./types.js";

interface ExecuteLoopStepDeps {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly buildMessages: LoopMessageBuilder;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly llm: LLM;
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: { warn: (msg: string, ctx?: unknown) => void } | undefined;
  readonly currentStep: number;
  readonly maxRetryAttempts?: number;
  readonly recordUsage: (usage: TokenUsage) => void;
}

export async function executeLoopStep(
  deps: ExecuteLoopStepDeps,
): Promise<{
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
}> {
  const {
    turnId,
    signal,
    buildMessages,
    dispatchEvent,
    llm,
    tools,
    hooks,
    log,
    currentStep,
    maxRetryAttempts,
    recordUsage,
  } = deps;

  // 1. beforeStep hook
  if (hooks?.beforeStep !== undefined) {
    const beforeStep = await hooks.beforeStep({
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
    if (beforeStep?.block === true) {
      throw new Error(beforeStep.reason ?? `Step ${String(currentStep)} was blocked`);
    }
  }

  signal.throwIfAborted();

  // 2. Build messages
  const messages = await buildMessages();
  signal.throwIfAborted();

  const stepUuid = randomUUID();

  const step: ToolCallStepContext = {
    tools,
    hooks,
    log,
    dispatchEvent,
    llm,
    signal,
    turnId,
    currentStep,
    stepUuid,
  };

  // 3. Record step begin
  await dispatchEvent({
    type: "step.begin",
    uuid: stepUuid,
    turnId,
    step: currentStep,
  });

  // 4. Call the LLM
  const chatParams: LLMChatParams = {
    messages: messages as Parameters<typeof llm.chat>[0]["messages"],
    tools: (tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as Record<string, unknown>,
    })),
    signal,
    onTextDelta: (delta: string) => {
      dispatchEvent({ type: "text.delta" as never, delta } as never);
    },
    onThinkDelta: (delta: string) => {
      dispatchEvent({ type: "thinking.delta" as never, delta } as never);
    },
    onToolCallDelta: (delta: ToolCallDelta) => {
      dispatchEvent({
        type: "tool.call.delta" as never,
        toolCallId: delta.toolCallId,
        name: delta.name,
        argumentsPart: delta.argumentsPart,
      } as never);
    },
  };

  const response: LLMChatResponse = await chatWithRetry({
    llm,
    params: chatParams,
    dispatchEvent,
    turnId,
    currentStep,
    stepUuid,
    maxAttempts: maxRetryAttempts,
    log,
  });

  const usage = response.usage;
  recordUsage(usage);

  // 4a. Emit assistant message event so context memory can persist
  // the model's response (text, tool calls, or both) for continuity
  // between steps. Without this, models (especially non-Anthropic ones)
  // lose context and may re-request the same tool calls endlessly.
  {
    const textContent = response.content ?? "";
    const toolCalls = response.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments ?? "{}",
    }));
    await dispatchEvent({
      type: "assistant.message",
      uuid: stepUuid,
      turnId,
      content: textContent,
      toolCalls,
    });
  }

  // 5. Derive stop reason
  const stopReason = deriveStepStopReason(response);

  // 6. Execute tool calls if present
  let effectiveStopReason = stopReason;
  if (stopReason === "tool_use") {
    const toolBatch = await runToolCallBatch(step, response);
    if (toolBatch.stopTurn) effectiveStopReason = "end_turn";
  }

  signal.throwIfAborted();

  // 7. Record step end
  await dispatchEvent({
    type: "step.end",
    uuid: stepUuid,
    turnId,
    step: currentStep,
    usage,
    finishReason: effectiveStopReason,
    llmFirstTokenLatencyMs: response.streamTiming?.firstTokenLatencyMs,
    llmStreamDurationMs: response.streamTiming?.streamDurationMs,
  });

  // 8. afterStep hook
  if (hooks?.afterStep !== undefined) {
    try {
      await hooks.afterStep({
        turnId,
        stepNumber: currentStep,
        usage,
        stopReason: effectiveStopReason,
        signal,
        llm,
      });
    } catch {
      // Observer hooks cannot change the result.
    }
  }

  return { usage, stopReason: effectiveStopReason };
}

function deriveStepStopReason(response: LLMChatResponse): LoopStepStopReason {
  const fr = response.providerFinishReason;
  if (fr === undefined) {
    return response.toolCalls.length > 0 ? "tool_use" : "end_turn";
  }
  switch (fr) {
    case "completed":
      return response.toolCalls.length > 0 ? "tool_use" : "end_turn";
    case "tool_use":
      return response.toolCalls.length > 0 ? "tool_use" : "unknown";
    case "max_tokens":
      return "max_tokens";
    case "filtered":
      return "filtered";
    case "paused":
      return "paused";
    case "unknown":
      return "unknown";
  }
}
