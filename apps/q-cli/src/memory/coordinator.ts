/**
 * MemoryCoordinator — Unified API Across All Four Memory Tiers.
 *
 * Step 28: Provides a single unified API for reading from and writing to
 * all four memory tiers: WorkingMemory (Step 23), EpisodicRecall (Step 24),
 * LTPM (Step 25), and CodebaseGraphIndex (Step 26).
 *
 * The coordinator abstracts the tier selection logic so consumers
 * (orchestrator, task decomposer, memory slicer) do not need to manage
 * tiers directly.
 *
 * Read API: recall() searches tiers in ascending latency order, merging
 * results with deduplication and freshness ordering.
 * Write API: store() dispatches to the correct tier(s) based on record type.
 * loadSessionState() restores session memory on resume.
 * Coherence enforcement detects and resolves cross-tier contradictions via LLM.
 *
 * Depends on: Steps 23–27 (all memory tiers).
 * Consumed by: Step 22 (MemorySliceBuilder), slash commands (TUI).
 */

import { randomUUID } from "node:crypto";
import type { ChatProvider } from "@q/qprovs";
import type {
  Episode,
  Decision,
  ConsolidatedFact,
  ExtractedFact,
  SessionMemoryState,
  RecallFilters,
  ScoredResult,
} from "./types.js";
import { EpisodicRecallStore } from "./episodic.js";
import { LTPMStore } from "./ltpm.js";
import { SemanticRecallIndex } from "./semantic.js";
import { CodebaseGraphIndex } from "./codebase_graph.js";
import { WorkingMemory, type PrioritizedMessage } from "./working.js";

// =========================================================================
// MemoryCoordinator Types
// =========================================================================

/**
 * The type of memory record being stored.
 */
export type MemoryRecordType =
  | "decision"
  | "consolidated_fact"
  | "episode"
  | "structural_update"
  | "fact";

/**
 * A record to store in the memory system.
 * The coordinator dispatches to the correct tier(s) based on type.
 */
export type MemoryRecord =
  | { type: "decision"; payload: Decision }
  | { type: "consolidated_fact"; payload: ConsolidatedFact }
  | { type: "episode"; payload: Episode }
  | {
      type: "structural_update";
      payload: { filePath: string };
    }
  | { type: "fact"; payload: ExtractedFact };

/**
 * Options for the recall query.
 */
export interface RecallContext {
  /** Maximum results to return (default 10) */
  maxResults?: number;
  /** Filter by module scope */
  module?: string;
  /** Filter by semantic tag */
  tag?: string;
  /** Time range filter (Unix ms) */
  timeRange?: { start: number; end: number };
  /** Filter by item type */
  itemType?: "episode" | "decision" | "fact";
  /** Minimum confidence threshold (0-1, default 0) */
  minConfidence?: number;
  /** Whether to include codebase graph results (default true) */
  includeCodebaseGraph?: boolean;
}

/**
 * A single result item from a recall query.
 */
export interface MemoryResultItem {
  /** The underlying item */
  item: Episode | Decision | ConsolidatedFact | string;
  /** The type of item */
  itemType: "episode" | "decision" | "fact" | "codebase" | "working_memory";
  /** Relevance score (0-1) */
  score: number;
  /** Which tier(s) produced this result */
  source: ("working_memory" | "episodic" | "ltpm" | "codebase_graph")[];
  /** Confidence in the item (0-1) */
  confidence: number;
}

/**
 * The result of a recall query.
 */
export interface MemoryResult {
  /** Matched items, ordered by score descending */
  items: MemoryResultItem[];
  /** Total number of items found across all tiers before merging */
  totalRawCount: number;
  /** Number of results after deduplication */
  deduplicatedCount: number;
  /** Whether the query was fully answered from working memory alone */
  satisfiedFromWorkingMemory: boolean;
  /** Tiers that were queried */
  tiersQueried: ("working_memory" | "episodic" | "ltpm" | "codebase_graph")[];
}

/**
 * A coherence event log entry.
 */
export interface CoherenceEvent {
  /** Unique event ID */
  id: string;
  /** When the event occurred */
  timestamp: number;
  /** The factual claim that was contradictory */
  claim: string;
  /** The conflicting versions found */
  versions: Array<{ tier: string; claim: string; confidence: number }>;
  /** The resolved claim after LLM inference */
  resolvedClaim: string;
  /** The resolved confidence */
  resolvedConfidence: number;
  /** Whether the resolution was successful */
  resolved: boolean;
}

/**
 * Minimal LLM inference interface used by the coordinator for coherence
 * enforcement and quick resolution of contradictions.
 */
export interface LLMProvider {
  /**
   * Perform a single-turn (direct) LLM inference.
   * Returns the model's response text.
   */
  infer(prompt: string, system?: string): Promise<string>;
}

// =========================================================================
// Default LLM Provider — Runtime Dependency Injection
// =========================================================================

/**
 * Default LLM provider that uses a ChatProvider for inference.
 * Injected lazily when a provider becomes available.
 */
export class ChatLLMProvider implements LLMProvider {
  private _provider: ChatProvider | null = null;

  constructor(provider?: ChatProvider) {
    this._provider = provider ?? null;
  }

  setProvider(provider: ChatProvider): void {
    this._provider = provider;
  }

  async infer(prompt: string, system?: string): Promise<string> {
    const provider = this._provider;
    if (!provider) {
      return "Unable to resolve: no LLM provider configured.";
    }
    try {
      const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }
      messages.push({ role: "user", content: prompt });

      const response = await provider.generate({ messages });
      return response.message?.content ?? "";
    } catch {
      return "Unable to resolve: LLM inference failed.";
    }
  }
}

// =========================================================================
// MemoryCoordinator
// =========================================================================

export type { Episode, ConsolidatedFact, Decision, SessionMemoryState };

export interface MemoryCoordinatorQueries {
  queryEpisodes(moduleName: string): Episode[];
  queryFacts(moduleName: string): ConsolidatedFact[];
  queryDecisions(moduleName: string): Decision[];
}

/**
 * MemoryCoordinator — Central hub for the multi-tiered memory architecture.
 *
 * Owns references to all four memory tiers:
 * - WorkingMemory (Step 23) — priority-tagged context, critical facts/decisions
 * - EpisodicRecallStore (Step 24) — in-memory episode records
 * - LTPM (Step 25) — persistent facts and decisions
 * - CodebaseGraphIndex (Step 26) — codebase structure
 * - SemanticRecallIndex (Step 27) — vector/BM25 search (via LTPM)
 *
 * Provides a unified recall() / store() API that abstracts tier selection.
 */
export class MemoryCoordinator {
  // ── Tier 0: WorkingMemory (Step 23) ────────────────────────────────────
  private _workingMemory?: WorkingMemory;

