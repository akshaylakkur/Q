/**
 * Stdio MCP transport client.
 *
 * Wraps the @modelcontextprotocol/sdk StdioClientTransport and exposes the
 * small MCPClient surface. Lifecycle is explicit: the caller must `connect()`
 * before use and `close()` to terminate the child process.
 */

import type { McpServerStdioConfig } from '../config/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

export interface StdioMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly toolCallTimeoutMs?: number;
}

const STDERR_BUFFER_CAPACITY = 4 * 1024;

/**
 * Wraps the @modelcontextprotocol/sdk stdio client and exposes the small
 * surface required by MCPClient. Lifecycle is explicit: the caller must
 * `connect()` before use and `close()` to terminate the child process.
 */
export class StdioMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly toolCallTimeoutMs?: number;
  private readonly stderrBuffer = new BoundedTail(STDERR_BUFFER_CAPACITY);
  private started = false;
  private closed = false;
  // Flips to true only after `client.connect()` resolves AND the caller has
  // not torn things down mid-startup.
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  // Buffered when the transport closes before a listener is installed.
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;

  /** Capacity (in characters) of the stderr tail captured for diagnostics. */
  static readonly stderrBufferCapacity = STDERR_BUFFER_CAPACITY;

  constructor(config: McpServerStdioConfig, options: StdioMcpClientOptions = {}) {
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: mergeStdioEnv(config.env),
      cwd: config.cwd,
      stderr: 'pipe',
    });
    // `stderr: 'pipe'` means we MUST drain the stream — otherwise the child
    // can block on a full pipe. We also keep the last few KB around so the
    // connection manager can attach it to user-facing failure messages.
    this.transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrBuffer.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    this.client = new Client({
      name: options.clientName ?? Q_MCP_CLIENT_NAME,
      version: options.clientVersion ?? Q_MCP_CLIENT_VERSION,
    });
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('MCP stdio client is closed');
    }
    if (this.started) return;
    this.started = true;
    // Install transport hooks BEFORE the SDK handshake so we never lose an
    // onclose that fires between handshake completion and our wiring.
    this.installTransportHooks();
    try {
      await this.client.connect(this.transport);
    } catch (error) {
      await this.closeStartedClient();
      throw error;
    }
    if (this.closed) {
      await this.closeStartedClient();
      throw new Error('MCP stdio client was closed during startup');
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStartedClient();
  }

  /**
   * Register a listener that fires when the underlying transport closes on
   * its own — i.e. the caller has not yet invoked `close`. At most one
   * listener can be installed; later registrations replace earlier ones.
   * Intentional closes never invoke the listener.
   *
   * If the transport already closed before this method was called, the
   * buffered reason is replayed synchronously so the close is never dropped.
   */
  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
    const pending = this.pendingUnexpectedClose;
    if (pending !== undefined) {
      this.pendingUnexpectedClose = undefined;
      listener(pending);
    }
  }

  /**
   * Returns the tail of bytes captured from the child's stderr since spawn.
   * Bounded by StdioMcpClient.stderrBufferCapacity so a noisy server
   * cannot exhaust memory.
   */
  stderrSnapshot(): string {
    return this.stderrBuffer.snapshot();
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
    // Client.onclose fires for THREE situations:
    //   1. The intentional close() path → gated by this.closed.
    //   2. Transport dying during the SDK handshake → gated by !this.ready;
    //      the failure already surfaces via client.connect() rejecting.
    //   3. Transport dying after the handshake succeeded → the case we care
    //      about: fire or buffer for the manager's watch listener.
    this.client.onclose = () => {
      if (this.closed) return;
      if (!this.ready) return;
      const stderr = this.stderrBuffer.snapshot();
      const reason: UnexpectedCloseReason = {
        error: this.lastTransportError,
        stderr: stderr.length > 0 ? stderr : undefined,
      };
      const listener = this.unexpectedCloseListener;
      if (listener !== undefined) {
        listener(reason);
      } else {
        this.pendingUnexpectedClose = reason;
      }
    };
    this.client.onerror = (error) => {
      // Errors are informational on their own — onclose is what tells us
      // the transport is gone — so just remember the latest one.
      this.lastTransportError = error;
    };
  }
}

/**
 * A bounded "tail" buffer: appends characters and drops the oldest when the
 * total exceeds capacity. Used to keep the last few KB of child-process
 * stderr around without unbounded growth.
 */
class BoundedTail {
  private buffer = '';
  constructor(private readonly capacity: number) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(this.buffer.length - this.capacity);
    }
  }

  snapshot(): string {
    return this.buffer;
  }
}

/**
 * Inherit the parent's env so PATH/HOME/etc. survive — otherwise npx/uvx
 * style stdio servers fail to launch even with a valid config. Explicit
 * config.env entries still override on conflict.
 */
function mergeStdioEnv(configEnv?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  if (configEnv !== undefined) Object.assign(merged, configEnv);
  return merged;
}
