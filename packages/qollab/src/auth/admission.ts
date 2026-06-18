/**
 * QollabAdmission — Secure admission protocol for Qollab sessions.
 *
 * Flow:
 * 1. Master creates session -> server generates sessionKey, stores hash
 * 2. Attendee connects with sessionKey -> server verifies hash
 * 3. Attendee enters "pending" state -> master notified
 * 4. Master admits/rejects -> attendee gets access or denied
 */

import { randomUUID } from "node:crypto";
import type { QollabAttendee, QollabSession } from "../types.js";
import { hashSessionKey, verifySessionKey, generateSessionKey, assignColor } from "./encryption.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AdmissionRecord {
  sessionId: string;
  sessionKeyHash: string;
  masterUserId: string;
  createdAt: string;
  pendingAttendees: Map<string, PendingAttendee>;
}

export interface PendingAttendee {
  userId: string;
  displayName: string;
  color: string;
  requestedAt: string;
  connectionId: string;
}

// ─── Default color palette ──────────────────────────────────────────────

export const DEFAULT_COLOR_PALETTE = [
  "#22D3EE", // Cyan
  "#A78BFA", // Violet
  "#FBBF24", // Amber
  "#4ADE80", // Green
  "#FB7185", // Rose
  "#38BDF8", // Sky
  "#F472B6", // Pink
  "#34D399", // Emerald
];

// ─── QollabAdmission ─────────────────────────────────────────────────────

export class QollabAdmission {
  private sessions: Map<string, AdmissionRecord> = new Map();
  private readonly colorPalette: string[];

  constructor(colorPalette?: string[]) {
    this.colorPalette = colorPalette ?? DEFAULT_COLOR_PALETTE;
  }

  /**
   * Create a new session and generate its secure key.
   * Returns the session ID and the plaintext session key (to show to master).
   * The key hash is stored internally; the plaintext key is NOT stored.
   */
  createSession(masterUserId: string): { sessionId: string; sessionKey: string } {
    const sessionId = randomUUID();
    const sessionKey = generateSessionKey();
    const keyHash = hashSessionKey(sessionKey);

    this.sessions.set(sessionId, {
      sessionId,
      sessionKeyHash: keyHash,
      masterUserId,
      createdAt: new Date().toISOString(),
      pendingAttendees: new Map(),
    });

    return { sessionId, sessionKey };
  }

  /**
   * Attempt to authenticate an attendee with a session key.
   * Returns the session ID if authentication succeeds, or null if it fails.
   */
  authenticate(sessionKey: string): string | null {
    // Iterate sessions to find matching key hash
    for (const [sessionId, record] of this.sessions) {
      if (verifySessionKey(sessionKey, record.sessionKeyHash)) {
        return sessionId;
      }
    }
    return null;
  }

  /**
   * Request admission as a pending attendee.
   * Returns the pending attendee record or null if the session doesn't exist.
   */
  requestAdmission(
    sessionId: string,
    displayName: string,
    connectionId: string,
  ): PendingAttendee | null {
    const record = this.sessions.get(sessionId);
    if (!record) return null;

    const userId = randomUUID();
    const color = assignColor(userId, this.colorPalette);

    const pending: PendingAttendee = {
      userId,
      displayName,
      color,
      requestedAt: new Date().toISOString(),
      connectionId,
    };

    record.pendingAttendees.set(userId, pending);
    return pending;
  }

  /**
   * Admit a pending attendee. Returns the full QollabAttendee or null if
   * the pending request doesn't exist.
   */
  admitAttendee(sessionId: string, userId: string, masterUserId: string): QollabAttendee | null {
    const record = this.sessions.get(sessionId);
    if (!record) return null;

    // Verify the requester is the master
    if (record.masterUserId !== masterUserId) return null;

    const pending = record.pendingAttendees.get(userId);
    if (!pending) return null;

    record.pendingAttendees.delete(userId);

    return {
      userId: pending.userId,
      displayName: pending.displayName,
      color: pending.color,
      role: "attendee",
      joinedAt: new Date().toISOString(),
      connectionStatus: "online",
    };
  }

  /**
   * Reject a pending attendee.
   */
  rejectAttendee(sessionId: string, userId: string, masterUserId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    if (record.masterUserId !== masterUserId) return false;

    return record.pendingAttendees.delete(userId);
  }

  /**
   * Check if a user is the master of a session.
   */
  isMaster(sessionId: string, userId: string): boolean {
    const record = this.sessions.get(sessionId);
    return record?.masterUserId === userId;
  }

  /**
   * Get the pending attendees for a session.
   */
  getPendingAttendees(sessionId: string): PendingAttendee[] {
    const record = this.sessions.get(sessionId);
    if (!record) return [];
    return Array.from(record.pendingAttendees.values());
  }

  /**
   * Destroy a session (cleanup).
   */
  destroySession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
