/**
 * Execution mode constants — separated from index.ts to avoid
 * circular dependency with DynamicReclassifier.
 *
 * This file must NOT import from any other file in the modes/ directory.
 */

/**
 * Execution mode constants used across the system.
 *
 * User-facing modes (shown in /mode):
 *   auto             — Default natural system behavior (classifier-driven)
 *   lightweight      — Lightweight plan execution
 *   speed-campaign   — Fast parallel dispatch
 *   medium-campaign  — Orchestrated multi-wave campaign
 *   high-campaign    — Continuous campaign with convergence
 *   modus-maximus    — Full orchestration pipeline
 *
 * Internal handler constants:
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