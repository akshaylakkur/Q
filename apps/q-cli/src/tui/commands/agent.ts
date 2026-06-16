/**
 * Agent — Command handlers for Category 2 (Agent & Orchestration).
 *
 * This module implements:
 *  /mode   — Switch orchestrator execution mode (auto, modus-maximus)
 *  /agent  — Switch active agent profile (editius, rewritius, searchius, auto)
 *
 * Modes are tracked in the orchestrator and displayed in the TUI status bar.
 * Agent profiles apply different system prompts and tool configurations to
 * the active agent, biasing its behavior toward specific methodologies.
 *
 * Argument autocomplete for both commands is provided by the
 * getArgumentCompletions hooks in registry.ts.
 */

import type { SlashCommandHost } from "./types.js";

// ── User-facing mode names → display labels ─────────────────────────

/**
 * The 2 available modes the user can select via /mode.
 */
export const MODE_OPTIONS = [
  "auto",
  "modus-maximus",
] as const;

export type ModeOption = (typeof MODE_OPTIONS)[number];

/**
 * Mapping from user-facing option names to their display labels.
 */
export const MODE_DISPLAY_LABELS: Record<ModeOption, string> = {
  "auto": "Auto",
  "modus-maximus": "Modus Maximus",
};

/**
 * Mapping from user-facing option names to internal orchestrator mode strings.
 * These align with the ExecutionModes constants in the orchestrator.
 */
export const MODE_INTERNAL_MAP: Record<ModeOption, string> = {
  "auto": "AUTO",
  "modus-maximus": "MODUS_MAXIMUS",
};

/**
 * Mode-specific descriptions shown as status feedback after switching modes.
 * Each description gives the user a concise understanding of what the mode does.
 */
export const MODE_DESCRIPTIONS: Record<ModeOption, string> = {
  "auto":
    "Default mode — single-agent turn loop with classifier-driven behavior adaptation",
  "modus-maximus":
    "Multi-agent orchestration pipeline — plan generation, user confirmation, sequential sub-agent execution, and summary",
};

// ── Agent profiles ──────────────────────────────────────────────────

/**
 * The 4 available agent profiles the user can select via /agent.
 *
 * Each profile defines:
 * - name: The command name used in /agent <name>
 * - label: Display label shown in the UI
 * - description: What this agent profile specializes in
 * - coreCapability: The primary tool/capability this profile focuses on
 *
 * These profiles apply different system prompts and tool configurations
 * to the active agent, biasing its behavior toward specific methodologies.
 */
export const AGENT_PROFILES = [
  {
    name: "editius",
    label: "Editius",
    description: "Precise editing profile — StrReplace, Read, and targeted modifications with minimal diff footprint",
    coreCapability: "StrReplace — surgical string replacements with read-before-edit methodology",
  },
  {
    name: "rewritius",
    label: "Rewritius",
    description: "Refactoring profile — full file rewrites, module transformations, and large-scale changes",
    coreCapability: "Write — complete file replacements with dependency analysis",
  },
  {
    name: "searchius",
    label: "Searchius",
    description: "Analysis profile — systematic codebase search, pattern detection, and intelligence gathering",
    coreCapability: "Read / Glob / Grep — structured multi-phase codebase analysis",
  },
  {
    name: "auto",
    label: "Auto",
    description: "Adaptive profile — automatically selects the best methodology for each task",
    coreCapability: "All tools — task-adaptive execution with best-practice methodology",
  },
] as const;

export type AgentProfileName = (typeof AGENT_PROFILES)[number]["name"];

/**
 * Mapping from agent profile name to its display label.
 */
export const AGENT_DISPLAY_LABELS: Record<AgentProfileName, string> = {
  "editius": "Editius",
  "rewritius": "Rewritius",
  "searchius": "Searchius",
  "auto": "Auto",
};

/**
 * Mapping from agent profile name to its description.
 */
export const AGENT_DESCRIPTIONS: Record<AgentProfileName, string> = {
  "editius": "Precise editing profile — StrReplace, Read, and targeted modifications with minimal diff footprint",
  "rewritius": "Refactoring profile — full file rewrites, module transformations, and large-scale changes",
  "searchius": "Analysis profile — systematic codebase search, pattern detection, and intelligence gathering",
  "auto": "Adaptive profile — automatically selects the best methodology for each task",
};

/**
 * Mapping from agent profile name to its core capability description.
 */
export const AGENT_CORE_CAPABILITIES: Record<AgentProfileName, string> = {
  "editius": "StrReplace — surgical string replacements with read-before-edit verification",
  "rewritius": "Write — complete file replacements with dependency analysis",
  "searchius": "Read / Glob / Grep — structured multi-phase codebase analysis",
  "auto": "All tools — task-adaptive execution with best-practice methodology",
};

