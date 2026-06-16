/**
 * LspConnector — Language Server Protocol Integration for Six Languages
 *
 * Manages a pool of LSP server connections for TypeScript/JavaScript, Python,
 * Rust, Go, Java, and C/C++. Provides methods for definitions, references,
 * hover, diagnostics, completions, signature help, rename, formatting,
 * code actions, and document symbols.
 *
 * Features:
 *   - JSON-RPC 2.0 over stdio with content-length header parsing
 *   - Connection lifecycle: initialize, initialized, subscribe diagnostics, shutdown
 *   - Error recovery with exponential backoff (1s→2s→4s, max 3 retries)
 *   - Batch optimization per language server
 *   - Fallback to regex-based parsing when a server is marked 'failed'
 *   - Dynamic tool definitions for the agent
 *   - Per-request AbortSignal timeout
 *
 * Consumed by tool registration, TypeCheckGate fast path,
 * and q-cli doctor.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { readdir, access } from "node:fs/promises";
import { resolve, extname, basename } from "node:path";
import { EventEmitter } from "node:events";

// =========================================================================
// Types
// =========================================================================

/** Client capabilities for LSP initialize request. */
const TEXT_DOCUMENT_SYNC_CAPABILITIES = {
  textDocument: {
    synchronization: {
      dynamicRegistration: true,
      willSave: false,
      willSaveWaitUntil: false,
      didSave: false,
    },
    completion: {
      dynamicRegistration: true,
      completionItem: { snippetSupport: false },
    },
    hover: { dynamicRegistration: true },
    signatureHelp: { dynamicRegistration: true },
    declaration: { dynamicRegistration: true },
    definition: { dynamicRegistration: true },
    typeDefinition: { dynamicRegistration: true },
    implementation: { dynamicRegistration: true },
    references: { dynamicRegistration: true },
    documentHighlight: { dynamicRegistration: true },
    documentSymbol: { dynamicRegistration: true },
    codeAction: { dynamicRegistration: true },
    rename: { dynamicRegistration: true },
    formatting: { dynamicRegistration: true },
    rangeFormatting: { dynamicRegistration: true },
    onTypeFormatting: { dynamicRegistration: true },
  },
  workspace: {
    symbol: { dynamicRegistration: true },
    didChangeConfiguration: { dynamicRegistration: true },
    configuration: true,
  },
};

/** A single location from LSP definition/references. */
export interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

/** LSP completion item. */
export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
}

/** LSP signature information. */
export interface LspSignatureInfo {
  signatures: Array<{ label: string; documentation?: string; parameters?: Array<{ label: string; documentation?: string }> }>;
  activeSignature: number;
  activeParameter: number;
}

/** LSP text edit (for formatting/rename). */
export interface LspTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

/** LSP code action. */
export interface LspCodeAction {
  title: string;
  kind?: string;
  diagnostics?: Array<{ message: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }>;
  edit?: { changes?: Record<string, LspTextEdit[]> };
  command?: { command: string; arguments?: unknown[] };
}

/** LSP document symbol. */
export interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

/** LSP diagnostic from publishDiagnostics notification. */
export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

/** Language descriptor used by LspConnector. */
export interface LanguageDescriptor {
  name: string;
  extensions: string[];
  serverCommand: string;
  serverArgs: string[];
  fallbackBinary?: string;
  // Some servers need extra initialization options
  initializationOptions?: Record<string, unknown>;
  // Whether the server supports dynamic capability registration
  dynamicCapabilities?: boolean;
}

// =========================================================================
// Configuration
// =========================================================================

/** Per-request timeout configuration in ms. */
export interface LspTimeoutConfig {
  definitions: number;
  references: number;
  hover: number;
  completions: number;
  signatureHelp: number;
  rename: number;
  format: number;
  codeAction: number;
  documentSymbol: number;
  diagnostics: number;
}

const DEFAULT_TIMEOUTS: LspTimeoutConfig = {
  definitions: 10_000,
  references: 10_000,
  hover: 10_000,
  completions: 30_000,
  signatureHelp: 10_000,
  rename: 10_000,
  format: 30_000,
  codeAction: 30_000,
  documentSymbol: 10_000,
  diagnostics: 120_000,
};

