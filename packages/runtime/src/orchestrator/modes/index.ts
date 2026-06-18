/**
 * Execution mode handlers
 *
 * Defines the 2 user-facing execution modes that can be selected via /mode.
 *
 * User-facing modes (shown in /mode):
 *   auto             — Default natural system behavior (classifier-driven)
 *   modus-maximus    — Full orchestration pipeline
 */

export const ExecutionModes = {
  // ── User-facing modes ──────────────────────────────────────────────
  AUTO: "AUTO",
  MODUS_MAXIMUS: "MODUS_MAXIMUS",
} as const;

export type ExecutionMode = (typeof ExecutionModes)[keyof typeof ExecutionModes];

/**
 * The 2 user-facing mode options exposed via /mode.
 */
export const USER_FACING_MODES: readonly ExecutionMode[] = [
  ExecutionModes.AUTO,
  ExecutionModes.MODUS_MAXIMUS,
] as const;

export { ExecutionModeHandler } from "./handler.js";
export type { Task, ExecutionResult, SubTask, SubTaskStatus, TaskPhase } from "./types.js";
export type { DependencyDAG, CampaignState, ExecutionMetrics, EscalationEvent, EscalationRecommendation } from "./types.js";

export { ModusMaximusMode } from "./modus-maximus-mode.js";
export type { ParsedStep, ConfirmationChoice, ConfirmationResponse, StepAgentExecResult } from "./modus-maximus-mode.js";
export { DirectMode } from "./direct-mode.js";
export { DynamicReclassifier } from "./dynamic-reclassifier.js";
export type { ReclassifierThresholds } from "./dynamic-reclassifier.js";
