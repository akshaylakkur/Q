/**
 * q-remote RemoteDaemon — headless agent daemon.
 *
 * Lifecycle:
 *   1. Decrypt credentials from the uploaded `.qcred.enc` using the
 *      passphrase read from a tmp file (transmitted out-of-band).
 *   2. Initialize the EventBridge + LogStore.
 *   3. Emit the metadata event (instance info).
 *   4. Create the headless Agent + OrchestratorCore + memory system.
 *   5. Start the heartbeat timer (5s).
 *   6. Poll the control file (`control.jsonl`) for new commands.
 *   7. On shutdown signal or shutdown command: emit shutdown, flush, exit.
 *
 * ── SAFEGUARDS ───────────────────────────────────────────────────────────
 *
 * 1. Prompt timeout: each prompt execution is wrapped in a timeout race.
 *    If the prompt (including all its LLM calls + tool executions) exceeds
 *    PROMPT_TIMEOUT_MS (30 minutes), the orchestrator is cancelled and
 *    the daemon emits a timeout event instead of staying stuck forever.
 *
 * 2. Stuck-prompt watchdog: a background interval (every 15s) monitors
 *    whether the orchestrator has been "running" for too long without
 *    producing any events. If it appears stuck, the watchdog re-initializes
 *    the agent and emits a warning event. This prevents the daemon from
 *    silently sitting in a broken state after a hung tool call.
 *
 * 3. Graceful recovery: after a timeout or error, the daemon re-creates
 *    the agent and orchestrator rather than remaining in a broken state.
 *    Future prompts will use a fresh pipeline.
 *
 * nohup compatibility:
 *   - Control is file-based (control.jsonl), NOT stdin. The daemon watches
 *     the control file for new lines appended by the local client.
 *   - stdout is written line-by-line (no buffering tricks).
 *   - Events are persisted to events.log BEFORE being written to stdout
 *     so they survive a crash mid-stream.
 */

import { hostname, userInfo, platform, arch } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, appendFileSync, statSync, openSync, closeSync, readSync, watchFile } from "node:fs";
import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";

import { OrchestratorCore, PluginManager, SkillRegistry, McpConnectionManager } from "@qode-agent/runtime";
import type { ControlCommand, CredentialPayload, RemoteStatus } from "@qode-agent/protocol";

import { decryptCredentials } from "./credentials.js";
import { EventBridge } from "./event-bridge.js";
import { LogStore } from "./log-store.js";
import { SessionManager } from "./session-manager.js";
import { createHeadlessAgent } from "./agent-factory.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DaemonOptions {
  workspace: string;
  sessionId: string;
  credsPath: string;
  passphrase: string;
  mode?: string;
  permissionMode?: "manual" | "yolo" | "auto";
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 5_000;
const CONTROL_POLL_INTERVAL_MS = 200;

/**
 * Maximum time (1 hr 18 min) a single prompt can take before it is forcefully
 * cancelled. This prevents the daemon from staying stuck on a prompt
 * that hangs due to a tool execution or LLM call that never completes.
 */
const PROMPT_TIMEOUT_MS = 4_680_000;

/**
 * Watchdog interval (15s): checks if the orchestrator has been running
 * too long without producing events. If so, it re-initializes the agent.
 */
const WATCHDOG_INTERVAL_MS = 15_000;

/**
 * If the orchestrator is "running" and no new events have been emitted
 * for this many ms, the watchdog considers it stuck and re-initializes.
 */
const STUCK_THRESHOLD_MS = 120_000;

// ─── RemoteDaemon ───────────────────────────────────────────────────────────

export class RemoteDaemon {
  private readonly opts: DaemonOptions;
  private readonly qremoteDir: string;
  private readonly logStore: LogStore;
  private readonly eventBridge: EventBridge;
  private readonly sessionManager: SessionManager;
  private agent: ReturnType<typeof createHeadlessAgent> | null = null;
  private orchestrator: OrchestratorCore | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private controlPollTimer: ReturnType<typeof setInterval> | null = null;
  private controlReadOffset = 0;
  private readonly controlPath: string;
  private readonly pidPath: string;
  private readonly eventsLogPath: string;
  private startedAt = Date.now();
  private running = false;
  private currentMode: string;

