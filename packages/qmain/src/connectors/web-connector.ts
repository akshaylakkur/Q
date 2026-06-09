/**
 * Options for WebConnector
 */
export interface WebConnectorOptions {
  /** Custom fetch implementation (for testing) */
  fetchImpl?: typeof globalThis.fetch;
  /** Web search provider (optional — throws if not set when search is called) */
  webSearchProvider?: WebSearchProvider;
  /** User-Agent string for HTTP requests */
  userAgent?: string;
  /** Maximum response size in bytes. Default 10MB */
  maxBytes?: number;
  /** Whether to allow private IP addresses. Default false */
  allowPrivateAddresses?: boolean;
}

/**
 * A web search result
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  content?: string;
}

/**
 * Options for web search
 */
export interface WebSearchOptions {
  limit?: number;
  includeContent?: boolean;
}

/**
 * Abstract web search provider interface.
 * Backends like Moonshot, SERP API, Tavily can implement this.
 */
export interface WebSearchProvider {
  search(query: string, options?: WebSearchOptions): Promise<SearchResult[]>;
}

/**
 * Error thrown when a connector feature is not available.
 */
export class ConnectorNotAvailableError extends Error {
  constructor(feature: string) {
    super(`Connector feature not available: ${feature}`);
    this.name = "ConnectorNotAvailableError";
  }
}

/**
 * Error thrown when an HTTP request fails.
 */
export class HttpFetchError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpFetchError";
    this.status = status;
  }
}

/**
 * WebConnector — Web operations for fetching URLs and searching the web.
 *
 * fetchUrl fetches content from URLs with HTML text extraction.
 * webSearch delegates to a configurable provider (Moonshot, Tavily, SERP, etc.).
 */
export class WebConnector {
  private fetchImpl: typeof globalThis.fetch;
  private webSearchProvider?: WebSearchProvider;
  private userAgent: string;
  private maxBytes: number;
  private allowPrivateAddresses: boolean;

  constructor(opts?: WebConnectorOptions) {
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
    this.webSearchProvider = opts?.webSearchProvider;
    this.userAgent =
      opts?.userAgent ??
      "Mozilla/5.0 (compatible; VBot/1.0; +https://v.sh/bot)";
    this.maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024; // 10MB
    this.allowPrivateAddresses = opts?.allowPrivateAddresses ?? false;
  }

