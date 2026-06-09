/**
 * Tool-call lifecycle for one completed provider response.
 *
 * Validates every provider tool call, runs preparation hooks,
 * dispatches tool.call events, executes tools with conflict-aware
 * scheduling, finalizes results, and dispatches tool.result events.
 */

import { errorMessage, isAbortError } from "./errors.js";
import type { LoopEventDispatcher, LoopToolCallEvent } from "./events.js";
import type { LLM, LLMChatResponse } from "./llm.js";
import { ToolAccesses } from "./tool-access.js";
import { ToolScheduler, type ToolCallTask } from "./tool-scheduler.js";
import type {
  AuthorizeToolExecutionResult,
  ExecutableTool,
  ExecutableToolResult,
  LoopHooks,
  PrepareToolExecutionResult,
  RunnableToolExecution,
  ToolCall,
  ToolExecution,
  ToolInputDisplay,
} from "./types.js";

const GRACE_TIMEOUT_MS = 2_000;
const TOOL_OUTPUT_EMPTY = "Tool output is empty.";
const TOOL_OUTPUT_CAP = 100_000;

export interface ToolCallStepContext {
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: { warn: (msg: string, ctx?: unknown) => void } | undefined;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly llm: LLM;
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
}

type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

interface RunnableToolCall {
  readonly kind: "runnable";
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly tool: ExecutableTool;
  readonly args: unknown;
}

interface RejectedToolCall {
  readonly kind: "rejected";
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly output: string;
}

interface PendingToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ExecutableToolResult;
  readonly stopTurn?: boolean | undefined;
}

interface PreparedToolCallTask {
  readonly task: ToolCallTask<PendingToolResult>;
  readonly stopBatchAfterThis?: boolean | undefined;
}

interface ToolCallDisplayFields {
  description?: string;
  display?: ToolInputDisplay;
}

export interface ToolCallBatchResult {
  readonly stopTurn: boolean;
}

export async function runToolCallBatch(
  step: ToolCallStepContext,
  response: LLMChatResponse,
): Promise<ToolCallBatchResult> {
  if (response.toolCalls.length === 0) return { stopTurn: false };

  const calls = response.toolCalls.map((tc) =>
    preflightToolCall(step.tools, {
      id: tc.id,
      name: tc.name,
      args: tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {},
    }),
  );

  const scheduler = new ToolScheduler<PendingToolResult>();
  const pendingResults: Array<Promise<PendingToolResult>> = [];
  let stopTurn = false;

  try {
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      const prepared = await prepareToolCall(step, call);
      pendingResults.push(scheduler.add(prepared.task));

      if (prepared.stopBatchAfterThis === true) {
        stopTurn = true;
        for (const skippedCall of calls.slice(index + 1)) {
          const skippedTask = await prepareSkippedToolCall(step, skippedCall);
          pendingResults.push(scheduler.add(skippedTask));
        }
        break;
      }
    }

    for (const pendingResult of pendingResults) {
      const result = await finalizePendingToolResult(step, await pendingResult);
      if (result.stopTurn === true) stopTurn = true;
      await step.dispatchEvent({
        type: "tool.result",
        parentUuid: result.toolCall.id,
        toolCallId: result.toolCall.id,
        result: result.result,
      });
    }
  } finally {
    await Promise.allSettled(pendingResults);
  }
  return { stopTurn };
}

function preflightToolCall(
  tools: readonly ExecutableTool[] | undefined,
  toolCall: { id: string; name: string; args: Record<string, unknown> },
): PreflightedToolCall {
  const toolName = toolCall.name;
  const args = toolCall.args;
  const tool = tools?.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    return {
      kind: "rejected",
      toolCall: { id: toolCall.id, name: toolName, args },
      toolName,
      args,
      output: `Tool "${toolName}" not found`,
    };
  }
  return { kind: "runnable", toolCall: { id: toolCall.id, name: toolName, args }, toolName, tool, args };
}

