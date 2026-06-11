/**
 * Execution mode handlers
 *
 * Defines the 6 user-facing execution modes that can be selected via /mode.
 * At this stage, modes are tracked in the orchestrator and displayed in the
 * TUI, but do NOT affect the core agentic loop. Future implementations will
 * wire each mode to its specific execution strategy.
 *
 * User-facing modes (shown in /mode):
 *   auto             — Default natural system behavior (classifier-driven)
 *   lightweight      — Lightweight plan execution
 *   speed-campaign   — Fast parallel dispatch
 *   medium-campaign  — Orchestrated multi-wave campaign
 *   high-campaign    — Continuous campaign with convergence
 *   modus-maximus    — Full orchestration pipeline
 *
 * Internal handler constants (used by DirectMode / LightweightPlanMode
 * handler classes which provide the actual execution fallback):
 *   DIRECT           — Direct single-turn execution
 *   LIGHTWEIGHT_PLAN — Lightweight plan execution
 */

export const ExecutionModes = {
  // ── User-facing modes ──────────────────────────────────────────────
  AUTO: "AUTO",
  LIGHTWEIGHT: "LIGHTWEIGHT",
  SPEED_CAMPAIGN: "SPEED_CAMPAIGN",
  MEDIUM_CAMPAIGN: "MEDIUM_CAMPAIGN",
  HIGH_CAMPAIGN: "HIGH_CAMPAIGN",
  MODUS_MAXIMUS: "MODUS_MAXIMUS",

  // ── Internal handler constants ─────────────────────────────────────
  DIRECT: "DIRECT",
  LIGHTWEIGHT_PLAN: "LIGHTWEIGHT_PLAN",
} as const;

export type ExecutionMode = (typeof ExecutionModes)[keyof typeof ExecutionModes];

/**
 * The 6 user-facing mode options exposed via /mode.
 */
export const USER_FACING_MODES: readonly ExecutionMode[] = [
  ExecutionModes.AUTO,
  ExecutionModes.LIGHTWEIGHT,
  ExecutionModes.SPEED_CAMPAIGN,
  ExecutionModes.MEDIUM_CAMPAIGN,
  ExecutionModes.HIGH_CAMPAIGN,
  ExecutionModes.MODUS_MAXIMUS,
] as const;

export { ExecutionModeHandler } from "./handler.js";
export type { Task, ExecutionResult, SubTask, SubTaskStatus, TaskPhase } from "./types.js";
export type { DependencyDAG, CampaignState, ExecutionMetrics, EscalationRecommendation } from "./types.js";

export { DirectMode } from "./direct-mode.js";
export { LightweightPlanMode } from "./lightweight-plan-mode.js";
export { ModusMaximusMode } from "./modus-maximus-mode.js";
export type { ParsedStep, ConfirmationChoice, ConfirmationResponse, StepAgentExecResult } from "./modus-maximus-mode.js";
export { DynamicReclassifier } from "./dynamic-reclassifier.js";
export type { ReclassifierThresholds } from "./dynamic-reclassifier.js";