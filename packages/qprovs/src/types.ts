/** A message in the chat conversation sent to the LLM */
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  /** Tool calls made by the assistant (for assistant-role messages). */
  toolCalls?: Array<{
    id: string;
    type?: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

/** Simplified tool definition for LLM provider consumption */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Thinking mode level */
export type ThinkingLevel = "none" | "low" | "medium" | "high";

/** Parameters for an LLM chat completion request */
export interface ChatParams {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onStream?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onToolCallDelta?: (delta: { toolCallId: string; name?: string; argumentsPart?: string }) => void;
}

/** Response from an LLM chat completion */
export interface ChatResponse {
  message: AssistantMessage;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: TokenUsage;
  streamTiming?: StreamTiming;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type FinishReason =
  | "completed"
  | "tool_use"
  | "max_tokens"
  | "filtered"
  | "paused"
  | "unknown";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface StreamTiming {
  firstTokenMs: number;
  totalMs: number;
  tokensPerSecond: number;
}

/** Capability matrix for a model */
export interface ModelCapability {
  maxContextSize: number;
  maxOutputSize: number;
  supportsThinking: boolean;
  supportsStreaming: boolean;
  supportsToolUse: boolean;
  supportsMedia: boolean;
  supportsStructuredOutput: boolean;
  supportsParallelToolCalls: boolean;
}

/** Configuration for a provider */
export interface ProviderConfig {
  type: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  /** OAuth configuration */
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
    redirectPort?: number;
  };
  /** Environment variable overrides */
  envOverrides?: Record<string, string>;
  /** Custom HTTP headers */
  customHeaders?: Record<string, string>;
  /** Retry configuration overrides */
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
  };
  /** Fallback providers */
  fallback?: string[];
  /** Cache TTL in seconds */
  cacheTtlMs?: number;
}

/** Retry configuration */
export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

/** A model entry in the built-in capability catalog */
export interface ModelEntry {
  name: string;
  maxContextSize: number;
  maxOutputSize: number;
  supportsThinking: boolean;
  supportsStreaming: boolean;
  supportsToolUse: boolean;
  supportsMedia: boolean;
  supportsStructuredOutput: boolean;
  supportsParallelToolCalls: boolean;
  /** Optional pattern to match provider-specific model name variants */
  pattern?: string;
}

/** Capability catalog keyed by provider type */
export type CapabilityCatalog = Record<string, ModelEntry[]>;
