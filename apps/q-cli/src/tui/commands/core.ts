/**
 * Core — Command handlers for Category 1 (Core Utility & Navigation).
 *
 * This module implements:
 *  /help     — Show the full help dashboard
 *  /status   — Show the rich session dashboard
 *  /session  — Show/manage session info, rename with "title <name>"
 *  /clear    — Clear transcript, optionally start fresh session
 *  /exit     — Gracefully exit the TUI
 *  /version  — Show version info
 */

import type { SlashCommandHost } from "./types.js";

// ── /help ────────────────────────────────────────────────────────────

export function handleHelpCommand(host: SlashCommandHost, _args: string): void {
  host.track("command", { command: "help" });
  host.showHelpPanel();
}

// ── /status ──────────────────────────────────────────────────────────

export function handleStatusCommand(host: SlashCommandHost, _args: string): void {
  host.track("command", { command: "status" });
  host.showStatusDashboard();
}

// ── /session ─────────────────────────────────────────────────────────

export function handleSessionCommand(host: SlashCommandHost, args: string): void {
  host.track("command", { command: "session" });

  const trimmed = args.trim();

  if (!trimmed) {
    // Show session info in the transcript
    const s = host.appState;
    host.showStatus(`Session ID: ${s.sessionId}`);
    host.showStatus(`Working Dir: ${s.workDir}`);
    host.showStatus(`Model: ${s.model}`);
    host.showStatus(`Mode: ${s.permissionMode}${s.planMode ? " + plan" : ""}`);
    host.showStatus(
      `Context: ${s.contextTokens?.toLocaleString() ?? "?"} / ${s.maxContextTokens?.toLocaleString() ?? "128K"} tokens`,
    );
    return;
  }

  // Subcommands
  const parts = trimmed.split(/\s+/);
  const subcmd = parts[0]?.toLowerCase() ?? "";

  if (subcmd === "title" && parts.length >= 2) {
    const title = parts.slice(1).join(" ");
    host.showStatus(`Session title set to: "${title}"`);
    // Future: persist to session store
  } else if (subcmd === "id") {
    host.showStatus(host.appState.sessionId);
  } else if (subcmd === "export") {
    host.showStatus("Session export is not yet implemented");
  } else {
    host.showError(`Unknown /session subcommand: "${subcmd}". Try: title <name>, id, export`);
  }
}

// ── /clear ───────────────────────────────────────────────────────────

export function handleClearCommand(host: SlashCommandHost, args: string): void {
  host.track("command", { command: "clear" });

  const trimmed = args.trim().toLowerCase();

  if (trimmed === "--hard" || trimmed === "-h") {
    // Hard clear: start fresh session
    host.showStatus("Starting a fresh session...");
    host.clearTranscript();
  } else {
    // Soft clear: just clear the transcript view
    host.clearTranscript();
    host.showStatus("Transcript cleared");
  }
}

// ── /exit ────────────────────────────────────────────────────────────

export async function handleExitCommand(host: SlashCommandHost, _args: string): Promise<void> {
  host.track("command", { command: "exit" });
  host.showStatus("Goodbye!");
  // Small delay to allow the status to render before exit
  await new Promise((r) => setTimeout(r, 100));
  await host.stop(0);
}

// ── /version ─────────────────────────────────────────────────────────

export function handleVersionCommand(host: SlashCommandHost, _args: string): void {
  host.track("command", { command: "version" });
  const v = host.appState.version;
  host.showStatus(`Qode Agent v${v}`);
  host.showStatus("Built with pi-tui + agent-core");
}