/**
 * MCP Connection Manager — owns the lifecycle of all configured MCP servers.
 *
 * Each server entry follows a state machine:
 *   'pending' → 'connected' | 'failed' | 'disabled' | 'needs-auth'
 *
 * Servers are connected in parallel; per-server failures are isolated so a
 * crashed or misconfigured entry never blocks session startup.
 */

import type { McpServerConfig } from '../config/schema';

import { StdioMcpClient } from './client-stdio';
import { HttpMcpClient } from './client-http';
import type { UnexpectedCloseReason } from './client-shared';
import type { McpOAuthService } from './oauth';
import { assertMcpInputSchema, type MCPClient } from './types';
import { qualifyMcpToolName } from './tool-naming';

// ─── Types ───────────────────────────────────────────────────────────────

export type McpServerStatus = 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';

export interface McpServerEntry {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly error?: string;
}

interface InternalEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  attemptId: number;
  status: McpServerStatus;
  tools?: readonly McpToolEntry[];
  enabledNames?: ReadonlySet<string>;
  error?: string;
  client?: RuntimeMcpClient;
}

export interface McpToolEntry {
  /** The original tool name as returned by the MCP server (unqualified). */
  readonly originalName: string;
  /** The fully qualified tool name (e.g. `mcp__server__tool`). */
  readonly qualifiedName: string;
  /** The tool description. */
  readonly description: string;
  /** The tool's JSON Schema input schema. */
  readonly inputSchema: Record<string, unknown>;
}

export type McpStatusListener = (entry: McpServerEntry) => void;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

type RuntimeMcpClient = StdioMcpClient | HttpMcpClient;

export interface McpConnectionManagerOptions {
  readonly envLookup?: (name: string) => string | undefined;
  /**
   * Optional OAuth orchestrator. When provided, HTTP servers without a
   * static bearer token participate in the OAuth-via-synthetic-tool flow.
   */
  readonly oauthService?: McpOAuthService;
}

// ─── Connection Manager ──────────────────────────────────────────────────

/**
 * Owns the lifecycle of every configured MCP server.
 *
 * Connection lifecycle:
 * - connectAll(configs): iterates entries and connects in parallel via
 *   Promise.allSettled with per-server isolation.
 * - connectOne(entry): creates a transport client, connects, and calls
 *   listTools() with startup timeout (default 30s).
 * - reconnect(name): closes existing client and reconnects.
 * - shutdown(): closes all entries gracefully.
 */
export class McpConnectionManager {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly listeners = new Set<McpStatusListener>();

  /**
   * OAuth orchestrator injected at construction time. Consumed when
   * a server returns 401/Unauthorized to build the synthetic
   * `authenticate` tool.
   */
  readonly oauthService: McpOAuthService | undefined;

  constructor(private readonly options: McpConnectionManagerOptions = {}) {
    this.oauthService = options.oauthService;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Returns the URL of an HTTP MCP server by name, or `undefined` for
   * unknown / non-HTTP / disabled entries. Used by the synthetic auth tool
   * to drive OAuth discovery against the right base URL.
   */
  getHttpServerUrl(name: string): string | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    if (entry.config.transport !== 'http') return undefined;
    return (entry.config as { url: string }).url;
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): readonly McpServerEntry[] {
    return Array.from(this.entries.values(), toPublicEntry);
  }

  get(name: string): McpServerEntry | undefined {
    const entry = this.entries.get(name);
    return entry !== undefined ? toPublicEntry(entry) : undefined;
  }

  /**
   * Returns the discovered tools and the allow-list of tool
   * names for a given connected server, or `undefined` if the server is not
   * currently connected. The allow-list combines the server's enabledTools
   * and disabledTools filters.
   */
  resolved(name: string): { tools: readonly McpToolEntry[]; enabledNames: ReadonlySet<string> } | undefined {
    const entry = this.entries.get(name);
    if (
      entry?.status !== 'connected' ||
      entry.tools === undefined
    ) {
      return undefined;
    }
    return {
      tools: entry.tools,
      enabledNames: entry.enabledNames ?? new Set(entry.tools.map((t) => t.qualifiedName)),
    };
  }

