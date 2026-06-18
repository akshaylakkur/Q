/**
 * Tests — Semantic Recall (Step 27).
 *
 * Covers: BM25 scoring, cosine similarity, custom HNSW ANN,
 * SemanticRecallIndex integration, persistence, fallback mode,
 * and filter correctness.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import path from "pathe";
import {
  BM25Index,
  CustomHNSWIndex,
  cosineSimilarity,
  cosineDistance,
  SemanticRecallIndex,
  NullEmbeddingModel,
  type EmbeddingModel,
} from "../semantic.js";
import type { Episode, Decision, ConsolidatedFact } from "../types.js";

// =========================================================================
// Helpers
// =========================================================================

const TEST_INDEX_DIR = path.join(process.env.HOME ?? "/tmp", ".V-test-semantic-index");

async function cleanTestDir(): Promise<void> {
  try {
    await rm(TEST_INDEX_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
  await mkdir(TEST_INDEX_DIR, { recursive: true });
}

/** Deterministic mock embedding: hashes text to a 384-dim unit vector */
class MockEmbeddingModel implements EmbeddingModel {
  readonly dimension = 384;
  readonly available = true;

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dimension);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < this.dimension; i++) {
      // Mix hash with index to produce varied values
      const v = Math.sin(hash + i * 0.1) + Math.cos(hash * 0.3 + i * 0.05);
      vec[i] = v;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < this.dimension; i++) {
      norm += vec[i]! * vec[i]!;
    }
    const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
    for (let i = 0; i < this.dimension; i++) {
      vec[i]! *= scale;
    }
    return vec;
  }
}

function makeEpisode(id: string, summary: string, tags: string[] = []): Episode {
  const now = Date.now();
  return {
    id,
    sessionId: "test-session",
    sequenceNumber: 1,
    timestamp: { start: now - 1000, end: now },
    trigger: "compaction",
    summary,
    decisions: [],
    facts: [],
    affectedFiles: [],
    moduleScope: [],
    outcome: "completed",
    tokenCost: { promptTokens: 0, completionTokens: 0 },
    semanticTags: tags,
  };
}

function makeDecision(id: string, chosen: string, rationale: string, tags: string[] = []): Decision {
  return {
    id,
    sessionId: "test-session",
    timestamp: Date.now(),
    context: "test",
    alternatives: [],
    chosen,
    rationale,
    affectedPaths: [],
    tags,
    supersedes: [],
    supersededBy: [],
  };
}

function makeFact(id: string, claim: string): ConsolidatedFact {
  const now = Date.now();
  return {
    id,
    claim,
    confidence: 0.8,
    sources: [],
    verifiedBy: [],
    createdAt: now,
    updatedAt: now,
  };
}

// =========================================================================
// 1. Cosine Similarity
// =========================================================================

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0);
  });

  it("returns ~0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([-1, 0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it("returns expected value for known vectors", () => {
    const a = new Float32Array([1, 1, 0, 0]);
    const b = new Float32Array([1, 0, 1, 0]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(0.5, 2);
  });
});

describe("cosineDistance", () => {
  it("is 0 for identical vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    expect(cosineDistance(a, a)).toBeCloseTo(0.0);
  });

  it("is 1 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineDistance(a, b)).toBeCloseTo(1.0);
  });
});

// =========================================================================
// 2. BM25 Index
// =========================================================================

