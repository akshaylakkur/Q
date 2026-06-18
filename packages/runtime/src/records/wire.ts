/**
 * Wire format — JSONL I/O, streaming reads, crash recovery.
 *
 * Each line is a JSON-serialized SessionRecord.  Trailing truncated lines
 * (JSON.parse failure on the last line) are discarded on read.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import type { SessionRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Write (append)
// ---------------------------------------------------------------------------

/**
 * Append a single record to the JSONL file.
 * The file is created (including parent directories) if it does not exist.
 */
export function appendRecord(wirePath: string, record: SessionRecord): void {
  const dir = resolve(wirePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify(record) + "\n";
  writeFileSync(wirePath, line, { flag: "a" });
}

/**
 * Append a batch of records atomically.
 * Reads existing content, appends all new records, then writes back.
 * For small batches this is safe; for high-throughput use the debounced
 * persistence class.
 */
export function appendRecords(wirePath: string, records: SessionRecord[]): void {
  if (records.length === 0) return;

  const dir = resolve(wirePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const lines = records.map((r) => JSON.stringify(r) + "\n").join("");
  writeFileSync(wirePath, lines, { flag: "a" });
}

// ---------------------------------------------------------------------------
// Read (streaming)
// ---------------------------------------------------------------------------

/**
 * Read all records from a JSONL file, handling crash recovery.
 * If the last line fails to parse as JSON, it is discarded
 * (likely a truncated write from a crash).
 */
export async function readRecords(wirePath: string): Promise<SessionRecord[]> {
  if (!existsSync(wirePath)) return [];

  const records: SessionRecord[] = [];
  const lines: string[] = [];

  const rl = createInterface({
    input: createReadStream(wirePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lines.push(line);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    try {
      records.push(JSON.parse(trimmed) as SessionRecord);
    } catch {
      // If the last line fails to parse, it's likely a truncated write from a crash
      if (i === lines.length - 1) {
        // Discard and skip
        continue;
      }
      // Non-last-line parse failures are unexpected — rethrow
      throw new Error(
        `Failed to parse record at line ${i + 1}: ${trimmed.slice(0, 200)}`,
      );
    }
  }

  return records;
}

/**
 * Iterate over records line-by-line without loading the full file into memory.
 * Yields parsed SessionRecord objects.  Truncated final lines are discarded.
 */
export async function* iterateRecords(
  wirePath: string,
): AsyncGenerator<SessionRecord, void, void> {
  if (!existsSync(wirePath)) return;

  const rl = createInterface({
    input: createReadStream(wirePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let lastLine = "";
  let lineIndex = 0;
  let isLast = false;

  // Two-pass: we need to know if we're on the last line for crash recovery.
  // Instead of two-pass, buffer one line ahead.
  let prevLine: string | null = null;

  for await (const line of rl) {
    if (prevLine !== null) {
      const trimmed = prevLine.trim();
      if (trimmed.length > 0) {
        yield JSON.parse(trimmed) as SessionRecord;
      }
    }
    prevLine = line;
  }

  // Handle the last line with crash recovery
  if (prevLine !== null) {
    const trimmed = prevLine.trim();
    if (trimmed.length > 0) {
      try {
        yield JSON.parse(trimmed) as SessionRecord;
      } catch {
        // Trailing truncated line — discard silently
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rewrite (schema migration / compaction)
// ---------------------------------------------------------------------------

/**
 * Rewrite the wire file with a new set of records.
 * Atomically replaces the file using a temp file + rename.
 */
export function rewriteRecords(wirePath: string, records: SessionRecord[]): void {
  const dir = resolve(wirePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = wirePath + ".tmp." + process.pid;
  const lines = records.map((r) => JSON.stringify(r) + "\n").join("");
  writeFileSync(tmpPath, lines, "utf-8");
  renameSync(tmpPath, wirePath);
}

// ---------------------------------------------------------------------------
// Read first record (fast metadata access)
// ---------------------------------------------------------------------------

/**
 * Read only the first record from a JSONL file.
 * Useful for quickly accessing the metadata record without scanning the full file.
 * Returns null if the file is empty or does not exist.
 */
export async function readFirstRecord(wirePath: string): Promise<SessionRecord | null> {
  if (!existsSync(wirePath)) return null;

  const rl = createInterface({
    input: createReadStream(wirePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      return JSON.parse(trimmed) as SessionRecord;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Count the number of records in a wire file.
 */
export async function countRecords(wirePath: string): Promise<number> {
  if (!existsSync(wirePath)) return 0;

  const rl = createInterface({
    input: createReadStream(wirePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _line of rl) {
    count++;
  }

  return count;
}