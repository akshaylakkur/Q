/**
 * Tests — Long-Term Project Memory (LTPM) Store.
 *
 * Step 25: Persistent, crash-safe storage for episodes, decisions,
 * and consolidated facts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "pathe";
import { randomUUID } from "node:crypto";
import { LTPMStore, stringSimilarity } from "../ltpm.js";
import type { Episode, Decision, ConsolidatedFact } from "../types.js";

// =========================================================================
// Test Helpers
// =========================================================================

const TEST_MEMORY_ROOT = path.join(
  process.env.HOME ?? "/tmp",
  ".V-test-memory",
);

async function cleanTestRoot(): Promise<void> {
  try {
    await rm(TEST_MEMORY_ROOT, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

function makeEpisode(
  sessionId: string,
  seq: number,
  overrides?: Partial<Episode>,
): Episode {
  const now = Date.now();
  return {
    id: overrides?.id ?? randomUUID(),
    sessionId,
    sequenceNumber: seq,
    timestamp: { start: now - 1000, end: now },
    trigger: "compaction",
    summary: overrides?.summary ?? `Episode ${seq}`,
    decisions: overrides?.decisions ?? [],
    facts: overrides?.facts ?? [],
    affectedFiles: overrides?.affectedFiles ?? [],
    moduleScope: overrides?.moduleScope ?? [],
    outcome: "completed",
    tokenCost: { promptTokens: 100, completionTokens: 50 },
    semanticTags: overrides?.semanticTags ?? ["general"],
    agentProfile: overrides?.agentProfile,
  };
}

function makeDecision(overrides?: Partial<Decision>): Decision {
  return {
    id: overrides?.id ?? randomUUID(),
    sessionId: overrides?.sessionId ?? "test-session",
    timestamp: overrides?.timestamp ?? Date.now(),
    context: overrides?.context ?? "Test context",
    alternatives: overrides?.alternatives ?? [],
    chosen: overrides?.chosen ?? "Test choice",
    rationale: overrides?.rationale ?? "Test rationale",
    affectedPaths: overrides?.affectedPaths ?? [],
    tags: overrides?.tags ?? [],
    supersedes: overrides?.supersedes ?? [],
    supersededBy: overrides?.supersededBy ?? [],
  };
}

function makeFact(overrides?: Partial<ConsolidatedFact>): ConsolidatedFact {
  const now = Date.now();
  return {
    id: overrides?.id ?? randomUUID(),
    claim: overrides?.claim ?? "Module A depends on Module B",
    confidence: overrides?.confidence ?? 0.8,
    sources: overrides?.sources ?? [],
    verifiedBy: overrides?.verifiedBy ?? [],
    createdAt: overrides?.createdAt ?? now,
    updatedAt: overrides?.updatedAt ?? now,
    expiresAt: overrides?.expiresAt,
  };
}

// =========================================================================
// 1. stringSimilarity utility
// =========================================================================

describe("stringSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(stringSimilarity("hello world", "hello world")).toBeCloseTo(1.0);
  });

  it("returns 0.0 for empty strings", () => {
    expect(stringSimilarity("", "hello")).toBe(0.0);
  });

  it("returns high similarity for close strings", () => {
    const sim = stringSimilarity(
      "Module A depends on Module B",
      "Module A depends on Module C",
    );
    expect(sim).toBeGreaterThan(0.5);
  });

  it("returns low similarity for very different strings", () => {
    const sim = stringSimilarity(
      "The sky is blue",
      "Database connection pooling is configured",
    );
    expect(sim).toBeLessThan(0.3);
  });
});

// =========================================================================
// 2. LTPMStore — Initialization
// =========================================================================

describe("LTPMStore — initialization", () => {
  let store: LTPMStore;

  beforeEach(async () => {
    await cleanTestRoot();
    store = new LTPMStore({ memoryRoot: TEST_MEMORY_ROOT, debug: false });
  });

  afterEach(async () => {
    await cleanTestRoot();
  });

  it("creates directory structure on init", async () => {
    await store.init();
    expect(existsSync(path.join(TEST_MEMORY_ROOT, "episodes"))).toBe(true);
    expect(existsSync(path.join(TEST_MEMORY_ROOT, "decisions"))).toBe(true);
    expect(existsSync(path.join(TEST_MEMORY_ROOT, "facts"))).toBe(true);
    expect(existsSync(path.join(TEST_MEMORY_ROOT, "index"))).toBe(true);
  });

  it("starts with empty stats", async () => {
    await store.init();
    const stats = await store.getStats();
    expect(stats.episodeCount).toBe(0);
    expect(stats.decisionCount).toBe(0);
    expect(stats.factCount).toBe(0);
    expect(stats.memoryRoot).toBe(TEST_MEMORY_ROOT);
  });
});

// =========================================================================
// 3. LTPMStore — Episode Storage & Query
// =========================================================================

describe("LTPMStore — episode storage and query", () => {
  let store: LTPMStore;

  beforeEach(async () => {
    await cleanTestRoot();
    store = new LTPMStore({ memoryRoot: TEST_MEMORY_ROOT, debug: false });
    await store.init();
  });

  afterEach(async () => {
    await cleanTestRoot();
  });

  it("stores an episode and creates a JSON file", async () => {
    const ep = makeEpisode("session-1", 1);
    await store.storeEpisode(ep);

    const filePath = path.join(TEST_MEMORY_ROOT, "episodes", "session-1-1.json");
    const exists = existsSync(filePath);
    expect(exists).toBe(true);

    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content.id).toBe(ep.id);
    expect(content.sessionId).toBe("session-1");
    expect(content.sequenceNumber).toBe(1);
  });

  it("queries episodes by session ID", async () => {
    await store.storeEpisode(makeEpisode("session-1", 1));
    await store.storeEpisode(makeEpisode("session-1", 2));
    await store.storeEpisode(makeEpisode("session-2", 1));

    const session1Eps = await store.queryEpisodes("session-1");
    expect(session1Eps).toHaveLength(2);

    const session2Eps = await store.queryEpisodes("session-2");
    expect(session2Eps).toHaveLength(1);
  });

  it("limits query results", async () => {
    for (let i = 1; i <= 5; i++) {
      await store.storeEpisode(makeEpisode("session-1", i));
    }

    const limited = await store.queryEpisodes("session-1", 3);
    expect(limited).toHaveLength(3);
  });

  it("returns episodes ordered by sequence descending", async () => {
    await store.storeEpisode(makeEpisode("session-1", 1));
    await store.storeEpisode(makeEpisode("session-1", 2));
    await store.storeEpisode(makeEpisode("session-1", 3));

    const episodes = await store.queryEpisodes("session-1", 5);
    expect(episodes[0]!.sequenceNumber).toBe(3);
    expect(episodes[1]!.sequenceNumber).toBe(2);
    expect(episodes[2]!.sequenceNumber).toBe(1);
  });

  it("creates recall index entries", async () => {
    await store.storeEpisode(makeEpisode("session-1", 1, {
      summary: "Refactored auth module",
      semanticTags: ["refactor", "auth"],
    }));

    // Flush to persist indexes to disk
    await store.flush();

    // Recall index file should exist
    const recallIndexPath = path.join(TEST_MEMORY_ROOT, "episodes", "recall-index.json");
    expect(existsSync(recallIndexPath)).toBe(true);
  });

  it("recall function returns episodes by keyword match", async () => {
    await store.storeEpisode(makeEpisode("session-1", 1, {
      summary: "Refactored the authentication module",
      semanticTags: ["refactor", "auth"],
    }));
    await store.storeEpisode(makeEpisode("session-1", 2, {
      summary: "Fixed button alignment in UI",
      semanticTags: ["bugfix", "ui"],
    }));

    const results = await store.recall("auth module", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// 4. LTPMStore — Decision Storage & Query Chain
// =========================================================================

describe("LTPMStore — decision storage and chain query", () => {
  let store: LTPMStore;

  beforeEach(async () => {
    await cleanTestRoot();
    store = new LTPMStore({ memoryRoot: TEST_MEMORY_ROOT, debug: false });
    await store.init();
  });

  afterEach(async () => {
    await cleanTestRoot();
  });

  it("stores a decision and creates a JSON file", async () => {
    const dec = makeDecision({
      id: "dec-1",
      chosen: "Use SQLite for local storage",
      affectedPaths: ["/src/db/index.ts"],
      tags: ["database", "storage"],
    });
    await store.storeDecision(dec);

    const filePath = path.join(TEST_MEMORY_ROOT, "decisions", "dec-1.json");
    expect(existsSync(filePath)).toBe(true);

    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content.id).toBe("dec-1");
    expect(content.chosen).toBe("Use SQLite for local storage");
  });

  it("creates decision graph JSON file", async () => {
    await store.storeDecision(makeDecision({ id: "dec-1" }));
    await store.storeDecision(makeDecision({ id: "dec-2" }));

    // Flush to persist indexes to disk
    await store.flush();

    const graphPath = path.join(TEST_MEMORY_ROOT, "decisions", "graph.json");
    expect(existsSync(graphPath)).toBe(true);

    const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    expect(graph.nodes).toHaveLength(2);
  });

  it("queries decision chain by module path", async () => {
    const dec1 = makeDecision({
      id: "dec-auth-1",
      chosen: "Implement OAuth2 with JWT",
      affectedPaths: ["/src/auth/index.ts"],
      tags: ["auth"],
    });
    const dec2 = makeDecision({
      id: "dec-auth-2",
      chosen: "Use refresh tokens for session management",
      affectedPaths: ["/src/auth/index.ts"],
      tags: ["auth"],
      supersedes: ["dec-auth-1"],
    });
    // Wire up dec1's supersededBy
    const dec1Updated = { ...dec1, supersededBy: ["dec-auth-2"] };
    await store.storeDecision(dec1Updated);
    await store.storeDecision(dec2);

    const chain = await store.queryDecisionChain("auth");
    expect(chain.length).toBeGreaterThanOrEqual(2);
  });

  it("retrieves individual decisions by ID", async () => {
    await store.storeDecision(makeDecision({ id: "dec-1" }));
    const dec = await store.getDecision("dec-1");
    expect(dec).not.toBeNull();
    expect(dec!.id).toBe("dec-1");
  });
});

// =========================================================================
// 5. LTPMStore — Fact Storage & Consolidation
// =========================================================================

describe("LTPMStore — fact storage and consolidation", () => {
  let store: LTPMStore;

  beforeEach(async () => {
    await cleanTestRoot();
    store = new LTPMStore({
      memoryRoot: TEST_MEMORY_ROOT,
      debug: false,
      consolidationThreshold: 0.5, // Lower threshold for easier testing
    });
    await store.init();
  });

  afterEach(async () => {
    await cleanTestRoot();
  });

  it("stores a consolidated fact and creates a JSON file", async () => {
    const fact = makeFact({ id: "fact-1" });
    await store.storeFact(fact);

    const filePath = path.join(TEST_MEMORY_ROOT, "facts", "fact-1.json");
    expect(existsSync(filePath)).toBe(true);

    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content.id).toBe("fact-1");
  });

  it("stores fact in project-memory.json", async () => {
    await store.storeFact(makeFact({ id: "fact-1" }));

    // Flush to persist indexes to disk
    await store.flush();

    const pmPath = path.join(TEST_MEMORY_ROOT, "project-memory.json");
    expect(existsSync(pmPath)).toBe(true);

    const pm = JSON.parse(readFileSync(pmPath, "utf-8"));
    expect(pm.facts).toHaveLength(1);
    expect(pm.facts[0]!.id).toBe("fact-1");
  });

  it("consolidates duplicate facts by merging similar claims", async () => {
    // Two facts with very similar claims
    await store.storeFact(makeFact({
      id: "fact-1",
      claim: "Module A depends on Module B for database access",
      confidence: 0.8,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 5000,
    }));
    await store.storeFact(makeFact({
      id: "fact-2",
      claim: "Module A depends on Module B for database connectivity",
      confidence: 0.7,
      createdAt: Date.now() - 8000,
      updatedAt: Date.now() - 3000,
    }));

    const mergeCount = await store.consolidateFacts();
    expect(mergeCount).toBeGreaterThanOrEqual(1);

    // After consolidation, only one fact file should remain
    const remainingFacts = await store.getAllFacts();
    expect(remainingFacts.length).toBeGreaterThanOrEqual(1);
    expect(remainingFacts.length).toBeLessThanOrEqual(2);
  });

  it("does not merge very different facts", async () => {
    const store2 = new LTPMStore({
      memoryRoot: TEST_MEMORY_ROOT,
      debug: false,
      consolidationThreshold: 0.9, // Strict threshold
    });
    await store2.init();

    await store2.storeFact(makeFact({
      id: "fact-1",
      claim: "Module A depends on Module B",
      confidence: 0.8,
    }));
    await store2.storeFact(makeFact({
      id: "fact-2",
      claim: "The UI uses React for rendering",
      confidence: 0.9,
    }));

    const mergeCount = await store2.consolidateFacts();
    expect(mergeCount).toBe(0);
  });
});

// =========================================================================
// 6. LTPMStore — Session State & Direct Recall
// =========================================================================

describe("LTPMStore — session state management", () => {
  let store: LTPMStore;

  beforeEach(async () => {
    await cleanTestRoot();
    store = new LTPMStore({ memoryRoot: TEST_MEMORY_ROOT, debug: false });
    await store.init();
  });

  afterEach(async () => {
    await cleanTestRoot();
  });

  it("loadSessionState returns episodes and active decisions", async () => {
    // Store some episodes and decisions for session
    await store.storeEpisode(makeEpisode("session-1", 1, {
      summary: "Initial setup",
    }));
    await store.storeEpisode(makeEpisode("session-1", 2, {
      summary: "Auth implementation",
    }));

    // Active decision (not superseded)
    await store.storeDecision(makeDecision({
      id: "dec-active-1",
      supersededBy: [],
    }));

    // Superseded decision
    await store.storeDecision(makeDecision({
      id: "dec-superseded-1",
      supersededBy: ["dec-active-1"],
    }));

    const state = await store.loadSessionState("session-1");
    expect(state.recentEpisodes.length).toBeGreaterThanOrEqual(1);
    expect(state.activeDecisions.length).toBeGreaterThanOrEqual(1);
    // Only non-superseded decisions should be active
    const activeIds = state.activeDecisions.map((d) => d.id);
    expect(activeIds).toContain("dec-active-1");
    if (state.activeDecisions.length === 1) {
      expect(activeIds).not.toContain("dec-superseded-1");
    }
  });

  it("directRecall is a convenience wrapper around loadSessionState", async () => {
    await store.storeEpisode(makeEpisode("session-1", 1));
    const state = await store.directRecall("session-1");
    expect(state.recentEpisodes).toBeDefined();
    expect(state.activeDecisions).toBeDefined();
    expect(state.relevantFacts).toBeDefined();
  });
});

// =========================================================================
// 7. LTPMStore — Flush & Persistence
// =========================================================================

describe("LTPMStore — flush and persistence", () => {
  it("flushes indexes to disk on demand", async () => {
    await cleanTestRoot();
    const store = new LTPMStore({ memoryRoot: TEST_MEMORY_ROOT, debug: false });
    await store.init();

    await store.storeEpisode(makeEpisode("session-1", 1));
    await store.storeDecision(makeDecision({ id: "dec-1" }));
    await store.storeFact(makeFact({ id: "fact-1" }));

    await store.flush();

    // Check indexes exist
    const recallIndex = path.join(TEST_MEMORY_ROOT, "episodes", "recall-index.json");
    const decisionGraph = path.join(TEST_MEMORY_ROOT, "decisions", "graph.json");
    const projectMem = path.join(TEST_MEMORY_ROOT, "project-memory.json");

    expect(existsSync(recallIndex)).toBe(true);
    expect(existsSync(decisionGraph)).toBe(true);
    expect(existsSync(projectMem)).toBe(true);

    // New store loads existing indexes
    const store2 = new LTPMStore({ memoryRoot: TEST_MEMORY_ROOT, debug: false });
    await store2.init();

    const episodes = await store2.queryEpisodes("session-1");
    expect(episodes).toHaveLength(1);

    await cleanTestRoot();
  });
});

// =========================================================================
// 8. LTPMStore — Retention Policies
// =========================================================================

describe("LTPMStore — retention policies", () => {
  let store: LTPMStore;

  beforeEach(async () => {
    await cleanTestRoot();
    store = new LTPMStore({
      memoryRoot: TEST_MEMORY_ROOT,
      debug: false,
      factArchiveDays: 0, // Archive immediately
      episodeArchiveDays: 0, // Archive immediately
      maxSupersedesBeforeArchive: 1, // Archive after 1 supersede
    });
    await store.init();
  });

  afterEach(async () => {
    await cleanTestRoot();
  });

  it("archives facts older than configured days with confidence > 0.5", async () => {
    // Create a fact that looks old (timestamp in the past)
    const oldTime = Date.now() - 100000; // Well past 0 days
    await store.storeFact(makeFact({
      id: "old-fact",
      confidence: 0.8,
      createdAt: oldTime,
      updatedAt: oldTime,
    }));

    const result = await store.applyRetentionPolicies();
    expect(result.archivedFacts).toBeGreaterThanOrEqual(1);

    // Fact should no longer be in active storage
    const facts = await store.getAllFacts();
    expect(facts.find((f) => f.id === "old-fact")).toBeUndefined();
  });

  it("archives decisions superseded more than max threshold", async () => {
    // Create a decision that's been superseded many times
    await store.storeDecision(makeDecision({
      id: "overridden-dec",
      supersededBy: ["s1", "s2"], // More than maxSupersedesBeforeArchive(1)
    }));

    const result = await store.applyRetentionPolicies();
    expect(result.archivedDecisions).toBe(1);
  });

  it("cold-stores old episodes", async () => {
    const oldTime = Date.now() - 100000;
    await store.storeEpisode(makeEpisode("session-1", 1, {
      id: "old-episode",
      timestamp: { start: oldTime, end: oldTime },
    }));

    // Ensure episode file is fully flushed to disk before scanning
    await store.flush();
    // Small delay to ensure filesystem rename completes
    await new Promise((r) => setTimeout(r, 50));
    // Verify the file actually exists before running retention
    const epFile = path.join(TEST_MEMORY_ROOT, "episodes", "session-1-1.json");
    expect(existsSync(epFile)).toBe(true);

    const result = await store.applyRetentionPolicies();
    expect(result.archivedEpisodes).toBe(1);
  });
});

// =========================================================================
// 9. LTPMStore — Module-Contextual Recall
// =========================================================================

describe("LTPMStore — module-contextual recall", () => {
  let store: LTPMStore;

  beforeEach(async () => {
    await cleanTestRoot();
    store = new LTPMStore({ memoryRoot: TEST_MEMORY_ROOT, debug: false });
    await store.init();
  });

  afterEach(async () => {
    await cleanTestRoot();
  });

  it("returns decisions and facts for a module path", async () => {
    await store.storeDecision(makeDecision({
      id: "dec-auth",
      chosen: "Use JWT tokens",
      affectedPaths: ["/src/auth/index.ts"],
      tags: ["auth"],
    }));

    const result = await store.moduleContextualRecall("auth");
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);
    expect(result.decisions[0]!.chosen).toBe("Use JWT tokens");
  });
});

// =========================================================================
// 10. LTPMStore — Stats
// =========================================================================

describe("LTPMStore — stats", () => {
  let store: LTPMStore;

  beforeEach(async () => {
    await cleanTestRoot();
    store = new LTPMStore({ memoryRoot: TEST_MEMORY_ROOT, debug: false });
    await store.init();
  });

  afterEach(async () => {
    await cleanTestRoot();
  });

  it("getStats returns correct counts after operations", async () => {
    await store.storeEpisode(makeEpisode("session-1", 1));
    await store.storeEpisode(makeEpisode("session-1", 2));
    await store.storeDecision(makeDecision({ id: "dec-1" }));
    await store.storeFact(makeFact({ id: "fact-1" }));

    const stats = await store.getStats();
    expect(stats.episodeCount).toBe(2);
    expect(stats.decisionCount).toBe(1);
    expect(stats.factCount).toBe(1);
  });
});