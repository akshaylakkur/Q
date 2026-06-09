/**
 * Semantic Recall — Vector-Based Search Across Compacted Episodes.
 *
 * Step 27: Provides vector-based semantic search across episodes, decisions,
 * and facts stored in LTPM (Step 25), with a BM25 keyword fallback when
 * embeddings are unavailable.
 *
 * Architecture:
 *   - EmbeddingModel interface: pluggable backends (Xenova, OpenAI, Null).
 *   - CustomHNSWIndex: lightweight custom HNSW ANN graph.
 *   - BM25Index: keyword-based inverted index for fallback mode.
 *   - SemanticRecallIndex: public API orchestrating embedding, ANN/BM25,
 *     filtering, persistence, and lazy initialization.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, access, constants } from "node:fs/promises";
import path from "pathe";
import type { Episode, Decision, ConsolidatedFact, ScoredResult, RecallFilters } from "./types.js";

// =========================================================================
// Constants
// =========================================================================

const VECTOR_DIMENSION = 384; // all-MiniLM-L6-v2
const VECTOR_VERSION = 1;
const M = 16; // HNSW max neighbors per node
const M_L = 1.0 / Math.log(M); // HNSW level multiplier
const EF_SEARCH = 64; // HNSW search beam width
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const FLUSH_DEBOUNCE_MS = 5000;

// =========================================================================
// Stopwords (shared with episodic.ts for consistency)
// =========================================================================

const STOPWORDS = new Set([
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

// =========================================================================
// Embedding Model Interface
// =========================================================================

export interface EmbeddingModel {
  readonly dimension: number;
  readonly available: boolean;
  embed(text: string): Promise<Float32Array>;
}

/**
 * Null embedding model — forces BM25 fallback mode.
 */
export class NullEmbeddingModel implements EmbeddingModel {
  readonly dimension = VECTOR_DIMENSION;
  readonly available = false;
  async embed(): Promise<Float32Array> {
    throw new Error("NullEmbeddingModel cannot produce embeddings");
  }
}

/**
 * Xenova/Transformers local ONNX embedding model.
 * Loaded dynamically to avoid bundling issues.
 */
export class XenovaEmbeddingModel implements EmbeddingModel {
  readonly dimension = VECTOR_DIMENSION;
  private _available = false;
  private _pipeline: unknown | null = null;

  get available(): boolean {
    return this._available;
  }

  async init(): Promise<void> {
    try {
      // Dynamic import avoids tsdown bundling the heavy package
      const { pipeline } = await import("@xenova/transformers");
      this._pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        quantized: true,
      });
      // Warm-up embed to verify model works
      await this.embed("warmup");
      this._available = true;
    } catch (err) {
      this._available = false;
      this._pipeline = null;
      console.error("[SemanticRecall] Xenova model failed to load:", err);
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this._pipeline) {
      throw new Error("Xenova model not initialized");
    }
    const pipe = this._pipeline as {
      (text: string, options: { pooling: string; normalize: boolean }): Promise<{ data: number[] }>;
    };
    const result = await pipe(text, { pooling: "mean", normalize: true });
    // result.data is a flat number[] of length 384
    return new Float32Array(result.data);
  }
}

/**
 * OpenAI text-embedding-3-small API fallback.
 */
export class OpenAIEmbeddingModel implements EmbeddingModel {
  readonly dimension = 1536; // text-embedding-3-small
  private _apiKey: string;
  private _available = true;

  constructor(apiKey: string) {
    this._apiKey = apiKey;
  }

  get available(): boolean {
    return this._available;
  }

  async embed(text: string): Promise<Float32Array> {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: text,
        model: "text-embedding-3-small",
      }),
    });
    if (!resp.ok) {
      this._available = false;
      throw new Error(`OpenAI embedding API error: ${resp.status} ${resp.statusText}`);
    }
    const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return new Float32Array(json.data[0]!.embedding);
  }
}

// =========================================================================
// Binary Min-Heap (internal utility for HNSW search)
// =========================================================================

interface HeapNode {
  id: number;
  dist: number;
}

class MinHeap {
  private _data: HeapNode[] = [];

  push(node: HeapNode): void {
    this._data.push(node);
    this._bubbleUp(this._data.length - 1);
  }

