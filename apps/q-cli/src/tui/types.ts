/**
 * TUI Types — Shared types for the Qode TUI system.
 */

import type { Agent } from "@q/agent-core";

// ── App State ──────────────────────────────────────────────────────────

export interface TuiAppState {
  workDir: string;
  sessionId: string;
  model: string;
  version: string;
  permissionMode: "manual" | "yolo" | "auto";
  planMode: boolean;
  thinking: boolean;
  streamingPhase: "idle" | "waiting" | "thinking" | "composing" | "tool";
  streamingStartTime: number;
  contextTokens: number;
  maxContextTokens: number;
  contextUsage: number;
  isCompacting: boolean;
  isReplaying: boolean;
  /** Current orchestrator execution mode (user-facing name) */
  executionMode: string;
  /** Whether we are in modus-maximus confirmation phase */
  modusMaximusPhase: "idle" | "planning" | "confirming" | "executing" | "summarizing";
  /** Campaign mode: percentage of campaign completion (0-100) */
  campaignProgress?: number;
  /** Campaign mode: current phase name */
  campaignPhase?: string;
  /** Campaign mode: total sub-tasks in the campaign */
  campaignSubTaskCount?: number;
  /** Campaign mode: completed sub-tasks */
  campaignCompletedCount?: number;
  /** Campaign mode: convergence cycles completed */
  campaignConvergenceCount?: number;
  /** Campaign mode: gate status for medium-campaign (e.g. "pass", "fail", "pending") */
  campaignGateStatus?: string;
  /** Campaign mode: total files changed in high-campaign */
  campaignFilesChanged?: number;
  /** Campaign mode: verification status for high-campaign (e.g. "passing", "failing", "running") */
  campaignVerificationStatus?: string;
}

// ── Transcript Entries ─────────────────────────────────────────────────

export type TranscriptEntryKind =
  | "welcome"
  | "user"
  | "assistant"
  | "tool_call"
  | "thinking"
  | "status"
  | "error";

export interface ToolCallBlockData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  result?: ToolResultBlockData;
  step?: number;
  turnId?: string;
  truncated?: boolean;
  streamingArguments?: string;
  streamingStartedAtMs?: number;
}

export interface ToolResultBlockData {
  tool_call_id: string;
  output: string;
  is_error?: boolean;
  synthetic?: boolean;
}

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  turnId?: string;
  renderMode: "markdown" | "plain" | "notice";
  content: string;
  color?: string;
  detail?: string;
  toolCallData?: ToolCallBlockData;
}

// ── File Explorer ─────────────────────────────────────────────────────

export interface FileExplorerNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: FileExplorerNode[];
  modified?: boolean;
  expanded?: boolean;
}

// ── Modus Maximus Types ─────────────────────────────────────────────

export interface ModusMaximusStepInfo {
  stepIndex: number;
  stepTitle: string;
  instructions: string;
}

export type ConfirmationChoice = "looks-good" | "needs-revision" | "redo";

export interface ConfirmationResponse {
  choice: ConfirmationChoice;
  revisionText?: string;
}

export interface StepAgentResult {
  stepIndex: number;
  summary: string;
  usage: { promptTokens: number; completionTokens: number };
  success: boolean;
  changedFiles: string[];
}

// ── Agent Events (mapped from agent-core types) ───────────────────────

export interface AgentEvent {
  type: string;
  turnId?: number;
  delta?: string;
  toolCallId?: string;
  name?: string;
  args?: unknown;
  argumentsPart?: string;
  description?: string;
  output?: string;
  isError?: boolean;
  update?: unknown;
  step?: number;
  stepId?: string;
  usage?: unknown;
  finishReason?: string;
  reason?: string;
  message?: string;
  error?: string;
  origin?: string;

  // Modus Maximus fields
  planFilePath?: string;
  stepCount?: number;
  stepIndex?: number;
  stepTitle?: string;
  instructions?: string;
  stepInfo?: ModusMaximusStepInfo;
  totalSteps?: number;
  completedSteps?: number;
  failedSteps?: number;
  summary?: string;
  changedFiles?: string[];
  tokenUsage?: { promptTokens: number; completionTokens: number };
  planContent?: string;
  choice?: ConfirmationChoice;
  revisionText?: string;
  sessionId?: string;
}

// ── TUI Options ────────────────────────────────────────────────────────

export interface TuiOptions {
  agent: Agent;
  workDir: string;
  sessionId: string;
  model: string;
  version: string;
  permissionMode: "manual" | "yolo" | "auto";
  planMode: boolean;
  yolo: boolean;
  auto: boolean;
  /** Optional orchestrator reference for mode switching etc. */
  orchestrator?: {
    setCurrentMode(mode: string): void;
    getCurrentMode(): string;
    resolveModusMaximusConfirmation?(response: { choice: ConfirmationChoice; revisionText?: string }): void;
    /**
     * Submit a prompt through the orchestrator for mode-aware execution.
     * When in modus-maximus mode, this triggers the full pipeline.
     * Returns the execution result.
     */
    submitPrompt?(prompt: string): Promise<ExecutionResult>;
    /** Cancel the current orchestration (aborts modus-maximus pipeline) */
    cancel?(): void;
  };
}

// Import ExecutionResult type for the orchestrator interface
import type { ExecutionResult } from "../orchestrator/modes/types.js";

// ── Theme Colors ───────────────────────────────────────────────────────

export interface ColorPalette {
  primary: string;
  secondary: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  text: string;
  textDim: string;
  textBright: string;
  border: string;
  background: string;
  surface: string;
  accent: string;

  // Role-specific
  roleUser: string;
  roleAssistant: string;
  roleTool: string;

  // Diff colors
  diffAdded: string;
  diffAddedStrong: string;
  diffRemoved: string;
  diffRemovedStrong: string;
  diffGutter: string;
  diffMeta: string;

  // Code
  codeHighlight: string;
  codeText: string;

  // Status
  statusInfo: string;
  statusSuccess: string;
  statusWarning: string;
  statusError: string;
}

/** Modus maximus mode constants */
export const MODUS_MAXIMUS_DIR = ".Q/modes/modus-maximus";

export const DEFAULT_COLORS: ColorPalette = {
  primary: "#06B6D4",
  secondary: "#8B5CF6",
  success: "#22C55E",
  warning: "#F59E0B",
  error: "#EF4444",
  info: "#3B82F6",
  text: "#E2E8F0",
  textDim: "#94A3B8",
  textBright: "#F8FAFC",
  border: "#334155",
  background: "#0F172A",
  surface: "#1E293B",
  accent: "#A78BFA",
  roleUser: "#22D3EE",
  roleAssistant: "#A78BFA",
  roleTool: "#F59E0B",
  diffAdded: "#4ADE80",
  diffAddedStrong: "#22C55E",
  diffRemoved: "#FB7185",
  diffRemovedStrong: "#EF4444",
  diffGutter: "#475569",
  diffMeta: "#64748B",
  codeHighlight: "#2D3748",
  codeText: "#E2E8F0",
  statusInfo: "#38BDF8",
  statusSuccess: "#4ADE80",
  statusWarning: "#FBBF24",
  statusError: "#F87171",
};