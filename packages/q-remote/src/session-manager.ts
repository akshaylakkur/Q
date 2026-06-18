/**
 * q-remote session-manager — tracks per-session state on the remote.
 *
 * Each session gets a directory `<workspace>/.q-remote/sessions/<sessionId>/`
 * containing:
 *   - state.json  — mode, status, prompt history, timestamps
 *   - prompts.jsonl — every prompt received (for audit)
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { hostname, userInfo } from "node:os";

export type SessionStatus = "starting" | "running" | "idle" | "completed" | "failed";

export interface SessionState {
  sessionId: string;
  workspace: string;
  mode: string;
  status: SessionStatus;
  startedAt: string;
  lastActivityAt: string;
  promptCount: number;
  pid: number;
  host: string;
  user: string;
}

export class SessionManager {
  readonly baseDir: string;

  constructor(workspace: string) {
    this.baseDir = resolve(workspace, ".q-remote", "sessions");
    mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * Create or load a session.
   */
  initSession(sessionId: string, workspace: string, mode: string, pid: number): SessionState {
    const sessionDir = resolve(this.baseDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const statePath = resolve(sessionDir, "state.json");

    const now = new Date().toISOString();
    const state: SessionState = {
      sessionId,
      workspace,
      mode,
      status: "starting",
      startedAt: now,
      lastActivityAt: now,
      promptCount: 0,
      pid,
      host: hostname(),
      user: (() => {
        try {
          return userInfo().username;
        } catch {
          return "unknown";
        }
      })(),
    };

    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    return state;
  }

  /**
   * Load a session state.
   */
  getSession(sessionId: string): SessionState | null {
    const statePath = resolve(this.baseDir, sessionId, "state.json");
    if (!existsSync(statePath)) return null;
    try {
      return JSON.parse(readFileSync(statePath, "utf-8")) as SessionState;
    } catch {
      return null;
    }
  }

  /**
   * Update a session's status.
   */
  updateStatus(sessionId: string, status: SessionStatus): void {
    const state = this.getSession(sessionId);
    if (!state) return;
    state.status = status;
    state.lastActivityAt = new Date().toISOString();
    const statePath = resolve(this.baseDir, sessionId, "state.json");
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  /**
   * Record a prompt received from the client.
   */
  recordPrompt(sessionId: string, text: string, mode: string): void {
    const state = this.getSession(sessionId);
    if (!state) return;
    state.promptCount++;
    state.lastActivityAt = new Date().toISOString();
    const statePath = resolve(this.baseDir, sessionId, "state.json");
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    // Append to prompts log
    const promptsPath = resolve(this.baseDir, sessionId, "prompts.jsonl");
    appendFileSync(promptsPath, JSON.stringify({ ts: new Date().toISOString(), mode, text }) + "\n", "utf-8");
  }

  /**
   * List all known sessions.
   */
  listSessions(): SessionState[] {
    const result: SessionState[] = [];
    if (!existsSync(this.baseDir)) return result;
    for (const dir of readdirSync(this.baseDir)) {
      const state = this.getSession(dir);
      if (state) result.push(state);
    }
    return result;
  }
}