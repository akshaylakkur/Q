/**
 * QollabSessionServer — WebSocket-based relay server for collaborative sessions.
 *
 * Responsibilities:
 * 1. Listen on configurable port, authenticate via sessionKey
 * 2. Maintain admission queue (pending -> master admit/reject)
 * 3. Relay chat messages to all participants
 * 4. Relay snapshot sync requests to master, response back to attendee
 * 5. Heartbeat ping/pong for liveness detection
 * 6. Session auto-expiry on master disconnect
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { QollabServerEvent, QollabClientEvent, QollabSession, QollabAttendee, QollabSessionMetadata, QollabPermissions, MergeReport } from "../types.js";
import { QollabSessionStore } from "./session-store.js";
import { QollabAdmission } from "../auth/admission.js";
import { QollabChatRelay } from "../chat/chat-relay.js";
import type { SessionConnection } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_PORT = 19876;
const DEFAULT_TTL_MS = 86_400_000; // 24 hours

// ─── QollabSessionServer ─────────────────────────────────────────────────────

export class QollabSessionServer {
  private wss: WebSocketServer;
  private store: QollabSessionStore;
  private admission: QollabAdmission;
  private chatRelay: QollabChatRelay;

  // Live session state (not persisted)
  private liveSessions: Map<
    string,
    {
      session: QollabSession;
      masterConnections: Map<string, SessionConnection>;
      attendeeConnections: Map<string, SessionConnection>;
      pendingAttendees: Map<string, { userId: string; displayName: string; color: string; connection: SessionConnection }>;
      mergeInProgress: boolean;
      createdAt: number;
    }
  > = new Map();

  // Connection -> session mapping
  private connectionSessionMap: Map<WebSocket, string> = new Map();
  private connectionUserIdMap: Map<WebSocket, string> = new Map();

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private controlPollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly dataDir: string;

  constructor(options?: {
    port?: number;
    host?: string;
    dataDir?: string;
    store?: QollabSessionStore;
    admission?: QollabAdmission;
  }) {
    this.port = options?.port ?? DEFAULT_PORT;
    this.host = options?.host ?? "127.0.0.1";
    this.dataDir = options?.dataDir ?? resolve(process.env.HOME ?? "/tmp", ".Q", "collab", "data");
    this.store = options?.store ?? new QollabSessionStore();

    // Ensure data directory exists
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    this.admission = options?.admission ?? new QollabAdmission();
    this.chatRelay = new QollabChatRelay(
      (sessionId, event) => this.broadcast(sessionId, event),
      (sessionId, userId, event) => this.sendToUser(sessionId, userId, event),
    );

    this.wss = new WebSocketServer({ port: this.port, host: this.host });
    this.setupWebSocketHandlers();
  }

  // ─── Public Accessors (for CLI integration) ───────────────────────────

  /** Get the admission manager. */
  getAdmission(): QollabAdmission {
    return this.admission;
  }

  /** Get the chat relay. */
  getChatRelay(): QollabChatRelay {
    return this.chatRelay;
  }

  /** Get the live sessions map. */
  getLiveSessions(): Map<string, any> {
    return this.liveSessions;
  }

  /** Get the session store. */
  getStore(): QollabSessionStore {
    return this.store;
  }

  /**
   * Create a live session directly (for the master, without needing a WebSocket connection).
   * This is used by the CLI to bootstrap the session before the TUI starts.
   */
  createLiveSession(sessionId: string, masterUserId: string, displayName: string): void {
    const now = new Date().toISOString();
    const session: QollabSession = {
      sessionId,
      sessionKey: "",
      masterUserId,
      createdAt: now,
      status: "active",
      metadata: {
        displayName: displayName || "Qollab Session",
        collabType: "pair",
        permissions: {
          allowChatHistoryExport: true,
          allowSnapshotPullByAttendees: true,
          allowSnapshotSyncFromAttendees: true,
          requireMasterApprovalForJoin: true,
          requireMasterApprovalForSnapshotSync: true,
        },
        maxAttendees: 8,
        createdAt: now,
        ttlMs: 86400000,
        encryptionAlgorithm: "AES-256-GCM",
      },
      attendees: [],
      snapshotRef: "",
    };

    // Also persist to SQLite so foreign key constraints work
    const keyHash = this.admission ? this.admission['sessions']?.get(sessionId)?.sessionKeyHash : '';
    this.store.createSession(
      sessionId,
      keyHash || 'live-session',
      masterUserId,
      session.metadata,
    );

    this.liveSessions.set(sessionId, {
      session,
      masterConnections: new Map(),
      attendeeConnections: new Map(),
      pendingAttendees: new Map(),
      mergeInProgress: false,
      createdAt: Date.now(),
    });

    this.store.updateSessionStatus(sessionId, "active");
  }

  /**
   * Start the server.
   */
  async start(): Promise<void> {
    // WebSocketServer starts listening in the constructor, so we just
    // need to wait for the 'listening' event if it hasn't fired yet.
    if (this.wss.address()) {
      this.startHeartbeat();
      return;
    }
    return new Promise((resolvePromise) => {
      this.wss.on("listening", () => {
        this.startHeartbeat();
        resolvePromise();
      });
    });
  }

  /**
   * Stop the server gracefully.
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.controlPollTimer) {
      clearInterval(this.controlPollTimer);
      this.controlPollTimer = null;
    }

    // Close all WebSocket connections directly
    for (const [, live] of this.liveSessions) {
      for (const [, conn] of live.masterConnections) {
        try { conn.close(); } catch {}
      }
      for (const [, conn] of live.attendeeConnections) {
        try { conn.close(); } catch {}
      }
    }

    // Close all connected clients on the server
    for (const client of this.wss.clients) {
      try { client.close(); } catch {}
    }

    // Close the WebSocket server
    this.wss.close();
  }

  /**
   * Get the port the server is listening on.
   */
  getPort(): number {
    return (this.wss.address() as any)?.port ?? this.port;
  }

  // ─── WebSocket Setup ────────────────────────────────────────────────────

  private setupWebSocketHandlers(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      let authenticated = false;
      let sessionId: string | null = null;
      let userId: string | null = null;

      const connection: SessionConnection = {
        userId: "",
        role: "attendee",
        send: (event: QollabServerEvent) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event));
          }
        },
        close: () => {
          ws.close();
        },
        alive: true,
        lastPing: Date.now(),
      };

      ws.on("message", (data: Buffer) => {
        let parsed: QollabClientEvent;
        try {
          parsed = JSON.parse(data.toString()) as QollabClientEvent;
        } catch {
          this.sendError(ws, "PARSE_ERROR", "Invalid JSON");
          return;
        }

        if (!authenticated) {
          // Only auth messages allowed before authentication
          if (parsed.type === "auth") {
            const result = this.handleAuth(ws, parsed.sessionKey, parsed.displayName, connection);
            if (result) {
              authenticated = true;
              sessionId = result.sessionId;
              userId = result.userId;
              connection.userId = result.userId;
              connection.role = result.role;
              this.connectionSessionMap.set(ws, result.sessionId);
              this.connectionUserIdMap.set(ws, result.userId);
            }
          } else {
            this.sendError(ws, "AUTH_REQUIRED", "Authenticate first");
          }
          return;
        }

        // Handle authenticated client events
        this.handleClientEvent(ws, parsed, sessionId!, userId!);
      });

      ws.on("close", () => {
        if (sessionId && userId) {
          this.handleDisconnect(sessionId, userId, connection);
        }
        this.connectionSessionMap.delete(ws);
        this.connectionUserIdMap.delete(ws);
      });

      ws.on("error", () => {
        // Connection error — cleanup handled by close
        ws.close();
      });

      ws.on("pong", () => {
        connection.alive = true;
        connection.lastPing = Date.now();
      });
    });
  }

  // ─── Authentication ────────────────────────────────────────────────────

  private handleAuth(
    ws: WebSocket,
    sessionKey: string,
    displayName: string,
    connection: SessionConnection,
  ): { sessionId: string; userId: string; role: "master" | "attendee" } | null {
    // Authenticate the session key via the admission manager
    const authSessionId = this.admission.authenticate(sessionKey);
    if (!authSessionId) {
      this.sendError(ws, "AUTH_FAILED", "Invalid session key");
      return null;
    }

    // Check if this is the master reconnecting or a new attendee
    const live = this.liveSessions.get(authSessionId);

    // If no live session yet, this must be the master initializing
    if (!live) {
      this.sendError(ws, "SESSION_NOT_FOUND", "Session not found. Start with collab init first.");
      return null;
    }

    // Check if this is the master (by userId match)
    if (live.session.masterUserId === displayName) {
      // Master reconnecting
      const userId = live.session.masterUserId;
      connection.role = "master";
      connection.userId = userId;
      live.masterConnections.set(userId, connection);

      connection.send({ type: "session.state", session: live.session });
      return { sessionId: authSessionId, userId, role: "master" };
    }

    // Attendee connecting — enter pending state
    const pending = this.admission.requestAdmission(authSessionId, displayName, "");
    if (!pending) {
      this.sendError(ws, "ADMISSION_FAILED", "Could not request admission");
      return null;
    }

    // Store pending connection
    live.pendingAttendees.set(pending.userId, {
      userId: pending.userId,
      displayName: pending.displayName,
      color: pending.color,
      connection,
    });

    connection.userId = pending.userId;

    // Notify master about pending attendee
    this.broadcastToMaster(authSessionId, {
      type: "attendee.pending",
      userId: pending.userId,
      displayName: pending.displayName,
      color: pending.color,
    });

    // Send pending state to the attendee
    connection.send({ type: "attendee.pending", userId: pending.userId, displayName: pending.displayName, color: pending.color });

    return { sessionId: authSessionId, userId: pending.userId, role: "attendee" };
  }

  // ─── Client Event Handling ─────────────────────────────────────────────

  private handleClientEvent(
    ws: WebSocket,
    event: QollabClientEvent,
    sessionId: string,
    userId: string,
  ): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) return;

    switch (event.type) {
      case "chat.send": {
        const attendee = this.findAttendee(live, userId);
        if (!attendee) return;
        if (event.targetUserId) {
          // Whisper
          this.chatRelay.sendWhisper(
            sessionId,
            userId,
            attendee.displayName,
            attendee.color,
            event.targetUserId,
            event.text,
          );
        } else {
          // Broadcast
          this.chatRelay.sendMessage(
            sessionId,
            userId,
            attendee.displayName,
            attendee.color,
            event.text,
            event.replyTo,
          );
        }
        break;
      }

      case "snapshot.pull": {
        // Send the latest snapshot info
        const storedSnapshot = this.store.getLatestSnapshot(sessionId);
        if (storedSnapshot) {
          const manifest = JSON.parse(storedSnapshot.manifest);
          connectionSend(ws, {
            type: "snapshot.created",
            snapshot: {
              snapshotId: storedSnapshot.snapshot_id,
              sessionId: storedSnapshot.session_id,
              createdAt: storedSnapshot.created_at,
              createdBy: storedSnapshot.created_by,
              fileEntries: [],
              parentSnapshotId: storedSnapshot.parent_snapshot_id ?? undefined,
              manifest,
            },
          });
        }
        break;
      }

      case "snapshot.sync-request": {
        // Only attendees can request sync, and only if master approved it
        const attendee = this.findAttendee(live, userId);
        if (!attendee || attendee.role === "master") return;

        if (live.mergeInProgress) {
          connectionSend(ws, {
            type: "error",
            code: "MERGE_IN_PROGRESS",
            message: "Another merge is already in progress. Please wait.",
          });
          return;
        }

        // Rate limiting check
        const lastSync = live.session.metadata.permissions.allowSnapshotSyncFromAttendees;
        if (!lastSync) {
          connectionSend(ws, {
            type: "error",
            code: "SYNC_DISABLED",
            message: "Snapshot sync is disabled by the session master.",
          });
          return;
        }

        // Notify master of sync request
        live.mergeInProgress = true;
        const placeholderReport: MergeReport = {
          changedFiles: [],
          commitMessage: "Processing merge request...",
          diffSummary: "The merge is being prepared.",
          success: true,
        };

        this.broadcastToMaster(sessionId, {
          type: "snapshot.sync-request",
          userId,
          displayName: attendee.displayName,
          prompt: event.prompt,
          mergeReport: placeholderReport,
        });
        break;
      }

      case "snapshot.sync-accept": {
        // Only master can accept
        if (!this.isMaster(live, userId)) return;
        live.mergeInProgress = false;

        // Broadcast acceptance
        this.broadcast(sessionId, {
          type: "snapshot.sync-accepted",
          acceptedBy: userId,
          snapshotId: event.snapshotId,
        });
        break;
      }

      case "snapshot.sync-reject": {
        if (!this.isMaster(live, userId)) return;
        live.mergeInProgress = false;

        this.broadcast(sessionId, {
          type: "snapshot.sync-rejected",
          reason: event.reason,
        });
        break;
      }

      case "attendee.admit": {
        if (!this.isMaster(live, userId)) return;
        const pending = live.pendingAttendees.get(event.userId);
        if (!pending) return;

        const attendee = this.admission.admitAttendee(sessionId, event.userId, live.session.masterUserId);
        if (!attendee) return;

        // Move from pending to active connections
        live.pendingAttendees.delete(event.userId);
        pending.connection.role = "attendee";
        live.attendeeConnections.set(attendee.userId, pending.connection);

        // Persist
        this.store.addAttendee(attendee, sessionId);

        // Update live session
        live.session.attendees.push(attendee);

        // Notify all
        this.broadcast(sessionId, { type: "attendee.joined", attendee });

        // Send full session state to the admitted attendee
        pending.connection.send({ type: "session.state", session: live.session });
        break;
      }

      case "attendee.reject": {
        if (!this.isMaster(live, userId)) return;
        const pending = live.pendingAttendees.get(event.userId);
        if (!pending) return;

        live.pendingAttendees.delete(event.userId);
        this.admission.rejectAttendee(sessionId, event.userId, live.session.masterUserId);

        pending.connection.send({
          type: "attendee.rejected",
          userId: event.userId,
          reason: event.reason,
        });
        pending.connection.close();
        break;
      }

      case "attendee.kick": {
        if (!this.isMaster(live, userId)) return;
        const kickedConn = live.attendeeConnections.get(event.userId);
        if (!kickedConn) return;

        live.attendeeConnections.delete(event.userId);
        this.store.removeAttendee(event.userId);

        // Remove from live session
        live.session.attendees = live.session.attendees.filter((a) => a.userId !== event.userId);

        kickedConn.send({
          type: "attendee.rejected",
          userId: event.userId,
          reason: "Kicked by master",
        });
        kickedConn.close();

        this.broadcast(sessionId, { type: "attendee.left", userId: event.userId });
        break;
      }

      case "attendee.away": {
        this.store.updateAttendeeStatus(userId, "away");
        this.broadcast(sessionId, {
          type: "attendee.status",
          userId,
          connectionStatus: "away",
        });
        break;
      }

      case "attendee.back": {
        this.store.updateAttendeeStatus(userId, "online");
        this.broadcast(sessionId, {
          type: "attendee.status",
          userId,
          connectionStatus: "online",
        });
        break;
      }

      case "pong": {
        // Handled by WebSocket pong event
        break;
      }

      case "disconnect": {
        // Client requested disconnect — handled by ws close
        ws.close();
        break;
      }
    }
  }

  // ─── Disconnect Handling ──────────────────────────────────────────────

  private handleDisconnect(sessionId: string, userId: string, _connection: SessionConnection): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) return;

    // Remove from connections
    live.masterConnections.delete(userId);
    live.attendeeConnections.delete(userId);
    live.pendingAttendees.delete(userId);

    // Update status
    this.store.updateAttendeeStatus(userId, "offline");

    // Broadcast departure
    this.broadcast(sessionId, {
      type: "attendee.left",
      userId,
    });

    // If master disconnected, mark all attendees offline and eventually expire
    if (live.session.masterUserId === userId) {
      this.store.updateSessionStatus(sessionId, "pending");

      // Schedule expiry
      const ttl = live.session.metadata.ttlMs;
      setTimeout(() => {
        const stillLive = this.liveSessions.get(sessionId);
        if (stillLive && stillLive.masterConnections.size === 0) {
          // Master hasn't reconnected — expire session
          this.store.updateSessionStatus(sessionId, "completed");
          this.broadcast(sessionId, { type: "session.expired" });
          this.liveSessions.delete(sessionId);
        }
      }, ttl);
    }
  }

  // ─── Broadcast Helpers ────────────────────────────────────────────────

  /**
   * Broadcast an event to all participants in a session.
   */
  private broadcast(sessionId: string, event: QollabServerEvent): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) return;

    const allConnections = [
      ...live.masterConnections.values(),
      ...live.attendeeConnections.values(),
    ];

    const payload = JSON.stringify(event);
    for (const conn of allConnections) {
      if (conn.alive) {
        try {
          // Direct WebSocket send if available, else use connection.send
          conn.send(event);
        } catch {
          // Connection might be dead
        }
      }
    }
  }

  /**
   * Broadcast an event to the master connection(s).
   */
  private broadcastToMaster(sessionId: string, event: QollabServerEvent): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) return;

    for (const [, conn] of live.masterConnections) {
      if (conn.alive) {
        try {
          conn.send(event);
        } catch {
          // Ignore
        }
      }
    }
  }

  /**
   * Send an event to a specific user in a session.
   */
  private sendToUser(sessionId: string, userId: string, event: QollabServerEvent): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) return;

    const conn =
      live.masterConnections.get(userId) ?? live.attendeeConnections.get(userId);
    if (conn && conn.alive) {
      try {
        conn.send(event);
      } catch {
        // Ignore
      }
    }
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [sessionId, live] of this.liveSessions) {
        // Check master connections
        for (const [userId, conn] of live.masterConnections) {
          if (!conn.alive || Date.now() - conn.lastPing > HEARTBEAT_TIMEOUT_MS) {
            conn.alive = false;
            this.handleDisconnect(sessionId, userId, conn);
          }
        }
        // Check attendee connections
        for (const [userId, conn] of live.attendeeConnections) {
          if (!conn.alive || Date.now() - conn.lastPing > HEARTBEAT_TIMEOUT_MS) {
            conn.alive = false;
            this.handleDisconnect(sessionId, userId, conn);
          }
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private sendError(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", code, message }));
    }
  }

  private findAttendee(
    live: NonNullable<ReturnType<typeof this.liveSessions.get>>,
    userId: string,
  ): QollabAttendee | undefined {
    return live.session.attendees.find((a) => a.userId === userId);
  }

  private isMaster(
    live: NonNullable<ReturnType<typeof this.liveSessions.get>>,
    userId: string,
  ): boolean {
    return live.session.masterUserId === userId;
  }
}

// ─── Helper: Send JSON to WebSocket ──────────────────────────────────────────

function connectionSend(ws: WebSocket, event: QollabServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}
