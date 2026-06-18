/**
 * q-remote log-store — append-only NDJSON event log.
 *
 * The remote daemon writes every event envelope as a single NDJSON line to
 * `<workspace>/.q-remote/events.log`. This provides:
 *   - Live streaming (the local client `tail -f`s this file via SSH).
 *   - Crash recovery (the log survives daemon restarts).
 *   - Resume replay (the local client can request events from a given seq).
 *
 * The log format is one JSON object per line, terminated by `\n`. The `seq`
 * field in each line is the source of truth for ordering.
 */

import { openSync, readFileSync, closeSync, statSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NdjsonEnvelope, serializeEnvelope } from "@qode-agent/protocol";

// Note: we import the type only; the runtime function is used via dynamic import
// to avoid pulling the protocol package into the bundle at module-eval time.

// ─── LogStore ───────────────────────────────────────────────────────────────

export class LogStore {
  readonly logPath: string;
  private fd: number | null = null;
  private highSeq = 0;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  /**
   * Open the log file for appending. Creates it if missing.
   * Scans the existing file to initialize `highSeq`.
   */
  open(): void {
    if (this.fd !== null) return;
    // Ensure the file exists
    if (!existsSync(this.logPath)) {
      writeFileSync(this.logPath, "", "utf-8");
    }
    // Recover the high-water seq by reading existing content
    this.highSeq = this.scanHighSeq();
    // Open for appending (write-only, append mode, create if missing)
    this.fd = openSync(this.logPath, "a");
  }

  /**
   * Append a single envelope line. Returns the seq used.
   */
  append(env: NdjsonEnvelope): void {
    if (this.fd === null) throw new Error("LogStore not open");
    const line = JSON.stringify(env) + "\n";
    // Use a synchronous blocking write so we never lose events to buffering.
    const buf = Buffer.from(line, "utf-8");
    // We write directly via the fd using fs.appendFileSync equivalent.
    // Since we opened with "a", writes append atomically.
    writeSyncFd(this.fd, buf);
    if (env.seq > this.highSeq) this.highSeq = env.seq;
  }

  /**
   * Read all events with seq >= fromSeq, in order.
   */
  read(fromSeq: number): NdjsonEnvelope[] {
    if (!existsSync(this.logPath)) return [];
    const content = readFileSync(this.logPath, "utf-8");
    const lines = content.split("\n");
    const result: NdjsonEnvelope[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const env = JSON.parse(trimmed) as NdjsonEnvelope;
        if (env.seq >= fromSeq) result.push(env);
      } catch {
        // Skip malformed lines (e.g. partial writes on crash).
      }
    }
    return result;
  }

  /**
   * Get the current high-water seq.
   */
  lastSeq(): number {
    return this.highSeq;
  }

  /**
   * Close the log file.
   */
  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  /**
   * Get the file size in bytes.
   */
  sizeBytes(): number {
    if (!existsSync(this.logPath)) return 0;
    return statSync(this.logPath).size;
  }

  private scanHighSeq(): number {
    if (!existsSync(this.logPath)) return 0;
    const content = readFileSync(this.logPath, "utf-8");
    const lines = content.split("\n");
    let max = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const env = JSON.parse(trimmed) as NdjsonEnvelope;
        if (typeof env.seq === "number" && env.seq > max) max = env.seq;
      } catch {
        // ignore
      }
    }
    return max;
  }
}

// ─── writeSync helper ──────────────────────────────────────────────────────

import { writeSync } from "node:fs";

function writeSyncFd(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const written = writeSync(fd, buf, offset);
    offset += written;
  }
}

// Re-export the serialize function for callers who want it.
export { serializeEnvelope };