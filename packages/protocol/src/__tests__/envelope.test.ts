import { describe, it, expect } from "vitest";
import {
  parseEnvelope,
  serializeEnvelope,
  isHeartbeat,
  isMetadata,
  isFileAudit,
  isSyncProgress,
  type NdjsonEnvelope,
  type ControlCommand,
  type CredentialPayload,
} from "../envelope.js";

describe("NdjsonEnvelope round-trip", () => {
  it("serializes and parses an agent event", () => {
    const env: NdjsonEnvelope = {
      seq: 1,
      ts: "2025-01-01T00:00:00.000Z",
      kind: "agent",
      type: "assistant.delta",
      delta: "hello",
      turnId: 0,
    };
    const line = serializeEnvelope(env);
    expect(line).toBe(
      '{"seq":1,"ts":"2025-01-01T00:00:00.000Z","kind":"agent","type":"assistant.delta","delta":"hello","turnId":0}',
    );
    const back = parseEnvelope(line);
    expect(back).not.toBeNull();
    expect(back!.seq).toBe(1);
    expect(back!.kind).toBe("agent");
    expect(back!.delta).toBe("hello");
  });

  it("returns null for empty or malformed lines", () => {
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("   ")).toBeNull();
    expect(parseEnvelope("{not json")).toBeNull();
  });

  it("round-trips a heartbeat", () => {
    const env: NdjsonEnvelope = {
      seq: 42,
      ts: "2025-01-01T00:00:05.000Z",
      kind: "system",
      type: "heartbeat",
      alive: true,
      uptimeMs: 5000,
      pid: 12345,
    };
    const back = parseEnvelope(serializeEnvelope(env));
    expect(back).not.toBeNull();
    expect(isHeartbeat(back!)).toBe(true);
    if (isHeartbeat(back!)) {
      expect(back.uptimeMs).toBe(5000);
    }
  });

  it("round-trips metadata", () => {
    const env: NdjsonEnvelope = {
      seq: 0,
      ts: "2025-01-01T00:00:00.000Z",
      kind: "system",
      type: "remote.metadata",
      host: "ec2-1-2-3-4",
      sessionId: "abc",
      workspace: "/home/ubuntu/q-workspace",
      nodeVersion: "v22.19.0",
      arch: "x64",
      platform: "linux",
      pid: 999,
      startedAt: "2025-01-01T00:00:00.000Z",
      mode: "auto",
    };
    const back = parseEnvelope(serializeEnvelope(env));
    expect(isMetadata(back!)).toBe(true);
  });

  it("round-trips a file audit event", () => {
    const env: NdjsonEnvelope = {
      seq: 10,
      ts: "2025-01-01T00:00:10.000Z",
      kind: "audit",
      type: "file.modify",
      path: "src/foo.ts",
      bytesAfter: 420,
    };
    const back = parseEnvelope(serializeEnvelope(env));
    expect(isFileAudit(back!)).toBe(true);
  });

  it("round-trips sync progress", () => {
    const env: NdjsonEnvelope = {
      seq: 20,
      ts: "2025-01-01T00:00:20.000Z",
      kind: "sync",
      type: "sync.progress",
      phase: "transfer",
      direction: "pull",
      current: 3,
      total: 10,
    };
    const back = parseEnvelope(serializeEnvelope(env));
    expect(isSyncProgress(back!)).toBe(true);
  });
});

describe("ControlCommand", () => {
  it("accepts a prompt command", () => {
    const cmd: ControlCommand = { cmd: "prompt", text: "hello", mode: "auto" };
    expect(cmd.cmd).toBe("prompt");
    expect(JSON.parse(JSON.stringify(cmd)).text).toBe("hello");
  });

  it("accepts a shutdown command", () => {
    const cmd: ControlCommand = { cmd: "shutdown" };
    expect(cmd.cmd).toBe("shutdown");
  });
});

describe("CredentialPayload", () => {
  it("serializes with optional fields", () => {
    const p: CredentialPayload = {
      provider: "openai",
      model: "gpt-4",
      apiKey: "sk-xxx",
      thinkingLevel: "medium",
    };
    const json = JSON.stringify(p);
    const back = JSON.parse(json) as CredentialPayload;
    expect(back.provider).toBe("openai");
    expect(back.thinkingLevel).toBe("medium");
  });
});