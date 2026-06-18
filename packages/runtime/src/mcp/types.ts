/**
 * MCP protocol types and the minimal client contract consumed by
 * McpConnectionManager.
 *
 * This is a transport-agnostic seam: implementations can wrap
 * @modelcontextprotocol/sdk, a bespoke stdio client, an HTTP SSE client,
 * or a mock for testing. Keeping the surface small lets tests inject fakes
 * without pulling in the full SDK type graph.
 */

// ─── MCP Tool Definition ─────────────────────────────────────────────────

/**
 * An MCP tool definition as returned by an MCP server's `tools/list` method.
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

// ─── MCP Tool Result ────────────────────────────────────────────────────

/**
 * Inline resource contents nested under an EmbeddedResource block.
 * Exactly one of `text` or `blob` is populated, per the MCP schema's
 * `TextResourceContents | BlobResourceContents` union.
 */
export interface MCPEmbeddedResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

/**
 * A content block as returned by an MCP tool call (`tools/call`).
 *
 * This is a structural subset of the MCP protocol `ContentBlock` union,
 * covering the shapes that output processing knows how to convert.
 * Additional fields are ignored.
 */
export interface MCPContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: MCPEmbeddedResourceContents;
  [key: string]: unknown;
}

/**
 * Result of a single MCP tool invocation.
 *
 * Matches the shape returned by the MCP protocol's `tools/call` method.
 */
export interface MCPToolResult {
  content: MCPContentBlock[];
  isError: boolean;
}

// ─── MCPClient Interface ─────────────────────────────────────────────────

/**
 * Minimal MCP client interface consumed by McpConnectionManager
 * and tool callers.
 *
 * This is a transport-agnostic seam: implementations can wrap
 * @modelcontextprotocol/sdk stdio or HTTP transport clients, or a
 * mock for testing.
 */
export interface MCPClient {
  /** List the tools advertised by the MCP server. */
  listTools(): Promise<MCPToolDefinition[]>;
  /**
   * Invoke a tool by name with the given JSON arguments.
   *
   * `signal`, when provided, is forwarded to the underlying transport so an
   * abort from the loop (e.g. user cancellation) propagates all the way to
   * the server instead of leaving the request running in the background.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult>;
}

// ─── Utilities ───────────────────────────────────────────────────────────

/**
 * Validate the `inputSchema` field of an MCP tool definition. MCP advertises
 * input schemas as JSON Schema objects; reject anything that is not a plain
 * object so downstream consumers never see `null` or a primitive.
 */
export function assertMcpInputSchema(
  toolName: string,
  inputSchema: unknown,
): Record<string, unknown> {
  if (typeof inputSchema === 'object' && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>;
  }
  throw new Error(`Invalid inputSchema for MCP tool "${toolName}": schema must be a JSON object`);
}
