/**
 * Types — Slash command type definitions for the Qode TUI
 */

import type { SlashCommand } from "@earendil-works/pi-tui";

/**
 * Availability of a slash command — some commands only work when idle,
 * others are always available.
 */
export type SlashCommandAvailability = "always" | "idle-only";

/**
 * A slash command definition with metadata for autocomplete and help.
 */
export interface QSlashCommand<Name extends string = string> extends SlashCommand {
  readonly name: Name;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly category: CommandCategory;
  readonly priority?: number;
  readonly availability?: SlashCommandAvailability | ((args: string) => SlashCommandAvailability);
  readonly usage?: string;
}

/**
 * Command categories for the help panel grouping.
 */
export type CommandCategory =
  | "core"          // Category 1: Core utility & navigation
  | "agent"         // Category 2: Agent & orchestration
  | "memory"        // Category 3: Memory & context
  | "model"         // Category 4: Model & provider
  | "files"         // Category 5: Files & edits
  | "replay"        // Category 6: Replay & history
  | "system"        // Category 7: Configuration & system
  | "collab";       // Category 8: Qollab collaboration

/**
 * A parsed slash input.
 */
export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

/**
 * Reasons a slash command might be blocked.
 */
export type SlashCommandBusyReason = "streaming" | "compacting";
export type SlashCommandInvalidReason = "unknown";

/**
 * Host interface — what command handlers get access to.
 * This is implemented by the VTui class and passed to dispatch.
 */
export interface SlashCommandHost {
  // Core state
  readonly appState: {
    workDir: string;
    sessionId: string;
    model: string;
    version: string;
    permissionMode: string;
    planMode: boolean;
    streamingPhase: string;
    isCompacting: boolean;
    isReplaying: boolean;
    contextTokens: number;
    maxContextTokens: number;
    executionMode: string;
    /** Current active agent profile name (editius, rewritius, searchius, auto) */
    activeAgent: string;
    /** Whether collaboration mode is active */
    isCollab?: boolean;
    /** Current user's role in collaboration */
    collabRole?: "master" | "attendee";
    /** Number of attendees */
    collabAttendeeCount?: number;
    /** Pending admission requests count */
    collabPendingCount?: number;
  };

  // Agent access
  readonly agent: {
    config: {
      update(cfg: Record<string, unknown>): void;
      model: string;
    };
    permission: {
      setMode(mode: string): void;
    };
    context: {
      messages: unknown[];
    };
    /** Apply a named agent profile to the active agent */
    applyProfile?(profileName: string): void;
    /** Run a single-turn generation with the agent and return the response text */
    runGeneration?(prompt: string, systemReminder?: string): Promise<string>;
  };

  // Orchestrator access (for mode switching etc.)
  readonly orchestrator?: {
    setCurrentMode(mode: string): void;
    getCurrentMode(): string;
  };

  // UI feedback
  showStatus(message: string, colorOrType?: string): void;
  showError(message: string): void;
  showNotice(title: string, detail?: string): void;

  // Session management
  clearTranscript(): void;
  stop(exitCode?: number): Promise<void>;

  // Dialog management
  showHelpPanel(): void;
  showStatusDashboard(): void;

  // Tracking / telemetry
  track(event: string, props?: Record<string, unknown>): void;

  // Render
  requestRender(): void;

  // ── Qollab Collaboration ──────────────────────────────────────────
  /** Send a chat message to all session participants */
  collabSendChat?(text: string): void;
  /** Send a whisper to a specific user */
  collabSendWhisper?(userId: string, text: string): void;
  /** Admit a pending attendee (master only) */
  collabAdmit?(userId: string): void;
  /** Reject a pending attendee (master only) */
  collabReject?(userId: string, reason?: string): void;
  /** Kick an attendee (master only) */
  collabKick?(userId: string): void;
  /** Request snapshot pull */
  collabSnapshotPull?(): void;
  /** Request snapshot sync with prompt */
  collabSnapshotSync?(prompt: string): void;
  /** Approve a proposed snapshot (master only) */
  collabSnapshotApprove?(snapshotId: string): void;
  /** Reject a proposed snapshot (master only) */
  collabSnapshotReject?(reason: string): void;
  /** Push current state as new snapshot (master only) */
  collabSnapshotPush?(): void;
  /** Show collab status */
  collabShowStatus?(): void;
}
