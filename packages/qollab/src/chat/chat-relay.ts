/**
 * QollabChatRelay — Broadcasts chat messages to all session participants.
 *
 * Handles:
 * - Message broadcast (all participants)
 * - Whisper messages (targeted to one participant)
 * - System messages
 * - History management (rolling buffer)
 */

import { randomUUID } from "node:crypto";
import type { QollabChatMessage, QollabServerEvent } from "../types.js";
import type { ChatConfig } from "./types.js";

// ─── QollabChatRelay ───────────────────────────────────────────────────────

export class QollabChatRelay {
  private history: Map<string, QollabChatMessage[]> = new Map(); // sessionId -> messages
  private broadcastFn: (sessionId: string, event: QollabServerEvent) => void;
  private whisperFn: (sessionId: string, userId: string, event: QollabServerEvent) => void;
  private readonly config: ChatConfig;

  constructor(
    broadcastFn: (sessionId: string, event: QollabServerEvent) => void,
    whisperFn: (sessionId: string, userId: string, event: QollabServerEvent) => void,
    config?: Partial<ChatConfig>,
  ) {
    this.broadcastFn = broadcastFn;
    this.whisperFn = whisperFn;
    this.config = {
      historyLimit: config?.historyLimit ?? 10000,
      colorPalette: config?.colorPalette ?? ["#22D3EE", "#A78BFA", "#FBBF24", "#4ADE80", "#FB7185", "#38BDF8"],
    };
  }

  /**
   * Send a chat message to all participants in a session.
   */
  sendMessage(
    sessionId: string,
    userId: string,
    displayName: string,
    color: string,
    text: string,
    replyTo?: string,
  ): QollabChatMessage {
    const message: QollabChatMessage = {
      messageId: randomUUID(),
      userId,
      displayName,
      color,
      text,
      timestamp: new Date().toISOString(),
      type: "text",
      replyTo,
    };

    this.appendToHistory(sessionId, message);
    this.broadcastFn(sessionId, { type: "chat.message", message });
    return message;
  }

  /**
   * Send a system message to all participants.
   */
  sendSystemMessage(sessionId: string, text: string): QollabChatMessage {
    const message: QollabChatMessage = {
      messageId: randomUUID(),
      userId: "system",
      displayName: "System",
      color: "#64748B",
      text,
      timestamp: new Date().toISOString(),
      type: "system",
    };

    this.appendToHistory(sessionId, message);
    this.broadcastFn(sessionId, { type: "chat.message", message });
    return message;
  }

  /**
   * Send a whisper message to a specific user.
   */
  sendWhisper(
    sessionId: string,
    fromUserId: string,
    fromDisplayName: string,
    fromColor: string,
    targetUserId: string,
    text: string,
  ): QollabChatMessage {
    const message: QollabChatMessage = {
      messageId: randomUUID(),
      userId: fromUserId,
      displayName: fromDisplayName,
      color: fromColor,
      text,
      timestamp: new Date().toISOString(),
      type: "whisper",
      targetUserId,
    };

    // Only send to sender and target
    this.whisperFn(sessionId, fromUserId, { type: "chat.message", message });
    this.whisperFn(sessionId, targetUserId, { type: "chat.message", message });

    // Also store in history (both sides)
    this.appendToHistory(sessionId, message);
    return message;
  }

  /**
   * Get chat history for a session.
   */
  getHistory(sessionId: string, limit?: number): QollabChatMessage[] {
    const messages = this.history.get(sessionId) ?? [];
    const count = limit ?? this.config.historyLimit;
    return messages.slice(-count);
  }

  /**
   * Clear history for a session.
   */
  clearHistory(sessionId: string): void {
    this.history.delete(sessionId);
  }

  /**
   * Append a message to the rolling history buffer.
   */
  private appendToHistory(sessionId: string, message: QollabChatMessage): void {
    let messages = this.history.get(sessionId);
    if (!messages) {
      messages = [];
      this.history.set(sessionId, messages);
    }
    messages.push(message);

    // Trim to history limit
    if (messages.length > this.config.historyLimit) {
      this.history.set(sessionId, messages.slice(-this.config.historyLimit));
    }
  }
}