  // ── Tier 1: EpisodicRecall (Step 24) ─────────────────────────────────
  readonly episodicStore: EpisodicRecallStore;

  // ── Tier 2-3: LTPM (Step 25) ────────────────────────────────────────
  private _ltpmStore?: LTPMStore;

  // ── Tier 4: CodebaseGraphIndex (Step 26) ─────────────────────────────
  private _codebaseGraph?: CodebaseGraphIndex;

  // ── SemanticRecall (Step 27, accessed via LTPM) ──────────────────────
  private _semanticIndex?: SemanticRecallIndex;

  // ── In-memory caches for backward-compatible sync APIs ───────────────
  private _facts: ConsolidatedFact[] = [];
  private _decisions: Decision[] = [];

  // ── Session tracking ─────────────────────────────────────────────────
  private _sessionId = "";
  private _pendingFacts: ExtractedFact[] = [];

  // ── Coherence enforcement ────────────────────────────────────────────
  private _llmProvider: LLMProvider;
  private _coherenceLog: CoherenceEvent[] = [];
  private _maxCoherenceLogSize = 100;

  constructor(provider?: ChatProvider) {
    this.episodicStore = new EpisodicRecallStore();
    this._llmProvider = new ChatLLMProvider(provider);
  }

  // ========================================================================
  // Initialization & Wiring
  // ========================================================================

  /**
   * Set the session ID for this coordinator instance.
   */
  setSessionId(sessionId: string): void {
    this._sessionId = sessionId;
  }

  /**
   * Wire up the WorkingMemory tier.
   */
  setWorkingMemory(workingMemory: WorkingMemory): void {
    this._workingMemory = workingMemory;
  }

  /**
   * Wire up the LTPM store and semantic index.
   * Must be called before any persistent memory operations.
   */
  async initLTPM(ltpmStore: LTPMStore, semanticIndex?: SemanticRecallIndex): Promise<void> {
    this._ltpmStore = ltpmStore;
    this._semanticIndex = semanticIndex;
    if (semanticIndex) {
      this.episodicStore.setSemanticIndex(semanticIndex);
    }
  }

  /**
   * Wire up the CodebaseGraphIndex tier.
   */
  setCodebaseGraph(codebaseGraph: CodebaseGraphIndex): void {
    this._codebaseGraph = codebaseGraph;
  }

  /**
   * Set or replace the LLM provider for coherence enforcement.
   */
  setLLMProvider(provider: LLMProvider): void {
    this._llmProvider = provider;
  }

  // ========================================================================
  // READ API — recall(query, context?)
  // ========================================================================

  /**
   * Unified recall across all memory tiers.
   *
   * Strategy:
   * 1. First searches WorkingMemory for any facts or decisions tagged as
   *    'critical' that match the query (keyword scan of <decision> and
   *    <fact> system messages).
   * 2. If fewer than 3 results, searches EpisodicRecall (in-process, ~1ms).
   * 3. If still not sufficient, searches LTPM (slower, disk-backed,
   *    ~50-200ms with vector search).
   * 4. Simultaneously (independent of steps 1-3), queries the
   *    CodebaseGraphIndex for structural info matching query terms.
   * 5. Merges results from all tiers into a single MemoryResult with
   *    deduplication and freshness ordering.
   */
  async recall(query: string, context?: RecallContext): Promise<MemoryResult> {
    const maxResults = context?.maxResults ?? 10;
    const tiersQueried: MemoryResult["tiersQueried"] = [];
    const allItems: MemoryResultItem[] = [];
    let satisfiedFromWorkingMemory = false;

    // ── Step 1: Search WorkingMemory (fast — in-memory keyword scan) ──
    const wmItems = this._searchWorkingMemory(query, context);
    allItems.push(...wmItems);
    tiersQueried.push("working_memory");
    if (wmItems.length >= 3) {
      satisfiedFromWorkingMemory = true;
    }

    // ── Step 2: Search EpisodicRecall (in-process TF-IDF, ~1ms) ───────
    // Only if working memory didn't already give us enough
    if (!satisfiedFromWorkingMemory) {
      const epItems = this._searchEpisodic(query, context, maxResults);
      allItems.push(...epItems);
      tiersQueried.push("episodic");
    }

    // ── Step 3: Search LTPM (disk-backed, 50-200ms) ──────────────────
    // Only if earlier tiers didn't collectively give enough
    const currentCount = allItems.length;
    if (currentCount < 3 && this._ltpmStore) {
      const ltpmItems = await this._searchLTPM(query, context, maxResults);
      allItems.push(...ltpmItems);
      tiersQueried.push("ltpm");
    }

    // ── Step 4: CodebaseGraphIndex query (structural search) ──────────
    // Always runs (independent of results from other tiers)
    if (context?.includeCodebaseGraph !== false && this._codebaseGraph) {
      const cgItems = this._searchCodebaseGraph(query, context);
      allItems.push(...cgItems);
      tiersQueried.push("codebase_graph");
    }

    // ── Step 5: Merge, deduplicate, and score ──────────────────────────
    const merged = this._mergeResults(allItems, maxResults);

    // Apply minConfidence filter globally across all merged results
    let filteredItems = merged.items;
    if (context?.minConfidence !== undefined) {
      filteredItems = filteredItems.filter(
        (i) => i.confidence >= context.minConfidence!,
      );
    }

    return {
      items: filteredItems,
      totalRawCount: allItems.length,
      deduplicatedCount: merged.items.length,
      satisfiedFromWorkingMemory,
      tiersQueried: [...new Set(tiersQueried)],
    };
  }

  // ========================================================================
  // WRITE API — store(record)
  // ========================================================================

  /**
   * Unified store across all memory tiers.
   *
   * Dispatches to the correct tier(s) based on record type:
   * - decisions → WorkingMemory (as 'critical' priority) + LTPM (persistent)
   * - consolidated facts → WorkingMemory + EpisodicRecall (pendingFacts) + LTPM
   * - episodes → EpisodicRecall + LTPM
   * - structural updates → CodebaseGraphIndex (onFileChanged)
   * - extracted facts → WorkingMemory pendingFacts buffer + LTPM
   */
  async store(record: MemoryRecord): Promise<void> {
    switch (record.type) {
      case "decision":
        await this._storeDecision(record.payload);
        break;
      case "consolidated_fact":
        await this._storeConsolidatedFact(record.payload);
        break;
      case "episode":
        await this._storeEpisode(record.payload);
        break;
      case "structural_update":
        await this._storeStructuralUpdate(record.payload);
        break;
      case "fact":
        await this._storeFact(record.payload);
        break;
    }
  }

