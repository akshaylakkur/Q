/**
 * q-remote event-bridge — converts agent/orchestrator/system events into
 * canonical {@link NdjsonEnvelope} objects and writes them to both stdout
 * (live streaming to the SSH client) and the {@link LogStore} (for resume
 * replay).
 *
 * The bridge maintains a monotonically increasing `seq` counter so the local
 * client can detect gaps on reconnect and request replay from `seq + 1`.
 */

import { writeSync } from "node:fs";
import { hostname } from "node:os";
import type {
  NdjsonEnvelope,
  EnvelopeKind,
  MetadataEvent,
  HeartbeatEvent,
  ShutdownEvent,
  FileAuditEvent,
  FileAuditAction,
  SyncProgressEvent,
} from "@qode-agent/protocol";
import { serializeEnvelope, isHeartbeat } from "@qode-agent/protocol";
import { LogStore } from "./log-store.js";

// ─── EventBridge ─────────────────────────────────────────────────────────────

export interface EventBridgeOptions {
  /** The LogStore to persist events to. */
  logStore: LogStore;
  /** Write to stdout (live streaming). Default true. */
  writeToStdout?: boolean;
}

export class EventBridge {
  private seq = 0;
  private readonly logStore: LogStore;
  private readonly writeToStdout: boolean;
  private readonly stdoutFd = 1; // process.stdout.fd

  constructor(opts: EventBridgeOptions) {
    this.logStore = opts.logStore;
    this.writeToStdout = opts.writeToStdout ?? true;
  }

  /**
   * The current sequence number (last emitted).
   */
  get currentSeq(): number {
    return this.seq;
  }

  /**
   * Emit an arbitrary event. The `kind` and `type` classify it; remaining
   * fields are spread into the envelope.
   */
  emit(kind: EnvelopeKind, type: string, data: Record<string, unknown> = {}): void {
    this.seq++;
    const env: NdjsonEnvelope = {
      seq: this.seq,
      ts: new Date().toISOString(),
      kind,
      type,
      ...data,
    };
    this.write(env);
  }

  /**
   * Emit an agent event (from the Agent's RPC channel). The event object's
   * `type` field is preserved; everything else is spread into the envelope.
   */
  emitAgentEvent(event: unknown): void {
    const e = event as Record<string, unknown>;
    if (!e || typeof e.type !== "string") return;
    this.emit("agent", e.type, e as Record<string, unknown>);
  }

  /**
   * Emit an orchestrator event (from the OrchestratorCore event system).
   */
  emitOrchestratorEvent(event: unknown): void {
    const e = event as Record<string, unknown>;
    if (!e || typeof e.type !== "string") return;
    this.emit("orchestrator", e.type, e as Record<string, unknown>);
  }

  /**
   * Emit the initial metadata event (sent once on daemon start).
   */
  emitMetadata(info: {
    host: string;
    user?: string;
    sessionId: string;
    workspace: string;
    nodeVersion: string;
    arch: string;
    platform: string;
    pid: number;
    startedAt: string;
    mode: string;
  }): void {
    this.emit("system", "remote.metadata", info as Record<string, unknown>);
  }

  /**
   * Emit a heartbeat event.
   */
  emitHeartbeat(uptimeMs: number, pid: number): void {
    const env: HeartbeatEvent = {
      seq: 0, // will be overwritten
      ts: new Date().toISOString(),
      kind: "system",
      type: "heartbeat",
      alive: true,
      uptimeMs,
      pid,
    };
    // Use emit() to get the proper seq
    this.emit("system", "heartbeat", {
      alive: true,
      uptimeMs,
      pid,
    });
    // (env object above was just for type clarity)
    void env;
  }

  /**
   * Emit a file audit event.
   */
  emitFileAudit(action: FileAuditAction, path: string, extra: { bytesBefore?: number; bytesAfter?: number; toolCallId?: string; agentId?: string } = {}): void {
    this.emit("audit", `file.${action}`, { path, ...extra });
  }

  /**
   * Emit a sync progress event.
   */
  emitSyncProgress(phase: SyncProgressEvent["phase"], direction: "pull" | "push", current: number, total: number, message?: string): void {
    this.emit("sync", "sync.progress", { phase, direction, current, total, message });
  }

  /**
   * Emit a shutdown event.
   */
  emitShutdown(reason: ShutdownEvent["reason"], message?: string): void {
    this.emit("system", "shutdown", { reason, message });
  }

  /**
   * Replay all events from the log with seq >= fromSeq to stdout.
   * Used when a client reconnects and wants to catch up.
   */
  replay(fromSeq: number): number {
    const events = this.logStore.read(fromSeq);
    for (const env of events) {
      this.writeRaw(serializeEnvelope(env) + "\n");
    }
    return events.length;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private write(env: NdjsonEnvelope): void {
    // Persist to log first (crash safety)
    this.logStore.append(env);
    // Stream to stdout
    if (this.writeToStdout) {
      this.writeRaw(serializeEnvelope(env) + "\n");
    }
  }

  private writeRaw(line: string): void {
    const buf = Buffer.from(line, "utf-8");
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(this.stdoutFd, buf, offset);
    }
  }
}