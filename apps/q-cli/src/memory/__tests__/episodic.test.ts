/**
 * Tests — EpisodicRecall — Episode records, store, TF-IDF scorer,
 * tag assigner, episode builder, and compaction protocol.
 *
 * Step 24: Structured Episode Records & In-Process Compression Store.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  EpisodicRecallStore,
  EpisodeBuilder,
  CompactionProtocolHandler,
  TfIdfScorer,
  assignTags,
} from "../episodic.js";
import type { Episode, ExtractedFact, Decision } from "../types.js";

// =========================================================================
// Helpers

function makeEpisode(overrides?: Partial<Episode>): Episode {
  const now = Date.now();
  return {
    id: overrides?.id ?? "ep-test",
    sessionId: "test-session",
    sequenceNumber: overrides?.sequenceNumber ?? 1,
    timestamp: { start: now, end: now },
    trigger: "compaction",
    summary: overrides?.summary ?? "Test episode",
    decisions: overrides?.decisions ?? [],
    facts: overrides?.facts ?? [],
    affectedFiles: overrides?.affectedFiles ?? [],
    moduleScope: overrides?.moduleScope ?? [],
    outcome: "completed",
    tokenCost: { promptTokens: 0, completionTokens: 0 },
    semanticTags: overrides?.semanticTags ?? ["general"],
    agentProfile: overrides?.agentProfile,
  };
}

// =========================================================================
// 1. EpisodeBuilder

describe("EpisodeBuilder", () => {
  it("builds an episode with auto-generated ID and sequence number", () => {
    const builder = new EpisodeBuilder("test-session");
    const ep = builder.build({
      trigger: "compaction",
      summary: "Refactored auth module",
    });

    expect(ep.id).toBeDefined();
    expect(ep.sessionId).toBe("test-session");
    expect(ep.sequenceNumber).toBe(1);
    expect(ep.trigger).toBe("compaction");
    expect(ep.summary).toBe("Refactored auth module");
  });

  it("increments sequence number on each build", () => {
    const builder = new EpisodeBuilder("test-session");
    builder.build({ trigger: "manual", summary: "First" });
    builder.build({ trigger: "manual", summary: "Second" });
    const ep3 = builder.build({ trigger: "wave_complete", summary: "Third" });

    expect(ep3.sequenceNumber).toBe(3);
  });

  it("assigns default outcome as 'completed'", () => {
    const builder = new EpisodeBuilder("test-session");
    const ep = builder.build({ trigger: "compaction", summary: "Test" });
    expect(ep.outcome).toBe("completed");
  });

  it("accepts explicit outcome override", () => {
    const builder = new EpisodeBuilder("test-session");
    const ep = builder.build({ trigger: "compaction", summary: "Test", outcome: "partial" });
    expect(ep.outcome).toBe("partial");
  });

  it("assigns semantic tags automatically", () => {
    const builder = new EpisodeBuilder("test-session");
    const ep = builder.build({
      trigger: "compaction",
      summary: "Fixed a critical bug in auth module",
    });

    expect(ep.semanticTags).toContain("bugfix");
  });

  it("assigns 'general' tag when nothing specific matches", () => {
    const builder = new EpisodeBuilder("test-session");
    const ep = builder.build({
      trigger: "compaction",
      summary: "Performed routine maintenance tasks",
    });
    expect(ep.semanticTags).toContain("general");
  });
});

// =========================================================================
// 2. Tag Assigner

describe("assignTags", () => {
  it("tags refactor episodes", () => {
    const tags = assignTags("Refactored the core module", []);
    expect(tags).toContain("refactor");
  });

  it("tags bugfix episodes", () => {
    const tags = assignTags("Fixed a critical bug in the login flow", []);
    expect(tags).toContain("bugfix");
  });

  it("tags feature episodes", () => {
    const tags = assignTags("Added a new API endpoint for users", []);
    expect(tags).toContain("feature");
  });

  it("tags auth episodes", () => {
    const tags = assignTags("Implemented OAuth login flow", []);
    expect(tags).toContain("auth");
  });

  it("tags database episodes", () => {
    const tags = assignTags("Created migration for new schema", []);
    expect(tags).toContain("database");
  });

  it("tags test episodes", () => {
    const tags = assignTags("Added vitest tests for the service", []);
    expect(tags).toContain("test");
  });
});

// =========================================================================
// 3. EpisodicRecallStore — write API

describe("EpisodicRecallStore — write API", () => {
  let store: EpisodicRecallStore;

  beforeEach(() => {
    store = new EpisodicRecallStore({ maxEpisodes: 100 });
  });

  it("starts empty", () => {
    expect(store.count).toBe(0);
  });

  it("appends episodes", () => {
    store.append(makeEpisode({ id: "ep-1" }));
    expect(store.count).toBe(1);
  });

  it("appends batch of episodes", () => {
    store.appendBatch([
      makeEpisode({ id: "ep-1" }),
      makeEpisode({ id: "ep-2" }),
    ]);
    expect(store.count).toBe(2);
  });

  it("evicts oldest episodes when over maxEpisodes", () => {
    const smallStore = new EpisodicRecallStore({ maxEpisodes: 3 });
    smallStore.append(makeEpisode({ id: "ep-1", sequenceNumber: 1 }));
    smallStore.append(makeEpisode({ id: "ep-2", sequenceNumber: 2 }));
    smallStore.append(makeEpisode({ id: "ep-3", sequenceNumber: 3 }));
    smallStore.append(makeEpisode({ id: "ep-4", sequenceNumber: 4 }));

    expect(smallStore.count).toBe(3);
    // ep-1 should have been evicted
    const all = smallStore.getAll();
    expect(all.find((e) => e.id === "ep-1")).toBeUndefined();
  });

  it("clears all episodes", () => {
    store.append(makeEpisode());
    store.clear();
    expect(store.count).toBe(0);
  });
});

// =========================================================================
// 4. EpisodicRecallStore — query API

describe("EpisodicRecallStore — query API", () => {
  let store: EpisodicRecallStore;

  beforeEach(() => {
    store = new EpisodicRecallStore({ maxEpisodes: 100 });
    const now = Date.now();
    store.append(makeEpisode({
      id: "ep-1", sequenceNumber: 1, moduleScope: ["core"],
      affectedFiles: ["/src/core/index.ts"],
      semanticTags: ["refactor"],
      summary: "Refactored the core module",
      timestamp: { start: now - 5000, end: now - 4000 },
    }));
    store.append(makeEpisode({
      id: "ep-2", sequenceNumber: 2, moduleScope: ["ui"],
      affectedFiles: ["/src/ui/button.ts"],
      semanticTags: ["bugfix", "ui"],
      summary: "Fixed button alignment issue",
      timestamp: { start: now - 3000, end: now - 2000 },
    }));
    store.append(makeEpisode({
      id: "ep-3", sequenceNumber: 3, moduleScope: ["api", "core"],
      affectedFiles: ["/src/api/route.ts", "/src/core/index.ts"],
      semanticTags: ["feature", "api"],
      summary: "Added new user API endpoint",
      timestamp: { start: now - 1000, end: now },
    }));
  });

  it("getLatest returns most recent episodes in reverse order", () => {
    const latest = store.getLatest(2);
    expect(latest).toHaveLength(2);
    expect(latest[0]!.id).toBe("ep-3");
    expect(latest[1]!.id).toBe("ep-2");
  });

  it("queryByTag filters by tag", () => {
    const results = store.queryByTag(["refactor"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("ep-1");
  });

  it("queryByTag returns episodes matching any of multiple tags", () => {
    const results = store.queryByTag(["bugfix", "feature"]);
    expect(results).toHaveLength(2);
  });

  it("queryByModule filters by module name", () => {
    const results = store.queryByModule("ui");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("ep-2");
  });

  it("queryByModule matches modules touched by affected files", () => {
    const results = store.queryByModule("api");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("ep-3");
  });

  it("queryByTimeRange returns episodes within the range", () => {
    const now = Date.now();
    const results = store.queryByTimeRange(now - 2000, now);
    // ep-3 is in range, ep-2 and ep-1 are not
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((e) => e.id === "ep-3")).toBe(true);
  });

  it("querySemantic returns results sorted by relevance", () => {
    const results = store.querySemantic("refactored core module", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // ep-1 (refactor + core) should be most relevant
    expect(results[0]!.id).toBe("ep-1");
  });

  it("querySemantic finds bugfix-related episodes", () => {
    const results = store.querySemantic("bug fix button alignment", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("ep-2");
  });
});

// =========================================================================
// 5. TF-IDF Scorer

describe("TfIdfScorer", () => {
  it("scores documents and returns ranked results", () => {
    const scorer = new TfIdfScorer();
    scorer.addDocument("refactored core module exports");
    scorer.addDocument("fixed button alignment bug");
    scorer.addDocument("added new user api endpoint");

    const results = scorer.score("core module refactor", 3);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.index).toBe(0); // First doc is most relevant
  });

  it("returns empty for empty corpus", () => {
    const scorer = new TfIdfScorer();
    expect(scorer.score("test", 5)).toEqual([]);
  });

  it("returns empty for empty query", () => {
    const scorer = new TfIdfScorer();
    scorer.addDocument("some text");
    expect(scorer.score("", 5)).toEqual([]);
  });
});

// =========================================================================
// 6. CompactionProtocolHandler

describe("CompactionProtocolHandler", () => {
  it("creates and stores an episode from pending facts", () => {
    const store = new EpisodicRecallStore();
    const handler = new CompactionProtocolHandler(store);

    const facts: ExtractedFact[] = [
      { claim: "API depends on core module", confidence: 0.8, sourceMessageIds: ["msg-1"] },
    ];

    const result = handler.handleCompaction(facts, "Compacted 1 fact");
    expect(result).not.toBeNull();
    expect(result!.episode.facts).toHaveLength(1);
    expect(store.count).toBe(1);
  });

  it("returns null when no data provided", () => {
    const store = new EpisodicRecallStore();
    const handler = new CompactionProtocolHandler(store);

    const result = handler.handleCompaction([]);
    expect(result).toBeNull();
    expect(store.count).toBe(0);
  });

  it("returns recapText with episode-recap tags", () => {
    const store = new EpisodicRecallStore();
    const handler = new CompactionProtocolHandler(store);

    const facts: ExtractedFact[] = [
      { claim: "API depends on core module", confidence: 0.8, sourceMessageIds: ["msg-1"] },
    ];

    const result = handler.handleCompaction(facts, "Compacted 1 fact");
    expect(result).not.toBeNull();
    expect(result!.recapText).toContain("<episode-recap>");
    expect(result!.recapText).toContain("</episode-recap>");
  });

  it("calls LTPM flush callback when configured", async () => {
    let flushed = false;
    const store = new EpisodicRecallStore();
    const handler = new CompactionProtocolHandler(
      store,
      undefined,
      async () => { flushed = true; },
    );

    const facts: ExtractedFact[] = [
      { claim: "API depends on core module", confidence: 0.8, sourceMessageIds: ["msg-1"] },
    ];

    handler.handleCompaction(facts, "Test");
    // Wait a tick for async flush
    await new Promise((r) => setTimeout(r, 10));
    expect(flushed).toBe(true);
  });

  it("recordManual stores a manual episode", () => {
    const store = new EpisodicRecallStore();
    const handler = new CompactionProtocolHandler(store);

    handler.recordManual({
      summary: "Manual review completed",
      affectedFiles: ["/src/core/index.ts"],
      moduleScope: ["core"],
      outcome: "completed",
    });

    expect(store.count).toBe(1);
    const ep = store.getLatest(1)[0]!;
    expect(ep.trigger).toBe("manual");
    expect(ep.summary).toBe("Manual review completed");
  });

  it("recordWaveComplete stores a wave episode", () => {
    const store = new EpisodicRecallStore();
    const handler = new CompactionProtocolHandler(store);

    handler.recordWaveComplete({
      summary: "Wave 2 completed with all tests passing",
      tokenCost: { promptTokens: 500, completionTokens: 200 },
    });

    expect(store.count).toBe(1);
    const ep = store.getLatest(1)[0]!;
    expect(ep.trigger).toBe("wave_complete");
    expect(ep.sessionId).toBeDefined();
  });
});

// =========================================================================
// 7. Store getAll and iteration

describe("EpisodicRecallStore — iteration", () => {
  it("getAll returns a copy of all episodes", () => {
    const store = new EpisodicRecallStore();
    store.append(makeEpisode({ id: "ep-1" }));
    store.append(makeEpisode({ id: "ep-2" }));

    const all = store.getAll();
    expect(all).toHaveLength(2);
    // Modifying the returned array should not affect the store
    all.pop();
    expect(store.count).toBe(2);
  });
});

// =========================================================================
// 8. Episode defaults

describe("Episode defaults", () => {
  it("has default tokenCost when not provided", () => {
    const builder = new EpisodeBuilder();
    const ep = builder.build({ trigger: "compaction", summary: "Test" });
    expect(ep.tokenCost.promptTokens).toBe(0);
    expect(ep.tokenCost.completionTokens).toBe(0);
  });

  it("has an empty moduleScope by default", () => {
    const builder = new EpisodeBuilder();
    const ep = builder.build({ trigger: "compaction", summary: "Test" });
    expect(ep.moduleScope).toEqual([]);
  });
});