  pop(): HeapNode | undefined {
    if (this._data.length === 0) return undefined;
    const top = this._data[0];
    const last = this._data.pop()!;
    if (this._data.length > 0) {
      this._data[0] = last;
      this._bubbleDown(0);
    }
    return top;
  }

  peek(): HeapNode | undefined {
    return this._data[0];
  }

  get size(): number {
    return this._data.length;
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._data[parent]!.dist <= this._data[i]!.dist) break;
      [this._data[parent]!, this._data[i]!] = [this._data[i]!, this._data[parent]!];
      i = parent;
    }
  }

  private _bubbleDown(i: number): void {
    const n = this._data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this._data[left]!.dist < this._data[smallest]!.dist) smallest = left;
      if (right < n && this._data[right]!.dist < this._data[smallest]!.dist) smallest = right;
      if (smallest === i) break;
      [this._data[i]!, this._data[smallest]!] = [this._data[smallest]!, this._data[i]!];
      i = smallest;
    }
  }
}

// =========================================================================
// Custom HNSW Index
// =========================================================================

interface HnswNode {
  level: number;
  neighbors: number[][]; // neighbors[level] = array of neighbor ids
}

interface HnswSerialized {
  maxLevel: number;
  entryPoint: number;
  nodes: Record<number, HnswNode>;
}

/**
 * Minimal but correct HNSW implementation for approximate nearest-neighbor
 * search. Insert-only; no deletion support needed for LTPM semantics.
 */
export class CustomHNSWIndex {
  private _nodes = new Map<number, HnswNode>();
  private _entryPoint = -1;
  private _maxLevel = 0;
  private _M = M;
  private _mL = M_L;
  private _ef = EF_SEARCH;
  private _vectorLookup: (id: number) => Float32Array = () => new Float32Array(VECTOR_DIMENSION);

  /** Set the vector lookup function for distance computations */
  setVectorLookup(fn: (id: number) => Float32Array): void {
    this._vectorLookup = fn;
  }

  /** Get current number of indexed vectors */
  get size(): number {
    return this._nodes.size;
  }

