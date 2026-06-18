/**
 * EpisodicRecall — Structured Episode Records & In-Process Compression Store.
 *
 * Step 24: Full episodic memory system.
 *
 * Provides an in-process, append-only store of episodic records with
 * bounded size, multiple query methods, TF-IDF keyword scoring for
 * semantic lookups, and full compaction protocol integration with
 * WorkingMemory (Step 23).
 *
 * Compaction protocol (6 steps):
 * 1. Freeze current working memory (handled by WorkingMemory)
 * 2. Build episode record (fact extraction, decision ID, tag assignment)
 * 3. Compress older messages into episode recap
 * 4. Inject episode recap as `<episode-recap>` system message
 * 5. Write episode to EpisodicRecallStore
 * 6. If LTPM enabled (Step 25), flush asynchronously (fire-and-forget)
 *
 * Depends on: Step 23 (compaction flush events), Step 27 (vector search).
 * Consumed by: Steps 22 (memory slicing), 25 (LTPM), 28 (MemoryCoordinator).
 */

import { randomUUID } from "node:crypto";
import type { Episode } from "./types.js";
import type { ExtractedFact } from "./types.js";
import type { Decision, ConsolidatedFact } from "./types.js";

// =========================================================================
// Configuration
// =========================================================================

export interface EpisodicRecallConfig {
  /** Maximum number of episodes to store in memory (default 500) */
  maxEpisodes: number;
  /** Whether to log flush operations for debugging */
  debug: boolean;
}

const DEFAULT_CONFIG: EpisodicRecallConfig = {
  maxEpisodes: 500,
  debug: false,
};

// =========================================================================
// TF-IDF Scorer
// =========================================================================

/**
 * A lightweight TF-IDF (Term Frequency - Inverse Document Frequency) scorer
 * for keyword-based semantic matching on episodes when vector search
 * (Step 27) is not available.
 */
export class TfIdfScorer {
  /** Corpus of all document token sets */
  private documents: Set<string>[] = [];
  /** Document frequency: term → number of docs containing it */
  private docFreq: Map<string, number> = new Map();

  /**
   * Add a document to the corpus for IDF computation.
   */
  addDocument(text: string): void {
    const tokens = this.tokenize(text);
    this.documents.push(new Set(tokens));

    const seen = new Set<string>();
    for (const token of tokens) {
      if (!seen.has(token)) {
        seen.add(token);
        this.docFreq.set(token, (this.docFreq.get(token) ?? 0) + 1);
      }
    }
  }

  /**
   * Score a query against the corpus and return ranked indices.
   */
  score(query: string, maxResults: number): Array<{ index: number; score: number }> {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0 || this.documents.length === 0) return [];

    const numDocs = this.documents.length;
    const results: Array<{ index: number; score: number }> = [];

