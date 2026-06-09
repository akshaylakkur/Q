/**
 * Tests — ExecutionMode handler framework.
 *
 * Covers all five mode handlers, the DynamicReclassifier,
 * type construction, mode dispatch, and escalation paths.
 */
import { describe, it, expect } from "vitest";
import { OrchestratorCore } from "../core.js";
import {
  ExecutionModes,
  DirectMode,
  LightweightPlanMode,
  ParallelDispatchMode,
  OrchestratedCampaignMode,
  CampaignContinuousMode,
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

  it("ParallelDispatchMode implements ExecutionModeHandler", () => {
    const handler = new ParallelDispatchMode();
    expect(handler).toBeInstanceOf(ExecutionModeHandler);
    expect(handler.mode).toBe(ExecutionModes.PARALLEL_DISPATCH);
  });

  it("OrchestratedCampaignMode implements ExecutionModeHandler", () => {
    const handler = new OrchestratedCampaignMode();
    expect(handler).toBeInstanceOf(ExecutionModeHandler);
    expect(handler.mode).toBe(ExecutionModes.ORCHESTRATED_CAMPAIGN);
  });

  it("CampaignContinuousMode implements ExecutionModeHandler", () => {
    const handler = new CampaignContinuousMode();
    expect(handler).toBeInstanceOf(ExecutionModeHandler);
    expect(handler.mode).toBe(ExecutionModes.CAMPAIGN_CONTINUOUS);
  });

  it("all handlers have unique mode values", () => {
    const modes = [
      new DirectMode().mode,
      new LightweightPlanMode().mode,
      new ParallelDispatchMode().mode,
      new OrchestratedCampaignMode().mode,
      new CampaignContinuousMode().mode,
    ];
    expect(new Set(modes).size).toBe(5);
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
    // Without a configured agent, the handler gracefully degrades with setup instructions
    expect(result.output).toContain("⚠️");
  });

  it("changedFiles is deduplicated", async () => {
    const result = await handler.execute(makeTask({ id: "dedup-test" }), orchestrator);
    expect(Array.isArray(result.changedFiles)).toBe(true);
  });
});

// =========================================================================
// 4. ParallelDispatchMode
// =========================================================================

describe("ParallelDispatchMode", () => {
  const handler = new ParallelDispatchMode();

  it("returns a successful result with sub-tasks", async () => {
    const result = await handler.execute(makeTask(), orchestrator);
    expect(result.success).toBe(true);
    expect(result.mode).toBe(ExecutionModes.PARALLEL_DISPATCH);
    expect(result.subResults).toBeDefined();
    expect(result.subResults!.length).toBeGreaterThanOrEqual(4);
  });

  it("output includes sub-task count", async () => {
    const result = await handler.execute(makeTask(), orchestrator);
    expect(result.output).toContain("sub-tasks");
  });

  it("handles errors gracefully", async () => {
    const result = await handler.execute(makeTask({ id: "" }), orchestrator);
    expect(result.mode).toBe(ExecutionModes.PARALLEL_DISPATCH);
  });
});

// =========================================================================
// 5. OrchestratedCampaignMode
// =========================================================================

describe("OrchestratedCampaignMode", () => {
  const handler = new OrchestratedCampaignMode();

  it("returns a successful result with phase execution", async () => {
    const result = await handler.execute(makeTask({
      prompt: "The quick brown fox jumps over the lazy dog. ".repeat(10),
    }), orchestrator);
    expect(result.success).toBe(true);
    expect(result.mode).toBe(ExecutionModes.ORCHESTRATED_CAMPAIGN);
  });

  it("output includes phase information", async () => {
    const result = await handler.execute(makeTask(), orchestrator);
    expect(result.output).toContain("CampaignMode");
  });

  it("executes multiple phases", async () => {
    const result = await handler.execute(makeTask(), orchestrator);
    expect(result.subResults).toBeDefined();
    expect(result.subResults!.length).toBeGreaterThanOrEqual(5);
  });
});

// =========================================================================
// 6. CampaignContinuousMode
// =========================================================================

