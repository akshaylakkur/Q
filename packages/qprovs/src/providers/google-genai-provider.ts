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
 * GoogleGenAIProvider — Adapter for Google Gemini API.
 *
 * Uses the Google AI Gemini API via REST.
 * Supports multi-modal, streaming, and thinking.
 */
export class GoogleGenAIProvider extends BaseProvider {
  readonly name = "google";

  private baseUrl: string;
  private apiKey: string;

  constructor(modelName: string, config: ProviderConfig) {
    super(modelName, config);
    this.baseUrl = (
      config.baseUrl || "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? this.resolveApiKey();
  }

  private resolveApiKey(): string {
    if (this.config.envOverrides?.apiKey) {
      return this.config.envOverrides.apiKey;
    }
    const envKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (envKey) return envKey;
    throw new Error(
      "Google/Gemini API key is required. Set it in provider config, GOOGLE_API_KEY env var, or apiKey field.",
    );
  }

  async generate(params: ChatParams): Promise<ChatResponse> {
    return this.executeWithRetry(params);
  }

  protected async doGenerate(
    params: ChatParams,
  ): Promise<ChatResponse> {
    // Gemini uses a different API structure — /models/{model}:generateContent
    const url = `${this.baseUrl}/models/${this.modelName}:generateContent?key=${this.apiKey}`;
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      contents: convertContents(params.messages),
      generationConfig: {
        ...(this.maxCompletionTokens > 0
          ? { maxOutputTokens: this.maxCompletionTokens }
          : {}),
      },
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: params.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
    }

    // System instruction
    const systemMessages = params.messages.filter(
      (m) => m.role === "system",
    );
    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => m.content).join("\n") }],
      };
    }

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
        new Error(`Google AI API error (${response.status}): ${errorText}`),
        { status: response.status },
      );
    }

    const data = (await response.json()) as GeminiResponse;
    const totalMs = Date.now() - startTime;
    const firstTokenMs = Date.now() - startTime;

    const candidate = data.candidates?.[0];
    if (!candidate) {
      // Check for blocked content
      if (data.promptFeedback?.blockReason) {
        return {
          message: { role: "assistant", content: "" },
          toolCalls: [],
          finishReason: "filtered",
          usage: {
            promptTokens: estimateTokens(params.messages),
            completionTokens: 0,
          },
          streamTiming: {
            firstTokenMs,
            totalMs,
            tokensPerSecond: 0,
          },
        };
      }
      throw new Error("Google AI returned no candidates");
    }

    let content = "";
    let toolCalls: ToolCall[] = [];

    for (const part of candidate.content?.parts ?? []) {
      if (hasText(part)) {
        content += part.text;
      }
      if (hasFunctionCall(part)) {
        const fc = part.functionCall;
        let args: Record<string, unknown> = {};
        try {
          args =
            typeof fc.args === "object"
              ? (fc.args as Record<string, unknown>)
              : JSON.parse(String(fc.args));
        } catch {
          args = { raw: String(fc.args) };
        }
        toolCalls.push({
          id: fc.name,
          name: fc.name,
          args,
        });
      }
    }

    const usageMetadata = data.usageMetadata;
    const promptTokens = usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = usageMetadata?.candidatesTokenCount ?? 0;
    const tokensPerSecond =
      totalMs > 0 && completionTokens > 0
        ? (completionTokens / totalMs) * 1000
        : 0;

    return {
      message: { role: "assistant", content },
      toolCalls,
      finishReason: convertFinishReason(
        candidate.finishReason,
        candidate.finishReason === "SAFETY"
      ),
      usage: {
        promptTokens,
        completionTokens,
        cacheReadTokens: usageMetadata?.cachedContentTokenCount,
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

// -- Gemini API types --

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
  usageMetadata?: GeminiUsageMetadata;
}

interface GeminiCandidate {
  content: {
    parts: GeminiPart[];
    role: string;
  };
  finishReason?: string;
  safetyRatings?: unknown[];
  citationMetadata?: unknown;
}

interface GeminiTextPart { text: string }
interface GeminiFunctionCallPart { functionCall: { name: string; args: unknown } }
type GeminiPart = GeminiTextPart | GeminiFunctionCallPart;

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  cachedContentTokenCount?: number;
}

// -- Helpers --

function convertContents(
  messages: ChatMessage[],
): Record<string, unknown>[] {
  const contents: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // Handled separately

    if (msg.role === "tool") {
      // Function response
      contents.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name: msg.toolName,
              response: { content: msg.content },
            },
          },
        ],
      });
    } else {
      const role = msg.role === "assistant" ? "model" : "user";
      contents.push({
        role,
        parts: [{ text: msg.content }],
      });
    }
  }

  return contents;
}

function convertFinishReason(
  reason?: string,
  isSafety?: boolean,
): FinishReason {
  if (isSafety) return "filtered";
  switch (reason) {
    case "STOP":
      return "completed";
    case "MAX_TOKENS":
      return "max_tokens";
    case "FUNCTION_CALL":
      return "tool_use";
    case "SAFETY":
      return "filtered";
    case "RECITATION":
      return "filtered";
    case "OTHER":
      return "unknown";
    default:
      return reason ? "unknown" : "completed";
  }
}

function hasText(part: GeminiPart): part is GeminiTextPart {
  return "text" in part;
}

function hasFunctionCall(part: GeminiPart): part is GeminiFunctionCallPart {
  return "functionCall" in part;
}

function estimateTokens(messages: ChatMessage[]): number {
  // Rough estimate: ~4 characters per token
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}
