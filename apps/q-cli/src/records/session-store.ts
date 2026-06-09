/**
 * SessionStore — Manages session indexing.
 *
 * Sessions are stored in $HOME/.Q/sessions/ with metadata in index.json.
 * Provides create, list, fork, get, delete operations.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionMeta, SessionConfig, SessionIndex } from "./types.js";
import { CURRENT_WIRE_VERSION } from "./types.js";
import { FileSystemAgentRecordPersistence } from "./persistence.js";
import { readRecords } from "./wire.js";
import { BlobStore } from "./blob-store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEX_VERSION = 1;

/** Get the sessions base directory. */
export function getSessionsBase(): string {
  return resolve(process.env.HOME ?? "/tmp", ".Q", "sessions");
}

function getIndexPath(): string {
  return resolve(getSessionsBase(), "index.json");
}

function getSessionDir(sessionId: string): string {
  return resolve(getSessionsBase(), sessionId);
}

// ---------------------------------------------------------------------------
// Index I/O
// ---------------------------------------------------------------------------

function readIndex(): SessionIndex {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) {
    return { version: INDEX_VERSION, sessions: {} };
  }
  try {
    const raw = readFileSync(indexPath, "utf-8");
    return JSON.parse(raw) as SessionIndex;
  } catch {
    return { version: INDEX_VERSION, sessions: {} };
  }
}

function writeIndex(index: SessionIndex): void {
  const indexPath = getIndexPath();
  const dir = resolve(indexPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = indexPath + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(index, null, 2), "utf-8");
  renameSync(tmp, indexPath);
}

// ---------------------------------------------------------------------------
// Helper: compute size bytes for a session
// ---------------------------------------------------------------------------

function computeSessionSize(sessionDir: string): number {
  let total = 0;
  const wirePath = join(sessionDir, "wire.jsonl");
  if (existsSync(wirePath)) {
    total += readFileSync(wirePath).byteLength;
  }
  const blobsDir = join(sessionDir, "blobs");
  if (existsSync(blobsDir)) {
    try {
      const entries = readdirSync(blobsDir);
      for (const entry of entries) {
        const st = statSync(join(blobsDir, entry));
        total += st.size;
      }
    } catch {
      // Ignore if blobs dir can't be read
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  /**
   * Create a new session.
   * Returns the session ID and persistence instance.
   */
  async create(config: SessionConfig): Promise<{
    sessionId: string;
    persistence: FileSystemAgentRecordPersistence;
  }> {
    const sessionId = randomUUID();
    const sessionDir = getSessionDir(sessionId);

    // Ensure session directory exists
    mkdirSync(sessionDir, { recursive: true });

    const persistence = new FileSystemAgentRecordPersistence({
      sessionId,
      sessionDir,
    });

    await persistence.initialize();

    // Write metadata record
    const now = new Date().toISOString();
    await persistence.setMetadata({
      type: "metadata",
      timestamp: now,
      protocolVersion: CURRENT_WIRE_VERSION,
      createdAt: now,
      model: config.model,
      sessionName: config.name,
    });

    // Register in index
    const index = readIndex();
    const meta: SessionMeta = {
      id: sessionId,
      name: config.name,
      createdAt: now,
      updatedAt: now,
      workspaceDirectory: config.workspaceDirectory,
      model: config.model,
      protocolVersion: CURRENT_WIRE_VERSION,
      recordCount: 1,
      blobCount: 0,
      sizeBytes: 0, // Will be updated lazily
    };
    index.sessions[sessionId] = meta;
    writeIndex(index);

    return { sessionId, persistence };
  }

  /**
   * List sessions, optionally filtered by workspace directory.
   */
  list(filter?: { workspaceDirectory?: string }): SessionMeta[] {
    const index = readIndex();
    let sessions = Object.values(index.sessions);

    if (filter?.workspaceDirectory) {
      const wd = resolve(filter.workspaceDirectory);
      sessions = sessions.filter((s) => s.workspaceDirectory && resolve(s.workspaceDirectory) === wd);
    }

    // Sort by updatedAt descending
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return sessions;
  }

  /**
   * Get a session by ID.
   */
  get(sessionId: string): SessionMeta | null {
    const index = readIndex();
    return index.sessions[sessionId] ?? null;
  }

  /**
   * Delete a session, removing its directory and index entry.
   */
  async delete(sessionId: string): Promise<void> {
    const sessionDir = getSessionDir(sessionId);

    // Remove from index first
    const index = readIndex();
    delete index.sessions[sessionId];
    writeIndex(index);

    // Remove directory
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }

  /**
   * Fork (clone) a session.
   * Creates a new session with the same config but a fresh wire file.
   * Copies the workspaceDirectory and model from the source.
   */
  async fork(sessionId: string, newName?: string): Promise<{
    sessionId: string;
    persistence: FileSystemAgentRecordPersistence;
  }> {
    const sourceMeta = this.get(sessionId);
    if (!sourceMeta) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return this.create({
      name: newName ?? `${sourceMeta.name} (fork)`,
      workspaceDirectory: sourceMeta.workspaceDirectory,
      model: sourceMeta.model,
    });
  }

  /**
   * Refresh session metadata (update recordCount, blobCount, sizeBytes, updatedAt).
   */
  async refresh(sessionId: string): Promise<void> {
    const index = readIndex();
    const meta = index.sessions[sessionId];
    if (!meta) return;

    const sessionDir = getSessionDir(sessionId);
    const wirePath = join(sessionDir, "wire.jsonl");

    if (existsSync(wirePath)) {
      const records = await readRecords(wirePath);
      meta.recordCount = records.length;
    } else {
      meta.recordCount = 0;
    }

    const blobsDir = join(sessionDir, "blobs");
    if (existsSync(blobsDir)) {
      try {
        meta.blobCount = readdirSync(blobsDir).length;
      } catch {
        meta.blobCount = 0;
      }
    } else {
      meta.blobCount = 0;
    }

    meta.sizeBytes = computeSessionSize(sessionDir);
    meta.updatedAt = new Date().toISOString();

    writeIndex(index);
  }

  /**
   * Resolve session metadata from an existing session directory.
   * Used for import/restore.
   */
  async register(sessionId: string, meta: SessionMeta): Promise<void> {
    const index = readIndex();
    index.sessions[sessionId] = meta;
    writeIndex(index);
  }
}