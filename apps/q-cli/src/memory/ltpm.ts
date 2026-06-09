/**
 * Long-Term Project Memory (LTPM) — Persistent, Session-Spanning Store.
 *
 * Step 25: Full persistent storage for episodes, decisions, and consolidated
 * facts, with on-disk layout under $HOME/.Q/memory/.
 *
 * Directory layout:
 *   $HOME/.Q/memory/
 *     episodes/              — Episode JSON files + recall-index.json
 *     decisions/             — Decision JSON files + graph.json
 *     facts/                 — ConsolidatedFact JSON files
 *     index/                 — Vector index files (Step 27)
 *     project-memory.json    — Cross-session consolidated facts for project
 *
 * Atomic file writes use writeFile + rename for crash safety.
 *
 * Depends on: Steps 23 (fact extraction) and 24 (episode production).
 * Provides persistence for: Steps 22 (memory slicing), 26 (codebase graph
 * enrichment), 27 (vector indexing), 28 (MemoryCoordinator).
 */

import { randomUUID } from "node:crypto";
import { access, constants, mkdir, readFile, rename, writeFile, readdir, unlink } from "node:fs/promises";
import { gzip } from "node:zlib";
import path from "pathe";
import type { Episode, Decision, ConsolidatedFact, EpisodeRef, VerificationRef } from "./types.js";
import type { SessionMemoryState, ScoredResult, RecallFilters } from "./types.js";
import { SemanticRecallIndex } from "./semantic.js";

// =========================================================================
// Configuration
// =========================================================================

export interface LTPMConfig {
  /** Root directory for LTPM storage (default $HOME/.Q/memory) */
  memoryRoot: string;
  /** Maximum episodes per session to load on resume */
  maxEpisodesPerSession: number;
  /** Days before facts are archived (default 30) */
  factArchiveDays: number;
  /** Days before episodes are cold-stored (default 90) */
  episodeArchiveDays: number;
  /** Max supersedes count before decision is archived (default 10) */
  maxSupersedesBeforeArchive: number;
  /** String similarity threshold (0-1) for fact consolidation (default 0.9) */
  consolidationThreshold: number;
  /** Whether to enable debug logging */
  debug: boolean;
  /** Step 27: Optional injected semantic index for testing */
  semanticIndex?: SemanticRecallIndex;
}

const DEFAULT_CONFIG: LTPMConfig = {
  memoryRoot: "",
  maxEpisodesPerSession: 20,
  factArchiveDays: 30,
  episodeArchiveDays: 90,
  maxSupersedesBeforeArchive: 10,
  consolidationThreshold: 0.9,
  debug: false,
};

// =========================================================================
// Utilities
// =========================================================================

/**
 * Compute string similarity using Levenshtein-based ratio.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  const longerLen = longer.length;

  if (longerLen === 0) return 1.0;

  // Levenshtein distance
  const matrix: number[] = [];
  for (let i = 0; i <= shorter.length; i++) matrix[i] = i;

  for (let j = 1; j <= longer.length; j++) {
    let prev = j;
    for (let i = 1; i <= shorter.length; i++) {
      const cost = shorter[i - 1] === longer[j - 1] ? 0 : 1;
      const val = Math.min(
        matrix[i]! + 1,      // deletion
        prev + 1,           // insertion
        matrix[i - 1]! + cost, // substitution
      );
      matrix[i - 1] = prev;
      prev = val;
    }
    matrix[shorter.length] = prev;
  }

  const distance = matrix[shorter.length]!;
  return 1.0 - distance / longerLen;
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await access(dirPath, constants.F_OK);
  } catch {
    await mkdir(dirPath, { recursive: true });
  }
}

/**
 * Atomically write a JSON file: write to a temp path then rename.
 * This prevents partial writes from corrupting data on crash.
 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp.${randomUUID().slice(0, 8)}`;
  const content = JSON.stringify(data, null, 2);
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Read and parse a JSON file, returning null if it doesn't exist or is invalid.
 */
async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * List all JSON files in a directory matching a pattern.
 */
async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath);
    return entries
      .filter((e) => e.endsWith(".json"))
      .sort()
      .map((e) => path.join(dirPath, e));
  } catch {
    return [];
  }
}

// =========================================================================
// RecallIndex — Quick-Lookup Index for Episodes
// =========================================================================

interface RecallIndexEntry {
  /** Original episode ID for proper identity */
  episodeId: string;
  sessionId: string;
  sequenceNumber: number;
  fileName: string;
  tags: string[];
  timestamp: number;
  summary: string;
}

interface RecallIndex {
  entries: RecallIndexEntry[];
}

// =========================================================================
// DecisionGraph — Dependency Graph for Decisions
// =========================================================================

