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
