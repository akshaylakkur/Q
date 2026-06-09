/**
 * LLM contract for the model capability used by the stateless loop.
 */

import type {
  FinishReason,
  ModelCapability,
  TokenUsage,
  ChatMessage,
} from "@q/qprovs";

import type { ToolDefinition } from "@q/qprovs";

export interface ToolCallDelta {
  readonly toolCallId: string;
  readonly name?: string | undefined;
  readonly argumentsPart?: string | undefined;
}

export interface LLMRequestLogContext {
  readonly turnId?: string;
  readonly step?: number;
  readonly stepUuid?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
}

export interface LLMStreamTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
}

export interface LLMChatParams {
  messages: ChatMessage[];
  tools: readonly ToolDefinition[];
  signal: AbortSignal;
  requestLogContext?: LLMRequestLogContext;
  onTextDelta?: ((delta: string) => void) | undefined;
  onThinkDelta?: ((delta: string) => void) | undefined;
  onToolCallDelta?: ((delta: ToolCallDelta) => void) | undefined;
}

export interface LLMChatResponse {
  /** Assistant text content (may be empty when tool calls are present). */
  content?: string | undefined;
  toolCalls: { id: string; name: string; arguments: string | null }[];
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  usage: TokenUsage;
  streamTiming?: LLMStreamTiming;
}

export interface LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;
  isRetryableError?(error: unknown): boolean;
  chat(params: LLMChatParams): Promise<LLMChatResponse>;
}
