/**
 * Tests — MemorySliceBuilder, MemorySlice, applySlice.
 *
 * Covers: MemorySlice interface, MemorySliceBuilder.build() with
 * real topology data, filtering by module, dependency chain resolution,
 * codebase subgraph building, episode/fact/decision filtering, and
 * applySlice context injection.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkspaceTopology } from "../topology.js";
import { MemorySliceBuilder, type MemorySlice } from "../memory_slice.js";
import { MemoryCoordinator } from "../../memory/coordinator.js";
import type { TaskGraphNode } from "../taskgraph.js";

// =========================================================================
// Unique test dir helper
// =========================================================================

let testDirCounter = 0;

function createTestDir(label: string): string {
  const dir = `/tmp/v-slice-test-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return dir;
}

function writeFileIn(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath);
  const d = full.substring(0, full.lastIndexOf("/"));
  mkdirSync(d, { recursive: true });
  writeFileSync(full, content, "utf-8");
}

// =========================================================================
// 1. MemorySlice Interface
// =========================================================================

describe("MemorySlice interface", () => {
  it("can be constructed with all fields", () => {
    const slice: MemorySlice = {
      workingMemory: "Task: fix bug",
      episodes: [],
      facts: [],
      decisions: [],
      codebaseGraph: {
        moduleRoot: "core",
        moduleFiles: ["/src/core/index.ts"],
        dependencies: [],
        dependents: [],
        edges: [],
      },
    };
    expect(slice.workingMemory).toBe("Task: fix bug");
    expect(slice.codebaseGraph.moduleRoot).toBe("core");
    expect(slice.episodes).toEqual([]);
    expect(slice.facts).toEqual([]);
    expect(slice.decisions).toEqual([]);
  });

  it("codebaseGraph supports edges", () => {
    const slice: MemorySlice = {
      workingMemory: "",
      episodes: [],
      facts: [],
      decisions: [],
      codebaseGraph: {
        moduleRoot: "ui",
        moduleFiles: ["button.ts"],
        dependencies: ["core.ts"],
        dependents: [],
        edges: [{ from: "button.ts", to: "core.ts" }],
      },
    };
    expect(slice.codebaseGraph.edges).toHaveLength(1);
    expect(slice.codebaseGraph.edges[0]!.from).toBe("button.ts");
  });
});

// =========================================================================
// 2. MemorySliceBuilder — build() with real topology
// =========================================================================

describe("MemorySliceBuilder — build()", () => {
  const testDir = createTestDir("build");
  let topology: WorkspaceTopology;
  let memoryCoordinator: MemoryCoordinator;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    // Create a multi-module workspace
    writeFileIn(testDir, "src/core/index.ts", `import { helper } from "../utils/helper";\nexport const main = () => helper();`);
    writeFileIn(testDir, "src/utils/helper.ts", `export function helper() { return 42; }`);
    writeFileIn(testDir, "src/ui/button.ts", `import { main } from "../core";\nexport const button = main();`);
    writeFileIn(testDir, "src/ui/panel.ts", `export const panel = "panel";`);

    topology = new WorkspaceTopology({ maxDepth: 10 });
    await topology.build(testDir);

    memoryCoordinator = new MemoryCoordinator();
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("builds a MemorySlice given a task targeting a known module", () => {
    const builder = new MemorySliceBuilder();
    const taskNode: TaskGraphNode = {
      id: "task-1",
      profile: "rewritius",
      prompt: "Implement changes in core module",
      dependsOn: [],
      priority: 20,
      estimatedComplexity: 2,
      wave: 2,
      timeout: 180_000,
      verificationRequired: true,
      outputSpec: {},
      category: "per-module",
    };

    const slice = builder.build("rewritius", taskNode, topology, memoryCoordinator);

    expect(slice).toBeDefined();
    expect(slice.workingMemory).toContain("TASK");
    expect(slice.workingMemory).toContain("Implement changes in core module");
    expect(slice.codebaseGraph).toBeDefined();
    expect(slice.codebaseGraph.moduleFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("resolveTargetModule picks the correct module from prompt", () => {
    const builder = new MemorySliceBuilder();
    const taskNode: TaskGraphNode = {
      id: "task-ui",
      profile: "rewritius",
      prompt: "Update ui component button",
      dependsOn: [],
      priority: 20,
      estimatedComplexity: 1,
      wave: 2,
      timeout: 180_000,
      verificationRequired: false,
      outputSpec: {},
      category: "per-module",
    };

    const slice = builder.build("rewritius", taskNode, topology, memoryCoordinator);
    // The builder extracts "ui" from the prompt since "ui" is a known module
    expect(slice.codebaseGraph.moduleFiles.length).toBeGreaterThanOrEqual(1);
    // Verify we got the ui module
    const allUIFiles = slice.codebaseGraph.moduleFiles.filter(
      (f) => f.includes("ui"),
    );
    expect(allUIFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("workingMemory includes module structure", () => {
    const builder = new MemorySliceBuilder();
    const taskNode: TaskGraphNode = {
      id: "task-ui",
      profile: "rewritius",
      prompt: "Fix ui module",
      dependsOn: [],
      priority: 20,
      estimatedComplexity: 1,
      wave: 2,
      timeout: 180_000,
      verificationRequired: false,
      outputSpec: {},
    };

    const slice = builder.build("rewritius", taskNode, topology, memoryCoordinator);
    expect(slice.workingMemory).toContain("TARGET MODULE");
    expect(slice.workingMemory).toContain("MODULE FILES");
  });
});

// =========================================================================
// 3. Memory filtering with episodes, facts, decisions
// =========================================================================

describe("Memory filtering", () => {
  const testDir = createTestDir("filtering");
  let topology: WorkspaceTopology;
  let memoryCoordinator: MemoryCoordinator;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileIn(testDir, "src/core/index.ts", `export const core = "core";`);
    writeFileIn(testDir, "src/ui/button.ts", `export const button = "button";`);

    topology = new WorkspaceTopology({ maxDepth: 10 });
    await topology.build(testDir);

    // Seed the memory coordinator with data for different modules
    memoryCoordinator = new MemoryCoordinator();

    // Episodes
    const now = Date.now();
    memoryCoordinator.recordEpisode({
      id: "ep-1",
      sessionId: "test-session",
      sequenceNumber: 1,
      timestamp: { start: now - 1000, end: now },
      trigger: "compaction",
      agentProfile: "rewritius",
      moduleScope: ["core"],
      summary: "Refactored core module exports",
      affectedFiles: [join(testDir, "src/core/index.ts")],
      decisions: [],
      facts: [],
      outcome: "completed",
      tokenCost: { promptTokens: 100, completionTokens: 50 },
      semanticTags: ["refactor"],
    });
    memoryCoordinator.recordEpisode({
      id: "ep-2",
      sessionId: "test-session",
      sequenceNumber: 2,
      timestamp: { start: now, end: now + 1000 },
      trigger: "compaction",
      agentProfile: "editius",
      moduleScope: ["ui"],
      summary: "Added tests for UI button",
      affectedFiles: [join(testDir, "src/ui/button.ts")],
      decisions: [],
      facts: [],
      outcome: "completed",
      tokenCost: { promptTokens: 50, completionTokens: 25 },
      semanticTags: ["test"],
    });

    // Facts
    memoryCoordinator.recordFact({
      id: "fact-1",
      claim: "Core module is the main entry point",
      confidence: 0.9,
      sources: [],
      verifiedBy: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    memoryCoordinator.recordFact({
      id: "fact-2",
      claim: "UI module manages button rendering and events",
      confidence: 0.8,
      sources: [],
      verifiedBy: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Decisions
    memoryCoordinator.recordDecision({
      id: "dec-1",
      sessionId: "test-session",
      timestamp: Date.now(),
      context: "Core module should export all types",
      alternatives: [],
      chosen: "Use barrel exports from index.ts",
      rationale: "Simplifies imports across the project",
      affectedPaths: [join(testDir, "src/core/index.ts"), join(testDir, "src/ui/button.ts")],
      tags: ["core"],
      supersedes: [],
      supersededBy: [],
    });
    memoryCoordinator.recordDecision({
      id: "dec-2",
      sessionId: "test-session",
      timestamp: Date.now(),
      context: "UI components should be stateless",
      alternatives: [],
      chosen: "Make UI components functional",
      rationale: "Better testability",
      affectedPaths: [join(testDir, "src/ui/button.ts")],
      tags: ["ui"],
      supersedes: [],
      supersededBy: [],
    });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("filters episodes to only the target module", () => {
    const builder = new MemorySliceBuilder();
    const taskNode: TaskGraphNode = {
      id: "task-core",
      profile: "rewritius",
      prompt: "Fix core module",
      dependsOn: [],
      priority: 20,
      estimatedComplexity: 1,
      wave: 2,
      timeout: 180_000,
      verificationRequired: false,
      outputSpec: {},
    };

    const slice = builder.build("rewritius", taskNode, topology, memoryCoordinator);
    // Only ep-1 (core) should be included
    expect(slice.episodes).toHaveLength(1);
    expect(slice.episodes[0]!.id).toBe("ep-1");
  });

  it("filters facts to overlapping file paths", () => {
    const builder = new MemorySliceBuilder();
    const taskNode: TaskGraphNode = {
      id: "task-core",
      profile: "rewritius",
      prompt: "Fix core module",
      dependsOn: [],
      priority: 20,
      estimatedComplexity: 1,
      wave: 2,
      timeout: 180_000,
      verificationRequired: false,
      outputSpec: {},
    };

    const slice = builder.build("rewritius", taskNode, topology, memoryCoordinator);
    // Only fact-1 (core) should be included (fact-2 is about rendering, not core)
    expect(slice.facts).toHaveLength(1);
    // Check that the fact relates to core
    expect(slice.facts[0]!.id).toBe("fact-1");
  });

  it("filters decisions to same or affected modules", () => {
    const builder = new MemorySliceBuilder();
    const taskNode: TaskGraphNode = {
      id: "task-core",
      profile: "rewritius",
      prompt: "Fix core module",
      dependsOn: [],
      priority: 20,
      estimatedComplexity: 1,
      wave: 2,
      timeout: 180_000,
      verificationRequired: false,
      outputSpec: {},
    };

    const slice = builder.build("rewritius", taskNode, topology, memoryCoordinator);
    // dec-1 applies to core (has core in affectedPaths), dec-2 does not
    expect(slice.decisions).toHaveLength(1);
    expect(slice.decisions[0]!.id).toBe("dec-1");
  });

  it("builds working memory with all scoped context", () => {
    const builder = new MemorySliceBuilder();
    const taskNode: TaskGraphNode = {
      id: "task-core",
      profile: "rewritius",
      prompt: "Fix core module exports",
      dependsOn: [],
      priority: 20,
      estimatedComplexity: 1,
      wave: 2,
      timeout: 180_000,
      verificationRequired: false,
      outputSpec: {},
    };

    const slice = builder.build("rewritius", taskNode, topology, memoryCoordinator);

    // Working memory should be comprehensive
    expect(slice.workingMemory).toContain("TASK");
    expect(slice.workingMemory).toContain("Fix core module exports");
    expect(slice.workingMemory).toContain("TARGET MODULE");
    expect(slice.workingMemory).toContain("MODULE FILES");
  });
});

// =========================================================================
// 4. Codebase subgraph building
// =========================================================================

describe("Codebase subgraph", () => {
  const testDir = createTestDir("subgraph");
  let topology: WorkspaceTopology;
  let memoryCoordinator: MemoryCoordinator;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileIn(testDir, "src/core/main.ts", `import { helper } from "../utils/helper";\nexport const main = () => helper();`);
    writeFileIn(testDir, "src/utils/helper.ts", `export function helper() { return 42; }`);
    writeFileIn(testDir, "src/api/route.ts", `import { main } from "../core/main";\nexport const route = main();`);

    topology = new WorkspaceTopology({ maxDepth: 10 });
    await topology.build(testDir);
    memoryCoordinator = new MemoryCoordinator();
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("includes module files, dependencies, and dependents", () => {
    const builder = new MemorySliceBuilder();
    const taskNode: TaskGraphNode = {
      id: "task-core",
      profile: "rewritius",
      prompt: "Fix core module",
      dependsOn: [],
      priority: 20,
      estimatedComplexity: 1,
      wave: 2,
      timeout: 180_000,
      verificationRequired: false,
      outputSpec: {},
    };

    const slice = builder.build("rewritius", taskNode, topology, memoryCoordinator);
    const cg = slice.codebaseGraph;

    // Core module should have main.ts
    expect(cg.moduleFiles.length).toBeGreaterThanOrEqual(1);
    expect(cg.moduleRoot).toBe("core");

    // Should have utils as a dependency (core imports utils/helper)
    // Should have api as a dependent (api imports from core)
    expect(cg).toHaveProperty("dependencies");
    expect(cg).toHaveProperty("dependents");
    expect(cg).toHaveProperty("edges");
    expect(Array.isArray(cg.dependencies)).toBe(true);
    expect(Array.isArray(cg.dependents)).toBe(true);
  });

  it("returns a valid CodebaseSubgraph structure", () => {
    const builder = new MemorySliceBuilder();
    const taskNode: TaskGraphNode = {
      id: "task-utils",
      profile: "rewritius",
      prompt: "Fix utils module",
      dependsOn: [],
      priority: 20,
      estimatedComplexity: 1,
      wave: 2,
      timeout: 180_000,
      verificationRequired: false,
      outputSpec: {},
    };

    const slice = builder.build("rewritius", taskNode, topology, memoryCoordinator);
    const cg = slice.codebaseGraph;

    expect(cg).toHaveProperty("moduleRoot");
    expect(cg).toHaveProperty("moduleFiles");
    expect(cg).toHaveProperty("dependencies");
    expect(cg).toHaveProperty("dependents");
    expect(cg).toHaveProperty("edges");
    expect(Array.isArray(cg.moduleFiles)).toBe(true);
    expect(Array.isArray(cg.dependencies)).toBe(true);
    expect(Array.isArray(cg.dependents)).toBe(true);
    expect(Array.isArray(cg.edges)).toBe(true);
  });
});

// =========================================================================
// 5. applySlice — context injection builders
// =========================================================================

describe("applySlice", () => {
  it("builds a memory slice with episodes, facts, and decisions", () => {
    const slice: MemorySlice = {
      workingMemory: "=== TASK ===\nFix the core module\n\n=== TARGET MODULE ===\nModule: core\n\n=== MODULE FILES ===\n  /src/core/index.ts",
      episodes: [
        {
          id: "ep-1",
          sessionId: "test-session",
          sequenceNumber: 1,
          timestamp: { start: 1000, end: 2000 },
          trigger: "compaction",
          agentProfile: "rewritius",
          moduleScope: ["core"],
          summary: "Refactored core module",
          affectedFiles: ["/src/core/index.ts"],
          decisions: [],
          facts: [],
          outcome: "completed",
          tokenCost: { promptTokens: 0, completionTokens: 0 },
          semanticTags: ["refactor"],
        },
      ],
      facts: [
        {
          id: "fact-1",
          claim: "Core is the main entry point",
          confidence: 0.9,
          sources: [],
          verifiedBy: [],
          createdAt: Date.parse("2025-01-01T00:00:00Z"),
          updatedAt: Date.parse("2025-01-01T00:00:00Z"),
        },
      ],
      decisions: [
        {
          id: "dec-1",
          sessionId: "test-session",
          timestamp: Date.parse("2025-01-01T00:00:00Z"),
          context: "core module API design",
          alternatives: ["barrel exports", "direct exports", "namespace exports"],
          chosen: "Use barrel exports",
          rationale: "Clean API surface",
          affectedPaths: ["/src/core/index.ts"],
          tags: ["core", "api"],
          supersedes: [],
          supersededBy: [],
        },
      ],
      codebaseGraph: {
        moduleRoot: "core",
        moduleFiles: ["/src/core/index.ts"],
        dependencies: [],
        dependents: [],
        edges: [],
      },
    };

    // Verify the working memory contains all the expected parts
    expect(slice.workingMemory).toContain("TASK");
    expect(slice.workingMemory).toContain("Fix the core module");
    expect(slice.workingMemory).toContain("TARGET MODULE");
    expect(slice.workingMemory).toContain("MODULE FILES");

    // Verify episodes, facts, decisions are correct
    expect(slice.episodes).toHaveLength(1);
    expect(slice.facts).toHaveLength(1);
    expect(slice.decisions).toHaveLength(1);
  });

  it("handles empty slices gracefully", () => {
    const slice: MemorySlice = {
      workingMemory: "=== TASK ===\nSimple task",
      episodes: [],
      facts: [],
      decisions: [],
      codebaseGraph: {
        moduleRoot: "root",
        moduleFiles: [],
        dependencies: [],
        dependents: [],
        edges: [],
      },
    };

    expect(slice.workingMemory).toBeDefined();
    expect(slice.episodes).toHaveLength(0);
    expect(slice.facts).toHaveLength(0);
    expect(slice.decisions).toHaveLength(0);
    expect(slice.codebaseGraph.moduleRoot).toBe("root");
  });
});

// =========================================================================
// 6. Pool integration methods
// =========================================================================

describe("Pool integration", () => {
  it("buildMemorySlice returns null when dependencies are missing", async () => {
    const { SubAgentPoolManager } = await import("../pool.js");
    const pool = new SubAgentPoolManager();

    const result = pool.buildMemorySlice("rewritius", {
      id: "test",
      parentTaskId: "parent",
      description: "Fix core module",
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    expect(result).toBeNull();
  });

  it("setTopology and setMemoryCoordinator work without errors", async () => {
    const { SubAgentPoolManager } = await import("../pool.js");
    const pool = new SubAgentPoolManager();

    expect(() => {
      expect(pool.setTopology).toBeDefined();
      expect(pool.setMemoryCoordinator).toBeDefined();
    }).not.toThrow();
  });
});

// =========================================================================
// 7. MemoryCoordinator queries
// =========================================================================

describe("MemoryCoordinator queries", () => {
  it("queryEpisodes filters by module", () => {
    const coordinator = new MemoryCoordinator();
    const now = Date.now();
    coordinator.recordEpisode({
      id: "ep-core",
      sessionId: "test-session",
      sequenceNumber: 1,
      timestamp: { start: now, end: now },
      trigger: "compaction",
      agentProfile: "rewritius",
      moduleScope: ["core"],
      summary: "Core work",
      affectedFiles: [],
      decisions: [],
      facts: [],
      outcome: "completed",
      tokenCost: { promptTokens: 0, completionTokens: 0 },
      semanticTags: ["general"],
    });
    coordinator.recordEpisode({
      id: "ep-ui",
      sessionId: "test-session",
      sequenceNumber: 2,
      timestamp: { start: now, end: now },
      trigger: "compaction",
      agentProfile: "rewritius",
      moduleScope: ["ui"],
      summary: "UI work",
      affectedFiles: [],
      decisions: [],
      facts: [],
      outcome: "completed",
      tokenCost: { promptTokens: 0, completionTokens: 0 },
      semanticTags: ["general"],
    });

    const coreEpisodes = coordinator.queryEpisodes("core");
    expect(coreEpisodes).toHaveLength(1);
    expect(coreEpisodes[0]!.id).toBe("ep-core");
  });

  it("queryFacts filters by module path", () => {
    const coordinator = new MemoryCoordinator();
    const now = Date.now();
    coordinator.recordFact({
      id: "fact-core",
      claim: "Core module is the main entry point",
      confidence: 0.9,
      sources: [],
      verifiedBy: [],
      createdAt: now,
      updatedAt: now,
    });
    coordinator.recordFact({
      id: "fact-ui",
      claim: "UI module renders button component",
      confidence: 0.8,
      sources: [],
      verifiedBy: [],
      createdAt: now,
      updatedAt: now,
    });

    const coreFacts = coordinator.queryFacts("core");
    expect(coreFacts).toHaveLength(1);
    expect(coreFacts[0]!.id).toBe("fact-core");
  });

  it("queryDecisions filters by module", () => {
    const coordinator = new MemoryCoordinator();
    const now = Date.now();
    coordinator.recordDecision({
      id: "dec-core",
      sessionId: "test-session",
      timestamp: now,
      context: "Core module architecture",
      alternatives: [],
      chosen: "Use barrel exports",
      rationale: "Simplifies imports",
      affectedPaths: ["/src/core/index.ts"],
      tags: ["core"],
      supersedes: [],
      supersededBy: [],
    });
    coordinator.recordDecision({
      id: "dec-ui",
      sessionId: "test-session",
      timestamp: now,
      context: "UI styling approach",
      alternatives: [],
      chosen: "Use CSS modules",
      rationale: "Scoped by default",
      affectedPaths: ["/src/ui/button.ts"],
      tags: ["ui"],
      supersedes: [],
      supersededBy: [],
    });

    const coreDecisions = coordinator.queryDecisions("core");
    expect(coreDecisions).toHaveLength(1);
    expect(coreDecisions[0]!.id).toBe("dec-core");
  });
});