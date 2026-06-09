/**
 * Core types for the agent engine.
 */

/** Token usage tracking */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Reason why an LLM response finished */
export type FinishReason =
  | "completed"
  | "tool_use"
  | "max_tokens"
  | "filtered"
  | "paused"
  | "unknown";

/** Role in the conversation */
export type MessageRole = "user" | "assistant" | "system" | "tool";

/** A single message in the conversation */
export interface Message {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
}

/** Execution result from a turn or step */
export interface ExecutionResult {
  status: "completed" | "failed" | "interrupted";
  output: string;
  usage: TokenUsage;
}
