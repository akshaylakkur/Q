/**
 * QollabSessionStore — SQLite-backed persistence for Qollab sessions.
 *
 * Stores:
 * - Session registry (id, key hash, metadata, status)
 * - Attendee list (user_id, display_name, color, role)
 * - Chat message history (rolling, up to limit)
 * - Snapshot chain (snapshot_id, parent_id, manifest, created_by)
 *
 * Uses better-sqlite3 for synchronous, fast operations.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  QollabSession,
  QollabSessionMetadata,
  QollabAttendee,
  QollabPermissions,
  QollabChatMessage,
  QollabSnapshot,
  SnapshotFileEntry,
  SnapshotManifest,
} from "../types.js";
import type { StoredSession, StoredAttendee, StoredChatMessage, StoredSnapshot } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = resolve(
  process.env.HOME ?? "/tmp",
  ".Q",
  "collab",
  "qollab.db",
);

// ─── QollabSessionStore ──────────────────────────────────────────────────────

export class QollabSessionStore {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? DEFAULT_DB_PATH;
    // Ensure directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initializeSchema();
  }

  /**
   * Initialize the database schema.
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        session_key_hash TEXT NOT NULL,
        master_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        display_name TEXT NOT NULL,
        collab_type TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '{}',
        max_attendees INTEGER NOT NULL DEFAULT 8,
        ttl_ms INTEGER NOT NULL DEFAULT 86400000,
        encryption_algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
        snapshot_ref TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attendees (
        user_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        color TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        connection_status TEXT NOT NULL DEFAULT 'offline',
        public_key TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        color TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        reply_to TEXT,
        target_user_id TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        parent_snapshot_id TEXT,
        manifest TEXT NOT NULL DEFAULT '{}',
        data_path TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attendees_session ON attendees(session_id);
      CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id, created_at);
    `);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  // ─── Session CRUD ────────────────────────────────────────────────────────

  /**
   * Create a new session.
   */
  createSession(
    sessionId: string,
    sessionKeyHash: string,
    masterUserId: string,
    metadata: QollabSessionMetadata,
  ): QollabSession {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (session_id, session_key_hash, master_user_id, created_at, status, display_name, collab_type, permissions, max_attendees, ttl_ms, encryption_algorithm, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionId,
      sessionKeyHash,
      masterUserId,
      now,
      "pending",
      metadata.displayName,
      metadata.collabType,
      JSON.stringify(metadata.permissions),
      metadata.maxAttendees,
      metadata.ttlMs,
      metadata.encryptionAlgorithm,
      now,
    );

    return this.getSession(sessionId)!;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): QollabSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
      | StoredSession
      | undefined;
    if (!row) return null;

    const permissions: QollabPermissions = JSON.parse(row.permissions);
    const attendees = this.getAttendees(sessionId);

    return {
      sessionId: row.session_id,
      sessionKey: "", // Never returned from store
      masterUserId: row.master_user_id,
      createdAt: row.created_at,
      status: row.status as QollabSession["status"],
      metadata: {
        displayName: row.display_name,
        collabType: row.collab_type as QollabSessionMetadata["collabType"],
        permissions,
        maxAttendees: row.max_attendees,
        createdAt: row.created_at,
        ttlMs: row.ttl_ms,
        encryptionAlgorithm: row.encryption_algorithm as "AES-256-GCM",
      },
      attendees,
      snapshotRef: row.snapshot_ref,
    };
  }

  /**
   * Update session status.
   */
  updateSessionStatus(sessionId: string, status: string): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?")
      .run(status, new Date().toISOString(), sessionId);
  }

  /**
   * Update session snapshot reference.
   */
  updateSessionSnapshot(sessionId: string, snapshotRef: string): void {
    this.db
      .prepare("UPDATE sessions SET snapshot_ref = ?, updated_at = ? WHERE session_id = ?")
      .run(snapshotRef, new Date().toISOString(), sessionId);
  }

  /**
   * Delete a session and all associated data.
   */
  deleteSession(sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM snapshots WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM attendees WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    })();
  }

  /**
   * List all active sessions.
   */
  listActiveSessions(): QollabSession[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE status IN ('pending', 'active') ORDER BY created_at DESC")
      .all() as StoredSession[];

    return rows.map((row) => this.getSession(row.session_id)!).filter(Boolean);
  }

  // ─── Attendee CRUD ──────────────────────────────────────────────────────

  /**
   * Add an attendee to a session.
   */
  addAttendee(attendee: QollabAttendee, sessionId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO attendees (user_id, session_id, display_name, color, role, joined_at, connection_status, public_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attendee.userId,
        sessionId,
        attendee.displayName,
        attendee.color,
        attendee.role,
        attendee.joinedAt,
        attendee.connectionStatus,
        attendee.publicKey ?? null,
      );
  }

  /**
   * Update attendee connection status.
   */
  updateAttendeeStatus(userId: string, status: string): void {
    this.db
      .prepare("UPDATE attendees SET connection_status = ? WHERE user_id = ?")
      .run(status, userId);
  }

  /**
   * Remove an attendee from a session.
   */
  removeAttendee(userId: string): void {
    this.db.prepare("DELETE FROM attendees WHERE user_id = ?").run(userId);
  }

  /**
   * Get all attendees for a session.
   */
  getAttendees(sessionId: string): QollabAttendee[] {
    const rows = this.db
      .prepare("SELECT * FROM attendees WHERE session_id = ? ORDER BY joined_at ASC")
      .all(sessionId) as StoredAttendee[];

    return rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      color: row.color,
      role: row.role as "master" | "attendee",
      joinedAt: row.joined_at,
      connectionStatus: row.connection_status as QollabAttendee["connectionStatus"],
      publicKey: row.public_key ?? undefined,
    }));
  }

  // ─── Chat Message Persistence ───────────────────────────────────────────

  /**
   * Store a chat message.
   */
  storeChatMessage(sessionId: string, message: QollabChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO chat_messages (message_id, session_id, user_id, display_name, color, text, timestamp, type, reply_to, target_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.messageId,
        sessionId,
        message.userId,
        message.displayName,
        message.color,
        message.text,
        message.timestamp,
        message.type,
        message.replyTo ?? null,
        message.targetUserId ?? null,
      );
  }

  /**
   * Get chat history for a session.
   */
  getChatHistory(sessionId: string, limit?: number): QollabChatMessage[] {
    const maxLimit = limit ?? 100;
    const rows = this.db
      .prepare(
        "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?",
      )
      .all(sessionId, maxLimit) as StoredChatMessage[];

    return rows
      .reverse()
      .map((row) => ({
        messageId: row.message_id,
        userId: row.user_id,
        displayName: row.display_name,
        color: row.color,
        text: row.text,
        timestamp: row.timestamp,
        type: row.type as QollabChatMessage["type"],
        replyTo: row.reply_to ?? undefined,
        targetUserId: row.target_user_id ?? undefined,
      }));
  }

  // ─── Snapshot Persistence ──────────────────────────────────────────────

  /**
   * Store a snapshot reference.
   */
  storeSnapshot(
    snapshotId: string,
    sessionId: string,
    createdBy: string,
    parentSnapshotId: string | undefined,
    manifest: SnapshotManifest,
    dataPath: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (snapshot_id, session_id, created_at, created_by, parent_snapshot_id, manifest, data_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshotId,
        sessionId,
        new Date().toISOString(),
        createdBy,
        parentSnapshotId ?? null,
        JSON.stringify(manifest),
        dataPath,
      );
  }

  /**
   * Get the latest snapshot for a session.
   */
  getLatestSnapshot(sessionId: string): StoredSnapshot | null {
    const row = this.db
      .prepare(
        "SELECT * FROM snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(sessionId) as StoredSnapshot | undefined;

    return row ?? null;
  }

  /**
   * Get a specific snapshot by ID.
   */
  getSnapshot(snapshotId: string): StoredSnapshot | null {
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE snapshot_id = ?")
      .get(snapshotId) as StoredSnapshot | undefined;

    return row ?? null;
  }

  /**
   * Get snapshot chain for a session.
   */
  getSnapshotChain(sessionId: string): StoredSnapshot[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM snapshots WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionId) as StoredSnapshot[];

    return rows;
  }
}
