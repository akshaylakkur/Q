/**
 * Plan Handler — Command handler for /plan.
 *
 * Toggles plan mode on/off. When plan mode is active:
 * 1. User sends a prompt
 * 2. System generates a plan using the LLM
 * 3. Plan is written to ~/.Q/plan/<session_id>.md
 * 4. A dropdown with "Looks good!", "Needs revision", "Redo", "Exit" is shown
 * 5. User selects an option
 * 6. On accept: plan is executed step by step
 * 7. On revision: user provides revision text, plan is updated via StrReplace
 * 8. On redo: plan is regenerated from scratch
 * 9. On exit: plan mode is exited, task is executed directly
 */

import type { SlashCommandHost } from "../commands/types.js";
import { PlanModeController, type PlanPhase } from "./plan-mode.js";

/**
 * Handle /plan — toggle plan mode on/off.
 *
 * Usage: /plan [on|off]
 *
 * When toggled on, the TUI enters plan mode. The editor border changes color
 * to indicate plan mode is active. When the user submits a prompt, the system
 * first generates a plan, shows it, and presents a dropdown for confirmation.
 */
export function handlePlanCommand(host: SlashCommandHost, args: string): void {
  host.track("command", { command: "plan" });

  const trimmed = args.trim().toLowerCase();

  // ── Toggle logic ──────────────────────────────────────────────────
  const isCurrentlyActive = host.appState.planMode;

  if (trimmed === "on" || trimmed === "1" || trimmed === "true") {
    if (isCurrentlyActive) {
      host.showStatus("Plan mode is already active", "info");
      return;
    }
    activatePlanMode(host);
    return;
  }

  if (trimmed === "off" || trimmed === "0" || trimmed === "false") {
    if (!isCurrentlyActive) {
      host.showStatus("Plan mode is not active", "info");
      return;
    }
    deactivatePlanMode(host);
    return;
  }

  // No args or unknown arg — toggle
  if (isCurrentlyActive) {
    deactivatePlanMode(host);
  } else {
    activatePlanMode(host);
  }
}

/**
 * Activate plan mode — show a visual indicator and set the state.
 */
function activatePlanMode(host: SlashCommandHost): void {
  host.appState.planMode = true;

  // Show a prominent visual banner
  host.showNotice(
    "Plan Mode Activated",
    "Your next prompt will be planned before execution. The plan will be reviewed and confirmed before any changes are made.",
  );

  host.showStatus("Plan mode is ON", "success");
  host.showStatus("  Type your task and the system will first create a plan.", "plain");
  host.showStatus("  You can review, revise, or redo the plan before execution.", "plain");
  host.showStatus("  Use /plan off to exit plan mode.", "plain");

  host.requestRender();
}

/**
 * Deactivate plan mode — show a visual indicator and reset the state.
 */
function deactivatePlanMode(host: SlashCommandHost): void {
  host.appState.planMode = false;

  host.showNotice(
    "Plan Mode Deactivated",
    "Your next prompt will be executed directly without planning.",
  );

  host.showStatus("Plan mode is OFF", "info");

  host.requestRender();
}
