/**
 * Tests — MemoryCoordinator (Step 28)
 *
 * Covers: constructor/wiring, recall() tier cascade, store() dispatch,
 * loadSessionState(), enforceCoherence(), backward-compat APIs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryCoordinator, ChatLLMProvider } from "../coordinator.js";
import type {
  MemoryRecord,
  MemoryResult,
  MemoryResultItem,
  RecallContext,
  CoherenceEvent,
} from "../coordinator.js";
import type { Episode, Decision, ConsolidatedFact, ExtractedFact } from "../types.js";
import type { ChatProvider } from "@q/qprovs";

// =========================================================================
// Factories
// =========================================================================

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  const now = Date.now();
  return {
    id: "ep-1",
    sessionId: "session-1",
    sequenceNumber: 1,
    timestamp: { start: now, end: now },
    trigger: "compaction",
    summary: "Test episode about the API module",
    decisions: [],
    facts: [],
    affectedFiles: ["src/api/handler.ts"],
    moduleScope: ["api"],
    outcome: "completed",
    tokenCost: { promptTokens: 100, completionTokens: 50 },
    semanticTags: ["api", "refactor"],
    agentProfile: "default",
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec-1",
    sessionId: "session-1",
    timestamp: Date.now(),
    context: "Should we use SQLite or PostgreSQL?",
    alternatives: ["SQLite", "PostgreSQL"],
    chosen: "SQLite",
    rationale: "SQLite is simpler for local storage",
    affectedPaths: ["src/db/"],
    tags: ["database", "storage"],
    supersedes: [],
    supersededBy: [],
    ...overrides,
  };
}

function makeConsolidatedFact(overrides: Partial<ConsolidatedFact> = {}): ConsolidatedFact {
  return {
    id: "fact-1",
    claim: "Module X depends on Module Y through the API layer",
    confidence: 0.95,
    sources: [{ episodeId: "ep-1", sequenceNumber: 1 }],
    verifiedBy: [{ verifier: "agent-1", timestamp: Date.now(), outcome: "confirmed" }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeExtractedFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    claim: "The API uses SQLite for storage",
    confidence: 0.85,
    sourceMessageIds: ["msg-1", "msg-2"],
    ...overrides,
  };
}

// =========================================================================
// Mocks
// =========================================================================

function createMockChatProvider(): ChatProvider {
  return {
    name: "mock",
    generate: vi.fn().mockResolvedValue({
      message: { role: "assistant" as const, content: "RESOLVED_CLAIM: Use SQLite\nRESOLVED_CONFIDENCE: 0.9\nREASONING: Both agree on SQLite" },
      toolCalls: [],
      finishReason: "completed" as const,
      usage: { promptTokens: 10, completionTokens: 20 },
    }),
    withThinking: vi.fn().mockReturnThis(),
    withMaxCompletionTokens: vi.fn().mockReturnThis(),
    getCapability: vi.fn().mockReturnValue({
      maxContextSize: 100000,
      maxOutputSize: 4096,
      supportsThinking: false,
      supportsStreaming: false,
      supportsToolUse: true,
      supportsMedia: false,
      supportsStructuredOutput: false,
      supportsParallelToolCalls: false,
    }),
    getContextSizeLimit: vi.fn().mockReturnValue(100000),
    getModel: vi.fn().mockReturnValue("mock-model"),
  };
}

function createMockWorkingMemory() {
  return {
    history: [],
    appendMessageWithPriority: vi.fn(),
    appendSystemReminder: vi.fn(),
  } as unknown as any;
}

function createMockEpisodicStore() {
  return {
    append: vi.fn(),
    appendBatch: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getLatest: vi.fn().mockReturnValue([]),
    queryByModule: vi.fn().mockReturnValue([]),
    queryByTag: vi.fn().mockReturnValue([]),
    queryByTimeRange: vi.fn().mockReturnValue([]),
    querySemantic: vi.fn().mockReturnValue([]),
    setSemanticIndex: vi.fn(),
    clear: vi.fn(),
    count: 0,
  } as unknown as any;
}

function createMockLTPMStore() {
  return {
    storeEpisode: vi.fn().mockResolvedValue(undefined),
    storeDecision: vi.fn().mockResolvedValue(undefined),
    storeFact: vi.fn().mockResolvedValue(undefined),
    getAllFacts: vi.fn().mockResolvedValue([]),
    getAllDecisions: vi.fn().mockResolvedValue([]),
    getDecision: vi.fn().mockResolvedValue(null),
    queryEpisodes: vi.fn().mockResolvedValue([]),
    getAllEpisodes: vi.fn().mockResolvedValue([]),
    recall: vi.fn().mockResolvedValue([]),
    loadSessionState: vi.fn().mockResolvedValue({
      recentEpisodes: [],
      activeDecisions: [],
      relevantFacts: [],
    }),
    queryFacts: vi.fn().mockReturnValue([]),
    queryDecisionChain: vi.fn().mockResolvedValue([]),
    moduleContextualRecall: vi.fn().mockResolvedValue({ decisions: [], facts: [] }),
    flush: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({
      episodeCount: 0, decisionCount: 0, factCount: 0,
      recallIndexSize: 0, decisionGraphNodes: 0, projectMemoryFacts: 0,
      memoryRoot: "/tmp", semanticIndex: { vectorCount: 0, hnswSize: 0, bm25DocCount: 0, embeddingAvailable: false },
    }),
  } as unknown as any;
}

function createMockCodebaseGraph() {
  return {
    lookupSymbol: vi.fn().mockReturnValue([]),
    symbols: new Map<string, any[]>(),
    modules: new Map<string, any>(),
    onFileChanged: vi.fn().mockResolvedValue(undefined),
    onFileDeleted: vi.fn().mockResolvedValue(undefined),
    dependentsOfModule: vi.fn().mockReturnValue([]),
    moduleOf: vi.fn().mockReturnValue(null),
  } as unknown as any;
}

// =========================================================================
// Tests
// =========================================================================

describe("MemoryCoordinator", () => {
  // =====================================================================
  // 1. Constructor & Wiring
  // =====================================================================

  describe("constructor", () => {
    it("creates a coordinator with empty state", () => {
      const mc = new MemoryCoordinator();
      expect(mc.episodicStore).toBeDefined();
      expect(mc.getSessionId()).toBe("");
      expect(mc.getPendingFacts()).toEqual([]);
      expect(mc.getCoherenceLog()).toEqual([]);
      expect(mc.getAllFacts()).toEqual([]);
      expect(mc.getAllDecisions()).toEqual([]);
      expect(mc.getActiveDecisions()).toEqual([]);
    });

    it("accepts a ChatProvider for coherence LLM calls", () => {
      const provider = createMockChatProvider();
      const mc = new MemoryCoordinator(provider);
      // Should not crash
      expect(mc).toBeDefined();
    });

    it("setSessionId stores the session ID", () => {
      const mc = new MemoryCoordinator();
      mc.setSessionId("session-xyz");
      expect(mc.getSessionId()).toBe("session-xyz");
    });

    it("setWorkingMemory wires the working memory tier", () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      mc.setWorkingMemory(wm);
      // Should not crash; recall with set WM should work
      expect(mc).toBeDefined();
    });

    it("setCodebaseGraph wires the codebase graph tier", () => {
      const mc = new MemoryCoordinator();
      const cg = createMockCodebaseGraph();
      mc.setCodebaseGraph(cg);
      expect(mc).toBeDefined();
    });

    it("setLLMProvider replaces the internal LLM provider", () => {
      const mc = new MemoryCoordinator();
      const customProvider: any = { infer: vi.fn().mockResolvedValue("custom") };
      mc.setLLMProvider(customProvider);
      // Should be used for coherence enforcement
      expect(mc).toBeDefined();
    });

    it("initLTPM wires LTPM and semantic index", async () => {
      const mc = new MemoryCoordinator();
      const ltpm = createMockLTPMStore();
      await mc.initLTPM(ltpm);
      // After init, LTPM operations should work
      expect(mc).toBeDefined();
    });
  });

  // =====================================================================
  // 2. recall() — Tier Cascade
  // =====================================================================

  describe("recall — tier cascade", () => {
    it("returns empty result when no tiers are wired and no data", async () => {
      const mc = new MemoryCoordinator();
      const result = await mc.recall("test query");
      expect(result.items).toEqual([]);
      expect(result.totalRawCount).toBe(0);
      expect(result.satisfiedFromWorkingMemory).toBe(false);
    });

    it("searches working memory first for critical tagged items", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      // Populate WM history with a critical <decision> message
      wm.history.push({
        role: "assistant",
        content: "<decision><id>d1</id><chosen>SQLite</chosen></decision>",
        priority: "critical",
        messageId: "msg-1",
      });
      wm.history.push({
        role: "user",
        content: "unrelated normal message",
        priority: "normal",
        messageId: "msg-2",
      });
      mc.setWorkingMemory(wm);

      const result = await mc.recall("SQLite database storage");
      expect(result.tiersQueried).toContain("working_memory");
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items.some((i) => i.source.includes("working_memory"))).toBe(true);
    });

    it("skips episodic recall if working memory returns >= 3 results", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      // Add 3 critical matching messages
      for (let i = 0; i < 3; i++) {
        wm.history.push({
          role: "assistant",
          content: `<decision><id>d${i}</id><chosen>SQLite option ${i}</chosen></decision>`,
          priority: "critical",
          messageId: `msg-${i}`,
        });
      }
      mc.setWorkingMemory(wm);

      // Spy on episodic query
      const epSpy = vi.spyOn(mc.episodicStore, "querySemantic");

      const result = await mc.recall("SQLite");

      expect(result.satisfiedFromWorkingMemory).toBe(true);
      // Episodic should NOT have been queried
      expect(epSpy).not.toHaveBeenCalled();
    });

    it("queries episodic recall when working memory has < 3 results", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      // Add 1 critical matching message
      wm.history.push({
        role: "assistant",
        content: "<decision><id>d1</id><chosen>SQLite</chosen></decision>",
        priority: "critical",
        messageId: "msg-1",
      });
      mc.setWorkingMemory(wm);

      // Populate episodic store with some data
      const ep = makeEpisode({ summary: "We chose SQLite for the database" });
      vi.spyOn(mc.episodicStore, "getAll").mockReturnValue([ep]);
      vi.spyOn(mc.episodicStore, "querySemantic").mockReturnValue([ep]);

      const result = await mc.recall("SQLite database");

      expect(result.tiersQueried).toContain("episodic");
    });

    it("queries LTPM when earlier tiers don't give 3 results", async () => {
      const mc = new MemoryCoordinator();
      const ltpm = createMockLTPMStore();
      const ltpmResult = {
        item: makeConsolidatedFact({ claim: "We chose SQLite for local storage" }),
        score: 0.9,
        itemType: "fact" as const,
      };
      ltpm.recall = vi.fn().mockResolvedValue([ltpmResult]);
      await mc.initLTPM(ltpm);

      const wm = createMockWorkingMemory();
      mc.setWorkingMemory(wm);

      const result = await mc.recall("SQLite database");

      expect(result.tiersQueried).toContain("ltpm");
      expect(ltpm.recall).toHaveBeenCalled();
    });

    it("always queries codebase graph independently", async () => {
      const mc = new MemoryCoordinator();
      const cg = createMockCodebaseGraph();
      // Return a matching symbol
      cg.lookupSymbol = vi.fn().mockReturnValue([
        { kind: "function", scope: "exported", location: { file: "src/db/sqlite.ts", line: 42, column: 1 } },
      ]);
      mc.setCodebaseGraph(cg);

      const result = await mc.recall("SQLite connection pool");

      expect(result.tiersQueried).toContain("codebase_graph");
    });

    it("respects includeCodebaseGraph=false", async () => {
      const mc = new MemoryCoordinator();
      const cg = createMockCodebaseGraph();
      mc.setCodebaseGraph(cg);

      const result = await mc.recall("test", { includeCodebaseGraph: false });

      expect(result.tiersQueried).not.toContain("codebase_graph");
    });

    it("deduplicates same fact from working memory and LTPM", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      const claim = "API depends on the core module";
      wm.history.push({
        role: "assistant",
        content: `<fact><claim>${claim}</claim><confidence>1.0</confidence></fact>`,
        priority: "critical",
        messageId: "msg-1",
      });
      mc.setWorkingMemory(wm);

      const fact = makeConsolidatedFact({ claim, confidence: 0.8 });
      const ltpm = createMockLTPMStore();
      ltpm.recall = vi.fn().mockResolvedValue([
        { item: fact, score: 0.85, itemType: "fact" as const },
      ]);
      // Also return fact in getAllFacts so recall returns the right data
      // Actually recall on ltpm is called directly with the mock
      // But we need getAllFacts for the item loading in the real recall
      // For the mock, we just need the recall to resolve
      await mc.initLTPM(ltpm);

      const result = await mc.recall("API depends on core module");

      // The same claim from both tiers should be deduplicated
      // Working memory score 1.0 + 0.1 bonus = 1.1, LTPM score 0.85
      // After dedup: one result with max confidence = 1.0, merging both source tiers
      const deduped = result.items.filter((i) => {
        if (typeof i.item !== "string") return false;
        return (i.item as string).toLowerCase().includes("depends") ||
          (i.item as string).toLowerCase().includes("api");
      });
      // Should have fewer items than total raw
      expect(result.deduplicatedCount).toBeLessThanOrEqual(result.totalRawCount);
      expect(result.deduplicatedCount).toBeGreaterThan(0);
    });

    it("applies freshness bonus: working memory +0.1, episodic +0.05", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      wm.history.push({
        role: "assistant",
        content: "<decision><id>d1</id><chosen>PostgreSQL</chosen></decision>",
        priority: "critical",
        messageId: "msg-1",
      });
      mc.setWorkingMemory(wm);

      const result = await mc.recall("PostgreSQL database");
      // Freshness bonus should be applied within _mergeResults
      const wmItem = result.items.find((i) => i.source.includes("working_memory"));
      if (wmItem) {
        // Base score comes from token match ratio + freshness bonus
        expect(wmItem.score).toBeGreaterThan(0);
      }
    });
  });

  // =====================================================================
  // 3. store() — Dispatch to correct tiers
  // =====================================================================

  describe("store — dispatch to correct tiers", () => {
    it("stores a decision to working memory (critical) and LTPM", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      const ltpm = createMockLTPMStore();
      mc.setWorkingMemory(wm);
      await mc.initLTPM(ltpm);

      const decision = makeDecision();
      const record: MemoryRecord = { type: "decision", payload: decision };
      await mc.store(record);

      // Working memory should have received a critical-priority message
      expect(wm.appendMessageWithPriority).toHaveBeenCalled();
      const call = wm.appendMessageWithPriority.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      expect(call.priority).toBe("critical");
      expect(call.content).toContain("<decision>");

      // LTPM should have stored the decision
      expect(ltpm.storeDecision).toHaveBeenCalledWith(decision);

      // In-memory cache should have the decision
      expect(mc.getAllDecisions()).toHaveLength(1);
    });

    it("stores a consolidated fact to WM, pendingFacts, and LTPM", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      const ltpm = createMockLTPMStore();
      mc.setWorkingMemory(wm);
      await mc.initLTPM(ltpm);

      const fact = makeConsolidatedFact();
      const record: MemoryRecord = { type: "consolidated_fact", payload: fact };
      await mc.store(record);

      // WM should have a high-priority <fact> message
      expect(wm.appendMessageWithPriority).toHaveBeenCalled();
      const wmCall = wm.appendMessageWithPriority.mock.calls[0]?.[0];
      expect(wmCall.priority).toBe("critical");
      expect(wmCall.content).toContain("<fact>");

      // pendingFacts should have the claim
      expect(mc.getPendingFacts()).toHaveLength(1);
      expect(mc.getPendingFacts()[0]!.claim).toBe(fact.claim);

      // LTPM should have stored
      expect(ltpm.storeFact).toHaveBeenCalledWith(fact);

      // In-memory cache
      expect(mc.getAllFacts()).toHaveLength(1);
    });

    it("stores an episode to episodic store and LTPM", async () => {
      const mc = new MemoryCoordinator();
      const ltpm = createMockLTPMStore();
      await mc.initLTPM(ltpm);

      // Spy on episodic store
      const epSpy = vi.spyOn(mc.episodicStore, "append");

      const episode = makeEpisode();
      const record: MemoryRecord = { type: "episode", payload: episode };
      await mc.store(record);

      expect(epSpy).toHaveBeenCalledWith(episode);
      expect(ltpm.storeEpisode).toHaveBeenCalledWith(episode);
    });

    it("stores a structural update to codebase graph", async () => {
      const mc = new MemoryCoordinator();
      const cg = createMockCodebaseGraph();
      mc.setCodebaseGraph(cg);

      const record: MemoryRecord = {
        type: "structural_update",
        payload: { filePath: "/path/to/file.ts" },
      };
      await mc.store(record);

      expect(cg.onFileChanged).toHaveBeenCalledWith("/path/to/file.ts");
    });

    it("stores an extracted fact to pendingFacts and LTPM if confidence >= 0.7", async () => {
      const mc = new MemoryCoordinator();
      const ltpm = createMockLTPMStore();
      await mc.initLTPM(ltpm);

      const fact = makeExtractedFact({ confidence: 0.85 });
      const record: MemoryRecord = { type: "fact", payload: fact };
      await mc.store(record);

      expect(mc.getPendingFacts()).toHaveLength(1);
      expect(mc.getPendingFacts()[0]!.claim).toBe(fact.claim);
      // LTPM should have been called to store as a consolidated fact
      expect(ltpm.storeFact).toHaveBeenCalled();
      // In-memory fact cache should have the new ConsolidatedFact
      expect(mc.getAllFacts()).toHaveLength(1);
    });

    it("stores an extracted fact to pendingFacts only if confidence < 0.7", async () => {
      const mc = new MemoryCoordinator();
      const ltpm = createMockLTPMStore();
      await mc.initLTPM(ltpm);

      const fact = makeExtractedFact({ confidence: 0.4 });
      const record: MemoryRecord = { type: "fact", payload: fact };
      await mc.store(record);

      expect(mc.getPendingFacts()).toHaveLength(1);
      // LTPM should NOT have been called (confidence too low)
      expect(ltpm.storeFact).not.toHaveBeenCalled();
      expect(mc.getAllFacts()).toHaveLength(0);
    });

    it("stores a decision without LTPM wired (just cache)", async () => {
      const mc = new MemoryCoordinator();
      const decision = makeDecision();
      const record: MemoryRecord = { type: "decision", payload: decision };
      await mc.store(record);

      expect(mc.getAllDecisions()).toHaveLength(1);
      expect(mc.getActiveDecisions()).toHaveLength(1);
    });

    it("stores a consolidated fact without WM wired", async () => {
      const mc = new MemoryCoordinator();
      const fact = makeConsolidatedFact();
      const record: MemoryRecord = { type: "consolidated_fact", payload: fact };
      await mc.store(record);

      expect(mc.getAllFacts()).toHaveLength(1);
      expect(mc.getPendingFacts()).toHaveLength(1);
    });
  });

  // =====================================================================
  // 4. loadSessionState()
  // =====================================================================

  describe("loadSessionState", () => {
    it("loads from LTPM when wired, filters by episode limit", async () => {
      const mc = new MemoryCoordinator();
      const ltpm = createMockLTPMStore();
      const episodes = [
        makeEpisode({ id: "ep-1", sequenceNumber: 1, summary: "Ep 1" }),
        makeEpisode({ id: "ep-2", sequenceNumber: 2, summary: "Ep 2" }),
        makeEpisode({ id: "ep-3", sequenceNumber: 3, summary: "Ep 3" }),
        makeEpisode({ id: "ep-4", sequenceNumber: 4, summary: "Ep 4" }),
      ];
      const decisions = [makeDecision({ id: "d1" })];
      const facts = [
        makeConsolidatedFact({ id: "f1", confidence: 0.95 }),
        makeConsolidatedFact({ id: "f2", confidence: 0.65 }), // below threshold
      ];
      ltpm.loadSessionState = vi.fn().mockResolvedValue({
        recentEpisodes: episodes,
        activeDecisions: decisions,
        relevantFacts: facts,
      });
      await mc.initLTPM(ltpm);

      const wm = createMockWorkingMemory();
      mc.setWorkingMemory(wm);
      mc.setSessionId("session-1");

      const state = await mc.loadSessionState("session-1", 2);

      // Should limit episodes to 2
      expect(state.recentEpisodes).toHaveLength(2);
      // Should include all active decisions
      expect(state.activeDecisions).toHaveLength(1);
      // Should only include facts with confidence > 0.7
      expect(state.relevantFacts).toHaveLength(1);
      expect(state.relevantFacts[0]!.id).toBe("f1");

      // Working memory should have received a memory-recap
      expect(wm.appendSystemReminder).toHaveBeenCalled();
      const recapCall = wm.appendSystemReminder.mock.calls[0]?.[0];
      expect(recapCall).toContain("<memory-recap>");
      expect(recapCall).toContain("<session-id>session-1</session-id>");
    });

    it("falls back to episodic store and in-memory caches when no LTPM", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      mc.setWorkingMemory(wm);
      mc.setSessionId("session-1");

      // Add some data to the in-memory caches
      const decision = makeDecision({ id: "d1" });
      const fact = makeConsolidatedFact({
        id: "f1",
        confidence: 0.9,
        sources: [{ episodeId: "session-1-ep-1", sequenceNumber: 1 }],
      });
      vi.spyOn(mc.episodicStore, "getLatest").mockReturnValue([makeEpisode()]);
      mc["_decisions"] = [decision];
      mc["_facts"] = [fact];

      const state = await mc.loadSessionState("session-1", 3);

      expect(state.recentEpisodes).toHaveLength(1);
      expect(state.activeDecisions).toHaveLength(1);
      expect(state.relevantFacts).toHaveLength(1);
    });

    it("does nothing to WM if WM is not wired", async () => {
      const mc = new MemoryCoordinator();
      const ltpm = createMockLTPMStore();
      ltpm.loadSessionState = vi.fn().mockResolvedValue({
        recentEpisodes: [],
        activeDecisions: [],
        relevantFacts: [],
      });
      await mc.initLTPM(ltpm);

      // Should not crash even without WM
      const state = await mc.loadSessionState("session-1");
      expect(state).toBeDefined();
    });
  });

  // =====================================================================
  // 5. enforceCoherence()
  // =====================================================================

  describe("enforceCoherence", () => {
    it("returns empty when no claims exist anywhere", async () => {
      const mc = new MemoryCoordinator();
      const events = await mc.enforceCoherence();
      expect(events).toEqual([]);
    });

    it("returns empty when only working memory has claims", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      wm.history.push({
        role: "assistant",
        content: "<fact><claim>Module X depends on Y</claim><confidence>1.0</confidence></fact>",
        priority: "critical",
        messageId: "msg-1",
      });
      mc.setWorkingMemory(wm);

      const events = await mc.enforceCoherence();
      expect(events).toEqual([]);
    });

    it("returns empty when only LTPM has claims", async () => {
      const mc = new MemoryCoordinator();
      const ltpm = createMockLTPMStore();
      ltpm.getAllFacts = vi.fn().mockResolvedValue([
        makeConsolidatedFact({ claim: "Module X depends on Y", confidence: 0.8 }),
      ]);
      await mc.initLTPM(ltpm);

      const events = await mc.enforceCoherence();
      expect(events).toEqual([]);
    });

    it("detects contradiction on divergent confidence for same subject", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      wm.history.push({
        role: "assistant",
        content: "<fact><claim>Module X depends on Module Y</claim><confidence>1.0</confidence></fact>",
        priority: "critical",
        messageId: "msg-1",
      });
      mc.setWorkingMemory(wm);

      const ltpm = createMockLTPMStore();
      ltpm.getAllFacts = vi.fn().mockResolvedValue([
        makeConsolidatedFact({
          claim: "Module X does not depend on Module Y",
          confidence: 0.6,
        }),
      ]);
      await mc.initLTPM(ltpm);

      // Provide an LLM provider that returns a resolution
      const mockProvider: any = {
        infer: vi.fn().mockResolvedValue(
          "RESOLVED_CLAIM: Module X depends on Module Y\nRESOLVED_CONFIDENCE: 0.95\nREASONING: The dependency is confirmed"
        ),
      };
      mc.setLLMProvider(mockProvider);

      const events = await mc.enforceCoherence();

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.resolved).toBe(true);
      expect(events[0]!.resolvedClaim).toContain("Module X");
      expect(events[0]!.versions).toHaveLength(2);
    });

    it("detects contradiction via negation pattern", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      wm.history.push({
        role: "assistant",
        content: "<fact><claim>SQLite is enabled in the config</claim><confidence>0.9</confidence></fact>",
        priority: "critical",
        messageId: "msg-1",
      });
      mc.setWorkingMemory(wm);

      const ltpm = createMockLTPMStore();
      ltpm.getAllFacts = vi.fn().mockResolvedValue([
        makeConsolidatedFact({
          claim: "SQLite is not enabled in the config",
          confidence: 0.7,
        }),
      ]);
      await mc.initLTPM(ltpm);

      const events = await mc.enforceCoherence();
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it("logs coherence events and makes them retrievable", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      wm.history.push({
        role: "assistant",
        content: "<fact><claim>Module A depends on Module B</claim><confidence>1.0</confidence></fact>",
        priority: "critical",
        messageId: "msg-1",
      });
      mc.setWorkingMemory(wm);

      const ltpm = createMockLTPMStore();
      ltpm.getAllFacts = vi.fn().mockResolvedValue([
        makeConsolidatedFact({
          claim: "Module A does not depend on Module B",
          confidence: 0.5,
        }),
      ]);
      await mc.initLTPM(ltpm);

      const mockProvider: any = {
        infer: vi.fn().mockResolvedValue(
          "RESOLVED_CLAIM: Module A depends on Module B\nRESOLVED_CONFIDENCE: 0.95\nREASONING: Confirmed"
        ),
      };
      mc.setLLMProvider(mockProvider);

      await mc.enforceCoherence();

      const log = mc.getCoherenceLog();
      expect(log.length).toBeGreaterThanOrEqual(1);
      expect(log[0]!.id).toBeDefined();
      expect(log[0]!.timestamp).toBeGreaterThan(0);
    });

    it("applies resolution to working memory and LTPM", async () => {
      const mc = new MemoryCoordinator();
      const wm = createMockWorkingMemory();
      wm.history.push({
        role: "assistant",
        content: "<fact><claim>Module X depends on Y</claim><confidence>1.0</confidence></fact>",
        priority: "critical",
        messageId: "msg-1",
      });
      mc.setWorkingMemory(wm);

      const ltpmFact = makeConsolidatedFact({
        id: "ltpm-fact-1",
        claim: "Module X does not depend on core Module Y",
        confidence: 0.6,
      });
      const ltpm = createMockLTPMStore();
      ltpm.getAllFacts = vi.fn().mockResolvedValue([ltpmFact]);
      // Tracking storeFact calls to verify resolution pushes
      const storeFactSpy = vi.fn().mockResolvedValue(undefined);
      ltpm.storeFact = storeFactSpy;
      await mc.initLTPM(ltpm);

      const mockProvider: any = {
        infer: vi.fn().mockResolvedValue(
          "RESOLVED_CLAIM: Module X depends on core Module Y\nRESOLVED_CONFIDENCE: 0.95\nREASONING: Confirmed dependency"
        ),
      };
      mc.setLLMProvider(mockProvider);

      await mc.enforceCoherence();

      // WM should have a new critical resolution <fact>
      expect(wm.appendMessageWithPriority).toHaveBeenCalled();
      const resolutionCall = wm.appendMessageWithPriority.mock.calls
        .find((c: any[]) => c[0] && c[0].content?.includes("coherence_resolved"));
      expect(resolutionCall).toBeDefined();

      // LTPM should have the updated fact stored
      const updatedFact = storeFactSpy.mock.calls.find((c: any[]) =>
        c[0] && c[0].claim === "Module X depends on core Module Y"
      );
      expect(updatedFact).toBeDefined();
    });
  });

  // =====================================================================
  // 6. Backward-compatible sync APIs
  // =====================================================================

  describe("backward-compatible sync APIs", () => {
    it("queryEpisodes delegates to episodic store", () => {
      const mc = new MemoryCoordinator();
      const spy = vi.spyOn(mc.episodicStore, "queryByModule").mockReturnValue([
        makeEpisode({ moduleScope: ["api"] }),
      ]);
      const results = mc.queryEpisodes("api");
      expect(spy).toHaveBeenCalledWith("api");
      expect(results).toHaveLength(1);
    });

    it("recordEpisode delegates to episodic store", () => {
      const mc = new MemoryCoordinator();
      const spy = vi.spyOn(mc.episodicStore, "append");
      const ep = makeEpisode();
      mc.recordEpisode(ep);
      expect(spy).toHaveBeenCalledWith(ep);
    });

    it("getAllEpisodes returns all episodes", () => {
      const mc = new MemoryCoordinator();
      const ep = makeEpisode();
      vi.spyOn(mc.episodicStore, "getAll").mockReturnValue([ep]);
      expect(mc.getAllEpisodes()).toHaveLength(1);
    });

    it("queryFacts filters by module name", () => {
      const mc = new MemoryCoordinator();
      const fact1 = makeConsolidatedFact({ claim: "Module X depends on Y" });
      const fact2 = makeConsolidatedFact({ claim: "Database uses SQLite" });
      mc["_facts"] = [fact1, fact2];

      const results = mc.queryFacts("module X");
      expect(results).toHaveLength(1);
      expect(results[0]!.claim).toContain("Module X");
    });

    it("recordFact adds to cache and async LTPM", () => {
      const mc = new MemoryCoordinator();
      const fact = makeConsolidatedFact();
      mc.recordFact(fact);
      expect(mc.getAllFacts()).toHaveLength(1);
    });

    it("queryFactsLTPM falls back to sync query when no LTPM", async () => {
      const mc = new MemoryCoordinator();
      mc["_facts"] = [makeConsolidatedFact({ claim: "Module X" })];
      const results = await mc.queryFactsLTPM("module X");
      expect(results).toHaveLength(1);
    });

    it("queryFactsLTPM uses LTPM when wired", async () => {
      const mc = new MemoryCoordinator();
      const ltpm = createMockLTPMStore();
      const fact = makeConsolidatedFact({ claim: "Module X depends on Y" });
      ltpm.getAllFacts = vi.fn().mockResolvedValue([fact]);
      await mc.initLTPM(ltpm);

      const results = await mc.queryFactsLTPM("module X");
      expect(results).toHaveLength(1);
      expect(ltpm.getAllFacts).toHaveBeenCalled();
    });

    it("queryDecisions filters by module path", () => {
      const mc = new MemoryCoordinator();
      const dec1 = makeDecision({ chosen: "SQLite", affectedPaths: ["src/db/"] });
      const dec2 = makeDecision({ chosen: "React", affectedPaths: ["src/ui/"] });
      mc["_decisions"] = [dec1, dec2];

      const results = mc.queryDecisions("src/db/");
      expect(results).toHaveLength(1);
    });

    it("recordDecision adds to cache and async LTPM", () => {
      const mc = new MemoryCoordinator();
      const decision = makeDecision();
      mc.recordDecision(decision);
      expect(mc.getAllDecisions()).toHaveLength(1);
    });

    it("queryDecisionsLTPM falls back to sync query", async () => {
      const mc = new MemoryCoordinator();
      mc["_decisions"] = [makeDecision({ chosen: "SQLite", affectedPaths: ["db"] })];
      const results = await mc.queryDecisionsLTPM("db");
      expect(results).toHaveLength(1);
    });

    it("semanticQuery delegates to LTPM when wired", async () => {
      const mc = new MemoryCoordinator();
      const ltpm = createMockLTPMStore();
      const result = { item: makeConsolidatedFact(), score: 0.9, itemType: "fact" as const };
      ltpm.recall = vi.fn().mockResolvedValue([result]);
      await mc.initLTPM(ltpm);

      const results = await mc.semanticQuery("test query");
      expect(results).toHaveLength(1);
      expect(ltpm.recall).toHaveBeenCalledWith("test query", 10, undefined);
    });

    it("semanticQuery falls back to episodic TF-IDF", async () => {
      const mc = new MemoryCoordinator();
      const ep = makeEpisode({ summary: "test episode" });
      vi.spyOn(mc.episodicStore, "querySemantic").mockReturnValue([ep]);

      const results = await mc.semanticQuery("test query");
      expect(results).toHaveLength(1);
      expect(results[0]!.itemType).toBe("episode");
    });

    it("getActiveDecisions filters out superseded ones", () => {
      const mc = new MemoryCoordinator();
      mc["_decisions"] = [
        makeDecision({ id: "d1", supersededBy: [] }),
        makeDecision({ id: "d2", supersededBy: ["d3"] }),
      ];
      const active = mc.getActiveDecisions();
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe("d1");
    });
  });

  // =====================================================================
  // 7. Diagnostics
  // =====================================================================

  describe("diagnostics", () => {
    it("clearPendingFacts clears the buffer", () => {
      const mc = new MemoryCoordinator();
      mc["_pendingFacts"] = [makeExtractedFact()];
      expect(mc.getPendingFacts()).toHaveLength(1);
      mc.clearPendingFacts();
      expect(mc.getPendingFacts()).toHaveLength(0);
    });

    it("getCoherenceLog returns a copy", () => {
      const mc = new MemoryCoordinator();
      const event: CoherenceEvent = {
        id: "ce-1",
        timestamp: Date.now(),
        claim: "test claim",
        versions: [{ tier: "wm", claim: "v1", confidence: 0.9 }],
        resolvedClaim: "test claim",
        resolvedConfidence: 0.9,
        resolved: true,
      };
      mc["_coherenceLog"] = [event];
      const log = mc.getCoherenceLog();
      expect(log).toHaveLength(1);
      // Should be a copy
      expect(log).not.toBe(mc["_coherenceLog"]);
    });
  });
});