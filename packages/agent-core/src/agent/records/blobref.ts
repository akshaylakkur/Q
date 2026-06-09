/**
 * BlobStore — Offloads large media content from agent records to disk.
 *
 * Stores content-addressable blobs (SHA256-addressed) in a blobs directory.
 * On resume, rehydrates references back to inline data URIs.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "pathe";

const BLOBREF_PROTOCOL = "blobref:";
const DATA_URI_HEADER_RE = /^data:([^;]+);base64,/;
const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024;

export function isBlobRef(url: string): boolean {
  return url.startsWith(BLOBREF_PROTOCOL);
}

export interface BlobStoreOptions {
  readonly blobsDir: string;
  readonly threshold?: number;
  readonly maxCacheSize?: number;
}

export class BlobStore {
  private readonly blobsDir: string;
  private readonly threshold: number;
  private readonly maxCacheSize: number;
  private readonly cache = new Map<string, Buffer>();
  private readonly cacheSizes = new Map<string, number>();
  private currentCacheSize = 0;

  constructor(options: BlobStoreOptions) {
    this.blobsDir = options.blobsDir;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
  }

  async offload(data: string): Promise<string> {
    if (data.startsWith(BLOBREF_PROTOCOL)) return data;
    const match = DATA_URI_HEADER_RE.exec(data);
    if (match === null) return data;
    const mimeType = match[1]!;
    const payload = data.slice(match[0].length);
    if (payload.length < this.threshold) return data;
    return this.writeBlob(mimeType, payload);
  }

  async rehydrate(url: string): Promise<string> {
    if (!isBlobRef(url)) return url;
    const rest = url.slice(BLOBREF_PROTOCOL.length);
    const semiIdx = rest.indexOf(";");
    if (semiIdx === -1) return url;
    const mimeType = rest.slice(0, semiIdx);
    const hash = rest.slice(semiIdx + 1);
    if (hash.length === 0) return url;
    const payload = await this.readBlob(hash);
    if (payload === undefined) return "[media missing]";
    return `data:${mimeType};base64,${payload.toString("base64")}`;
  }

  private async readBlob(hash: string): Promise<Buffer | undefined> {
    const cached = this.cache.get(hash);
    if (cached !== undefined) {
      // LRU reorder
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached;
    }
    try {
      const payload = await readFile(join(this.blobsDir, hash));
      this.setCache(hash, payload);
      return payload;
    } catch {
      return undefined;
    }
  }

  private async writeBlob(mimeType: string, base64Payload: string): Promise<string> {
    await mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256").update(base64Payload, "utf8").digest("hex");
    const blobPath = join(this.blobsDir, hash);
    const binary = Buffer.from(base64Payload, "base64");
    try {
      await writeFile(blobPath, binary, { flag: "wx" });
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      // File already exists — that's fine, it's content-addressed
    }
    this.setCache(hash, binary);
    return `${BLOBREF_PROTOCOL}${mimeType};${hash}`;
  }

  private setCache(hash: string, payload: Buffer): void {
    const size = payload.byteLength;
    const alreadyCached = this.cache.has(hash);
    if (alreadyCached) {
      const oldSize = this.cacheSizes.get(hash) ?? 0;
      this.currentCacheSize += size - oldSize;
      this.cache.delete(hash);
    } else {
      if (size > this.maxCacheSize) return;
      while (this.currentCacheSize + size > this.maxCacheSize && this.cache.size > 0) {
        this.evictLRU();
      }
      this.currentCacheSize += size;
    }
    this.cache.set(hash, payload);
    this.cacheSizes.set(hash, size);
  }

  private evictLRU(): void {
    const lru = this.cache.keys().next().value;
    if (lru === undefined) return;
    const size = this.cacheSizes.get(lru) ?? 0;
    this.currentCacheSize -= size;
    this.cache.delete(lru);
    this.cacheSizes.delete(lru);
  }
}
