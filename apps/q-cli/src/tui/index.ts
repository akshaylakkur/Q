/**
 * TUI — Terminal User Interface for the Qode Agent.
 *
 * Provides a rich interactive experience with:
 * - Streaming agent output with styled tool call artifacts
 * - File explorer for project navigation
 * - Multi-line input editor with history
 * - Real-time streaming of agent responses
 * - Full slash command suite (40+ commands across 7 categories)
 * - Interactive help dashboard with command search
 * - Rich status dashboard with context window visualization
 */

export { QTui as VTui, startTui } from "./v-tui.js";
export type { TuiOptions, TuiAppState, ColorPalette, TranscriptEntry, AgentEvent } from "./types.js";
export { DEFAULT_COLORS } from "./types.js";
export { createMarkdownTheme, createDefaultTextStyle } from "./theme.js";

// Slash command system exports
export {
  dispatchInput,
  parseSlashInput,
  findSlashCommand,
  sortSlashCommands,
  ALL_SLASH_COMMANDS,
  type SlashCommandHost,
  type QSlashCommand,
  type ParsedSlashInput,
  type CommandCategory,
  type SlashCommandAvailability,
} from "./commands/index.js";
