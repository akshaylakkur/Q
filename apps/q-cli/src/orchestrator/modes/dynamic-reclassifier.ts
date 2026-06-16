/**
 * DynamicReclassifier — Monitors execution and recommends mode escalation
 * based on runtime metrics.
 *
 * After each turn, the orchestrator calls reclassify() to check if mode
 * escalation is warranted. This engine implements the escalation chain:
 *   AUTO → MODUS_MAXIMUS
 *
 * Each escalation step is triggered by characteristic signals (token growth,
 * tool failures, turn count, convergence conflicts, verification failures)
 * that indicate the current mode is insufficient for the task's complexity.
 *
 * Escalation History Tracking
 * ───────────────────────────
 * The reclassifier maintains an `escalationHistory` array that records every
 * escalation event. When the orchestrator completes a mode execution it calls
 * `recordOutcome()` to mark the escalation as successful or failed. This
 * history is used to:
 *   - Avoid re-escalating to a mode that previously failed
 *   - Reduce confidence for modes that have failed before
 *   - Bias toward modes that have succeeded for similar trigger patterns
 */

import { ExecutionModes } from "./constants.js";
import type { ExecutionMode } from "./constants.js";
import type { EscalationEvent, EscalationRecommendation, ExecutionMetrics } from "./types.js";

/**
 * Thresholds used by the DynamicReclassifier.
 */
export interface ReclassifierThresholds {
  /** Token growth (delta between consecutive turns) that signals rapid expansion */
  tokenGrowthRateThreshold: number;
  /** Ratio of failed tool calls above which the mode may be struggling */
  toolFailureRatioThreshold: number;
  /** Minimum confidence required to recommend escalation (0-1) */
  escalationConfidenceThreshold: number;
  /** Maximum number of escalations before the reclassifier becomes conservative */
  maxEscalationsBeforeConservative: number;
}

const DEFAULT_THRESHOLDS: ReclassifierThresholds = {
  tokenGrowthRateThreshold: 5000,
  toolFailureRatioThreshold: 0.3,
  escalationConfidenceThreshold: 0.6,
  maxEscalationsBeforeConservative: 3,
};

/**
 * Describes the next step in the escalation chain from the current mode.
 */
const ESCALATION_CHAIN: Record<ExecutionMode, ExecutionMode | null> = {
  [ExecutionModes.AUTO]: ExecutionModes.MODUS_MAXIMUS,
  [ExecutionModes.MODUS_MAXIMUS]: null, // Terminal mode — no further escalation
};

/**
 * Penalty applied to confidence when escalating to a mode that previously
 * failed with similar trigger signal patterns.
 */
const HISTORY_FAILURE_PENALTY = 0.2;

/**
 * Bonus applied to confidence when escalating to a mode that previously
 * succeeded with similar trigger signal patterns.
 */
const HISTORY_SUCCESS_BONUS = 0.1;

/**
 * DynamicReclassifier monitors execution and can escalate mid-turn.
 */
export class DynamicReclassifier {
  private thresholds: ReclassifierThresholds;
  private escalationCount = 0;

  /**
   * Roll of all escalation events, ordered by occurrence.
   * Used to learn from past decisions and avoid oscillation.
   */
  private escalationHistory: EscalationEvent[] = [];

