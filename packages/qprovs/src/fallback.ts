import type { ChatParams, ChatResponse } from "./types.js";
import type { ChatProvider } from "./provider.js";

/**
 * FallbackChain — Executes providers in order until one succeeds.
 *
 * A configurable ordered list of providers to try if the primary fails.
 * On failure of a provider, the next in the chain is used.
 * Only non-retryable errors trigger fallback; retries are handled internally
 * by each provider's retry logic.
 */
export class FallbackChain {
  private providers: ChatProvider[];

  constructor(providers: ChatProvider[]) {
    if (providers.length === 0) {
      throw new Error("FallbackChain requires at least one provider");
    }
    this.providers = providers;
  }

  /**
   * Execute the fallback chain for a given prompt.
   * Tries each provider in order until one succeeds.
   * If all fail, throws the last error.
   */
  async generate(params: ChatParams): Promise<ChatResponse> {
    let lastError: Error | undefined;

    for (const provider of this.providers) {
      try {
        return await provider.generate(params);
      } catch (error) {
        lastError =
          error instanceof Error
            ? error
            : new Error(String(error));

        // Log the failure
        console.error(
          `[FallbackChain] Provider "${provider.name}" failed: ${lastError.message}`,
        );
        // Continue to next provider
      }
    }

    throw lastError ?? new Error("All fallback providers failed");
  }

  /** Get the list of providers in this chain */
  getProviders(): ChatProvider[] {
    return [...this.providers];
  }
}
