/**
 * Synthetic `mcp__<server>__authenticate` tool.
 *
 * When an MCP HTTP server lands in the `needs-auth` state — i.e. its
 * initial connection failed with a 401 / `UnauthorizedError` and no static
 * bearer token is configured — the connection manager replaces the real MCP
 * tools with this single tool. Calling it:
 *
 *  1. Asks McpOAuthService to perform RFC 9728 / RFC 8414 / RFC 7591
 *     discovery and produce an authorization URL.
 *  2. Returns that URL in the tool output so the model can present it to
 *     the human user.
 *  3. Blocks (up to 15 minutes) on the one-shot localhost callback listener
 *     owned by the OAuth service.
 *  4. Drives a manager-level `reconnect(name)` once tokens have been
 *     persisted, which flips the entry to `connected` and replaces the
 *     synthetic tool with the real MCP tools.
 */

import type { McpOAuthService, AlreadyAuthorizedError as AlreadyAuthorizedErrorType } from './oauth';
import { qualifyMcpToolName } from './tool-naming';

// Re-export for type checking
export type { AlreadyAuthorizedErrorType };

const AUTH_TOOL_TOOL_NAME = 'authenticate';
const DEFAULT_AUTH_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface McpAuthToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(ctx: { signal: AbortSignal }): Promise<{
    output: string;
    isError?: boolean;
  }>;
}

export interface CreateMcpAuthToolOptions {
  /** Friendly MCP server name as configured in `mcp.json`. */
  readonly serverName: string;
  /** Base URL of the MCP server (used for OAuth resource metadata discovery). */
  readonly serverUrl: string;
  /** OAuth orchestrator, typically session-scoped. */
  readonly oauthService: McpOAuthService;
  /**
   * Triggers a manager-level reconnect once tokens land on disk.
   */
  readonly reconnect: (signal?: AbortSignal) => Promise<void>;
  /**
   * Overrides the per-call OAuth wait timeout. Tests set this to a small
   * number; production callers should accept the default.
   */
  readonly timeoutMs?: number;
}

/**
 * Create a synthetic `mcp__<server>__authenticate` tool that drives the
 * OAuth flow for an MCP HTTP server that needs authorization.
 */
export function createMcpAuthTool(options: CreateMcpAuthToolOptions): McpAuthToolDefinition {
  const { serverName, serverUrl, oauthService, reconnect, timeoutMs } = options;
  const name = qualifyMcpToolName(serverName, AUTH_TOOL_TOOL_NAME);
  const description =
    `Authenticate with MCP server "${serverName}" via OAuth.\n\n` +
    `This server requires an OAuth login that has not yet been completed. ` +
    `Calling this tool starts the authorization flow:\n\n` +
    `  1. The tool prints an authorization URL.\n` +
    `  2. **You must show that URL to the user verbatim** and ask them to open it\n` +
    `     in a browser, sign in, and approve the Qode CLI client.\n` +
    `  3. The tool blocks (up to 15 minutes) until the browser redirects back to\n` +
    `     the local callback listener.\n` +
    `  4. On success, Qode reconnects the MCP server and the real tools\n` +
    `     replace this synthetic tool.\n\n` +
    `Take no arguments. Treat the URL as sensitive — do not modify it or strip\n` +
    `query parameters.`;

  const execute = async (ctx: {
    signal: AbortSignal;
  }): Promise<{ output: string; isError?: boolean }> => {
    ctx.signal.throwIfAborted();

    let flow: Awaited<ReturnType<McpOAuthService['beginAuthorization']>>;
    try {
      flow = await oauthService.beginAuthorization(serverName, serverUrl);
    } catch (error) {
      if (isAlreadyAuthorized(error)) {
        try {
          await reconnect(ctx.signal);
        } catch (reconnectError) {
          return {
            isError: true,
            output: `Reconnection failed for "${serverName}": ${formatError(reconnectError)}`,
          };
        }
        return {
          output:
            `MCP server "${serverName}" already had valid OAuth credentials. ` +
            `Reconnected; real tools are available now.`,
        };
      }
      return authErrorResult(serverName, error);
    }

    const urlText = flow.authorizationUrl.toString();

    try {
      await flow.complete({ signal: ctx.signal, timeoutMs: timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS });
    } catch (error) {
      return authErrorResult(serverName, error, urlText);
    }

    try {
      await reconnect(ctx.signal);
    } catch (error) {
      return authErrorResult(serverName, error);
    }

    return {
      output:
        `MCP server "${serverName}" authenticated successfully. ` +
        `The real MCP tools have replaced this synthetic authenticate tool.`,
    };
  };

  // No arguments; an empty object schema keeps providers happy across SDKs.
  return {
    name,
    description,
    parameters: {} as Record<string, unknown>,
    execute,
  };
}

function authErrorResult(
  serverName: string,
  error: unknown,
  authorizationUrl?: string,
): { output: string; isError: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  const suffix =
    authorizationUrl !== undefined
      ? `\n\nAuthorization URL (still valid if the listener has not timed out): ${authorizationUrl}`
      : '';
  return {
    isError: true,
    output: `OAuth flow for MCP server "${serverName}" did not complete: ${message}${suffix}`,
  };
}

function isAlreadyAuthorized(error: unknown): boolean {
  return error instanceof Error && error.name === 'AlreadyAuthorizedError';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