  constructor(thresholds?: Partial<ReclassifierThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Reclassify based on current execution metrics, returning an
   * escalation recommendation when runtime signals indicate the
   * current mode is no longer sufficient.
   *
   * The method collects signals from token growth, tool failure rate,
   * turn count, and optional metadata, then feeds them into the
   * escalation chain rules.
   *
   * When an escalation is recommended, the event is automatically
   * recorded in the escalation history so that future recommendations
   * can take past outcomes into account.
   */
  reclassify(
    metrics: ExecutionMetrics,
    previousMetrics?: ExecutionMetrics,
  ): EscalationRecommendation {
    // ── Collect signals ──────────────────────────────────────────────
    const signals: string[] = [];

    // 1. Token growth rate (abrupt expansion suggests unexpected complexity)
    const tokenDelta = this.computeTokenGrowth(metrics, previousMetrics);
    if (tokenDelta !== null && tokenDelta > this.thresholds.tokenGrowthRateThreshold) {
      signals.push(
        `rapid token growth: +${tokenDelta.toLocaleString()} tokens since last turn`,
      );
    }

    // 2. Tool failure ratio (frequent failures → need more robust orchestration)
    const failureRatio = this.computeToolFailureRatio(metrics);
    if (failureRatio > this.thresholds.toolFailureRatioThreshold) {
      signals.push(
        `high tool failure rate: ${(failureRatio * 100).toFixed(0)}% (${metrics.toolCalls.failed}/${metrics.toolCalls.total} calls failed)`,
      );
    }

    // 3. Turn count signal — if we've exceeded a reasonable number of turns
    //    for the current mode, that's pressure for escalation.
    const turnPressure = this.computeTurnPressure(metrics);
    if (turnPressure !== null) {
      signals.push(turnPressure);
    }

    // 4. Metadata domain signals — convergence conflicts & verification failures
    const metadataSignals = this.collectMetadataSignals(metrics);
    signals.push(...metadataSignals);

    // ── Compute escalation ───────────────────────────────────────────
    const recommendation = this.computeEscalation(metrics.currentMode, signals, metrics);

    // ── Record the escalation event if escalation was recommended ────
    if (recommendation.shouldEscalate && recommendation.recommendedMode) {
      this.recordEscalation(
        metrics.currentMode,
        recommendation.recommendedMode,
        recommendation.confidence,
        signals,
      );
    }

    return recommendation;
  }

  /**
   * Record the outcome of a previously-recommended escalation.
   *
   * Called by the orchestrator after the escalated mode completes.
   * Updates the most recent escalation event from `fromMode` → `toMode`
   * with the actual outcome. If no matching in-flight escalation is found
   * (e.g. due to a mode being set directly via /mode), this is a no-op.
   *
   * @param fromMode - The mode that execution was leaving
   * @param toMode   - The mode that was escalated to
   * @param wasSuccessful - Whether the mode execution completed successfully
   */
  recordOutcome(fromMode: ExecutionMode, toMode: ExecutionMode, wasSuccessful: boolean): void {
    // Find the most recent escalation with matching modes that is still 'unknown'
    for (let i = this.escalationHistory.length - 1; i >= 0; i--) {
      const event = this.escalationHistory[i];
      if (!event) continue;
      if (
        event.fromMode === fromMode &&
        event.toMode === toMode &&
        event.outcome === 'unknown'
      ) {
        event.outcome = wasSuccessful ? 'successful' : 'failed';
        return;
      }
    }
  }

  /** Reset the escalation counter and history (e.g. on new task). */
  reset(): void {
    this.escalationCount = 0;
    this.escalationHistory = [];
  }

  /**
   * Return a read-only view of the current escalation history.
   * Useful for diagnostics and TUI display.
   */
  getEscalationHistory(): ReadonlyArray<EscalationEvent> {
    return this.escalationHistory;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Record a new escalation event in the history.
   * The outcome is set to 'unknown' until the orchestrator calls
   * recordOutcome() with the final result.
   */
  private recordEscalation(
    fromMode: ExecutionMode,
    toMode: ExecutionMode,
    confidence: number,
    triggerSignals: string[],
  ): void {
    const event: EscalationEvent = {
      timestamp: new Date().toISOString(),
      fromMode,
      toMode,
      confidence,
      triggerSignals,
      outcome: 'unknown',
    };
    this.escalationHistory.push(event);
  }

  /**
   * Compute the absolute token growth (delta) between consecutive turns.
   * Returns null when previous metrics are unavailable.
   */
  private computeTokenGrowth(
    metrics: ExecutionMetrics,
    previousMetrics?: ExecutionMetrics,
  ): number | null {
    if (!previousMetrics) return null;
    return metrics.usage.totalTokens - previousMetrics.usage.totalTokens;
  }

  /**
   * Compute the ratio of failed tool calls to total tool calls.
   * Returns 0 if no tool calls have been made.
   */
  private computeToolFailureRatio(metrics: ExecutionMetrics): number {
    if (metrics.toolCalls.total <= 0) return 0;
    return metrics.toolCalls.failed / metrics.toolCalls.total;
  }

  /**
   * Compute turn-pressure signal. Returns a human-readable string if
   * the turn count has grown large enough to warrant escalation, or
   * null if no pressure.
   *
   * Heuristic: tasks running beyond 15 turns show diminishing returns
   * in a simple mode and likely need more structured orchestration.
   */
  private computeTurnPressure(metrics: ExecutionMetrics): string | null {
    if (metrics.turnCount < 10) return null;

    if (metrics.turnCount >= 20) {
      return `excessive turn count: ${metrics.turnCount} turns completed (diminishing returns likely)`;
    }
    if (metrics.turnCount >= 15) {
      return `high turn count: ${metrics.turnCount} turns completed (may need structured orchestration)`;
    }
    // 10-14 turns: mild pressure, not enough alone
    if (metrics.toolCalls.total > 0 && this.computeToolFailureRatio(metrics) > 0.2) {
      return `elevated turn count (${metrics.turnCount}) combined with tool failures`;
    }
    return null;
  }

  /**
   * Collect signals from the optional metadata bag. Known keys:
   *   - convergenceConflicts (number): triggers escalation
   *   - verificationFailures (number): triggers escalation
   */
  private collectMetadataSignals(metrics: ExecutionMetrics): string[] {
    const signals: string[] = [];
    const meta = metrics.metadata;
    if (!meta) return signals;

    const convergenceConflicts = meta.convergenceConflicts as number | undefined;
    if (typeof convergenceConflicts === "number" && convergenceConflicts > 0) {
      signals.push(
        `convergence conflicts detected: ${convergenceConflicts} conflict(s) unresolved`,
      );
    }

    const verificationFailures = meta.verificationFailures as number | undefined;
    if (typeof verificationFailures === "number" && verificationFailures > 0) {
      signals.push(
        `verification failures: ${verificationFailures} consecutive failure(s)`,
      );
    }

    return signals;
  }

  /**
   * Apply escalation history penalties and bonuses to the computed confidence.
   *
   * Scans the escalation history for prior escalations to the same `targetMode`.
   * If any prior escalation with a matching trigger signal pattern ended in
   * failure, confidence is reduced by HISTORY_FAILURE_PENALTY (0.2). If a prior
   * escalation succeeded with matching signals, confidence receives a small
   * HISTORY_SUCCESS_BONUS (0.1). The final confidence is clamped to [0, 1].
   *
   * "Similar trigger signals" are determined by matching signal prefixes —
   * e.g. both having "rapid token growth" or "high tool failure rate". This
   * allows the reclassifier to learn from related escalation contexts without
   * requiring exact signal string equality.
   */
  private applyHistoryPenalty(
    baseConfidence: number,
    targetMode: ExecutionMode,
    currentSignals: string[],
  ): number {
    let adjusted = baseConfidence;

    // Extract signal prefixes for similarity matching
    const currentPrefixes = new Set(currentSignals.map((s) => s.split(":")[0]));

    for (const event of this.escalationHistory) {
      if (event.toMode !== targetMode) continue;

      // Check for overlapping signal prefixes
      const eventPrefixes = new Set(event.triggerSignals.map((s) => s.split(":")[0]));
      let hasSharedSignals = false;
      for (const prefix of currentPrefixes) {
        if (eventPrefixes.has(prefix)) {
          hasSharedSignals = true;
          break;
        }
      }

      if (!hasSharedSignals) continue;

      // Apply penalty or bonus based on outcome
      if (event.outcome === 'failed') {
        adjusted -= HISTORY_FAILURE_PENALTY;
      } else if (event.outcome === 'successful') {
        adjusted += HISTORY_SUCCESS_BONUS;
      }
    }

    // Clamp to valid range
    return Math.max(0, Math.min(1, adjusted));
  }

  /**
   * Core escalation engine. Applies the chain rules and returns a
   * recommendation.
   *
   * Rules:
   *   1. No signals → no escalation
   *   2. Already at terminal mode (MODUS_MAXIMUS) → no escalation
   *   3. Escalation count exceeds max → be conservative (no escalation)
   *   4. Escalation history: if a mode has failed before with similar signals,
   *      reduce confidence by HISTORY_FAILURE_PENALTY
   *   5. Apply mode-specific rules to decide if escalation is warranted
   */
  private computeEscalation(
    currentMode: ExecutionMode,
    signals: string[],
    metrics: ExecutionMetrics,
  ): EscalationRecommendation {
    // ── Guard: no signals, nothing to escalate on ────────────────────
    if (signals.length === 0) {
      return {
        shouldEscalate: false,
        confidence: 1,
        reason: "No trigger signals detected — current mode is adequate.",
        triggerSignals: [],
        recommendedMode: currentMode,
      };
    }

    // ── Guard: terminal mode ─────────────────────────────────────────
    if (ESCALATION_CHAIN[currentMode] === null) {
      return {
        shouldEscalate: false,
        confidence: 1,
        reason: `Already at terminal mode (${currentMode}) — no further escalation possible.`,
        triggerSignals: signals,
        recommendedMode: currentMode,
      };
    }

    // ── Guard: too many escalations → go conservative ────────────────
    if (this.escalationCount >= this.thresholds.maxEscalationsBeforeConservative) {
      return {
        shouldEscalate: false,
        confidence: 0.3,
        reason: `Escalation count (${this.escalationCount}) exceeds max (${this.thresholds.maxEscalationsBeforeConservative}) — staying conservative.`,
        triggerSignals: signals,
        recommendedMode: currentMode,
      };
    }

    // ── Guard: check if recommended mode has failed before ───────────
    // If the next mode in the chain has consistently failed in similar
    // contexts, we may block escalation entirely.
    const nextMode = ESCALATION_CHAIN[currentMode]!;
    const blockingFailure = this.findBlockingFailure(nextMode, signals);
    if (blockingFailure) {
      return {
        shouldEscalate: false,
        confidence: 0.15,
        reason:
          `Not escalating to ${nextMode} — prior escalation failed with similar signals ` +
          `(${blockingFailure.timestamp}). Consider an alternative approach.`,
        triggerSignals: signals,
        recommendedMode: currentMode,
      };
    }

    // ── Mode-specific escalation rules ───────────────────────────────
    // Each rule set maps signal patterns to the recommended next mode.
    const failureRatio = this.computeToolFailureRatio(metrics);

    let shouldEscalate = false;
    let confidence = 0;
    let reason = "";

    switch (currentMode) {
      // ── AUTO → MODUS_MAXIMUS ────────────────────────────────────────
      // Trigger: tool failures > 30% or high turn count or rapid token growth
      case ExecutionModes.AUTO: {
        const hasToolFailures = failureRatio > this.thresholds.toolFailureRatioThreshold;
        const hasHighTurnCount = metrics.turnCount >= 15;
        const hasRapidGrowth = signals.some((s) => s.startsWith("rapid token growth"));

        if (hasToolFailures || hasHighTurnCount || hasRapidGrowth) {
          shouldEscalate = true;
          confidence = hasToolFailures ? 0.85 : hasRapidGrowth ? 0.8 : 0.65;
          reason = hasToolFailures
            ? `Tool failure rate ${(failureRatio * 100).toFixed(0)}% exceeds threshold — MODUS_MAXIMUS full orchestration may provide more robust execution.`
            : hasRapidGrowth
              ? `Rapid token growth detected — MODUS_MAXIMUS structured planning can better manage expanding scope.`
              : `Turn count (${metrics.turnCount}) suggests need for full orchestration pipeline.`;
        }
        break;
      }

      default:
        // Unknown mode — no escalation
        break;
    }

    // ── Apply history-based confidence adjustment ────────────────────
    if (shouldEscalate) {
      confidence = this.applyHistoryPenalty(confidence, nextMode, signals);
    }

    // ── Build recommendation ─────────────────────────────────────────
    if (!shouldEscalate) {
      return {
        shouldEscalate: false,
        confidence: 0.5,
        reason: `Signals detected but insufficient for escalation from ${currentMode}.`,
        triggerSignals: signals,
        recommendedMode: currentMode,
      };
    }

    // Check if confidence is below threshold after history adjustment
    if (confidence < this.thresholds.escalationConfidenceThreshold) {
      return {
        shouldEscalate: false,
        confidence,
        reason:
          `Escalation to ${nextMode} considered but confidence (${confidence.toFixed(2)}) ` +
          `is below threshold (${this.thresholds.escalationConfidenceThreshold}) ` +
          `after accounting for prior escalation history.`,
        triggerSignals: signals,
        recommendedMode: currentMode,
      };
    }

    // Increment escalation counter
    this.escalationCount++;

    return {
      shouldEscalate: true,
      confidence: Math.min(confidence, 1),
      reason,
      triggerSignals: signals,
      recommendedMode: nextMode,
    };
  }

  /**
   * Check the escalation history for a prior escalation to `targetMode`
   * that failed with overlapping signal patterns.
   *
   * Returns the first matching failed escalation event, or null if no
   * blocking failure exists. This is used to avoid re-escalating to a
   * mode that previously failed under similar circumstances. A failure
   * is considered "blocking" if it was a clean failure (not 'unknown').
   *
   * "Similar trigger signals" means the current signal set shares at
   * least one signal prefix (portion before the colon) with the prior
   * escalation's trigger signals.
   */
  private findBlockingFailure(
    targetMode: ExecutionMode,
    currentSignals: string[],
  ): EscalationEvent | null {
    const currentPrefixes = new Set(currentSignals.map((s) => s.split(":")[0]));

    for (const event of this.escalationHistory) {
      if (event.toMode !== targetMode) continue;
      if (event.outcome !== 'failed') continue;

      // Check signal overlap
      const eventPrefixes = new Set(event.triggerSignals.map((s) => s.split(":")[0]));
      for (const prefix of currentPrefixes) {
        if (eventPrefixes.has(prefix)) {
          return event; // Blocking failure found
        }
      }
    }

    return null;
  }
}
