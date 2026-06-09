/**
 * Smoke test for session records persistence system.
 * Tests: wire format, blob store, persistence, session store, migration, export/import.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CURRENT_WIRE_VERSION } from "../types.js";
import { readRecords, appendRecord, rewriteRecords, countRecords } from "../wire.js";
import { BlobStore, parseBlobRef, encodeBlobRef, isBlobRef } from "../blob-store.js";
import { runMigrations, resolveProtocolVersion, getLatestVersion } from "../migration.js";
import { FileSystemAgentRecordPersistence } from "../persistence.js";
import { SessionStore, getSessionsBase } from "../session-store.js";
import { exportSession, importSession } from "../export-import.js";

const testHome = "/tmp/v-test-sessions-" + randomUUID().slice(0, 8);
const origHome = process.env.HOME;

import { describe, test, expect, beforeEach, afterAll } from "vitest";

let testDir: string;

beforeEach(() => {
  process.env.HOME = testHome;
  testDir = resolve(testHome, ".Q", "sessions");
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  process.env.HOME = origHome;
  try { rmSync(resolve(testHome), { recursive: true, force: true }); } catch {}
});

// ================================
describe("Wire format (JSONL I/O)", () => {
  test("append and read records", async () => {
    const wirePath = join(testDir, "test", "wire.jsonl");
    mkdirSync(resolve(wirePath, ".."), { recursive: true });

    appendRecord(wirePath, {
      type: "metadata",
      timestamp: new Date().toISOString(),
      protocolVersion: 1,
      createdAt: new Date().toISOString(),
    });
    appendRecord(wirePath, {
      type: "turn.prompt",
      timestamp: new Date().toISOString(),
      turnId: "turn-1",
      prompt: "Hello",
    });
    appendRecord(wirePath, {
      type: "usage.record",
      timestamp: new Date().toISOString(),
      tokenType: "input",
      count: 42,
    });

    const records = await readRecords(wirePath);
    expect(records).toHaveLength(3);
    expect(records[0]?.type).toBe("metadata");
    expect(records[1]?.type).toBe("turn.prompt");
    expect(records[2]?.type).toBe("usage.record");
  });

  test("crash recovery discards truncated last line", async () => {
    const wirePath = join(testDir, "crash", "wire.jsonl");
    mkdirSync(resolve(wirePath, ".."), { recursive: true });

    appendRecord(wirePath, {
      type: "metadata",
      timestamp: "now",
      protocolVersion: 1,
      createdAt: "now",
    });

    // Append truncated JSON
    writeFileSync(wirePath, readFileSync(wirePath) + '{"type": "metadata"', "utf-8");

    const records = await readRecords(wirePath);
    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe("metadata");
  });

  test("countRecords", async () => {
    const wirePath = join(testDir, "count", "wire.jsonl");
    mkdirSync(resolve(wirePath, ".."), { recursive: true });

    appendRecord(wirePath, { type: "metadata", timestamp: "n", protocolVersion: 1, createdAt: "n" });
    appendRecord(wirePath, { type: "turn.prompt", timestamp: "n", turnId: "t", prompt: "p" });

    expect(await countRecords(wirePath)).toBe(2);
  });

  test("rewriteRecords replaces content", async () => {
    const wirePath = join(testDir, "rewrite", "wire.jsonl");
    mkdirSync(resolve(wirePath, ".."), { recursive: true });

    appendRecord(wirePath, { type: "metadata", timestamp: "n", protocolVersion: 1, createdAt: "n" });
    rewriteRecords(wirePath, [
      { type: "metadata", timestamp: "new", protocolVersion: 1, createdAt: "new" },
    ]);

    const records = await readRecords(wirePath);
    expect(records).toHaveLength(1);
    expect(records[0]?.timestamp).toBe("new");
  });
});

// ================================
describe("BlobStore", () => {
  test("store and retrieve blobs", () => {
    const blobsDir = join(testDir, "blobs-test");
    rmSync(blobsDir, { recursive: true, force: true });

    const store = new BlobStore(blobsDir);
    store.initialize();

    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const ref = store.store(data, "application/octet-stream");
    expect(ref).toMatch(/^blobref:/);

    const parsed = parseBlobRef(ref);
    expect(parsed).not.toBeNull();
    expect(parsed!.sha256).toHaveLength(64);

    const retrieved = store.retrieve(parsed!.sha256);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.byteLength).toBe(5);
  });

  test("returns null for missing blob", () => {
    const store = new BlobStore(join(testDir, "blobs-none"));
    store.initialize();
    const result = store.retrieve("0000000000000000000000000000000000000000000000000000000000000000");
    expect(result).toBeNull();
  });

  test("deduplicates by content", () => {
    const blobsDir = join(testDir, "blobs-dedup");
    rmSync(blobsDir, { recursive: true, force: true });

    const store = new BlobStore(blobsDir);
    store.initialize();

    const data = new Uint8Array([1, 2, 3]);
    const ref1 = store.store(data, "text/plain");
    const ref2 = store.store(data, "text/plain");
    expect(ref1).toBe(ref2);
  });

  test("isBlobRef and encodeBlobRef", () => {
    const ref = encodeBlobRef("image/png", "a".repeat(64));
    expect(ref).toBe(`blobref:image/png;${"a".repeat(64)}`);
    expect(isBlobRef(ref)).toBe(true);
    expect(isBlobRef("hello")).toBe(false);

    const parsed = parseBlobRef(ref);
    expect(parsed).not.toBeNull();
    expect(parsed!.mime).toBe("image/png");
    expect(parsed!.sha256).toBe("a".repeat(64));
  });
});

// ================================
describe("Schema Migration", () => {
  test("getLatestVersion returns 1", () => {
    expect(getLatestVersion()).toBe(1);
  });

  test("resolveProtocolVersion from records", () => {
    const records = [
      { type: "metadata" as const, timestamp: "now", protocolVersion: 1, createdAt: "now" },
    ];
    expect(resolveProtocolVersion(records)).toBe(1);
  });

  test("runMigrations no-op at version 1", () => {
    const records = [
      { type: "metadata" as const, timestamp: "now", protocolVersion: 1, createdAt: "now" },
    ];
    const { didMigrate, targetVersion } = runMigrations(records);
    expect(didMigrate).toBe(false);
    expect(targetVersion).toBe(1);
  });
});

// ================================
describe("FileSystemAgentRecordPersistence", () => {
  test("append, flush, and read records", async () => {
    const sessionDir = join(testDir, "persistence-test");
    rmSync(sessionDir, { recursive: true, force: true });

    const p = new FileSystemAgentRecordPersistence({ sessionId: "test", sessionDir });
    await p.initialize();

    p.append({ type: "turn.prompt", timestamp: "now", turnId: "t1", prompt: "hello" });
    p.append({ type: "turn.prompt", timestamp: "now", turnId: "t2", prompt: "world" });
    p.flushSync();

    const records = await p.readAll();
    expect(records).toHaveLength(2);

    p.close();
  });

  test("setMetadata prepends metadata record", async () => {
    const sessionDir = join(testDir, "persistence-meta");
    rmSync(sessionDir, { recursive: true, force: true });

    const p = new FileSystemAgentRecordPersistence({ sessionId: "test", sessionDir });
    await p.initialize();

    p.append({ type: "turn.prompt", timestamp: "now", turnId: "t1", prompt: "hello" });
    p.flushSync();

    await p.setMetadata({
      type: "metadata",
      timestamp: "now",
      protocolVersion: CURRENT_WIRE_VERSION,
      createdAt: new Date().toISOString(),
    });

    const records = await p.readAll();
    expect(records).toHaveLength(2);
    expect(records[0]?.type).toBe("metadata");

    p.close();
  });
});

// ================================
describe("SessionStore", () => {
  test("create, get, list, delete", async () => {
    const store = new SessionStore();

    expect(store.list()).toHaveLength(0);

    const { sessionId, persistence } = await store.create({
      name: "Test",
      workspaceDirectory: "/tmp/test-ws",
      model: "test-model",
    });

    expect(sessionId.length).toBeGreaterThan(0);

    const meta = store.get(sessionId);
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe("Test");
    expect(meta!.workspaceDirectory).toBe("/tmp/test-ws");
    expect(meta!.model).toBe("test-model");

    expect(store.list()).toHaveLength(1);
    expect(store.list({ workspaceDirectory: "/tmp/test-ws" })).toHaveLength(1);
    expect(store.list({ workspaceDirectory: "/tmp/other" })).toHaveLength(0);

    persistence.close();
    await store.delete(sessionId);
    expect(store.list()).toHaveLength(0);
  });

  test("fork copies workspace and model", async () => {
    const store = new SessionStore();

    const { sessionId } = await store.create({
      name: "Original",
      workspaceDirectory: "/tmp/ws",
      model: "gpt-4",
    });

    const { sessionId: forkId } = await store.fork(sessionId, "Forked");
    const forkMeta = store.get(forkId);
    expect(forkMeta).not.toBeNull();
    expect(forkMeta!.name).toBe("Forked");
    expect(forkMeta!.workspaceDirectory).toBe("/tmp/ws");
    expect(forkMeta!.model).toBe("gpt-4");

    await store.delete(forkId);
    await store.delete(sessionId);
  });
});

// ================================
describe("Session Export/Import", () => {
  test("export and import round-trip", async () => {
    const store = new SessionStore();

    const { sessionId, persistence } = await store.create({
      name: "Export Test",
      model: "test-model",
    });

    persistence.append({ type: "turn.prompt", timestamp: "now", turnId: "t1", prompt: "export test" });
    persistence.flushSync();

    await store.refresh(sessionId);
    expect(store.get(sessionId)).not.toBeNull();

    const exportPath = join("/tmp", `test-export-${sessionId}.zip`);
    await exportSession(sessionId, exportPath);
    expect(existsSync(exportPath)).toBe(true);

    persistence.close();
    await store.delete(sessionId);
    expect(store.get(sessionId)).toBeNull();

    const imported = await importSession(exportPath);
    expect(imported.name).toBe("Export Test");
    expect(imported.model).toBe("test-model");

    const importedMeta = store.get(imported.id);
    expect(importedMeta).not.toBeNull();
    expect(importedMeta!.recordCount).toBeGreaterThanOrEqual(2);

    await store.delete(imported.id);
    try { rmSync(exportPath, { force: true }); } catch {}
  });
});