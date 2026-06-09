/**
 * DynamicReclassifier — Monitors execution and can escalate mid-turn.
 *
 * After each turn, the orchestrator calls reclassify() to check if mode
 * escalation is warranted based on runtime metrics.
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

interface EscalationCandidate {
  recommendedMode: ExecutionMode;
  confidence: number;
  reason: string;
  shouldEscalate: boolean;
  triggerSignals: string[];
}

/**
 * DynamicReclassifier monitors execution and can escalate mid-turn.
 */
export class DynamicReclassifier {
  private thresholds: ReclassifierThresholds;
  private escalationCount = 0;

  constructor(thresholds?: Partial<ReclassifierThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Reclassify based on current execution metrics.
   * Called by the orchestrator after each turn.
   */
  reclassify(
    metrics: ExecutionMetrics,
    previousMetrics?: ExecutionMetrics,
  ): EscalationRecommendation {
    const triggerSignals: string[] = [];

    const tokenSignal = this.checkTokenGrowth(metrics, previousMetrics);
    if (tokenSignal) triggerSignals.push(tokenSignal);

    const errorSignal = this.checkErrorDensity(metrics);
    if (errorSignal) triggerSignals.push(errorSignal);

    const contextSignal = this.checkUserContext(metrics);
    if (contextSignal) triggerSignals.push(contextSignal);

    const turnSignal = this.checkTurnThreshold(metrics);
    if (turnSignal) triggerSignals.push(turnSignal);

    if (triggerSignals.length === 0) {
      return {
        shouldEscalate: false,
        confidence: 0,
        reason: "No escalation signals detected",
        triggerSignals: [],
      };
    }

    const recommendation = this.determineEscalation(metrics, triggerSignals);

    if (this.escalationCount >= this.thresholds.maxEscalationsBeforeConservative) {
      recommendation.confidence *= 0.5;
      recommendation.reason += " [Conservative mode]";
    }

    if (recommendation.confidence >= this.thresholds.escalationConfidenceThreshold) {
      this.escalationCount++;
    }

    return recommendation;
  }

  /** Reset the escalation counter. */
  reset(): void {
    this.escalationCount = 0;
  }

  private checkTokenGrowth(
    metrics: ExecutionMetrics,
    previousMetrics?: ExecutionMetrics,
  ): string | null {
    if (!previousMetrics) return null;
    const delta = metrics.usage.totalTokens - previousMetrics.usage.totalTokens;
    if (delta > this.thresholds.tokenGrowthRateThreshold) {
      return `token_growth:+${delta}`;
    }
    return null;
  }

  private checkErrorDensity(metrics: ExecutionMetrics): string | null {
    if (metrics.toolCalls.total === 0) return null;
    const ratio = metrics.toolCalls.failed / metrics.toolCalls.total;
    if (ratio >= this.thresholds.toolFailureRatioThreshold) {
      return `error_density:${(ratio * 100).toFixed(0)}%`;
    }
    return null;
  }

  private checkUserContext(metrics: ExecutionMetrics): string | null {
    return metrics.userAddedContext ? "user_added_context" : null;
  }

  private checkTurnThreshold(metrics: ExecutionMetrics): string | null {
    if (metrics.currentMode === ExecutionModes.DIRECT && metrics.turnCount >= 3) {
      return `turn_threshold:${metrics.turnCount}`;
    }
    if (metrics.currentMode === ExecutionModes.LIGHTWEIGHT_PLAN && metrics.turnCount >= 8) {
      return `turn_threshold:${metrics.turnCount}`;
    }
    return null;
  }

  private determineEscalation(
    metrics: ExecutionMetrics,
    signals: string[],
  ): EscalationCandidate {
    const currentMode = metrics.currentMode;
    const hasTokenSpike = signals.some((s) => s.startsWith("token_growth"));
    const hasErrorSpike = signals.some((s) => s.startsWith("error_density"));
    const hasUserContext = signals.some((s) => s.startsWith("user_added_context"));

    switch (currentMode) {
      case ExecutionModes.DIRECT:
        if (hasTokenSpike || hasErrorSpike) {
          return {
            shouldEscalate: true,
            triggerSignals: signals,
            recommendedMode: ExecutionModes.PARALLEL_DISPATCH,
            confidence: Math.min(0.7 + (hasErrorSpike ? 0.15 : 0) + (hasUserContext ? 0.1 : 0), 0.95),
            reason: `DIRECT → PARALLEL_DISPATCH: ${hasErrorSpike ? "High error density. " : ""}${hasTokenSpike ? "Rapid token growth. " : ""}${hasUserContext ? "New context added. " : ""}`,
          };
        }
        if (hasUserContext) {
          return {
            shouldEscalate: true,
            triggerSignals: signals,
            recommendedMode: ExecutionModes.LIGHTWEIGHT_PLAN,
            confidence: 0.65,
            reason: "DIRECT → LIGHTWEIGHT_PLAN: User added context mid-task.",
          };
        }
        break;

      case ExecutionModes.LIGHTWEIGHT_PLAN:
        if (hasErrorSpike || hasTokenSpike) {
          return {
            shouldEscalate: true,
            triggerSignals: signals,
            recommendedMode: ExecutionModes.PARALLEL_DISPATCH,
            confidence: hasErrorSpike ? 0.75 : 0.7,
            reason: `LIGHTWEIGHT_PLAN → PARALLEL_DISPATCH: ${hasErrorSpike ? "High error density." : "Rapid token growth."}`,
          };
        }
        break;

      case ExecutionModes.PARALLEL_DISPATCH:
        if (hasErrorSpike) {
          return {
            shouldEscalate: true,
            triggerSignals: signals,
            recommendedMode: ExecutionModes.ORCHESTRATED_CAMPAIGN,
            confidence: 0.8,
            reason: "PARALLEL_DISPATCH → ORCHESTRATED_CAMPAIGN: Concurrent errors in parallel dispatch.",
          };
        }
        break;

      case ExecutionModes.ORCHESTRATED_CAMPAIGN:
      case ExecutionModes.CAMPAIGN_CONTINUOUS:
        break;
    }

    const nextMode = this.getNextMode(currentMode);
    return {
      shouldEscalate: true,
      triggerSignals: signals,
      recommendedMode: nextMode,
      confidence: 0.5,
      reason: `Escalating from ${currentMode} to ${nextMode}: ${signals.join(", ")}.`,
    };
  }

  private getNextMode(current: ExecutionMode): ExecutionMode {
    const path: ExecutionMode[] = [
      ExecutionModes.DIRECT,
      ExecutionModes.LIGHTWEIGHT_PLAN,
      ExecutionModes.PARALLEL_DISPATCH,
      ExecutionModes.ORCHESTRATED_CAMPAIGN,
      ExecutionModes.CAMPAIGN_CONTINUOUS,
    ];
    const idx = path.indexOf(current);
    if (idx >= 0 && idx < path.length - 1) {
      return path[idx + 1]!;
    }
    return current;
  }
}