  // ========================================================================
  // Session State Management
  // ========================================================================

  /**
   * Load session memory state for session resume.
   *
   * Loads the last N episodes from LTPM (default 3), all active
   * non-superseded decisions, all active consolidated facts with
   * confidence > 0.7, and injects them into WorkingMemory as
   * system reminders (formatted as <memory-recap> messages).
   *
   * @param sessionId - The session to load state for
   * @param episodeLimit - Number of recent episodes to load (default 3)
   */
  async loadSessionState(
    sessionId: string,
    episodeLimit: number = 3,
  ): Promise<SessionMemoryState> {
    let state: SessionMemoryState;

    if (this._ltpmStore) {
      // Load full state from LTPM
      const fullState = await this._ltpmStore.loadSessionState(sessionId);
      state = {
        recentEpisodes: fullState.recentEpisodes.slice(0, episodeLimit),
        activeDecisions: fullState.activeDecisions,
        relevantFacts: fullState.relevantFacts.filter((f) => f.confidence > 0.7),
      };
    } else {
      // Fallback: use episodic store + in-memory caches
      const episodes = this.episodicStore.getLatest(episodeLimit);
      const activeDecisions = this._decisions.filter((d) => d.supersededBy.length === 0);
      const relevantFacts = this._facts.filter(
        (f) => f.confidence > 0.7 &&
          f.sources.some((s) => s.episodeId.startsWith(sessionId)),
      );
      state = { recentEpisodes: episodes, activeDecisions, relevantFacts };
    }

    // Inject into WorkingMemory as <memory-recap> messages
    this._injectMemoryRecap(state, sessionId);

    return state;
  }

  // ========================================================================
  // Coherence Enforcement
  // ========================================================================

  /**
   * Detect and resolve contradictions across memory tiers.
   *
   * If the same factual claim appears in two tiers with contradictory
   * confidence (e.g., "Module X depends on Y" in WorkingMemory with
   * confidence: 1.0, but "Module X does not depend on Y" in LTPM with
   * confidence: 0.6), run a quick LLM inference to resolve the
   * contradiction, update all tiers with the resolved version, and
   * log the coherence event.
   *
   * @returns A list of coherence events that were resolved
   */
  async enforceCoherence(): Promise<CoherenceEvent[]> {
    const events: CoherenceEvent[] = [];

    // Collect all factual claims from WorkingMemory and LTPM
    const wmClaims = this._extractWorkingMemoryClaims();
    let ltpmClaims: Array<{ claim: string; confidence: number }> = [];

    if (this._ltpmStore) {
      const allFacts = await this._ltpmStore.getAllFacts();
      ltpmClaims = allFacts.map((f) => ({
        claim: f.claim,
        confidence: f.confidence,
      }));
    }

    if (wmClaims.length === 0 || ltpmClaims.length === 0) {
      return events; // No contradictions possible
    }

    // Find contradictory claims by keyword overlap
    const contradictions = this._findContradictions(wmClaims, ltpmClaims);

    for (const contradiction of contradictions) {
      const event = await this._resolveContradiction(contradiction);
      if (event) {
        events.push(event);
        this._logCoherenceEvent(event);
      }
    }

    return events;
  }

  // ========================================================================
  // Episode queries (Step 24 — EpisodicRecall)
  // ========================================================================

  /** Query episodes relevant to a given module. */
  queryEpisodes(moduleName: string): Episode[] {
    return this.episodicStore.queryByModule(moduleName);
  }

  /** Record a new episode. */
  recordEpisode(episode: Episode): void {
    this.episodicStore.append(episode);
  }

  /** Get all stored episodes. */
  getAllEpisodes(): Episode[] {
    return this.episodicStore.getAll();
  }

  // ========================================================================
  // Fact queries (Step 25 — LTPM)
  // ========================================================================

  /** Query consolidated facts relevant to a given module (sync). */
  queryFacts(moduleName: string): ConsolidatedFact[] {
    const lower = moduleName.toLowerCase();
    return this._facts.filter(
      (fact) =>
        (fact.claim && fact.claim.toLowerCase().includes(lower)) ||
        fact.verifiedBy.some((v) => v.verifier.toLowerCase().includes(lower)),
    );
  }

  /** Record a new consolidated fact (sync + async persist). */
  recordFact(fact: ConsolidatedFact): void {
    this._facts.push(fact);
    if (this._ltpmStore) {
      this._ltpmStore.storeFact(fact).catch((err) => {
        console.error("[MemoryCoordinator] LTPM storeFact failed:", err);
      });
    }
  }

  /** Get all stored facts (in-memory cache). */
  getAllFacts(): ConsolidatedFact[] {
    return [...this._facts];
  }

  /** Query facts from LTPM (async). */
  async queryFactsLTPM(moduleName: string): Promise<ConsolidatedFact[]> {
    if (this._ltpmStore) {
      const all = await this._ltpmStore.getAllFacts();
      const lower = moduleName.toLowerCase();
      return all.filter(
        (fact) =>
          (fact.claim && fact.claim.toLowerCase().includes(lower)) ||
          fact.verifiedBy.some((v) => v.verifier.toLowerCase().includes(lower)),
      );
    }
    return this.queryFacts(moduleName);
  }

  // ========================================================================
  // Decision queries (Step 25 — LTPM)
  // ========================================================================

  /** Query decisions relevant to a given module (sync). */
  queryDecisions(moduleName: string): Decision[] {
    const lower = moduleName.toLowerCase();
    return this._decisions.filter(
      (dec) =>
        (dec.context && dec.context.toLowerCase().includes(lower)) ||
        (dec.chosen && dec.chosen.toLowerCase().includes(lower)) ||
        dec.affectedPaths.some((p) => p.toLowerCase().includes(lower)),
    );
  }

  /** Record a new decision (sync + async persist). */
  recordDecision(decision: Decision): void {
    this._decisions.push(decision);
    if (this._ltpmStore) {
      this._ltpmStore.storeDecision(decision).catch((err) => {
        console.error("[MemoryCoordinator] LTPM storeDecision failed:", err);
      });
    }
  }

  /** Get all stored decisions. */
  getAllDecisions(): Decision[] {
    return [...this._decisions];
  }

  /** Get active (non-superseded) decisions. */
  getActiveDecisions(): Decision[] {
    return this._decisions.filter((d) => d.supersededBy.length === 0);
  }

  /** Query decisions from LTPM (async). */
  async queryDecisionsLTPM(moduleName: string): Promise<Decision[]> {
    if (this._ltpmStore) {
      const all = await this._ltpmStore.getAllDecisions();
      const lower = moduleName.toLowerCase();
      return all.filter(
        (dec) =>
          (dec.context && dec.context.toLowerCase().includes(lower)) ||
          (dec.chosen && dec.chosen.toLowerCase().includes(lower)) ||
          dec.affectedPaths.some((p) => p.toLowerCase().includes(lower)),
      );
    }
    return this.queryDecisions(moduleName);
  }