  // ── SAFEGUARD: Watchdog state ───────────────────────────────────────────
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogLastEventSeq = 0;
  private agentInitialized = false;
  private creds: CredentialPayload | null = null;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.qremoteDir = resolve(opts.workspace, ".q-remote");
    this.eventsLogPath = resolve(this.qremoteDir, "events.log");
    this.controlPath = resolve(this.qremoteDir, "control.jsonl");
    this.pidPath = resolve(this.qremoteDir, "daemon.pid");
    this.logStore = new LogStore(this.eventsLogPath);
    this.eventBridge = new EventBridge({ logStore: this.logStore });
    this.sessionManager = new SessionManager(opts.workspace);
    this.currentMode = opts.mode ?? "auto";
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Ensure .q-remote directory exists
    mkdirSync(this.qremoteDir, { recursive: true });

    // Open the log store
    this.logStore.open();

    // Write the PID file
    writeFileSync(this.pidPath, String(process.pid), "utf-8");

    // Initialize session
    this.sessionManager.initSession(this.opts.sessionId, this.opts.workspace, this.currentMode, process.pid);
    this.sessionManager.updateStatus(this.opts.sessionId, "starting");

    // Decrypt credentials
    let creds: CredentialPayload;
    try {
      const blob = readFileSync(this.opts.credsPath);
      creds = decryptCredentials(blob, this.opts.passphrase);
      this.creds = creds; // cache for watchdog recovery
      // Delete the creds file after decryption (security)
      try { unlinkSync(this.opts.credsPath); } catch { /* best effort */ }
    } catch (err) {
      this.eventBridge.emitShutdown("error", `Credential decryption failed: ${err instanceof Error ? err.message : String(err)}`);
      this.logStore.close();
      try { unlinkSync(this.pidPath); } catch { /* */ }
      process.exit(1);
    }

    // Initialize the agent + orchestrator
    this.initializeAgentPipeline(creds);

    // Set up the control file (truncate any stale content)
    if (!existsSync(this.controlPath)) {
      writeFileSync(this.controlPath, "", "utf-8");
    }
    // Start from the current end of the control file
    this.controlReadOffset = existsSync(this.controlPath) ? statSync(this.controlPath).size : 0;

    // Start the heartbeat timer
    this.heartbeatTimer = setInterval(() => {
      this.eventBridge.emitHeartbeat(Date.now() - this.startedAt, process.pid);
    }, HEARTBEAT_INTERVAL_MS);

    // Start the control file poller
    this.controlPollTimer = setInterval(() => {
      this.pollControlFile();
    }, CONTROL_POLL_INTERVAL_MS);

    // ── SAFEGUARD: Start the watchdog timer ──────────────────────────────
    this.startWatchdog();

    // Emit metadata event with instance info
    this.eventBridge.emitMetadata({
      host: hostname(),
      user: (() => { try { return userInfo().username; } catch { return undefined; } })(),
      sessionId: this.opts.sessionId,
      workspace: this.opts.workspace,
      nodeVersion: process.version,
      arch: process.arch,
      platform: process.platform,
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      mode: this.currentMode,
    });

    // Mark running
    this.running = true;
    this.sessionManager.updateStatus(this.opts.sessionId, "running");

    this.eventBridge.emit("system", "ready", { message: "Daemon ready" });

