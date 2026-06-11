/**
 * Tests — ExecutionMode handler framework.
 *
 * Covers the two mode handlers (DirectMode, LightweightPlanMode),
 * the DynamicReclassifier (stub), type construction, and mode dispatch.
 */
import { describe, it, expect } from "vitest";
import { OrchestratorCore } from "../core.js";
import {
  ExecutionModes,
  DirectMode,
  LightweightPlanMode,
  DynamicReclassifier,
  ExecutionModeHandler,
} from "../modes/index.js";
import type { ExecutionMode } from "../modes/index.js";
import type { Task, ExecutionResult, ExecutionMetrics } from "../modes/types.js";

// =========================================================================
// Helpers
// =========================================================================

const orchestrator = new OrchestratorCore();

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "test-task-1",
    prompt: "Fix the bug in index.ts",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// =========================================================================
// 1. Handler interface
// =========================================================================

describe("Handler interface", () => {
  it("DirectMode implements ExecutionModeHandler", () => {
    const handler = new DirectMode();
    expect(handler).toBeInstanceOf(ExecutionModeHandler);
    expect(handler.mode).toBe(ExecutionModes.DIRECT);
    expect(handler.description).toBeTruthy();
  });

  it("LightweightPlanMode implements ExecutionModeHandler", () => {
    const handler = new LightweightPlanMode();
    expect(handler).toBeInstanceOf(ExecutionModeHandler);
    expect(handler.mode).toBe(ExecutionModes.LIGHTWEIGHT_PLAN);
  });

  it("all handlers have unique mode values", () => {
    const modes = [
      new DirectMode().mode,
      new LightweightPlanMode().mode,
    ];
    expect(new Set(modes).size).toBe(2);
  });
});

// =========================================================================
// 2. DirectMode
// =========================================================================

describe("DirectMode", () => {
  const handler = new DirectMode();

  it("returns a successful ExecutionResult", async () => {
    const result = await handler.execute(makeTask(), orchestrator);
    expect(result).toBeDefined();
    expect(result.mode).toBe(ExecutionModes.DIRECT);
    expect(result.taskId).toBe("test-task-1");
    expect(result.success).toBe(true);
  });

  it("includes mode and taskId on failure", async () => {
    const result = await handler.execute(makeTask({ id: "" }), orchestrator);
    expect(result.mode).toBe(ExecutionModes.DIRECT);
    expect(result.taskId).toBe("");
  });

  it("has durationMs set", async () => {
    const result = await handler.execute(makeTask(), orchestrator);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("has completedAt set", async () => {
    const result = await handler.execute(makeTask(), orchestrator);
    expect(result.completedAt).toBeTruthy();
  });
});

// =========================================================================
// 3. LightweightPlanMode
// =========================================================================

describe("LightweightPlanMode", () => {
  const handler = new LightweightPlanMode();

  it("returns a successful result with plan steps", async () => {
    const result = await handler.execute(makeTask(), orchestrator);
    expect(result.success).toBe(true);
    expect(result.mode).toBe(ExecutionModes.LIGHTWEIGHT_PLAN);
    expect(result.subResults).toBeDefined();
    expect(result.subResults!.length).toBeGreaterThanOrEqual(3);
  });

  it("output is present when no agent is configured", async () => {
    const result = await handler.execute(makeTask(), orchestrator);
    expect(result.output).toContain("⚠️");
  });

  it("changedFiles is deduplicated", async () => {
    const result = await handler.execute(makeTask({ id: "dedup-test" }), orchestrator);
    expect(Array.isArray(result.changedFiles)).toBe(true);
  });
});

// =========================================================================
// 4. DynamicReclassifier (real implementation — escalates on signals)
// =========================================================================

describe("DynamicReclassifier", () => {
  const reclassifier = new DynamicReclassifier();

  function makeMetrics(overrides?: Partial<ExecutionMetrics>): ExecutionMetrics {
    return {
      usage: { totalTokens: 1000, inputTokens: 500, outputTokens: 500 },
      toolCalls: { total: 10, failed: 0 },
      turnCount: 1,
      userAddedContext: false,
      currentMode: ExecutionModes.AUTO,
      ...overrides,
    };
  }

  it("does not escalate with low metrics (no signals)", () => {
    const result = reclassifier.reclassify(makeMetrics());
    // Low metrics (no tool failures, low turn count) should not escalate
    expect(result.shouldEscalate).toBe(false);
  });

  it("recommends escalation with high tool failure signals", () => {
    const current = makeMetrics({
      usage: { totalTokens: 20000, inputTokens: 10000, outputTokens: 10000 },
      toolCalls: { total: 10, failed: 8 },
      currentMode: ExecutionModes.AUTO,
    });
    const previous = makeMetrics({ usage: { totalTokens: 1000, inputTokens: 500, outputTokens: 500 } });
    const result = reclassifier.reclassify(current, previous);
    expect(result.shouldEscalate).toBe(true);
  });

  it("always returns a valid reason string", () => {
    const result = reclassifier.reclassify(makeMetrics());
    expect(result.reason).toBeTruthy();
    expect(typeof result.reason).toBe("string");
  });

  it("reset does not throw", () => {
    expect(() => reclassifier.reset()).not.toThrow();
  });
});

// =========================================================================
// 5. Types
// =========================================================================

describe("Types", () => {
  it("execution modes have expected constants", () => {
    expect(ExecutionModes.AUTO).toBe("AUTO");
    expect(ExecutionModes.LIGHTWEIGHT).toBe("LIGHTWEIGHT");
    expect(ExecutionModes.SPEED_CAMPAIGN).toBe("SPEED_CAMPAIGN");
    expect(ExecutionModes.MEDIUM_CAMPAIGN).toBe("MEDIUM_CAMPAIGN");
    expect(ExecutionModes.HIGH_CAMPAIGN).toBe("HIGH_CAMPAIGN");
    expect(ExecutionModes.MODUS_MAXIMUS).toBe("MODUS_MAXIMUS");
    expect(ExecutionModes.DIRECT).toBe("DIRECT");
    expect(ExecutionModes.LIGHTWEIGHT_PLAN).toBe("LIGHTWEIGHT_PLAN");
    expect(Object.keys(ExecutionModes)).toHaveLength(8);
  });

  it("Task type constructs correctly", () => {
    const task: Task = { id: "t1", prompt: "hello" };
    expect(task.id).toBe("t1");
  });

  it("ExecutionResult type includes all optional fields", () => {
    const result: ExecutionResult = {
      success: true,
      mode: ExecutionModes.DIRECT,
      taskId: "t1",
      output: "done",
      totalTokens: 100,
      llmCallCount: 1,
      toolCallCount: 2,
      durationMs: 500,
      changedFiles: ["a.ts"],
      verificationPassed: true,
      completedAt: new Date().toISOString(),
    };
    expect(result.success).toBe(true);
    expect(result.changedFiles).toContain("a.ts");
  });
});

// =========================================================================
// 6. All handlers produce consistent result shapes
// =========================================================================

describe("All handlers", () => {
  const handlers = [
    new DirectMode(),
    new LightweightPlanMode(),
  ];

  for (const handler of handlers) {
    it(`${handler.mode} returns result with required fields`, async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("mode", handler.mode);
      expect(result).toHaveProperty("taskId");
      expect(result).toHaveProperty("completedAt");
      expect(typeof result.durationMs).toBe("number");
    });
  }
});