  /**
   * Connect all configured servers in parallel. Per-server failures are
   * isolated: one server crashing does not affect others.
   */
  async connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const [name, config] of Object.entries(configs)) {
      const disabled = config.enabled === false;
      const entry: InternalEntry = {
        name,
        config,
        attemptId: 0,
        status: disabled ? 'disabled' : 'pending',
      };
      this.entries.set(name, entry);
      this.emit(entry);
      if (!disabled) {
        tasks.push(this.connectOne(entry, this.beginConnectAttempt(entry)));
      }
    }
    await Promise.allSettled(tasks);
  }

  /**
   * Reconnect to a specific MCP server. Throws if the server is not
   * configured or is disabled.
   */
  async reconnect(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    if (entry.config.enabled === false) {
      throw new Error(`MCP server is disabled: ${name}`);
    }
    const attemptId = this.beginConnectAttempt(entry);
    await this.closeClient(entry);
    if (!this.isCurrent(entry, attemptId)) return;
    entry.status = 'pending';
    entry.tools = undefined;
    entry.enabledNames = undefined;
    entry.error = undefined;
    this.emit(entry);
    await this.connectOne(entry, attemptId);
  }

  /**
   * Gracefully shut down all MCP servers. Closes all transport clients
   * and clears the entry map.
   */
  async shutdown(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    const tasks = entries.map((entry) => this.closeClient(entry));
    await Promise.allSettled(tasks);
  }

  // ── Internal Connection Logic ──────────────────────────────────────────

  private async connectOne(entry: InternalEntry, attemptId: number): Promise<void> {
    const timeoutMs = entry.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

    let client: RuntimeMcpClient | undefined;
    try {
      const startupClient = this.createClient(entry.config, entry.name);
      client = startupClient;
      entry.client = startupClient;
      const mcpTools = await withTimeout(
        this.connectAndDiscoverTools(startupClient),
        timeoutMs,
        () => {
          void this.closeRuntimeClient(startupClient);
        },
      );
      if (!this.isCurrent(entry, attemptId)) {
        await this.closeRuntimeClient(startupClient);
        return;
      }
      entry.tools = mcpTools.map((t) => ({
        originalName: t.name,
        qualifiedName: qualifyMcpToolName(entry.name, t.name),
        description: t.description,
        inputSchema: assertMcpInputSchema(t.name, t.inputSchema),
      }));
      entry.enabledNames = computeEnabledNames(entry.config, entry.tools);
      entry.status = 'connected';
      this.watchForUnexpectedClose(entry, startupClient, attemptId);
    } catch (error) {
      if (!this.isCurrent(entry, attemptId)) {
        if (client !== undefined) {
          await this.closeRuntimeClient(client);
        }
        return;
      }
      if (this.shouldMarkNeedsAuth(entry, error)) {
        entry.status = 'needs-auth';
        entry.error = `${entry.name} requires OAuth — run the mcp__${entry.name}__authenticate tool to authorize`;
      } else {
        entry.status = 'failed';
        entry.error = formatStartupError(error, client);
      }
      entry.tools = undefined;
      entry.enabledNames = undefined;
      await this.closeClient(entry);
    }
    if (!this.isCurrent(entry, attemptId)) return;
    this.emit(entry);
  }

  private async connectAndDiscoverTools(client: RuntimeMcpClient): Promise<
    { name: string; description: string; inputSchema: unknown }[]
  > {
    await client.connect();
    const mcpTools = await client.listTools();
    return mcpTools;
  }

  private watchForUnexpectedClose(
    entry: InternalEntry,
    client: RuntimeMcpClient,
    attemptId: number,
  ): void {
    client.onUnexpectedClose((reason) => {
      if (!this.isCurrent(entry, attemptId)) return;
      if (entry.client !== client) return;
      entry.status = 'failed';
      entry.error = formatUnexpectedCloseError(entry.name, reason);
      entry.tools = undefined;
      entry.enabledNames = undefined;
      entry.client = undefined;
      void this.closeRuntimeClient(client);
      this.emit(entry);
    });
  }

  private beginConnectAttempt(entry: InternalEntry): number {
    entry.attemptId += 1;
    return entry.attemptId;
  }

  private createClient(config: McpServerConfig, name: string): RuntimeMcpClient {
    const toolCallTimeoutMs = config.toolTimeoutMs;
    if (config.transport === 'stdio') {
      return new StdioMcpClient(config, { toolCallTimeoutMs });
    }
    return new HttpMcpClient(config, {
      toolCallTimeoutMs,
      envLookup: this.options.envLookup,
      oauthProvider: this.resolveOAuthProvider(config, name),
    });
  }

  private resolveOAuthProvider(
    config: McpServerConfig,
    name: string,
  ): ReturnType<McpOAuthService['getProvider']> | undefined {
    const oauthService = this.oauthService;
    if (oauthService === undefined) return undefined;
    if (config.transport !== 'http') return undefined;
    if (config.bearerTokenEnvVar !== undefined) return undefined;
    // Only attach the provider once tokens have been minted; before that,
    // the transport should propagate a clean 401 so we can flip the entry
    // into `needs-auth` rather than getting tangled in the SDK's auth()
    // flow (which would try DCR before we have an active redirect URL).
    if (!oauthService.hasTokens(name, config.url)) return undefined;
    return oauthService.getProvider(name, config.url);
  }

  private shouldMarkNeedsAuth(entry: InternalEntry, error: unknown): boolean {
    if (this.oauthService === undefined) return false;
    if (entry.config.transport !== 'http') return false;
    if (entry.config.bearerTokenEnvVar !== undefined) return false;
    // If the user pinned a static headers block, treat 401s as a bad header
    // rather than hijacking them into the OAuth flow.
    if (entry.config.headers !== undefined) return false;
    return isUnauthorizedLikeError(error);
  }

  private async closeClient(entry: InternalEntry): Promise<void> {
    if (entry.client === undefined) return;
    const client = entry.client;
    entry.client = undefined;
    await this.closeRuntimeClient(client);
  }

  private async closeRuntimeClient(client: RuntimeMcpClient): Promise<void> {
    try {
      await client.close();
    } catch {
      // Suppress close errors — the server is going away regardless and we
      // don't want them masking the original startup failure.
    }
  }

  private isCurrent(entry: InternalEntry, attemptId: number): boolean {
    return this.entries.get(entry.name) === entry && entry.attemptId === attemptId;
  }

  private emit(entry: InternalEntry): void {
    const view = toPublicEntry(entry);
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch {
        // Listener faults must not break the connection manager.
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function toPublicEntry(entry: InternalEntry): McpServerEntry {
  return {
    name: entry.name,
    transport: entry.config.transport,
    status: entry.status,
    toolCount:
      entry.status === 'connected' && entry.enabledNames !== undefined
        ? entry.enabledNames.size
        : 0,
    error: entry.error,
  };
}

function computeEnabledNames(
  config: McpServerConfig,
  tools: readonly McpToolEntry[],
): Set<string> {
  const all = tools.map((t) => t.qualifiedName);
  const enabledFilter =
    config.enabledTools !== undefined ? new Set(config.enabledTools) : undefined;
  const disabledFilter =
    config.disabledTools !== undefined ? new Set(config.disabledTools) : undefined;
  const allowed = new Set<string>();
  for (const qualifiedName of all) {
    // enabledTools/disabledTools may be specified as either qualified or
    // unqualified names. Check both.
    const originalName = tools.find((t) => t.qualifiedName === qualifiedName)?.originalName;
    if (enabledFilter !== undefined) {
      if (enabledFilter.has(qualifiedName) || (originalName !== undefined && enabledFilter.has(originalName))) {
        allowed.add(qualifiedName);
      }
      continue;
    }
    if (disabledFilter !== undefined) {
      if (disabledFilter.has(qualifiedName) || (originalName !== undefined && disabledFilter.has(originalName))) {
        continue;
      }
    }
    allowed.add(qualifiedName);
  }
  return allowed;
}

function isUnauthorizedLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'UnauthorizedError') return true;
  // SDK transport errors typically expose the HTTP status as `.code`.
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && code === 401) return true;
  if (typeof code === 'string' && code === '401') return true;
  return /\b401\b/.test(error.message) || /unauthorized/i.test(error.message);
}

function formatStartupError(error: unknown, client: RuntimeMcpClient | undefined): string {
  const base = error instanceof Error ? error.message : String(error);
  const tail = stderrTail(client);
  if (tail === undefined) return base;
  return `${base}\nstderr: ${tail}`;
}

function formatUnexpectedCloseError(name: string, reason: UnexpectedCloseReason): string {
  const parts = [`MCP server "${name}" closed unexpectedly`];
  if (reason.error !== undefined) {
    parts.push(reason.error.message);
  }
  if (reason.stderr !== undefined && reason.stderr.length > 0) {
    parts.push(`stderr: ${reason.stderr.trimEnd()}`);
  }
  return parts.join('\n');
}

function stderrTail(client: RuntimeMcpClient | undefined): string | undefined {
  if (client === undefined) return undefined;
  if (!(client instanceof StdioMcpClient)) return undefined;
  const snapshot = client.stderrSnapshot();
  if (snapshot.length === 0) return undefined;
  return snapshot.trimEnd();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
