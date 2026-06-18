/**
 * Event adapter — converts NDJSON envelopes from the remote daemon into the
 * AgentEvent shape that the TUI's handleAgentEvent() expects.
 *
 * This is the bridge between the wire protocol (NDJSON envelopes) and the
 * local TUI rendering pipeline (StreamingController, tool call components,
 * thinking sections, status messages).
 *
 * The mapping is 1:1 for agent events: the remote EventBridge spreads the
 * original event fields into the envelope, so we just extract them back.
 * For system/sync/audit events, we translate to TUI-friendly types.
 */

import type { NdjsonEnvelope, FileAuditEvent, HeartbeatEvent, MetadataEvent, SyncProgressEvent } from "@qode-agent/protocol";
import { isFileAudit, isHeartbeat, isMetadata, isSyncProgress } from "@qode-agent/protocol";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A TUI event — mirrors the AgentEvent type in tui/types.ts but is kept
 * loose here to avoid a circular import. The TUI's handleAgentEvent accepts
 * any object with a `type` string.
 */
export interface TuiEvent {
  type: string;
  [key: string]: unknown;
}

export interface RemoteAdapterCallbacks {
  /** Called for agent/orchestrator events (mapped to TUI handleAgentEvent). */
  onAgentEvent: (event: TuiEvent) => void;
  /** Called for the initial metadata event. */
  onMetadata?: (info: MetadataEvent) => void;
  /** Called for heartbeat events. */
  onHeartbeat?: (event: HeartbeatEvent) => void;
  /** Called for file audit events. */
  onFileAudit?: (event: FileAuditEvent) => void;
  /** Called for sync progress events. */
  onSyncProgress?: (event: SyncProgressEvent) => void;
  /** Called for shutdown events. */
  onShutdown?: (event: NdjsonEnvelope) => void;
  /** Called for unrecognized events. */
  onUnknown?: (env: NdjsonEnvelope) => void;
}

// ─── adaptRemoteEvent ──────────────────────────────────────────────────────

/**
 * Convert a single NDJSON envelope into TUI event(s) and invoke the
 * appropriate callback.
 */
export function adaptRemoteEvent(env: NdjsonEnvelope, callbacks: RemoteAdapterCallbacks): void {
  // System events
  if (env.kind === "system") {
    if (isMetadata(env)) {
      callbacks.onMetadata?.(env);
      return;
    }
    if (isHeartbeat(env)) {
      callbacks.onHeartbeat?.(env);
      return;
    }
    if (env.type === "shutdown") {
      callbacks.onShutdown?.(env);
      return;
    }
    if (env.type === "ready" || env.type === "warning" || env.type === "status" || env.type === "cancelled" || env.type === "mode.changed" || env.type === "prompt.received") {
      // Forward as a status-like agent event so the TUI can show it
      callbacks.onAgentEvent({ type: "remote.system", ...stripEnvelopeFields(env) });
      return;
    }
    callbacks.onUnknown?.(env);
    return;
  }

  // Audit events
  if (isFileAudit(env)) {
    callbacks.onFileAudit?.(env);
    // Also forward to the TUI as a tool-result-like event for the audit log
    callbacks.onAgentEvent({ type: env.type, ...stripEnvelopeFields(env) });
    return;
  }

  // Sync events
  if (isSyncProgress(env)) {
    callbacks.onSyncProgress?.(env);
    callbacks.onAgentEvent({ type: "remote.sync", ...stripEnvelopeFields(env) });
    return;
  }

  // Agent + orchestrator events — pass through directly to the TUI handler.
  // The remote EventBridge spread the original event fields into the envelope,
  // so stripping seq/ts/kind leaves the original event shape.
  if (env.kind === "agent" || env.kind === "orchestrator") {
    const event = stripEnvelopeFields(env) as TuiEvent;
    if (typeof event.type === "string") {
      callbacks.onAgentEvent(event);
    }
    return;
  }

  callbacks.onUnknown?.(env);
}

/**
 * Remove the envelope wrapper fields, leaving the original event payload.
 */
function stripEnvelopeFields(env: NdjsonEnvelope): Record<string, unknown> {
  const { seq: _seq, ts: _ts, kind: _kind, ...rest } = env;
  return rest;
}