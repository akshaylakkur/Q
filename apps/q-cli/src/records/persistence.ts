/**
 * FileSystemAgentRecordPersistence — Append records to JSONL with batched
 * async flush using a 100 ms debounce.  On schema version mismatch the
 * entire file is rewritten after migration.
 */

import { resolve } from "node:path";
import { appendRecords, readRecords, rewriteRecords } from "./wire.js";
import { BlobStore } from "./blob-store.js";
import { migrateWireFile, resolveProtocolVersion, getLatestVersion } from "./migration.js";
import type { SessionRecord, MetadataRecord } from "./types.js";
import { CURRENT_WIRE_VERSION } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the metadata record in a list of records.
 */
function findMetadata(records: SessionRecord[]): MetadataRecord | null {
  for (const r of records) {
    if (r.type === "metadata") return r as MetadataRecord;
  }
  return null;
}

// ---------------------------------------------------------------------------
// FileSystemAgentRecordPersistence
// ---------------------------------------------------------------------------

export interface PersistenceOptions {
  /** Session ID */
  sessionId: string;
  /** Base directory for the session (parent of wire.jsonl and blobs/) */
  sessionDir: string;
  /** Wire file path (defaults to <sessionDir>/wire.jsonl) */
  wirePath?: string;
  /** Blobs directory (defaults to <sessionDir>/blobs) */
  blobsDir?: string;
  /** Debounce wait in ms (default 100) */
  debounceMs?: number;
}

/**
 * FileSystemAgentRecordPersistence — manages the JSONL wire file for a single session.
 *
 * Features:
 * - Batched append with async flush (100ms debounce)
 * - Schema migration on session resume
 * - Crash recovery (trailing truncated lines discarded)
 * - BlobStore integration for large payloads
 */
export class FileSystemAgentRecordPersistence {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly wirePath: string;
  readonly blobsDir: string;
  readonly blobStore: BlobStore;

  private buffer: SessionRecord[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private debounceMs: number;
  private _closed = false;
  private protocolVersion: number;

  constructor(options: PersistenceOptions) {
    this.sessionId = options.sessionId;
    this.sessionDir = options.sessionDir;
    this.wirePath = options.wirePath ?? resolve(this.sessionDir, "wire.jsonl");
    this.blobsDir = options.blobsDir ?? resolve(this.sessionDir, "blobs");
    this.debounceMs = options.debounceMs ?? 100;
    this.protocolVersion = CURRENT_WIRE_VERSION;
    this.blobStore = new BlobStore(this.blobsDir);
  }

  /**
   * Initialize or resume a session.
   * On resume, runs schema migration if needed.
   */
  async initialize(): Promise<void> {
    this.blobStore.initialize();

    const result = await migrateWireFile(this.wirePath);
    if (result.didMigrate) {
      this.protocolVersion = result.targetVersion;
    } else if (result.recordCount > 0) {
      // Read protocol version from existing records
      const records = await readRecords(this.wirePath);
      const meta = findMetadata(records);
      if (meta) {
        this.protocolVersion = meta.protocolVersion;
      }
    }
  }

  /**
   * Append a single record (batched, debounced).
   */
  append(record: SessionRecord): void {
    if (this._closed) throw new Error("Persistence is closed");

    this.buffer.push(record);
    this.scheduleFlush();
  }

  /**
   * Append multiple records at once (batched, debounced).
   */
  appendBatch(records: SessionRecord[]): void {
    if (this._closed) throw new Error("Persistence is closed");
    if (records.length === 0) return;

    this.buffer.push(...records);
    this.scheduleFlush();
  }

  /**
   * Get protocol version.
   */
  getProtocolVersion(): number {
    return this.protocolVersion;
  }

  /**
   * Schedule a debounced flush.
   */
  private scheduleFlush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    if (!this.flushing) {
      this.debounceTimer = setTimeout(() => {
        this.flush().catch(() => {
          // Flush errors are silently caught; caller can use flushSync
        });
      }, this.debounceMs);
    }
  }

  /**
   * Flush the buffer to disk (async).
   */
  async flush(): Promise<void> {
    if (this._closed) return;

    this.flushing = true;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const batch = this.buffer.splice(0, this.buffer.length);
    if (batch.length === 0) {
      this.flushing = false;
      return;
    }

    try {
      appendRecords(this.wirePath, batch);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Flush the buffer synchronously.
   * Useful before shutdown or when sync guarantees are needed.
   */
  flushSync(): void {
    if (this._closed) return;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const batch = this.buffer.splice(0, this.buffer.length);
    if (batch.length > 0) {
      appendRecords(this.wirePath, batch);
    }
  }

  /**
   * Read all records from the wire file.
   * Includes buffered (not-yet-flushed) records at the end.
   */
  async readAll(): Promise<SessionRecord[]> {
    const records = await readRecords(this.wirePath);
    // Include buffered records
    if (this.buffer.length > 0) {
      records.push(...this.buffer);
    }
    return records;
  }

  /**
   * Rewrite the wire file with a new set of records.
   * Flushes buffered records first.
   */
  rewrite(records: SessionRecord[]): void {
    this.flushSync();
    rewriteRecords(this.wirePath, records);
  }

  /**
   * Close the persistence, flushing any buffered records.
   */
  close(): void {
    if (this._closed) return;
    this._closed = true;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const batch = this.buffer.splice(0, this.buffer.length);
    if (batch.length > 0) {
      appendRecords(this.wirePath, batch);
    }
  }

  /**
   * Set the metadata record in the wire file.
   * If a metadata record already exists, replaces it in-place.
   * Otherwise prepends it.
   */
  async setMetadata(record: MetadataRecord): Promise<void> {
    const existing = await readRecords(this.wirePath);

    // Find and replace or prepend
    const metaIndex = existing.findIndex((r) => r.type === "metadata");
    if (metaIndex >= 0) {
      existing[metaIndex] = record;
    } else {
      existing.unshift(record);
    }

    rewriteRecords(this.wirePath, existing);
    this.protocolVersion = record.protocolVersion;
  }
}