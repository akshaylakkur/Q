/**
 * Shared utilities for MCP transport clients.
 *
 * Provides common helpers for converting between the @modelcontextprotocol/sdk
 * shapes and the internal MCPClient interface, as well as version strings and
 * request options.
 */

import type { MCPToolDefinition, MCPToolResult } from './types';

// ─── Client Identity ─────────────────────────────────────────────────────

export const Q_MCP_CLIENT_NAME = 'q-cli';

let _version: string | undefined;

/**
 * Resolve the current Qode CLI version at runtime. Falls back to '0.0.0' if
 * the version cannot be determined.
 */
export function getQMcpClientVersion(): string {
  if (_version !== undefined) return _version;
  try {
    // Dynamic import so this works both during `tsx` dev and from the built
    // artifact. The package.json is resolved relative to this package.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _version = (require('../../package.json') as { version: string }).version;
  } catch {
    _version = '0.0.0';
  }
  return _version;
}

export const Q_MCP_CLIENT_VERSION: string = /* @__PURE__ */ getQMcpClientVersion();

// ─── Unexpected Close Reporting ──────────────────────────────────────────

/**
 * Why-context attached when a runtime client notices its underlying transport
 * has gone away on its own — i.e. `close()` was NOT called by the manager.
 *
 * - `error` is the last error reported via the SDK's `onerror` channel, if any.
 * - `stderr` is the tail of bytes captured from the child process's stderr;
 *   populated only for the stdio transport.
 */
export interface UnexpectedCloseReason {
  readonly error?: Error;
  readonly stderr?: string;
}

export type UnexpectedCloseListener = (reason: UnexpectedCloseReason) => void;

// ─── Request Options ────────────────────────────────────────────────────

export interface McpRequestOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

/**
 * Build the `RequestOptions` object accepted by the MCP SDK's `callTool`,
 * including either the configured tool-call timeout, an in-flight abort
 * signal, both, or neither. Returns `undefined` when nothing needs to be
 * passed so the SDK falls back to its defaults.
 */
export function buildRequestOptions(
  toolCallTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): McpRequestOptions | undefined {
  if (toolCallTimeoutMs === undefined && signal === undefined) return undefined;
  return { timeout: toolCallTimeoutMs, signal };
}

// ─── SDK Shape Conversion ────────────────────────────────────────────────

interface SdkListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export function toMcpToolDefinition(tool: SdkListedTool): MCPToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
  };
}

/**
 * Normalise the SDK's `callTool` return into the internal MCPToolResult.
 * The SDK can return either the modern `{ content, isError }` shape or a
 * legacy `{ toolResult }` shape; we collapse the legacy shape to a single
 * text content block.
 */
export function toMcpToolResult(result: unknown): MCPToolResult {
  if (typeof result === 'object' && result !== null && 'content' in result) {
    const typed = result as { content: unknown; isError?: unknown };
    if (Array.isArray(typed.content)) {
      return {
        content: typed.content as MCPToolResult['content'],
        isError: typed.isError === true,
      };
    }
  }
  if (typeof result === 'object' && result !== null && 'toolResult' in result) {
    const legacy = (result as { toolResult: unknown }).toolResult;
    return {
      content: [
        {
          type: 'text',
          text: typeof legacy === 'string' ? legacy : JSON.stringify(legacy),
        },
      ],
      isError: false,
    };
  }
  return { content: [], isError: false };
}