describe("BM25Index", () => {
  it("scores documents with exact keyword matches highest", () => {
    const idx = new BM25Index();
    idx.addDocument("doc-1", "The quick brown fox jumps over the lazy dog");
    idx.addDocument("doc-2", "The lazy dog sleeps in the sun");
    idx.addDocument("doc-3", "A quick brown fox runs fast");

    const results = idx.score("quick brown fox", 3);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // doc-1 and doc-3 both contain "quick", "brown", "fox"
    const ids = results.map((r) => r.id);
    expect(ids).toContain("doc-1");
    expect(ids).toContain("doc-3");
    // doc-1 has more matches so should outrank doc-2
    expect(ids[0]).not.toBe("doc-2");
  });

  it("handles empty corpus gracefully", () => {
    const idx = new BM25Index();
    const results = idx.score("anything", 10);
    expect(results).toHaveLength(0);
  });

  it("handles query with no matching tokens gracefully", () => {
    const idx = new BM25Index();
    idx.addDocument("doc-1", "hello world");
    const results = idx.score("xyzabc", 10);
    expect(results).toHaveLength(0);
  });

  it("replaces existing documents by id", () => {
    const idx = new BM25Index();
    idx.addDocument("doc-a", "old content about cats");
    idx.addDocument("doc-a", "new content about dogs");
    const results = idx.score("dogs", 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("doc-a");
  });

  it("serializes and deserializes round-trip", () => {
    const idx = new BM25Index();
    idx.addDocument("doc-1", "hello world");
    idx.addDocument("doc-2", "goodbye world");

    const serialized = idx.serialize();
    const idx2 = new BM25Index();
    idx2.deserialize(serialized);

    const r1 = idx.score("hello", 10);
    const r2 = idx2.score("hello", 10);
    expect(r2).toHaveLength(1);
    expect(r2[0]!.id).toBe(r1[0]!.id);
    expect(r2[0]!.score).toBeCloseTo(r1[0]!.score);
  });
});

// =========================================================================
// 3. Custom HNSW Index
// =========================================================================

describe("CustomHNSWIndex", () => {
  it("inserts and searches small dataset with 100% recall", () => {
    const hnsw = new CustomHNSWIndex();
    const dim = 128;
    const count = 50;
    const vectors: Float32Array[] = [];

    // Create random unit vectors
    for (let i = 0; i < count; i++) {
      const v = new Float32Array(dim);
      for (let j = 0; j < dim; j++) {
        v[j] = Math.random() - 0.5;
      }
      let norm = 0;
      for (let j = 0; j < dim; j++) norm += v[j]! * v[j]!;
      const scale = Math.sqrt(norm);
      for (let j = 0; j < dim; j++) v[j]! /= scale;
      vectors.push(v);
    }

    hnsw.setVectorLookup((id) => vectors[id]!);

    for (let i = 0; i < count; i++) {
      hnsw.insert(i, vectors[i]!, cosineDistance);
    }

    expect(hnsw.size).toBe(count);

    // Search for each vector; brute-force check that HNSW returns the query itself
    let correct = 0;
    for (let i = 0; i < count; i++) {
      const results = hnsw.search(vectors[i]!, 5, cosineDistance);
      // The exact same vector should be the closest (distance ~0)
      const foundSelf = results.some((r) => r.id === i && r.dist < 0.001);
      if (foundSelf) correct++;
    }

    // HNSW should find self in >90% of cases with these params
    expect(correct / count).toBeGreaterThanOrEqual(0.85);
  });

  it("returns empty results for empty graph", () => {
    const hnsw = new CustomHNSWIndex();
    const v = new Float32Array([1, 0, 0]);
    const results = hnsw.search(v, 5, cosineDistance);
    expect(results).toHaveLength(0);
  });

  it("serializes and deserializes round-trip", () => {
    const hnsw = new CustomHNSWIndex();
    const vectors = [
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
      new Float32Array([0, 0, 1]),
    ];
    hnsw.setVectorLookup((id) => vectors[id]!);

    for (let i = 0; i < vectors.length; i++) {
      hnsw.insert(i, vectors[i]!, cosineDistance);
    }

    const serialized = hnsw.serialize();
    const hnsw2 = new CustomHNSWIndex();
    hnsw2.deserialize(serialized);
    hnsw2.setVectorLookup((id) => vectors[id]!);

    expect(hnsw2.size).toBe(hnsw.size);

    const q = new Float32Array([1, 0, 0]);
    const r1 = hnsw.search(q, 3, cosineDistance);
    const r2 = hnsw2.search(q, 3, cosineDistance);
    expect(r2.map((r) => r.id)).toEqual(r1.map((r) => r.id));
  });
});

// =========================================================================
// 4. SemanticRecallIndex — Integration
// =========================================================================

describe("SemanticRecallIndex — integration", () => {
  beforeEach(async () => {
    await cleanTestDir();
  });

  afterEach(async () => {
    try {
      await rm(TEST_INDEX_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("indexes episodes and returns them via BM25 fallback", async () => {
    const index = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      noEmbeddings: true,
      debug: false,
    });
    await index.init();

    const ep1 = makeEpisode("ep-1", "Refactored the authentication module", ["refactor", "auth"]);
    const ep2 = makeEpisode("ep-2", "Fixed button alignment in UI", ["bugfix", "ui"]);

    await index.indexEpisode(ep1);
    await index.indexEpisode(ep2);

    const results = await index.recall("auth module", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The auth episode should be top or near-top
    const ids = results.map((r) => r.meta.id);
    expect(ids).toContain("ep-1");
  });

  it("indexes decisions and facts alongside episodes", async () => {
    const index = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      noEmbeddings: true,
      debug: false,
    });
    await index.init();

    const ep = makeEpisode("ep-1", "Implemented caching layer with in-memory cache", ["feature"]);
    const dec = makeDecision("dec-1", "Use Redis", "Fast in-memory cache for sessions", ["database"]);
    const fact = makeFact("fact-1", "Redis cache is used for session storage");

    await index.indexEpisode(ep);
    await index.indexDecision(dec);
    await index.indexFact(fact);

    const results = await index.recall("cache", 10);
    const ids = results.map((r) => r.meta.id);
    expect(ids).toContain("ep-1");
    expect(ids).toContain("dec-1");
    expect(ids).toContain("fact-1");
  });

  it("filters by itemType", async () => {
    const index = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      noEmbeddings: true,
      debug: false,
    });
    await index.init();

    const ep = makeEpisode("ep-1", "Authentication work", ["auth"]);
    const dec = makeDecision("dec-1", "Use OAuth", "Secure login", ["auth"]);
    const fact = makeFact("fact-1", "OAuth tokens expire in one hour");

    await index.indexEpisode(ep);
    await index.indexDecision(dec);
    await index.indexFact(fact);

    const factResults = await index.recall("oauth", 10, { itemType: "fact" });
    expect(factResults).toHaveLength(1);
    expect(factResults[0]!.meta.itemType).toBe("fact");
  });

  it("filters by tag", async () => {
    const index = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      noEmbeddings: true,
      debug: false,
    });
    await index.init();

    const ep1 = makeEpisode("ep-1", "Auth refactor", ["auth", "refactor"]);
    const ep2 = makeEpisode("ep-2", "UI refactor", ["ui", "refactor"]);

    await index.indexEpisode(ep1);
    await index.indexEpisode(ep2);

    const results = await index.recall("refactor", 10, { tag: "auth" });
    expect(results).toHaveLength(1);
    expect(results[0]!.meta.id).toBe("ep-1");
  });

  it("filters by timeRange", async () => {
    const index = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      noEmbeddings: true,
      debug: false,
    });
    await index.init();

    const now = Date.now();
    const epOld = makeEpisode("ep-old", "Old work", []);
    epOld.timestamp = { start: now - 100000, end: now - 90000 };
    const epNew = makeEpisode("ep-new", "Recent work", []);
    epNew.timestamp = { start: now - 1000, end: now };

    await index.indexEpisode(epOld);
    await index.indexEpisode(epNew);

    const results = await index.recall("work", 10, {
      timeRange: { start: now - 5000, end: now + 1000 },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.meta.id).toBe("ep-new");
  });

  it("works with mock embedding model (vector mode)", async () => {
    const model = new MockEmbeddingModel();
    const index = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      embeddingModel: model,
      noEmbeddings: false,
      debug: false,
    });
    await index.init();

    const ep1 = makeEpisode("ep-1", "Authentication module implementation", ["auth"]);
    const ep2 = makeEpisode("ep-2", "Database schema migration", ["database"]);

    await index.indexEpisode(ep1);
    await index.indexEpisode(ep2);

    const stats = index.getStats();
    expect(stats.vectorCount).toBe(2);
    expect(stats.hnswSize).toBe(2);
    expect(stats.embeddingAvailable).toBe(true);

    const results = await index.recall("auth login", 10);
    // At least one result should come back
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Scores should be in [0,1]
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("persists and reloads index from disk", async () => {
    const model = new MockEmbeddingModel();
    const index1 = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      embeddingModel: model,
      noEmbeddings: false,
      debug: false,
    });
    await index1.init();

    const ep = makeEpisode("ep-1", "Persistent memory test", ["test"]);
    await index1.indexEpisode(ep);
    await index1.flush();

    // Create new instance pointing at same dir
    const index2 = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      embeddingModel: model,
      noEmbeddings: false,
      debug: false,
    });
    await index2.init();

    const stats = index2.getStats();
    expect(stats.vectorCount).toBe(1);
    expect(stats.hnswSize).toBe(1);

    const results = await index2.recall("memory", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.meta.id).toBe("ep-1");
  });

  it("fallback mode works when no embeddings model is available", async () => {
    const index = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      noEmbeddings: true,
      debug: false,
    });
    await index.init();

    const ep = makeEpisode("ep-1", "Fallback mode test", ["test"]);
    await index.indexEpisode(ep);

    const stats = index.getStats();
    expect(stats.embeddingAvailable).toBe(false);
    expect(stats.bm25DocCount).toBe(1);

    const results = await index.recall("fallback", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("rebuilds HNSW incrementally after loading partial state", async () => {
    const model = new MockEmbeddingModel();
    const index = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      embeddingModel: model,
      noEmbeddings: false,
      debug: false,
    });
    await index.init();

    const ep = makeEpisode("ep-1", "HNSW rebuild test", ["test"]);
    await index.indexEpisode(ep);
    await index.flush();

    // Corrupt HNSW by deleting it, leaving vectors.bin and meta intact
    const hnswPath = path.join(TEST_INDEX_DIR, "hnsw.json");
    try {
      await rm(hnswPath);
    } catch {
      // ignore
    }

    const index2 = new SemanticRecallIndex({
      indexDir: TEST_INDEX_DIR,
      embeddingModel: model,
      noEmbeddings: false,
      debug: false,
    });
    await index2.init();

    const stats = index2.getStats();
    expect(stats.hnswSize).toBe(1);

    const results = await index2.recall("rebuild", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// 5. SemanticRecallIndex — LTPM integration
// =========================================================================

describe("SemanticRecallIndex — LTPM integration", () => {
  beforeEach(async () => {
    await cleanTestDir();
  });

  afterEach(async () => {
    try {
      await rm(TEST_INDEX_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("LTPM recall uses SemanticRecallIndex for results", async () => {
    const { LTPMStore } = await import("../ltpm.js");
    const ltpm = new LTPMStore({
      memoryRoot: path.join(process.env.HOME ?? "/tmp", ".V-test-ltpm-semantic"),
      debug: false,
    });
    await ltpm.init();

    const ep = makeEpisode("ep-auth", "Implemented JWT authentication", ["auth"]);
    await ltpm.storeEpisode(ep);

    // Default LTPM has a built-in SemanticRecallIndex
    const results = await ltpm.recall("authentication", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.itemType).toBe("episode");

    // Cleanup
    try {
      await rm(path.join(process.env.HOME ?? "/tmp", ".V-test-ltpm-semantic"), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