/** LspConnector configuration. */
export interface LspConnectorConfig {
  /** Workspace root path. */
  rootPath: string;
  /** Per-request timeouts. */
  timeouts?: Partial<LspTimeoutConfig>;
  /** Maximum restart attempts per server (default: 3). */
  maxRestartAttempts?: number;
  /** Whether to enable tool definitions for the agent. */
  enableAgentTools?: boolean;
  /** Logger for LSP events. Defaults to console. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

const DEFAULT_CONFIG: Partial<LspConnectorConfig> = {
  maxRestartAttempts: 3,
  enableAgentTools: true,
};

// =========================================================================
// Language Descriptors
// =========================================================================

const BUILTIN_LANGUAGES: LanguageDescriptor[] = [
  {
    name: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    serverCommand: "typescript-language-server",
    serverArgs: ["--stdio"],
    initializationOptions: {},
  },
  {
    name: "python",
    extensions: [".py"],
    serverCommand: "pyright-langserver",
    serverArgs: ["--stdio"],
    fallbackBinary: "pylsp",
    initializationOptions: {},
  },
  {
    name: "rust",
    extensions: [".rs"],
    serverCommand: "rust-analyzer",
    serverArgs: [],
    initializationOptions: {},
  },
  {
    name: "go",
    extensions: [".go"],
    serverCommand: "gopls",
    serverArgs: [],
    initializationOptions: {},
  },
  {
    name: "java",
    extensions: [".java"],
    serverCommand: "jdtls",
    serverArgs: [],
    initializationOptions: { extendedClientCapabilities: { progressReportProvider: false } },
  },
  {
    name: "cpp",
    extensions: [".c", ".cpp", ".h", ".hpp", ".cxx", ".hxx", ".cc", ".hh"],
    serverCommand: "clangd",
    serverArgs: ["--background-index"],
    initializationOptions: {},
  },
];

// =========================================================================
// JSON-RPC types
// =========================================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccessResponse | JsonRpcErrorResponse;

// =========================================================================
// LspClient — JSON-RPC over stdio for a single server
// =========================================================================

/**
 * Wraps JSON-RPC communication over a single LSP server's stdio streams.
 * Each request gets a monotonically incrementing id; responses are matched
 * by id via a pending promises map.
 */
export class LspClient extends EventEmitter {
  readonly language: string;
  private command: string;
  private args: string[];
  private child: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private requestId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: NodeJS.Timeout }>();
  private buf = "";
  private _connected = false;
  private _stopped = false;
  private _failed = false;
  private diagnosticsCache = new Map<string, LspDiagnostic[]>();
  private rootPath: string;
  private initOptions: Record<string, unknown>;
  private timeouts: LspTimeoutConfig;
  private logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  private restartAttempt = 0;
  private maxRestartAttempts: number;
  /** Timeout for restart backoff (resolved promise). */
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    language: string,
    command: string,
    args: string[],
    rootPath: string,
    opts: {
      timeouts: LspTimeoutConfig;
      initOptions?: Record<string, unknown>;
      maxRestartAttempts?: number;
      logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
    },
  ) {
    super();
    this.language = language;
    this.command = command;
    this.args = args;
    this.rootPath = rootPath;
    this.initOptions = opts.initOptions ?? {};
    this.timeouts = opts.timeouts;
    this.maxRestartAttempts = opts.maxRestartAttempts ?? 3;
    this.logger = opts.logger ?? { info: console.log, warn: console.warn, error: console.error };
  }

  get connected(): boolean { return this._connected; }
  get failed(): boolean { return this._failed; }

  get diagnostics(): Map<string, LspDiagnostic[]> { return this.diagnosticsCache; }

  /**
   * Initialize: spawn the server process, send initialize request, receive
   * response, send initialized notification, and subscribe to diagnostics.
   */
  async initialize(): Promise<void> {
    if (this.child) {
      await this.shutdown().catch(() => {});
    }
    // Reset state for fresh connection
    this._failed = false;
    this._stopped = false;

    return new Promise<void>((resolveInit, rejectInit) => {
      try {
        const child = spawn(this.command, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;

        // Set up stdout reader with content-length parsing
        const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        this.readline = rl;

        let contentLength = 0;
        let bodyBuf = "";
        let readingBody = false;

        child.stdout!.on("data", (chunk: Buffer) => {
          if (this._stopped) return;
          const text = chunk.toString("utf-8");
          this.buf += text;

          // Parse content-length headers and body
          while (this.buf.length > 0) {
            if (!readingBody) {
              const headerEnd = this.buf.indexOf("\r\n\r\n");
              if (headerEnd === -1) {
                // Try \n\n
                const headerEndLf = this.buf.indexOf("\n\n");
                if (headerEndLf === -1) break;
                const headers = this.buf.slice(0, headerEndLf);
                this.buf = this.buf.slice(headerEndLf + 2);
                const clMatch = headers.match(/Content-Length:\s*(\d+)/i);
                if (clMatch) {
                  contentLength = parseInt(clMatch[1]!, 10);
                }
                readingBody = true;
                bodyBuf = "";
              } else {
                const headers = this.buf.slice(0, headerEnd);
                this.buf = this.buf.slice(headerEnd + 4);
                const clMatch = headers.match(/Content-Length:\s*(\d+)/i);
                if (clMatch) {
                  contentLength = parseInt(clMatch[1]!, 10);
                }
                readingBody = true;
                bodyBuf = "";
              }
            }

            if (readingBody) {
              if (contentLength <= 0) {
                // Invalid Content-Length header — skip and reset
                readingBody = false;
                bodyBuf = "";
                continue;
              }
              const needed = contentLength - bodyBuf.length;
              if (this.buf.length >= needed) {
                bodyBuf += this.buf.slice(0, needed);
                this.buf = this.buf.slice(needed);
                readingBody = false;
                contentLength = 0;

                // Process the complete JSON-RPC message
                try {
                  const msg = JSON.parse(bodyBuf) as JsonRpcMessage;
                  this.handleMessage(msg);
                } catch (err) {
                  this.logger.warn(`[LSP ${this.language}] Failed to parse message: ${err instanceof Error ? err.message : String(err)}`);
                }
                bodyBuf = "";
              } else {
                bodyBuf += this.buf;
                this.buf = "";
              }
            }
          }
        });

        child.stderr!.on("data", (chunk: Buffer) => {
          // stderr from LSP servers is often logging/diagnostics
          const txt = chunk.toString("utf-8").trim();
          if (txt) {
            this.logger.info(`[LSP ${this.language} stderr] ${txt}`);
          }
        });

        child.on("error", (err) => {
          this.logger.error(`[LSP ${this.language}] Process error: ${err.message}`);
          this._connected = false;
          this._failed = true;
          rejectInit(err);
        });

        let exitHandled = false;
        child.on("exit", (code, signal) => {
          if (exitHandled) return;
          exitHandled = true;
          this._connected = false;
          // Failed if: non-zero exit code (including signal-killed where code is null)
          this._failed = code !== 0;

          // Reject all pending promises
          for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`LSP server ${this.language} exited (code=${code}, signal=${signal})`));
          }
          this.pending.clear();

          // Attempt restart — only if we aren't already stopped/failed
          if (!this._stopped && this._failed) {
            this.attemptRestart(code, signal);
          }
        });

        // Send initialize request
        const initId = this.nextId();
        this.sendRawRequest(initId, "initialize", {
          processId: process.pid,
          clientInfo: { name: "q-cli", version: "0.1.0" },
          capabilities: TEXT_DOCUMENT_SYNC_CAPABILITIES,
          rootUri: `file://${resolve(this.rootPath)}`,
          initializationOptions: this.initOptions,
          workspaceFolders: [{ uri: `file://${resolve(this.rootPath)}`, name: basename(this.rootPath) }],
        });

        // Store the pending promise to resolve on response
        this.pending.set(initId, {
          resolve: (result: unknown) => {
            // Server initialized — send initialized notification
            this.sendNotification("initialized", {});
            this._connected = true;
            this.restartAttempt = 0;
            resolveInit();
          },
          reject: (err) => {
            this._failed = true;
            rejectInit(err);
          },
          timer: setTimeout(() => {
            this.pending.delete(initId);
            this._failed = true;
            rejectInit(new Error(`LSP ${this.language} initialize timed out`));
          }, 15_000),
        });
      } catch (err) {
        rejectInit(err);
      }
    });
  }

  /**
   * Send a shutdown request, then exit notification.
   * Kills the process if it doesn't exit within 3s.
   */
  async shutdown(): Promise<void> {
    this._stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child) return;

    // Send shutdown request
    try {
      const shutdownId = this.nextId();
      this.sendRawRequest(shutdownId, "shutdown", {});

      await new Promise<void>((resolveShutdown, rejectShutdown) => {
        const timer = setTimeout(() => {
          // Shutdown timed out — kill
          this.child?.kill("SIGKILL");
          this.child = null;
          rejectShutdown(new Error("Shutdown timed out"));
        }, 3000);

        this.pending.set(shutdownId, {
          resolve: () => {
            clearTimeout(timer);
            // Send exit notification
            this.sendNotification("exit", {});
            setTimeout(() => {
              // Ensure process is dead
              try { this.child?.kill("SIGKILL"); } catch { /* ignore */ }
              this.child = null;
            }, 1000);
            resolveShutdown();
          },
          reject: (err) => {
            clearTimeout(timer);
            try { this.child?.kill("SIGKILL"); } catch { /* ignore */ }
            this.child = null;
            rejectShutdown(err);
          },
          timer,
        });
      });
    } catch {
      // Force kill
      try { this.child?.kill("SIGKILL"); } catch { /* ignore */ }
      this.child = null;
    }

    this.readline?.close();
    this.readline = null;
    this._connected = false;
  }

  // =======================================================================
  // LSP Methods
  // =======================================================================

  async definitions(path: string, line: number, col: number): Promise<LspLocation[]> {
    const result = await this.request("textDocument/definition", {
      textDocument: { uri: this.pathToUri(path) },
      position: { line, character: col },
    }, this.timeouts.definitions);
    return this.normalizeLocations(result);
  }

  async references(path: string, line: number, col: number): Promise<LspLocation[]> {
    const result = await this.request("textDocument/references", {
      textDocument: { uri: this.pathToUri(path) },
      position: { line, character: col },
      context: { includeDeclaration: true },
    }, this.timeouts.references);
    const locations = this.normalizeLocations(result);
    // Sort by file then line
    return locations.sort((a, b) => {
      if (a.uri !== b.uri) return a.uri < b.uri ? -1 : 1;
      return a.range.start.line - b.range.start.line;
    });
  }

  async hover(path: string, line: number, col: number): Promise<string> {
    const result = await this.request("textDocument/hover", {
      textDocument: { uri: this.pathToUri(path) },
      position: { line, character: col },
    }, this.timeouts.hover);
    return this.extractHoverText(result);
  }

  async completions(path: string, line: number, col: number): Promise<LspCompletionItem[]> {
    const result = await this.request("textDocument/completion", {
      textDocument: { uri: this.pathToUri(path) },
      position: { line, character: col },
    }, this.timeouts.completions);
    return this.normalizeCompletions(result);
  }

  async signatureHelp(path: string, line: number, col: number): Promise<LspSignatureInfo | null> {
    const result = await this.request("textDocument/signatureHelp", {
      textDocument: { uri: this.pathToUri(path) },
      position: { line, character: col },
    }, this.timeouts.signatureHelp);
    if (!result || typeof result !== "object") return null;
    const r = result as Record<string, unknown>;
    return {
      signatures: (r.signatures as Array<{ label: string; documentation?: string; parameters?: Array<{ label: string; documentation?: string }> }>) ?? [],
      activeSignature: (r.activeSignature as number) ?? 0,
      activeParameter: (r.activeParameter as number) ?? 0,
    };
  }

  async rename(path: string, line: number, col: number, newName: string): Promise<LspTextEdit[]> {
    const result = await this.request("textDocument/rename", {
      textDocument: { uri: this.pathToUri(path) },
      position: { line, character: col },
      newName,
    }, this.timeouts.rename);
    if (!result || typeof result !== "object") return [];
    const r = result as Record<string, unknown>;
    const changes = r.changes as Record<string, LspTextEdit[]> | undefined;
    if (!changes) return [];
    return Object.values(changes).flat();
  }

  async format(path: string): Promise<LspTextEdit[]> {
    const result = await this.request("textDocument/formatting", {
      textDocument: { uri: this.pathToUri(path) },
      options: { tabSize: 4, insertSpaces: true },
    }, this.timeouts.format);
    if (!Array.isArray(result)) return [];
    return result as LspTextEdit[];
  }

  async codeAction(path: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }): Promise<LspCodeAction[]> {
    const result = await this.request("textDocument/codeAction", {
      textDocument: { uri: this.pathToUri(path) },
      range,
      context: { diagnostics: [] },
    }, this.timeouts.codeAction);
    if (!Array.isArray(result)) return [];
    return result as LspCodeAction[];
  }

  async documentSymbol(path: string): Promise<LspSymbolInformation[]> {
    const result = await this.request("textDocument/documentSymbol", {
      textDocument: { uri: this.pathToUri(path) },
    }, this.timeouts.documentSymbol);
    return this.normalizeSymbols(result);
  }

  // =======================================================================
  // Internal: JSON-RPC message handling
  // =======================================================================

  private nextId(): number {
    return this.requestId++;
  }

  private sendRawRequest(id: number, method: string, params: Record<string, unknown>): void {
    if (!this.child?.stdin) return;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`);
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.child?.stdin) return;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`);
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this._failed) throw new Error(`LSP server ${this.language} is in failed state`);
    if (!this._connected) throw new Error(`LSP server ${this.language} is not connected`);
    if (this._stopped) throw new Error(`LSP server ${this.language} is stopped`);

    return new Promise((resolve, reject) => {
      const id = this.nextId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.sendRawRequest(id, method, params);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response
    if ("id" in msg && "result" in msg) {
      const pending = this.pending.get(msg.id as number);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id as number);
        pending.resolve((msg as JsonRpcSuccessResponse).result);
      }
      return;
    }

    // Error response
    if ("id" in msg && "error" in msg) {
      const pending = this.pending.get(msg.id as number);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id as number);
        const err = (msg as JsonRpcErrorResponse).error;
        pending.reject(new Error(`LSP error ${err.code}: ${err.message}`));
      }
      return;
    }

    // Notification
    if (!("id" in msg) && "method" in msg) {
      const notification = msg as JsonRpcNotification;
      this.handleNotification(notification);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const method = notification.method;
    const params = notification.params ?? {};

    switch (method) {
      case "textDocument/publishDiagnostics": {
        const p = params as { uri?: string; diagnostics?: LspDiagnostic[] };
        const uri = p.uri ?? "";
        const diags = p.diagnostics ?? [];
        this.diagnosticsCache.set(uri, diags);
        this.emit("diagnostics", uri, diags);
        break;
      }
      case "window/logMessage": {
        const p = params as { type?: number; message?: string };
        this.logger.info(`[LSP ${this.language} log] ${p.message ?? ""}`);
        break;
      }
      case "window/showMessage":
      case "telemetry/event": {
        const p = params as { type?: number; message?: string };
        this.logger.info(`[LSP ${this.language} ${method}] ${p.message ?? JSON.stringify(params)}`);
        break;
      }
      default:
        // Unknown notifications are silently ignored per LSP spec
        break;
    }
  }

  // =======================================================================
  // Internal: Error recovery
  // =======================================================================

  private attemptRestart(code: number | null, signal: string | null): void {
    if (this._stopped) return;
    this.restartAttempt++;

    if (this.restartAttempt > this.maxRestartAttempts) {
      this._failed = true;
      this.logger.error(`[LSP ${this.language}] Failed after ${this.maxRestartAttempts} restart attempts`);
      this.emit("failed");
      return;
    }

    // Exponential backoff: 1s, 2s, 4s
    const delay = Math.min(1000 * Math.pow(2, this.restartAttempt - 1), 4000);
    this.logger.warn(`[LSP ${this.language}] Crash (code=${code}, signal=${signal}), restart attempt ${this.restartAttempt}/${this.maxRestartAttempts} in ${delay}ms`);

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      // Check that server binary is still available
      const binaryName = this.command.split(" ")[0] ?? this.command;
      try {
        await new Promise<void>((resolveWhich, rejectWhich) => {
          execFile("which", [binaryName], { timeout: 5000 }, (err, stdout) => {
            if (err || !stdout.trim()) {
              rejectWhich(new Error(`${binaryName} not found on PATH`));
            } else {
              resolveWhich();
            }
          });
        });
      } catch {
        this._failed = true;
        this.logger.error(`[LSP ${this.language}] Binary ${binaryName} not found on PATH after crash`);
        this.emit("failed");
        return;
      }

      // Re-initialize
      try {
        await this.initialize();
        this.logger.info(`[LSP ${this.language}] Successfully restarted on attempt ${this.restartAttempt}`);
        this.emit("restarted");
      } catch (err) {
        this._failed = true;
        this.logger.error(`[LSP ${this.language}] Restart attempt ${this.restartAttempt} failed: ${err instanceof Error ? err.message : String(err)}`);
        this.emit("failed");
      }
    }, delay);
  }

  // =======================================================================
  // Internal: Normalization helpers
  // =======================================================================

  private pathToUri(path: string): string {
    const resolved = resolve(path);
    return `file://${resolved}`;
  }

  private uriToPath(uri: string): string {
    return uri.replace(/^file:\/\//, "");
  }

  private normalizeLocations(result: unknown): LspLocation[] {
    if (!result) return [];
    if (Array.isArray(result)) return result as LspLocation[];
    // Single location
    const r = result as Record<string, unknown>;
    if (r.uri && r.range) return [result as LspLocation];
    return [];
  }

  private extractHoverText(result: unknown): string {
    if (!result || typeof result !== "object") return "";
    const r = result as Record<string, unknown>;

    // Direct MarkupContent
    if (r.contents) {
      return this.extractMarkupContent(r.contents);
    }

    // MarkedString | MarkedString[]
    return JSON.stringify(r);
  }

  private extractMarkupContent(contents: unknown): string {
    if (typeof contents === "string") return contents;

    if (Array.isArray(contents)) {
      return contents.map((c) => this.extractMarkupContent(c)).join("\n\n---\n\n");
    }

    if (contents && typeof contents === "object") {
      const c = contents as Record<string, unknown>;
      if (typeof c.value === "string") return c.value;
      if (typeof c.language === "string" && typeof c.value === "string") {
        return `\`\`\`${c.language}\n${c.value}\n\`\`\``;
      }
      return JSON.stringify(c);
    }

    return String(contents ?? "");
  }

  private normalizeCompletions(result: unknown): LspCompletionItem[] {
    if (!result) return [];

    // CompletionList or CompletionItem[]
    if (Array.isArray(result)) return result as LspCompletionItem[];

    const r = result as Record<string, unknown>;
    if (r.items && Array.isArray(r.items)) return r.items as LspCompletionItem[];

    // isIncomplete may be present
    if (r.isIncomplete !== undefined && r.items && Array.isArray(r.items)) {
      return r.items as LspCompletionItem[];
    }

    return [];
  }

  private normalizeSymbols(result: unknown): LspSymbolInformation[] {
    if (!result) return [];

    // DocumentSymbol[] or SymbolInformation[]
    if (Array.isArray(result)) {
      // Check if they're DocumentSymbol (with children/range) or SymbolInformation (with location)
      const items = result as Array<Record<string, unknown>>;
      if (items.length > 0 && items[0]?.range) {
        // DocumentSymbol — convert to flat list
        return this.flattenDocumentSymbols(items);
      }
      return result as LspSymbolInformation[];
    }

    return [];
  }

  private flattenDocumentSymbols(symbols: Array<Record<string, unknown>>, containerName?: string): LspSymbolInformation[] {
    const result: LspSymbolInformation[] = [];
    for (const sym of symbols) {
      const name = sym.name as string;
      const kind = sym.kind as number;
      const range = sym.range as { start: { line: number; character: number }; end: { line: number; character: number } };
      const selectionRange = sym.selectionRange as { start: { line: number; character: number }; end: { line: number; character: number } } | undefined;
      const children = sym.children as Array<Record<string, unknown>> | undefined;

      result.push({
        name,
        kind,
        location: {
          uri: "",
          range: selectionRange ?? range,
        },
        containerName,
      });

      if (children) {
        result.push(...this.flattenDocumentSymbols(children, name));
      }
    }
    return result;
  }
}

