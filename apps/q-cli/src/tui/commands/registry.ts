/**
 * Registry — Central registry of all built-in slash commands.
 *
 * This defines the complete set of 40+ commands across 7 categories.
 * Category 1 (Core) is fully implemented. Categories 2-7 have command
 * definitions and autocomplete but their handlers show "not yet implemented"
 * status messages. As each command is implemented, its handler in index.ts
 * should be updated to call the real implementation.
 */

import type { QSlashCommand, CommandCategory } from "./types.js";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

// =========================================================================
// Mode argument completions (shared with agent.ts handler)
// =========================================================================

export const MODE_ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
  { value: "auto", label: "auto", description: "Default mode — single-agent turn loop with classifier-driven behavior adaptation" },
  { value: "modus-maximus", label: "modus-maximus", description: "Multi-agent orchestration pipeline — plan, confirm, execute, summarize" },
];

// =========================================================================
// Agent profile argument completions (shared with agent.ts handler)
// =========================================================================

export const AGENT_ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
  { value: "editius", label: "editius", description: "Precise editing profile — StrReplace, Read, and targeted modifications with minimal diff footprint" },
  { value: "rewritius", label: "rewritius", description: "Refactoring profile — full file rewrites, module transformations, and large-scale changes" },
  { value: "searchius", label: "searchius", description: "Analysis profile — systematic codebase search, pattern detection, and intelligence gathering" },
  { value: "auto", label: "auto", description: "Adaptive profile — automatically selects the best methodology for each task" },
];

// =========================================================================
// Full command definitions
// =========================================================================