  /**
   * Insert a new point with the given id into the HNSW graph.
   * @param id - unique integer identifier for the point
   * @param vector - the embedding vector
   * @param distanceFn - (a, b) => number (smaller = closer)
   */
  insert(id: number, vector: Float32Array, distanceFn: (a: Float32Array, b: Float32Array) => number): void {
    const level = this._randomLevel();
    const node: HnswNode = { level, neighbors: [] };
    for (let i = 0; i <= level; i++) {
      node.neighbors.push([]);
    }

    if (this._nodes.size === 0) {
      this._entryPoint = id;
      this._maxLevel = level;
      this._nodes.set(id, node);
      return;
    }

    // Search for nearest neighbors at each layer
    let currEntry = this._entryPoint;
    let currDist = distanceFn(vector, this._vectorLookup(currEntry));
    const ep = { id: currEntry, dist: currDist };

    // Phase 1: greedy descent from top layer to insertion layer + 1
    for (let lc = this._maxLevel; lc > level; lc--) {
      const nearest = this._searchLayer(vector, currEntry, 1, lc, distanceFn);
      if (nearest.length > 0 && nearest[0]!.dist < ep.dist) {
        ep.id = nearest[0]!.id;
        ep.dist = nearest[0]!.dist;
      }
      currEntry = ep.id;
    }

    // Phase 2: search at insertion layer and below, connect neighbors
    for (let lc = Math.min(level, this._maxLevel); lc >= 0; lc--) {
      const candidates = this._searchLayer(vector, currEntry, this._ef, lc, distanceFn);
      const neighbors = this._selectNeighbors(candidates, this._M);
      node.neighbors[lc] = neighbors;

      // Bidirectional links
      for (const nid of neighbors) {
        const nbr = this._nodes.get(nid);
        if (!nbr) continue;
        const nbrNeighbors = nbr.neighbors[lc] ?? [];
        nbrNeighbors.push(id);
        if (nbrNeighbors.length > this._M) {
          // Shrink neighborhood by distance to new point
          const sorted = nbrNeighbors
            .map((nid2) => ({ id: nid2, dist: distanceFn(this._vectorLookup(nid2), this._vectorLookup(id)) }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, this._M)
            .map((n) => n.id);
          nbr.neighbors[lc] = sorted;
        } else {
          nbr.neighbors[lc] = nbrNeighbors;
        }
      }

      currEntry = candidates.length > 0 ? candidates[0]!.id : currEntry;
    }

    this._nodes.set(id, node);
    if (level > this._maxLevel) {
      this._maxLevel = level;
      this._entryPoint = id;
    }
  }

  /**
   * Search for the k nearest neighbors to the query vector.
   */
  search(query: Float32Array, k: number, distanceFn: (a: Float32Array, b: Float32Array) => number): Array<{ id: number; dist: number }> {
    if (this._nodes.size === 0) return [];

    let currEntry = this._entryPoint;
    let currDist = distanceFn(query, this._vectorLookup(currEntry));
    const ep = { id: currEntry, dist: currDist };

    // Descend from top layer
    for (let lc = this._maxLevel; lc > 0; lc--) {
      const nearest = this._searchLayer(query, currEntry, 1, lc, distanceFn);
      if (nearest.length > 0 && nearest[0]!.dist < ep.dist) {
        ep.id = nearest[0]!.id;
        ep.dist = nearest[0]!.dist;
      }
      currEntry = ep.id;
    }

    // Search at layer 0 with wider beam
    const candidates = this._searchLayer(query, currEntry, this._ef, 0, distanceFn);
    const results = candidates.slice(0, k);
    return results.map((c) => ({ id: c.id, dist: c.dist }));
  }

  /** Serialize to JSON-compatible structure */
  serialize(): HnswSerialized {
    const nodes: Record<number, HnswNode> = {};
    for (const [id, node] of this._nodes) {
      nodes[id] = { level: node.level, neighbors: node.neighbors.map((n) => [...n]) };
    }
    return {
      maxLevel: this._maxLevel,
      entryPoint: this._entryPoint,
      nodes,
    };
  }

  /** Deserialize from JSON-compatible structure */
  deserialize(data: HnswSerialized): void {
    this._maxLevel = data.maxLevel;
    this._entryPoint = data.entryPoint;
    this._nodes.clear();
    for (const [idStr, node] of Object.entries(data.nodes)) {
      this._nodes.set(Number(idStr), {
        level: node.level,
        neighbors: node.neighbors.map((n) => [...n]),
      });
    }
  }


  private _randomLevel(): number {
    let level = 0;
    while (Math.random() < this._mL && level < 16) {
      level++;
    }
    return level;
  }

  /**
   * Greedy search within a single layer.
   * Returns candidates sorted by distance (ascending).
   */
  private _searchLayer(
    query: Float32Array,
    entryId: number,
    ef: number,
    layer: number,
    distanceFn: (a: Float32Array, b: Float32Array) => number,
  ): Array<{ id: number; dist: number }> {
    const visited = new Set<number>();
    const candidates = new MinHeap();
    const nearest = new MinHeap();

    const entryDist = distanceFn(query, this._vectorLookup(entryId));
    candidates.push({ id: entryId, dist: entryDist });
    nearest.push({ id: entryId, dist: -entryDist }); // max-heap via negation
    visited.add(entryId);

    while (candidates.size > 0) {
      const curr = candidates.pop()!;
      const farthest = nearest.peek()!;
      if (curr.dist > -farthest.dist) break;

      const node = this._nodes.get(curr.id);
      if (!node) continue;
      const neighbors = node.neighbors[layer] ?? [];
      for (const nid of neighbors) {
        if (visited.has(nid)) continue;
        visited.add(nid);
        const dist = distanceFn(query, this._vectorLookup(nid));
        const f = nearest.peek()!;
        if (dist < -f.dist || nearest.size < ef) {
          candidates.push({ id: nid, dist });
          nearest.push({ id: nid, dist: -dist });
          if (nearest.size > ef) {
            nearest.pop();
          }
        }
      }
    }

    const results: Array<{ id: number; dist: number }> = [];
    while (nearest.size > 0) {
      const n = nearest.pop()!;
      results.push({ id: n.id, dist: -n.dist });
    }
    return results.reverse(); // ascending by distance
  }

  private _selectNeighbors(candidates: Array<{ id: number; dist: number }>, maxNeighbors: number): number[] {
    return candidates.slice(0, maxNeighbors).map((c) => c.id);
  }
}

// =========================================================================
// BM25 Index
// =========================================================================

interface Bm25Doc {
  id: string;
  tokens: string[];
  dl: number; // document length in tokens
}

interface Bm25Serialized {
  docCount: number;
  avgDl: number;
  docFreqs: Record<string, number>;
  docs: Array<{ id: string; tokens: string[]; dl: number }>;
}

/**
 * Lightweight BM25 inverted index for keyword-based fallback search.
 * Maintained in parallel with the vector index so fallback is instant.
 */
export class BM25Index {
  private _docs: Bm25Doc[] = [];
  private _docFreqs = new Map<string, number>();
  private _idToIndex = new Map<string, number>();