// =========================================================================
// LspConnector — Pool manager for multiple language servers
// =========================================================================

export type LspServerState = "pending" | "connected" | "failed" | "disabled";

export interface LspServerStatus {
  language: string;
  state: LspServerState;
  diagnosticsCount: number;
  uptimeMs: number;
}

/** Result type for tool-formatted output. */
export interface FormattedLocation {
  file: string;
  line: number;
  col: number;
  description?: string;
}

/**
 * Manages a pool of LSP server connections for different languages.
 * Handles lifecycle, language detection, batching, and fallback.
 */
export class LspConnector extends EventEmitter {
  private rootPath: string;
  private config: {
    rootPath: string;
    timeouts: LspTimeoutConfig;
    maxRestartAttempts: number;
    enableAgentTools: boolean;
    logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  };
  private clients: Map<string, LspClient> = new Map();
  private languages: Map<string, LanguageDescriptor> = new Map();
  private state: Map<string, LspServerState> = new Map();
  private startTimes: Map<string, number> = new Map();
  private _initialized = false;

  constructor(config: LspConnectorConfig) {
    super();
    this.rootPath = config.rootPath;
    this.config = {
      rootPath: config.rootPath,
      timeouts: { ...DEFAULT_TIMEOUTS, ...config.timeouts },
      maxRestartAttempts: config.maxRestartAttempts ?? DEFAULT_CONFIG.maxRestartAttempts!,
      enableAgentTools: config.enableAgentTools ?? DEFAULT_CONFIG.enableAgentTools!,
      logger: config.logger ?? { info: console.log, warn: console.warn, error: console.error },
    };

    // Register built-in language descriptors
    for (const lang of BUILTIN_LANGUAGES) {
      this.languages.set(lang.name, lang);
    }
  }

