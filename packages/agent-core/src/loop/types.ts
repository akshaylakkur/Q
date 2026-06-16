/**
 * Public contracts for the stateless agent loop.
 *
 * Defines the narrow surfaces connecting an agent conversation to
 * tool execution, phase hooks, and turn results.
 */

import type { ToolCall, TokenUsage } from "@q/qprovs";

import type { ToolInputDisplay } from "./display.js";
import type { ToolAccesses } from "./tool-access.js";
import type { LLM } from "./llm.js";

export type { ToolCall };

export type LoopMessageBuilder = () => Promise<unknown[]>;

/**
 * Stop reason for one completed model step.
 */
export type LoopStepStopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "filtered"
  | "paused"
  | "unknown";

export type LoopTerminalStepStopReason = Exclude<LoopStepStopReason, "tool_use">;

export type LoopTurnStopReason = LoopTerminalStepStopReason | "aborted";

export interface TurnResult {
  stopReason: LoopTurnStopReason;
  steps: number;
  usage: TokenUsage;
}

export type ExecutableToolOutput = string | unknown[];

export interface ExecutableToolSuccessResult {
  readonly output: ExecutableToolOutput;
  readonly isError?: false | undefined;
  readonly message?: string | undefined;
}

export interface ExecutableToolErrorResult {
  readonly output: ExecutableToolOutput;
  readonly isError: true;
  readonly message?: string | undefined;
  readonly stopTurn?: boolean | undefined;
}

export type ExecutableToolResult = ExecutableToolSuccessResult | ExecutableToolErrorResult;

export interface ToolUpdate {
  kind: "stdout" | "stderr" | "progress" | "status" | "custom";
  text?: string | undefined;
  percent?: number | undefined;
  customKind?: string | undefined;
  customData?: unknown;
}

export interface ExecutableToolContext {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly metadata?: unknown;
  readonly signal: AbortSignal;
  readonly onUpdate?: ((update: ToolUpdate) => void) | undefined;
}

export interface RunnableToolExecution {
  readonly isError?: false | undefined;
  readonly accesses?: ToolAccesses | undefined;
  readonly display?: ToolInputDisplay | undefined;
  readonly description?: string;
  readonly approvalRule: string;
  readonly execute: (ctx: ExecutableToolContext) => Promise<ExecutableToolResult>;
}

export type ToolExecution = RunnableToolExecution | ExecutableToolErrorResult;

export interface ExecutableTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  resolveExecution(input: unknown): ToolExecution | Promise<ToolExecution>;
}

export interface LoopStepHookContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly signal: AbortSignal;
  readonly llm: LLM;
}

export interface ToolExecutionHookContext extends LoopStepHookContext {
  readonly toolCall: ToolCall;
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
}

export interface ResolvedToolExecutionHookContext extends ToolExecutionHookContext {
  readonly execution: RunnableToolExecution;
}

export interface AuthorizeToolExecutionResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly syntheticResult?: ExecutableToolResult | undefined;
  readonly executionMetadata?: unknown;
}

export interface PrepareToolExecutionResult extends AuthorizeToolExecutionResult {
  readonly updatedArgs?: unknown;
}

export interface FinalizeToolResultContext extends ToolExecutionHookContext {
  readonly result: ExecutableToolResult;
}

export interface LoopAfterStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
}

export interface LoopStoppedStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopTerminalStepStopReason;
}

export interface BeforeStepResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
}

export interface ShouldContinueAfterStopResult {
  readonly continue: boolean;
}

export type BeforeStepHook = (
  ctx: LoopStepHookContext,
) => Promise<BeforeStepResult | undefined>;

export type AfterStepHook = (ctx: LoopAfterStepContext) => Promise<void>;

export type PrepareToolExecutionHook = (
  ctx: ToolExecutionHookContext,
) => Promise<PrepareToolExecutionResult | undefined>;

export type AuthorizeToolExecutionHook = (
  ctx: ResolvedToolExecutionHookContext,
) => Promise<AuthorizeToolExecutionResult | undefined>;

export type FinalizeToolResultHook = (
  ctx: FinalizeToolResultContext,
) => Promise<ExecutableToolResult | undefined>;

export type ShouldContinueAfterStopHook = (
  ctx: LoopStoppedStepContext,
) => Promise<ShouldContinueAfterStopResult | undefined>;

export interface LoopHooks {
  beforeStep?: BeforeStepHook | undefined;
  afterStep?: AfterStepHook | undefined;
  prepareToolExecution?: PrepareToolExecutionHook | undefined;
  authorizeToolExecution?: AuthorizeToolExecutionHook | undefined;
  finalizeToolResult?: FinalizeToolResultHook | undefined;
  shouldContinueAfterStop?: ShouldContinueAfterStopHook | undefined;
}

export type { ToolInputDisplay } from "./display.js";