interface DecisionGraphNode {
  id: string;
  sessionId: string;
  timestamp: number;
  chosen: string;
  tags: string[];
  affectedPaths: string[];
  supersedes: string[];
  supersededBy: string[];
}

interface DecisionGraph {
  nodes: DecisionGraphNode[];
  /** Map from module/file path to decision IDs for quick lookup */
  moduleIndex: Record<string, string[]>;
}

// =========================================================================
// Project Memory — Cross-Session Consolidated Facts
// =========================================================================

interface ProjectMemory {
  version: number;
  lastUpdated: number;
  facts: Array<{
    id: string;
    claim: string;
    confidence: number;
    createdAt: number;
    updatedAt: number;
    expiresAt?: number;
  }>;
}

// =========================================================================
// LTPMStore
// =========================================================================

/**
 * Long-Term Project Memory Store.
 *
 * Provides persistent, crash-safe storage for episodes, decisions,
 * and consolidated facts, with query methods, fact consolidation,
 * and configurable retention policies.
 */
export class LTPMStore {
  private _config: LTPMConfig;
  private _memoryRoot: string;
  private _episodesDir: string;
  private _decisionsDir: string;
  private _factsDir: string;
  private _indexDir: string;
  private _projectMemoryPath: string;
  private _recallIndexPath: string;
  private _decisionGraphPath: string;

  /** In-memory cache of recall index entries for fast query */
  private _recallIndexCache: RecallIndexEntry[] = [];
  private _recallIndexDirty = false;

  /** In-memory cache of decision graph */
  private _decisionGraphCache: DecisionGraph = { nodes: [], moduleIndex: {} };
  private _decisionGraphDirty = false;

  /** In-memory cache of project memory */
  private _projectMemoryCache: ProjectMemory = {
    version: 1,
    lastUpdated: Date.now(),
    facts: [],
  };
  private _projectMemoryDirty = false;

  /** Step 27: Semantic recall index for vector/BM25 search */
  private _semanticIndex: SemanticRecallIndex;

  /** Track when facts were last consolidated */
  private _lastConsolidationTime: number | null = null;

  constructor(config?: Partial<LTPMConfig>) {
    const homedir =
      typeof process !== "undefined" && process.env?.HOME
        ? process.env.HOME
        : "/tmp";
    this._config = {
      ...DEFAULT_CONFIG,
      memoryRoot: path.join(homedir, ".Q", "memory"),
      ...config,
    };
    this._memoryRoot = this._config.memoryRoot;
    this._episodesDir = path.join(this._memoryRoot, "episodes");
    this._decisionsDir = path.join(this._memoryRoot, "decisions");
    this._factsDir = path.join(this._memoryRoot, "facts");
    this._indexDir = path.join(this._memoryRoot, "index");
    this._projectMemoryPath = path.join(this._memoryRoot, "project-memory.json");
    this._recallIndexPath = path.join(this._episodesDir, "recall-index.json");
    this._decisionGraphPath = path.join(this._decisionsDir, "graph.json");

    // Step 27: Initialize semantic index (lazy, loads on first use)
    this._semanticIndex =
      config?.semanticIndex ??
      new SemanticRecallIndex({
        indexDir: this._indexDir,
        noEmbeddings: false,
        debug: this._config.debug,
      });
  }

  // ========================================================================
  // Initialization
  // ========================================================================

  /**
   * Initialize the LTPM store: create directories and load indexes.
   * Must be called before any other operations.
   */
  async init(): Promise<void> {
    await ensureDir(this._episodesDir);
    await ensureDir(this._decisionsDir);
    await ensureDir(this._factsDir);
    await ensureDir(this._indexDir);

    await this.loadIndexes();

    // Initialize the semantic recall index for vector/BM25 search
    await this._semanticIndex.init();
  }

  /**
   * Load recall index, decision graph, and project memory from disk.
   */
  private async loadIndexes(): Promise<void> {
    // Load recall index
    const recallIndex = await readJson<RecallIndex>(this._recallIndexPath);
    if (recallIndex) {
      this._recallIndexCache = recallIndex.entries;
    }

    // Load decision graph
    const decisionGraph = await readJson<DecisionGraph>(this._decisionGraphPath);
    if (decisionGraph) {
      this._decisionGraphCache = decisionGraph;
    }

    // Load project memory
    const projectMemory = await readJson<ProjectMemory>(this._projectMemoryPath);
    if (projectMemory) {
      this._projectMemoryCache = projectMemory;
    }
  }

