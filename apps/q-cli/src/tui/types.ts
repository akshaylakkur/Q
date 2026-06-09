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
  };
}

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