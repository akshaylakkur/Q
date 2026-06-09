/**
 * QprovsLLM — Wraps a ChatProvider into the LLM interface expected by the loop.
 */

import type {
  ChatProvider,
  ChatMessage,
  ChatParams,
  ChatResponse,
} from "@q/qprovs";

import type { LLM, LLMChatParams, LLMChatResponse } from "../../loop/llm.js";

export class QprovsLLM implements LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  private readonly _provider: ChatProvider;

  constructor(config: {
    provider: ChatProvider;
    modelName: string;
    systemPrompt: string;
  }) {
    this._provider = config.provider;
    this.modelName = config.modelName;
    this.systemPrompt = config.systemPrompt;
  }

  isRetryableError(error: unknown): boolean {
    if (error && typeof error === "object") {
      const err = error as { status?: number };
      if (err.status === 429) return true;
      if (err.status !== undefined && err.status >= 500) return true;
    }
    return false;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    const providerMessages = this.buildProviderMessages(params);
    const providerTools = params.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));

    const chatParams: ChatParams = {
      messages: providerMessages,
      tools: providerTools.length > 0 ? providerTools : undefined,
      signal: params.signal,
      onStream: params.onTextDelta
        ? (chunk: string) => params.onTextDelta!(chunk)
        : undefined,
      onThinking: params.onThinkDelta
        ? (chunk: string) => params.onThinkDelta!(chunk)
        : undefined,
      onToolCallDelta: params.onToolCallDelta
        ? (delta: { toolCallId: string; name?: string; argumentsPart?: string }) =>
            params.onToolCallDelta!(delta)
        : undefined,
    };

    const response: ChatResponse = await this._provider.generate(chatParams);

    return {
      content: response.message?.content,
      toolCalls: response.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.args),
      })),
      providerFinishReason: response.finishReason,
      rawFinishReason: response.finishReason,
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
      },
    };
  }

  private buildProviderMessages(params: LLMChatParams): ChatMessage[] {
    const allMessages = [...params.messages];

    const providerMessages: ChatMessage[] = [];
    if (this.systemPrompt) {
      providerMessages.push({
        role: "system",
        content: this.systemPrompt,
      });
    }

    for (const msg of allMessages) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      const pm: ChatMessage = {
        role: msg.role,
        content,
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
      };
      // Preserve tool_calls from prior assistant messages so providers
      // that support tool-call history (OpenAI-compatible, Ollama, etc.)
      // can send them back to the model for context continuity.
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        pm.toolCalls = msg.toolCalls;
      }
      providerMessages.push(pm);
    }

    return providerMessages;
  }
}