export const ALL_SLASH_COMMANDS = [
  // ── Category 1: Core Utility & Navigation ───────────────────────────
  {
    name: "help",
    aliases: ["h", "?"],
    description: "Show the full help dashboard with all commands and shortcuts",
    category: "core" as CommandCategory,
    priority: 100,
    availability: "always" as const,
    usage: "/help [filter]",
  },
  {
    name: "status",
    aliases: ["s", "stats"],
    description: "Show rich session dashboard: model, mode, tokens, uptime, memory",
    category: "core" as CommandCategory,
    priority: 95,
    availability: "always" as const,
    usage: "/status",
  },
  {
    name: "session",
    aliases: ["info"],
    description: "Show or manage current session info. Rename with 'title <name>'",
    category: "core" as CommandCategory,
    priority: 90,
    availability: "always" as const,
    usage: "/session [title <name>]",
  },
  {
    name: "clear",
    aliases: ["new", "fresh"],
    description: "Clear the transcript. Use --hard to start a brand new session",
    category: "core" as CommandCategory,
    priority: 85,
    usage: "/clear [--hard]",
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Exit the application gracefully",
    category: "core" as CommandCategory,
    priority: 20,
    availability: "always" as const,
    usage: "/exit",
  },
  {
    name: "version",
    aliases: ["v"],
    description: "Show version information",
    category: "core" as CommandCategory,
    priority: 15,
    availability: "always" as const,
    usage: "/version",
  },

  // ── Category 2: Agent & Orchestration ───────────────────────────────
  {
    name: "mode",
    aliases: ["execution"],
    description: "Switch orchestrator execution mode: auto, modus-maximus",
    category: "agent" as CommandCategory,
    priority: 90,
    usage: "/mode <name>",
    getArgumentCompletions: (_argumentPrefix: string) => MODE_ARGUMENT_COMPLETIONS,
  },
  {
    name: "plan",
    aliases: ["blueprint"],
    description: "Toggle plan mode on/off",
    category: "agent" as CommandCategory,
    priority: 88,
    usage: "/plan [on|off]",
  },
  {
    name: "agent",
    aliases: ["profile", "persona"],
    description: "Switch agent profile: editius, rewritius, searchius, auto",
    category: "agent" as CommandCategory,
    priority: 85,
    usage: "/agent <profile-name>",
    getArgumentCompletions: (_argumentPrefix: string) => AGENT_ARGUMENT_COMPLETIONS,
  },
  {
    name: "rewind",
    aliases: ["undo", "rollback"],
    description: "Rewind conversation to a previous turn or open timeline browser",
    category: "agent" as CommandCategory,
    priority: 82,
    usage: "/rewind [turn-number|-1]",
  },
  {
    name: "retry",
    aliases: ["redo", "try-again"],
    description: "Retry the last agent turn with the same prompt",
    category: "agent" as CommandCategory,
    priority: 80,
    usage: "/retry",
  },
  {
    name: "steer",
    aliases: ["direct"],
    description: "Inject a system directive mid-session",
    category: "agent" as CommandCategory,
    priority: 75,
    usage: "/steer <directive text>",
  },
  {
    name: "task",
    aliases: ["tasks", "jobs"],
    description: "View and manage background tasks / sub-agents",
    category: "agent" as CommandCategory,
    priority: 70,
    availability: "always" as const,
    usage: "/task [stop <id>|output <id>]",
  },

  // ── Category 3: Memory & Context ────────────────────────────────────
  {
    name: "compact",
    aliases: ["compress", "squash"],
    description: "Manually trigger context compaction with tier selection",
    category: "memory" as CommandCategory,
    priority: 88,
    usage: "/compact [--tier 1|2|3] [--dry-run]",
  },
  {
    name: "memory",
    aliases: ["recall", "remember"],
    description: "Query episodic and semantic memory across sessions",
    category: "memory" as CommandCategory,
    priority: 85,
    usage: "/memory <query>",
  },
  {
    name: "fact",
    aliases: ["facts", "knowledge"],
    description: "View and manage consolidated long-term facts",
    category: "memory" as CommandCategory,
    priority: 80,
    usage: "/fact [list|show <id>|search <q>]",
  },
  {
    name: "graph",
    aliases: ["codebase", "deps"],
    description: "Show the codebase dependency graph for the workspace",
    category: "memory" as CommandCategory,
    priority: 75,
    usage: "/graph [<module-path>]",
  },
  {
    name: "context",
    aliases: ["ctx", "window"],
    description: "Show current context window state with usage progress bar",
    category: "memory" as CommandCategory,
    priority: 72,
    availability: "always" as const,
    usage: "/context",
  },
  {
    name: "forget",
    aliases: ["prune", "drop"],
    description: "Remove specific turns or messages from context",
    category: "memory" as CommandCategory,
    priority: 70,
    usage: "/forget [turn <N>|last|range <start-end>]",
  },

  // ── Category 4: Model & Provider ────────────────────────────────────
  {
    name: "model",
    aliases: ["provider"],
    description: "Switch the active model for this session",
    category: "model" as CommandCategory,
    priority: 90,
    usage: "/model <alias>",
  },
  {
    name: "provider",
    aliases: ["backend", "llm"],
    description: "Switch LLM provider (Anthropic, OpenAI, Google, Kimi, etc.)",
    category: "model" as CommandCategory,
    priority: 88,
    usage: "/provider <name>",
  },
  {
    name: "thinking",
    aliases: ["think", "reason"],
    description: "Configure thinking mode: on, off, auto, or effort level 1-100",
    category: "model" as CommandCategory,
    priority: 85,
    usage: "/thinking [on|off|auto|<1-100>]",
  },
  {
    name: "key",
    aliases: ["apikey", "auth"],
    description: "Set or update an API key for a provider (secure masked input)",
    category: "model" as CommandCategory,
    priority: 80,
    usage: "/key <provider>",
  },
  {
    name: "connect",
    aliases: ["login"],
    description: "Connect a provider via OAuth or API key setup wizard",
    category: "model" as CommandCategory,
    priority: 75,
    usage: "/connect",
  },

  // ── Category 5: Files & Edits ───────────────────────────────────────
  {
    name: "files",
    aliases: ["explorer", "tree"],
    description: "Toggle file explorer panel or navigate to a directory",
    category: "files" as CommandCategory,
    priority: 85,
    availability: "always" as const,
    usage: "/files [<path>]",
  },
  {
    name: "edit",
    aliases: ["open"],
    description: "Open a file in the external editor",
    category: "files" as CommandCategory,
    priority: 82,
    usage: "/edit <filepath> [--line N]",
  },
  {
    name: "diff",
    aliases: ["changes", "review"],
    description: "Show pending file changes as unified diff, accept or reject",
    category: "files" as CommandCategory,
    priority: 80,
    usage: "/diff [<file>|accept <all|file>|reject <file>]",
  },
  {
    name: "grep",
    aliases: ["search", "find"],
    description: "Search workspace files with ripgrep pattern",
    category: "files" as CommandCategory,
    priority: 75,
    usage: "/grep <pattern> [--context N] [--ignore-case]",
  },
  {
    name: "save",
    aliases: ["snapshot", "checkpoint"],
    description: "Create a named checkpoint of current session state",
    category: "files" as CommandCategory,
    priority: 70,
    usage: "/save <name>",
  },

  // ── Category 6: Replay & History ────────────────────────────────────
  {
    name: "replay",
    aliases: ["review", "history"],
    description: "Replay a previous session interactively",
    category: "replay" as CommandCategory,
    priority: 85,
    usage: "/replay [<session-id>]",
  },
  {
    name: "sessions",
    aliases: ["list", "resume"],
    description: "Browse and resume past sessions",
    category: "replay" as CommandCategory,
    priority: 82,
    availability: "always" as const,
    usage: "/sessions",
  },
  {
    name: "export",
    aliases: ["archive", "share"],
    description: "Export session as markdown, JSON, or ZIP archive",
    category: "replay" as CommandCategory,
    priority: 78,
    usage: "/export [--md|--json|--zip] [<filepath>]",
  },
  {
    name: "undo",
    aliases: ["back", "prev"],
    description: "Step back one turn, restoring prior context",
    category: "replay" as CommandCategory,
    priority: 75,
    usage: "/undo",
  },

  // ── Category 7: Configuration & System ─────────────────────────────
  {
    name: "qmd",
    aliases: ["project-rules", "conventions"],
    description: "Generate a Q.md file with project conventions, rules, and guidelines via LLM analysis",
    category: "system" as CommandCategory,
    priority: 82,
    availability: "always" as const,
    usage: "/qmd [\"<instructions>\"]",
  },
  {
    name: "config",
    aliases: ["settings", "prefs"],
    description: "Open TUI settings: theme, editor, permissions, defaults",
    category: "system" as CommandCategory,
    priority: 80,
    availability: "always" as const,
    usage: "/config",
  },
  {
    name: "theme",
    aliases: ["colors", "palette"],
    description: "Set the terminal UI color theme",
    category: "system" as CommandCategory,
    priority: 78,
    availability: "always" as const,
    usage: "/theme [<name>|list|custom]",
  },
  {
    name: "plugin",
    aliases: ["plugins", "extensions"],
    description: "Manage plugins: list, install, enable/disable",
    category: "system" as CommandCategory,
    priority: 75,
    availability: "always" as const,
    usage: "/plugin [list|install <name>|remove <name>]",
  },
  {
    name: "mcp",
    aliases: ["tools", "connectors"],
    description: "Show MCP server status and connected tools",
    category: "system" as CommandCategory,
    priority: 72,
    availability: "always" as const,
    usage: "/mcp",
  },
  {
    name: "skill",
    aliases: ["skills", "commands"],
    description: "List, enable, or disable custom workspace skills",
    category: "system" as CommandCategory,
    priority: 70,
    availability: "always" as const,
    usage: "/skill [list|enable <name>|disable <name>]",
  },
  {
    name: "doctor",
    aliases: ["diagnose", "check"],
    description: "Run system health diagnostics: providers, config, git, MCP",
    category: "system" as CommandCategory,
    priority: 65,
    availability: "always" as const,
    usage: "/doctor",
  },
  {
    name: "onboard",
    aliases: ["wizard", "setup"],
    description: "Re-run the initial onboarding setup wizard",
    category: "system" as CommandCategory,
    priority: 60,
    usage: "/onboard",
  },

  // ── Category 8: Qollab Collaboration ───────────────────────────────
  {
    name: "admit",
    aliases: ["approve"],
    description: "Admit a pending attendee into the collaborative session (master only)",
    category: "collab" as CommandCategory,
    priority: 95,
    availability: "always" as const,
    usage: "/admit <userId>",
  },
  {
    name: "reject",
    aliases: ["deny"],
    description: "Reject a pending attendee (master only)",
    category: "collab" as CommandCategory,
    priority: 90,
    availability: "always" as const,
    usage: "/reject <userId> [reason]",
  },
  {
    name: "kick",
    aliases: ["remove"],
    description: "Remove an attendee from the session (master only)",
    category: "collab" as CommandCategory,
    priority: 85,
    availability: "always" as const,
    usage: "/kick <userId>",
  },
  {
    name: "msg",
    aliases: ["say", "chat"],
    description: "Send a chat message to all session participants",
    category: "collab" as CommandCategory,
    priority: 80,
    availability: "always" as const,
    usage: "/msg <text>",
  },
  {
    name: "whisper",
    aliases: ["tell", "dm"],
    description: "Send a private message to a specific attendee",
    category: "collab" as CommandCategory,
    priority: 75,
    availability: "always" as const,
    usage: "/whisper <userId> <text>",
  },
  {
    name: "snapshot-push",
    aliases: ["push-snapshot"],
    description: "Force update the global snapshot with your current local state (master only)",
    category: "collab" as CommandCategory,
    priority: 70,
    availability: "always" as const,
    usage: "/snapshot-push",
  },
  {
    name: "snapshot-pull",
    aliases: ["pull-snapshot"],
    description: "Download the latest session snapshot for reference (read-only)",
    category: "collab" as CommandCategory,
    priority: 68,
    availability: "always" as const,
    usage: "/snapshot-pull",
  },
  {
    name: "snapshot-sync",
    aliases: ["sync-snapshot"],
    description: "Request agentic merge of your changes into the master's snapshot",
    category: "collab" as CommandCategory,
    priority: 65,
    availability: "always" as const,
    usage: "/snapshot-sync <prompt>",
  },
  {
    name: "snapshot-approve",
    aliases: ["approve-snapshot"],
    description: "Accept a proposed snapshot from an attendee (master only)",
    category: "collab" as CommandCategory,
    priority: 62,
    availability: "always" as const,
    usage: "/snapshot-approve <snapshotId>",
  },
  {
    name: "snapshot-reject",
    aliases: ["reject-snapshot"],
    description: "Reject a proposed snapshot from an attendee (master only)",
    category: "collab" as CommandCategory,
    priority: 60,
    availability: "always" as const,
    usage: "/snapshot-reject <reason>",
  },
  {
    name: "snapshot-diff",
    aliases: ["diff-snapshot"],
    description: "Show diff between current snapshot and another",
    category: "collab" as CommandCategory,
    priority: 58,
    availability: "always" as const,
    usage: "/snapshot-diff [<snapshotId>]",
  },
  {
    name: "collab-status",
    aliases: ["cstatus", "cs"],
    description: "Show full collaboration session status with attendee list",
    category: "collab" as CommandCategory,
    priority: 55,
    availability: "always" as const,
    usage: "/collab-status",
  },
  {
    name: "collab-rekey",
    aliases: ["rekey"],
    description: "Generate a new session key and invalidate the old one (master only)",
    category: "collab" as CommandCategory,
    priority: 50,
    availability: "always" as const,
    usage: "/collab-rekey",
  },
] as const satisfies readonly QSlashCommand[];

