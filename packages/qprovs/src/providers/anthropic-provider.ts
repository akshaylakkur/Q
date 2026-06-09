import type {
  ChatMessage,
  ChatParams,
  ChatResponse,
  FinishReason,
  ProviderConfig,
  ToolCall,
} from "../types.js";
import { BaseProvider } from "../base-provider.js";
import { lookupModelCapability } from "../model-capabilities.js";

/**
 * AnthropicProvider — Adapter for Anthropic's Messages API.
 *
 * Supports extended thinking mode, streaming, tool use, and image input.
 * Uses the Anthropic REST API directly.
 */
export class AnthropicProvider extends BaseProvider {
  readonly name = "anthropic";

  private baseUrl: string;
  private apiKey: string;
  private anthropicVersion = "2023-06-01";

  constructor(modelName: string, config: ProviderConfig) {
    super(modelName, config);
    this.baseUrl = (
      config.baseUrl || "https://api.anthropic.com/v1"
    ).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? this.resolveApiKey();
  }

  private resolveApiKey(): string {
    if (this.config.envOverrides?.apiKey) {
      return this.config.envOverrides.apiKey;
    }
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) return envKey;
    throw new Error(
      "Anthropic API key is required. Set it in provider config, ANTHROPIC_API_KEY env var, or apiKey field.",
    );
  }

  async generate(params: ChatParams): Promise<ChatResponse> {
    return this.executeWithRetry(params);
  }

  protected async doGenerate(
    params: ChatParams,
  ): Promise<ChatResponse> {
    const url = `${this.baseUrl}/messages`;
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: convertMessagesAnthropic(params.messages),
      max_tokens: this.maxCompletionTokens > 0 ? this.maxCompletionTokens : 8192,
      stream: false,
    };

    // System prompt: Anthropic uses a separate system parameter
    const systemMessages = params.messages.filter(
      (m) => m.role === "system",
    );
    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => m.content).join("\n");
    }

    // Tool definitions
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    // Extended thinking mode
    if (this.thinkingLevel !== "none" && this.supportsThinking()) {
      const thinkingBudget = this.getThinkingBudget();
      body.thinking = {
        type: "enabled",
        budget_tokens: thinkingBudget,
      };
    }

    const response = await this.fetchWithSignal(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion,
        ...(this.config.customHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw Object.assign(
        new Error(`Anthropic API error (${response.status}): ${errorText}`),
        { status: response.status },
      );
    }

    const data = (await response.json()) as AnthropicResponse;

    return this.extractResponse(data, startTime);
  }

  private extractResponse(
    data: AnthropicResponse,
    startTime: number,
  ): ChatResponse {
    const firstTokenMs = Date.now() - startTime;
    const totalMs = Date.now() - startTime;

    let content = "";
    let toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        let args: Record<string, unknown> = {};
        try {
          args =
            typeof block.input === "object"
              ? (block.input as Record<string, unknown>)
              : JSON.parse(String(block.input));
        } catch {
          args = { raw: String(block.input) };
        }
        toolCalls.push({
          id: block.id,
          name: block.name,
          args,
        });
      }
    }

    const completionTokens = data.usage?.output_tokens ?? 0;
    const tokensPerSecond =
      totalMs > 0 && completionTokens > 0
        ? (completionTokens / totalMs) * 1000
        : 0;

    return {
      message: { role: "assistant", content },
      toolCalls,
      finishReason: convertAnthropicStopReason(data.stop_reason),
      usage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens,
        cacheReadTokens: data.usage?.cache_read_input_tokens,
        cacheWriteTokens: data.usage?.cache_creation_input_tokens,
      },
      streamTiming: {
        firstTokenMs,
        totalMs,
        tokensPerSecond,
      },
    };
  }

  private supportsThinking(): boolean {
    const cap = lookupModelCapability("anthropic", this.modelName);
    return cap.supportsThinking;
  }

  private getThinkingBudget(): number {
    const maxOutput = this.maxCompletionTokens > 0
      ? this.maxCompletionTokens
      : 8192;
    switch (this.thinkingLevel) {
      case "low":
        return Math.min(2048, maxOutput);
      case "medium":
        return Math.min(4096, maxOutput);
      case "high":
        return Math.min(16384, maxOutput);
      default:
        return 4096;
    }
  }
}

// -- Anthropic Messages API types --

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// -- Helpers --

function convertMessagesAnthropic(
  messages: ChatMessage[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // Handled separately

    if (msg.role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: msg.content,
          },
        ],
      });
    } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      // Build content blocks: text + tool_use blocks
      const contentBlocks: Record<string, unknown>[] = [];
      if (msg.content) {
        contentBlocks.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          parsedArgs = { raw: tc.function.arguments };
        }
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: parsedArgs,
        });
      }
      result.push({
        role: "assistant",
        content: contentBlocks,
      });
    } else {
      result.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  return result;
}

function convertAnthropicStopReason(
  reason: string | null,
): FinishReason {
  switch (reason) {
    case "end_turn":
      return "completed";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "completed";
    default:
      return reason === null ? "completed" : "unknown";
  }
}