  /**
   * Flush all dirty indexes to disk.
   */
  async flush(): Promise<void> {
    if (this._recallIndexDirty) {
      const index: RecallIndex = { entries: this._recallIndexCache };
      await atomicWriteJson(this._recallIndexPath, index);
      this._recallIndexDirty = false;
    }

    if (this._decisionGraphDirty) {
      await atomicWriteJson(this._decisionGraphPath, this._decisionGraphCache);
      this._decisionGraphDirty = false;
    }

    if (this._projectMemoryDirty) {
      await atomicWriteJson(this._projectMemoryPath, this._projectMemoryCache);
      this._projectMemoryDirty = false;
    }
  }

  // ========================================================================
  // Store Operations — Episodes
  // ========================================================================

  /**
   * Store an episode with atomic file writes.
   *
   * Writes the episode as <sessionId>-<seq>.json under episodes/,
   * updates the recall index, and writes consolidated project facts
   * to project-memory.json.
   */
  async storeEpisode(episode: Episode): Promise<void> {
    const fileName = `${episode.sessionId}-${episode.sequenceNumber}.json`;
    const filePath = path.join(this._episodesDir, fileName);

    // Atomic write
    await atomicWriteJson(filePath, episode);

    // Update recall index
    this._recallIndexCache.push({
      episodeId: episode.id,
      sessionId: episode.sessionId,
      sequenceNumber: episode.sequenceNumber,
      fileName,
      tags: episode.semanticTags,
      timestamp: episode.timestamp.end,
      summary: episode.summary.slice(0, 200),
    });
    this._recallIndexDirty = true;

    // Step 27: Index episode for semantic recall
    await this._semanticIndex.indexEpisode(episode);

    // Flush indexes periodically
    if (this._recallIndexCache.length % 10 === 0) {
      await this.flush();
    }

    if (this._config.debug) {
      console.log(`[LTPM] Stored episode ${fileName}`);
    }
  }

  // ========================================================================
  // Store Operations — Decisions
  // ========================================================================

  /**
   * Store a decision with atomic file writes.
   *
   * Writes the decision as <uuid>.json under decisions/,
   * updates the decision graph.
   */
  async storeDecision(decision: Decision): Promise<void> {
    const fileName = `${decision.id}.json`;
    const filePath = path.join(this._decisionsDir, fileName);

    // Atomic write
    await atomicWriteJson(filePath, decision);

    // Update decision graph
    const node: DecisionGraphNode = {
      id: decision.id,
      sessionId: decision.sessionId,
      timestamp: decision.timestamp,
      chosen: decision.chosen,
      tags: decision.tags,
      affectedPaths: decision.affectedPaths,
      supersedes: decision.supersedes,
      supersededBy: decision.supersededBy,
    };

    // Remove existing node for this decision if it exists (update)
    this._decisionGraphCache.nodes = this._decisionGraphCache.nodes.filter(
      (n) => n.id !== decision.id,
    );
    this._decisionGraphCache.nodes.push(node);

    // Update module index
    this.updateDecisionModuleIndex(decision);

    this._decisionGraphDirty = true;

    // Step 27: Index decision for semantic recall
    await this._semanticIndex.indexDecision(decision);

    if (this._config.debug) {
      console.log(`[LTPM] Stored decision ${decision.id}`);
    }
  }

  /**
   * Update the decision graph's module index with paths from a decision.
   */
  private updateDecisionModuleIndex(decision: Decision): void {
    const idx = this._decisionGraphCache.moduleIndex;

    for (const p of decision.affectedPaths) {
      if (!idx[p]) {
        idx[p] = [];
      }
      if (!idx[p]!.includes(decision.id)) {
        idx[p]!.push(decision.id);
      }
    }
  }

  // ========================================================================
  // Store Operations — Consolidated Facts
  // ========================================================================

  /**
   * Store a consolidated fact with atomic file writes.
   *
   * Writes the fact as <uuid>.json under facts/,
   * and updates project-memory.json.
   */
  async storeFact(fact: ConsolidatedFact): Promise<void> {
    const fileName = `${fact.id}.json`;
    const filePath = path.join(this._factsDir, fileName);

    // Atomic write
    await atomicWriteJson(filePath, fact);

    // Update project memory
    const existingIdx = this._projectMemoryCache.facts.findIndex(
      (f) => f.id === fact.id,
    );
    const pmEntry = {
      id: fact.id,
      claim: fact.claim,
      confidence: fact.confidence,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
      expiresAt: fact.expiresAt,
    };

    if (existingIdx >= 0) {
      this._projectMemoryCache.facts[existingIdx] = pmEntry;
    } else {
      this._projectMemoryCache.facts.push(pmEntry);
    }
    this._projectMemoryCache.lastUpdated = Date.now();
    this._projectMemoryDirty = true;

    // Step 27: Index fact for semantic recall
    await this._semanticIndex.indexFact(fact);

    if (this._config.debug) {
      console.log(`[LTPM] Stored fact ${fact.id}`);
    }
  }