export type AllSlashCommand = (typeof ALL_SLASH_COMMANDS)[number];
export type AllSlashCommandName = AllSlashCommand["name"];

// ── Category groupings ───────────────────────────────────────────────

export interface CommandCategoryGroup {
  readonly category: CommandCategory;
  readonly label: string;
  readonly icon: string;
}

export const COMMAND_CATEGORIES: readonly CommandCategoryGroup[] = [
  { category: "core", label: "Core Utility & Navigation", icon: "📟" },
  { category: "agent", label: "Agent & Orchestration", icon: "🤖" },
  { category: "memory", label: "Memory & Context", icon: "🧠" },
  { category: "model", label: "Model & Provider", icon: "🔧" },
  { category: "files", label: "Files & Edits", icon: "📁" },
  { category: "replay", label: "Replay & History", icon: "🔄" },
  { category: "system", label: "Configuration & System", icon: "⚙️" },
  { category: "collab", label: "Qollab Collaboration", icon: "🔐" },
];

// ── Lookup helpers ───────────────────────────────────────────────────

/**
 * Find a command by name or alias.
 */
export function findSlashCommand(commandName: string): AllSlashCommand | undefined {
  return ALL_SLASH_COMMANDS.find(
    (cmd) => cmd.name === commandName || (cmd.aliases as readonly string[]).includes(commandName),
  ) as AllSlashCommand | undefined;
}

/**
 * Resolve availability status for a command.
 */
export function resolveSlashCommandAvailability(
  command: AllSlashCommand,
  args: string,
): "always" | "idle-only" {
  const availability = (command as QSlashCommand).availability ?? "idle-only";
  return typeof availability === "function" ? availability(args) : availability;
}

/**
 * Sort commands by priority (descending), then alphabetically.
 */
export function sortSlashCommands(commands: readonly QSlashCommand[]): QSlashCommand[] {
  return [...commands].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name),
  );
}

/**
 * Get commands filtered by category.
 */
export function getCommandsByCategory(category: CommandCategory): QSlashCommand[] {
  return ALL_SLASH_COMMANDS.filter((cmd) => cmd.category === category) as unknown as QSlashCommand[];
}

/**
 * Get Category 1 (Core) commands specifically.
 */
export function getCoreCommands(): readonly QSlashCommand[] {
  return getCommandsByCategory("core");
}