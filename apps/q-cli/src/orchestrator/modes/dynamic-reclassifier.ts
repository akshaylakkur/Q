/**
 * DynamicReclassifier — Monitors execution and can escalate mid-turn.
 *
 * After each turn, the orchestrator calls reclassify() to check if mode
 * escalation is warranted based on runtime metrics.
 *
 * Currently stubbed — modes do not yet affect the agentic loop, so the
 * reclassifier always returns "no escalation". Future implementations
 * will wire the escalation chain for the 6 user-facing modes.
 */

import { ExecutionModes } from "./index.js";
import type { ExecutionMode } from "./index.js";
import type { EscalationRecommendation, ExecutionMetrics } from "./types.js";

/**
 * Thresholds used by the DynamicReclassifier.
 */
export interface ReclassifierThresholds {
  tokenGrowthRateThreshold: number;
  toolFailureRatioThreshold: number;
  escalationConfidenceThreshold: number;
  maxEscalationsBeforeConservative: number;
}

const DEFAULT_THRESHOLDS: ReclassifierThresholds = {
  tokenGrowthRateThreshold: 5000,
  toolFailureRatioThreshold: 0.3,
  escalationConfidenceThreshold: 0.6,
  maxEscalationsBeforeConservative: 3,
};

/**
 * DynamicReclassifier monitors execution and can escalate mid-turn.
 * Currently a no-op stub — always returns "no escalation".
 */
export class DynamicReclassifier {
  private thresholds: ReclassifierThresholds;
  private escalationCount = 0;

  constructor(thresholds?: Partial<ReclassifierThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Reclassify based on current execution metrics.
   * Currently returns no escalation — modes are not yet wired.
   */
  reclassify(
    _metrics: ExecutionMetrics,
    _previousMetrics?: ExecutionMetrics,
  ): EscalationRecommendation {
    return {
      shouldEscalate: false,
      confidence: 0,
      reason: "Mode escalation not yet implemented — all modes follow the same execution path.",
      triggerSignals: [],
      recommendedMode: ExecutionModes.AUTO,
    };
  }

  /** Reset the escalation counter. */
  reset(): void {
    this.escalationCount = 0;
  }
}