  get docCount(): number {
    return this._docs.length;
  }

  /**
   * Add a document to the BM25 index.
   */
  addDocument(id: string, text: string): void {
    if (this._idToIndex.has(id)) {
      // Replace existing document
      const idx = this._idToIndex.get(id)!;
      const oldDoc = this._docs[idx]!;
      // Decrement docFreqs for old tokens
      const seenOld = new Set<string>();
      for (const t of oldDoc.tokens) {
        if (!seenOld.has(t)) {
          seenOld.add(t);
          this._docFreqs.set(t, (this._docFreqs.get(t) ?? 1) - 1);
        }
      }
      // Insert new tokens
      const tokens = this._tokenize(text);
      this._docs[idx] = { id, tokens, dl: tokens.length };
      const seenNew = new Set<string>();
      for (const t of tokens) {
        if (!seenNew.has(t)) {
          seenNew.add(t);
          this._docFreqs.set(t, (this._docFreqs.get(t) ?? 0) + 1);
        }
      }
      return;
    }

    const tokens = this._tokenize(text);
    const doc: Bm25Doc = { id, tokens, dl: tokens.length };
    const idx = this._docs.length;
    this._docs.push(doc);
    this._idToIndex.set(id, idx);

    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        this._docFreqs.set(t, (this._docFreqs.get(t) ?? 0) + 1);
      }
    }
  }

  /**
   * Remove a document from the BM25 index by its ID.
   */
  removeDocument(id: string): void {
    const idx = this._idToIndex.get(id);
    if (idx === undefined) return;

    const doc = this._docs[idx]!;
    const seen = new Set<string>();
    for (const t of doc.tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        const current = this._docFreqs.get(t) ?? 1;
        if (current <= 1) {
          this._docFreqs.delete(t);
        } else {
          this._docFreqs.set(t, current - 1);
        }
      }
    }

    this._docs.splice(idx, 1);
    this._idToIndex.delete(id);
    for (let i = idx; i < this._docs.length; i++) {
      this._idToIndex.set(this._docs[i]!.id, i);
    }
  }

  /**
   * Score a query against all documents and return top results.
   */
  score(query: string, maxResults: number): Array<{ id: string; score: number }> {
    const queryTokens = this._tokenize(query);
    if (queryTokens.length === 0 || this._docs.length === 0) return [];

    const N = this._docs.length;
    const avgDl = this._docs.reduce((sum, d) => sum + d.dl, 0) / N;
    const scores = new Map<string, number>();

    for (const token of queryTokens) {
      const df = this._docFreqs.get(token) ?? 0;
      if (df === 0) continue;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const doc of this._docs) {
        const tf = doc.tokens.filter((t) => t === token).length;
        if (tf === 0) continue;
        const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.dl / avgDl));
        const score = idf * ((tf * (BM25_K1 + 1)) / denom);
        scores.set(doc.id, (scores.get(doc.id) ?? 0) + score);
      }
    }

    const results = Array.from(scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return results;
  }

  /** Serialize to JSON-compatible structure */
  serialize(): Bm25Serialized {
    const docFreqs: Record<string, number> = {};
    for (const [term, df] of this._docFreqs) {
      docFreqs[term] = df;
    }
    const avgDl = this._docs.length > 0
      ? this._docs.reduce((sum, d) => sum + d.dl, 0) / this._docs.length
      : 0;
    return {
      docCount: this._docs.length,
      avgDl,
      docFreqs,
      docs: this._docs.map((d) => ({ id: d.id, tokens: [...d.tokens], dl: d.dl })),
    };
  }

  /** Deserialize from JSON-compatible structure */
  deserialize(data: Bm25Serialized): void {
    this._docs = data.docs.map((d) => ({ id: d.id, tokens: [...d.tokens], dl: d.dl }));
    this._idToIndex.clear();
    for (let i = 0; i < this._docs.length; i++) {
      this._idToIndex.set(this._docs[i]!.id, i);
    }
    this._docFreqs.clear();
    for (const [term, df] of Object.entries(data.docFreqs)) {
      this._docFreqs.set(term, df);
    }
  }

  private _tokenize(text: string): string[] {
    const raw = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
    return raw.filter((t) => !STOPWORDS.has(t));
  }
}

