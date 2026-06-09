/**
 * Execution mode handlers
 *
 * DirectMode, LightweightPlanMode, ParallelDispatchMode,
 * OrchestratedCampaignMode, CampaignContinuousMode,
 * DynamicReclassifier.
 */

export const ExecutionModes = {
  DIRECT: "DIRECT",
  LIGHTWEIGHT_PLAN: "LIGHTWEIGHT_PLAN",
  PARALLEL_DISPATCH: "PARALLEL_DISPATCH",
  ORCHESTRATED_CAMPAIGN: "ORCHESTRATED_CAMPAIGN",
  CAMPAIGN_CONTINUOUS: "CAMPAIGN_CONTINUOUS",
} as const;

export type ExecutionMode = (typeof ExecutionModes)[keyof typeof ExecutionModes];

export { ExecutionModeHandler } from "./handler.js";
export type { Task, ExecutionResult, SubTask, SubTaskStatus, TaskPhase } from "./types.js";
export type { DependencyDAG, CampaignState, ExecutionMetrics, EscalationRecommendation } from "./types.js";

export { DirectMode } from "./direct-mode.js";
export { LightweightPlanMode } from "./lightweight-plan-mode.js";
export { ParallelDispatchMode } from "./parallel-dispatch-mode.js";
export { OrchestratedCampaignMode } from "./orchestrated-campaign-mode.js";
export { CampaignContinuousMode } from "./campaign-continuous-mode.js";
export { DynamicReclassifier } from "./dynamic-reclassifier.js";
export type { ReclassifierThresholds } from "./dynamic-reclassifier.js";