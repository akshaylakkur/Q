/**
 * Session-specific types for the Qollab session server and client.
 */

import type { QollabSession, QollabAttendee, QollabChatMessage, QollabSnapshot } from "../types.js";

// ── Session Store (SQLite-backed) ──────────────────────────────

export interface StoredSession {
  sessionId: string;
  sessionKeyHash: string;
  masterUserId: string;
  createdAt: string;
  status: string;
  displayName: string;
  collabType: string;
  permissions: string; // JSON
  maxAttendees: number;
  ttlMs: number;
  encryptionAlgorithm: string;
  snapshotRef: string;
  updatedAt: string;
}

export interface StoredAttendee {
  userId: string;
  sessionId: string;
  displayName: string;
  color: string;
  role: string;
  joinedAt: string;
  connectionStatus: string;
  publicKey: string | null;
}

export interface StoredChatMessage {
  messageId: string;
  sessionId: string;
  userId: string;
  displayName: string;
  color: string;
  text: string;
  timestamp: string;
  type: string;
  replyTo: string | null;
  targetUserId: string | null;
}

export interface StoredSnapshot {
  snapshotId: string;
  sessionId: string;
  createdAt: string;
  createdBy: string;
  parentSnapshotId: string | null;
  manifest: string; // JSON
  dataPath: string; // Path to tarball
}

// ── Session Server internal state ─────────────────────────────

export interface LiveSession {
  session: QollabSession;
  masterConnection: SessionConnection | null;
  attendeeConnections: Map<string, SessionConnection>;
  pendingAttendees: Map<string, { displayName: string; color: string; connection: SessionConnection }>;
  chatHistory: QollabChatMessage[];
  snapshotChain: string[]; // snapshotId ordered list
  mergeInProgress: boolean;
  lastSyncTimestamps: Map<string, number>; // userId -> timestamp
  createdAt: number;
}

export interface SessionConnection {
  userId: string;
  role: "master" | "attendee";
  send: (event: QollabServerEvent) => void;
  close: () => void;
  alive: boolean;
  lastPing: number;
}
