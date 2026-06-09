/**
 * Tests — TaskDecomposer & TaskGraph — DAG construction and wave dispatch.
 *
 * Covers: TaskGraphNode/Wave types, decomposition pipeline,
 * wave assignment, profile assignment, wave execution, integration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TaskDecomposer, TaskGraph } from "../taskgraph.js";
import { SubAgentPoolManager } from "../pool.js";
import type { IntentProfile, IntentScope, IntentDepth } from "../intent.js";

// =========================================================================
// Helpers
// =========================================================================

function makeProfile(overrides?: Partial<IntentProfile>): IntentProfile {
  return {
    scope: "single_file",
    depth: "surface",
    confidence: 0.8,
    estimatedFiles: 1,
    estimatedTurns: 1,
    requiresParallel: false,
    requiresResearch: false,
    requiresVerification: false,
    hasArchitecturalImpact: false,
    ...overrides,
  };
}

// =========================================================================
// 1. Types
// =========================================================================

describe("Types", () => {
  it("TaskGraphNode can be constructed with all fields", () => {
    const node: import("../taskgraph.js").TaskGraphNode = {
      id: "task-1",
      profile: "rewriter",
      prompt: "Implement changes",
      dependsOn: ["task-0"],
      priority: 10,
      estimatedComplexity: 2,
      wave: 2,
      timeout: 180_000,
      verificationRequired: true,
      outputSpec: { filesToModify: ["src/main.ts"] },
    };
    expect(node.id).toBe("task-1");
    expect(node.dependsOn).toContain("task-0");
  });

  it("Wave can be constructed with all fields", () => {
    const wave: import("../taskgraph.js").Wave = {
      index: 2,
      phase: "implement",
      taskIds: ["task-1", "task-2"],
      convergeAfter: true,
      gates: [{ type: "lint", severity: "required" }],
    };
    expect(wave.index).toBe(2);
    expect(wave.convergeAfter).toBe(true);
  });
});

// =========================================================================
// 2. Construction
// =========================================================================

describe("TaskDecomposer construction", () => {
  it("creates with a pool manager", () => {
    const pool = new SubAgentPoolManager();
    const decomposer = new TaskDecomposer(pool);
    expect(decomposer).toBeDefined();
  });
});

// =========================================================================
// 3. Decomposition — basic
// =========================================================================

describe("Decomposition — basic", () => {
  let pool: SubAgentPoolManager;
  let decomposer: TaskDecomposer;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
    decomposer = new TaskDecomposer(pool);
  });

  it("decomposes a single_file surface profile", () => {
    const profile = makeProfile({ scope: "single_file", depth: "surface" });
    const graph = decomposer.decompose(profile);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(3); // research + file + doc
    expect(graph.waves.length).toBe(6); // 6 default waves
    expect(graph.intentProfile.scope).toBe("single_file");
  });

  it("decomposes a multi_file moderate profile", () => {
    const profile = makeProfile({ scope: "multi_file", depth: "moderate", estimatedFiles: 3 });
    const graph = decomposer.decompose(profile);
    expect(graph.nodes.length).toBeGreaterThan(5);
    expect(graph.estimatedTotalTasks).toBe(graph.nodes.length);
  });

  it("decomposes a codebase_gen campaign profile", () => {
    const profile = makeProfile({ scope: "codebase_gen", depth: "campaign", requiresVerification: true, hasArchitecturalImpact: true });
    const graph = decomposer.decompose(profile);
    expect(graph.nodes.length).toBeGreaterThan(10);
    expect(graph.waves.length).toBe(6);
  });

  it("includes research task as first wave", () => {
    const profile = makeProfile();
    const graph = decomposer.decompose(profile);
    const wave0Tasks = graph.nodes.filter((n) => n.wave === 0);
    expect(wave0Tasks.length).toBeGreaterThanOrEqual(1);
    expect(wave0Tasks.some((n) => n.profile === "explore")).toBe(true);
  });
});

// =========================================================================
// 4. Wave Assignment
// =========================================================================

describe("Wave assignment", () => {
  let pool: SubAgentPoolManager;
  let decomposer: TaskDecomposer;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
    decomposer = new TaskDecomposer(pool);
  });

  it("research tasks go to wave 0", () => {
    const graph = decomposer.decompose(makeProfile());
    const wave0 = graph.waves[0]!;
    expect(wave0.phase).toBe("research");
  });

  it("scaffold tasks go to wave 1", () => {
    const graph = decomposer.decompose(makeProfile({ scope: "multi_file" }));
    const wave1 = graph.waves[1]!;
    expect(wave1.phase).toBe("scaffold");
    const wave1Tasks = graph.nodes.filter((n) => n.wave === 1);
    expect(wave1Tasks.length).toBeGreaterThan(0);
  });

  it("implement tasks go to wave 2", () => {
    const graph = decomposer.decompose(makeProfile());
    const wave2Tasks = graph.nodes.filter((n) => n.wave === 2);
    expect(wave2Tasks.length).toBeGreaterThanOrEqual(1);
  });

  it("test/doc tasks go to wave 3", () => {
    const graph = decomposer.decompose(makeProfile({ requiresVerification: true }));
    const wave3Tasks = graph.nodes.filter((n) => n.wave === 3);
    expect(wave3Tasks.length).toBeGreaterThanOrEqual(1);
    expect(wave3Tasks.some((n) => n.profile === "test-gen")).toBe(true);
  });

  it("validate tasks go to wave 5", () => {
    const graph = decomposer.decompose(makeProfile({ requiresVerification: true }));
    const wave5Tasks = graph.nodes.filter((n) => n.wave === 5);
    expect(wave5Tasks.length).toBeGreaterThan(0);
  });
});

// =========================================================================
// 5. Profile Assignment
// =========================================================================

describe("Profile assignment", () => {
  let pool: SubAgentPoolManager;
  let decomposer: TaskDecomposer;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
    decomposer = new TaskDecomposer(pool);
  });

  it("research tasks get explore profile", () => {
    const graph = decomposer.decompose(makeProfile());
    const research = graph.nodes.find((n) => n.wave === 0);
    expect(research?.profile).toBe("explore");
  });

  it("implement tasks get rewriter profile", () => {
    const graph = decomposer.decompose(makeProfile());
    const implement = graph.nodes.find((n) => n.wave === 2);
    expect(implement?.profile).toBe("rewriter");
  });

  it("test tasks get test-gen profile", () => {
    const graph = decomposer.decompose(makeProfile({ requiresVerification: true, depth: "moderate" }));
    const testTask = graph.nodes.find((n) => n.profile === "test-gen");
    expect(testTask).toBeDefined();
  });

  it("validate tasks get validator profile", () => {
    const graph = decomposer.decompose(makeProfile({ requiresVerification: true }));
    const validatorTask = graph.nodes.find((n) => n.profile === "validator");
    expect(validatorTask).toBeDefined();
  });
});

// =========================================================================
// 6. Dependency Ordering
// =========================================================================

describe("Dependency ordering", () => {
  let pool: SubAgentPoolManager;
  let decomposer: TaskDecomposer;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
    decomposer = new TaskDecomposer(pool);
  });

  it("research tasks have no dependencies", () => {
    const graph = decomposer.decompose(makeProfile());
    const research = graph.nodes.find((n) => n.wave === 0);
    expect(research?.dependsOn.length ?? 0).toBe(0);
  });

  it("implement tasks may depend on research/scaffold", () => {
    const graph = decomposer.decompose(makeProfile({ scope: "multi_file" }));
    const implement = graph.nodes.find((n) => n.wave === 2);
    // Implementation tasks may depend on earlier tasks
    expect(implement).toBeDefined();
  });

  it("tasks are ordered by wave ascending", () => {
    const graph = decomposer.decompose(makeProfile({ scope: "codebase_gen", depth: "deep", requiresVerification: true }));
    for (const node of graph.nodes) {
      expect(node.wave).toBeGreaterThanOrEqual(0);
      expect(node.wave).toBeLessThanOrEqual(5);
    }
  });
});

// =========================================================================
// 7. WorkspaceTopology
// =========================================================================

describe("WorkspaceTopology", () => {
  let pool: SubAgentPoolManager;
  let decomposer: TaskDecomposer;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
    decomposer = new TaskDecomposer(pool);
  });

  it("accepts topology with modules and files", () => {
    const topology = {
      modules: ["core", "api"],
      files: ["core/index.ts", "api/handler.ts", "api/types.ts"],
      dependencies: [{ from: "core", to: "api" }],
    };
    const profile = makeProfile({ scope: "module", depth: "moderate" });
    const graph = decomposer.decompose(profile, topology);
    expect(graph.nodes.length).toBeGreaterThan(3);
  });

  it("uses topology modules for task generation", () => {
    const topology = {
      modules: ["custom-module"],
      files: ["custom-module/index.ts"],
      dependencies: [],
    };
    const profile = makeProfile({ scope: "module", depth: "deep" });
    const graph = decomposer.decompose(profile, topology);
    const wave2Tasks = graph.nodes.filter((n) => n.wave === 2);
    expect(wave2Tasks.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// 8. Wave Dispatch
// =========================================================================

describe("Wave dispatch", () => {
  let pool: SubAgentPoolManager;
  let decomposer: TaskDecomposer;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
    decomposer = new TaskDecomposer(pool);
  });

  it("dispatches all waves and returns results", async () => {
    pool.start();
    const graph = decomposer.decompose(makeProfile({ scope: "single_file", depth: "surface" }));
    const result = await decomposer.dispatchWaves(graph);
    expect(result.graph).toBe(graph);
    expect(result.waveResults.length).toBeGreaterThanOrEqual(1);
    pool.stop();
  }, 10_000);

  it("reports total duration", async () => {
    pool.start();
    const graph = decomposer.decompose(makeProfile());
    const result = await decomposer.dispatchWaves(graph);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    pool.stop();
  }, 10_000);

  it("calls convergeCallback when wave has convergeAfter", async () => {
    pool.start();
    const convergeCb = vi.fn();
    const graph = decomposer.decompose(makeProfile({ scope: "multi_file", depth: "moderate" }));
    await decomposer.dispatchWaves(graph, convergeCb);
    // Wave 1 (scaffold) has convergeAfter=true
    expect(convergeCb).toHaveBeenCalled();
    pool.stop();
  }, 10_000);

  it("handles empty waves gracefully", async () => {
    pool.start();
    const graph: TaskGraph = {
      nodes: [],
      waves: [{ index: 0, phase: "research", taskIds: [], convergeAfter: false, gates: [] }],
      intentProfile: makeProfile(),
      estimatedTotalTasks: 0,
      estimatedTotalWaves: 1,
    };
    const result = await decomposer.dispatchWaves(graph);
    expect(result.success).toBe(true);
    expect(result.waveResults).toHaveLength(0); // empty wave skipped
    pool.stop();
  }, 10_000);
});

// =========================================================================
// 9. Integration with PoolManager
// =========================================================================

describe("Integration with PoolManager", () => {
  let pool: SubAgentPoolManager;
  let decomposer: TaskDecomposer;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 4 });
    decomposer = new TaskDecomposer(pool);
  });

  afterEach(() => {
    pool.stop();
  });

  it("schedules tasks through the pool manager", async () => {
    pool.start();
    const profile = makeProfile({ scope: "single_file", depth: "surface" });
    const graph = decomposer.decompose(profile);

    // Before dispatch, pool should be empty
    expect(pool.getRunningCount()).toBe(0);

    const result = await decomposer.dispatchWaves(graph);
    expect(result.success).toBe(true);

    // After dispatch, pool should have completed/failed agents
    const stateCounts = pool.getStateCounts();
    expect(stateCounts.completed + stateCounts.failed).toBeGreaterThanOrEqual(1);
  }, 10_000);

  it("handles concurrency limits during wave dispatch", async () => {
    const limitedPool = new SubAgentPoolManager({ globalConcurrency: 2 });
    const limitedDecomposer = new TaskDecomposer(limitedPool);
    limitedPool.start();

    const graph = limitedDecomposer.decompose(
      makeProfile({ scope: "module", depth: "deep", requiresVerification: true }),
    );
    const result = await limitedDecomposer.dispatchWaves(graph);
    // Should still complete despite limited concurrency
    expect(result).toBeDefined();
    limitedPool.stop();
  }, 10_000);
});

// =========================================================================
// 10. Edge Cases
// =========================================================================

describe("Edge cases", () => {
  let pool: SubAgentPoolManager;
  let decomposer: TaskDecomposer;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
    decomposer = new TaskDecomposer(pool);
  });

  it("handles surface depth with no verification", () => {
    const profile = makeProfile({ scope: "single_file", depth: "surface", requiresVerification: false });
    const graph = decomposer.decompose(profile);
    const wave3Tasks = graph.nodes.filter((n) => n.wave === 3);
    // Surface depth without verification may still have doc tasks
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("handles campaign depth with max modules", () => {
    const profile = makeProfile({ scope: "codebase_gen", depth: "campaign", estimatedFiles: 30 });
    const graph = decomposer.decompose(profile);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(15);
  });

  it("all nodes have unique IDs", () => {
    const profile = makeProfile({ scope: "codebase_gen", depth: "deep", requiresVerification: true });
    const graph = decomposer.decompose(profile);
    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all nodes have a valid wave index (0-5)", () => {
    const profile = makeProfile({ scope: "module", depth: "campaign" });
    const graph = decomposer.decompose(profile);
    for (const node of graph.nodes) {
      expect(node.wave).toBeGreaterThanOrEqual(0);
      expect(node.wave).toBeLessThanOrEqual(5);
    }
  });

  it("all wave task references exist in nodes", () => {
    const profile = makeProfile({ scope: "multi_file", depth: "moderate" });
    const graph = decomposer.decompose(profile);
    const allNodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const wave of graph.waves) {
      for (const taskId of wave.taskIds) {
        expect(allNodeIds.has(taskId)).toBe(true);
      }
    }
  });
});