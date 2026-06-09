/**
 * Tests — ConvergenceEngine — Diff Collection, Conflict Detection & Resolution.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ConvergenceEngine, createTwoFilesPatch } from "../convergence.js";
import type { ChangeSet, Conflict, ConvergenceResult } from "../convergence.js";
import type { ExecutionResult, SubTask } from "../modes/types.js";

function makeResult(overrides?: Partial<ExecutionResult>): ExecutionResult {
  return {
    success: true,
    mode: "LIGHTWEIGHT_PLAN" as any,
    taskId: "task-1",
    output: "Made changes to the API module",
    changedFiles: ["src/api/handler.ts", "src/api/types.ts"],
    totalTokens: 500, llmCallCount: 3, toolCallCount: 5, durationMs: 1000,
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSubTask(overrides?: Partial<SubTask>): SubTask {
  return {
    id: "sub-1", parentTaskId: "task-main",
    description: "Update the API module endpoints",
    status: "completed", createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// =========================================================================
// 1. Diff utilities
// =========================================================================

describe("Diff utilities", () => {
  it("creates unified diff for changed content", () => {
    const diff = createTwoFilesPatch("test.ts", "line1\nline2\nline3\n", "line1\nmodified\nline3\n");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+modified");
  });

  it("returns empty for identical content", () => {
    expect(createTwoFilesPatch("same.ts", "a\nb\n", "a\nb\n")).toBe("");
  });

  it("handles added lines", () => {
    expect(createTwoFilesPatch("a.ts", "a\nb\n", "a\nb\nc\n")).toContain("+c");
  });

  it("handles removed lines", () => {
    expect(createTwoFilesPatch("a.ts", "a\nb\nc\n", "a\nc\n")).toContain("-b");
  });
});

// =========================================================================
// 2. Types
// =========================================================================

describe("Types", () => {
  it("ChangeSet can be constructed", () => {
    const cs: ChangeSet = {
      agentId: "sub-1", agentProfile: "rewriter", priority: 10,
      filePath: "src/api/handler.ts",
      oldContent: "old", newContent: "new",
      diff: "@@ -1 +1 @@\n-old\n+new",
      summary: "Updated handler",
      tag: "INTENDED",
      affectedSymbols: [], modules: [], timestamp: "now",
    };
    expect(cs.filePath).toBe("src/api/handler.ts");
    expect(cs.tag).toBe("INTENDED");
  });

  it("Conflict can be constructed", () => {
    const c: Conflict = {
      type: "LINE_CONFLICT", filePath: "a.ts",
      agentIdA: "s1", agentIdB: "s2",
      description: "Overlap in a.ts", severity: "critical",
    };
    expect(c.type).toBe("LINE_CONFLICT");
    expect(c.filePath).toBe("a.ts");
  });
});

// =========================================================================
// 3. Construction & converge pipeline
// =========================================================================

describe("ConvergenceEngine", () => {
  let engine: ConvergenceEngine;

  beforeEach(() => {
    engine = new ConvergenceEngine();
  });

  it("creates with defaults", () => {
    expect(engine).toBeDefined();
  });

  it("converge returns a ConvergenceResult", async () => {
    const r = await engine.converge(
      [makeResult({ taskId: "t1", changedFiles: ["a.ts"] })],
      [makeSubTask({ id: "t1" })],
    );
    expect(r).toHaveProperty("success");
    expect(r).toHaveProperty("rounds");
    expect(r).toHaveProperty("appliedChanges");
    expect(r).toHaveProperty("totalConflicts");
    expect(r).toHaveProperty("totalDurationMs");
  });

  it("succeeds for non-conflicting changes", async () => {
    const r = await engine.converge(
      [makeResult({ taskId: "t1", changedFiles: ["a.ts"] }), makeResult({ taskId: "t2", changedFiles: ["b.ts"] })],
      [makeSubTask({ id: "t1" }), makeSubTask({ id: "t2" })],
    );
    expect(r.success).toBe(true);
    expect(r.totalConflicts).toBe(0);
  });

  it("detects conflicts for same file changes", async () => {
    const r = await engine.converge(
      [makeResult({ taskId: "t1", changedFiles: ["shared.ts"], output: "Change A" }), makeResult({ taskId: "t2", changedFiles: ["shared.ts"], output: "Change B" })],
      [makeSubTask({ id: "t1" }), makeSubTask({ id: "t2" })],
    );
    expect(r.totalConflicts).toBeGreaterThanOrEqual(1);
  });

  it("handles empty results", async () => {
    const r = await engine.converge([], []);
    expect(r.success).toBe(true);
    expect(r.rounds).toHaveLength(0);
  });

  it("handles null/undefined results gracefully", async () => {
    const r = await engine.converge(null as any, []);
    expect(r.success).toBe(true);
  });

  it("handles results with no changed files", async () => {
    const r = await engine.converge([makeResult({ changedFiles: [] })], [makeSubTask()]);
    expect(r.success).toBe(true);
  });

  it("rounds increment across calls", async () => {
    const r1 = await engine.converge([makeResult({ taskId: "t1", changedFiles: ["a.ts"] })], [makeSubTask({ id: "t1" })]);
    const r2 = await engine.converge([makeResult({ taskId: "t2", changedFiles: ["b.ts"] })], [makeSubTask({ id: "t2" })]);
    expect(r2.rounds[0]!.roundNumber).toBe(r1.rounds.length + r2.rounds.length - 1);
  });

  it("applies changes and reports them", async () => {
    const r = await engine.converge(
      [makeResult({ taskId: "t1", changedFiles: ["a.ts", "b.ts"] })],
      [makeSubTask({ id: "t1" })],
    );
    expect(r.appliedChanges.length).toBeGreaterThanOrEqual(2);
  });

  it("includes timing information", async () => {
    const r = await engine.converge([makeResult({ taskId: "t1", changedFiles: ["a.ts"] })], [makeSubTask({ id: "t1" })]);
    expect(r.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});

// =========================================================================
// 4. Many files
// =========================================================================

describe("Many files", () => {
  let engine: ConvergenceEngine;

  beforeEach(() => {
    engine = new ConvergenceEngine();
  });

  it("handles many files efficiently", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `src/m${i}/f${i}.ts`);
    const r = await engine.converge(
      [makeResult({ taskId: "t-big", changedFiles: many })],
      [makeSubTask({ id: "t-big", description: "Big change" })],
    );
    expect(r.success).toBe(true);
    expect(r.appliedChanges.length).toBe(20);
  });
});

// =========================================================================
// 5. Multiple conflicts
// =========================================================================

describe("Multiple conflicts", () => {
  let engine: ConvergenceEngine;

  beforeEach(() => {
    engine = new ConvergenceEngine();
  });

  it("multiple agents touching the same file", async () => {
    const r = await engine.converge(
      [
        makeResult({ taskId: "t1", changedFiles: ["c.ts"], output: "Change A" }),
        makeResult({ taskId: "t2", changedFiles: ["c.ts"], output: "Change B" }),
        makeResult({ taskId: "t3", changedFiles: ["c.ts"], output: "Change 3" }),
      ],
      [
        makeSubTask({ id: "t1", description: "Change 1" }),
        makeSubTask({ id: "t2", description: "Change 2" }),
        makeSubTask({ id: "t3", description: "Change 3" }),
      ],
    );
    expect(r.totalConflicts).toBeGreaterThanOrEqual(1);
  });
});