  // ========================================================================
  // Semantic Recall (Step 27)
  // ========================================================================

  /**
   * Semantic search across all memory tiers.
   * Delegates to LTPM's recall() which uses SemanticRecallIndex.
   */
  async semanticQuery(
    query: string,
    maxResults: number = 10,
    filters?: RecallFilters,
  ): Promise<ScoredResult[]> {
    if (this._ltpmStore) {
      return this._ltpmStore.recall(query, maxResults, filters);
    }
    // Fallback: TF-IDF on episodic store only
    const episodes = this.episodicStore.querySemantic(query, maxResults);
    return episodes.map((ep) => ({ item: ep, score: 0.5, itemType: "episode" as const }));
  }

  // ========================================================================
  // Diagnostics
  // ========================================================================

  /** Get the coherence event log. */
  getCoherenceLog(): CoherenceEvent[] {
    return [...this._coherenceLog];
  }

  /** Get pending extracted facts buffer. */
  getPendingFacts(): ExtractedFact[] {
    return [...this._pendingFacts];
  }

  /** Clear pending facts buffer. */
  clearPendingFacts(): void {
    this._pendingFacts = [];
  }

  /** Get the current session ID. */
  getSessionId(): string {
    return this._sessionId;
  }

  /**
   * Forget (delete) a memory item by its ID across all tiers.
   *
   * Checks each tier in order (working memory, episodic, LTPM) and removes
   * the item where found. Returns the tier where the item was deleted,
   * or null if not found in any tier.
   */
  async forget(id: string): Promise<"working_memory" | "episodic" | "ltpm" | null> {
    // WorkingMemory — remove any messages containing this ID
    if (this._workingMemory) {
      const removed = this._workingMemory.removeContentContaining(id);
      if (removed > 0) {
        return "working_memory";
      }
    }

    // EpisodicRecallStore — remove by ID
    const removedFromEpisodic = this.episodicStore.removeById(id);
    if (removedFromEpisodic) {
      return "episodic";
    }

    // LTPMStore — delete by ID across all item types
    if (this._ltpmStore) {
      const result = await this._ltpmStore.deleteById(id);
      if (result) {
        return "ltpm";
      }
    }

    return null;
  }

  /**
   * Get comprehensive diagnostics for all four memory tiers.
   */
  async getDiagnostics(): Promise<{
    workingMemory: {
      totalMessages: number;
      compactionLevel: number;
      totalTokens: number;
      contextLimit: number;
      pendingFacts: number;
    };
    episodic: {
      episodeCount: number;
      latestEpisodeTimestamp: number | null;
      averageTokenCost: number;
    };
    ltpm: {
      decisionCount: number;
      factCount: number;
      episodeCount: number;
      vectorIndexSize: number;
      lastConsolidationTime: number | null;
      memoryRoot: string;
    };
    codebaseGraph: {
      fileCount: number;
      symbolCount: number;
      moduleCount: number;
      lastRefreshTimestamp: number | null;
    };
  }> {
    // WorkingMemory
    const wm = this._workingMemory;
    const totalMessages = wm ? wm.history.length : 0;
    const totalTokens = wm ? wm.tokenCount : 0;
    const contextLimit = wm ? wm.contextLimit : 128_000;
    const compactionLevel = contextLimit > 0 ? Math.min(1, totalTokens / contextLimit) : 0;
    const pendingFacts = wm ? wm.pendingFacts.length : 0;

    // EpisodicRecall
    const allEpisodes = this.episodicStore.getAll();
    const episodeCount = allEpisodes.length;
    let latestEpisodeTimestamp: number | null = null;
    let totalTokenCost = 0;
    for (const ep of allEpisodes) {
      if (ep.timestamp.end > (latestEpisodeTimestamp ?? 0)) {
        latestEpisodeTimestamp = ep.timestamp.end;
      }
      totalTokenCost += (ep.tokenCost.promptTokens + ep.tokenCost.completionTokens);
    }
    const averageTokenCost = episodeCount > 0 ? totalTokenCost / episodeCount : 0;

    // LTPM
    let decisionCount = this._decisions.length;
    let factCount = this._facts.length;
    const ltpmEpisodeCount = allEpisodes.length;
    let vectorIndexSize = 0;
    let lastConsolidationTime: number | null = null;
    let memoryRoot = "";
    let vectorCount = 0;

    if (this._ltpmStore) {
      try {
        const stats = await this._ltpmStore.getStats();
        decisionCount = Math.max(decisionCount, stats.decisionCount);
        factCount = Math.max(factCount, stats.factCount);
        vectorCount = stats.semanticIndex.vectorCount;
        // Approx MB: 384-dim Float32 = 1536 bytes per vector + ~20% HNSW overhead
        vectorIndexSize = Math.round((vectorCount * 1536 * 1.2) / (1024 * 1024));
        memoryRoot = stats.memoryRoot;
        lastConsolidationTime = stats.lastConsolidationTime;
      } catch {
        // Silently use in-memory fallback
      }
    }

    // CodebaseGraphIndex
    const cg = this._codebaseGraph;
    const fileCount = cg ? cg.files.size : 0;
    const symbolCount = cg ? cg.symbols.size : 0;
    const moduleCount = cg ? cg.modules.size : 0;
    let lastRefreshTimestamp: number | null = null;
    if (cg && fileCount > 0) {
      // Find the latest mtime across all file nodes as refresh indicator
      let latestMtime = 0;
      for (const [, node] of cg.files) {
        if (node.mtime > latestMtime) {
          latestMtime = node.mtime;
        }
      }
      lastRefreshTimestamp = latestMtime > 0 ? latestMtime : null;
    }

    return {
      workingMemory: {
        totalMessages,
        compactionLevel,
        totalTokens,
        contextLimit,
        pendingFacts,
      },
      episodic: {
        episodeCount,
        latestEpisodeTimestamp,
        averageTokenCost,
      },
      ltpm: {
        decisionCount,
        factCount,
        episodeCount: ltpmEpisodeCount,
        vectorIndexSize,
        lastConsolidationTime,
        memoryRoot,
      },
      codebaseGraph: {
        fileCount,
        symbolCount,
        moduleCount,
        lastRefreshTimestamp,
      },
    };
  }

  // ========================================================================
  // Private: WorkingMemory Search
  // ========================================================================

