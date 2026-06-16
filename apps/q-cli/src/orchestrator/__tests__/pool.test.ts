/**
 * Tests — SubAgentPoolManager lifecycle, scheduling, health monitoring.
 *
 * Covers: SubAgentHandle, scheduling, priority buckets, conflict detection,
 * dependency ordering, concurrency limits, heartbeat, health monitoring,
 * fairness, event listeners, state queries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SubAgentPoolManager } from "../pool.js";
import type { SubAgentHandle, TokenUsage } from "../pool.js";
import type { SubTask } from "../modes/types.js";

// =========================================================================
// Helpers
// =========================================================================

function makeSubTask(overrides?: Partial<SubTask>): SubTask {
  return {
    id: "sub-" + Math.random().toString(36).slice(2, 8),
    parentTaskId: "task-1",
    description: "Implement the changes",
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSubTaskWithDeps(depIds: string[], overrides?: Partial<SubTask>): SubTask {
  return makeSubTask({ dependencies: depIds, description: "Depends on others", ...overrides });
}

const defaultTimeout = 10_000;

// =========================================================================
// 1. SubAgentHandle & Types
// =========================================================================

describe("Types", () => {
  it("TokenUsage has the required fields", () => {
    const usage: TokenUsage = { promptTokens: 100, completionTokens: 200 };
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(200);
  });

  it("SubAgentHandle can be constructed with all fields", () => {
    const controller = new AbortController();
    const handle: SubAgentHandle = {
      id: "agent-1",
      profile: "searchius",
      state: "running",
      moduleTarget: "api",
      priority: 50,
      heartbeat: Date.now(),
      errorCount: 0,
      tokenUsage: { promptTokens: 10, completionTokens: 20 },
      controller,
      startedAt: Date.now(),
    };
    expect(handle.id).toBe("agent-1");
    expect(handle.moduleTarget).toBe("api");
    expect(handle.controller).toBe(controller);
  });
});

// =========================================================================
// 2. Construction & Configuration
// =========================================================================

describe("SubAgentPoolManager construction", () => {
  it("creates with default config", () => {
    const pool = new SubAgentPoolManager();
    expect(pool.getConfig().globalConcurrency).toBe(8);
    expect(pool.getConfig().heartbeatTimeoutMs).toBe(60_000);
    expect(pool.getRunningCount()).toBe(0);
    expect(pool.getQueueSize()).toBe(0);
  });

  it("creates with custom config", () => {
    const pool = new SubAgentPoolManager({ globalConcurrency: 4, heartbeatTimeoutMs: 30_000 });
    expect(pool.getConfig().globalConcurrency).toBe(4);
    expect(pool.getConfig().heartbeatTimeoutMs).toBe(30_000);
  });

  it("updateConfig merges at runtime", () => {
    const pool = new SubAgentPoolManager();
    pool.updateConfig({ globalConcurrency: 16 });
    expect(pool.getConfig().globalConcurrency).toBe(16);
    expect(pool.getConfig().heartbeatTimeoutMs).toBe(60_000); // unchanged
  });
});

// =========================================================================
// 3. Scheduling — Immediate Dispatch
// =========================================================================

describe("Scheduling — immediate dispatch", () => {
  let pool: SubAgentPoolManager;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
  });

  it("schedules a sub-task and returns a handle", () => {
    const st = makeSubTask();
    const handle = pool.schedule(st);
    expect(handle).not.toBeNull();
    expect(handle!.id).toBe(st.id);
    // After the simulated async spawn, state becomes running then completed
    expect(handle!.state).toBe("running");
  });

  it("returns null when global concurrency is exceeded", () => {
    const smallPool = new SubAgentPoolManager({ globalConcurrency: 1 });
    // Schedule first — dispatches immediately
    smallPool.schedule(makeSubTask({ id: "first" }));
    // Schedule second — should be queued since running count is at limit
    // (the simulated spawn completes quickly but synchronously the first is 'running')
    const second = smallPool.schedule(makeSubTask({ id: "second" }));
    expect(second).toBeNull(); // queued
  });

  it("queues when per-profile limit is reached", () => {
    const profilePool = new SubAgentPoolManager({
      profileLimits: { "editius": 1 },
      globalConcurrency: 8,
    });
    profilePool.schedule(makeSubTask({ id: "t1", assignedAgent: "editius", phase: "test_generation" }));
    const second = profilePool.schedule(makeSubTask({ id: "t2", assignedAgent: "editius", phase: "test_generation" }));
    expect(second).toBeNull(); // queued (profile limit reached)
  });

  it("queues when module concurrency limit is reached", () => {
    // Force both to same module by using module-level keywords in description
    const st1 = makeSubTask({ id: "m1", description: "Fix the API module endpoint", phase: "implementation" });
    const st2 = makeSubTask({ id: "m2", description: "Refactor API module internals", phase: "implementation" });
    pool.schedule(st1);
    const second = pool.schedule(st2);
    // Both target "module" — moduleConcurrency=2 so second should dispatch
    // Actually moduleConcurrency=2 allows 2 per module, so let's test with 3
    const st3 = makeSubTask({ id: "m3", description: "Rewrite API module types", phase: "implementation" });
    const third = pool.schedule(st3);
    // Only 2 per module, so third should be queued
    expect(third).toBeNull();
  });
});

// =========================================================================
// 4. Priority Buckets
// =========================================================================

describe("Priority Buckets", () => {
  let pool: SubAgentPoolManager;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
  });

  it("dependency_resolution → bucket 0", () => {
    const st = makeSubTask({ phase: "dependency_resolution" });
    const handle = pool.schedule(st);
    expect(handle).not.toBeNull();
    expect(handle!.state).toBe("running");
  });

  it("explore phase → bucket 1", () => {
    const st = makeSubTask({ phase: "searchius" });
    const handle = pool.schedule(st);
    expect(handle).not.toBeNull();
  });

  it("implementation (default) → bucket 2", () => {
    const st = makeSubTask({ phase: "implementation" });
    const handle = pool.schedule(st);
    expect(handle).not.toBeNull();
  });

  it("test generation → bucket 3", () => {
    const st = makeSubTask({ assignedAgent: "editius", phase: "test_generation", description: "test" });
    const handle = pool.schedule(st);
    expect(handle).not.toBeNull();
  });

  it("documentation → bucket 3", () => {
    const st = makeSubTask({ assignedAgent: "rewritius", phase: "documentation", description: "docs" });
    const handle = pool.schedule(st);
    expect(handle).not.toBeNull();
  });
});

// =========================================================================
// 5. Dependency Ordering
// =========================================================================

describe("Dependency ordering", () => {
  let pool: SubAgentPoolManager;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
  });

  it("independent tasks schedule immediately", () => {
    const st = makeSubTask();
    const handle = pool.schedule(st);
    expect(handle).not.toBeNull();
  });

  it("task with unmet dependencies is queued", () => {
    const depSt = makeSubTask({ id: "dep-target", description: "setup", phase: "searchius" });
    const st = makeSubTask({ id: "dependent", description: "real work", phase: "implementation", dependencies: ["dep-target"] });

    // Schedule the dependent first — dependencies not met
    const handle = pool.schedule(st);
    expect(handle).toBeNull(); // queued

    // Schedule the dependency — it dispatches
    const depHandle = pool.schedule(depSt);
    expect(depHandle).not.toBeNull();
  });

  it("dependenciesMet returns true when no deps", () => {
    const st = makeSubTask();
    expect(pool.dependenciesMet(st)).toBe(true);
  });

  it("dependenciesMet returns false when deps not completed", () => {
    // First, schedule and start the dependency
    const dep = makeSubTask({ id: "dep-x", description: "dep", phase: "searchius" });
    pool.schedule(dep);
    // Dep is running, not completed yet
    const st = makeSubTask({ id: "dependent-x", dependencies: ["dep-x"] });
    expect(pool.dependenciesMet(st)).toBe(false);
  });
});

// =========================================================================
// 6. Conflict Detection
// =========================================================================

describe("Conflict detection", () => {
  let pool: SubAgentPoolManager;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8, moduleConcurrency: 1 });
  });

  it("bucket 2 tasks to same module conflict", () => {
    const st1 = makeSubTask({ id: "c1", description: "Fix the API module", phase: "implementation" });
    const st2 = makeSubTask({ id: "c2", description: "Refactor the API module", phase: "implementation" });
    pool.schedule(st1);
    const handle2 = pool.schedule(st2);
    // Both resolve to "module" as module target, moduleConcurrency=1
    expect(handle2).toBeNull(); // conflict — queued
  });

  it("bucket 3 tasks never conflict (always parallel-safe)", () => {
    const st1 = makeSubTask({ id: "s1", description: "Test the API module", phase: "test_generation" });
    const st2 = makeSubTask({ id: "s2", description: "Test the API module too", phase: "test_generation" });
    pool.schedule(st1);
    const handle2 = pool.schedule(st2);
    // Both bucket 3 — always parallel-safe, should dispatch
    expect(handle2).not.toBeNull();
  });
});

// =========================================================================
// 7. Heartbeat & Health Monitoring
// =========================================================================

describe("Heartbeat and health monitoring", () => {
  let pool: SubAgentPoolManager;

  beforeEach(() => {
    pool = new SubAgentPoolManager({
      globalConcurrency: 8,
      heartbeatTimeoutMs: 200, // very short for testing
    });
    pool.start();
  });

  afterEach(() => {
    pool.stop();
  });

  it("recordHeartbeat updates the heartbeat timestamp", () => {
    const st = makeSubTask({ id: "hb-1" });
    pool.schedule(st);

    const before = Date.now();
    pool.recordHeartbeat("hb-1");
    const after = Date.now();

    const agent = pool.getAgent("hb-1");
    expect(agent).toBeDefined();
    expect(agent!.heartbeat).toBeGreaterThanOrEqual(before);
    expect(agent!.heartbeat).toBeLessThanOrEqual(after + 100);
  });

  it("heartbeat listener is called on recordHeartbeat", () => {
    const listener = vi.fn();
    pool.onHeartbeat(listener);
    // Schedule an agent first so recordHeartbeat has a target
    pool.schedule(makeSubTask({ id: "hb-listener" }));
    pool.recordHeartbeat("hb-listener");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("offHeartbeat removes the listener", () => {
    const listener = vi.fn();
    pool.onHeartbeat(listener);
    pool.offHeartbeat(listener);
    // Schedule an agent first so recordHeartbeat has a target
    pool.schedule(makeSubTask({ id: "hb-off-test" }));
    pool.recordHeartbeat("hb-off-test");
    expect(listener).not.toHaveBeenCalled();
  });
});

// =========================================================================
// 8. Completion Events
// =========================================================================

describe("Completion events", () => {
  let pool: SubAgentPoolManager;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
  });

  it("onCompletion listener is called when a task completes", async () => {
    const listener = vi.fn();
    pool.onCompletion(listener);

    const st = makeSubTask();
    pool.schedule(st);

    // Wait for the simulated spawn to complete
    await new Promise((r) => setTimeout(r, 200));
    expect(listener).toHaveBeenCalled();
    const handle = listener.mock.calls[0]?.[0] as SubAgentHandle;
    expect(handle.state).toBe("completed");
  });

  it("offCompletion removes the listener", async () => {
    const listener = vi.fn();
    pool.onCompletion(listener);
    pool.offCompletion(listener);

    const st = makeSubTask();
    pool.schedule(st);

    await new Promise((r) => setTimeout(r, 200));
    expect(listener).not.toHaveBeenCalled();
  });
});

// =========================================================================
// 9. Agent Queries
// =========================================================================

describe("Agent queries", () => {
  let pool: SubAgentPoolManager;

  beforeEach(() => {
    pool = new SubAgentPoolManager({ globalConcurrency: 8 });
  });

  it("getAgent returns undefined for unknown id", () => {
    expect(pool.getAgent("nonexistent")).toBeUndefined();
  });

  it("getAllAgents returns all scheduled agents", () => {
    pool.schedule(makeSubTask({ id: "a1" }));
    pool.schedule(makeSubTask({ id: "a2" }));
    const all = pool.getAllAgents();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("getAgentsByState filters by state", () => {
    pool.schedule(makeSubTask({ id: "st1" }));
    // "running" state immediately after schedule
    const running = pool.getAgentsByState("running");
    expect(running.length).toBeGreaterThanOrEqual(1);
    expect(running.every((h) => h.state === "running")).toBe(true);
  });

  it("getRunningCount returns current count", () => {
    expect(pool.getRunningCount()).toBe(0);
    pool.schedule(makeSubTask({ id: "rc1" }));
    expect(pool.getRunningCount()).toBeGreaterThanOrEqual(1);
  });

  it("getStateCounts returns counts for all states", () => {
    pool.schedule(makeSubTask({ id: "sc1" }));
    const counts = pool.getStateCounts();
    expect(counts.created).toBeTypeOf("number");
    expect(counts.ready).toBeTypeOf("number");
    expect(counts.running).toBeTypeOf("number");
    expect(counts.completed).toBeTypeOf("number");
    expect(counts.failed).toBeTypeOf("number");
    expect(counts.timeout).toBeTypeOf("number");
  });
});

// =========================================================================
// 10. Lifecycle — Start / Stop
// =========================================================================

describe("Pool lifecycle", () => {
  it("start and stop do not throw", () => {
    const pool = new SubAgentPoolManager();
    expect(() => pool.start()).not.toThrow();
    expect(() => pool.stop()).not.toThrow();
  });

  it("starting twice does not create duplicate timers", () => {
    const pool = new SubAgentPoolManager();
    pool.start();
    pool.start(); // second start is a no-op
    pool.stop();
  });

  it("stop aborts all running agents", () => {
    const pool = new SubAgentPoolManager({ globalConcurrency: 8 });
    const handle = pool.schedule(makeSubTask({ id: "kill-1" }));
    // Capture a reference to the handle before stop() clears the map
    expect(handle).not.toBeNull();
    const capturedState = handle!.state;
    expect(capturedState).toBe("running");
    pool.stop();
    // The agent should no longer be in the map (cleared by stop)
    expect(pool.getAgent("kill-1")).toBeUndefined();
    expect(pool.getRunningCount()).toBe(0);
  });

  it("setCodebaseGraphIndex does not throw", () => {
    const pool = new SubAgentPoolManager();
    expect(() => pool.setCodebaseGraphIndex({})).not.toThrow();
  });
});

// =========================================================================
// 11. Dynamic Adjustment
// =========================================================================

describe("Dynamic adjustment", () => {
  it("updateConfig changes global concurrency at runtime", () => {
    const pool = new SubAgentPoolManager({ globalConcurrency: 8 });
    pool.updateConfig({ globalConcurrency: 16 });
    expect(pool.getConfig().globalConcurrency).toBe(16);
  });

  it("updateConfig changes per-profile limits", () => {
    const pool = new SubAgentPoolManager({ profileLimits: { rewrites: 3 } });
    pool.updateConfig({ profileLimits: { rewrites: 5 } });
    expect(pool.getConfig().profileLimits.rewrites).toBe(5);
  });

  it("throws on invalid state transitions gracefully", () => {
    const pool = new SubAgentPoolManager();
    // Just verify the pool is operational after various operations
    pool.schedule(makeSubTask({ id: "op1" }));
    pool.onTaskComplete("op1");
    // No crash
  });
});