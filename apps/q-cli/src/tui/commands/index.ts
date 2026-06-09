/**
 * Dispatch — Entry point for slash command processing.
 *
 * Takes raw user input, parses it, resolves the intent, and dispatches
 * to the appropriate handler.
 */

import { parseSlashInput } from "./parse.js";
import { resolveSlashCommandInput, slashBusyMessage } from "./resolve.js";
import type { SlashCommandHost, SlashCommandBusyReason } from "./types.js";

// Import all command handlers
import {
  handleHelpCommand,
  handleStatusCommand,
  handleSessionCommand,
  handleClearCommand,
  handleExitCommand,
  handleVersionCommand,
} from "./core.js";
import {
  handleModeCommand,
} from "./agent.js";

// =========================================================================
// Re-exports
// =========================================================================

export * from "./types.js";
export * from "./parse.js";
export * from "./registry.js";
export * from "./resolve.js";
export * from "./core.js";
export * from "./agent.js";

// =========================================================================
// Dispatch — main entry point
// =========================================================================

/**
 * Process user input. If it's a slash command, dispatch it.
 * Otherwise, the caller should treat it as normal user input.
 *
 * Returns true if the input was handled as a command, false if it's normal text.
 */
export function dispatchInput(host: SlashCommandHost, text: string): boolean {
  if (!text.startsWith("/")) {
    return false;
  }

  // Launch async but don't block — the host manages lifecycle
  void executeSlashCommand(host, text);
  return true;
}

async function executeSlashCommand(host: SlashCommandHost, input: string): Promise<void> {
  const parsedCommand = parseSlashInput(input);
  const intent = resolveSlashCommandInput({
    input,
    skillCommandMap: new Map(),
    isStreaming: host.appState.streamingPhase !== "idle",
    isCompacting: host.appState.isCompacting,
  });

  switch (intent.kind) {
    case "not-command":
      return;
    case "blocked":
      host.track("command_blocked", { command: intent.commandName, reason: intent.reason });
      host.showError(slashBusyMessage(intent.commandName, intent.reason));
      return;
    case "skill":
      // Future: dispatch to skill system
      host.showError(`Unknown command: /${intent.commandName}`);
      return;
    case "message":
      // It's not really a command — pass through as normal text
      // This shouldn't happen because we check startsWith("/") above,
      // but handle gracefully.
      return;
    case "invalid":
      host.showError(`Unknown command: /${intent.commandName}`);
      return;
    case "builtin":
      host.track("command", { command: intent.name });
      try {
        await handleBuiltInSlashCommand(host, intent.name, intent.args);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        host.showError(`Command /${intent.name} failed: ${msg}`);
      }
      return;
  }
}

async function handleBuiltInSlashCommand(
  host: SlashCommandHost,
  name: string,
  args: string,
): Promise<void> {
  switch (name) {
    // ── Category 1: Core ──────────────────────────────────────────────
    case "help":
      handleHelpCommand(host, args);
      return;
    case "status":
      handleStatusCommand(host, args);
      return;
    case "session":
      handleSessionCommand(host, args);
      return;
    case "clear":
      handleClearCommand(host, args);
      return;
    case "exit":
      await handleExitCommand(host, args);
      return;
    case "version":
      handleVersionCommand(host, args);
      return;

    // ── Category 2: Agent & Orchestration ─────────────────────────────
    case "mode":
      handleModeCommand(host, args);
      return;
    case "plan":
    case "agent":
    case "rewind":
    case "retry":
    case "steer":
    case "task":
      host.showStatus(`/${name} — not yet implemented (coming soon)`);
      return;

    // Category 3: Memory
    case "compact":
    case "memory":
    case "fact":
    case "graph":
    case "context":
    case "forget":
      host.showStatus(`/${name} — not yet implemented (coming soon)`);
      return;

    // Category 4: Model
    case "model":
    case "provider":
    case "thinking":
    case "key":
    case "connect":
      host.showStatus(`/${name} — not yet implemented (coming soon)`);
      return;

    // Category 5: Files
    case "files":
    case "edit":
    case "diff":
    case "grep":
    case "save":
      host.showStatus(`/${name} — not yet implemented (coming soon)`);
      return;

    // Category 6: Replay
    case "replay":
    case "sessions":
    case "export":
    case "undo":
      host.showStatus(`/${name} — not yet implemented (coming soon)`);
      return;

    // Category 7: System
    case "config":
    case "theme":
    case "plugin":
    case "mcp":
    case "skill":
    case "doctor":
    case "onboard":
      host.showStatus(`/${name} — not yet implemented (coming soon)`);
      return;

    default:
      host.showError(`Unknown command: /${name}`);
      return;
  }
}