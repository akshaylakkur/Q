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
 * OllamaProvider — Local inference through Ollama's OpenAI-compatible endpoint.
 *
 * Uses the /v1/chat/completions endpoint at localhost:11434.
 * Supports streaming, tool use (model-dependent), and basic chat.
 */
export class OllamaProvider extends BaseProvider {
  readonly name = "ollama";

  private baseUrl: string;

  constructor(modelName: string, config: ProviderConfig) {
    super(modelName, config);
    this.baseUrl = (config.baseUrl || "http://localhost:11434").replace(
      /\/+$/,
      "",
    );
  }

  async generate(params: ChatParams): Promise<ChatResponse> {
    return this.executeWithRetry(params);
  }

  protected async doGenerate(
    params: ChatParams,
  ): Promise<ChatResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
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

    // Handle streaming
    if (params.onStream) {
      body.stream = true;

      const response = await this.fetchWithSignal(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw Object.assign(
          new Error(`Ollama API error (${response.status}): ${errorText}`),
          { status: response.status },
        );
      }

      return this.processStream(response, params, startTime);
    }

    // Non-streaming request
    const response = await this.fetchWithSignal(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw Object.assign(
        new Error(`Ollama API error (${response.status}): ${errorText}`),
        { status: response.status },
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("Ollama returned no choices");
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
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      streamTiming: {
        firstTokenMs,
        totalMs,
        tokensPerSecond,
      },
    };
  }

  private async processStream(
    response: Response,
    params: ChatParams,
    startTime: number,
  ): Promise<ChatResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let toolCalls: ToolCall[] = [];
    let finishReason: FinishReason = "unknown";
    let promptTokens = 0;
    let completionTokens = 0;
    let firstTokenMs = 0;
    let isFirstChunk = true;
    let totalMs = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") continue;

          try {
            const chunk = JSON.parse(dataStr) as OllamaStreamChunk;

            if (isFirstChunk && chunk.choices?.[0]?.delta?.content) {
              firstTokenMs = Date.now() - startTime;
              isFirstChunk = false;
            }

            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              content += delta.content;
              params.onStream?.(delta.content);
            }

            // Accumulate tool calls & emit streaming tool call deltas
            if (delta?.tool_calls) {
              for (const tcChunk of delta.tool_calls) {
                const existing = toolCalls.find(
                  (tc) => tc.id === tcChunk.id,
                );
                if (existing) {
                  if (tcChunk.function?.arguments) {
                    // Accumulate raw arguments string. The Ollama API streams
                    // tool call arguments as partial JSON strings across
                    // multiple chunks. We accumulate the raw string and only
                    // parse it when it's complete (on the next tool call or
                    // at the end of the stream).
                    const raw = ((existing as any)._rawArgs ?? "") as string;
                    const updated = raw + tcChunk.function.arguments;
                    (existing as any)._rawArgs = updated;
                    // Try to parse — if it succeeds, store the parsed result
                    // and clear the raw accumulator. If it fails, the
                    // arguments are still being streamed.
                    try {
                      existing.args = JSON.parse(updated) as Record<string, unknown>;
                      (existing as any)._rawArgs = "";
                    } catch {
                      // Still accumulating — keep the raw string
                    }
                    // Emit the streaming delta so the UI can show live args build-up
                    const argsPart: string = tcChunk.function.arguments!;
                    const tcId: string = tcChunk.id ?? ("tc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
                    params.onToolCallDelta?.({
                      toolCallId: tcId,
                      argumentsPart: argsPart,
                    });
                  }
                } else if (tcChunk.id) {
                  // Emit the name + first args chunk
                  const argsPart: string = tcChunk.function?.arguments ?? "";
                  const tcId: string = tcChunk.id ?? ("tc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
                  if (tcChunk.function?.name) {
                    params.onToolCallDelta?.({
                      toolCallId: tcId,
                      name: tcChunk.function.name,
                      argumentsPart: argsPart,
                    });
                  } else if (argsPart) {
                    params.onToolCallDelta?.({
                      toolCallId: tcId,
                      argumentsPart: argsPart,
                    });
                  }
                  const newTc: ToolCall = {
                    id: tcChunk.id,
                    name: tcChunk.function?.name ?? "",
                    args: {},
                  };
                  // If arguments are provided in the same chunk, parse them
                  if (argsPart) {
                    try {
                      newTc.args = JSON.parse(argsPart) as Record<string, unknown>;
                    } catch {
                      // Partial JSON — store raw for accumulation
                      (newTc as any)._rawArgs = argsPart;
                    }
                  }
                  toolCalls.push(newTc);
                }
              }
            }

            const finish = chunk.choices?.[0]?.finish_reason;
            if (finish) {
              finishReason = convertFinishReason(finish);
            }

            if (chunk.usage) {
              promptTokens = chunk.usage.prompt_tokens ?? 0;
              completionTokens = chunk.usage.completion_tokens ?? 0;
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    totalMs = Date.now() - startTime;
    const tokensPerSecond =
      totalMs > 0 && completionTokens > 0
        ? (completionTokens / totalMs) * 1000
        : 0;

    return {
      message: { role: "assistant", content },
      toolCalls,
      finishReason,
      usage: {
        promptTokens,
        completionTokens,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      streamTiming: {
        firstTokenMs: firstTokenMs || totalMs,
        totalMs,
        tokensPerSecond,
      },
    };
  }
}

// -- OpenAI-compatible response types --

interface OllamaChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OllamaChoice[];
  usage?: OllamaUsage;
}

interface OllamaChoice {
  index: number;
  message: OllamaMessage;
  finish_reason: string | null;
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface OllamaUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

interface OllamaStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// -- Conversion helpers --

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
  toolCalls?: OllamaToolCall[],
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
