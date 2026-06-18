/**
 * Record types — Discriminated union for the JSONL wire format.
 *
 * Each record has a `type` field used as the discriminator.
 */

/** Protocol version constant */
export const CURRENT_WIRE_VERSION = 1;

// ---------------------------------------------------------------------------
// Record type discriminators
// ---------------------------------------------------------------------------

export type RecordType =
  | "metadata"
  | "turn.prompt"
  | "turn.steer"
  | "turn.cancel"
  | "config.update"
  | "permission.set_mode"
  | "permission.record_approval_result"
  | "full_compaction.begin"
  | "full_compaction.cancel"
  | "full_compaction.complete"
  | "plan_mode.enter"
  | "plan_mode.cancel"
  | "plan_mode.exit"
  | "context.append_message"
  | "context.mark_last_user_prompt_blocked"
  | "context.append_loop_event"
  | "context.clear"
  | "context.apply_compaction"
  | "tools.register_user_tool"
  | "tools.unregister_user_tool"
  | "tools.set_active_tools"
  | "tools.update_store"
  | "background.stop"
  | "usage.record"
  | "correction.attempt";

/** Union discriminator base */
export interface RecordBase {
  type: RecordType;
  timestamp: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Individual record shapes
// ---------------------------------------------------------------------------

export interface MetadataRecord extends RecordBase {
  type: "metadata";
  protocolVersion: number;
  createdAt: string;
  model?: string;
  sessionName?: string;
}

export interface TurnPromptRecord extends RecordBase {
  type: "turn.prompt";
  turnId: string;
  prompt: string;
  mode?: string;
  provider?: string;
  model?: string;
}

export interface TurnSteerRecord extends RecordBase {
  type: "turn.steer";
  turnId: string;
  steer: string;
  mode?: string;
}

export interface TurnCancelRecord extends RecordBase {
  type: "turn.cancel";
  turnId: string;
  reason?: string;
}

export interface ConfigUpdateRecord extends RecordBase {
  type: "config.update";
  key: string;
  value: unknown;
  previousValue?: unknown;
}

export interface PermissionSetModeRecord extends RecordBase {
  type: "permission.set_mode";
  mode: string;
}

export interface PermissionRecordApprovalResultRecord extends RecordBase {
  type: "permission.record_approval_result";
  toolCallId: string;
  toolName: string;
  approved: boolean;
  reason?: string;
}

export interface FullCompactionBeginRecord extends RecordBase {
  type: "full_compaction.begin";
  sourceTurnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface FullCompactionCancelRecord extends RecordBase {
  type: "full_compaction.cancel";
  reason?: string;
}

export interface FullCompactionCompleteRecord extends RecordBase {
  type: "full_compaction.complete";
  compactionId: string;
  originalRecordCount: number;
  compactedRecordCount: number;
}

export interface PlanModeEnterRecord extends RecordBase {
  type: "plan_mode.enter";
  provider?: string;
  model?: string;
}

export interface PlanModeCancelRecord extends RecordBase {
  type: "plan_mode.cancel";
  reason?: string;
}

export interface PlanModeExitRecord extends RecordBase {
  type: "plan_mode.exit";
}

export interface ContextAppendMessageRecord extends RecordBase {
  type: "context.append_message";
  messageIds?: string[];
  role?: string;
  content?: string;
}

export interface ContextMarkLastUserPromptBlockedRecord extends RecordBase {
  type: "context.mark_last_user_prompt_blocked";
  reason?: string;
}

export interface ContextAppendLoopEventRecord extends RecordBase {
  type: "context.append_loop_event";
  event: string;
  data?: unknown;
}

export interface ContextClearRecord extends RecordBase {
  type: "context.clear";
}

export interface ContextApplyCompactionRecord extends RecordBase {
  type: "context.apply_compaction";
  compactionId: string;
  prunedMessageCount: number;
}

export interface ToolsRegisterUserToolRecord extends RecordBase {
  type: "tools.register_user_tool";
  toolName: string;
  toolSpec: unknown;
}

export interface ToolsUnregisterUserToolRecord extends RecordBase {
  type: "tools.unregister_user_tool";
  toolName: string;
}

export interface ToolsSetActiveToolsRecord extends RecordBase {
  type: "tools.set_active_tools";
  toolNames: string[];
}

export interface ToolsUpdateStoreRecord extends RecordBase {
  type: "tools.update_store";
  store: string;
  key: string;
  value?: unknown;
}

export interface BackgroundStopRecord extends RecordBase {
  type: "background.stop";
  backgroundTaskId: string;
  reason?: string;
}

export interface UsageRecordRecord extends RecordBase {
  type: "usage.record";
  tokenType: string;
  count: number;
  model?: string;
  provider?: string;
}

export interface CorrectionAttemptRecord extends RecordBase {
  type: "correction.attempt";
  /** The diagnostic that triggered the correction. */
  diagnosticId: string;
  /** The gate that produced the diagnostic (syntax, lint, typecheck, etc.). */
  gateName: string;
  /** The handler/profile used for the correction. */
  handler: string;
  /** Human-readable summary of what was attempted. */
  attemptedFixSummary: string;
  /** Outcome of the correction. */
  outcome: "fixed" | "failed" | "skipped";
  /** Duration of the correction attempt in ms. */
  durationMs: number;
  /** File path(s) that were changed. */
  changedFiles: string[];
  /** The original error message. */
  errorMessage: string;
  /** Line number of the error (1-based). */
  line: number;
  /** Column number of the error (1-based). */
  column: number;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type SessionRecord =
  | MetadataRecord
  | TurnPromptRecord
  | TurnSteerRecord
  | TurnCancelRecord
  | ConfigUpdateRecord
  | PermissionSetModeRecord
  | PermissionRecordApprovalResultRecord
  | FullCompactionBeginRecord
  | FullCompactionCancelRecord
  | FullCompactionCompleteRecord
  | PlanModeEnterRecord
  | PlanModeCancelRecord
  | PlanModeExitRecord
  | ContextAppendMessageRecord
  | ContextMarkLastUserPromptBlockedRecord
  | ContextAppendLoopEventRecord
  | ContextClearRecord
  | ContextApplyCompactionRecord
  | ToolsRegisterUserToolRecord
  | ToolsUnregisterUserToolRecord
  | ToolsSetActiveToolsRecord
  | ToolsUpdateStoreRecord
  | BackgroundStopRecord
  | UsageRecordRecord
  | CorrectionAttemptRecord;

// ---------------------------------------------------------------------------
// Session metadata (stored in index.json)
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  workspaceDirectory?: string;
  model?: string;
  protocolVersion: number;
  recordCount: number;
  blobCount: number;
  sizeBytes: number;
}

export interface SessionIndex {
  version: number;
  sessions: Record<string, SessionMeta>;
}

// ---------------------------------------------------------------------------
// Session config
// ---------------------------------------------------------------------------

export interface SessionConfig {
  name: string;
  workspaceDirectory?: string;
  model?: string;
}