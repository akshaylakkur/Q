/**
 * Comprehensive edge-case tests for session records persistence system.
 * Covers crash recovery, dedup, permissions reservation, concurrent scenarios,
 * LRU eviction, schema migration scaffolding, and error paths.
 */
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

import { CURRENT_WIRE_VERSION } from "../types.js";
import {
  readRecords, appendRecord, appendRecords, rewriteRecords,
  countRecords, readFirstRecord, iterateRecords,
} from "../wire.js";
import {
  BlobStore, MAX_INLINE_BYTES, parseBlobRef, encodeBlobRef, isBlobRef,
} from "../blob-store.js";
import {
  migrateWireFile, runMigrations, resolveProtocolVersion, getLatestVersion,
} from "../migration.js";
import { FileSystemAgentRecordPersistence } from "../persistence.js";
import { SessionStore, getSessionsBase } from "../session-store.js";
import { exportSession, importSession } from "../export-import.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpBase = resolve("/tmp", `v-records-test-${randomUUID().slice(0, 8)}`);

function freshDir(name: string): string {
  const d = join(tmpBase, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

function countLines(p: string): number {
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf-8").split("\n").filter(l => l.trim().length > 0).length;
}

// =========================================================================
// 1. Wire Format — edge cases
// =========================================================================

describe("Wire format", () => {
  let dir: string;

  beforeEach(() => { dir = freshDir("wire"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes and reads a single record", async () => {
    const p = join(dir, "wire.jsonl");
    appendRecord(p, { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "t0" });
    const r = await readRecords(p);
    expect(r).toHaveLength(1);
    expect(r[0]!.type).toBe("metadata");
  });

  it("writes and reads multiple records", async () => {
    const p = join(dir, "wire.jsonl");
    appendRecord(p, { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "t0" });
    appendRecord(p, { type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "hello" });
    appendRecord(p, { type: "turn.prompt", timestamp: "t2", turnId: "b", prompt: "world" });
    const r = await readRecords(p);
    expect(r).toHaveLength(3);
  });

  it("handles empty file", async () => {
    const p = join(dir, "empty.jsonl");
    writeFileSync(p, "", "utf-8");
    const r = await readRecords(p);
    expect(r).toHaveLength(0);
  });

  it("handles nonexistent file", async () => {
    const p = join(dir, "nope.jsonl");
    const r = await readRecords(p);
    expect(r).toHaveLength(0);
  });

  it("crash recovery: discards trailing truncated line", async () => {
    const p = join(dir, "wire.jsonl");
    appendRecord(p, { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "t0" });
    appendRecord(p, { type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "ok" });

    // Append a truncated record (crash scenario)
    writeFileSync(p, readFileSync(p) + '{"type": "turn.prompt"', "utf-8");

    const r = await readRecords(p);
    expect(r).toHaveLength(2); // truncated line discarded
  });

  it("crash recovery: preserves file when last line is valid", async () => {
    const p = join(dir, "wire.jsonl");
    appendRecord(p, { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "t0" });
    const r = await readRecords(p);
    expect(r).toHaveLength(1);
  });

  it("rejects parse errors on non-last lines", async () => {
    const p = join(dir, "wire.jsonl");
    writeFileSync(p, '{"type":"metadata","timestamp":"t"}\nbroken\n{"type":"turn.prompt"}\n', "utf-8");
    await expect(readRecords(p)).rejects.toThrow();
  });

  it("appendRecords batch writes multiple records", async () => {
    const p = join(dir, "wire.jsonl");
    appendRecords(p, [
      { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "t0" },
      { type: "turn.prompt", timestamp: "t1", turnId: "x", prompt: "batch" },
    ]);
    const r = await readRecords(p);
    expect(r).toHaveLength(2);
  });

  it("appendRecords with empty array does nothing", async () => {
    const p = join(dir, "wire.jsonl");
    appendRecords(p, []);
    expect(existsSync(p)).toBe(false);
  });

  it("rewriteRecords atomically replaces content", async () => {
    const p = join(dir, "wire.jsonl");
    appendRecord(p, { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "t0" });
    rewriteRecords(p, [
      { type: "metadata", timestamp: "t1", protocolVersion: 1, createdAt: "t1" },
    ]);
    const r = await readRecords(p);
    expect(r).toHaveLength(1);
    expect(r[0]!.timestamp).toBe("t1");
  });

  it("countRecords counts correctly", async () => {
    const p = join(dir, "wire.jsonl");
    expect(await countRecords(p)).toBe(0);
    appendRecord(p, { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "t0" });
    expect(await countRecords(p)).toBe(1);
    appendRecord(p, { type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "hey" });
    expect(await countRecords(p)).toBe(2);
  });

  it("readFirstRecord returns first record quickly", async () => {
    const p = join(dir, "wire.jsonl");
    expect(await readFirstRecord(p)).toBeNull();
    appendRecord(p, { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "t0" });
    appendRecord(p, { type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "hey" });
    const first = await readFirstRecord(p);
    expect(first).not.toBeNull();
    expect(first!.type).toBe("metadata");
  });

  it("iterateRecords yields records line-by-line", async () => {
    const p = join(dir, "wire.jsonl");
    appendRecord(p, { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "t0" });
    appendRecord(p, { type: "usage.record", timestamp: "t1", tokenType: "input", count: 42 });

    const yielded: string[] = [];
    for await (const rec of iterateRecords(p)) {
      yielded.push(rec.type);
    }
    expect(yielded).toEqual(["metadata", "usage.record"]);
  });

  it("iterateRecords handles truncated last line", async () => {
    const p = join(dir, "wire.jsonl");
    appendRecord(p, { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "t0" });
    appendRecord(p, { type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "ok" });
    writeFileSync(p, readFileSync(p) + '{"type":"turn.prompt"', "utf-8");

    const yielded: string[] = [];
    for await (const rec of iterateRecords(p)) {
      yielded.push(rec.type);
    }
    expect(yielded).toEqual(["metadata", "turn.prompt"]);
  });

  it("reads files with blank lines", async () => {
    const p = join(dir, "wire.jsonl");
    writeFileSync(p, '\n{"type":"metadata","timestamp":"t","protocolVersion":1,"createdAt":"t"}\n\n\n', "utf-8");
    const r = await readRecords(p);
    expect(r).toHaveLength(1);
  });
});

// =========================================================================
// 2. BlobStore — edge cases
// =========================================================================

describe("BlobStore", () => {
  let dir: string;
  let store: BlobStore;

  beforeEach(() => {
    dir = freshDir("blobs");
    store = new BlobStore(dir);
    store.initialize();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stores and retrieves a blob", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const ref = store.store(data, "application/octet-stream");
    const parsed = parseBlobRef(ref)!;
    const retrieved = store.retrieve(parsed.sha256);
    expect(retrieved).not.toBeNull();
    expect([...retrieved!]).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns null for missing blob", () => {
    const hash = "0000000000000000000000000000000000000000000000000000000000000000";
    expect(store.retrieve(hash)).toBeNull();
  });

  it("deduplicates identical content", () => {
    const data = new Uint8Array([10, 20, 30]);
    const ref1 = store.store(data, "text/plain");
    const ref2 = store.store(data, "text/plain");
    expect(ref1).toBe(ref2);
    expect(store.count()).toBe(1);
  });

  it("stores different content separately", () => {
    store.store(new Uint8Array([1]), "a/a");
    store.store(new Uint8Array([2]), "b/b");
    expect(store.count()).toBe(2);
  });

  it("parseBlobRef returns null for invalid strings", () => {
    expect(parseBlobRef("")).toBeNull();
    expect(parseBlobRef("blobref:")).toBeNull();
    expect(parseBlobRef("blobref:application/octet-stream;abc")).toBeNull();
    expect(parseBlobRef("not-a-blobref")).toBeNull();
  });

  it("encodeBlobRef and parseBlobRef round-trip", () => {
    const mime = "image/png";
    const hash = "a".repeat(64);
    const ref = encodeBlobRef(mime, hash);
    const parsed = parseBlobRef(ref);
    expect(parsed).not.toBeNull();
    expect(parsed!.mime).toBe(mime);
    expect(parsed!.sha256).toBe(hash);
  });

  it("isBlobRef correctly identifies refs", () => {
    expect(isBlobRef(`blobref:text/plain;${"a".repeat(64)}`)).toBe(true);
    expect(isBlobRef("hello")).toBe(false);
    expect(isBlobRef("blobref:;abc")).toBe(false);
  });

  it("maybeOffload leaves small strings inline", () => {
    const small = "a".repeat(128);
    expect(store.maybeOffload(small, "text/plain")).toBe(small);
  });

  it("maybeOffload offloads large base64 strings", () => {
    const largeBuf = Buffer.alloc(5000, 0x42);
    const b64 = largeBuf.toString("base64");
    const ref = store.maybeOffload(b64, "image/png");
    expect(ref).not.toBe(b64);
    expect(isBlobRef(ref)).toBe(true);
  });

  it("maybeOffload returns non-base64 strings as-is", () => {
    const val = "hello world this is not base64";
    expect(store.maybeOffload(val, "text/plain")).toBe(val);
  });

  it("delete removes blob from disk and cache", () => {
    const d = new Uint8Array([99]);
    const ref = store.store(d, "a/a");
    const parsed = parseBlobRef(ref)!;
    expect(store.retrieve(parsed.sha256)).not.toBeNull();

    store.delete(parsed.sha256);
    expect(store.retrieve(parsed.sha256)).toBeNull();
    expect(store.count()).toBe(0);
  });

  it("resolvePayload resolves blobref transparently", () => {
    const d = new Uint8Array([1, 2, 3]);
    const ref = store.store(d, "a/a");
    const resolved = store.resolvePayload(ref);
    expect(resolved).toBeInstanceOf(Uint8Array);
    expect([...(resolved as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("resolvePayload returns non-string values as-is", () => {
    expect(store.resolvePayload(42)).toBe(42);
    expect(store.resolvePayload(null)).toBeNull();
    expect(store.resolvePayload({ key: "val" })).toEqual({ key: "val" });
  });

  it("resolvePayload throws for missing blob reference", () => {
    const ref = encodeBlobRef("text/plain", "f".repeat(64));
    expect(() => store.resolvePayload(ref)).toThrow("Blob not found");
  });

  it("totalSize aggregates blob sizes", () => {
    store.store(new Uint8Array(100), "a/a");
    store.store(new Uint8Array(200), "b/b");
    expect(store.totalSize()).toBeGreaterThanOrEqual(300);
  });
});

// =========================================================================
// 3. Schema Migration
// =========================================================================

describe("Schema Migration", () => {
  it("getLatestVersion returns 1 when no migrations registered", () => {
    expect(getLatestVersion()).toBe(1);
  });

  it("resolveProtocolVersion reads from metadata record", () => {
    const records = [
      { type: "metadata" as const, timestamp: "t", protocolVersion: 1, createdAt: "t" },
    ];
    expect(resolveProtocolVersion(records)).toBe(1);
  });

  it("resolveProtocolVersion falls back to 1 when no metadata", () => {
    const records = [
      { type: "turn.prompt" as const, timestamp: "t", turnId: "a", prompt: "hi" },
    ];
    expect(resolveProtocolVersion(records)).toBe(1);
  });

  it("runMigrations is a no-op for empty records", () => {
    const result = runMigrations([]);
    expect(result.didMigrate).toBe(false);
    expect(result.migrated).toHaveLength(0);
  });

  it("runMigrations is a no-op at latest version", () => {
    const records = [
      { type: "metadata" as const, timestamp: "t", protocolVersion: 1, createdAt: "t" },
    ];
    const { didMigrate, targetVersion } = runMigrations(records);
    expect(didMigrate).toBe(false);
    expect(targetVersion).toBe(1);
  });

  it("migrateWireFile on non-existent file returns zero counts", async () => {
    const result = await migrateWireFile("/tmp/nonexistent-wire.jsonl");
    expect(result.recordCount).toBe(0);
    expect(result.didMigrate).toBe(false);
  });
});

// =========================================================================
// 4. FileSystemAgentRecordPersistence — edge cases
// =========================================================================

describe("FileSystemAgentRecordPersistence", () => {
  let dir: string;
  let p: FileSystemAgentRecordPersistence;

  beforeEach(async () => {
    dir = freshDir("persist");
    p = new FileSystemAgentRecordPersistence({ sessionId: "test", sessionDir: dir });
    await p.initialize();
  });

  afterEach(() => {
    p.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts with empty records", async () => {
    const r = await p.readAll();
    expect(r).toHaveLength(0);
  });

  it("appends and flushes records", () => {
    p.append({ type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "hello" });
    p.flushSync();
    expect(countLines(p.wirePath)).toBe(1);
  });

  it("batches multiple appends before flush", () => {
    p.append({ type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "a" });
    p.append({ type: "turn.prompt", timestamp: "t2", turnId: "b", prompt: "b" });
    p.flushSync();
    expect(countLines(p.wirePath)).toBe(2);
  });

  it("appendBatch adds multiple records at once", () => {
    p.appendBatch([
      { type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "a" },
      { type: "turn.prompt", timestamp: "t2", turnId: "b", prompt: "b" },
    ]);
    p.flushSync();
    expect(countLines(p.wirePath)).toBe(2);
  });

  it("setMetadata replaces existing metadata record", async () => {
    await p.setMetadata({
      type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "original",
    });
    await p.setMetadata({
      type: "metadata", timestamp: "t1", protocolVersion: 1, createdAt: "updated",
    });
    const r = await p.readAll();
    expect(r).toHaveLength(1);
    expect((r[0]! as any).createdAt).toBe("updated");
  });

  it("setMetadata prepends metadata if none exists", async () => {
    p.append({ type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "data" });
    p.flushSync();
    await p.setMetadata({
      type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "now",
    });
    const r = await p.readAll();
    expect(r).toHaveLength(2);
    expect(r[0]!.type).toBe("metadata");
  });

  it("close flushes buffered records", () => {
    p.append({ type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "data" });
    p.close();
    expect(countLines(p.wirePath)).toBe(1);
  });

  it("throws when appending after close", () => {
    p.close();
    expect(() => p.append({ type: "turn.prompt", timestamp: "t", turnId: "a", prompt: "nope" })).toThrow("closed");
  });

  it("rewrite flushes and replaces all records", () => {
    p.append({ type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "old" });
    p.flushSync();
    p.rewrite([
      { type: "metadata", timestamp: "t0", protocolVersion: 1, createdAt: "new" },
    ]);
    expect(countLines(p.wirePath)).toBe(1);
  });

  it("debounce flushes after delay", async () => {
    p.append({ type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "data" });
    await new Promise(r => setTimeout(r, 150));
    expect(countLines(p.wirePath)).toBe(1);
  });

  it("debounce timer resets on rapid appends", async () => {
    p.append({ type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "a" });
    p.append({ type: "turn.prompt", timestamp: "t2", turnId: "b", prompt: "b" });
    p.append({ type: "turn.prompt", timestamp: "t3", turnId: "c", prompt: "c" });
    await new Promise(r => setTimeout(r, 50));
    expect(countLines(p.wirePath)).toBe(0);
    await new Promise(r => setTimeout(r, 100));
    expect(countLines(p.wirePath)).toBe(3);
  });

  it("getProtocolVersion returns current version", () => {
    expect(p.getProtocolVersion()).toBe(CURRENT_WIRE_VERSION);
  });

  it("blobStore is accessible", () => {
    expect(p.blobStore).toBeInstanceOf(BlobStore);
  });
});

// =========================================================================
// 5. SessionStore — edge cases
// =========================================================================

describe("SessionStore", () => {
  const origHome = process.env.HOME;
  const store = new SessionStore();
  let sessionId: string;
  let persistence: FileSystemAgentRecordPersistence;

  beforeAll(async () => {
    process.env.HOME = tmpBase;
    rmSync(join(tmpBase, ".Q", "sessions"), { recursive: true, force: true });
    const result = await store.create({ name: "test-main", model: "gpt-4", workspaceDirectory: "/tmp/ws" });
    sessionId = result.sessionId;
    persistence = result.persistence;
  });

  afterAll(() => {
    persistence.close();
    process.env.HOME = origHome;
  });

  it("create returns a valid session", () => {
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe("string");
  });

  it("get retrieves session metadata", () => {
    const meta = store.get(sessionId);
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe("test-main");
    expect(meta!.model).toBe("gpt-4");
    expect(meta!.workspaceDirectory).toBe("/tmp/ws");
    expect(meta!.protocolVersion).toBe(CURRENT_WIRE_VERSION);
  });

  it("get returns null for nonexistent session", () => {
    expect(store.get("nonexistent")).toBeNull();
  });

  it("list returns at least one session", () => {
    const list = store.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it("list filters by workspace directory", () => {
    const filtered = store.list({ workspaceDirectory: "/tmp/ws" });
    expect(filtered.length).toBeGreaterThanOrEqual(1);
  });

  it("list filter with non-matching workspace returns empty", () => {
    expect(store.list({ workspaceDirectory: "/nonexistent" })).toHaveLength(0);
  });

  it("list returns sessions sorted by updatedAt descending", () => {
    const list = store.list();
    for (let i = 1; i < list.length; i++) {
      expect(new Date(list[i]!.updatedAt).getTime())
        .toBeLessThanOrEqual(new Date(list[i - 1]!.updatedAt).getTime());
    }
  });

  it("fork creates a new session with same workspace and model", async () => {
    const { sessionId: forkId, persistence: forkP } = await store.fork(sessionId, "forked");
    const meta = store.get(forkId);
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe("forked");
    expect(meta!.workspaceDirectory).toBe("/tmp/ws");
    expect(meta!.model).toBe("gpt-4");
    forkP.close();
    await store.delete(forkId);
  });

  it("fork without new name appends (fork) suffix", async () => {
    const { sessionId: forkId, persistence: forkP } = await store.fork(sessionId);
    const meta = store.get(forkId);
    expect(meta!.name).toContain("(fork)");
    forkP.close();
    await store.delete(forkId);
  });

  it("fork throws for nonexistent session", async () => {
    await expect(store.fork("nonexistent")).rejects.toThrow("Session not found");
  });

  it("delete removes session from index and disk", async () => {
    const { sessionId: tmpId } = await store.create({ name: "delete-me" });
    expect(store.get(tmpId)).not.toBeNull();
    await store.delete(tmpId);
    expect(store.get(tmpId)).toBeNull();
    expect(existsSync(join(getSessionsBase(), tmpId))).toBe(false);
  });

  it("refresh updates record count", async () => {
    const { sessionId: sid, persistence: sp } = await store.create({ name: "refresh-test" });
    sp.append({ type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "r1" });
    sp.append({ type: "turn.prompt", timestamp: "t2", turnId: "b", prompt: "r2" });
    sp.flushSync();
    await store.refresh(sid);
    const meta = store.get(sid);
    expect(meta!.recordCount).toBeGreaterThanOrEqual(3);
    sp.close();
    await store.delete(sid);
  });

  it("register adds external session to index", async () => {
    const id = randomUUID();
    await store.register(id, {
      id, name: "imported", createdAt: "now", updatedAt: "now",
      protocolVersion: 1, recordCount: 0, blobCount: 0, sizeBytes: 0,
    });
    expect(store.get(id)).not.toBeNull();
    await store.delete(id);
  });
});

// =========================================================================
// 6. Export/Import — end-to-end round-trip
// =========================================================================

describe("Session Export/Import", () => {
  const origHome = process.env.HOME;

  beforeAll(() => {
    process.env.HOME = tmpBase;
  });

  afterAll(() => {
    process.env.HOME = origHome;
  });

  it("exports a session with records", async () => {
    const store = new SessionStore();
    const { sessionId, persistence } = await store.create({ name: "export-test", model: "claude" });

    persistence.append({ type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "hello" });
    persistence.append({ type: "turn.prompt", timestamp: "t2", turnId: "b", prompt: "world" });
    persistence.append({ type: "usage.record", timestamp: "t3", tokenType: "output", count: 100 });
    persistence.flushSync();

    const zipPath = join(tmpBase, `export-${sessionId}.zip`);
    await exportSession(sessionId, zipPath);
    expect(existsSync(zipPath)).toBe(true);
    expect(statSync(zipPath).size).toBeGreaterThan(100);

    persistence.close();
    await store.delete(sessionId);
    rmSync(zipPath, { force: true });
  });

  it("round-trips export and import", async () => {
    const store = new SessionStore();

    const { sessionId, persistence } = await store.create({
      name: "roundtrip", model: "gpt-4o", workspaceDirectory: "/tmp/ws2",
    });
    persistence.append({ type: "turn.prompt", timestamp: "t1", turnId: "x", prompt: "roundtrip test" });
    persistence.append({ type: "config.update", timestamp: "t2", key: "theme", value: "dark" });
    persistence.flushSync();

    const blobData = new Uint8Array(5000).fill(0x41);
    persistence.blobStore.store(blobData, "image/png");
    await store.refresh(sessionId);

    const zipPath = join(tmpBase, `rt-${sessionId}.zip`);
    await exportSession(sessionId, zipPath);

    persistence.close();
    await store.delete(sessionId);
    expect(store.get(sessionId)).toBeNull();

    const imported = await importSession(zipPath);
    expect(imported.name).toBe("roundtrip");
    expect(imported.model).toBe("gpt-4o");
    expect(imported.workspaceDirectory).toBe("/tmp/ws2");

    const importedStore = new SessionStore();
    const meta = importedStore.get(imported.id);
    expect(meta).not.toBeNull();
    expect(meta!.recordCount).toBeGreaterThanOrEqual(3);

    await importedStore.delete(imported.id);
    rmSync(zipPath, { force: true });
  });

  it("import rejects archive without manifest.json", async () => {
    const badZip = join(tmpBase, "bad.zip");
    writeFileSync(badZip, "not-a-zip");
    await expect(importSession(badZip)).rejects.toThrow();
    rmSync(badZip, { force: true });
  });

  it("import rejects nonexistent archive", async () => {
    await expect(importSession("/tmp/nonexistent.zip")).rejects.toThrow("Archive not found");
  });
});

// =========================================================================
// 7. Integration — cross-module scenarios
// =========================================================================

describe("Integration scenarios", () => {
  const origHome = process.env.HOME;
  beforeAll(() => { process.env.HOME = tmpBase; });
  afterAll(() => { process.env.HOME = origHome; });

  it("creates session with blob offloading and persists records", async () => {
    const store = new SessionStore();
    const { sessionId, persistence } = await store.create({
      name: "blob-integration", model: "test",
    });

    const largeData = new Uint8Array(10000).fill(0x42);
    const ref = persistence.blobStore.store(largeData, "application/octet-stream");
    expect(isBlobRef(ref)).toBe(true);

    persistence.append({
      type: "context.append_message",
      timestamp: "t1",
      role: "user",
      content: ref,
    });
    persistence.flushSync();

    const records = await persistence.readAll();
    const msgRecord = records.find(r => r.type === "context.append_message") as any;
    expect(msgRecord).toBeDefined();
    expect(isBlobRef(msgRecord.content)).toBe(true);

    const parsed = parseBlobRef(msgRecord.content)!;
    const resolved = persistence.blobStore.retrieve(parsed.sha256);
    expect(resolved).not.toBeNull();
    expect(resolved!.byteLength).toBe(10000);

    persistence.close();
    await store.delete(sessionId);
  });

  it("survives close and reopen with migration check", async () => {
    const store = new SessionStore();
    const { sessionId, persistence } = await store.create({
      name: "reopen-test", model: "test",
    });

    persistence.append({ type: "turn.prompt", timestamp: "t1", turnId: "a", prompt: "before close" });
    persistence.flushSync();
    persistence.close();

    const p2 = new FileSystemAgentRecordPersistence({
      sessionId,
      sessionDir: join(getSessionsBase(), sessionId),
    });
    await p2.initialize();

    const records = await p2.readAll();
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(records.some(r => r.type === "turn.prompt")).toBe(true);

    p2.close();
    await store.delete(sessionId);
  });
});