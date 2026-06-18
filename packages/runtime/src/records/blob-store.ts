/**
 * BlobStore — Large payload offloading for the JSONL wire format.
 *
 * When a base64-encoded media payload exceeds 4 KB it is replaced with a
 * blob reference string: `blobref:<mime>;<sha256Hex>` and the raw decoded
 * bytes are stored at `$HOME/.Q/sessions/<sessionId>/blobs/<sha256Hex>`.
 *
 * Content-addressed deduplication via checking for EEXIST on write.
 * Maintains an LRU cache (max 50 MB) for frequently accessed blobs.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { LRUCache } from "lru-cache";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum inline size for a base64 payload (4 KB). */
export const MAX_INLINE_BYTES = 4 * 1024;

/** Maximum LRU cache size (50 MB). */
const LRU_MAX_SIZE_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Blob reference pattern
// ---------------------------------------------------------------------------

const BLOB_REF_RE = /^blobref:([^;]+);([a-f0-9]{64})$/;

/**
 * Parse a blob reference string.
 * Returns null if the string is not a valid blobref.
 */
export function parseBlobRef(ref: string): { mime: string; sha256: string } | null {
  const m = ref.match(BLOB_REF_RE);
  if (!m) return null;
  return { mime: m[1] as string, sha256: m[2] as string };
}

/**
 * Encode a blob reference from mime type and SHA-256 hash.
 */
export function encodeBlobRef(mime: string, sha256: string): string {
  return `blobref:${mime};${sha256}`;
}

/**
 * Check whether a string is a blob reference.
 */
export function isBlobRef(value: string): boolean {
  return BLOB_REF_RE.test(value);
}

// ---------------------------------------------------------------------------
// Blob directory helpers
// ---------------------------------------------------------------------------

function ensureBlobDir(blobsDir: string): void {
  if (!existsSync(blobsDir)) {
    mkdirSync(blobsDir, { recursive: true });
  }
}

function blobPath(blobsDir: string, sha256: string): string {
  return resolve(blobsDir, sha256);
}

// ---------------------------------------------------------------------------
// LRU cache (global per BlobStore instance)
// ---------------------------------------------------------------------------

const lru = new LRUCache<string, Uint8Array>({
  maxSize: LRU_MAX_SIZE_BYTES,
  sizeCalculation: (value) => value.byteLength,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * BlobStore for offloading large payloads to disk.
 */
export class BlobStore {
  private blobsDir: string;

  constructor(blobsDir: string) {
    this.blobsDir = blobsDir;
  }

  /**
   * Initialize the blob directory.
   */
  initialize(): void {
    ensureBlobDir(this.blobsDir);
  }

  /**
   * Store a blob from raw bytes.
   * Returns the blob reference string.
   * If the blob already exists (content-addressed dedup), skips writing.
   */
  store(data: Uint8Array, mime: string): string {
    ensureBlobDir(this.blobsDir);

    const hash = createHash("sha256").update(data).digest("hex");
    const ref = encodeBlobRef(mime, hash);
    const path = blobPath(this.blobsDir, hash);

    // Content-addressed dedup: if file exists, skip
    if (!existsSync(path)) {
      try {
        writeFileSync(path, data);
      } catch (err: unknown) {
        // EEXIST race condition — another write beat us to it
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
      }
    }

    // Update LRU cache
    lru.set(hash, data);

    return ref;
  }

  /**
   * Retrieve blob bytes by SHA-256 hash.
   * Checks the LRU cache first, then falls back to disk.
   * Returns null if the blob does not exist on disk.
   */
  retrieve(sha256: string): Uint8Array | null {
    // Check LRU cache first
    const cached = lru.get(sha256);
    if (cached !== undefined) return cached;

    const path = blobPath(this.blobsDir, sha256);
    if (!existsSync(path)) return null;

    const data = readFileSync(path);
    lru.set(sha256, data);
    return data;
  }

  /**
   * Parse a payload value from a record.
   * If it is a blob reference, resolves it transparently.
   * Otherwise returns the value as-is.
   */
  resolvePayload(value: unknown): Uint8Array | string | unknown {
    if (typeof value !== "string") return value;
    const parsed = parseBlobRef(value);
    if (!parsed) return value;

    const data = this.retrieve(parsed.sha256);
    if (data === null) {
      throw new Error(`Blob not found: ${parsed.sha256}`);
    }
    return data;
  }

  /**
   * Given a string value (potentially base64-encoded content),
   * store it as a blob if its decoded size exceeds MAX_INLINE_BYTES.
   * Returns the string value (unchanged if small, blobref if large).
   */
  maybeOffload(value: string, mime: string): string {
    if (value.length <= MAX_INLINE_BYTES + 128) {
      // Rough check: base64 is ~4/3 of original, so small strings are safe
      return value;
    }

    // Decode to check actual byte size
    try {
      const decoded = Buffer.from(value, "base64");
      if (decoded.byteLength <= MAX_INLINE_BYTES) return value;
      return this.store(new Uint8Array(decoded), mime);
    } catch {
      // Not valid base64 — return as-is
      return value;
    }
  }

  /**
   * Delete a blob by SHA-256 hash.
   */
  delete(sha256: string): void {
    lru.delete(sha256);
    const path = blobPath(this.blobsDir, sha256);
    try {
      unlinkSync(path);
    } catch {
      // Ignore if already gone
    }
  }

  /**
   * Get the number of blobs on disk.
   */
  count(): number {
    if (!existsSync(this.blobsDir)) return 0;
    return readdirSync(this.blobsDir).length;
  }

  /**
   * Get total size of all blobs on disk.
   */
  totalSize(): number {
    if (!existsSync(this.blobsDir)) return 0;
    const files = readdirSync(this.blobsDir);
    let total = 0;
    for (const f of files) {
      try {
        const st = statSync(resolve(this.blobsDir, f));
        total += st.size;
      } catch {
        // Skip
      }
    }
    return total;
  }
}