// =========================================================================
// Vector Utilities
// =========================================================================

/** Compute cosine similarity between two float32 vectors. Returns 0-1. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Compute cosine distance (1 - similarity) for HNSW. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  return 1 - cosineSimilarity(a, b);
}

// =========================================================================
// SemanticRecallIndex
// =========================================================================

interface VectorMetaEntry {
  id: string;
  itemType: "episode" | "decision" | "fact";
  index: number; // position in vectors.bin
  tags: string[];
  paths: string[]; // affectedFiles or affectedPaths
  timestampStart: number;
  timestampEnd: number;
}

export interface SemanticRecallConfig {
  /** Directory for index files (default $HOME/.Q/memory/index) */
  indexDir: string;
  /** Embedding model to use */
  embeddingModel?: EmbeddingModel;
  /** Whether to disable embeddings and use BM25 only */
  noEmbeddings: boolean;
  /** Debug logging */
  debug: boolean;
}

const DEFAULT_SEMANTIC_CONFIG: SemanticRecallConfig = {
  indexDir: "",
  noEmbeddings: false,
  debug: false,
};

/**
 * SemanticRecallIndex — Vector-based search across episodes, decisions,
 * and facts stored in LTPM, with BM25 keyword fallback.
 *
 * Public API:
 *   - indexEpisode / indexDecision / indexFact
 *   - recall(query, maxResults, filters) → ScoredResult[]
 *   - init() / flush()
 */
export class SemanticRecallIndex {
  private _config: SemanticRecallConfig;
  private _indexDir: string;
  private _vectorsPath: string;
  private _metaPath: string;
  private _hnswPath: string;
  private _bm25Path: string;

  private _vectors: Float32Array[] = []; // in-memory vectors
  private _meta: VectorMetaEntry[] = [];
  private _hnsw = new CustomHNSWIndex();
  private _bm25 = new BM25Index();

  private _embeddingModel: EmbeddingModel;
  private _initialized = false;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _dirty = false;

  constructor(config?: Partial<SemanticRecallConfig>) {
    const homedir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    this._config = {
      ...DEFAULT_SEMANTIC_CONFIG,
      indexDir: path.join(homedir, ".Q", "memory", "index"),
      ...config,
    };
    this._indexDir = this._config.indexDir;
    this._vectorsPath = path.join(this._indexDir, "vectors.bin");
    this._metaPath = path.join(this._indexDir, "vectors.meta.json");
    this._hnswPath = path.join(this._indexDir, "hnsw.json");
    this._bm25Path = path.join(this._indexDir, "bm25.json");

    if (this._config.noEmbeddings) {
      this._embeddingModel = new NullEmbeddingModel();
    } else if (this._config.embeddingModel) {
      this._embeddingModel = this._config.embeddingModel;
    } else {
      // Try to auto-detect: attempt Xenova, otherwise Null
      this._embeddingModel = new NullEmbeddingModel();
    }
  }

  /** Set or replace the embedding model (useful for testing). */
  setEmbeddingModel(model: EmbeddingModel): void {
    this._embeddingModel = model;
  }

  /** Initialize: create directories and load existing index from disk. */
  async init(): Promise<void> {
    await ensureDir(this._indexDir);
    await this._loadFromDisk();
    this._initialized = true;
  }

  /** Index an episode. */
  async indexEpisode(episode: Episode): Promise<void> {
    const text = this._episodeText(episode);
    await this._indexItem(
      episode.id,
      "episode",
      text,
      episode.semanticTags,
      [...episode.affectedFiles, ...episode.moduleScope],
      episode.timestamp.start,
      episode.timestamp.end,
    );
  }

  /** Index a decision. */
  async indexDecision(decision: Decision): Promise<void> {
    const text = this._decisionText(decision);
    await this._indexItem(
      decision.id,
      "decision",
      text,
      decision.tags,
      decision.affectedPaths,
      decision.timestamp,
      decision.timestamp,
    );
  }

