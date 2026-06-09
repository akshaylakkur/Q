/**
 * Agent — Command handlers for Category 2 (Agent & Orchestration).
 *
 * This module implements:
 *  /mode   — Switch orchestrator execution mode
 *
 * The 6 user-facing modes are:
 *   auto             — Default natural system behavior (classifier-driven)
 *   lightweight      — Lightweight plan execution
 *   speed-campaign   — Fast parallel dispatch
 *   medium-campaign  — Orchestrated multi-wave campaign
 *   high-campaign    — Continuous campaign with convergence
 *   modus-maximus    — Full orchestration pipeline
 *
 * Modes are tracked in the orchestrator and displayed in the TUI, but do
 * NOT yet affect the core agentic loop. Future implementations will wire
 * each mode to its specific execution strategy.
 *
 * Argument autocomplete for the 6 mode options is provided by the
 * /mode command's getArgumentCompletions hook in registry.ts.
 */

import type { SlashCommandHost } from "./types.js";

// ── User-facing mode names → display labels ─────────────────────────

/**
 * The 6 available modes the user can select via /mode.
 */
export const MODE_OPTIONS = [
  "auto",
  "lightweight",
  "speed-campaign",
  "medium-campaign",
  "high-campaign",
  "modus-maximus",
] as const;

export type ModeOption = (typeof MODE_OPTIONS)[number];

/**
 * Mapping from user-facing option names to their display labels.
 */
export const MODE_DISPLAY_LABELS: Record<ModeOption, string> = {
  "auto": "Auto",
  "lightweight": "Lightweight Plan",
  "speed-campaign": "Speed Campaign",
  "medium-campaign": "Medium Campaign",
  "high-campaign": "High Campaign",
  "modus-maximus": "Modus Maximus",
};

/**
 * Mapping from user-facing option names to internal orchestrator mode strings.
 * These align with the ExecutionModes constants in the orchestrator.
 */
export const MODE_INTERNAL_MAP: Record<ModeOption, string> = {
  "auto": "AUTO",
  "lightweight": "LIGHTWEIGHT",
  "speed-campaign": "SPEED_CAMPAIGN",
  "medium-campaign": "MEDIUM_CAMPAIGN",
  "high-campaign": "HIGH_CAMPAIGN",
  "modus-maximus": "MODUS_MAXIMUS",
};

// ── /mode ────────────────────────────────────────────────────────────

/**
 * Handle /mode — switch the orchestrator execution mode.
 *
 * Usage: /mode <name>
 * Where <name> is one of: auto, lightweight, speed-campaign, medium-campaign,
 * high-campaign, modus-maximus
 *
 * The autocomplete dropdown (provided via getArgumentCompletions in registry.ts)
 * guides the user to select from the 6 available modes. No argument listing
 * is needed here — autocomplete handles discovery.
 */
export function handleModeCommand(host: SlashCommandHost, args: string): void {
  host.track("command", { command: "mode" });

  const trimmed = args.trim().toLowerCase();

  // No args — just show the current mode
  if (!trimmed) {
    const currentMode = host.appState.executionMode || "not set";
    host.showStatus(`Current mode: ${currentMode}`);
    host.showStatus("Hint: use Tab to autocomplete mode options.");
    return;
  }

  // Validate the mode name
  const matched = MODE_OPTIONS.find((opt) => opt === trimmed);
  if (!matched) {
    host.showError(
      `Unknown mode: "${trimmed}". Available: ${MODE_OPTIONS.join(", ")}`,
    );
    return;
  }

  // Resolve the internal mode string
  const internalMode = MODE_INTERNAL_MAP[matched];
  const displayLabel = MODE_DISPLAY_LABELS[matched];

  // Tell the orchestrator to switch mode (if connected)
  if (host.orchestrator) {
    host.orchestrator.setCurrentMode(internalMode);
  }

  // Update the app state so current mode is tracked
  host.appState.executionMode = matched;

  // Signal the mode change to the user with a styled mode announcement
  host.showStatus(`🚀 Entered ${displayLabel}`, "success");
  host.showStatus(`  mode: ${matched}`, "plain");
}