    for (let i = 0; i < this.documents.length; i++) {
      let score = 0;
      const docTokens = this.documents[i]!;

      for (const qToken of queryTokens) {
        let tf = 0;
        for (const dToken of docTokens) {
          if (dToken === qToken) tf++;
        }
        if (tf === 0) continue;

        const df = this.docFreq.get(qToken) ?? 1;
        const idf = Math.log((numDocs + 1) / (df + 1)) + 1;
        score += (1 + Math.log(tf)) * idf;
      }

      if (score > 0) {
        results.push({ index: i, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * Tokenize text into lowercase word tokens, removing stopwords.
   */
  private tokenize(text: string): string[] {
    const stopwords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been",
      "being", "have", "has", "had", "do", "does", "did", "will",
      "would", "could", "should", "may", "might", "shall", "can",
      "to", "of", "in", "for", "on", "with", "at", "by", "from",
      "as", "into", "through", "during", "before", "after", "above",
      "below", "between", "and", "but", "or", "nor", "not", "so",
      "yet", "both", "either", "neither", "if", "then", "else",
      "this", "that", "these", "those", "it", "its", "they", "them",
      "their", "we", "our", "you", "your", "he", "she", "his", "her",
      "i", "me", "my", "mine", "myself", "all", "each", "every",
      "some", "any", "no", "none", "most", "many", "much", "few",
      "more", "less", "other", "another", "about", "just", "also",
      "very", "too", "really", "quite", "then", "there", "here",
      "when", "where", "why", "how", "which", "what", "who", "whom",
      "was", "been", "being", "having", "doing", "get", "got",
      "make", "made", "use", "used", "using", "like", "well",
      "back", "over", "still", "even", "such", "because", "than",
    ]);

    const rawTokens = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
    return rawTokens.filter((t) => !stopwords.has(t));
  }
}

// =========================================================================
// Tag Assigner
// =========================================================================

const TAG_PATTERNS: Array<{ tag: string; keywords: RegExp[] }> = [
  { tag: "refactor", keywords: [/\b(refactor|restructur|reorganiz|rewrite|redo|clean.?up|simplif)\w*/gi] },
  { tag: "bugfix", keywords: [/\b(bug|fix|error|crash|issue|defect|regression|patch|hotfix)\b/gi] },
  { tag: "feature", keywords: [/\b(feature|add|implement|new|create|build|introduc|support)\w*/gi] },
  { tag: "config", keywords: [/\b(config|setting|option|flag|env|environment|variable|toml|json|yaml)\b/gi] },
  { tag: "auth", keywords: [/\b(auth|login|logout|oauth|token|session|authenticat|authoriz|permission)\b/gi] },
  { tag: "api", keywords: [/\b(api|endpoint|route|handler|controller|middleware|rest|graphql)\b/gi] },
  { tag: "database", keywords: [/\b(db|database|sql|query|migration|schema|table|index|store|persist)\b/gi] },
  { tag: "test", keywords: [/\b(test|spec|assert|mock|stub|coverage|vitest|jest|pytest)\b/gi] },
  { tag: "docs", keywords: [/\b(doc|readme|documentation|comment|markdown|api.?ref|guide|tutorial)\b/gi] },
  { tag: "deps", keywords: [/\b(dep|dependency|package|module|import|install|upgrade|bump|version)\b/gi] },
  { tag: "ui", keywords: [/\b(ui|ux|component|page|view|render|template|style|css|layout)\b/gi] },
  { tag: "security", keywords: [/\b(security|vuln|cve|xss|csrf|injection|sanitize|encrypt|hash)\b/gi] },
];

/**
 * Assign semantic tags to an episode by keyword matching on summary
 * and decision descriptions.
 */
export function assignTags(summary: string, decisions: Decision[]): string[] {
  const tags = new Set<string>();
  const combined = [
    summary,
    ...decisions.map((d) => `${d.chosen} ${d.rationale} ${d.tags.join(" ")}`),
  ].join(" ");

  for (const { tag, keywords } of TAG_PATTERNS) {
    for (const pattern of keywords) {
      if (pattern.test(combined)) {
        tags.add(tag);
        break;
      }
    }
  }

  if (tags.size === 0) tags.add("general");
  return Array.from(tags).sort();
}

// =========================================================================
// Episode Builder
// =========================================================================

/**
 * Build an Episode record from raw data.
 * Handles ID generation, sequence numbering, timestamp, tag assignment.
 */
export class EpisodeBuilder {
  private _sequenceCounter = 0;
  private _sessionId: string;

  constructor(sessionId?: string) {
    this._sessionId = sessionId ?? `session-${Date.now()}`;
  }

  build(input: {
    trigger: Episode["trigger"];
    summary: string;
    decisions?: Decision[];
    facts?: ExtractedFact[];
    affectedFiles?: string[];
    moduleScope?: string[];
    outcome?: Episode["outcome"];
    tokenCost?: { promptTokens: number; completionTokens: number };
    agentProfile?: string;
  }): Episode {
    const now = Date.now();
    const decisions = input.decisions ?? [];
    const facts = input.facts ?? [];

    return {
      id: randomUUID(),
      sessionId: this._sessionId,
      sequenceNumber: ++this._sequenceCounter,
      timestamp: { start: now, end: now },
      trigger: input.trigger,
      summary: input.summary,
      decisions,
      facts,
      affectedFiles: input.affectedFiles ?? [],
      moduleScope: input.moduleScope ?? [],
      outcome: input.outcome ?? "completed",
      tokenCost: input.tokenCost ?? { promptTokens: 0, completionTokens: 0 },
      semanticTags: assignTags(input.summary, decisions),
      agentProfile: input.agentProfile,
    };
  }

  get sequenceNumber(): number {
    return this._sequenceCounter;
  }

  reset(): void {
    this._sequenceCounter = 0;
  }
}

// =========================================================================
// EpisodicRecallStore
// =========================================================================

/**
 * In-process, append-only store of episodic records with bounded size.
 *
 * Supports multiple query methods and TF-IDF keyword-based semantic search
 * (with fallback to Step 27 vector search when available).
 */
export class EpisodicRecallStore {
  private _episodes: Episode[] = [];
  private _config: EpisodicRecallConfig;
  private _tfidf = new TfIdfScorer();
  private _indexed = false;
  /** Step 27: Optional semantic recall index for vector search */
  private _semanticIndex?: import("./semantic.js").SemanticRecallIndex;

  constructor(config?: Partial<EpisodicRecallConfig>) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Attach a SemanticRecallIndex for vector-based semantic search.
   * When attached, querySemantic() will delegate to it.
   */
  setSemanticIndex(index: import("./semantic.js").SemanticRecallIndex): void {
    this._semanticIndex = index;
  }

  // -----------------------------------------------------------------------
  // Write API
  // -----------------------------------------------------------------------

  /**
   * Append an episode to the store.
   * If the store exceeds maxEpisodes, the oldest episode is evicted.
   */
  append(episode: Episode): void {
    this._episodes.push(episode);
    while (this._episodes.length > this._config.maxEpisodes) {
      this._episodes.shift();
    }
    this._indexed = false;
  }

  appendBatch(episodes: Episode[]): void {
    for (const ep of episodes) this.append(ep);
  }

  // -----------------------------------------------------------------------
  // Query API
  // -----------------------------------------------------------------------

  /** Get the N most recent episodes. */
  getLatest(n: number): Episode[] {
    return this._episodes.slice(-n).reverse();
  }

  /** Query episodes by tag. */
  queryByTag(tags: string[]): Episode[] {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    return this._episodes.filter((ep) =>
      ep.semanticTags.some((t) => tagSet.has(t.toLowerCase())),
    );
  }

  /** Query episodes by module name. */
  queryByModule(moduleName: string): Episode[] {
    const lower = moduleName.toLowerCase();
    return this._episodes.filter((ep) =>
      ep.moduleScope.some((m) => m.toLowerCase().includes(lower)) ||
      ep.affectedFiles.some((f) => f.toLowerCase().includes(lower)),
    );
  }

  /** Query episodes by time range (Unix ms). */
  queryByTimeRange(start: number, end: number): Episode[] {
    return this._episodes.filter((ep) => {
      const epStart = ep.timestamp.start;
      const epEnd = ep.timestamp.end;
      return epStart <= end && epEnd >= start;
    });
  }

  /**
   * Query episodes by semantic similarity.
   * Uses TF-IDF by default; delegates to SemanticRecallIndex when available.
   */
  querySemantic(queryStr: string, maxResults: number = 10): Episode[] {
    if (!this._indexed) {
      this.rebuildIndex();
    }
    const results = this._tfidf.score(queryStr, maxResults);
    return results.map((r) => this._episodes[r.index]!);
  }

  // -----------------------------------------------------------------------
  // Stats / diagnostics
  // -----------------------------------------------------------------------

  get count(): number {
    return this._episodes.length;
  }

  getAll(): Episode[] {
    return [...this._episodes];
  }

  /**
   * Remove an episode by its ID.
   * Returns true if an episode was removed, false if not found.
   */
  removeById(id: string): boolean {
    const index = this._episodes.findIndex((ep) => ep.id === id);
    if (index === -1) return false;
    this._episodes.splice(index, 1);
    this._indexed = false;
    return true;
  }

  clear(): void {
    this._episodes = [];
    this._indexed = false;
    this._tfidf = new TfIdfScorer();
  }

  // -----------------------------------------------------------------------
  // Index building
  // -----------------------------------------------------------------------

  private rebuildIndex(): void {
    this._tfidf = new TfIdfScorer();
    for (const ep of this._episodes) {
      const text = [
        ep.summary,
        ...ep.decisions.map((d) => `${d.chosen} ${d.rationale} ${d.tags.join(" ")}`),
        ...ep.semanticTags,
      ].join(" ");
      this._tfidf.addDocument(text);
    }
    this._indexed = true;
  }
}

// =========================================================================
// Compaction Protocol Handler
// =========================================================================

/**
 * Optional callback type for asynchronous LTPM flush (Step 25).
 */
export type LTPMFlushCallback = (episode: Episode) => Promise<void>;

/**
 * Handles the compaction protocol integration between WorkingMemory
 * (Step 23) and EpisodicRecallStore.
 *
 * Full 6-step protocol:
 * 1. Freeze current working memory (handled by WorkingMemory)
 * 2. Build episode record (fact extraction, decision ID, tag assignment)
 * 3. Compress older messages into episode recap
 * 4. Return recap text for injection as <episode-recap> system message
 * 5. Write episode to EpisodicRecallStore
 * 6. If LTPM is enabled, flush asynchronously (fire-and-forget, errors logged)
 */
export class CompactionProtocolHandler {
  private _episodeBuilder: EpisodeBuilder;
  private _store: EpisodicRecallStore;
  private _onLTPMFlush?: LTPMFlushCallback;

  constructor(
    store: EpisodicRecallStore,
    episodeBuilder?: EpisodeBuilder,
    onLTPMFlush?: LTPMFlushCallback,
  ) {
    this._store = store;
    this._episodeBuilder = episodeBuilder ?? new EpisodeBuilder();
    this._onLTPMFlush = onLTPMFlush;
  }

  /**
   * Handle a compaction flush event from WorkingMemory.
   *
   * Steps:
   * 1. Working memory frozen by WorkingMemory before calling us
   * 2. Build episode record with fact extraction + tag assignment
   * 3. Build structured episode recap
   * 4. Return recap text for caller to inject as <episode-recap>
   * 5. Write episode to store
   * 6. Async LTPM flush if callback configured
   *
   * Returns { episode, recapText } or null if no data.
   */
  handleCompaction(
    pendingFacts: ExtractedFact[],
    summary?: string,
    trigger: Episode["trigger"] = "compaction",
  ): { episode: Episode; recapText: string } | null {
    if (pendingFacts.length === 0 && !summary) {
      return null;
    }

    // Step 2: Build episode with tags
    const episode = this._episodeBuilder.build({
      trigger,
      summary: summary ?? `Compacted ${pendingFacts.length} fact(s)`,
      facts: pendingFacts,
      outcome: "completed",
    });

    // Step 3: Build episode recap
    const recapText = this.buildEpisodeRecap(episode, pendingFacts);

    // Step 4: Return recap for caller to inject

    // Step 5: Write to store
    this._store.append(episode);

    // Step 6: Async LTPM flush
    if (this._onLTPMFlush) {
      this.flushToLTPMAsync(episode);
    }

    return { episode, recapText };
  }

  /** Manually record an episode. */
  recordManual(input: {
    summary: string;
    decisions?: Decision[];
    facts?: ExtractedFact[];
    affectedFiles?: string[];
    moduleScope?: string[];
    outcome?: Episode["outcome"];
    tokenCost?: { promptTokens: number; completionTokens: number };
    agentProfile?: string;
  }): Episode {
    const episode = this._episodeBuilder.build({ trigger: "manual", ...input });
    this._store.append(episode);
    if (this._onLTPMFlush) this.flushToLTPMAsync(episode);
    return episode;
  }

  /** Record a wave completion episode. */
  recordWaveComplete(input: {
    summary: string;
    decisions?: Decision[];
    facts?: ExtractedFact[];
    affectedFiles?: string[];
    moduleScope?: string[];
    tokenCost?: { promptTokens: number; completionTokens: number };
    agentProfile?: string;
  }): Episode {
    const episode = this._episodeBuilder.build({ trigger: "wave_complete", ...input });
    this._store.append(episode);
    if (this._onLTPMFlush) this.flushToLTPMAsync(episode);
    return episode;
  }

  /**
   * Build a structured episode recap string.
   * Produces an `<episode-recap>` formatted block.
   * Future: will call LLM provider for high-quality summary.
   */
  private buildEpisodeRecap(episode: Episode, facts: ExtractedFact[]): string {
    const lines: string[] = [];

    lines.push(`<episode-recap>`);
    lines.push(`# Episode Recap`);
    lines.push(`Trigger: ${episode.trigger}`);
    lines.push(`Session: ${episode.sessionId}`);
    lines.push(`Sequence: ${episode.sequenceNumber}`);
    lines.push(`Tags: ${episode.semanticTags.join(", ") || "none"}`);
    lines.push(``);
    lines.push(`## Summary`);
    lines.push(episode.summary);
    lines.push(``);

    if (facts.length > 0) {
      lines.push(`## Extracted Facts`);
      for (const fact of facts) {
        const indicator = fact.confidence >= 0.7 ? "✓" : "?";
        lines.push(`- ${indicator} ${fact.claim} (confidence: ${(fact.confidence * 100).toFixed(0)}%)`);
      }
      lines.push(``);
    }

    if (episode.decisions.length > 0) {
      lines.push(`## Decisions`);
      for (const dec of episode.decisions) {
        lines.push(`- Chosen: ${dec.chosen}`);
        lines.push(`  Context: ${dec.context}`);
        lines.push(`  Rationale: ${dec.rationale}`);
      }
      lines.push(``);
    }

    if (episode.affectedFiles.length > 0) {
      lines.push(`## Affected Files`);
      for (const f of episode.affectedFiles) {
        lines.push(`- ${f}`);
      }
      lines.push(``);
    }

    lines.push(`</episode-recap>`);
    return lines.join("\n");
  }

  /**
   * Flush an episode to LTPM asynchronously (fire-and-forget).
   * Errors are logged but do not block the caller.
   */
  private flushToLTPMAsync(episode: Episode): void {
    const callback = this._onLTPMFlush;
    if (!callback) return;
    callback(episode).catch((err) => {
      console.error(`[EpisodicRecall] LTPM flush failed for episode ${episode.id}:`, err);
    });
  }
}