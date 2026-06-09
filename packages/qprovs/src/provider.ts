import type { ChatParams, ChatResponse, ModelCapability, ProviderConfig, ThinkingLevel } from "./types.js";

import {
  OllamaProvider,
  OpenAIProvider,
  OpenAICompatibleProvider,
  AnthropicProvider,
  GoogleGenAIProvider,
  KimiProvider,
} from "./providers/index.js";

/**
 * ChatProvider — Unified LLM provider abstraction.
 *
 * Each provider adapter implements this interface to
 * normalize the API surface across Anthropic, OpenAI,
 * Google Gemini, Ollama, and custom endpoints.
 */
export interface ChatProvider {
  /** Provider name (e.g., 'anthropic', 'openai', 'ollama') */
  readonly name: string;

  /** Generate a response from the LLM */
  generate(params: ChatParams): Promise<ChatResponse>;

  /** Set thinking mode level */
  withThinking(level: ThinkingLevel): this;

  /** Set maximum completion tokens */
  withMaxCompletionTokens(n: number): this;

  /** Get capabilities for the current model */
  getCapability(): ModelCapability;

  /** Get context size limit for the current model */
  getContextSizeLimit(): number;

  /** Get the model name being used */
  getModel(): string;
}

/**
 * ProviderFactory — Creates the correct provider adapter
 * from a config string.
 */
export class ProviderFactory {
  /**
   * Create a provider adapter from configuration.
   */
  static create(
    type: string,
    modelName: string,
    config: ProviderConfig,
  ): ChatProvider {
    switch (type) {
      case "anthropic":
        return new AnthropicProvider(modelName, config);
      case "openai":
        return new OpenAIProvider(modelName, config);
      case "google":
        return new GoogleGenAIProvider(modelName, config);
      case "ollama":
        return new OllamaProvider(modelName, config);
      case "kimi":
        return new KimiProvider(modelName, config);
      case "openai-compatible":
        return new OpenAICompatibleProvider(modelName, config);
      default:
        throw new Error(
          `Unknown provider type: ${type}. Supported types: anthropic, openai, google, ollama, kimi, openai-compatible`,
        );
    }
  }

  /**
   * Get the list of supported provider types.
   */
  static getSupportedTypes(): string[] {
    return [
      "anthropic",
      "openai",
      "google",
      "ollama",
      "kimi",
      "openai-compatible",
    ];
  }
}
