/**
 * Qollab — Secure real-time agentic collaboration for Qode.
 *
 * This package provides:
 * - Session management (WebSocket-based relay server + client)
 * - Secure admission and encryption (AES-256-GCM)
 * - Snapshot system (project state capture, diff, merge)
 * - Read-only remote file reference system
 * - Agentic merge engine for collaborative code changes
 */

export * from "./types.js";

// Session
export * from "./session/index.js";

// Auth
export * from "./auth/index.js";

// Chat
export * from "./chat/index.js";

// Snapshot
export * from "./snapshot/index.js";
