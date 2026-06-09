/**
 * Memory types — Shared type definitions for the multi-tiered memory system.
 *
 * These types are forward-references that will be fully implemented in
 * Steps 24 (EpisodicRecall), 25 (LTPM), and 26 (CodebaseGraphIndex).
 */

// =========================================================================
// RetentionPriority (Step 23 — Enhanced ContextMemory)
// =========================================================================

/**
 * Priority level for message retention during compaction.
 * Critical messages are never compacted. Low messages are first to go.
 */
export type RetentionPriority = "critical" | "high" | "normal" | "low";

// =========================================================================
// ExtractedFact (Step 23 — Enhanced ContextMemory)
// =========================================================================

/**
 * A fact extracted from context messages during compaction.
 */
export interface ExtractedFact {
  /** The factual claim as a string */
  claim: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** IDs of messages that support this fact */
  sourceMessageIds: string[];
}

// =========================================================================
// CompactionRecord (Step 23 — Enhanced ContextMemory)
// =========================================================================

/**
 * Statistics recorded for each compaction cycle.
 */
export interface CompactionRecord {
  /** Timestamp of the compaction */
  timestamp: string;
  /** Tier that was triggered (1, 2, or 3) */
  tier: 1 | 2 | 3;
  /** Total messages before compaction */
  totalMessagesBefore: number;
  /** Total messages after compaction */
  totalMessagesAfter: number;
  /** Tokens saved by compaction */
  tokensSaved: number;
  /** Context pressure that triggered this (0-1) */
  contextPressure: number;
}

// =========================================================================
// Episode (Step 24 — EpisodicRecall)
// =========================================================================

/**
 * A single episodic record — a past agent's session summary.
 *
 * Step 24: Full implementation with sequence numbers, triggers,
 * timestamp range, affected files, module scope, outcomes,
 * token cost, and semantic tags.
 */
export interface Episode {
  /** Unique identifier (UUID v7) */
  id: string;
  /** Session this episode belongs to */
  sessionId: string;
  /** Monotonically increasing within session */
  sequenceNumber: number;
  /** Timestamp range (Unix ms) */
  timestamp: { start: number; end: number };
  /** What triggered this episode */
  trigger: "compaction" | "manual" | "wave_complete";
  /** Natural language summary */
  summary: string;
  /** Decisions extracted during the episode */
  decisions: Decision[];
  /** Facts extracted during the episode */
  facts: ExtractedFact[];
  /** File paths touched during the episode */
  affectedFiles: string[];
  /** Module names involved */
  moduleScope: string[];
  /** Outcome of the episode */
  outcome: "completed" | "failed" | "partial";
  /** Token usage for the episode */
  tokenCost: { promptTokens: number; completionTokens: number };
  /** Tags for retrieval: "refactor", "auth", "bugfix", etc. */
  semanticTags: string[];
  /** The agent profile that produced this episode */
  agentProfile?: string;
}

// =========================================================================
// EpisodeRef (Step 25 — LTPM)
// =========================================================================

/**
 * Reference to an episode that supports a consolidated fact.
 */
export interface EpisodeRef {
  /** Episode ID */
  episodeId: string;
  /** Sequence number within the episode */
  sequenceNumber: number;
}

// =========================================================================
// VerificationRef (Step 25 — LTPM)
// =========================================================================

/**
 * Reference to a verification that confirmed a consolidated fact.
 */
export interface VerificationRef {
  /** Verifier identifier (e.g., agent profile or session ID) */
  verifier: string;
  /** Timestamp of verification */
  timestamp: number;
  /** Outcome of verification */
  outcome: "confirmed" | "disputed" | "updated";
}

// =========================================================================
// Decision (Step 25 — LTPM)
// =========================================================================

/**
 * A design or architectural decision stored in LTPM.
 */
export interface Decision {
  /** Unique identifier (UUID) */
  id: string;
  /** Session this decision belongs to */
  sessionId: string;
  /** Timestamp when the decision was made (Unix ms) */
  timestamp: number;
  /** What prompted the decision */
  context: string;
  /** Options considered */
  alternatives: string[];
  /** What was done */
  chosen: string;
  /** Why this path was chosen */
  rationale: string;
  /** File paths affected by this decision */
  affectedPaths: string[];
  /** Tags for cross-referencing */
  tags: string[];
  /** List of Decision IDs that this overrides */
  supersedes: string[];
  /** List of Decision IDs that override this */
  supersededBy: string[];
}

// =========================================================================
// ConsolidatedFact (Step 25 — LTPM)
// =========================================================================

/**
 * A long-term consolidated fact extracted across episodes.
 */
export interface ConsolidatedFact {
  /** Unique identifier (UUID) */
  id: string;
  /** The factual claim, e.g. "Module X depends on Y through Z" */
  claim: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Episodes supporting this fact */
  sources: EpisodeRef[];
  /** Verifications that confirmed/disputed/updated this fact */
  verifiedBy: VerificationRef[];
  /** Timestamp when the fact was created (Unix ms) */
  createdAt: number;
  /** Timestamp when the fact was last updated (Unix ms) */
  updatedAt: number;
  /** Optional expiration for time-sensitive facts (Unix ms) */
  expiresAt?: number;
}

// =========================================================================
// SessionMemoryState (Step 25 — LTPM)
// =========================================================================

/**
 * The memory state loaded for session resume.
 */
export interface SessionMemoryState {
  /** Recent episodes (last N) */
  recentEpisodes: Episode[];
  /** Active (non-superseded) decisions */
  activeDecisions: Decision[];
  /** Consolidated facts relevant to this session */
  relevantFacts: ConsolidatedFact[];
}

// =========================================================================
// RecallFilters (Step 27 — SemanticRecall)
// =========================================================================

/**
 * Optional filters for semantic recall queries.
 */
export interface RecallFilters {
  /** Only results touching a specific module (via affectedFiles or affectedPaths) */
  module?: string;
  /** Only results with a specific semantic tag */
  tag?: string;
  /** Only results within a Unix ms time window */
  timeRange?: { start: number; end: number };
  /** Only results of a specific item type */
  itemType?: "episode" | "decision" | "fact";
}

// =========================================================================
// ScoredResult (Step 25 — LTPM)
// =========================================================================

/**
 * A scored search result from semantic recall.
 */
export interface ScoredResult {
  /** The matched item */
  item: Episode | Decision | ConsolidatedFact;
  /** Relevance score (0-1) */
  score: number;
  /** The type of the matched item */
  itemType: "episode" | "decision" | "fact";
}

// =========================================================================
// CodebaseSubgraph (Step 26 — CodebaseGraphIndex)
// =========================================================================

/**
 * A subgraph of the full codebase graph scoped to one module.
 */
export interface CodebaseSubgraph {
  /** The root module path */
  moduleRoot: string;
  /** File paths belonging to this module */
  moduleFiles: string[];
  /** Direct dependency file paths */
  dependencies: string[];
  /** Direct dependent file paths (modules that depend on this one) */
  dependents: string[];
  /** File-level dependency edges (from → to) */
  edges: Array<{ from: string; to: string }>;
}

// =========================================================================
// Archivable interface (Step 25 — LTPM retention policies)
// =========================================================================

/**
 * Interface for items that can be archived/cold-stored by retention policy.
 */
export interface Archivable {
  readonly id: string;
  readonly timestamp: number;
}