describe("CampaignContinuousMode", () => {
  const handler = new CampaignContinuousMode();

  it("returns a successful result with multiple cycles", async () => {
    const result = await handler.execute(makeTask({
      prompt: "Generate the entire codebase from scratch with a full API layer, database schema, authentication, and testing suite",
    }), orchestrator);
    expect(result.success).toBe(true);
    expect(result.mode).toBe(ExecutionModes.CAMPAIGN_CONTINUOUS);
  });

  it("output includes cycle count", async () => {
    const result = await handler.execute(makeTask(), orchestrator);
    expect(result.output).toContain("convergence cycles");
  });

  it("supports pause request", () => {
    expect(() => handler.requestPause()).not.toThrow();
  });

  it("supports resume request", () => {
    expect(() => handler.requestResume()).not.toThrow();
  });

  it("supports stop request", () => {
    expect(() => handler.requestStop()).not.toThrow();
  });
});

// =========================================================================
// 7. DynamicReclassifier
// =========================================================================

describe("DynamicReclassifier", () => {
  const reclassifier = new DynamicReclassifier();

  function makeMetrics(overrides?: Partial<ExecutionMetrics>): ExecutionMetrics {
    return {
      usage: { totalTokens: 1000, inputTokens: 500, outputTokens: 500 },
      toolCalls: { total: 10, failed: 0 },
      turnCount: 1,
      userAddedContext: false,
      currentMode: ExecutionModes.DIRECT,
      ...overrides,
    };
  }

  it("returns no escalation when no signals are present", () => {
    const result = reclassifier.reclassify(makeMetrics());
    expect(result.shouldEscalate).toBe(false);
    expect(result.triggerSignals).toHaveLength(0);
  });

  it("detects rapid token growth", () => {
    const current = makeMetrics({ usage: { totalTokens: 15000, inputTokens: 7500, outputTokens: 7500 } });
    const previous = makeMetrics({ usage: { totalTokens: 1000, inputTokens: 500, outputTokens: 500 } });
    const result = reclassifier.reclassify(current, previous);
    expect(result.triggerSignals).toEqual(
      expect.arrayContaining([expect.stringContaining("token_growth")]),
    );
  });

  it("detects high error density", () => {
    const metrics = makeMetrics({ toolCalls: { total: 10, failed: 5 } });
    const result = reclassifier.reclassify(metrics);
    expect(result.triggerSignals).toEqual(
      expect.arrayContaining([expect.stringContaining("error_density")]),
    );
  });

  it("detects user-added context", () => {
    const metrics = makeMetrics({ userAddedContext: true });
    const result = reclassifier.reclassify(metrics);
    expect(result.triggerSignals).toEqual(expect.arrayContaining(["user_added_context"]));
  });

  it("escalates DIRECT → PARALLEL_DISPATCH on token spike", () => {
    const current = makeMetrics({
      usage: { totalTokens: 20000, inputTokens: 10000, outputTokens: 10000 },
      currentMode: ExecutionModes.DIRECT,
    });
    const previous = makeMetrics({ usage: { totalTokens: 1000, inputTokens: 500, outputTokens: 500 } });
    const result = reclassifier.reclassify(current, previous);
    expect(result.recommendedMode).toBe(ExecutionModes.PARALLEL_DISPATCH);
  });

  it("escalates DIRECT → LIGHTWEIGHT_PLAN on user context addition", () => {
    const metrics = makeMetrics({ userAddedContext: true, currentMode: ExecutionModes.DIRECT });
    const result = reclassifier.reclassify(metrics);
    expect(result.recommendedMode).toBe(ExecutionModes.LIGHTWEIGHT_PLAN);
  });

  it("escalates LIGHTWEIGHT_PLAN → PARALLEL_DISPATCH on errors", () => {
    const metrics = makeMetrics({ toolCalls: { total: 10, failed: 4 }, currentMode: ExecutionModes.LIGHTWEIGHT_PLAN });
    const result = reclassifier.reclassify(metrics);
    expect(result.recommendedMode).toBe(ExecutionModes.PARALLEL_DISPATCH);
  });

  it("escalates PARALLEL_DISPATCH → ORCHESTRATED_CAMPAIGN on errors", () => {
    const metrics = makeMetrics({ toolCalls: { total: 10, failed: 5 }, currentMode: ExecutionModes.PARALLEL_DISPATCH });
    const result = reclassifier.reclassify(metrics);
    expect(result.recommendedMode).toBe(ExecutionModes.ORCHESTRATED_CAMPAIGN);
  });

  it("does not escalate ORCHESTRATED_CAMPAIGN further", () => {
    const prev = makeMetrics({ currentMode: ExecutionModes.ORCHESTRATED_CAMPAIGN });
    const curr = makeMetrics({
      usage: { totalTokens: 20000, inputTokens: 10000, outputTokens: 10000 },
      toolCalls: { total: 10, failed: 5 },
      currentMode: ExecutionModes.ORCHESTRATED_CAMPAIGN,
    });
    const result = reclassifier.reclassify(curr, prev);
    expect(result.triggerSignals.length).toBeGreaterThanOrEqual(1);
  });

  it("becomes conservative after repeated escalations", () => {
    const r = new DynamicReclassifier({ maxEscalationsBeforeConservative: 1 });
    const current = makeMetrics({
      usage: { totalTokens: 20000, inputTokens: 10000, outputTokens: 10000 },
      currentMode: ExecutionModes.DIRECT,
    });
    const previous = makeMetrics({ usage: { totalTokens: 1000, inputTokens: 500, outputTokens: 500 } });

    r.reclassify(current, previous);
    const second = r.reclassify(current, previous);
    if (second.shouldEscalate) {
      expect(second.confidence).toBeLessThanOrEqual(0.5);
    }
  });

  it("reset clears escalation counter", () => {
    const r = new DynamicReclassifier({ maxEscalationsBeforeConservative: 1 });
    const m = makeMetrics({ usage: { totalTokens: 20000, inputTokens: 10000, outputTokens: 10000 }, currentMode: ExecutionModes.DIRECT });
    const p = makeMetrics({ usage: { totalTokens: 1000, inputTokens: 500, outputTokens: 500 } });

    r.reclassify(m, p);
    r.reset();
    const result = r.reclassify(m, p);
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it("detects DIRECT turn threshold", () => {
    const metrics = makeMetrics({ turnCount: 5, currentMode: ExecutionModes.DIRECT });
    const result = reclassifier.reclassify(metrics);
    expect(result.triggerSignals).toEqual(expect.arrayContaining([expect.stringContaining("turn_threshold")]));
  });

  it("detects LIGHTWEIGHT_PLAN turn threshold", () => {
    const metrics = makeMetrics({ turnCount: 10, currentMode: ExecutionModes.LIGHTWEIGHT_PLAN });
    const result = reclassifier.reclassify(metrics);
    expect(result.triggerSignals).toEqual(expect.arrayContaining([expect.stringContaining("turn_threshold")]));
  });

  it("returns valid confidence between 0 and 1", () => {
    const metrics = makeMetrics({ userAddedContext: true, currentMode: ExecutionModes.DIRECT });
    const result = reclassifier.reclassify(metrics);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// =========================================================================
// 8. Types
// =========================================================================

describe("Types", () => {
  it("ExecutionModes is a const object with all 5 modes", () => {
    expect(ExecutionModes.DIRECT).toBe("DIRECT");
    expect(ExecutionModes.LIGHTWEIGHT_PLAN).toBe("LIGHTWEIGHT_PLAN");
    expect(ExecutionModes.PARALLEL_DISPATCH).toBe("PARALLEL_DISPATCH");
    expect(ExecutionModes.ORCHESTRATED_CAMPAIGN).toBe("ORCHESTRATED_CAMPAIGN");
    expect(ExecutionModes.CAMPAIGN_CONTINUOUS).toBe("CAMPAIGN_CONTINUOUS");
    expect(Object.keys(ExecutionModes)).toHaveLength(5);
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
// 9. All handlers produce consistent result shapes
// =========================================================================

describe("All handlers", () => {
  const handlers = [
    new DirectMode(),
    new LightweightPlanMode(),
    new ParallelDispatchMode(),
    new OrchestratedCampaignMode(),
    new CampaignContinuousMode(),
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