  /** Index a consolidated fact. */
  async indexFact(fact: ConsolidatedFact): Promise<void> {
    const text = fact.claim;
    await this._indexItem(
      fact.id,
      "fact",
      text,
      [],
      [],
      fact.createdAt,
      fact.updatedAt,
    );
  }

  /**
   * Semantic search across all indexed items.
   *
   * 1. Embed the query (or BM25 tokenize).
   * 2. HNSW search (or BM25 score) to get candidate IDs.
   * 3. Load full items from LTPM directories (caller-provided loader).
   * 4. Post-filter by RecallFilters.
   * 5. Compute exact cosine similarity for top candidates.
   * 6. Sort and return ScoredResult[].
   *
   * Note: item loading is delegated to the caller via `itemLoader`.
   * The `recall` method here returns results based on the index only;
   * integration with LTPM resolves full items.
   */
  async recall(
    query: string,
    maxResults: number = 10,
    filters?: RecallFilters,
  ): Promise<Array<{ meta: VectorMetaEntry; score: number }>> {
    if (!this._initialized) {
      await this.init();
    }

    let candidates: Array<{ meta: VectorMetaEntry; score: number }> = [];

    if (this._embeddingModel.available && this._vectors.length > 0) {
      candidates = await this._vectorSearch(query, maxResults * 3);
    } else {
      candidates = this._bm25Search(query, maxResults * 3);
    }

    // Post-filter
    const filtered = candidates.filter((c) => this._passesFilters(c.meta, filters));

    // Recompute exact cosine for top candidates if in vector mode
    if (this._embeddingModel.available && this._vectors.length > 0) {
      const queryVector = await this._embeddingModel.embed(query);
      for (const c of filtered.slice(0, maxResults * 2)) {
        const vec = this._vectors[c.meta.index];
        if (vec) {
          c.score = Math.max(0, Math.min(1, cosineSimilarity(queryVector, vec)));
        }
      }
    }

    // Normalize BM25 scores to [0,1] by dividing by top score
    if (!this._embeddingModel.available && filtered.length > 0) {
      const maxScore = filtered[0]!.score;
      if (maxScore > 0) {
        for (const c of filtered) {
          c.score = Math.min(1, c.score / maxScore);
        }
      }
    }

    // Sort by score descending
    filtered.sort((a, b) => b.score - a.score);
    return filtered.slice(0, maxResults);
  }

