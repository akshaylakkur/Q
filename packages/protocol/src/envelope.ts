/**
 * @qode-agent/protocol — Canonical wire types for the local-to-remote
 * QSSH bridge. Imported by both the local q-cli (SSH client + TUI bridge)
 * and the remote q-remote (headless daemon + event bridge) to guarantee
 * both sides agree on the on-the-wire shape.
 *
 * Everything is transported as line-delimited JSON (NDJSON). Each line is
 * one {@link NdjsonEnvelope}. Control commands flow in the opposite
 * direction as {@link ControlCommand} entries appended to a control file.
 */

// ─── Event Envelope ────────────────────────────────────────────────────────

/**
 * A single NDJSON line streamed from the remote daemon to the local client.
 *
 * `seq` is monotonically increasing and starts at 1. The local client tracks
 * the highest `seq` it has seen so it can request replay from `seq + 1` after
 * a reconnect (resume).
 */
export interface NdjsonEnvelope {
  /** Monotonic sequence number (1-based). */
  seq: number;
  /** ISO-8601 timestamp the event was emitted. */
  ts: string;
  /** Logical channel that produced this event. */
  kind: EnvelopeKind;
  /** Event type within the channel (mirrors the agent/orchestrator event types). */
  type: string;
  /** Arbitrary payload fields keyed by event type. */
  [key: string]: unknown;
}

export type EnvelopeKind = "agent" | "orchestrator" | "system" | "sync" | "audit";

// ─── System Event Types ────────────────────────────────────────────────────

/** Emitted by the daemon every heartbeat interval to signal liveness. */
export interface HeartbeatEvent extends NdjsonEnvelope {
  kind: "system";
  type: "heartbeat";
  alive: true;
  uptimeMs: number;
  pid: number;
}

/** Emitted once when the daemon starts, carries instance metadata. */
export interface MetadataEvent extends NdjsonEnvelope {
  kind: "system";
  type: "remote.metadata";
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
}

/** Emitted when the daemon shuts down (graceful or error). */
export interface ShutdownEvent extends NdjsonEnvelope {
  kind: "system";
  type: "shutdown";
  reason: "graceful" | "error" | "signal";
  message?: string;
}

// ─── Audit Event Types ─────────────────────────────────────────────────────

export type FileAuditAction = "create" | "modify" | "delete" | "rename";

export interface FileAuditEvent extends NdjsonEnvelope {
  kind: "audit";
  type: `file.${FileAuditAction}`;
  path: string;
  bytesBefore?: number;
  bytesAfter?: number;
  toolCallId?: string;
  agentId?: string;
}

// ─── Sync Event Types ──────────────────────────────────────────────────────

export interface SyncProgressEvent extends NdjsonEnvelope {
  kind: "sync";
  type: "sync.progress";
  phase: "manifest" | "diff" | "transfer" | "apply" | "complete";
  direction: "pull" | "push";
  current: number;
  total: number;
  message?: string;
}

// ─── Control Commands (local → remote) ─────────────────────────────────────

export type ControlCmdName =
  | "prompt"
  | "cancel"
  | "status"
  | "heartbeat"
  | "shutdown"
  | "sync-diff"
  | "sync-apply"
  | "set-mode";

export interface ControlCommand {
  cmd: ControlCmdName;
  [key: string]: unknown;
}

export interface PromptControlCommand extends ControlCommand {
  cmd: "prompt";
  text: string;
  mode?: "auto" | "modus_maximus";
}

export interface CancelControlCommand extends ControlCommand {
  cmd: "cancel";
}

export interface StatusControlCommand extends ControlCommand {
  cmd: "status";
}

export interface ShutdownControlCommand extends ControlCommand {
  cmd: "shutdown";
}

export interface SetModeControlCommand extends ControlCommand {
  cmd: "set-mode";
  mode: "auto" | "modus_maximus";
}

export interface SyncDiffControlCommand extends ControlCommand {
  cmd: "sync-diff";
}

export interface SyncApplyControlCommand extends ControlCommand {
  cmd: "sync-apply";
  patchPath: string;
}

// ─── Remote Status Response ───────────────────────────────────────────────

export interface RemoteStatus {
  running: boolean;
  pid: number;
  sessionId: string;
  lastEventSeq: number;
  mode: string;
  state: string;
  uptimeMs: number;
}

// ─── File Manifest (sync) ──────────────────────────────────────────────────

export interface FileManifestEntry {
  /** Relative path within the workspace. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Last modified time in ms since epoch. */
  mtimeMs: number;
  /** SHA-256 hex digest of file contents (empty string for dirs/symlinks). */
  sha256: string;
}

export interface FileManifest {
  workspace: string;
  entries: FileManifestEntry[];
  generatedAt: string;
}

// ─── Sync Plan & Report ────────────────────────────────────────────────────

export type ConflictPolicy = "remote-wins" | "local-wins" | "prompt" | "merge";

export type SyncDirection = "pull" | "push" | "both";

export interface SyncPlan {
  /** Files to fetch from remote → local. */
  pull: FileManifestEntry[];
  /** Files to send from local → remote. */
  push: FileManifestEntry[];
  /** Relative paths that differ on both sides (need policy resolution). */
  conflicts: FileManifestEntry[];
}

export interface SyncReport {
  direction: SyncDirection;
  policy: ConflictPolicy;
  pulled: number;
  pushed: number;
  conflicts: number;
  conflictsResolved: number;
  errors: string[];
  dryRun: boolean;
}

// ─── Credentials Payload ──────────────────────────────────────────────────

export interface CredentialPayload {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  thinkingLevel?: "none" | "low" | "medium" | "high";
}

// ─── Session Info ─────────────────────────────────────────────────────────

export interface RemoteSessionInfo {
  host: string;
  user?: string;
  port?: number;
  sessionId: string;
  workspace: string;
  remoteNodeVersion: string;
  remoteArch: string;
  remotePlatform: string;
  startedAt: string;
  pid: number;
  mode: string;
}

// ─── Connection Health ────────────────────────────────────────────────────

export type ConnectionHealth = "live" | "degraded" | "lost";

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a single NDJSON line into an envelope, or return null if the line
 * is empty/malformed. Throws never.
 */
export function parseEnvelope(line: string): NdjsonEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as NdjsonEnvelope;
  } catch {
    return null;
  }
}

/**
 * Serialize an envelope to a single NDJSON line (no trailing newline).
 */
export function serializeEnvelope(env: NdjsonEnvelope): string {
  return JSON.stringify(env);
}

/**
 * Type guard: is this envelope a heartbeat?
 */
export function isHeartbeat(env: NdjsonEnvelope): env is HeartbeatEvent {
  return env.kind === "system" && env.type === "heartbeat";
}

/**
 * Type guard: is this envelope a metadata event?
 */
export function isMetadata(env: NdjsonEnvelope): env is MetadataEvent {
  return env.kind === "system" && env.type === "remote.metadata";
}

/**
 * Type guard: is this envelope a file audit event?
 */
export function isFileAudit(env: NdjsonEnvelope): env is FileAuditEvent {
  return env.kind === "audit" && env.type.startsWith("file.");
}

/**
 * Type guard: is this envelope a sync progress event?
 */
export function isSyncProgress(env: NdjsonEnvelope): env is SyncProgressEvent {
  return env.kind === "sync" && env.type === "sync.progress";
}