  /** Whether the connector has been initialized. */
  get initialized(): boolean { return this._initialized; }

  /**
   * Scan the workspace for source files and start LSP servers for
   * each detected language.
   */
  async initialize(): Promise<{ started: string[]; failed: string[]; skipped: string[] }> {
    const started: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];

    // Detect languages present in the project
    const detected = await this.detectLanguages();
    if (detected.length === 0) {
      this._initialized = true;
      return { started, failed, skipped };
    }

    // Start servers in parallel
    const startPromises = detected.map(async (langName) => {
      const lang = this.languages.get(langName);
      if (!lang) { skipped.push(langName); return; }

      this.state.set(langName, "pending");
      const client = new LspClient(
        lang.name,
        lang.serverCommand,
        lang.serverArgs,
        this.rootPath,
        {
          timeouts: this.config.timeouts,
          initOptions: lang.initializationOptions,
          maxRestartAttempts: this.config.maxRestartAttempts,
          logger: this.config.logger,
        },
      );

      // Forward events
      client.on("diagnostics", (uri, diags) => {
        this.emit("diagnostics", langName, uri, diags);
      });
      client.on("failed", () => {
        this.state.set(langName, "failed");
        this.emit("server-failed", langName);
      });
      client.on("restarted", () => {
        this.state.set(langName, "connected");
        this.emit("server-restarted", langName);
      });

      this.clients.set(langName, client);
      this.startTimes.set(langName, Date.now());

      try {
        await client.initialize();
        this.state.set(langName, "connected");
        started.push(langName);
        this.emit("server-connected", langName);
      } catch (err) {
        this.state.set(langName, "failed");
        const msg = err instanceof Error ? err.message : String(err);
        this.config.logger.warn(`[LSP ${langName}] Failed to initialize: ${msg}`);

        // Try fallback binary if available
        if (lang.fallbackBinary) {
          this.config.logger.info(`[LSP ${langName}] Trying fallback binary: ${lang.fallbackBinary}`);
          const fallbackClient = new LspClient(
            lang.name,
            lang.fallbackBinary,
            lang.serverArgs,
            this.rootPath,
            {
              timeouts: this.config.timeouts,
              initOptions: lang.initializationOptions,
              maxRestartAttempts: this.config.maxRestartAttempts,
              logger: this.config.logger,
            },
          );

          fallbackClient.on("diagnostics", (uri, diags) => {
            this.emit("diagnostics", langName, uri, diags);
          });
          fallbackClient.on("failed", () => {
            this.state.set(langName, "failed");
            this.emit("server-failed", langName);
          });
          fallbackClient.on("restarted", () => {
            this.state.set(langName, "connected");
            this.emit("server-restarted", langName);
          });

          this.clients.set(langName, fallbackClient);

          try {
            await fallbackClient.initialize();
            this.state.set(langName, "connected");
            started.push(`${langName} (fallback: ${lang.fallbackBinary})`);
          } catch (fallbackErr) {
            this.state.set(langName, "failed");
            failed.push(langName);
            this.startTimes.delete(langName);
            this.clients.delete(langName);
          }
        } else {
          failed.push(langName);
          this.startTimes.delete(langName);
          this.clients.delete(langName);
        }
      }
    });

