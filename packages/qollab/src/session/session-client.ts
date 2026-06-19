/**
 * QollabSessionClient — WebSocket client for connecting to a Qollab session.
 *
 * Used by both master and attendees to:
 * - Authenticate with session key
 * - Send and receive chat messages
 * - Pull snapshots
 * - Request/approve snapshot syncs
 * - Manage attendee admission (master only)
 */

import WebSocket from "ws";
import type { QollabServerEvent, QollabClientEvent, QollabSession } from "../types.js";

// ─── QollabSessionClient ────────────────────────────────────────────────────

export class QollabSessionClient {
  private ws: WebSocket | null = null;
  private readonly serverUrl: string;
  private readonly sessionKey: string;
  private readonly displayName: string;
  private readonly userId?: string;
  private connected = false;
  private authenticated = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelayMs = 2000;
  private onEventCallback: (event: QollabServerEvent) => void;
  private onDisconnectCallback?: () => void;
  private onErrorCallback?: (err: Error) => void;
  private intentionalClose = false;
  /** Buffer for events that arrive before a callback is properly set */
  private eventBuffer: QollabServerEvent[] = [];

  constructor(options: {
    serverUrl: string;
    sessionKey: string;
    displayName: string;
    userId?: string;
    onEvent: (event: QollabServerEvent) => void;
    onDisconnect?: () => void;
    onError?: (err: Error) => void;
  }) {
    this.serverUrl = options.serverUrl;
    this.sessionKey = options.sessionKey;
    this.displayName = options.displayName;
    this.userId = options.userId;
    this.onEventCallback = options.onEvent;
    this.onDisconnectCallback = options.onDisconnect;
    this.onErrorCallback = options.onError;
  }

  /**
   * Connect to the Qollab session server.
   * Returns a promise that resolves once authenticated.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.serverUrl);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.on("open", () => {
        this.connected = true;
        this.reconnectAttempts = 0;

        // Send authentication — include userId if we have one (master)
        const authMsg: Record<string, string> = {
          type: "auth",
          sessionKey: this.sessionKey,
          displayName: this.displayName,
        };
        if (this.userId) {
          authMsg.userId = this.userId;
        }
        this.send(authMsg as QollabClientEvent);
      });

      this.ws.on("message", (data: Buffer) => {
        let event: QollabServerEvent;
        try {
          event = JSON.parse(data.toString()) as QollabServerEvent;
        } catch {
          this.onErrorCallback?.(new Error("Failed to parse server event"));
          return;
        }

        // Handle auth response
        if (event.type === "session.state") {
          this.authenticated = true;
          // Buffer the session.state event so the TUI callback receives it
          this.eventBuffer.push(event);
          resolve();
          this.flushBuffer();
          return;
        }

        // Handle pending state (attendee authenticated but not yet admitted)
        if (event.type === "attendee.pending") {
          this.authenticated = true;
          this.eventBuffer.push(event);
          resolve();
          this.flushBuffer();
          return;
        }

        // Handle rejection
        if (event.type === "attendee.rejected") {
          this.intentionalClose = true;
          this.ws?.close();
          reject(new Error(`Admission rejected: ${event.reason ?? "No reason"}`));
          return;
        }

        if (event.type === "error" && event.code === "AUTH_FAILED") {
          reject(new Error(`Authentication failed: ${event.message}`));
          return;
        }

        if (event.type === "error" && event.code === "SESSION_EXPIRED") {
          reject(new Error(`Session expired: ${event.message}`));
          return;
        }

        // Forward to callback (buffer if not yet flushed)
        this.eventBuffer.push(event);
        this.flushBuffer();
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.authenticated = false;
        this.onDisconnectCallback?.();

        if (!this.intentionalClose && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => {
            this.connect().catch((err) => {
              this.onErrorCallback?.(err);
            });
          }, this.reconnectDelayMs * this.reconnectAttempts);
        }
      });

      this.ws.on("error", (err) => {
        this.onErrorCallback?.(err);
        if (!this.authenticated) {
          reject(err);
        }
      });

      // Connection timeout
      setTimeout(() => {
        if (!this.authenticated && !this.intentionalClose) {
          this.ws?.close();
          reject(new Error("Connection timeout"));
        }
      }, 10000);
    });
  }

  /**
   * Disconnect from the session.
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.send({ type: "disconnect" });
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
  }

  /**
   * Send a chat message.
   */
  sendChat(text: string, replyTo?: string): void {
    this.send({ type: "chat.send", text, replyTo });
  }

  /**
   * Send a whisper message to a specific user.
   */
  sendWhisper(targetUserId: string, text: string): void {
    this.send({ type: "chat.send", text, targetUserId });
  }

  /**
   * Request to pull the latest snapshot.
   */
  requestSnapshotPull(): void {
    this.send({ type: "snapshot.pull" });
  }

  /**
   * Request a snapshot sync (attendee -> master).
   */
  requestSnapshotSync(prompt: string): void {
    this.send({ type: "snapshot.sync-request", prompt });
  }

  /**
   * Accept a proposed snapshot (master only).
   */
  acceptSnapshot(snapshotId: string): void {
    this.send({ type: "snapshot.sync-accept", snapshotId });
  }

  /**
   * Reject a proposed snapshot (master only).
   */
  rejectSnapshot(reason: string): void {
    this.send({ type: "snapshot.sync-reject", reason });
  }

  /**
   * Admit a pending attendee (master only).
   */
  admitAttendee(userId: string): void {
    this.send({ type: "attendee.admit", userId });
  }

  /**
   * Reject a pending attendee (master only).
   */
  rejectAttendee(userId: string, reason?: string): void {
    this.send({ type: "attendee.reject", userId, reason });
  }

  /**
   * Kick an attendee from the session (master only).
   */
  kickAttendee(userId: string): void {
    this.send({ type: "attendee.kick", userId });
  }

  /**
   * Mark self as away.
   */
  markAway(): void {
    this.send({ type: "attendee.away" });
  }

  /**
   * Mark self as back.
   */
  markBack(): void {
    this.send({ type: "attendee.back" });
  }

  /**
   * Set the event callback (used by the TUI to wire in its handler after construction).
   * Flushes any buffered events to the new callback.
   */
  setEventCallback(callback: (event: QollabServerEvent) => void): void {
    this.onEventCallback = callback;
    this.flushBuffer();
  }

  /**
   * Check if currently connected.
   */
  isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  /**
   * Send a raw client event.
   */
  private send(event: QollabClientEvent): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  /**
   * Flush buffered events to the current callback.
   */
  private flushBuffer(): void {
    if (this.eventBuffer.length === 0) return;
    const buffer = this.eventBuffer.splice(0);
    for (const event of buffer) {
      this.onEventCallback(event);
    }
  }
}