async function prepareToolCall(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
): Promise<PreparedToolCallTask> {
  const settleError = async (
    args: unknown,
    output: string,
    displayFields?: ToolCallDisplayFields,
  ): Promise<PreparedToolCallTask> => {
    await dispatchToolCall(step, call, args, displayFields);
    return { task: makeResolvedToolCallTask(makeErrorToolResult(call, args, output)) };
  };

  const settleSynthetic = async (
    args: unknown,
    result: ExecutableToolResult,
    displayFields?: ToolCallDisplayFields,
  ): Promise<PreparedToolCallTask> => {
    const coerced = coerceToolResult(result, call.toolName);
    await dispatchToolCall(step, call, args, displayFields);
    return {
      task: makeResolvedToolCallTask(makeToolResult(call, args, coerced)),
      stopBatchAfterThis: toolResultStopsTurn(coerced),
    };
  };

  if (call.kind === "rejected") return settleError(call.args, call.output);

  const decision = await runPrepareToolExecutionHook(step, call);
  if (decision.kind === "blocked" || decision.kind === "hookFailed") {
    return settleError(decision.args, decision.output ?? "Tool call was blocked");
  }
  if (decision.kind === "synthetic") {
    return settleSynthetic(decision.args, decision.result!);
  }

  const effectiveArgs = decision.args;
  let rawExecution: ToolExecution;
  try {
    rawExecution = await call.tool.resolveExecution(effectiveArgs);
  } catch (error) {
    step.log?.warn?.("tool execution setup failed", {
      toolName: call.toolName,
      toolCallId: call.toolCall.id,
      error,
    });
    const output = `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
    return settleError(effectiveArgs, output);
  }

  // Check if the resolution returned an error result directly
  if ("isError" in rawExecution && (rawExecution as ExecutableToolResult).isError === true) {
    return settleSynthetic(effectiveArgs, rawExecution as ExecutableToolResult, undefined);
  }

  const runnable = rawExecution as RunnableToolExecution;
  const displayFields = {
    description: runnable.description,
    display: runnable.display,
  };

  if (step.signal.aborted) {
    return settleError(effectiveArgs, `Tool "${call.toolName}" was aborted`, displayFields);
  }

  const authorization = await runAuthorizeToolExecutionHook(step, call, effectiveArgs, runnable);
  if (step.signal.aborted) {
    return settleError(effectiveArgs, `Tool "${call.toolName}" was aborted`);
  }

  if (authorization?.block === true) {
    return settleError(
      effectiveArgs,
      authorization.reason ?? `Tool call "${call.toolName}" was blocked`,
      displayFields,
    );
  }

  if (authorization?.syntheticResult !== undefined) {
    return settleSynthetic(effectiveArgs, authorization.syntheticResult, displayFields);
  }

  await dispatchToolCall(step, call, effectiveArgs, displayFields);
  return {
    task: {
      accesses: runnable.accesses ?? ToolAccesses.all(),
      start: async () => ({
        result: runRunnableToolCall(step, call, effectiveArgs, runnable),
      }),
    },
  };
}

async function prepareSkippedToolCall(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
): Promise<ToolCallTask<PendingToolResult>> {
  const output = "Tool skipped because a previous tool call stopped the turn.";
  await dispatchToolCall(step, call, call.args);
  return makeResolvedToolCallTask(makeErrorToolResult(call, call.args, output));
}

function makeResolvedToolCallTask(result: PendingToolResult): ToolCallTask<PendingToolResult> {
  return {
    accesses: ToolAccesses.none(),
    start: async () => ({ result: Promise.resolve(result) }),
  };
}

async function runPrepareToolExecutionHook(
  step: ToolCallStepContext,
  call: RunnableToolCall,
): Promise<PrepareToolExecutionDecision> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  const { toolCall, args } = call;

  if (hooks?.prepareToolExecution === undefined) {
    return { kind: "allowed", args };
  }

  let hookResult: PrepareToolExecutionResult | undefined;
  try {
    hookResult = await hooks.prepareToolExecution({
      toolCall,
      tool: call.tool,
      args,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return {
        kind: "hookFailed",
        args,
        output: `Tool "${call.toolName}" was aborted during prepareToolExecution hook`,
      };
    }
    return {
      kind: "hookFailed",
      args,
      output: `prepareToolExecution hook failed for "${call.toolName}": ${errorMessage(error)}`,
    };
  }

  const effectiveArgs = hookResult?.updatedArgs ?? args;
  if (hookResult?.block === true) {
    return {
      kind: "blocked",
      args: effectiveArgs,
      output: hookResult.reason ?? `Tool call "${call.toolName}" was blocked`,
    };
  }

  if (hookResult?.syntheticResult !== undefined) {
    return { kind: "synthetic", args: effectiveArgs, result: hookResult.syntheticResult };
  }

  return { kind: "allowed", args: effectiveArgs, metadata: hookResult?.executionMetadata };
}

async function runAuthorizeToolExecutionHook(
  step: ToolCallStepContext,
  call: RunnableToolCall,
  args: unknown,
  execution: RunnableToolExecution,
): Promise<AuthorizeToolExecutionResult | undefined> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  if (hooks?.authorizeToolExecution === undefined) return undefined;

  try {
    return await hooks.authorizeToolExecution({
      toolCall: call.toolCall,
      tool: call.tool,
      args,
      execution,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return {
        block: true,
        reason: `Tool "${call.toolName}" was aborted during authorizeToolExecution hook`,
      };
    }
    return {
      block: true,
      reason: `authorizeToolExecution hook failed for "${call.toolName}": ${errorMessage(error)}`,
    };
  }
}

interface PrepareToolExecutionDecision {
  kind: "allowed" | "synthetic" | "blocked" | "hookFailed";
  args: unknown;
  result?: ExecutableToolResult;
  output?: string;
  metadata?: unknown;
}

async function runRunnableToolCall(
  step: ToolCallStepContext,
  call: RunnableToolCall,
  effectiveArgs: unknown,
  execution: RunnableToolExecution,
): Promise<PendingToolResult> {
  const { signal } = step;
  const { toolCall, toolName } = call;

  if (signal.aborted) {
    return makeErrorToolResult(call, effectiveArgs, `Tool "${toolName}" was aborted`);
  }

  let toolResult: ExecutableToolResult;
  try {
    const raw = await executeTool(step, execution, toolCall, toolName);
    toolResult = coerceToolResult(raw, toolName);
  } catch (error) {
    const aborted = isAbortError(error) || signal.aborted;
    if (!aborted) {
      step.log?.warn?.("tool execution failed", {
        toolName,
        toolCallId: toolCall.id,
        error,
      });
    }
    const output = aborted
      ? `Tool "${toolName}" was aborted`
      : `Tool "${toolName}" failed: ${errorMessage(error)}`;
    return makeErrorToolResult(call, effectiveArgs, output);
  }

  return makeToolResult(call, effectiveArgs, toolResult);
}

async function finalizePendingToolResult(
  step: ToolCallStepContext,
  pendingResult: PendingToolResult,
): Promise<PendingToolResult> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  if (hooks?.finalizeToolResult === undefined) {
    return { ...pendingResult, result: normalizeToolResult(pendingResult.result) };
  }

  try {
    const finalizedResult = await hooks.finalizeToolResult({
      toolCall: pendingResult.toolCall,
      args: pendingResult.args,
      result: pendingResult.result,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
    const effectiveResult = coerceToolResult(
      finalizedResult ?? pendingResult.result,
      pendingResult.toolName,
    );
    return {
      ...pendingResult,
      stopTurn: pendingResult.stopTurn === true || toolResultStopsTurn(effectiveResult),
      result: normalizeToolResult(effectiveResult),
    };
  } catch (error) {
    const aborted = isAbortError(error) || signal.aborted;
    if (!aborted) {
      step.log?.warn?.("finalizeToolResult hook failed", {
        toolName: pendingResult.toolName,
        toolCallId: pendingResult.toolCall.id,
        error,
      });
    }
    const output = aborted
      ? `Tool "${pendingResult.toolName}" aborted during finalizeToolResult hook.`
      : `finalizeToolResult hook failed for "${pendingResult.toolName}": ${errorMessage(error)}`;
    return {
      ...pendingResult,
      stopTurn: pendingResult.stopTurn,
      result: { output, isError: true },
    };
  }
}

async function executeTool(
  step: ToolCallStepContext,
  execution: RunnableToolExecution,
  toolCall: { id: string },
  toolName: string,
): Promise<ExecutableToolResult> {
  const { dispatchEvent, signal, turnId } = step;

  signal.throwIfAborted();

  const executePromise = execution.execute({
    turnId,
    toolCallId: toolCall.id,
    signal,
    onUpdate: (update) => {
      if (signal.aborted) return;
      dispatchEvent({
        type: "tool.progress",
        toolCallId: toolCall.id,
        update,
      } as never);
    },
  });
  return raceExecuteWithGraceTimeout(executePromise, signal, toolName);
}

async function raceExecuteWithGraceTimeout(
  executePromise: Promise<ExecutableToolResult>,
  signal: AbortSignal,
  toolName: string,
): Promise<ExecutableToolResult> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const graceSentinel: Promise<ExecutableToolResult> = new Promise((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(() => {
        resolve({
          output: `Tool "${toolName}" aborted by grace timeout (${String(GRACE_TIMEOUT_MS)}ms)`,
          isError: true,
        });
      }, GRACE_TIMEOUT_MS);
    };
    if (signal.aborted) {
      armTimer();
    } else {
      onAbort = armTimer;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
    }
  }
}

function coerceToolResult(value: unknown, toolName: string): ExecutableToolResult {
  if (value === null || value === undefined) {
    return { output: `Tool "${toolName}" returned no result.`, isError: true };
  }
  if (typeof value !== "object") {
    return {
      output: `Tool "${toolName}" returned a ${typeof value} instead of a tool result.`,
      isError: true,
    };
  }
  const candidate = value as { output?: unknown };
  if (typeof candidate.output !== "string" && !Array.isArray(candidate.output)) {
    return {
      output: `Tool "${toolName}" returned a result with a missing or malformed "output" field.`,
      isError: true,
    };
  }
  return value as ExecutableToolResult;
}

function normalizeToolResult(r: ExecutableToolResult): ExecutableToolResult {
  let output: ExecutableToolResult["output"];
  if (typeof r.output === "string") {
    output = r.output.length > 0 ? capOutput(r.output, TOOL_OUTPUT_CAP) : TOOL_OUTPUT_EMPTY;
  } else if (r.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    output = r.output;
  }
  return r.isError === true ? { output, isError: true } : { output };
}

function capOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  return output.slice(0, maxChars) + `\n\n[Output truncated at ${maxChars.toLocaleString()} characters]`;
}

function makeToolResult(
  call: PreflightedToolCall,
  args: unknown,
  result: ExecutableToolResult,
): PendingToolResult {
  return {
    toolCall: call.toolCall,
    toolName: call.toolName,
    args,
    result,
    stopTurn: toolResultStopsTurn(result),
  };
}

function toolResultStopsTurn(result: ExecutableToolResult): boolean {
  return result.isError === true && result.stopTurn === true;
}

function makeErrorToolResult(
  call: PreflightedToolCall,
  args: unknown,
  output: string,
): PendingToolResult {
  return makeToolResult(call, args, { output, isError: true });
}



async function dispatchToolCall(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
  args: unknown,
  displayFields?: ToolCallDisplayFields | undefined,
): Promise<void> {
  const { toolCall, toolName } = call;
  const event: LoopToolCallEvent = {
    type: "tool.call",
    uuid: toolCall.id,
    turnId: step.turnId,
    step: step.currentStep,
    stepUuid: step.stepUuid,
    toolCallId: toolCall.id,
    name: toolName,
    args,
    description: displayFields?.description,
    display: displayFields?.display,
  };
  await step.dispatchEvent(event);
}