  // ========================================================================
  // Fact Consolidation
  // ========================================================================

  /**
   * Consolidate facts by merging duplicate or conflicting claims.
   *
   * Analyzes all stored consolidated facts for co-referent claims:
   * if two facts have >90% string similarity in their claim field,
   * merge them with averaged confidence and combined sources/verifications.
   *
   * Returns the number of merges performed.
   */
  async consolidateFacts(): Promise<number> {
    // Load all fact files from disk for a fresh view
    const factFiles = await listJsonFiles(this._factsDir);
    const facts: ConsolidatedFact[] = [];

    for (const filePath of factFiles) {
      const fact = await readJson<ConsolidatedFact>(filePath);
      if (fact) facts.push(fact);
    }

    if (facts.length <= 1) return 0;

    let mergeCount = 0;
    const mergedIds = new Set<string>();
    const result: ConsolidatedFact[] = [];

    for (let i = 0; i < facts.length; i++) {
      const fi = facts[i]!;
      if (mergedIds.has(fi.id)) continue;

      let merged = { ...fi };
      let foundMerge = true;

      while (foundMerge) {
        foundMerge = false;
        for (let j = i + 1; j < facts.length; j++) {
          const fj = facts[j]!;
          if (mergedIds.has(fj.id)) continue;
          if (merged.id === fj.id) continue;

          const similarity = stringSimilarity(merged.claim, fj.claim);
          if (similarity >= this._config.consolidationThreshold) {
            // Merge fj into merged
            merged = this.mergeFacts(merged, fj);
            mergedIds.add(fj.id);
            mergeCount++;
            foundMerge = true;

            // Remove the merged file from disk
            const mergedFileName = `${fj.id}.json`;
            const mergedPath = path.join(this._factsDir, mergedFileName);
            try {
              await unlink(mergedPath);
            } catch {
              // Ignore if already gone
            }
          }
        }
      }

      mergedIds.add(merged.id);
      // Update the source fact on disk
      const mergedFileName = `${merged.id}.json`;
      const mergedPath = path.join(this._factsDir, mergedFileName);
      await atomicWriteJson(mergedPath, merged);

      result.push(merged);
    }

    // Update project memory cache
    this._projectMemoryCache.facts = result.map((f) => ({
      id: f.id,
      claim: f.claim,
      confidence: f.confidence,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      expiresAt: f.expiresAt,
    }));
    this._projectMemoryCache.lastUpdated = Date.now();
    this._projectMemoryDirty = true;
    await this.flush();

    if (this._config.debug) {
      console.log(`[LTPM] Consolidation merged ${mergeCount} fact(s)`);
    }

    this._lastConsolidationTime = Date.now();
    return mergeCount;
  }

  /**
   * Merge two consolidated facts into one.
   * Averaged confidence, combined sources and verifications.
   */
  private mergeFacts(a: ConsolidatedFact, b: ConsolidatedFact): ConsolidatedFact {
    const now = Date.now();

    // Keep the longer, more descriptive claim
    const claim = a.claim.length >= b.claim.length ? a.claim : b.claim;

    // Averaged confidence
    const confidence = (a.confidence + b.confidence) / 2;

    // Combine sources (dedup by episodeId+sequenceNumber)
    const sourceMap = new Map<string, EpisodeRef>();
    for (const s of [...a.sources, ...b.sources]) {
      const key = `${s.episodeId}:${s.sequenceNumber}`;
      if (!sourceMap.has(key)) sourceMap.set(key, s);
    }

    // Combine verifications (dedup by verifier+timestamp)
    const verifMap = new Map<string, VerificationRef>();
    for (const v of [...a.verifiedBy, ...b.verifiedBy]) {
      const key = `${v.verifier}:${v.timestamp}`;
      if (!verifMap.has(key)) verifMap.set(key, v);
    }

    // Keep the earliest createdAt, latest updatedAt
    const createdAt = Math.min(a.createdAt, b.createdAt);
    const updatedAt = now;

    // Keep the earliest expiresAt if both have one
    const expiresAt =
      a.expiresAt !== undefined && b.expiresAt !== undefined
        ? Math.min(a.expiresAt, b.expiresAt)
        : (a.expiresAt ?? b.expiresAt);

    return {
      id: a.id,
      claim,
      confidence,
      sources: Array.from(sourceMap.values()),
      verifiedBy: Array.from(verifMap.values()),
      createdAt,
      updatedAt,
      expiresAt,
    };
  }

  // ========================================================================
  // Query Operations — Episodes
  // ========================================================================