// ── /mode ────────────────────────────────────────────────────────────

/**
 * Handle /mode — switch the orchestrator execution mode.
 *
 * Usage: /mode <name>
 * Where <name> is one of: auto, modus-maximus
 *
 * The autocomplete dropdown (provided via getArgumentCompletions in registry.ts)
 * guides the user to select from the 2 available modes. No argument listing
 * is needed here — autocomplete handles discovery.
 */
export function handleModeCommand(host: SlashCommandHost, args: string): void {
  host.track("command", { command: "mode" });

  const trimmed = args.trim().toLowerCase();

  // No args — just show the current mode with its description
  if (!trimmed) {
    const currentMode = host.appState.executionMode || "not set";
    host.showStatus(`Current mode: ${currentMode}`, "plain");

    const found = MODE_OPTIONS.find((opt) => opt === currentMode);
    if (found) {
      const label = MODE_DISPLAY_LABELS[found];
      const desc = MODE_DESCRIPTIONS[found];
      host.showStatus(`  ${label} — ${desc}`, "plain");
    }

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
  const description = MODE_DESCRIPTIONS[matched];

  // Tell the orchestrator to switch mode (if connected)
  if (host.orchestrator) {
    host.orchestrator.setCurrentMode(internalMode);
  }

  // Update the app state so current mode is tracked
  host.appState.executionMode = matched;

  // ── Richer mode-change feedback ─────────────────────────────────

  // 1. Show a prominent notice banner in the transcript
  host.showNotice(`${displayLabel}`, `${description}`);

  // 2. Show status feedback with the mode-specific description
  host.showStatus(`✅ Mode switched to ${displayLabel}`, "success");
  host.showStatus(`   ${description}`, "plain");
  host.showStatus(`   (internal: ${internalMode})`, "plain");
}

// ── /agent ───────────────────────────────────────────────────────────

/**
 * Handle /agent — switch the active agent profile.
 *
 * Usage: /agent <name>
 * Where <name> is one of: editius, rewritius, searchius, auto
 *
 * The autocomplete dropdown (provided via getArgumentCompletions in registry.ts)
 * guides the user to select from the available profiles.
 *
 * When an agent profile is set, the system applies that profile's configuration
 * (system prompt, tool set) to the active agent. The profile remains active
 * until the user switches via /agent again.
 */
export function handleAgentCommand(host: SlashCommandHost, args: string): void {
  host.track("command", { command: "agent" });

  const trimmed = args.trim().toLowerCase();
  const profileNames = AGENT_PROFILES.map((p) => p.name);

  // No args — show the current agent profile and available options
  if (!trimmed) {
    const currentAgent = host.appState.activeAgent || "auto";
    host.showStatus(`Current agent: ${AGENT_DISPLAY_LABELS[currentAgent as AgentProfileName] || currentAgent}`, "plain");

    const desc = AGENT_DESCRIPTIONS[currentAgent as AgentProfileName];
    if (desc) {
      host.showStatus(`  ${desc}`, "plain");
    }

    host.showStatus("", "plain");
    host.showStatus("Available agent profiles:", "plain");
    for (const profile of AGENT_PROFILES) {
      host.showStatus(
        `  ${profile.label.padEnd(12)} ${profile.description}`,
        "plain",
      );
    }
    host.showStatus("Hint: use Tab to autocomplete agent profile names.");
    return;
  }

  // Validate the profile name
  const matched = AGENT_PROFILES.find((p) => p.name === trimmed);
  if (!matched) {
    host.showError(
      `Unknown agent profile: "${trimmed}". Available: ${profileNames.join(", ")}`,
    );
    return;
  }

  const displayLabel = matched.label;
  const description = matched.description;
  const coreCapability = matched.coreCapability;

  // Apply the agent profile to the active agent
  // This updates the system prompt and tool set on the agent
  if (host.agent && host.agent.applyProfile) {
    try {
      host.agent.applyProfile(matched.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      host.showError(`Failed to apply profile "${matched.name}": ${msg}`);
      return;
    }
  }

  // Update the app state so the current agent is tracked
  host.appState.activeAgent = matched.name;

  // ── Richer agent-switch feedback ─────────────────────────────────

  // 1. Show a prominent notice banner in the transcript
  host.showNotice(`${displayLabel}`, `${description}`);

  // 2. Show status feedback with the profile-specific description
  host.showStatus(`✅ Switched to ${displayLabel}`, "success");
  host.showStatus(`   ${description}`, "plain");
  host.showStatus(`   Core capability: ${coreCapability}`, "plain");
  host.showStatus(`   (profile: ${matched.name})`, "plain");
}
