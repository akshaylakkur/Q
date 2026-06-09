/**
 * HTTP/SSE MCP transport client.
 *
 * Wraps the @modelcontextprotocol/sdk StreamableHTTPClientTransport and
 * exposes the small MCPClient surface. Static bearer tokens are looked up
 * from process.env via the configured env var name. OAuth providers can
 * be attached separately by the connection manager.
 */

import type { McpServerHttpConfig } from '../config/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  buildRequestOptions,
  Q_MCP_CLIENT_NAME,
  Q_MCP_CLIENT_VERSION,
  toMcpToolDefinition,
  toMcpToolResult,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from './client-shared';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export interface HttpMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly toolCallTimeoutMs?: number;
  /**
   * Reads `process.env[name]` by default. Tests can inject a deterministic
   * lookup function so they do not have to mutate global env.
   */
  readonly envLookup?: (name: string) => string | undefined;
  /**
   * Lets tests inject a fake `fetch` for the underlying transport.
   */
  readonly fetch?: typeof fetch;
  /**
   * OAuth client provider attached to the transport. Set only when the server
   * has no static token configuration; the SDK uses this to handle 401s with
   * RFC 9728 / RFC 8414 / DCR discovery and PKCE. The connection manager wires
   * this in and surfaces `UnauthorizedError` as a `needs-auth` status.
   */
  readonly oauthProvider?: OAuthClientProvider;
}

/**
 * Wraps the SDK streamable-HTTP transport as an MCPClient.
 * Static bearer tokens are looked up from `process.env[bearerTokenEnvVar]`.
 * OAuth providers are attached separately by the connection manager.
 */
export class HttpMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly toolCallTimeoutMs?: number;
  private started = false;
  private closed = false;
  // See StdioMcpClient.ready — distinguishes handshake-phase failures from
  // post-ready disconnects.
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;
  // Latch so onerror and a (theoretical) onclose for the same transport
  // failure do not double-fire.
  private unexpectedCloseFired = false;

  constructor(config: McpServerHttpConfig, options: HttpMcpClientOptions = {}) {
    const envLookup = options.envLookup ?? ((name) => process.env[name]);
    const headers = buildMcpHttpHeaders(config, envLookup);

    this.transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: headers !== undefined ? { headers } : undefined,
      fetch: options.fetch,
      authProvider: options.oauthProvider,
    });
    this.client = new Client({
      name: options.clientName ?? Q_MCP_CLIENT_NAME,
      version: options.clientVersion ?? Q_MCP_CLIENT_VERSION,
    });
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('MCP HTTP client is closed');
    }
    if (this.started) return;
    this.started = true;
    this.installTransportHooks();
    try {
      await this.client.connect(this.transport);
    } catch (error) {
      await this.closeStartedClient();
      throw error;
    }
    if (this.closed) {
      await this.closeStartedClient();
      throw new Error('MCP HTTP client was closed during startup');
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStartedClient();
  }

  /**
   * Register a listener for unsolicited transport drops. If the transport
   * already signalled a terminal failure, the buffered reason is replayed
   * synchronously.
   */
  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
    const pending = this.pendingUnexpectedClose;
    if (pending !== undefined) {
      this.pendingUnexpectedClose = undefined;
      listener(pending);
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.client.listTools();
    return result.tools.map(toMcpToolDefinition);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult> {
    const requestOptions = buildRequestOptions(this.toolCallTimeoutMs, signal);
    const result = await this.client.callTool({ name, arguments: args }, undefined, requestOptions);
    return toMcpToolResult(result);
  }

  private async closeStartedClient(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.client.close();
  }

  private installTransportHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    this.client.onclose = () => {
      if (this.closed) return;
      if (!this.ready) return;
      this.fireUnexpectedClose({ error: this.lastTransportError });
    };
    // streamable-http's transport only calls onclose on its own close()
    // path, so 99% of remote disconnects arrive as onerror instead. Map
    // known-terminal error messages back to an unexpected close.
    this.client.onerror = (error) => {
      this.lastTransportError = error;
      if (this.closed) return;
      if (!this.ready) return;
      if (isTerminalTransportError(error)) {
        this.fireUnexpectedClose({ error });
      }
    };
  }

  private fireUnexpectedClose(reason: UnexpectedCloseReason): void {
    if (this.unexpectedCloseFired) return;
    this.unexpectedCloseFired = true;
    const listener = this.unexpectedCloseListener;
    if (listener !== undefined) {
      listener(reason);
    } else {
      this.pendingUnexpectedClose = reason;
    }
  }
}

/**
 * Returns true when an error reported via Client.onerror indicates the
 * underlying HTTP transport is dead. The streamable-http SDK does not call
 * onclose for remote disconnects; instead it surfaces them through onerror,
 * but only a few specific messages mean "give up":
 *
 * - `UnauthorizedError` — RFC 9728/8414 auth flow gave up.
 * - "Maximum reconnection attempts ... exceeded." — SSE reconnect budget gone.
 *
 * Transient signals (per-request fetch failures, single SSE flaps that the
 * SDK is about to reconnect from) MUST NOT match.
 */
export function isTerminalTransportError(error: Error): boolean {
  if (error.name === 'UnauthorizedError') return true;
  if (/Maximum reconnection attempts/i.test(error.message)) return true;
  return false;
}

export function buildMcpHttpHeaders(
  config: McpServerHttpConfig,
  envLookup: (name: string) => string | undefined,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...config.headers };
  if (config.bearerTokenEnvVar !== undefined) {
    const token = envLookup(config.bearerTokenEnvVar);
    if (token === undefined || token.length === 0) {
      throw new Error(
        `MCP HTTP bearer token env var "${config.bearerTokenEnvVar}" is not set or is empty`,
      );
    }
    // Strip any case-variant 'authorization' static header before injecting the
    // bearer; if not, Fetch Headers folds duplicate keys into a comma-joined
    // value.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') {
        delete headers[key];
      }
    }
    headers['Authorization'] = `Bearer ${token}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