  /** Schedule a flush to disk (debounced 5s). */
  scheduleFlush(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
    }
    this._flushTimer = setTimeout(() => {
      this.flush().catch((err) => {
        console.error("[SemanticRecall] Flush failed:", err);
      });
    }, FLUSH_DEBOUNCE_MS);
  }

  /** Flush all index data to disk immediately. */
  async flush(): Promise<void> {
    if (!this._dirty) return;
    await ensureDir(this._indexDir);

    // Write vectors.bin
    await this._writeVectorsBin();

    // Write vectors.meta.json
    await atomicWriteJson(this._metaPath, this._meta);

    // Write hnsw.json
    await atomicWriteJson(this._hnswPath, this._hnsw.serialize());

    // Write bm25.json
    await atomicWriteJson(this._bm25Path, this._bm25.serialize());

    this._dirty = false;
    if (this._config.debug) {
      console.log(`[SemanticRecall] Flushed ${this._meta.length} vectors to disk`);
    }
  }

  /** Get index statistics. */
  getStats(): { vectorCount: number; hnswSize: number; bm25DocCount: number; embeddingAvailable: boolean } {
    return {
      vectorCount: this._vectors.length,
      hnswSize: this._hnsw.size,
      bm25DocCount: this._bm25.docCount,
      embeddingAvailable: this._embeddingModel.available,
    };
  }

  /**
   * Delete an item from all indexes by its ID.
   */
  async deleteById(id: string): Promise<void> {
    if (!this._initialized) await this.init();

    const idx = this._meta.findIndex((m) => m.id === id);
    if (idx === -1) return;

    const metaEntry = this._meta[idx]!;
    const vectorIndex = metaEntry.index;

    // Remove from BM25
    this._bm25.removeDocument(id);

    // Remove from vector list (shift subsequent vectors)
    this._vectors.splice(vectorIndex, 1);

    // Remove from meta list
    this._meta.splice(idx, 1);

    // Update indices in all meta entries after the removed vector
    for (const m of this._meta) {
      if (m.index > vectorIndex) {
        m.index--;
      }
    }

    // Rebuild HNSW from scratch (cleanest approach after deletion)
    this._hnsw = new CustomHNSWIndex();
    if (this._vectors.length > 0) {
      this._hnsw.setVectorLookup((vIdx) => this._vectors[vIdx]!);
      for (let i = 0; i < this._vectors.length; i++) {
        this._hnsw.insert(i, this._vectors[i]!, cosineDistance);
      }
    }

    this._dirty = true;
    this.scheduleFlush();
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  private async _indexItem(
    id: string,
    itemType: VectorMetaEntry["itemType"],
    text: string,
    tags: string[],
    paths: string[],
    timestampStart: number,
    timestampEnd: number,
  ): Promise<void> {
    // Always update BM25
    this._bm25.addDocument(id, text);

    let vectorIndex = -1;
    if (this._embeddingModel.available) {
      try {
        const vector = await this._embeddingModel.embed(text);
        vectorIndex = this._vectors.length;
        this._vectors.push(vector);
        this._hnsw.insert(vectorIndex, vector, cosineDistance);
      } catch (err) {
        console.error(`[SemanticRecall] Embedding failed for ${id}, falling back to BM25 only:`, err);
      }
    }

    // Check if this id already exists in meta; if so, replace
    const existingIdx = this._meta.findIndex((m) => m.id === id);
    const metaEntry: VectorMetaEntry = {
      id,
      itemType,
      index: vectorIndex,
      tags,
      paths,
      timestampStart,
      timestampEnd,
    };

    if (existingIdx >= 0) {
      this._meta[existingIdx] = metaEntry;
    } else {
      this._meta.push(metaEntry);
    }

    this._dirty = true;
    this.scheduleFlush();
  }

  private async _vectorSearch(
    query: string,
    candidateCount: number,
  ): Promise<Array<{ meta: VectorMetaEntry; score: number }>> {
    const queryVector = await this._embeddingModel.embed(query);
    const hnswResults = this._hnsw.search(queryVector, candidateCount, cosineDistance);

    const results: Array<{ meta: VectorMetaEntry; score: number }> = [];
    for (const r of hnswResults) {
      const meta = this._meta[r.id];
      if (!meta) continue;
      // HNSW returns distance; convert to similarity
      const score = 1 - r.dist;
      results.push({ meta, score });
    }
    return results;
  }

  private _bm25Search(query: string, candidateCount: number): Array<{ meta: VectorMetaEntry; score: number }> {
    const bm25Results = this._bm25.score(query, candidateCount);
    const results: Array<{ meta: VectorMetaEntry; score: number }> = [];
    for (const r of bm25Results) {
      const meta = this._meta.find((m) => m.id === r.id);
      if (!meta) continue;
      results.push({ meta, score: r.score });
    }
    return results;
  }

  private _passesFilters(meta: VectorMetaEntry, filters?: RecallFilters): boolean {
    if (!filters) return true;

    if (filters.itemType && meta.itemType !== filters.itemType) return false;

    if (filters.timeRange) {
      const { start, end } = filters.timeRange;
      if (meta.timestampEnd < start || meta.timestampStart > end) return false;
    }

    if (filters.module) {
      const mod = filters.module.toLowerCase();
      const hasPath = meta.paths.some((p) => p.toLowerCase().includes(mod));
      // For facts without paths, heuristic: check claim text (not available here,
      // but fact module filtering is handled at the LTPM integration layer)
      if (!hasPath && meta.itemType !== "fact") return false;
    }

    if (filters.tag) {
      const tag = filters.tag.toLowerCase();
      const hasTag = meta.tags.some((t) => t.toLowerCase().includes(tag));
      if (!hasTag) return false;
    }

    return true;
  }

  private _episodeText(episode: Episode): string {
    const parts: string[] = [episode.summary];
    if (episode.decisions.length > 0) {
      parts.push(...episode.decisions.map((d) => d.chosen + " " + d.rationale));
    }
    if (episode.semanticTags.length > 0) {
      parts.push(episode.semanticTags.join(", "));
    }
    return parts.join("\n");
  }

  private _decisionText(decision: Decision): string {
    return [decision.chosen, decision.rationale, decision.context, decision.tags.join(", ")].join("\n");
  }

  // ========================================================================
  // Persistence
  // ========================================================================

  private async _writeVectorsBin(): Promise<void> {
    const count = this._vectors.length;
    const dim = VECTOR_DIMENSION;
    const headerSize = 16;
    const bodySize = count * dim * 4;
    const buf = Buffer.allocUnsafe(headerSize + bodySize);

    // Header: version, dimension, count, itemType (all uint32 LE)
    buf.writeUInt32LE(VECTOR_VERSION, 0);
    buf.writeUInt32LE(dim, 4);
    buf.writeUInt32LE(count, 8);
    buf.writeUInt32LE(0, 12); // itemType = 0 (mixed)

    for (let i = 0; i < count; i++) {
      const vec = this._vectors[i]!;
      const offset = headerSize + i * dim * 4;
      for (let j = 0; j < dim; j++) {
        buf.writeFloatLE(vec[j]!, offset + j * 4);
      }
    }

    const tmpPath = `${this._vectorsPath}.tmp.${randomUUID().slice(0, 8)}`;
    await writeFile(tmpPath, buf);
    await rename(tmpPath, this._vectorsPath);
  }

  private async _loadFromDisk(): Promise<void> {
    // Load vectors.bin
    try {
      const buf = await readFile(this._vectorsPath);
      const version = buf.readUInt32LE(0);
      const dim = buf.readUInt32LE(4);
      const count = buf.readUInt32LE(8);
      // const itemType = buf.readUInt32LE(12);

      if (version !== VECTOR_VERSION) {
        console.warn(`[SemanticRecall] vectors.bin version mismatch (${version} vs ${VECTOR_VERSION}), rebuilding`);
        return;
      }
      if (dim !== VECTOR_DIMENSION) {
        console.warn(`[SemanticRecall] vectors.bin dimension mismatch (${dim} vs ${VECTOR_DIMENSION}), rebuilding`);
        return;
      }

      const headerSize = 16;
      this._vectors = [];
      for (let i = 0; i < count; i++) {
        const offset = headerSize + i * dim * 4;
        const arr = new Float32Array(dim);
        for (let j = 0; j < dim; j++) {
          arr[j] = buf.readFloatLE(offset + j * 4);
        }
        this._vectors.push(arr);
      }
    } catch {
      // vectors.bin doesn't exist yet
      // leave in-memory vectors untouched
    }

    // Load metadata
    try {
      const metaRaw = await readFile(this._metaPath, "utf-8");
      this._meta = JSON.parse(metaRaw) as VectorMetaEntry[];
    } catch {
      // leave in-memory meta untouched
    }

    // Load HNSW
    try {
      const hnswRaw = await readFile(this._hnswPath, "utf-8");
      const hnswData = JSON.parse(hnswRaw) as HnswSerialized;
      this._hnsw.deserialize(hnswData);
    } catch {
      // hnsw.json doesn't exist yet — keep empty graph
    }
    this._hnsw.setVectorLookup((id) => this._vectors[id]!);

    // Load BM25
    try {
      const bm25Raw = await readFile(this._bm25Path, "utf-8");
      const bm25Data = JSON.parse(bm25Raw) as Bm25Serialized;
      this._bm25.deserialize(bm25Data);
    } catch {
      // bm25.json doesn't exist yet — keep empty index
    }

    // Rebuild HNSW from vectors if meta count != hnsw size (incremental consistency check)
    if (this._vectors.length > 0 && this._hnsw.size !== this._vectors.length) {
      this._hnsw = new CustomHNSWIndex();
      this._hnsw.setVectorLookup((id) => this._vectors[id]!);
      for (let i = 0; i < this._vectors.length; i++) {
        this._hnsw.insert(i, this._vectors[i]!, cosineDistance);
      }
      this._dirty = true;
    }

    if (this._config.debug) {
      console.log(
        `[SemanticRecall] Loaded ${this._vectors.length} vectors, HNSW size ${this._hnsw.size}, BM25 docs ${this._bm25.docCount}`,
      );
    }
  }
}

// =========================================================================
// Utilities
// =========================================================================

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await access(dirPath, constants.F_OK);
  } catch {
    await mkdir(dirPath, { recursive: true });
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp.${randomUUID().slice(0, 8)}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}
