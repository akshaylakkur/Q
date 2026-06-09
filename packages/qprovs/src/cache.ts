import type { ChatParams, ChatResponse, ProviderConfig } from "./types.js";

/** A cache key for LLM requests */
interface CacheKey {
  model: string;
  messages: string; // JSON-serialized messages
  tools: string; // JSON-serialized tools (or empty string)
}

/** A cached response entry */
interface CacheEntry {
  response: ChatResponse;
  expiresAt: number;
}

/**
 * Request cache for identical LLM requests within a TTL window.
 * Uses a simple in-memory Map with expiration.
 */
export class RequestCache {
  private cache = new Map<string, CacheEntry>();
  private defaultTtlMs: number;

  constructor(defaultTtlMs = 5000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Build a cache key from the model name and params.
   * Only caches non-streaming requests.
   */
  private buildKey(model: string, params: ChatParams): string | null {
    // Don't cache streaming requests
    if (params.onStream || params.onThinking) {
      return null;
    }

    const key: CacheKey = {
      model,
      messages: JSON.stringify(params.messages),
      tools: params.tools ? JSON.stringify(params.tools) : "",
    };

    return JSON.stringify(key);
  }

  /** Get a cached response if available and not expired */
  get(model: string, params: ChatParams): ChatResponse | undefined {
    const key = this.buildKey(model, params);
    if (!key) return undefined;

    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.response;
  }

  /** Store a response in the cache */
  set(
    model: string,
    params: ChatParams,
    response: ChatResponse,
    ttlMs?: number,
  ): void {
    const key = this.buildKey(model, params);
    if (!key) return;

    this.cache.set(key, {
      response,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /** Clear the entire cache */
  clear(): void {
    this.cache.clear();
  }

  /** Remove expired entries */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  /** Get cache size */
  get size(): number {
    return this.cache.size;
  }
}

/** Global cache instance */
export const globalRequestCache = new RequestCache();

/**
 * Create a cache TTL configuration from provider config.
 */
export function getCacheTtlMs(config?: ProviderConfig): number {
  if (config?.cacheTtlMs !== undefined) {
    return config.cacheTtlMs;
  }
  return 5000; // default 5 seconds
}