  /**
   * Query episodes by session ID, ordered by sequence number descending.
   */
  async queryEpisodes(sessionId: string, limit?: number): Promise<Episode[]> {
    const maxResults = limit ?? this._config.maxEpisodesPerSession;
    const episodes: Episode[] = [];

    // Find matching entries in recall index
    const matchingEntries = this._recallIndexCache
      .filter((e) => e.sessionId === sessionId)
      .sort((a, b) => b.sequenceNumber - a.sequenceNumber)
      .slice(0, maxResults);

    for (const entry of matchingEntries) {
      const filePath = path.join(this._episodesDir, entry.fileName);
      const episode = await readJson<Episode>(filePath);
      if (episode) {
        episodes.push(episode);
      }
    }

    return episodes;
  }

  /**
   * Get all episodes, optionally filtered by session.
   * Returns them ordered by timestamp descending.
   */
  async getAllEpisodes(sessionId?: string): Promise<Episode[]> {
    const entries = sessionId
      ? this._recallIndexCache.filter((e) => e.sessionId === sessionId)
      : [...this._recallIndexCache];

    entries.sort((a, b) => b.timestamp - a.timestamp);

    const episodes: Episode[] = [];
    for (const entry of entries) {
      const filePath = path.join(this._episodesDir, entry.fileName);
      const episode = await readJson<Episode>(filePath);
      if (episode) {
        episodes.push(episode);
      }
    }

    return episodes;
  }

  // ========================================================================
  // Query Operations — Decisions
  // ========================================================================

  /**
   * Query a decision by ID.
   */
  async getDecision(decisionId: string): Promise<Decision | null> {
    const filePath = path.join(this._decisionsDir, `${decisionId}.json`);
    return readJson<Decision>(filePath);
  }