    // Handle graceful shutdown signals
    const shutdownHandler = (signal: string) => {
      this.eventBridge.emitShutdown("signal", `Received ${signal}`);
      this.shutdown(0);
    };
    process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
    process.on("SIGINT", () => shutdownHandler("SIGINT"));
  }

  /**
   * Initialize (or re-initialize) the agent + orchestrator pipeline.
   * This is called on startup and after watchdog recovery.
   */
  private initializeAgentPipeline(creds: CredentialPayload): void {
    // Cancel any existing orchestrator
    try { this.orchestrator?.cancel(); } catch { /* */ }

    // Create the headless agent
    this.agent = createHeadlessAgent({
      workspace: this.opts.workspace,
      credentials: creds,
      eventBridge: this.eventBridge,
      permissionMode: this.opts.permissionMode ?? "yolo",
      profile: "auto",
      sessionId: this.opts.sessionId,
    });

    // Create the orchestrator
    this.orchestrator = new OrchestratorCore({
      convergenceTimeout: 60_000,
      taskTimeout: 300_000,
      workspaceRoot: this.opts.workspace,
    });
    this.orchestrator.setAgent(this.agent);
    this.orchestrator.setSessionId(this.opts.sessionId);

    // Wire orchestrator events to the bridge
    this.orchestrator.onEvent((event) => {
      this.eventBridge.emitOrchestratorEvent(event);
      // ── SAFEGUARD: Track last event seq for watchdog ──────────────────
      this.watchdogLastEventSeq = this.eventBridge.currentSeq;
    });

    // Initialize memory system (best-effort — non-fatal on failure)
    try {
      this.orchestrator.initMemorySystem(this.opts.sessionId).catch((err) => {
        this.eventBridge.emit("system", "warning", {
          message: `Memory system init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    } catch (err) {
      this.eventBridge.emit("system", "warning", {
        message: `Memory system init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Initialize plugins (best-effort)
    try {
      const skillRegistry = new SkillRegistry({ cwd: this.opts.workspace });
      const mcpManager = new McpConnectionManager();
      const pluginManager = new PluginManager(skillRegistry, mcpManager, this.agent.tools, {}, this.opts.workspace);
      this.orchestrator.setPluginManager(pluginManager);
      pluginManager.activateAll().catch((err) => {
        this.eventBridge.emit("system", "warning", {
          message: `Plugin activation error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    } catch (err) {
      this.eventBridge.emit("system", "warning", {
        message: `Plugin system init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    this.agentInitialized = true;
  }

  // ── SAFEGUARD: Watchdog ─────────────────────────────────────────────

  /**
   * Start the periodic watchdog that monitors the orchestrator for
   * stuck states. If the orchestrator is "running" and no events have
   * been emitted for STUCK_THRESHOLD_MS, the watchdog re-initializes
   * the agent pipeline.
   */
  private startWatchdog(): void {
    this.watchdogLastEventSeq = this.eventBridge.currentSeq;

    this.watchdogTimer = setInterval(() => {
      this.runWatchdogCheck();
    }, WATCHDOG_INTERVAL_MS);
  }

  private async runWatchdogCheck(): Promise<void> {
    if (!this.running) return;
    if (!this.orchestrator) return;
    if (!this.agentInitialized) return;

    const state = this.orchestrator.state;
    const currentSeq = this.eventBridge.currentSeq;
    const stableSinceMs = (currentSeq === this.watchdogLastEventSeq) ? WATCHDOG_INTERVAL_MS : 0;

    // Update the last event seq so we can measure time since last event
    this.watchdogLastEventSeq = currentSeq;

    // Only check when the orchestrator claims to be running
    if (state !== "running" && state !== "processing") return;

    // Check if we've been running without events for too long
    // The orchestrator's convergence loop should produce events periodically.
    // If it hasn't produced any events in STUCK_THRESHOLD_MS, it's likely stuck.
    // Note: this is an approximate check — we incrementally accumulate time.
    if (stableSinceMs < STUCK_THRESHOLD_MS / WATCHDOG_INTERVAL_MS) return;

    // ── SAFEGUARD: Detected stuck state — re-initialize ────────────────
    this.eventBridge.emit("system", "warning", {
      message: `Watchdog detected stuck orchestrator (state=${state}, no events for ${STUCK_THRESHOLD_MS}ms). Re-initializing agent pipeline.`,
    });

    try {
      this.orchestrator.cancel();
    } catch { /* */ }

    if (this.creds) {
      this.initializeAgentPipeline(this.creds);
      this.eventBridge.emit("system", "recovered", {
        message: "Agent pipeline re-initialized after watchdog recovery.",
      });
    } else {
      this.eventBridge.emit("system", "error", {
        message: "Watchdog recovery failed: no cached credentials available.",
      });
    }
  }

  /**
   * Graceful shutdown.
   */
  shutdown(exitCode: number = 0): void {
    if (!this.running) return;
    this.running = false;

    this.sessionManager.updateStatus(this.opts.sessionId, "completed");

    // ── SAFEGUARD: Stop watchdog timer ─────────────────────────────────
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.controlPollTimer) {
      clearInterval(this.controlPollTimer);
      this.controlPollTimer = null;
    }

    try { this.orchestrator?.cancel(); } catch { /* */ }

    this.logStore.close();
    try { unlinkSync(this.pidPath); } catch { /* */ }

    process.exit(exitCode);
  }

  /**
   * Get the current daemon status (for the `status` command).
   */
  getStatus(): RemoteStatus {
    return {
      running: this.running,
      pid: process.pid,
      sessionId: this.opts.sessionId,
      lastEventSeq: this.eventBridge.currentSeq,
      mode: this.currentMode,
      state: this.orchestrator?.state ?? "idle",
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  // ─── Control File Polling ──────────────────────────────────────────────────

  private pollControlFile(): void {
    if (!existsSync(this.controlPath)) return;
    let st;
    try { st = statSync(this.controlPath); } catch { return; }
    if (st.size <= this.controlReadOffset) return;

    // Read new content from our last offset
    let content: string;
    try {
      const fd = openSync(this.controlPath, "r");
      const len = st.size - this.controlReadOffset;
      const buf = Buffer.alloc(len);
      // Read from offset
      readSync(fd, buf, 0, len, this.controlReadOffset);
      closeSync(fd);
      content = buf.toString("utf-8");
    } catch {
      return;
    }
    this.controlReadOffset = st.size;

    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const cmd = JSON.parse(trimmed) as ControlCommand;
        this.handleControl(cmd);
      } catch {
        // Malformed line — skip
      }
    }
  }

  // ─── Command Handlers ──────────────────────────────────────────────────────

  private async handleControl(cmd: ControlCommand): Promise<void> {
    switch (cmd.cmd) {
      case "prompt":
        await this.handlePrompt(cmd);
        break;
      case "cancel":
        this.handleCancel();
        break;
      case "status":
        this.handleStatusRequest();
        break;
      case "set-mode":
        this.handleSetMode(cmd);
        break;
      case "confirm":
        this.handleConfirm(cmd);
        break;
      case "shutdown":
        this.eventBridge.emitShutdown("graceful", "Shutdown requested by client");
        this.shutdown(0);
        break;
      default:
        this.eventBridge.emit("system", "warning", {
          message: `Unknown control command: ${cmd.cmd}`,
        });
    }
  }

  /**
   * Normalize a mode string from the protocol (snake_case, lowercase)
   * to the runtime constant (SCREAMING_SNAKE_CASE, uppercase).
   *
   * Protocol sends: "auto" | "modus_maximus"
   * Runtime expects: "AUTO" | "MODUS_MAXIMUS"
   */
  private normalizeMode(mode: string | undefined): string {
    if (!mode) return this.currentMode;
    switch (mode) {
      case "auto": return "AUTO";
      case "modus_maximus": return "MODUS_MAXIMUS";
      default: return mode.toUpperCase();
    }
  }

  private async handlePrompt(cmd: ControlCommand): Promise<void> {
    if (!this.orchestrator) return;
    const text = String((cmd as { text?: string }).text ?? "");
    const rawMode = (cmd as { mode?: string }).mode;
    const mode = this.normalizeMode(rawMode);
    if (mode && (mode === "AUTO" || mode === "MODUS_MAXIMUS")) {
      this.currentMode = mode;
    }
    this.sessionManager.recordPrompt(this.opts.sessionId, text, this.currentMode);
    this.eventBridge.emit("system", "prompt.received", { text: text.slice(0, 200), mode: this.currentMode });

    // ── SAFEGUARD: Prompt timeout race ──────────────────────────────────
    // If the prompt takes longer than PROMPT_TIMEOUT_MS, we cancel the
    // orchestrator and emit a timeout event. This prevents the daemon
    // from staying stuck on a single prompt forever.
    const promptTimeout = setTimeout(() => {
      try { this.orchestrator?.cancel(); } catch { /* */ }
      this.eventBridge.emit("orchestrator", "prompt.timeout", {
        error: `Prompt timed out after ${PROMPT_TIMEOUT_MS}ms`,
        textPreview: text.slice(0, 200),
      });
    }, PROMPT_TIMEOUT_MS);

    try {
      this.orchestrator.currentMode = this.currentMode as any;
      const result = await this.orchestrator.submitPrompt(text);

      // ── SAFEGUARD: Update watchdog event seq after prompt completes ──
      this.watchdogLastEventSeq = this.eventBridge.currentSeq;

      this.eventBridge.emit("orchestrator", "prompt.complete", {
        success: result.success,
        mode: result.mode,
        durationMs: result.durationMs,
      });
    } catch (err) {
      // ── SAFEGUARD: Catch and emit all errors ──────────────────────────
      // This prevents a thrown error from crashing the daemon or putting
      // it into a broken state. The orchestrator is cancelled by the
      // timeout above or by the error itself.
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorName = err instanceof Error ? err.name : "UnknownError";

      this.eventBridge.emit("orchestrator", "prompt.error", {
        error: errorMsg,
        errorName,
        textPreview: text.slice(0, 200),
      });

      // ── SAFEGUARD: Auto-recovery after error ──────────────────────────
      // If the pipeline is broken, re-initialize the agent for the next
      // prompt so we don't accumulate broken state.
      if (this.creds) {
        try {
          this.orchestrator.cancel();
          this.initializeAgentPipeline(this.creds);
          this.eventBridge.emit("system", "recovered", {
            message: "Agent pipeline re-initialized after prompt error.",
          });
        } catch (reinitErr) {
          this.eventBridge.emit("system", "error", {
            message: `Failed to re-initialize after error: ${reinitErr instanceof Error ? reinitErr.message : String(reinitErr)}`,
          });
        }
      }
    } finally {
      clearTimeout(promptTimeout);
    }
  }

  private handleCancel(): void {
    try { this.orchestrator?.cancel(); } catch { /* */ }
    this.eventBridge.emit("system", "cancelled", {});
  }

  private handleStatusRequest(): void {
    const status = this.getStatus();
    this.eventBridge.emit("system", "status", status as unknown as Record<string, unknown>);
  }

  private handleSetMode(cmd: ControlCommand): void {
    const rawMode = (cmd as { mode?: string }).mode;
    if (rawMode) {
      this.currentMode = this.normalizeMode(rawMode);
      this.eventBridge.emit("system", "mode.changed", { mode: this.currentMode });
    }
  }

  /**
   * Handle a confirmation response from the TUI (modus-maximus plan review).
   * Forwards the choice to the orchestrator's ModusMaximusMode handler.
   */
  private handleConfirm(cmd: ControlCommand): void {
    const c = cmd as { choice?: string; revisionText?: string };
    if (!c.choice) return;
    const response: { choice: "looks-good" | "needs-revision" | "redo"; revisionText?: string } = {
      choice: c.choice as any,
      revisionText: c.revisionText,
    };
    this.eventBridge.emit("system", "confirm.received", { choice: c.choice });
    try {
      this.orchestrator?.resolveModusMaximusConfirmation(response);
    } catch (err) {
      this.eventBridge.emit("system", "warning", {
        message: `Confirm handler error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}