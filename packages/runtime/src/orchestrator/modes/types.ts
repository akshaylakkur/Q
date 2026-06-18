/**
 * Types — Task, ExecutionResult, TaskPhase, and execution framework types.
 */

import type { ExecutionMode } from "./index.js";
import type { IntentProfile } from "../intent.js";

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/**
 * A single unit of work to be executed by a mode handler.
 */
export interface Task {
  /** Unique task identifier */
  id: string;
  /** The original user prompt */
  prompt: string;
  /** Optional high-level goal derived from the prompt */
  goal?: string;
  /** Intent profile from the classifier */
  profile?: IntentProfile;
  /** Selected execution mode */
  mode?: ExecutionMode;
  /** Ordered list of sub-task IDs (for decomposed tasks) */
  subTaskIds?: string[];
  /** Arbitrary metadata for the task */
  metadata?: Record<string, unknown>;
  /** Timestamp when the task was created */
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// TaskPhase
// ---------------------------------------------------------------------------

/**
 * Phases within an orchestrated campaign.
 */
export type TaskPhase =
  | "research"
  | "explore"
  | "scaffolding"
  | "dependency_resolution"
  | "implementation"
  | "test_generation"
  | "documentation"
  | "verification"
  | "self_correction"
  | "convergence";

// ---------------------------------------------------------------------------
// ExecutionResult
// ---------------------------------------------------------------------------

/**
 * Result produced by a mode handler after executing a task.
 */
export interface ExecutionResult {
  /** Whether the execution completed successfully */
  success: boolean;
  /** The execution mode that was used */
  mode: ExecutionMode;
  /** Task ID this result corresponds to */
  taskId: string;
  /** Summary or primary output text */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Total tokens used during execution */
  totalTokens?: number;
  /** Number of LLM calls made */
  llmCallCount?: number;
  /** Number of tool calls made */
  toolCallCount?: number;
  /** Wall-clock duration in ms */
  durationMs?: number;
  /** Files that were created or modified */
  changedFiles?: string[];
  /** Map of file path to new file content */
  newContents?: Record<string, string>;
  /** Whether verification passed */
  verificationPassed?: boolean;
  /** Sub-task results (for decomposed modes) */
  subResults?: ExecutionResult[];
  /** List of errors encountered (for multi-step modes) */
  errors?: string[];
  /** Timestamp when execution completed */
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// SubTask
// ---------------------------------------------------------------------------

/**
 * A decomposed sub-task for parallel or campaign execution.
 */
export interface SubTask {
  id: string;
  parentTaskId: string;
  description: string;
  phase?: TaskPhase;
  dependencies?: string[]; // IDs of sub-tasks that must complete first
  assignedAgent?: string; // Agent profile name
  status: SubTaskStatus;
  result?: ExecutionResult;
  createdAt: string;
}

export type SubTaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";

// ---------------------------------------------------------------------------
// ExecutionMetrics (for DynamicReclassifier)
// ---------------------------------------------------------------------------

/**
 * Runtime metrics collected during execution for reclassification.
 */
export interface ExecutionMetrics {
  /** Current token usage */
  usage: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
  /** Tool call statistics */
  toolCalls: {
    total: number;
    failed: number;
  };
  /** Number of turns completed so far */
  turnCount: number;
  /** Whether user provided additional context */
  userAddedContext: boolean;
  /** Current execution mode */
  currentMode: ExecutionMode;
  /**
   * Optional metadata for domain-specific signals used by the
   * DynamicReclassifier escalation engine. Known keys:
   *   - convergenceConflicts (number): number of conflicts detected during
   *     convergence loops (used by MEDIUM→HIGH escalation)
   *   - verificationFailures (number): consecutive verification failures
   *     (used by HIGH→MODUS_MAXIMUS escalation)
   */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// DependencyDAG
// ---------------------------------------------------------------------------

/**
 * A directed acyclic graph of sub-task dependencies.
 */
export interface DependencyDAG {
  nodes: Map<string, SubTask>;
  /** Mapping from sub-task ID to array of dependency IDs */
  edges: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// CampaignState (for CampaignContinuousMode)
// ---------------------------------------------------------------------------

/**
 * Persistent state for an active campaign.
 */
export interface CampaignState {
  campaignId: string;
  originalTask: Task;
  currentPhase: TaskPhase;
  completedPhases: TaskPhase[];
  convergenceCount: number;
  pauseRequested: boolean;
  shouldStop: boolean;
  checkpointPath?: string;
  lastCompactionThreshold: number;
  progressCheckpoints: Array<{
    convergenceNumber: number;
    timestamp: string;
    filesChanged: number;
    tokensUsed: number;
  }>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// EscalationEvent
// ---------------------------------------------------------------------------

/**
 * A record of an escalation event that occurred during execution.
 * Used by the DynamicReclassifier to learn from past decisions
 * and avoid oscillation or re-escalating to failed modes.
 */
export interface EscalationEvent {
  /** ISO timestamp when the escalation was recommended */
  timestamp: string;
  /** The mode the execution was leaving */
  fromMode: ExecutionMode;
  /** The mode being escalated to */
  toMode: ExecutionMode;
  /** Confidence score at the time of escalation (0-1) */
  confidence: number;
  /** The trigger signals that prompted this escalation */
  triggerSignals: string[];
  /**
   * Outcome of the escalated mode execution.
   * Set by the orchestrator after the mode completes.
   * 'unknown' while execution is in-flight.
   */
  outcome: 'successful' | 'failed' | 'unknown';
}

// ---------------------------------------------------------------------------
// EscalationRecommendation
// ---------------------------------------------------------------------------

/**
 * Result from the DynamicReclassifier.
 */
export interface EscalationRecommendation {
  /** Whether escalation is recommended */
  shouldEscalate: boolean;
  /** The recommended new mode (if escalation is needed) */
  recommendedMode?: ExecutionMode;
  /** Confidence in the recommendation (0-1) */
  confidence: number;
  /** Human-readable reason for escalation */
  reason: string;
  /** Which signals triggered the escalation */
  triggerSignals: string[];
}