  /**
   * Fetch a URL and extract text content.
   *
   * Features:
   * - SSRF guard against private/internal IPs (checks both original and redirected URLs)
   * - Content size limit enforcement
   * - Content-type-aware handling (plain text vs HTML)
   */
  async fetchUrl(url: string): Promise<string> {
    this.assertSafeTarget(url);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "text/html, text/plain, text/markdown, */*",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // Wrap network errors (timeout, DNS failure, connection refused, etc.)
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("aborted") || message.includes("timed out")) {
        throw new HttpFetchError(408, `Request timed out: ${url}`);
      }
      throw new Error(`Network error fetching ${url}: ${message}`);
    }

    if (!response.ok) {
      throw new HttpFetchError(response.status, `HTTP ${response.status}: ${response.statusText}`);
    }

    // **SSRF guard against redirect attacks**: check the final URL after all redirects
    if (response.url && response.url !== url) {
      this.assertSafeTarget(response.url);
    }

    // Check content-length header first
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > this.maxBytes) {
      throw new Error(`Response too large: ${contentLength} bytes (max ${this.maxBytes})`);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const isPlainText =
      contentType.startsWith("text/plain") || contentType.startsWith("text/markdown");

    // Read response as text with size limit
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.length;
      if (totalBytes > this.maxBytes) {
        throw new Error(`Response exceeded maximum size of ${this.maxBytes} bytes`);
      }

      chunks.push(value);
    }

    const decoder = new TextDecoder();
    const html = chunks.length > 0
      ? decoder.decode(Buffer.concat(chunks))
      : "";

    if (!html) {
      return "";
    }

    if (isPlainText) {
      return html.trim();
    }

    // Extract text content from HTML
    return this.extractTextFromHtml(html);
  }

  /**
   * Search the web using the configured provider.
   *
   * @throws ConnectorNotAvailableError if no provider is configured
   */
  async webSearch(query: string, opts?: WebSearchOptions): Promise<SearchResult[]> {
    if (!this.webSearchProvider) {
      throw new ConnectorNotAvailableError(
        "webSearch: no WebSearchProvider configured. Configure a search provider or set one via WebConnectorOptions.",
      );
    }
    return this.webSearchProvider.search(query, opts);
  }

  /**
   * Set or replace the web search provider at runtime.
   */
  setWebSearchProvider(provider: WebSearchProvider): void {
    this.webSearchProvider = provider;
  }

  /**
   * SSRF guard: reject non-http(s) URLs and private/reserved IP addresses.
   * Checks both IPv4 and IPv6 private ranges.
   */
  private assertSafeTarget(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Only http/https URLs are allowed, got: ${parsed.protocol}`);
    }

    if (this.allowPrivateAddresses) return;

    const hostname = parsed.hostname.toLowerCase();

    // Strip IPv6 brackets for internal checking
    const cleanHostname = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

    // Reject loopback addresses
    if (
      cleanHostname === "localhost" ||
      cleanHostname === "127.0.0.1" ||
      cleanHostname === "::1" ||
      cleanHostname === "0.0.0.0"
    ) {
      throw new Error(`URL points to a loopback address: ${url}`);
    }

    // Reject IPv4 private/reserved ranges
    if (
      cleanHostname.startsWith("10.") ||
      cleanHostname.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(cleanHostname) ||
      cleanHostname.startsWith("169.254.") ||
      cleanHostname.startsWith("0.") ||
      cleanHostname.startsWith("127.")
    ) {
      throw new Error(`URL points to a private/local address: ${url}`);
    }

    // Reject IPv6 unique local (fc00::/7, fd00::/7) and link-local (fe80::/10)
    if (
      cleanHostname.startsWith("fc") ||
      cleanHostname.startsWith("fd") ||
      cleanHostname.startsWith("fe8") ||
      cleanHostname.startsWith("fe9") ||
      cleanHostname.startsWith("fea") ||
      cleanHostname.startsWith("feb")
    ) {
      throw new Error(`URL points to a private IPv6 address: ${url}`);
    }
  }

  /**
   * Extract text content from HTML using regex-based tag stripping.
   *
   * Approach:
   * 1. Remove <script>, <style>, <noscript> elements and their content
   * 2. Extract title from <title> tag
   * 3. Prefer content from <article> or <main> containers
   * 4. Fall back to <body> content
   * 5. Strip all remaining HTML tags
   * 6. Decode common HTML entities
   * 7. Normalize whitespace
   */
  private extractTextFromHtml(html: string): string {
    let text = html;

    // Remove scripts, styles, noscripts (including their content)
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

    // Remove HTML comments
    text = text.replace(/<!--[\s\S]*?-->/g, "");

    // Extract title
    const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1]!.trim() : "";

    // Try to find article/main content
    let content = "";
    const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

    if (articleMatch && mainMatch) {
      // Use whichever is longer (likely the more substantive one)
      content = articleMatch[1]!.length >= mainMatch[1]!.length
        ? articleMatch[1]!
        : mainMatch[1]!;
    } else if (articleMatch) {
      content = articleMatch[1]!;
    } else if (mainMatch) {
      content = mainMatch[1]!;
    } else {
      // Fallback: extract body content
      const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      content = bodyMatch ? bodyMatch[1]! : text;
    }

    // Strip all remaining HTML tags
    content = content.replace(/<[^>]*>/g, " ");

    // Decode common HTML entities (both named and numeric)
    content = this.decodeHtmlEntities(content);

    // Normalize whitespace
    content = content.replace(/\s+/g, " ").trim();

    // If content is empty, return empty string
    if (!content) {
      return "";
    }

    // Prepend title if present and not already in content
    if (title && !content.startsWith(title)) {
      return `# ${title}\n\n${content}`;
    }

    return content;
  }

  /**
   * Decode HTML entities in a string, including named, decimal, and hex entities.
   */
  private decodeHtmlEntities(text: string): string {
    return text
      // Named entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, "\u00A0")
      .replace(/&mdash;/g, "\u2014")
      .replace(/&ndash;/g, "\u2013")
      .replace(/&hellip;/g, "\u2026")
      .replace(/&lsquo;/g, "\u2018")
      .replace(/&rsquo;/g, "\u2019")
      .replace(/&ldquo;/g, "\u201C")
      .replace(/&rdquo;/g, "\u201D")
      .replace(/&copy;/g, "\u00A9")
      .replace(/&reg;/g, "\u00AE")
      .replace(/&trade;/g, "\u2122")
      .replace(/&bull;/g, "\u2022")
      .replace(/&middot;/g, "\u00B7")
      .replace(/&eacute;/g, "\u00E9")
      .replace(/&egrave;/g, "\u00E8")
      .replace(/&agrave;/g, "\u00E0")
      .replace(/&ocirc;/g, "\u00F4")
      .replace(/&uuml;/g, "\u00FC")
      .replace(/&ccedil;/g, "\u00E7")
      // Decimal numeric entities
      .replace(/&#(\d+);/g, (_match, num) => String.fromCodePoint(parseInt(num, 10)))
      // Hex numeric entities
      .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)));
  }
}