  /**
   * Query all decisions.
   */
  async getAllDecisions(): Promise<Decision[]> {
    const files = await listJsonFiles(this._decisionsDir);
    const decisions: Decision[] = [];
    for (const filePath of files) {
      if (filePath.endsWith("graph.json")) continue;
      const decision = await readJson<Decision>(filePath);
      if (decision) decisions.push(decision);
    }
    return decisions.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Query the decision chain for a module by walking the
   * supersedes/supersededBy graph.
   *
   * Starts from decisions that affect the given module path,
   * then walks backwards (supersedes) and forwards (supersededBy)
   * to build the full decision chain.
   */
  async queryDecisionChain(modulePath: string): Promise<Decision[]> {
    const seen = new Set<string>();
    const result: Decision[] = [];

    // Find seed decision IDs from the module index (by exact match and substring)
    const seedIds = new Set<string>();
    const idx = this._decisionGraphCache.moduleIndex;
    for (const [pathKey, decisionIds] of Object.entries(idx)) {
      if (pathKey.includes(modulePath) || modulePath.includes(pathKey)) {
        for (const id of decisionIds) {
          seedIds.add(id);
        }
      }
    }

    // Also check node tags for module relevance
    for (const node of this._decisionGraphCache.nodes) {
      if (node.tags.some((t) => t.includes(modulePath))) {
        seedIds.add(node.id);
      }
    }

    // Walk the graph from each seed
    for (const seedId of seedIds) {
      await this.walkDecisionChain(seedId, result, seen);
    }

    // Sort by timestamp ascending (chronological order)
    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Recursively walk the decision graph via supersedes/supersededBy.
   */
  private async walkDecisionChain(
    decisionId: string,
    result: Decision[],
    seen: Set<string>,
  ): Promise<void> {
    if (seen.has(decisionId)) return;
    seen.add(decisionId);

    const decision = await this.getDecision(decisionId);
    if (!decision) return;

    // Walk backwards: decisions that this one supersedes
    for (const supersededId of decision.supersedes) {
      await this.walkDecisionChain(supersededId, result, seen);
    }

    // Add this decision
    result.push(decision);

    // Walk forwards: decisions that supersede this one
    for (const supersederId of decision.supersededBy) {
      await this.walkDecisionChain(supersederId, result, seen);
    }
  }

  // ========================================================================
  // Delete Operations — Remove by ID across all item types
  // ========================================================================

  /**
   * Delete a memory item by its ID, checking all tiers (episodes, decisions, facts).
   * Returns the type of the item that was deleted, or null if not found.
   */
  async deleteById(id: string): Promise<"episode" | "decision" | "fact" | null> {
    // Check decisions directory
    const decisionPath = path.join(this._decisionsDir, `${id}.json`);
    try {
      await access(decisionPath, constants.F_OK);
      await unlink(decisionPath);
      // Remove from decision graph cache
      this._decisionGraphCache.nodes = this._decisionGraphCache.nodes.filter(
        (n) => n.id !== id,
      );
      // Clean up module index
      for (const [pathKey, ids] of Object.entries(this._decisionGraphCache.moduleIndex)) {
        this._decisionGraphCache.moduleIndex[pathKey] = ids.filter((did) => did !== id);
        if (this._decisionGraphCache.moduleIndex[pathKey]!.length === 0) {
          delete this._decisionGraphCache.moduleIndex[pathKey];
        }
      }
      this._decisionGraphDirty = true;
      // Remove from semantic index
      await this._semanticIndex.deleteById(id);
      await this.flush();
      if (this._config.debug) console.log(`[LTPM] Deleted decision ${id}`);
      return "decision";
    } catch { /* not a decision */ }

    // Check facts directory
    const factPath = path.join(this._factsDir, `${id}.json`);
    try {
      await access(factPath, constants.F_OK);
      await unlink(factPath);
      // Remove from project memory cache
      this._projectMemoryCache.facts = this._projectMemoryCache.facts.filter(
        (f) => f.id !== id,
      );
      this._projectMemoryDirty = true;
      await this._semanticIndex.deleteById(id);
      await this.flush();
      if (this._config.debug) console.log(`[LTPM] Deleted fact ${id}`);
      return "fact";
    } catch { /* not a fact */ }

    // Check episodes directory (search recall index for the episode id's file)
    const entry = this._recallIndexCache.find((e) => e.episodeId === id);
    if (entry) {
      const episodePath = path.join(this._episodesDir, entry.fileName);
      try {
        await unlink(episodePath);
      } catch { /* already gone */ }
      this._recallIndexCache = this._recallIndexCache.filter(
        (e) => e.episodeId !== id,
      );
      this._recallIndexDirty = true;
      await this._semanticIndex.deleteById(id);
      await this.flush();
      if (this._config.debug) console.log(`[LTPM] Deleted episode ${id}`);
      return "episode";
    }

    return null;
  }

  // ========================================================================
  // Query Operations — Facts
  // ========================================================================

  /**
   * Get all consolidated facts, optionally filtered by module/tag.
   */
  async getAllFacts(): Promise<ConsolidatedFact[]> {
    const files = await listJsonFiles(this._factsDir);
    const facts: ConsolidatedFact[] = [];
    for (const filePath of files) {
      const fact = await readJson<ConsolidatedFact>(filePath);
      if (fact) facts.push(fact);
    }
    return facts.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Query consolidated facts from project memory.
   */
  queryFacts(tag?: string): ConsolidatedFact[] {
    const memoryFacts = this._projectMemoryCache.facts;
    if (!tag) {
      return memoryFacts.map((f) => this.pmEntryToFact(f));
    }

    const filtered = memoryFacts.filter((f) =>
      f.claim.toLowerCase().includes(tag.toLowerCase()),
    );
    return filtered.map((f) => this.pmEntryToFact(f));
  }

  /**
   * Convert a ProjectMemory fact entry to a partial ConsolidatedFact.
   */
  private pmEntryToFact(entry: ProjectMemory["facts"][number]): ConsolidatedFact {
    return {
      id: entry.id,
      claim: entry.claim,
      confidence: entry.confidence,
      sources: [],
      verifiedBy: [],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      expiresAt: entry.expiresAt,
    };
  }

  // ========================================================================
  // Semantic Recall (Step 27)
  // ========================================================================

  /**
   * Semantic search across all stored items.
   *
   * Delegates to SemanticRecallIndex for vector-based ANN search
   * (or BM25 fallback), then loads full items from disk.
   *
   * @param queryStr - The search query string
   * @param maxResults - Maximum number of results to return
   * @param filters - Optional filters for results
   * @returns Scored results sorted by relevance
   */
  async recall(
    queryStr: string,
    maxResults: number = 10,
    filters?: RecallFilters,
  ): Promise<ScoredResult[]> {
    const metaResults = await this._semanticIndex.recall(queryStr, maxResults * 2, filters);

    const results: ScoredResult[] = [];
    for (const { meta, score } of metaResults) {
      let item: Episode | Decision | ConsolidatedFact | null = null;

      if (meta.itemType === "episode") {
        const entry = this._recallIndexCache.find((e) => e.episodeId === meta.id);
        if (entry) {
          item = await readJson<Episode>(path.join(this._episodesDir, entry.fileName));
        }
      } else if (meta.itemType === "decision") {
        item = await this.getDecision(meta.id);
      } else {
        item = await readJson<ConsolidatedFact>(path.join(this._factsDir, `${meta.id}.json`));
      }

      if (item) {
        results.push({ item, score, itemType: meta.itemType });
      }
    }

    // Post-filter facts by module claim text (facts have no affectedPaths)
    if (filters?.module) {
      const mod = filters.module.toLowerCase();
      const filtered = results.filter((r) => {
        if (r.itemType !== "fact") return true;
        const fact = r.item as ConsolidatedFact;
        return fact.claim.toLowerCase().includes(mod);
      });
      return filtered.slice(0, maxResults);
    }

    return results.slice(0, maxResults);
  }


  // ========================================================================
  // Session State Management
  // ========================================================================

  /**
   * Load session memory state for session resume.
   *
   * Loads the last N episodes and all active (non-superseded) decisions
   * for the given session, plus relevant consolidated facts.
   */
  async loadSessionState(sessionId: string): Promise<SessionMemoryState> {
    const recentEpisodes = await this.queryEpisodes(
      sessionId,
      this._config.maxEpisodesPerSession,
    );

    // Get active decisions: those not superseded by another
    const allDecisions = await this.getAllDecisions();
    const activeDecisions = allDecisions.filter(
      (d) => d.supersededBy.length === 0,
    );

    // Get facts relevant to this session (facts created during session time)
    const relevantFacts: ConsolidatedFact[] = [];
    const allFacts = await this.getAllFacts();
    const sessionEpisodes = recentEpisodes.length > 0
      ? recentEpisodes
      : await this.queryEpisodes(sessionId, 50);

    const sessionEpisodeIds = new Set(sessionEpisodes.map((e) => e.id));
    for (const fact of allFacts) {
      if (fact.sources.some((s) => sessionEpisodeIds.has(s.episodeId))) {
        relevantFacts.push(fact);
      }
    }

    return {
      recentEpisodes,
      activeDecisions,
      relevantFacts,
    };
  }

  // ========================================================================
  // Retention Policies
  // ========================================================================

  /**
   * Run all retention policies to archive or cold-store old data.
   *
   * Policies:
   * - Facts older than 30 days with confidence > 0.5 get archived
   *   (removed from active storage, kept in archive metadata).
   * - Decisions superseded more than 10 times get archived.
   * - Episodes older than 90 days get archived to cold storage
   *   (gzip-compressed JSON).
   *
   * Returns a summary of archived items.
   */
  async applyRetentionPolicies(): Promise<{
    archivedFacts: number;
    archivedDecisions: number;
    archivedEpisodes: number;
  }> {
    const now = Date.now();
    const factArchiveMs = this._config.factArchiveDays * 24 * 60 * 60 * 1000;
    const episodeArchiveMs = this._config.episodeArchiveDays * 24 * 60 * 60 * 1000;

    let archivedFacts = 0;
    let archivedDecisions = 0;
    let archivedEpisodes = 0;

    // ── Policy 1: Archive old facts with confidence > 0.5 ──────────────
    const factFiles = await listJsonFiles(this._factsDir);
    for (const filePath of factFiles) {
      const fact = await readJson<ConsolidatedFact>(filePath);
      if (!fact) continue;

      const age = now - fact.updatedAt;
      if (age > factArchiveMs && fact.confidence > 0.5) {
        // Archive: remove from active storage
        await this.archiveFact(filePath, fact);
        archivedFacts++;

        // Remove from project memory cache
        this._projectMemoryCache.facts = this._projectMemoryCache.facts.filter(
          (f) => f.id !== fact.id,
        );
        this._projectMemoryDirty = true;
      }
    }

    // ── Policy 2: Archive decisions superseded more than 10 times ───────
    const decisionFiles = (await readdir(this._decisionsDir))
      .filter((f) => f.endsWith(".json") && f !== "graph.json");

    for (const fileName of decisionFiles) {
      const filePath = path.join(this._decisionsDir, fileName);
      const decision = await readJson<Decision>(filePath);
      if (!decision) continue;

      if (decision.supersededBy.length > this._config.maxSupersedesBeforeArchive) {
        await this.archiveDecision(filePath, decision);
        archivedDecisions++;

        // Remove from decision graph cache
        this._decisionGraphCache.nodes = this._decisionGraphCache.nodes.filter(
          (n) => n.id !== decision.id,
        );

        // Clean up module index
        for (const p of decision.affectedPaths) {
          const ids = this._decisionGraphCache.moduleIndex[p];
          if (ids) {
            this._decisionGraphCache.moduleIndex[p] = ids.filter(
              (id) => id !== decision.id,
            );
            if (this._decisionGraphCache.moduleIndex[p]!.length === 0) {
              delete this._decisionGraphCache.moduleIndex[p];
            }
          }
        }

        this._decisionGraphDirty = true;
      }
    }

    // ── Policy 3: Archive episodes older than 90 days ───────────────────
    for (const entry of this._recallIndexCache) {
      const filePath = path.join(this._episodesDir, entry.fileName);
      const age = now - entry.timestamp;
      if (age > episodeArchiveMs) {
        // Read the episode from disk for the full data
        const episode = await readJson<Episode>(filePath);
        if (!episode) continue;

        await this.coldStoreEpisode(filePath, episode);
        archivedEpisodes++;

        // Remove from recall index cache
        this._recallIndexCache = this._recallIndexCache.filter(
          (e) => !(e.sessionId === entry.sessionId && e.sequenceNumber === entry.sequenceNumber),
        );
        this._recallIndexDirty = true;
      }
    }

    // Flush indexes
    await this.flush();

    if (this._config.debug) {
      console.log(
        `[LTPM] Retention: archived ${archivedFacts} fact(s), ` +
          `${archivedDecisions} decision(s), ${archivedEpisodes} episode(s)`,
      );
    }

    return { archivedFacts, archivedDecisions, archivedEpisodes };
  }

  /**
   * Archive a fact: write to archive directory and remove from active storage.
   */
  private async archiveFact(filePath: string, fact: ConsolidatedFact): Promise<void> {
    const archiveDir = path.join(this._memoryRoot, "archive", "facts");
    await ensureDir(archiveDir);
    const archivedPath = path.join(archiveDir, `${fact.id}.json`);
    await rename(filePath, archivedPath);
  }

  /**
   * Archive a decision: write to archive directory and remove from active storage.
   */
  private async archiveDecision(filePath: string, decision: Decision): Promise<void> {
    const archiveDir = path.join(this._memoryRoot, "archive", "decisions");
    await ensureDir(archiveDir);
    const archivedPath = path.join(archiveDir, `${decision.id}.json`);
    await rename(filePath, archivedPath);
  }

  /**
   * Cold-store an episode: gzip-compress and move to cold storage.
   */
  private async coldStoreEpisode(filePath: string, episode: Episode): Promise<void> {
    const coldDir = path.join(this._memoryRoot, "cold", "episodes");
    await ensureDir(coldDir);
    const coldPath = path.join(
      coldDir,
      `${episode.sessionId}-${episode.sequenceNumber}.json.gz`,
    );

    // Gzip compress the episode
    const content = JSON.stringify(episode);
    const compressed: Buffer = await new Promise((resolve, reject) => {
      gzip(content, (err: Error | null, result: Buffer) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    // Write compressed data directly to cold path
    await writeFile(coldPath, compressed);

    // Remove original file
    try { await unlink(filePath); } catch { /* ignore */ }
  }

  // ========================================================================
  // Retrieval Strategy Helpers
  // ========================================================================

  /**
   * Direct Recall — Load the last N episodes and all active decisions
   * for session resume. Convenience wrapper around loadSessionState.
   */
  async directRecall(sessionId: string): Promise<SessionMemoryState> {
    return this.loadSessionState(sessionId);
  }

  /**
   * Module-Contextual Recall — Get decisions and facts filtered by module.
   * Returns a memory slice suitable for sub-agent dispatch.
   */
  async moduleContextualRecall(
    modulePath: string,
  ): Promise<{
    decisions: Decision[];
    facts: ConsolidatedFact[];
  }> {
    const decisions = await this.queryDecisionChain(modulePath);
    const facts = this.queryFacts(modulePath);
    return { decisions, facts };
  }

  // ========================================================================
  // Diagnostics & Stats
  // ========================================================================

  /**
   * Get storage statistics for diagnostics.
   */
  async getStats(): Promise<{
    episodeCount: number;
    decisionCount: number;
    factCount: number;
    recallIndexSize: number;
    decisionGraphNodes: number;
    projectMemoryFacts: number;
    memoryRoot: string;
    lastConsolidationTime: number | null;
    semanticIndex: {
      vectorCount: number;
      hnswSize: number;
      bm25DocCount: number;
      embeddingAvailable: boolean;
    };
  }> {
    const episodeEntries = this._recallIndexCache.length;
    const decisionNodes = this._decisionGraphCache.nodes.length;
    const projectFacts = this._projectMemoryCache.facts.length;

    const factFiles = await listJsonFiles(this._factsDir);
    const decisionFiles = (await readdir(this._decisionsDir))
      .filter((f) => f.endsWith(".json") && f !== "graph.json");

    const semanticStats = this._semanticIndex.getStats();

    return {
      episodeCount: episodeEntries,
      decisionCount: decisionFiles.length,
      factCount: factFiles.length,
      recallIndexSize: episodeEntries,
      decisionGraphNodes: decisionNodes,
      projectMemoryFacts: projectFacts,
      memoryRoot: this._memoryRoot,
      lastConsolidationTime: this._lastConsolidationTime,
      semanticIndex: {
        vectorCount: semanticStats.vectorCount,
        hnswSize: semanticStats.hnswSize,
        bm25DocCount: semanticStats.bm25DocCount,
        embeddingAvailable: semanticStats.embeddingAvailable,
      },
    };
  }
}
