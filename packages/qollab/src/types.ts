/**
 * Qollab — Core type definitions for secure agentic collaboration.
 *
 * Defines the data models for sessions, attendees, chat messages,
 * snapshots, and the WebSocket event protocol between master and attendees.
 */

// ── Session Identity ─────────────────────────────────────────

export interface QollabSession {
  sessionId: string;
  sessionKey: string;
  masterUserId: string;
  createdAt: string;
  status: "pending" | "active" | "completed" | "failed";
  metadata: QollabSessionMetadata;
  attendees: QollabAttendee[];
  snapshotRef: string;
}

export interface QollabSessionMetadata {
  displayName: string;
  collabType: "pair" | "team" | "review" | "hackathon";
  permissions: QollabPermissions;
  maxAttendees: number;
  createdAt: string;
  ttlMs: number;
  encryptionAlgorithm: "AES-256-GCM";
}

export interface QollabPermissions {
  allowChatHistoryExport: boolean;
  allowSnapshotPullByAttendees: boolean;
  allowSnapshotSyncFromAttendees: boolean;
  requireMasterApprovalForJoin: boolean;
  requireMasterApprovalForSnapshotSync: boolean;
}

// ── Attendee / User ───────────────────────────────────────────

export interface QollabAttendee {
  userId: string;
  displayName: string;
  color: string;
  role: "master" | "attendee";
  joinedAt: string;
  connectionStatus: "online" | "away" | "offline" | "pending";
  publicKey?: string;
}

// ── Chat ──────────────────────────────────────────────────────

export interface QollabChatMessage {
  messageId: string;
  userId: string;
  displayName: string;
  color: string;
  text: string;
  timestamp: string;
  type:
    | "text"
    | "system"
    | "snapshot-sync-request"
    | "snapshot-sync-accepted"
    | "snapshot-updated"
    | "whisper";
  replyTo?: string;
  targetUserId?: string; // For whisper messages
}

// ── Snapshot ──────────────────────────────────────────────────

export interface QollabSnapshot {
  snapshotId: string;
  sessionId: string;
  createdAt: string;
  createdBy: string;
  fileEntries: SnapshotFileEntry[];
  parentSnapshotId?: string;
  manifest: SnapshotManifest;
}

export interface SnapshotFileEntry {
  path: string;
  content: string;
  sha256: string;
  size: number;
  encoding: "utf-8" | "base64";
}

export interface SnapshotManifest {
  totalFiles: number;
  totalSizeBytes: number;
  changedFiles: string[];
  commitMessage?: string;
}

// ── Merge Report (from agentic merge) ──────────────────────────

export interface MergeReport {
  changedFiles: string[];
  commitMessage: string;
  diffSummary: string;
  success: boolean;
  error?: string;
}

// ── WebSocket Events ─────────────────────────────────────────

export type QollabServerEvent =
  | { type: "session.state"; session: QollabSession }
  | { type: "attendee.joined"; attendee: QollabAttendee }
  | { type: "attendee.left"; userId: string }
  | { type: "attendee.pending"; userId: string; displayName: string; color: string }
  | { type: "attendee.admitted"; userId: string }
  | { type: "attendee.rejected"; userId: string; reason?: string }
  | { type: "attendee.status"; userId: string; connectionStatus: QollabAttendee["connectionStatus"] }
  | { type: "chat.message"; message: QollabChatMessage }
  | { type: "snapshot.created"; snapshot: QollabSnapshot }
  | { type: "snapshot.sync-request"; userId: string; displayName: string; prompt: string; mergeReport: MergeReport }
  | { type: "snapshot.sync-accepted"; acceptedBy: string; snapshotId: string }
  | { type: "snapshot.sync-rejected"; reason: string }
  | { type: "session.expired" }
  | { type: "error"; code: string; message: string }
  | { type: "heartbeat" };

export type QollabClientEvent =
  | { type: "auth"; sessionKey: string; displayName: string }
  | { type: "chat.send"; text: string; replyTo?: string; targetUserId?: string }
  | { type: "snapshot.pull" }
  | { type: "snapshot.sync-request"; prompt: string }
  | { type: "snapshot.sync-accept"; snapshotId: string }
  | { type: "snapshot.sync-reject"; reason: string }
  | { type: "attendee.admit"; userId: string }
  | { type: "attendee.reject"; userId: string; reason?: string }
  | { type: "attendee.kick"; userId: string }
  | { type: "attendee.away" }
  | { type: "attendee.back" }
  | { type: "disconnect" }
  | { type: "pong" };

// ── Server options ─────────────────────────────────────────────

export interface QollabServerOptions {
  port: number;
  host?: string;
  tls?: { cert: string; key: string };
  dataDir?: string;
  sessionTtlMs?: number;
  maxAttendees?: number;
  rateLimitSyncPerMinute?: number;
}

// ── Client options ─────────────────────────────────────────────

export interface QollabClientOptions {
  serverUrl: string;
  sessionKey: string;
  displayName: string;
  userId?: string;
  onEvent: (event: QollabServerEvent) => void;
  onDisconnect?: () => void;
  onError?: (err: Error) => void;
}

// ── Config ─────────────────────────────────────────────────────

export interface QollabConfig {
  enabled: boolean;
  serverUrl: string;
  defaultCollabType: QollabSessionMetadata["collabType"];
  maxAttendees: number;
  snapshotSyncRateLimit: number;
  encryption: "AES-256-GCM";
  chat: {
    historyLimit: number;
    colorPalette: string[];
  };
}