  /**
   * Search WorkingMemory for critical facts/decisions matching the query.
   *
   * Scans the message history for <decision> and <fact> system messages
   * tagged with 'critical' priority, performing keyword matching.
   */
  private _searchWorkingMemory(
    query: string,
    context?: RecallContext,
  ): MemoryResultItem[] {
    const wm = this._workingMemory;
    if (!wm) return [];

    const queryLower = query.toLowerCase();
    const queryTokens = queryLower.match(/\b\w{3,}\b/g) ?? [];
    if (queryTokens.length === 0) return [];

    const items: MemoryResultItem[] = [];
    const history = wm.history as readonly PrioritizedMessage[];

    for (const msg of history) {
      // Only search critical-priority messages
      if (msg.priority !== "critical") continue;

      const content = msg.content ?? "";
      const contentLower = content.toLowerCase();

      // Check if any query token appears in the message
      const matchCount = queryTokens.filter((t) => contentLower.includes(t)).length;
      if (matchCount === 0) continue;

      // Check for <decision> or <fact> tags
      const hasDecisionTag = content.includes("<decision>") || content.includes("</decision>");
      const hasFactTag = content.includes("<fact>") || content.includes("</fact>");

      if (!hasDecisionTag && !hasFactTag) continue;

      // Score: ratio of matched tokens to total query tokens
      const score = 0.5 + (matchCount / Math.max(queryTokens.length, 1)) * 0.5;

      items.push({
        item: content,
        itemType: "working_memory",
        score,
        source: ["working_memory"],
        confidence: 1.0, // Working memory items are high-confidence
      });
    }

    // Apply itemType filter
    if (context?.itemType) {
      // Working memory results always returned as supplementary context;
      // the itemType filter applies to non-working-memory results.
      // No filtering needed here.
    }

    // Sort by score descending
    items.sort((a, b) => b.score - a.score);
    return items;
  }

  // ========================================================================
  // Private: EpisodicRecall Search
  // ========================================================================

  /**
   * Search EpisodicRecallStore using TF-IDF keyword scoring.
   */
  private _searchEpisodic(
    query: string,
    context?: RecallContext,
    maxResults: number = 10,
  ): MemoryResultItem[] {
    // Apply filters before semantic search if possible
    let candidates: Episode[];

    if (context?.module) {
      candidates = this.episodicStore.queryByModule(context.module);
    } else if (context?.tag) {
      candidates = this.episodicStore.queryByTag([context.tag]);
    } else if (context?.timeRange) {
      candidates = this.episodicStore.queryByTimeRange(
        context.timeRange.start,
        context.timeRange.end,
      );
    } else {
      candidates = this.episodicStore.getAll();
    }

    // If we have a specific itemType filter, filter further
    if (context?.itemType && context.itemType !== "episode") {
      return []; // No episodes match non-episode filter
    }

    if (candidates.length === 0) return [];

    // Get TF-IDF scored results from the full store, then intersect with candidates
    const scored = this.episodicStore.querySemantic(query, Math.max(maxResults * 2, 20));
    const candidateIdSet = new Set(candidates.map((ep) => ep.id));
    const filtered = scored.filter((ep) => candidateIdSet.has(ep.id)).slice(0, maxResults);

    return filtered.map((ep) => ({
      item: ep,
      itemType: "episode" as const,
      score: 0.6,
      source: ["episodic" as const],
      confidence: ep.outcome === "completed" ? 0.8 : 0.5,
    }));
  }

  // ========================================================================
  // Private: LTPM Search
  // ========================================================================

  /**
   * Search LTPM store using semantic recall / BM25 fallback.
   */
  private async _searchLTPM(
    query: string,
    context?: RecallContext,
    maxResults: number = 10,
  ): Promise<MemoryResultItem[]> {
    if (!this._ltpmStore) return [];

    const filters: RecallFilters = {};
    if (context?.module) filters.module = context.module;
    if (context?.tag) filters.tag = context.tag;
    if (context?.timeRange) filters.timeRange = context.timeRange;
    if (context?.itemType) filters.itemType = context.itemType;

    try {
      const results = await this._ltpmStore.recall(query, maxResults, filters);

      return results.map((r) => ({
        item: r.item,
        itemType: r.itemType,
        score: r.score,
        source: ["ltpm" as const],
        confidence: "confidence" in r.item ? (r.item as ConsolidatedFact).confidence : 0.5,
      }));
    } catch {
      return [];
    }
  }

  // ========================================================================
  // Private: CodebaseGraphIndex Search
  // ========================================================================

  /**
   * Query the CodebaseGraphIndex for structural information relevant
   * to the query (symbol definitions matching query terms, module deps).
   */
  private _searchCodebaseGraph(
    query: string,
    context?: RecallContext,
  ): MemoryResultItem[] {
    const cg = this._codebaseGraph;
    if (!cg) return [];

    const queryLower = query.toLowerCase();
    const queryTokens = queryLower.match(/\b\w{3,}\b/g) ?? [];
    if (queryTokens.length === 0) return [];

    const items: MemoryResultItem[] = [];
    const seenSymbols = new Set<string>();

    // Look up each query token as a symbol name
    for (const token of queryTokens) {
      const refs = cg.lookupSymbol(token);

      // Also try case-insensitive match on all symbols
      if (refs.length === 0) {
        // Iterate symbol keys for fuzzy match
        for (const [symName, symRefs] of cg.symbols) {
          if (symName.toLowerCase().includes(token)) {
            for (const ref of symRefs) {
              if (seenSymbols.has(symName)) continue;
              seenSymbols.add(symName);

              items.push({
                item: `Symbol: ${symName} (${ref.kind}, ${ref.scope}) at ${ref.location.file}:${ref.location.line}`,
                itemType: "codebase",
                score: 0.4,
                source: ["codebase_graph"],
                confidence: 0.9,
              });
            }
          }
        }
      } else {
        for (const ref of refs) {
          if (seenSymbols.has(token)) continue;
          seenSymbols.add(token);

          items.push({
            item: `Symbol: ${token} (${ref.kind}, ${ref.scope}) at ${ref.location.file}:${ref.location.line}`,
            itemType: "codebase",
            score: 0.5,
            source: ["codebase_graph"],
            confidence: 0.9,
          });
        }
      }
    }

    // Also include module dependency info if query mentions a module
    if (context?.module) {
      const moduleName = context.module;
      const mod = cg.modules.get(moduleName);
      if (mod) {
        // Add dependency structure
        const depInfo = `Module "${moduleName}" depends on: ${mod.internalDeps.join(", ") || "none"}`;
        items.push({
          item: depInfo,
          itemType: "codebase",
          score: 0.6,
          source: ["codebase_graph"],
          confidence: 1.0,
        });

        // Add dependent info
        const dependents = cg.dependentsOfModule(moduleName);
        if (dependents.length > 0) {
          items.push({
            item: `Module "${moduleName}" is depended on by: ${dependents.join(", ")}`,
            itemType: "codebase",
            score: 0.55,
            source: ["codebase_graph"],
            confidence: 1.0,
          });
        }
      }
    }

    // Filter by minConfidence
    if (context?.minConfidence !== undefined) {
      return items.filter((i) => i.confidence >= context.minConfidence!);
    }

    return items;
  }