    await Promise.allSettled(startPromises);
    this._initialized = true;

    return { started, failed, skipped };
  }

  /**
   * Shutdown all connected LSP servers.
   */
  async shutdown(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];
    for (const [, client] of this.clients) {
      shutdownPromises.push(client.shutdown().catch(() => {}));
    }
    await Promise.allSettled(shutdownPromises);
    this.clients.clear();
    this.state.clear();
    this.startTimes.clear();
    this._initialized = false;
  }

  // =======================================================================
  // Language Detection
  // =======================================================================

  /**
   * Scan the workspace for source files and detect which languages
   * are present, returning the set of language names to start servers for.
   */
  private async detectLanguages(): Promise<string[]> {
    const detected = new Set<string>();
    const extToLang = new Map<string, string>();

    for (const [langName, lang] of this.languages) {
      for (const ext of lang.extensions) {
        extToLang.set(ext, langName);
      }
    }

    // Check for project indicator files first (faster)
    try {
      await access(resolve(this.rootPath, "tsconfig.json"));
      detected.add("typescript");
    } catch { /* no tsconfig */ }

    try {
      await access(resolve(this.rootPath, "Cargo.toml"));
      detected.add("rust");
    } catch { /* no cargo */ }

    try {
      await access(resolve(this.rootPath, "go.mod"));
      detected.add("go");
    } catch { /* no go mod */ }

    try {
      await access(resolve(this.rootPath, "pyproject.toml"));
      detected.add("python");
    } catch {
      try {
        await access(resolve(this.rootPath, "setup.py"));
        detected.add("python");
      } catch { /* no python project */ }
    }

    try {
      await access(resolve(this.rootPath, "pom.xml"));
      detected.add("java");
    } catch { /* no java */ }

    // Also scan for source files to catch mixed-language projects
    try {
      const entries = await readdir(this.rootPath, { withFileTypes: true });

      // Scan first-level source files too
      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = extname(entry.name);
          const lang = extToLang.get(ext);
          if (lang) detected.add(lang);
        }
      }

      // Scan top-level src/ dir
      try {
        const srcDir = resolve(this.rootPath, "src");
        const srcEntries = await readdir(srcDir, { withFileTypes: true });
        for (const entry of srcEntries) {
          if (entry.isFile()) {
            const ext = extname(entry.name);
            const lang = extToLang.get(ext);
            if (lang) detected.add(lang);
          }
        }
      } catch { /* no src dir */ }
    } catch { /* can't read dir */ }

    return Array.from(detected);
  }

  /** Get the language for a given file path. */
  getLanguageForFile(filePath: string): string | null {
    const ext = extname(filePath).toLowerCase();
    for (const [langName, lang] of this.languages) {
      if (lang.extensions.includes(ext)) return langName;
    }
    return null;
  }

  // =======================================================================
  // LSP Method Delegation (routes to the correct language client)
  // =======================================================================

  /** Get the LSP client for the given language. */
  private getClient(language: string): LspClient | null {
    const client = this.clients.get(language);
    if (!client || client.failed) return null;
    return client;
  }

  /** Get the LSP client for a given file path. */
  private getClientForFile(filePath: string): { client: LspClient; language: string } | null {
    const lang = this.getLanguageForFile(filePath);
    if (!lang) return null;
    const client = this.getClient(lang);
    if (!client) return null;
    return { client, language: lang };
  }

  async definitions(path: string, line: number, col: number): Promise<LspLocation[]> {
    const entry = this.getClientForFile(path);
    if (!entry) return [];
    return entry.client.definitions(path, line, col);
  }

  async references(path: string, line: number, col: number): Promise<LspLocation[]> {
    const entry = this.getClientForFile(path);
    if (!entry) return [];
    return entry.client.references(path, line, col);
  }

  async hover(path: string, line: number, col: number): Promise<string> {
    const entry = this.getClientForFile(path);
    if (!entry) return "";
    return entry.client.hover(path, line, col);
  }

  async diagnostics(path: string): Promise<LspDiagnostic[]> {
    const entry = this.getClientForFile(path);
    if (!entry) return [];
    const uri = `file://${resolve(path)}`;
    return entry.client.diagnostics.get(uri) ?? [];
  }

  /**
   * Batch diagnostics for multiple files for the same language.
   */
  async batchDiagnostics(files: string[]): Promise<Map<string, LspDiagnostic[]>> {
    const results = new Map<string, LspDiagnostic[]>();

    // Group by language
    const byLang = new Map<string, string[]>();
    for (const file of files) {
      const lang = this.getLanguageForFile(file);
      if (lang) {
        const arr = byLang.get(lang) ?? [];
        arr.push(file);
        byLang.set(lang, arr);
      }
    }

    // Query each language in parallel
    const promises: Promise<void>[] = [];
    for (const [, fileList] of byLang) {
      promises.push(Promise.all(
        fileList.map(async (f) => {
          const diags = await this.diagnostics(f);
          results.set(f, diags);
        }),
      ).then(() => {}));
    }

    await Promise.allSettled(promises);
    return results;
  }

  async completions(path: string, line: number, col: number): Promise<LspCompletionItem[]> {
    const entry = this.getClientForFile(path);
    if (!entry) return [];
    return entry.client.completions(path, line, col);
  }

  async signatureHelp(path: string, line: number, col: number): Promise<LspSignatureInfo | null> {
    const entry = this.getClientForFile(path);
    if (!entry) return null;
    return entry.client.signatureHelp(path, line, col);
  }

  async rename(path: string, line: number, col: number, newName: string): Promise<LspTextEdit[]> {
    const entry = this.getClientForFile(path);
    if (!entry) return [];
    return entry.client.rename(path, line, col, newName);
  }

  async format(path: string): Promise<LspTextEdit[]> {
    const entry = this.getClientForFile(path);
    if (!entry) return [];
    return entry.client.format(path);
  }

  async codeAction(path: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }): Promise<LspCodeAction[]> {
    const entry = this.getClientForFile(path);
    if (!entry) return [];
    return entry.client.codeAction(path, range);
  }

  async documentSymbol(path: string): Promise<LspSymbolInformation[]> {
    const entry = this.getClientForFile(path);
    if (!entry) return [];
    return entry.client.documentSymbol(path);
  }

  // =======================================================================
  // Cross-language operations
  // =======================================================================

  /**
   * Find references across all language servers and merge results by URI.
   */
  async referencesAll(path: string, line: number, col: number): Promise<LspLocation[]> {
    const allLocations: LspLocation[] = [];
    const promises: Promise<void>[] = [];

    for (const [, client] of this.clients) {
      if (!client.connected) continue;
      promises.push(
        client.references(path, line, col)
          .then((locations) => { allLocations.push(...locations); })
          .catch(() => {}),
      );
    }

    await Promise.allSettled(promises);

    // Dedup by URI+range
    const seen = new Set<string>();
    return allLocations.filter((loc) => {
      const key = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // =======================================================================
  // Status
  // =======================================================================

  /** Get status of all language servers. */
  getStatus(): LspServerStatus[] {
    const statuses: LspServerStatus[] = [];
    for (const [langName, lang] of this.languages) {
      const state = this.state.get(langName) ?? "disabled";
      const client = this.clients.get(langName);
      const startTime = this.startTimes.get(langName) ?? 0;
      statuses.push({
        language: langName,
        state,
        diagnosticsCount: client ? client.diagnostics.size : 0,
        uptimeMs: startTime > 0 ? Date.now() - startTime : 0,
      });
    }
    return statuses;
  }

  /** Get the list of connected language names. */
  getConnectedLanguages(): string[] {
    return Array.from(this.clients.entries())
      .filter(([, c]) => c.connected)
      .map(([name]) => name);
  }

  /** Get the list of failed language names. */
  getFailedLanguages(): string[] {
    return Array.from(this.clients.entries())
      .filter(([, c]) => c.failed)
      .map(([name]) => name);
  }

  // =======================================================================
  // Tool definitions for the agent
  // =======================================================================

  /**
   * Build dynamic tool definitions for the agent based on which language
   * servers are connected and healthy.
   *
   * Returns an array of { name, description, inputSchema } objects suitable
   * for registration with ToolManager.
   */
  getAgentToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    const tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }> = [];

    const connected = this.getConnectedLanguages();
    if (connected.length === 0) return tools;

    // LSPDefinitions tool
    tools.push({
      name: "LSPDefinitions",
      description: `Find the definition of a symbol at a given file:line:col. Connected languages: ${connected.join(", ")}. Returns the file path, line, and column of the definition.`,
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the file" },
          line: { type: "number", description: "Line number (0-based)" },
          col: { type: "number", description: "Column number (0-based)" },
        },
        required: ["filePath", "line", "col"],
      },
    });

    // LSPReferences tool
    tools.push({
      name: "LSPReferences",
      description: `Find all references to a symbol at a given file:line:col. Connected languages: ${connected.join(", ")}. Returns a sorted list of locations.`,
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the file" },
          line: { type: "number", description: "Line number (0-based)" },
          col: { type: "number", description: "Column number (0-based)" },
        },
        required: ["filePath", "line", "col"],
      },
    });

    // LSPHover tool
    tools.push({
      name: "LSPHover",
      description: `Get hover documentation for a symbol at a given file:line:col. Connected languages: ${connected.join(", ")}. Returns type information and documentation strings.`,
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the file" },
          line: { type: "number", description: "Line number (0-based)" },
          col: { type: "number", description: "Column number (0-based)" },
        },
        required: ["filePath", "line", "col"],
      },
    });

    // LSPDiagnostics tool
    tools.push({
      name: "LSPDiagnostics",
      description: `Get current diagnostics (errors, warnings) for a file from the LSP server's notification cache. Connected languages: ${connected.join(", ")}. Returns diagnostic messages with severity, file location, and message text.`,
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the file" },
        },
        required: ["filePath"],
      },
    });

    return tools;
  }
}

