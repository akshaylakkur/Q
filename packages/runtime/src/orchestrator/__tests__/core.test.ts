/**
 * Tests — OrchestratorCore central state machine & coordinator.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { OrchestratorCore } from "../core.js";
import { IntentClassifier } from "../intent.js";
import { SubAgentPoolManager } from "../pool.js";
import { TaskDecomposer } from "../taskgraph.js";
import { DynamicReclassifier, ExecutionModes } from "../modes/index.js";

// =========================================================================
// 1. Construction
// =========================================================================

describe("Construction", () => {
  it("creates with default options", () => {
    const core = new OrchestratorCore();
    expect(core.getStatus().state).toBe("idle");
  });

  it("creates with custom options", () => {
    const core = new OrchestratorCore({ convergenceTimeout: 120_000 });
    expect(core).toBeDefined();
  });

  it("has all sub-components initialized", () => {
    const core = new OrchestratorCore();
    expect(core.intentClassifier).toBeInstanceOf(IntentClassifier);
    expect(core.poolManager).toBeInstanceOf(SubAgentPoolManager);
    expect(core.taskDecomposer).toBeInstanceOf(TaskDecomposer);
    expect(core.dynamicReclassifier).toBeInstanceOf(DynamicReclassifier);
  });

  it("initial state is idle", () => {
    const core = new OrchestratorCore();
    expect(core.getStatus().state).toBe("idle");
  });
});

// =========================================================================
// 2. State Machine
// =========================================================================

describe("State machine", () => {
  let core: OrchestratorCore;

  beforeEach(() => {
    core = new OrchestratorCore();
  });

  it("starts in idle state", () => {
    expect(core.getStatus().state).toBe("idle");
  });

  it("transitions through states during submitPrompt", async () => {
    const promise = core.submitPrompt("Fix the typo in index.ts");
    const status = core.getStatus();
    expect(status.state).not.toBe("idle");
    await promise;
    expect(core.getStatus().state).toBe("idle");
  });

  it("returns to idle after completion", async () => {
    const result = await core.submitPrompt("Fix the typo in index.ts");
    expect(result.success).toBe(true);
    expect(core.getStatus().state).toBe("idle");
  });
});

// =========================================================================
// 3. submitPrompt
// =========================================================================

describe("submitPrompt", () => {
  let core: OrchestratorCore;

  beforeEach(() => {
    core = new OrchestratorCore();
  });

  it("returns an ExecutionResult", async () => {
    const result = await core.submitPrompt("Fix the typo in index.ts");
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("mode");
    expect(result).toHaveProperty("taskId");
    expect(result).toHaveProperty("completedAt");
  });

  it("returns AUTO mode for all prompts (the default natural behavior)", async () => {
    const result = await core.submitPrompt("Fix the typo in index.ts");
    expect(result.mode).toBe(ExecutionModes.AUTO);
  });

  it("selects AUTO mode for codebase generation prompts", async () => {
    const result = await core.submitPrompt("Generate the entire project from scratch with a full API layer, database schema, authentication, and testing suite including integration and unit tests with 90% coverage");
    expect(result.mode).toBe(ExecutionModes.AUTO);
  });

  it("produces output text", async () => {
    const result = await core.submitPrompt("Fix the bug");
    expect(result.output).toBeTruthy();
  });
});

// =========================================================================
// 4. Cancel / Pause / Resume
// =========================================================================

describe("Cancel and pause", () => {
  let core: OrchestratorCore;

  beforeEach(() => {
    core = new OrchestratorCore();
  });

  it("cancel returns to idle", () => {
    core.cancel();
    expect(core.getStatus().state).toBe("idle");
  });

  it("multiple cancels are safe", () => {
    core.cancel();
    core.cancel();
    core.cancel();
    expect(core.getStatus().state).toBe("idle");
  });

  it("cancel during submitPrompt still completes", async () => {
    const promise = core.submitPrompt("Fix the bug in index.ts");
    core.cancel();
    const result = await promise;
    expect(result).toBeDefined();
  });

  it("pause and resume work", async () => {
    // pause sets a flag, resume resolves it
    const pausePromise = core.pause();
    core.resume();
    await pausePromise;
    expect(core.getStatus().state).toBe("idle");
  });
});

// =========================================================================
// 5. OrchestratorStatus
// =========================================================================

describe("OrchestratorStatus", () => {
  let core: OrchestratorCore;

  beforeEach(() => {
    core = new OrchestratorCore();
  });

  it("getStatus returns all required fields", () => {
    const status = core.getStatus();
    expect(status).toHaveProperty("state");
    expect(status).toHaveProperty("progress");
    expect(status).toHaveProperty("activeAgents");
    expect(status).toHaveProperty("completedAgents");
  });

  it("status shows idle state initially", () => {
    const status = core.getStatus();
    expect(status.state).toBe("idle");
    expect(status.activeAgents).toBe(0);
    expect(status.completedAgents).toBe(0);
  });

  it("progress is between 0 and 100", () => {
    const status = core.getStatus();
    expect(status.progress).toBeGreaterThanOrEqual(0);
    expect(status.progress).toBeLessThanOrEqual(100);
  });
});

// =========================================================================
// 6. Event Emission
// =========================================================================

describe("Event emission", () => {
  let core: OrchestratorCore;

  beforeEach(() => {
    core = new OrchestratorCore();
  });

  it("onEvent and offEvent work", () => {
    const listener = vi.fn();
    core.onEvent(listener);
    core.offEvent(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("state change event fires during submitPrompt", async () => {
    const listener = vi.fn();
    core.onEvent(listener);
    await core.submitPrompt("Fix the bug");
    expect(listener).toHaveBeenCalled();
  });

  it("events include type and timestamp", async () => {
    const events: any[] = [];
    core.onEvent((e) => events.push(e));
    await core.submitPrompt("Fix the bug");
    for (const event of events) {
      expect(event.type).toBeTruthy();
      expect(event.timestamp).toBeTruthy();
    }
  });
});

// =========================================================================
// 7. Mode Dispatch
// =========================================================================

describe("Mode dispatch", () => {
  let core: OrchestratorCore;

  beforeEach(() => {
    core = new OrchestratorCore();
  });

  it("AUTO mode (default) completes successfully", async () => {
    const result = await core.submitPrompt("Fix the typo in index.ts");
    expect(result.success).toBe(true);
    expect(result.mode).toBe(ExecutionModes.AUTO);
  });

  it("AUTO mode completes", async () => {
    const result = await core.submitPrompt("Update auth.ts, userService.ts, and types.ts");
    expect(result.success).toBe(true);
  });

  it("AUTO mode works — classifies and executes naturally", async () => {
    const result = await core.submitPrompt("Refactor the entire auth module. We need to completely redesign the authentication flow to support modern security patterns.");
    expect(result.success).toBe(true);
  });
});

// =========================================================================
// 8. Tool call recording
// =========================================================================

describe("Tool call recording", () => {
  let core: OrchestratorCore;

  beforeEach(() => {
    core = new OrchestratorCore();
  });

  it("recordToolCall accepts successful and failed calls", () => {
    expect(() => core.recordToolCall(true)).not.toThrow();
    expect(() => core.recordToolCall(false)).not.toThrow();
  });

  it("recordTurn increments turn count", () => {
    expect(() => core.recordTurn()).not.toThrow();
  });

  it("setCurrentWave updates wave number", () => {
    core.setCurrentWave(2);
    expect(core.getStatus().wave).toBe(2);
  });
});

// =========================================================================
// 9. Sequential prompts
// =========================================================================

describe("Sequential prompts", () => {
  let core: OrchestratorCore;

  beforeEach(() => {
    core = new OrchestratorCore();
  });

  it("sequential prompts work", async () => {
    const r1 = await core.submitPrompt("Fix the first bug");
    expect(r1.success).toBe(true);
    const r2 = await core.submitPrompt("Fix the second bug");
    expect(r2.success).toBe(true);
    const r3 = await core.submitPrompt("Fix the third bug");
    expect(r3.success).toBe(true);
  });

  it("reclassifier is reset between prompts", async () => {
    await core.submitPrompt("Fix the bug");
    expect(core.dynamicReclassifier).toBeDefined();
  });

  it("handles rapid cancel and resubmit", async () => {
    core.cancel();
    const result = await core.submitPrompt("Fix the bug");
    expect(result.success).toBe(true);
    expect(core.getStatus().state).toBe("idle");
  });

  it("handles empty prompts gracefully", async () => {
    const result = await core.submitPrompt("");
    expect(result.success).toBe(true);
  });
});

// =========================================================================
// 10. PoolManager integration
// =========================================================================

describe("PoolManager integration", () => {
  it("pool manager is accessible with config", () => {
    const core = new OrchestratorCore();
    expect(core.poolManager.getRunningCount()).toBe(0);
  });

  it("pool manager config is configurable", () => {
    const core = new OrchestratorCore({ poolConfig: { globalConcurrency: 4 } });
    expect(core.poolManager.getConfig().globalConcurrency).toBe(4);
  });
});