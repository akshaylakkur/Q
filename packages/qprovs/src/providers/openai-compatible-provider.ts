import type {
  ChatMessage,
  ChatParams,
  ChatResponse,
  FinishReason,
  ProviderConfig,
  ToolCall,
} from "../types.js";
import { BaseProvider } from "../base-provider.js";

/**
 * OpenAICompatibleProvider — Generic adapter for any OpenAI-compatible endpoint.
 *
 * Works with services like Groq, Together AI, Fireworks, and any other
 * service that exposes an OpenAI-compatible /v1/chat/completions API.
 * Also serves as the base for Ollama (OpenAI-compatible mode).
 */
export class OpenAICompatibleProvider extends BaseProvider {
  readonly name = "openai-compatible";

  private baseUrl: string;
  private apiKey?: string;
  private headers: Record<string, string>;

  constructor(modelName: string, config: ProviderConfig) {
    super(modelName, config);

    const rawUrl = config.baseUrl ?? "http://localhost:11434/v1";
    this.baseUrl = rawUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey || undefined;
    this.headers = { ...(config.customHeaders ?? {}) };

    // Override with env vars if set
    if (config.envOverrides?.baseUrl) {
      this.baseUrl = config.envOverrides.baseUrl;
    }
    if (config.envOverrides?.apiKey) {
      this.apiKey = config.envOverrides.apiKey;
    }
  }

  async generate(params: ChatParams): Promise<ChatResponse> {
    return this.executeWithRetry(params);
  }

  protected async doGenerate(
    params: ChatParams,
  ): Promise<ChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: convertMessages(params.messages),
      stream: false,
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    if (this.maxCompletionTokens > 0) {
      body.max_tokens = this.maxCompletionTokens;
    }

    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headers,
    };

    if (this.apiKey) {
      reqHeaders["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchWithSignal(url, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw Object.assign(
        new Error(`Provider API error (${response.status}): ${errorText}`),
        { status: response.status },
      );
    }

    const data = (await response.json()) as CompatibleChatResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("Provider returned no choices");
    }

    const firstTokenMs = Date.now() - startTime;
    const totalMs = Date.now() - startTime;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const tokensPerSecond =
      totalMs > 0 && completionTokens > 0
        ? (completionTokens / totalMs) * 1000
        : 0;

    return {
      message: {
        role: "assistant",
        content: choice.message?.content ?? "",
      },
      toolCalls: convertToolCalls(choice.message?.tool_calls),
      finishReason: convertFinishReason(choice.finish_reason),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens,
        cacheWriteTokens: undefined,
      },
      streamTiming: {
        firstTokenMs,
        totalMs,
        tokensPerSecond,
      },
    };
  }
}

// -- Compatible API types --

interface CompatibleChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CompatibleChoice[];
  usage?: CompatibleUsage;
}

interface CompatibleChoice {
  index: number;
  message: CompatibleMessage;
  finish_reason: string | null;
}

interface CompatibleMessage {
  role: string;
  content: string;
  tool_calls?: CompatibleToolCall[];
}

interface CompatibleToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface CompatibleUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

// -- Helpers --

function convertMessages(
  messages: ChatMessage[],
): Record<string, unknown>[] {
  return messages.map((msg) => {
    const base: Record<string, unknown> = {
      role: msg.role,
      content: msg.content,
    };
    if (msg.role === "tool") {
      base.tool_call_id = msg.toolCallId;
      base.name = msg.toolName;
    }
    // Include tool_calls for assistant messages that made tool calls
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      base.tool_calls = msg.toolCalls;
    }
    return base;
  });
}

function convertToolCalls(
  toolCalls?: CompatibleToolCall[],
): ToolCall[] {
  if (!toolCalls) return [];
  return toolCalls.map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch {
      args = { raw: tc.function.arguments };
    }
    return {
      id: tc.id,
      name: tc.function.name,
      args,
    };
  });
}

function convertFinishReason(
  reason: string | null,
): FinishReason {
  switch (reason) {
    case "stop":
      return "completed";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "filtered";
    default:
      return reason === null ? "completed" : "unknown";
  }
}