  // ========================================================================
  // Private: Merge, Deduplicate, and Score Results
  // ========================================================================

  /**
   * Merge results from all tiers with deduplication and freshness ordering.
   *
   * - Same fact from working memory and LTPM → return once with merged
   *   confidence via Math.max
   * - Freshness ordering: working memory results get +0.1 score bonus,
   *   episodic gets +0.05, LTPM gets base score
   */
  private _mergeResults(
    items: MemoryResultItem[],
    maxResults: number,
  ): { items: MemoryResultItem[] } {
    if (items.length === 0) return { items: [] };

    // Apply freshness bonuses
    for (const item of items) {
      if (item.source.includes("working_memory")) {
        item.score += 0.1;
      } else if (item.source.includes("episodic")) {
        item.score += 0.05;
      }
    }

    // Deduplication: group by a normalized key and merge
    const dedupMap = new Map<string, MemoryResultItem>();

    for (const item of items) {
      const key = this._dedupKey(item);
      const existing = dedupMap.get(key);

      if (existing) {
        // Merge: take max confidence, merge sources, max score
        existing.confidence = Math.max(existing.confidence, item.confidence);
        existing.score = Math.max(existing.score, item.score);

        // Merge source tiers
        for (const src of item.source) {
          if (!existing.source.includes(src)) {
            existing.source.push(src);
          }
        }

        // If we have the same item from multiple sources, prefer the
        // one with higher confidence for the item field
        if (item.confidence > existing.confidence) {
          existing.item = item.item;
          existing.itemType = item.itemType;
        }
      } else {
        dedupMap.set(key, { ...item, source: [...item.source] });
      }
    }

    // Sort by score descending
    const merged = Array.from(dedupMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return { items: merged };
  }

  /**
   * Create a stable deduplication key for a MemoryResultItem.
   *
   * For cross-tier dedup, extracts the <claim> tag from string items
   * so the same fact from working memory (raw string) and LTPM
   * (ConsolidatedFact) produces the same key.
   */
  private _dedupKey(item: MemoryResultItem): string {
    if (typeof item.item === "string") {
      // For string items (codebase results or WM fact/decision blocks),
      // try to extract <claim> tag for cross-tier dedup with LTPM facts.
      const claimMatch = item.item.match(/<claim>([^<]+)<\/claim>/i);
      if (claimMatch) {
        return `claim:${claimMatch[1]!.trim().toLowerCase()}`;
      }
      // For decisions, extract <chosen> tag
      const chosenMatch = item.item.match(/<chosen>([^<]+)<\/chosen>/i);
      if (chosenMatch) {
        return `decision:${chosenMatch[1]!.trim().toLowerCase()}`;
      }
      // For codebase results, use the string content
      return `string:${item.item.toLowerCase().trim()}`;
    }

    // For structured items, use ID or claim
    const obj = item.item as unknown as Record<string, unknown>;
    if (typeof obj.id === "string") {
      return `id:${obj.id}`;
    }
    if (typeof obj.claim === "string") {
      return `claim:${obj.claim.toLowerCase().trim()}`;
    }

    // Fallback: type + summary
    if (item.itemType === "episode") {
      const ep = item.item as Episode;
      return `ep:${ep.sessionId}:${ep.sequenceNumber}`;
    }

    return `${item.itemType}:${String(obj.id ?? "")}`;
  }

  // ========================================================================
  // Private: Store Dispatchers
  // ========================================================================

  /**
   * Store a decision:
   * - WorkingMemory: inject as 'critical' priority <decision> message
   * - LTPM: persist via storeDecision()
   */
  private async _storeDecision(decision: Decision): Promise<void> {
    // In-memory cache
    this._decisions.push(decision);

    // WorkingMemory: inject as critical-priority <decision> message
    if (this._workingMemory) {
      const decisionBlock = `<decision>
  <id>${decision.id}</id>
  <context>${decision.context}</context>
  <chosen>${decision.chosen}</chosen>
  <rationale>${decision.rationale}</rationale>
  <paths>${decision.affectedPaths.join(", ")}</paths>
  <tags>${decision.tags.join(", ")}</tags>
</decision>`;
      this._workingMemory.appendMessageWithPriority({
        role: "assistant",
        content: decisionBlock,
        priority: "critical",
      });
    }

    // LTPM: persist
    if (this._ltpmStore) {
      try {
        await this._ltpmStore.storeDecision(decision);
      } catch (err) {
        console.error("[MemoryCoordinator] LTPM storeDecision failed:", err);
      }
    }
  }

  /**
   * Store a consolidated fact:
   * - WorkingMemory: inject as high-priority <fact> message
   * - EpisodicRecall: add to pendingFacts buffer for next episode
   * - LTPM: persist via storeFact()
   */
  private async _storeConsolidatedFact(fact: ConsolidatedFact): Promise<void> {
    // In-memory cache
    this._facts.push(fact);

    // WorkingMemory: inject as high-priority <fact> message
    if (this._workingMemory) {
      const factBlock = `<fact>
  <claim>${fact.claim}</claim>
  <confidence>${fact.confidence}</confidence>
  <sources>${fact.sources.map((s) => s.episodeId).join(", ")}</sources>
</fact>`;
      this._workingMemory.appendMessageWithPriority({
        role: "assistant",
        content: factBlock,
        priority: "critical", // Facts stored through coordinator must be critical for recall() to find them
      });
    }

    // EpisodicRecall: add to pendingFacts buffer for next episode
    this._pendingFacts.push({
      claim: fact.claim,
      confidence: fact.confidence,
      sourceMessageIds: fact.sources.map((s) => s.episodeId),
    });

    // LTPM: persist
    if (this._ltpmStore) {
      try {
        await this._ltpmStore.storeFact(fact);
      } catch (err) {
        console.error("[MemoryCoordinator] LTPM storeFact failed:", err);
      }
    }
  }

  /**
   * Store an episode:
   * - EpisodicRecall: append to in-memory store
   * - LTPM: persist via storeEpisode()
   */
  private async _storeEpisode(episode: Episode): Promise<void> {
    this.episodicStore.append(episode);

    if (this._ltpmStore) {
      try {
        await this._ltpmStore.storeEpisode(episode);
      } catch (err) {
        console.error("[MemoryCoordinator] LTPM storeEpisode failed:", err);
      }
    }
  }

  /**
   * Handle a structural update (file change):
   * - CodebaseGraphIndex: onFileChanged()
   */
  private async _storeStructuralUpdate(
    payload: { filePath: string },
  ): Promise<void> {
    if (this._codebaseGraph) {
      try {
        await this._codebaseGraph.onFileChanged(payload.filePath);
      } catch (err) {
        console.error("[MemoryCoordinator] CodebaseGraph onFileChanged failed:", err);
      }
    }
  }

  /**
   * Store an extracted fact:
   * - WorkingMemory: add to pendingFacts buffer
   * - LTPM: persist as a ConsolidatedFact (if confidence is high enough)
   */
  private async _storeFact(fact: ExtractedFact): Promise<void> {
    this._pendingFacts.push(fact);

    // If confidence is high enough, also store in LTPM as ConsolidatedFact
    if (fact.confidence >= 0.7 && this._ltpmStore) {
      const consolidatedFact: ConsolidatedFact = {
        id: randomUUID(),
        claim: fact.claim,
        confidence: fact.confidence,
        sources: fact.sourceMessageIds.map((msgId) => ({
          episodeId: msgId,
          sequenceNumber: 0,
        })),
        verifiedBy: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this._facts.push(consolidatedFact);
      try {
        await this._ltpmStore.storeFact(consolidatedFact);
      } catch (err) {
        console.error("[MemoryCoordinator] LTPM storeFact (from extracted fact) failed:", err);
      }
    }
  }

  // ========================================================================
  // Private: Load Session State — Inject into WorkingMemory
  // ========================================================================

  /**
   * Inject loaded session state into WorkingMemory as <memory-recap> messages.
   */
  private _injectMemoryRecap(state: SessionMemoryState, sessionId?: string): void {
    const wm = this._workingMemory;
    if (!wm) return;

    const lines: string[] = [];

    lines.push(`<memory-recap>`);
    lines.push(`<session-id>${sessionId ?? this._sessionId}</session-id>`);
    lines.push(``);

    // Episodes summary
    if (state.recentEpisodes.length > 0) {
      lines.push(`<recent-episodes count="${state.recentEpisodes.length}">`);
      for (const ep of state.recentEpisodes) {
        lines.push(`  <episode seq="${ep.sequenceNumber}" outcome="${ep.outcome}">`);
        lines.push(`    <summary>${ep.summary}</summary>`);
        lines.push(`    <tags>${ep.semanticTags.join(", ")}</tags>`);
        lines.push(`    <files>${ep.affectedFiles.join(", ")}</files>`);
        lines.push(`  </episode>`);
      }
      lines.push(`</recent-episodes>`);
      lines.push(``);
    }

    // Active decisions
    if (state.activeDecisions.length > 0) {
      lines.push(`<active-decisions count="${state.activeDecisions.length}">`);
      for (const dec of state.activeDecisions) {
        lines.push(`  <decision id="${dec.id}">`);
        lines.push(`    <chosen>${dec.chosen}</chosen>`);
        lines.push(`    <rationale>${dec.rationale}</rationale>`);
        lines.push(`    <paths>${dec.affectedPaths.join(", ")}</paths>`);
        lines.push(`  </decision>`);
      }
      lines.push(`</active-decisions>`);
      lines.push(``);
    }

    // Relevant facts
    if (state.relevantFacts.length > 0) {
      lines.push(`<relevant-facts count="${state.relevantFacts.length}">`);
      for (const fact of state.relevantFacts) {
        lines.push(`  <fact confidence="${fact.confidence.toFixed(2)}">`);
        lines.push(`    <claim>${fact.claim}</claim>`);
        lines.push(`  </fact>`);
      }
      lines.push(`</relevant-facts>`);
    }

    lines.push(`</memory-recap>`);

    wm.appendSystemReminder(lines.join("\n"));
  }

  // ========================================================================
  // Private: Coherence Helpers
  // ========================================================================

  /**
   * Extract factual claims from WorkingMemory's critical messages.
   */
  private _extractWorkingMemoryClaims(): Array<{ claim: string; confidence: number }> {
    const wm = this._workingMemory;
    if (!wm) return [];

    const claims: Array<{ claim: string; confidence: number }> = [];
    const history = wm.history as readonly PrioritizedMessage[];

    for (const msg of history) {
      if (msg.priority !== "critical") continue;
      const content = msg.content ?? "";
      const contentLower = content.toLowerCase();
      if (!contentLower.includes("<fact>") && !contentLower.includes("<decision>")) continue;

      // Extract claim from <claim> tags
      const claimMatch = content.match(/<claim>([^<]+)<\/claim>/);
      const confMatch = content.match(/<confidence>([\d.]+)<\/confidence>/);

      if (claimMatch) {
        claims.push({
          claim: claimMatch[1]!.trim(),
          confidence: confMatch ? parseFloat(confMatch[1]!) : 1.0,
        });
      }
    }

    return claims;
  }

  /**
   * Find contradictory claims between working memory and LTPM claims.
   *
   * Looks for claims that share significant keyword overlap but differ
   * in assertion — e.g., one says "depends" and the other says
   * "does not depend" — or where confidence levels are widely
   * divergent for the same subject.
   */
  private _findContradictions(
    wmClaims: Array<{ claim: string; confidence: number }>,
    ltpmClaims: Array<{ claim: string; confidence: number }>,
  ): Array<{
    wmClaim: { claim: string; confidence: number };
    ltpmClaim: { claim: string; confidence: number };
    overlapScore: number;
  }> {
    const contradictions: Array<{
      wmClaim: { claim: string; confidence: number };
      ltpmClaim: { claim: string; confidence: number };
      overlapScore: number;
    }> = [];

    for (const wmc of wmClaims) {
      for (const lc of ltpmClaims) {
        // Compute keyword overlap
        const wmTokens = new Set(wmc.claim.toLowerCase().match(/\b\w{4,}\b/g) ?? []);
        const ltpmTokens = new Set(lc.claim.toLowerCase().match(/\b\w{4,}\b/g) ?? []);

        if (wmTokens.size === 0 || ltpmTokens.size === 0) continue;

        // Count overlapping tokens
        let overlap = 0;
        for (const token of wmTokens) {
          if (ltpmTokens.has(token)) overlap++;
        }

        const overlapScore = overlap / Math.min(wmTokens.size, ltpmTokens.size);

        // Check for contradiction signals:
        // 1. Significant keyword overlap (same subject) but conflicting assertions
        // 2. Or highly divergent confidence (one says 1.0, other says < 0.5)
        const divergentConfidence =
          Math.abs(wmc.confidence - lc.confidence) > 0.5;

        const conflictingAssertion =
          this._hasConflictingAssertion(wmc.claim, lc.claim);

        if (overlapScore >= 0.5 && (divergentConfidence || conflictingAssertion)) {
          contradictions.push({
            wmClaim: wmc,
            ltpmClaim: lc,
            overlapScore,
          });
        }
      }
    }

    return contradictions;
  }

  /**
   * Check if two claims about the same subject have conflicting assertions.
   */
  private _hasConflictingAssertion(a: string, b: string): boolean {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    // Check for negation pattern: one claim has "not"/"no"/"doesn't"
    // while the other doesn't
    const negationWords = /\b(not|no|doesn'?t|don'?t|isn'?t|aren'?t|cannot|can'?t)\b/;
    const aHasNegation = negationWords.test(aLower);
    const bHasNegation = negationWords.test(bLower);

    if (aHasNegation !== bHasNegation) return true;

    // Check for antonym pairs
    const antonyms = [
      ["depends", "independent"],
      ["requires", "optional"],
      ["enabled", "disabled"],
      ["active", "inactive"],
      ["public", "private"],
      ["internal", "external"],
    ] as const;

    for (const [ant1, ant2] of antonyms) {
      const aHas1 = aLower.includes(ant1);
      const aHas2 = aLower.includes(ant2);
      const bHas1 = bLower.includes(ant1);
      const bHas2 = bLower.includes(ant2);

      if ((aHas1 && bHas2) || (aHas2 && bHas1)) return true;
    }

    return false;
  }

  /**
   * Resolve a contradiction using the LLM provider.
   */
  private async _resolveContradiction(contradiction: {
    wmClaim: { claim: string; confidence: number };
    ltpmClaim: { claim: string; confidence: number };
    overlapScore: number;
  }): Promise<CoherenceEvent | null> {
    const { wmClaim, ltpmClaim } = contradiction;

    const prompt = `I found two conflicting memory entries about the same subject. Please resolve the contradiction.

Version A (from Working Memory, confidence ${wmClaim.confidence}):
"${wmClaim.claim}"

Version B (from Long-Term Project Memory, confidence ${ltpmClaim.confidence}):
"${ltpmClaim.claim}"

Which version is correct, or is there a synthesis that reconciles both?
Respond with:
- RESOLVED_CLAIM: <the corrected factual claim>
- RESOLVED_CONFIDENCE: <a number 0-1 indicating your certainty>
- REASONING: <brief explanation>`;

    try {
      const response = await this._llmProvider.infer(prompt, "You are a memory coherence resolver. Resolve contradictions between memory tiers.");

      // Parse the response for resolved claim and confidence
      const claimMatch = response.match(/RESOLVED_CLAIM:\s*(.+?)(?:\n|$)/);
      const confMatch = response.match(/RESOLVED_CONFIDENCE:\s*([\d.]+)/);

      const resolvedClaim = claimMatch?.[1]?.trim() ?? wmClaim.claim;
      const resolvedConfidence = confMatch
        ? Math.min(1, Math.max(0, parseFloat(confMatch[1]!)))
        : Math.max(wmClaim.confidence, ltpmClaim.confidence);

      // Update all tiers with the resolved version
      await this._applyResolution(resolvedClaim, resolvedConfidence);

      const event: CoherenceEvent = {
        id: randomUUID(),
        timestamp: Date.now(),
        claim: resolvedClaim,
        versions: [
          { tier: "working_memory", claim: wmClaim.claim, confidence: wmClaim.confidence },
          { tier: "ltpm", claim: ltpmClaim.claim, confidence: ltpmClaim.confidence },
        ],
        resolvedClaim,
        resolvedConfidence,
        resolved: true,
      };

      return event;
    } catch {
      // LLM inference failed — log the event as unresolved
      return {
        id: randomUUID(),
        timestamp: Date.now(),
        claim: wmClaim.claim,
        versions: [
          { tier: "working_memory", claim: wmClaim.claim, confidence: wmClaim.confidence },
          { tier: "ltpm", claim: ltpmClaim.claim, confidence: ltpmClaim.confidence },
        ],
        resolvedClaim: wmClaim.claim,
        resolvedConfidence: Math.max(wmClaim.confidence, ltpmClaim.confidence),
        resolved: false,
      };
    }
  }

  /**
   * Apply a resolved claim to all memory tiers.
   *
   * Updates WorkingMemory with a corrected <fact> message,
   * updates LTPM with the corrected claim if a matching fact exists.
   */
  private async _applyResolution(
    resolvedClaim: string,
    resolvedConfidence: number,
  ): Promise<void> {
    // Update WorkingMemory
    if (this._workingMemory) {
      const factBlock = `<fact>
  <claim>${resolvedClaim}</claim>
  <confidence>${resolvedConfidence}</confidence>
  <resolution>coherence_resolved</resolution>
</fact>`;
      this._workingMemory.appendMessageWithPriority({
        role: "assistant",
        content: factBlock,
        priority: "critical",
      });
    }

    // Update LTPM: find and update matching fact
    if (this._ltpmStore) {
      try {
        const allFacts = await this._ltpmStore.getAllFacts();
        for (const fact of allFacts) {
          const similarity = this._claimSimilarity(fact.claim, resolvedClaim);
          if (similarity >= 0.5) {
            // Update the fact
            fact.claim = resolvedClaim;
            fact.confidence = resolvedConfidence;
            fact.updatedAt = Date.now();
            // Store updated fact
            await this._ltpmStore.storeFact(fact);
          }
        }
      } catch (err) {
        console.error("[MemoryCoordinator] Failed to update LTPM with resolution:", err);
      }
    }
  }

  /**
   * Simple string similarity (word overlap ratio) for claim matching.
   */
  private _claimSimilarity(a: string, b: string): number {
    const tokensA = new Set(a.toLowerCase().match(/\b\w{3,}\b/g) ?? []);
    const tokensB = new Set(b.toLowerCase().match(/\b\w{3,}\b/g) ?? []);

    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let overlap = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) overlap++;
    }

    return overlap / Math.min(tokensA.size, tokensB.size);
  }

  /**
   * Log a coherence event, bounded by maxCoherenceLogSize.
   */
  private _logCoherenceEvent(event: CoherenceEvent): void {
    this._coherenceLog.push(event);
    if (this._coherenceLog.length > this._maxCoherenceLogSize) {
      this._coherenceLog.shift();
    }

    console.log(
      `[MemoryCoordinator] Coherence resolved: "${event.claim}" ` +
        `(conf: ${event.resolvedConfidence.toFixed(2)}, ` +
        `resolved: ${event.resolved})`,
    );
  }
}