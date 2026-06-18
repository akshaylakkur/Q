/**
 * Chat-specific types for the Qollab chat relay.
 */

import type { QollabChatMessage } from "../types.js";

// ── Chat configuration ────────────────────────────────────────

export interface ChatConfig {
  historyLimit: number;
  colorPalette: string[];
}

// ── Chat relay events ─────────────────────────────────────────

export interface ChatRelayEvent {
  type: "message" | "system" | "whisper";
  message: QollabChatMessage;
  targetUserId?: string;
}

// ── Chat history ──────────────────────────────────────────────

export interface ChatHistoryEntry {
  message: QollabChatMessage;
  sessionId: string;
}