// =========================================================================
// Regex-based fallback parsers (used when LSP server is in 'failed' state)
// =========================================================================

/**
 * Fallback: extract symbols from a source file using regex.
 * Used when the LSP server for a language has failed.
 */
export function fallbackExtractSymbols(content: string, filePath: string): LspSymbolInformation[] {
  const symbols: LspSymbolInformation[] = [];
  const ext = extname(filePath).toLowerCase();
  const lines = content.split("\n");

  // TypeScript/JavaScript
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    const tsPatterns = [
      /export\s+(?:default\s+)?(?:class|function|interface|type|enum|const|let|var|abstract\s+class)\s+(\w+)/g,
      /^(?:class|function|interface|type|enum)\s+(\w+)/gm,
      /^\s*(?:export\s+)?const\s+(\w+)\s*[:=]/gm,
      /^\s*(?:export\s+)?function\s+\*?(\w+)/gm,
    ];
    for (const pattern of tsPatterns) {
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const lineNum = content.slice(0, m.index).split("\n").length - 1;
        symbols.push({
          name: m[1]!,
          kind: m[0]!.includes("class") ? 5 : m[0]!.includes("interface") ? 9 : m[0]!.includes("enum") ? 10 : m[0]!.includes("function") ? 12 : 13,
          location: {
            uri: filePath,
            range: { start: { line: lineNum, character: 0 }, end: { line: lineNum, character: m[1]!.length } },
          },
        });
      }
    }
  }

  // Python
  if (ext === ".py") {
    const pyPatterns = [
      /^(?:async\s+)?def\s+(\w+)/gm,
      /^class\s+(\w+)/gm,
    ];
    for (const pattern of pyPatterns) {
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const lineNum = content.slice(0, m.index).split("\n").length - 1;
        symbols.push({
          name: m[1]!,
          kind: pattern.source.includes("class") ? 5 : 12,
          location: {
            uri: filePath,
            range: { start: { line: lineNum, character: 0 }, end: { line: lineNum, character: m[1]!.length } },
          },
        });
      }
    }
  }

  // Rust
  if (ext === ".rs") {
    const rsPatterns = [
      /^\s*(?:pub\s+)?(?:fn|struct|enum|trait|impl|mod|type|const)\s+(\w+)/gm,
    ];
    for (const pattern of rsPatterns) {
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const lineNum = content.slice(0, m.index).split("\n").length - 1;
        symbols.push({
          name: m[1]!,
          kind: pattern.source.includes("fn") ? 12 : pattern.source.includes("struct") ? 23 : pattern.source.includes("enum") ? 10 : pattern.source.includes("trait") ? 17 : 13,
          location: {
            uri: filePath,
            range: { start: { line: lineNum, character: 0 }, end: { line: lineNum, character: m[1]!.length } },
          },
        });
      }
    }
  }

  // Go
  if (ext === ".go") {
    const goPatterns = [
      /^\s*func\s+(\w+)/gm,
      /^\s*type\s+(\w+)\s+(?:struct|interface)\s/gm,
    ];
    for (const pattern of goPatterns) {
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const lineNum = content.slice(0, m.index).split("\n").length - 1;
        symbols.push({
          name: m[1]!,
          kind: pattern.source.includes("func") ? 12 : 5,
          location: {
            uri: filePath,
            range: { start: { line: lineNum, character: 0 }, end: { line: lineNum, character: m[1]!.length } },
          },
        });
      }
    }
  }

  return symbols;
}