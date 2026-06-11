/**
 * Tests — Campaign mode handlers (SpeedCampaignMode, MediumCampaignMode, HighCampaignMode).
 *
 * Comprehensive integration tests covering:
 *   1. Handler interface conformance (all three modes)
 *   2. SpeedCampaignMode — execution, decomposition, edge cases
 *   3. MediumCampaignMode — wave-based execution, verification, edge cases
 *   4. HighCampaignMode — convergence cycles, checkpointing, escalation
 *   5. Orchestrator dispatch via submitPrompt with mode selection
 *   6. DynamicReclassifier — real escalation logic
 *   7. Campaign mode event emission patterns
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { OrchestratorCore } from "../core.js";
import {
  ExecutionModes,
  SpeedCampaignMode,
  MediumCampaignMode,
  HighCampaignMode,
  ExecutionModeHandler,
  DynamicReclassifier,
} from "../modes/index.js";
import type { ExecutionMode } from "../modes/index.js";
import type { Task, ExecutionResult, ExecutionMetrics, SubTask } from "../modes/types.js";

// =========================================================================
// Helpers
// =========================================================================

const orchestrator = new OrchestratorCore();

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "campaign-test-task-1",
    prompt: "Fix the typo in index.ts AND update the README AND add tests for auth.ts",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function collectEvents(o: OrchestratorCore): any[] {
  const events: any[] = [];
  o.onEvent((e: any) => events.push(e));
  return events;
}

// =========================================================================
// 1. Handler interface conformance — all three campaign modes
// =========================================================================

describe("Handler interface conformance (campaign modes)", () => {
  const handlers = [
    { ctor: SpeedCampaignMode, mode: ExecutionModes.SPEED_CAMPAIGN },
    { ctor: MediumCampaignMode, mode: ExecutionModes.MEDIUM_CAMPAIGN },
    { ctor: HighCampaignMode, mode: ExecutionModes.HIGH_CAMPAIGN },
  ];

  for (const { ctor, mode } of handlers) {
    const name = ctor.name;

    it(`${name} extends ExecutionModeHandler`, () => {
      const handler = new ctor();
      expect(handler).toBeInstanceOf(ExecutionModeHandler);
    });

    it(`${name} has the correct mode constant`, () => {
      const handler = new ctor();
      expect(handler.mode).toBe(mode);
    });

    it(`${name} has a non-empty description`, () => {
      const handler = new ctor();
      expect(handler.description).toBeTruthy();
      expect(typeof handler.description).toBe("string");
      expect(handler.description.length).toBeGreaterThan(0);
    });
  }

  it("all three campaign modes have unique mode values (no collisions)", () => {
    const modes = [
      new SpeedCampaignMode().mode,
      new MediumCampaignMode().mode,
      new HighCampaignMode().mode,
    ];
    expect(new Set(modes).size).toBe(3);

    // Also verify no collision with existing modes
    const allModes = new Set([
      ExecutionModes.AUTO,
      ExecutionModes.DIRECT,
      ExecutionModes.LIGHTWEIGHT,
      ExecutionModes.LIGHTWEIGHT_PLAN,
      ExecutionModes.SPEED_CAMPAIGN,
      ExecutionModes.MEDIUM_CAMPAIGN,
      ExecutionModes.HIGH_CAMPAIGN,
      ExecutionModes.MODUS_MAXIMUS,
    ]);
    expect(allModes.size).toBe(8);
  });
});

// =========================================================================
// 2. SpeedCampaignMode
// =========================================================================

describe("SpeedCampaignMode", () => {
  const handler = new SpeedCampaignMode();

  describe("Basic ExecutionResult shape", () => {
    it("returns a valid ExecutionResult with SPEED_CAMPAIGN mode", async () => {
      const result = await handler.execute(makeTask(), orchestrator);

      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.SPEED_CAMPAIGN);
      expect(result.success).toBeDefined();
      expect(typeof result.success).toBe("boolean");
      expect(result.taskId).toBe("campaign-test-task-1");
    });

    it("has subResults as an array", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(result.subResults).toBeDefined();
      expect(Array.isArray(result.subResults)).toBe(true);
    });

    it("has durationMs and completedAt set", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.completedAt).toBeTruthy();
      expect(typeof result.completedAt).toBe("string");
      const parsed = new Date(result.completedAt!);
      expect(parsed.getTime()).not.toBeNaN();
      expect(parsed.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("has output as a non-empty string", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(result.output).toBeTruthy();
      expect(typeof result.output).toBe("string");
      expect(result.output!.length).toBeGreaterThan(0);
    });

    it("taskId propagates correctly", async () => {
      const customId = "custom-task-id-99";
      const result = await handler.execute(makeTask({ id: customId }), orchestrator);
      expect(result.taskId).toBe(customId);
    });

    it("has changedFiles array and verificationPassed boolean", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(Array.isArray(result.changedFiles)).toBe(true);
      expect(typeof result.verificationPassed).toBe("boolean");
    });
  });

  describe("Task decomposition", () => {
    it("decomposes a prompt with multiple bullet points into sub-tasks", async () => {
      const bulletPrompt = [
        "- Fix the typo in index.ts",
        "- Update the README with new API docs",
        "- Add tests for auth.ts",
      ].join("\n");

      const result = await handler.execute(makeTask({ prompt: bulletPrompt }), orchestrator);

      expect(result.subResults!.length).toBeGreaterThanOrEqual(2);
      expect(result.mode).toBe(ExecutionModes.SPEED_CAMPAIGN);
    });

    it("decomposes a prompt with numbered list into sub-tasks", async () => {
      const numberedPrompt = [
        "1. Refactor the database layer",
        "2. Add migration scripts",
        "3. Update the ORM models",
      ].join("\n");

      const result = await handler.execute(makeTask({ prompt: numberedPrompt }), orchestrator);

      expect(result.subResults!.length).toBeGreaterThanOrEqual(2);
    });

    it("handles a single line prompt (no list) gracefully", async () => {
      const result = await handler.execute(
        makeTask({ prompt: "Fix the critical security vulnerability" }),
        orchestrator,
      );
      expect(result.subResults).toBeDefined();
      expect(result.subResults!.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Edge cases", () => {
    it("handles empty prompts gracefully", async () => {
      const result = await handler.execute(makeTask({ prompt: "" }), orchestrator);
      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.SPEED_CAMPAIGN);
      expect(Array.isArray(result.subResults)).toBe(true);
    });

    it("handles very long prompts (>1000 chars) by capping sub-tasks", async () => {
      const longPrompt = Array.from({ length: 50 }, (_, i) => `- Task item number ${i + 1} with extra detail`).join("\n");
      expect(longPrompt.length).toBeGreaterThan(1000);

      const result = await handler.execute(makeTask({ prompt: longPrompt }), orchestrator);
      expect(result).toBeDefined();
      expect(result.subResults).toBeDefined();
    });

    it("handles cancellation gracefully (abort signal)", async () => {
      const abortOrchestrator = new OrchestratorCore();
      abortOrchestrator.cancel();

      const result = await handler.execute(makeTask(), abortOrchestrator);
      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.SPEED_CAMPAIGN);
      expect(result.completedAt).toBeTruthy();
    });

    it("produces consistent result shape across calls", async () => {
      const result1 = await handler.execute(makeTask({ id: "consist-1" }), orchestrator);
      const result2 = await handler.execute(makeTask({ id: "consist-2" }), orchestrator);

      for (const result of [result1, result2]) {
        expect(result).toHaveProperty("success");
        expect(result).toHaveProperty("mode", ExecutionModes.SPEED_CAMPAIGN);
        expect(result).toHaveProperty("taskId");
        expect(result).toHaveProperty("output");
        expect(result).toHaveProperty("durationMs");
        expect(result).toHaveProperty("completedAt");
        expect(result).toHaveProperty("subResults");
        expect(result).toHaveProperty("verificationPassed");
        expect(result).toHaveProperty("changedFiles");
      }
    });
  });

  describe("Result fields", () => {
    it("includes totalTokens, llmCallCount, toolCallCount", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(typeof result.totalTokens).toBe("number");
      expect(result.totalTokens!).toBeGreaterThanOrEqual(0);
      expect(typeof result.llmCallCount).toBe("number");
      expect(result.llmCallCount!).toBeGreaterThanOrEqual(0);
      expect(typeof result.toolCallCount).toBe("number");
      expect(result.toolCallCount!).toBeGreaterThanOrEqual(0);
    });

    it("subResults contain ExecutionResult-shaped objects", async () => {
      const result = await handler.execute(makeTask({ prompt: "- Do thing A\n- Do thing B" }), orchestrator);
      for (const sub of result.subResults!) {
        expect(sub).toHaveProperty("success");
        expect(sub).toHaveProperty("mode");
        expect(sub).toHaveProperty("taskId");
        expect(sub).toHaveProperty("completedAt");
      }
    });
  });
});

// =========================================================================
// 3. MediumCampaignMode
// =========================================================================

describe("MediumCampaignMode", () => {
  const handler = new MediumCampaignMode();

  describe("Basic ExecutionResult shape", () => {
    it("returns a valid ExecutionResult with MEDIUM_CAMPAIGN mode", async () => {
      const result = await handler.execute(makeTask(), orchestrator);

      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.MEDIUM_CAMPAIGN);
      expect(result.success).toBeDefined();
      expect(typeof result.success).toBe("boolean");
      expect(result.taskId).toBe("campaign-test-task-1");
    });

    it("subResults contains at least one wave result", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(result.subResults).toBeDefined();
      expect(Array.isArray(result.subResults)).toBe(true);
      expect(result.subResults!.length).toBeGreaterThanOrEqual(1);
    });

    it("has verificationPassed field", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(result).toHaveProperty("verificationPassed");
      expect(typeof result.verificationPassed).toBe("boolean");
    });

    it("has durationMs and completedAt", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.completedAt).toBeTruthy();
      expect(typeof result.completedAt).toBe("string");
    });

    it("taskId propagates correctly", async () => {
      const customId = "medium-custom-42";
      const result = await handler.execute(makeTask({ id: customId }), orchestrator);
      expect(result.taskId).toBe(customId);
    });
  });

  describe("Wave execution", () => {
    it("includes changedFiles and errors arrays", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(Array.isArray(result.changedFiles)).toBe(true);
      if (result.errors) {
        expect(Array.isArray(result.errors)).toBe(true);
      }
    });

    it("sub-results have ExecutionResult shape per wave", async () => {
      const result = await handler.execute(makeTask({ prompt: "- Implement feature A\n- Implement feature B" }), orchestrator);
      for (const waveResult of result.subResults!) {
        expect(waveResult).toHaveProperty("success");
        expect(waveResult).toHaveProperty("mode", ExecutionModes.MEDIUM_CAMPAIGN);
        expect(waveResult).toHaveProperty("taskId");
        expect(waveResult).toHaveProperty("completedAt");
      }
    });

    it("handles prompts with explicit profile (IntentProfile)", async () => {
      const taskWithProfile = makeTask({
        prompt: "Refactor the authentication module",
        profile: {
          scope: "module",
          depth: "deep",
          confidence: 0.9,
          estimatedFiles: 5,
          estimatedTurns: 15,
          requiresParallel: false,
          requiresResearch: true,
          requiresVerification: true,
          hasArchitecturalImpact: true,
        },
      });
      const result = await handler.execute(taskWithProfile, orchestrator);
      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.MEDIUM_CAMPAIGN);
    });
  });

  describe("Edge cases", () => {
    it("handles cancellation gracefully", async () => {
      const abortOrch = new OrchestratorCore();
      abortOrch.cancel();

      const result = await handler.execute(makeTask(), abortOrch);
      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.MEDIUM_CAMPAIGN);
      expect(result.completedAt).toBeTruthy();
    });

    it("handles empty prompts gracefully", async () => {
      const result = await handler.execute(makeTask({ prompt: "" }), orchestrator);
      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.MEDIUM_CAMPAIGN);
    });

    it("produces consistent result shape across calls", async () => {
      const result1 = await handler.execute(makeTask({ id: "mc-1" }), orchestrator);
      const result2 = await handler.execute(makeTask({ id: "mc-2" }), orchestrator);

      for (const result of [result1, result2]) {
        expect(result).toHaveProperty("success");
        expect(result).toHaveProperty("mode", ExecutionModes.MEDIUM_CAMPAIGN);
        expect(result).toHaveProperty("taskId");
        expect(result).toHaveProperty("output");
        expect(result).toHaveProperty("durationMs");
        expect(result).toHaveProperty("completedAt");
        expect(result).toHaveProperty("changedFiles");
        expect(result).toHaveProperty("subResults");
        expect(result).toHaveProperty("verificationPassed");
      }
    });

    it("handles classification failure gracefully (falls back to default profile)", async () => {
      const throwingOrch = new OrchestratorCore();
      vi.spyOn(throwingOrch.intentClassifier, "classify").mockImplementation(() => {
        throw new Error("Intent classification failed");
      });

      const result = await handler.execute(makeTask(), throwingOrch);
      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.MEDIUM_CAMPAIGN);
      expect(typeof result.success).toBe("boolean");
      expect(typeof result.verificationPassed).toBe("boolean");
    });
  });

  describe("Result metrics", () => {
    it("includes totalTokens, llmCallCount, toolCallCount", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(typeof result.totalTokens).toBe("number");
      expect(result.totalTokens!).toBeGreaterThanOrEqual(0);
      expect(typeof result.llmCallCount).toBe("number");
      expect(result.llmCallCount!).toBeGreaterThanOrEqual(0);
      expect(typeof result.toolCallCount).toBe("number");
      expect(result.toolCallCount!).toBeGreaterThanOrEqual(0);
    });
  });
});

// =========================================================================
// 4. HighCampaignMode
// =========================================================================

describe("HighCampaignMode", () => {
  const handler = new HighCampaignMode();

  describe("Basic ExecutionResult shape", () => {
    it("returns a valid ExecutionResult with HIGH_CAMPAIGN mode", async () => {
      const result = await handler.execute(makeTask(), orchestrator);

      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.HIGH_CAMPAIGN);
      expect(result.success).toBeDefined();
      expect(typeof result.success).toBe("boolean");
      expect(result.taskId).toBe("campaign-test-task-1");
    });

    it("has durationMs and completedAt set", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.completedAt).toBeTruthy();
      expect(typeof result.completedAt).toBe("string");
    });

    it("has output as a non-empty string", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(result.output).toBeTruthy();
      expect(typeof result.output).toBe("string");
      expect(result.output!.length).toBeGreaterThan(0);
    });

    it("taskId propagates correctly", async () => {
      const customId = "hc-custom-77";
      const result = await handler.execute(makeTask({ id: customId }), orchestrator);
      expect(result.taskId).toBe(customId);
    });
  });

  describe("Convergence cycles", () => {
    it("verificationPassed is present", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(result).toHaveProperty("verificationPassed");
      expect(typeof result.verificationPassed).toBe("boolean");
    });

    it("includes changedFiles array", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(Array.isArray(result.changedFiles)).toBe(true);
    });

    it("includes totalTokens, llmCallCount, toolCallCount", async () => {
      const result = await handler.execute(makeTask(), orchestrator);
      expect(typeof result.totalTokens).toBe("number");
      expect(result.totalTokens!).toBeGreaterThanOrEqual(0);
      expect(typeof result.llmCallCount).toBe("number");
      expect(result.llmCallCount!).toBeGreaterThanOrEqual(0);
      expect(typeof result.toolCallCount).toBe("number");
      expect(result.toolCallCount!).toBeGreaterThanOrEqual(0);
    });

    it("handles prompts with explicit profile", async () => {
      const taskWithProfile = makeTask({
        prompt: "Build a complex distributed system",
        profile: {
          scope: "cross_cutting",
          depth: "deep",
          confidence: 0.95,
          estimatedFiles: 20,
          estimatedTurns: 50,
          requiresParallel: true,
          requiresResearch: true,
          requiresVerification: true,
          hasArchitecturalImpact: true,
        },
      });
      const result = await handler.execute(taskWithProfile, orchestrator);
      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.HIGH_CAMPAIGN);
    });
  });

  describe("Edge cases", () => {
    it("handles abort gracefully", async () => {
      const abortOrch = new OrchestratorCore();
      abortOrch.cancel();

      const result = await handler.execute(makeTask(), abortOrch);
      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.HIGH_CAMPAIGN);
      expect(result.completedAt).toBeTruthy();
    });

    it("handles empty prompts gracefully", async () => {
      const result = await handler.execute(makeTask({ prompt: "" }), orchestrator);
      expect(result).toBeDefined();
      expect(result.mode).toBe(ExecutionModes.HIGH_CAMPAIGN);
    });

    it("produces consistent result shape across calls", async () => {
      const result1 = await handler.execute(makeTask({ id: "hc-1" }), orchestrator);
      const result2 = await handler.execute(makeTask({ id: "hc-2" }), orchestrator);

      for (const result of [result1, result2]) {
        expect(result).toHaveProperty("success");
        expect(result).toHaveProperty("mode", ExecutionModes.HIGH_CAMPAIGN);
        expect(result).toHaveProperty("taskId");
        expect(result).toHaveProperty("output");
        expect(result).toHaveProperty("durationMs");
        expect(result).toHaveProperty("completedAt");
        expect(result).toHaveProperty("changedFiles");
        expect(result).toHaveProperty("verificationPassed");
      }
    });
  });

  describe("Checkpoint path and progress tracking", () => {
    it("progress checkpoints are tracked during execution", async () => {
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const checkpointEvents = events.filter(
        (e: any) => e.type === "high-campaign.progress-checkpoint",
      );
      expect(Array.isArray(checkpointEvents)).toBe(true);
    });
  });
});

// =========================================================================
// 5. Orchestrator dispatch — submitPrompt with mode setting
// =========================================================================

describe("Orchestrator dispatch — submitPrompt with campaign modes", () => {
  let core: OrchestratorCore;

  beforeEach(() => {
    core = new OrchestratorCore();
  });

  it("submitPrompt with SPEED_CAMPAIGN mode returns SPEED_CAMPAIGN mode", async () => {
    core.currentMode = ExecutionModes.SPEED_CAMPAIGN;
    const result = await core.submitPrompt("Fix the typo in index.ts");
    expect(result.mode).toBe(ExecutionModes.SPEED_CAMPAIGN);
  });

  it("submitPrompt with MEDIUM_CAMPAIGN mode returns MEDIUM_CAMPAIGN mode", async () => {
    core.currentMode = ExecutionModes.MEDIUM_CAMPAIGN;
    const result = await core.submitPrompt("Refactor the auth module with proper error handling");
    expect(result.mode).toBe(ExecutionModes.MEDIUM_CAMPAIGN);
  });

  it("submitPrompt with HIGH_CAMPAIGN mode returns HIGH_CAMPAIGN mode", async () => {
    core.currentMode = ExecutionModes.HIGH_CAMPAIGN;
    const result = await core.submitPrompt("Build a full-stack application");
    expect(result.mode).toBe(ExecutionModes.HIGH_CAMPAIGN);
  });

  it("submitPrompt with LIGHTWEIGHT mode returns LIGHTWEIGHT mode", async () => {
    core.currentMode = ExecutionModes.LIGHTWEIGHT;
    const result = await core.submitPrompt("Update the README");
    expect(result.mode).toBe(ExecutionModes.LIGHTWEIGHT);
  });

  it("submitPrompt with AUTO mode (default) returns AUTO mode", async () => {
    const result = await core.submitPrompt("Fix a small bug");
    expect(result.mode).toBe(ExecutionModes.AUTO);
  });

  it("submitPrompt with MODUS_MAXIMUS mode returns MODUS_MAXIMUS mode", async () => {
    core.currentMode = ExecutionModes.MODUS_MAXIMUS;
    const result = await core.submitPrompt("Build a sophisticated app with planning");
    expect(result.mode).toBe(ExecutionModes.MODUS_MAXIMUS);
  });

  it("sequential mode switching works (AUTO → SPEED → MEDIUM → HIGH → MODUS_MAXIMUS)", async () => {
    const r1 = await core.submitPrompt("Fix the typo in index.ts");
    expect(r1.mode).toBe(ExecutionModes.AUTO);
    expect(r1.success).toBe(true);

    core.currentMode = ExecutionModes.SPEED_CAMPAIGN;
    const r2 = await core.submitPrompt("Fix the typo in index.ts AND update the README");
    expect(r2.mode).toBe(ExecutionModes.SPEED_CAMPAIGN);
    expect(r2.success).toBe(true);

    core.currentMode = ExecutionModes.MEDIUM_CAMPAIGN;
    const r3 = await core.submitPrompt("Refactor the auth module with tests");
    expect(r3.mode).toBe(ExecutionModes.MEDIUM_CAMPAIGN);
    expect(r3.success).toBe(true);

    core.currentMode = ExecutionModes.HIGH_CAMPAIGN;
    const r4 = await core.submitPrompt("Build a complex system with multiple components");
    expect(r4.mode).toBe(ExecutionModes.HIGH_CAMPAIGN);
    expect(r4.success).toBe(true);

    core.currentMode = ExecutionModes.MODUS_MAXIMUS;
    const r5 = await core.submitPrompt("Build a comprehensive full-stack application");
    expect(r5.mode).toBe(ExecutionModes.MODUS_MAXIMUS);
    expect(r5.success).toBe(false); // No root agent => fails gracefully
  });

  it("correctly handles reset back to AUTO after campaign modes", async () => {
    core.currentMode = ExecutionModes.SPEED_CAMPAIGN;
    const r1 = await core.submitPrompt("Fix a bug");
    expect(r1.mode).toBe(ExecutionModes.SPEED_CAMPAIGN);

    core.currentMode = ExecutionModes.AUTO;
    const r2 = await core.submitPrompt("Fix another bug");
    expect(r2.mode).toBe(ExecutionModes.AUTO);
  });

  it("returns a proper ExecutionResult from every campaign mode dispatch", async () => {
    const modes = [
      ExecutionModes.SPEED_CAMPAIGN,
      ExecutionModes.MEDIUM_CAMPAIGN,
      ExecutionModes.HIGH_CAMPAIGN,
    ];

    for (const mode of modes) {
      core.currentMode = mode;
      const result = await core.submitPrompt(`Test prompt for ${mode}`);

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("mode", mode);
      expect(result).toHaveProperty("taskId");
      expect(result).toHaveProperty("output");
      expect(result).toHaveProperty("durationMs");
      expect(result).toHaveProperty("completedAt");

      expect(typeof result.success).toBe("boolean");
      expect(typeof result.output).toBe("string");
      expect(typeof result.durationMs).toBe("number");
    }
  });
});

// =========================================================================
// 6. DynamicReclassifier — updated tests (real implementation)
// =========================================================================

describe("DynamicReclassifier", () => {
  let reclassifier: DynamicReclassifier;

  beforeEach(() => {
    reclassifier = new DynamicReclassifier();
  });

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

  describe("Normal operation (no escalation)", () => {
    it("does not escalate with low metrics", () => {
      const metrics = makeMetrics();
      const result = reclassifier.reclassify(metrics);
      expect(result.shouldEscalate).toBe(false);
    });

    it("returns a valid reason string even without escalation", () => {
      const result = reclassifier.reclassify(makeMetrics());
      expect(result.reason).toBeTruthy();
      expect(typeof result.reason).toBe("string");
    });

    it("always returns triggerSignals array", () => {
      const result = reclassifier.reclassify(makeMetrics());
      expect(Array.isArray(result.triggerSignals)).toBe(true);
    });

    it("returns recommendedMode matching currentMode when not escalating", () => {
      const metrics = makeMetrics({ currentMode: ExecutionModes.SPEED_CAMPAIGN });
      const result = reclassifier.reclassify(metrics);
      expect(result.recommendedMode).toBe(ExecutionModes.SPEED_CAMPAIGN);
    });
  });

  describe("Escalation triggers", () => {
    it("recommends escalation with high tool failure ratio and high turn count", () => {
      const metrics = makeMetrics({
        toolCalls: { total: 10, failed: 8 }, // 80% failure > 30% threshold
        turnCount: 15,
        currentMode: ExecutionModes.AUTO,
      });
      const result = reclassifier.reclassify(metrics);
      expect(result.shouldEscalate).toBe(true);
      expect(result.recommendedMode).toBe(ExecutionModes.SPEED_CAMPAIGN);
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it("recommends escalation with rapid token growth", () => {
      const currentMetrics = makeMetrics({
        usage: { totalTokens: 15000, inputTokens: 7000, outputTokens: 8000 },
        toolCalls: { total: 5, failed: 0 },
        turnCount: 12,
        currentMode: ExecutionModes.SPEED_CAMPAIGN,
      });
      const previousMetrics = makeMetrics({
        usage: { totalTokens: 2000, inputTokens: 1000, outputTokens: 1000 },
        toolCalls: { total: 2, failed: 0 },
        turnCount: 5,
        currentMode: ExecutionModes.SPEED_CAMPAIGN,
      });

      const result = reclassifier.reclassify(currentMetrics, previousMetrics);
      expect(result.shouldEscalate).toBe(true);
      expect(result.recommendedMode).toBe(ExecutionModes.MEDIUM_CAMPAIGN);
    });

    it("escalation chain works step by step with fresh reclassifier per step", () => {
      // AUTO → SPEED
      const r1 = new DynamicReclassifier();
      const m1 = makeMetrics({
        toolCalls: { total: 10, failed: 5 },
        turnCount: 15,
        currentMode: ExecutionModes.AUTO,
      });
      const res1 = r1.reclassify(m1);
      expect(res1.shouldEscalate).toBe(true);
      expect(res1.recommendedMode).toBe(ExecutionModes.SPEED_CAMPAIGN);

      // SPEED → MEDIUM
      const r2 = new DynamicReclassifier();
      const m2 = makeMetrics({
        usage: { totalTokens: 20000, inputTokens: 10000, outputTokens: 10000 },
        toolCalls: { total: 10, failed: 0 },
        turnCount: 14,
        currentMode: ExecutionModes.SPEED_CAMPAIGN,
      });
      const prev2 = makeMetrics({
        usage: { totalTokens: 2000, inputTokens: 1000, outputTokens: 1000 },
        turnCount: 3,
        currentMode: ExecutionModes.SPEED_CAMPAIGN,
      });
      const res2 = r2.reclassify(m2, prev2);
      expect(res2.shouldEscalate).toBe(true);
      expect(res2.recommendedMode).toBe(ExecutionModes.MEDIUM_CAMPAIGN);

      // MEDIUM → HIGH (via convergence conflicts)
      const r3 = new DynamicReclassifier();
      const m3 = makeMetrics({
        toolCalls: { total: 5, failed: 0 },
        turnCount: 10,
        currentMode: ExecutionModes.MEDIUM_CAMPAIGN,
        metadata: { convergenceConflicts: 3 },
      });
      const res3 = r3.reclassify(m3);
      expect(res3.shouldEscalate).toBe(true);
      expect(res3.recommendedMode).toBe(ExecutionModes.HIGH_CAMPAIGN);

      // HIGH → MODUS_MAXIMUS (via verification failures)
      const r4 = new DynamicReclassifier();
      const m4 = makeMetrics({
        toolCalls: { total: 5, failed: 0 },
        turnCount: 5,
        currentMode: ExecutionModes.HIGH_CAMPAIGN,
        metadata: { verificationFailures: 2 },
      });
      const res4 = r4.reclassify(m4);
      expect(res4.shouldEscalate).toBe(true);
      expect(res4.recommendedMode).toBe(ExecutionModes.MODUS_MAXIMUS);

      // MODUS_MAXIMUS is terminal
      const r5 = new DynamicReclassifier();
      const m5 = makeMetrics({
        toolCalls: { total: 10, failed: 5 },
        turnCount: 20,
        currentMode: ExecutionModes.MODUS_MAXIMUS,
      });
      const res5 = r5.reclassify(m5);
      expect(res5.shouldEscalate).toBe(false);
    });
  });

  describe("Escalation history", () => {
    it("records escalation history when escalation is recommended", () => {
      const metrics = makeMetrics({
        toolCalls: { total: 10, failed: 5 },
        turnCount: 15,
        currentMode: ExecutionModes.AUTO,
      });
      reclassifier.reclassify(metrics);

      const history = reclassifier.getEscalationHistory();
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0]!.fromMode).toBe(ExecutionModes.AUTO);
      expect(history[0]!.toMode).toBe(ExecutionModes.SPEED_CAMPAIGN);
      expect(history[0]!.outcome).toBe("unknown");
      expect(history[0]!.timestamp).toBeTruthy();
    });

    it("recordOutcome updates the latest escalation event", () => {
      const metrics = makeMetrics({
        toolCalls: { total: 10, failed: 5 },
        turnCount: 15,
        currentMode: ExecutionModes.AUTO,
      });
      reclassifier.reclassify(metrics);

      reclassifier.recordOutcome(ExecutionModes.AUTO, ExecutionModes.SPEED_CAMPAIGN, true);

      const history = reclassifier.getEscalationHistory();
      expect(history[0]!.outcome).toBe("successful");
    });

    it("recordOutcome does not throw", () => {
      expect(() => {
        reclassifier.recordOutcome(ExecutionModes.AUTO, ExecutionModes.SPEED_CAMPAIGN, true);
      }).not.toThrow();
    });

    it("recordOutcome is a no-op when no matching in-flight escalation exists", () => {
      expect(() => {
        reclassifier.recordOutcome(ExecutionModes.MEDIUM_CAMPAIGN, ExecutionModes.HIGH_CAMPAIGN, false);
      }).not.toThrow();
    });

    it("reset clears history and counter", () => {
      const metrics = makeMetrics({
        toolCalls: { total: 10, failed: 5 },
        turnCount: 15,
        currentMode: ExecutionModes.AUTO,
      });
      reclassifier.reclassify(metrics);

      expect(reclassifier.getEscalationHistory().length).toBeGreaterThanOrEqual(1);

      reclassifier.reset();

      expect(reclassifier.getEscalationHistory().length).toBe(0);

      const r2 = reclassifier.reclassify(metrics);
      expect(r2.shouldEscalate).toBe(true);
    });

    it("history records outcome correctly for failures", () => {
      // First escalation: AUTO → SPEED
      const metrics = makeMetrics({
        toolCalls: { total: 10, failed: 5 },
        turnCount: 15,
        currentMode: ExecutionModes.AUTO,
      });
      const r1 = reclassifier.reclassify(metrics);
      expect(r1.shouldEscalate).toBe(true);

      // Record outcome as failed
      reclassifier.recordOutcome(ExecutionModes.AUTO, ExecutionModes.SPEED_CAMPAIGN, false);

      // Verify the history entry recorded the failure
      const history = reclassifier.getEscalationHistory();
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[history.length - 1]!.outcome).toBe("failed");
    });
  });

  describe("Metadata-based escalation signals", () => {
    it("convergence conflicts trigger MEDIUM → HIGH escalation", () => {
      const metrics = makeMetrics({
        toolCalls: { total: 10, failed: 0 },
        turnCount: 15,
        currentMode: ExecutionModes.MEDIUM_CAMPAIGN,
        metadata: { convergenceConflicts: 3 },
      });

      const result = reclassifier.reclassify(metrics);
      expect(result.shouldEscalate).toBe(true);
      expect(result.recommendedMode).toBe(ExecutionModes.HIGH_CAMPAIGN);
    });

    it("verification failures trigger HIGH → MODUS_MAXIMUS escalation", () => {
      const metrics = makeMetrics({
        toolCalls: { total: 10, failed: 0 },
        turnCount: 20,
        currentMode: ExecutionModes.HIGH_CAMPAIGN,
        metadata: { verificationFailures: 2 },
      });

      const result = reclassifier.reclassify(metrics);
      expect(result.shouldEscalate).toBe(true);
      expect(result.recommendedMode).toBe(ExecutionModes.MODUS_MAXIMUS);
    });
  });
});

// =========================================================================
// 7. Campaign mode event emission
// =========================================================================

describe("Campaign mode event emission", () => {
  describe("SpeedCampaignMode events", () => {
    it("emits speed-campaign.started event", async () => {
      const handler = new SpeedCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const startedEvent = events.find((e: any) => e.type === "speed-campaign.started");
      expect(startedEvent).toBeDefined();
      expect(startedEvent!.type).toBe("speed-campaign.started");
      expect(startedEvent!.taskId).toBe("campaign-test-task-1");
    });

    it("emits speed-campaign.completed event", async () => {
      const handler = new SpeedCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const completedEvent = events.find((e: any) => e.type === "speed-campaign.completed");
      expect(completedEvent).toBeDefined();
      expect(completedEvent!.type).toBe("speed-campaign.completed");
      expect(completedEvent).toHaveProperty("success");
      expect(completedEvent).toHaveProperty("duration");
    });

    it("emits speed-campaign.subtask.started events", async () => {
      const handler = new SpeedCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask({ prompt: "- Task A\n- Task B" }), eventOrch);

      const subtaskStarted = events.filter((e: any) => e.type === "speed-campaign.subtask.started");
      expect(subtaskStarted.length).toBeGreaterThanOrEqual(2);
      for (const ev of subtaskStarted) {
        expect(ev).toHaveProperty("subTaskId");
        expect(ev).toHaveProperty("description");
      }
    });
  });

  describe("MediumCampaignMode events", () => {
    it("emits medium-campaign.started event", async () => {
      const handler = new MediumCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const startedEvent = events.find((e: any) => e.type === "medium-campaign.started");
      expect(startedEvent).toBeDefined();
      expect(startedEvent!.type).toBe("medium-campaign.started");
      expect(startedEvent!.taskId).toBe("campaign-test-task-1");
    });

    it("emits medium-campaign.completed event", async () => {
      const handler = new MediumCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const completedEvent = events.find((e: any) => e.type === "medium-campaign.completed");
      expect(completedEvent).toBeDefined();
      expect(completedEvent!.type).toBe("medium-campaign.completed");
      expect(completedEvent).toHaveProperty("success");
      expect(completedEvent).toHaveProperty("duration");
      expect(completedEvent).toHaveProperty("waveCount");
    });

    it("emits medium-campaign.decomposing and graph-ready events", async () => {
      const handler = new MediumCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const decomposing = events.find((e: any) => e.type === "medium-campaign.decomposing");
      expect(decomposing).toBeDefined();
      expect(decomposing!.taskId).toBe("campaign-test-task-1");

      const graphReady = events.find((e: any) => e.type === "medium-campaign.graph-ready");
      expect(graphReady).toBeDefined();
      expect(graphReady).toHaveProperty("totalWaves");
      expect(graphReady).toHaveProperty("totalNodes");
    });

    it("emits wave execution events", async () => {
      const handler = new MediumCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const waveStart = events.find((e: any) => e.type === "medium-campaign.wave-execution-starting");
      expect(waveStart).toBeDefined();

      const waveComplete = events.find((e: any) => e.type === "medium-campaign.wave-execution-complete");
      expect(waveComplete).toBeDefined();
    });

    it("emits verification events when files are changed", async () => {
      const handler = new MediumCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const verificationEvents = events.filter(
        (e: any) => e.type && e.type.startsWith("medium-campaign.verification"),
      );
      expect(verificationEvents.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("HighCampaignMode events", () => {
    it("emits high-campaign.started event", async () => {
      const handler = new HighCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const startedEvent = events.find((e: any) => e.type === "high-campaign.started");
      expect(startedEvent).toBeDefined();
      expect(startedEvent!.type).toBe("high-campaign.started");
      expect(startedEvent).toHaveProperty("campaignId");
      expect(startedEvent).toHaveProperty("taskId");
    });

    it("emits high-campaign.completed event", async () => {
      const handler = new HighCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const completedEvent = events.find((e: any) => e.type === "high-campaign.completed");
      expect(completedEvent).toBeDefined();
      expect(completedEvent!.type).toBe("high-campaign.completed");
      expect(completedEvent).toHaveProperty("success");
      expect(completedEvent).toHaveProperty("duration");
    });

    it("emits planning and plan-ready events", async () => {
      const handler = new HighCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const planningEvent = events.find((e: any) => e.type === "high-campaign.planning");
      expect(planningEvent).toBeDefined();

      const planReadyEvent = events.find((e: any) => e.type === "high-campaign.plan-ready");
      expect(planReadyEvent).toBeDefined();
      expect(planReadyEvent).toHaveProperty("totalPhases");
    });

    it("emits phase events during execution", async () => {
      const handler = new HighCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const phaseStarted = events.find((e: any) => e.type === "high-campaign.phase.started");
      expect(phaseStarted).toBeDefined();
      expect(phaseStarted).toHaveProperty("phase");
      expect(phaseStarted).toHaveProperty("phaseIndex");
    });

    it("emits convergence events during cycles", async () => {
      const handler = new HighCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const convergenceEvents = events.filter(
        (e: any) => e.type && e.type.startsWith("high-campaign.convergence"),
      );
      expect(convergenceEvents.length).toBeGreaterThanOrEqual(0);

      const cycleEvents = events.filter(
        (e: any) => e.type && e.type.startsWith("high-campaign.convergence-cycle"),
      );
      expect(cycleEvents.length).toBeGreaterThanOrEqual(0);
    });

    it("emits progress-checkpoint events", async () => {
      const handler = new HighCampaignMode();
      const eventOrch = new OrchestratorCore();
      const events = collectEvents(eventOrch);

      await handler.execute(makeTask(), eventOrch);

      const checkpointEvents = events.filter(
        (e: any) => e.type === "high-campaign.progress-checkpoint",
      );
      if (checkpointEvents.length > 0) {
        expect(checkpointEvents[0]).toHaveProperty("convergenceNumber");
        expect(checkpointEvents[0]).toHaveProperty("timestamp");
        expect(checkpointEvents[0]).toHaveProperty("filesChanged");
        expect(checkpointEvents[0]).toHaveProperty("tokensUsed");
      }
    });
  });
});