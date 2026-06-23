/**
 * OllamaWebSearchProvider — Web search via the Ollama web search API.
 *
 * Calls https://ollama.com/api/web_search with the Ollama API key
 * and returns structured search results.
 */

import type { SearchResult, WebSearchOptions, WebSearchProvider } from "./web-connector.js";

/**
 * Response shape from the Ollama web search API.
 */
interface OllamaWebSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    snippet?: string;
    date?: string;
  }>;
  error?: string;
}

/**
 * OllamaWebSearchProvider — Uses the Ollama web search API.
 *
 * Requires an API key set via the `OLLAMA_API_KEY` environment variable
 * or passed explicitly in the constructor.
 */
export class OllamaWebSearchProvider implements WebSearchProvider {
  private baseUrl: string;
  private apiKey: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    this.baseUrl = (opts?.baseUrl ?? "https://ollama.com").replace(/\/+$/, "");
    this.apiKey = opts?.apiKey ?? process.env.OLLAMA_API_KEY ?? "";
  }

  async search(query: string, options?: WebSearchOptions): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error(
        "Ollama web search requires an API key. Set the OLLAMA_API_KEY environment variable " +
          "or pass an apiKey in the provider configuration.",
      );
    }

    const url = `${this.baseUrl}/api/web_search`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Ollama web search API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OllamaWebSearchResponse;

    if (data.error) {
      throw new Error(`Ollama web search error: ${data.error}`);
    }

    const results = data.results ?? [];

    // Apply limit if specified
    const limit = options?.limit ?? results.length;
    const limited = results.slice(0, limit);

    return limited.map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      // The Ollama API returns the full article text in the `content` field.
      // Use it as both `content` (full text) and `snippet` (preview).
      snippet: r.snippet ?? (r.content ? r.content.slice(0, 300) : ""),
      date: r.date,
      content: r.content,
    }));
  }
}
