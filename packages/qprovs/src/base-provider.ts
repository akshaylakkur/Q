import type {
  ChatParams,
  ChatResponse,
  ModelCapability,
  ModelEntry,
  ProviderConfig,
  RetryConfig,
  ThinkingLevel,
} from "./types.js";
import { lookupModelCapability } from "./model-capabilities.js";
import { withRetry } from "./retry.js";
import { globalRequestCache, getCacheTtlMs } from "./cache.js";

/**
 * Base provider that all provider adapters extend.
 * Provides shared functionality: retry, caching, capability inference.
 */
export abstract class BaseProvider {
  /** Provider name (e.g., 'ollama', 'openai', 'anthropic') */
  abstract readonly name: string;

  /** The model name to use */
  protected modelName: string;

  /** Provider configuration */
  protected config: ProviderConfig;

  /** Thinking level */
  protected thinkingLevel: ThinkingLevel = "none";

  /** Max completion tokens (0 = use model default) */
  protected maxCompletionTokens = 0;

  /** Retry config */
  protected retryConfig: RetryConfig;

  constructor(modelName: string, config: ProviderConfig) {
    this.modelName = modelName;
    this.config = config;

    // Merge retry config from defaults and provider config
    this.retryConfig = {
      maxAttempts: config.retry?.maxAttempts ?? 3,
      baseDelayMs: config.retry?.baseDelayMs ?? 300,
      maxDelayMs: config.retry?.maxDelayMs ?? 5000,
      multiplier: config.retry?.multiplier ?? 2,
    };
  }

  /** Set thinking mode level */
  withThinking(level: ThinkingLevel): this {
    this.thinkingLevel = level;
    return this;
  }

  /** Set maximum completion tokens */
  withMaxCompletionTokens(n: number): this {
    this.maxCompletionTokens = n;
    return this;
  }

  /** Get capabilities for the current model */
  getCapability(): ModelCapability {
    return this.resolveCapability(this.modelName);
  }

  /** Get context size limit for the current model */
  getContextSizeLimit(): number {
    return this.resolveCapability(this.modelName).maxContextSize;
  }

  /** The model name being used */
  getModel(): string {
    return this.modelName;
  }

  /**
   * Generate a response from the LLM.
   * This is the main method that provider adapters must implement.
   */
  abstract generate(params: ChatParams): Promise<ChatResponse>;

  /**
   * Execute the actual API call with retry support.
   * Subclasses implement doGenerate() which is wrapped with retry + cache.
   */
  protected async executeWithRetry(
    params: ChatParams,
  ): Promise<ChatResponse> {
    // Check cache first (for non-streaming requests)
    if (!params.onStream && !params.onThinking) {
      const cached = globalRequestCache.get(this.modelName, params);
      if (cached) return cached;
    }

    const response = await withRetry(
      () => this.doGenerate(params),
      this.retryConfig,
    );

    // Cache the response (for non-streaming requests)
    if (!params.onStream && !params.onThinking) {
      globalRequestCache.set(
        this.modelName,
        params,
        response,
        getCacheTtlMs(this.config),
      );
    }

    return response;
  }

  /**
   * Subclasses implement this to perform the actual API call.
   * This is wrapped by executeWithRetry().
   */
  protected abstract doGenerate(
    params: ChatParams,
  ): Promise<ChatResponse>;

  /**
   * Resolve model capabilities from the built-in catalog.
   * Can be overridden by subclasses for custom logic.
   */
  protected resolveCapability(modelName: string): ModelCapability {
    const entry = lookupModelCapability(this.name, modelName);
    return this.entryToCapability(entry);
  }

  /** Convert a ModelEntry to ModelCapability */
  protected entryToCapability(entry: ModelEntry): ModelCapability {
    return {
      maxContextSize: entry.maxContextSize,
      maxOutputSize: entry.maxOutputSize,
      supportsThinking: entry.supportsThinking,
      supportsStreaming: entry.supportsStreaming,
      supportsToolUse: entry.supportsToolUse,
      supportsMedia: entry.supportsMedia,
      supportsStructuredOutput: entry.supportsStructuredOutput,
      supportsParallelToolCalls: entry.supportsParallelToolCalls,
    };
  }

  /**
   * Build a Fetch API-compatible request with timeout support via AbortSignal.
   */
  protected async fetchWithSignal(
    url: string,
    init: RequestInit & { timeout?: number },
  ): Promise<Response> {
    const { timeout, ...fetchInit } = init;

    let signal = fetchInit.signal;
    if (timeout && !signal) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      signal = controller.signal;

      // Clean up timeout on completion
      const originalSignal = fetchInit.signal;
      if (originalSignal) {
        originalSignal.addEventListener("abort", () => {
          controller.abort();
          clearTimeout(timeoutId);
        });
      }

      const response = await fetch(url, { ...fetchInit, signal });
      clearTimeout(timeoutId);
      return response;
    }

    return fetch(url, fetchInit);
  }
}
