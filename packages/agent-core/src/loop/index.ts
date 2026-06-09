/**
 * Loop — Stateless agent turn loop.
 *
 * The loop owns the model-step lifecycle, tool execution with
 * conflict-aware scheduling, and event-based transcript recording.
 */

export { runTurn } from "./run-turn.js";
export type { RunTurnInput } from "./run-turn.js";

export { executeLoopStep } from "./turn-step.js";

export { runToolCallBatch } from "./tool-call.js";
export type { ToolCallStepContext, ToolCallBatchResult } from "./tool-call.js";

export { ToolScheduler } from "./tool-scheduler.js";
export type { ToolCallTask } from "./tool-scheduler.js";

export { ToolAccesses } from "./tool-access.js";
export type {
  ToolFileAccessOperation,
  ToolFileAccess,
  ToolResourceAccessAll,
  ToolResourceAccess,
  ToolAccesses as ToolAccessesType,
} from "./tool-access.js";

export { createLoopEventDispatcher } from "./events.js";
export type {
  LoopEventDispatcher,
  LoopEvent,
  LoopRecordedEvent,
  LoopLiveOnlyEvent,
  LoopStepBeginEvent,
  LoopStepEndEvent,
  LoopStepRetryingEvent,
  LoopContentPartEvent,
  LoopToolCallEvent,
  LoopToolResultEvent,
  LoopAssistantMessageEvent,
  LoopTurnInterruptedEvent,
  LoopTextDeltaEvent,
  LoopThinkingDeltaEvent,
  LoopToolCallDeltaEvent,
  LoopToolProgressEvent,
  LoopInterruptReason,
  LoopLiveEventEmitter,
  CreateLoopEventDispatcherInput,
} from "./events.js";

export type { LLM, LLMChatParams, LLMChatResponse, ToolCallDelta, LLMStreamTiming, LLMRequestLogContext } from "./llm.js";

export type {
  TurnResult,
  LoopStepStopReason,
  LoopTerminalStepStopReason,
  LoopTurnStopReason,
  LoopMessageBuilder,
  ExecutableToolOutput,
  ExecutableToolSuccessResult,
  ExecutableToolErrorResult,
  ExecutableToolResult,
  ExecutableTool,
  ExecutableToolContext,
  RunnableToolExecution,
  ToolExecution,
  ToolUpdate,
  ToolCall,
  LoopHooks,
  LoopStepHookContext,
  ToolExecutionHookContext,
  ResolvedToolExecutionHookContext,
  AuthorizeToolExecutionResult,
  PrepareToolExecutionResult,
  FinalizeToolResultContext,
  LoopAfterStepContext,
  LoopStoppedStepContext,
  BeforeStepResult,
  ShouldContinueAfterStopResult,
  BeforeStepHook,
  AfterStepHook,
  PrepareToolExecutionHook,
  AuthorizeToolExecutionHook,
  FinalizeToolResultHook,
  ShouldContinueAfterStopHook,
  ToolInputDisplay,
} from "./types.js";

export { LoopError, MaxStepsExceededError, isAbortError, isMaxStepsExceededError, errorMessage } from "./errors.js";
