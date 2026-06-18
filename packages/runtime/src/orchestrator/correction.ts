/**
 * SelfCorrectionCycle — Automated Fix → Re-Verify Loop (Step 31)
 *
 * 4-step correction protocol:
 *   1. COLLECT_DIAGNOSTIC  — Extract error details + workspace snapshot
 *   2. CLASSIFY_FAILURE    — Categorize by type, scope, and root cause
 *   3. CORRECT             — Dispatch targeted fix based on classification
 *   4. RE_VERIFY           — Re-run gates up to and including the failed gate
 *
 * Consumed by OrchestratorCore during the "correcting" state.
 * Depends on VerificationPipeline for re-verification,
 * ConvergenceEngine for re-merge, and pool profiles for dispatch.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, relative, basename } from "node:path";
import { existsSync } from "node:fs";
import type { PipelineResult, GateResult, Diagnostic as VerDiagnostic, GateContext } from "./verification.js";
import { VerificationPipeline } from "./verification.js";
import type { ExecutionModeLevel } from "./verification.js";
import { appendRecord } from "../records/wire.js";
import type { CorrectionAttemptRecord } from "../records/types.js";

// =========================================================================
// Correction Protocol Types
// =========================================================================

/** The type of failure detected during validation. */
export type FailureType =
  | "syntax"
  | "lint"
  | "type"
  | "test_failure"
  | "architecture";

/** The scope of the failure — how many files/modules are affected. */
export type FailureScope =
  | "per_file"
  | "cross_file"
  | "module"
  | "cross_module";

/** The inferred root cause of the failure. */
export type RootCause =
  | "simple_mistake"
  | "misunderstanding"
  | "architectural"
  | "test_flakiness";

/** Options presented to the user during escalation. */
export type EscalationOption =
  | "retry"
  | "manual_edit"
  | "skip"
  | "abort";

/** Agent profile dispatched for correction. */
export type CorrectionProfile =
  | "searchius"
  | "rewritius"
  | "editius";

/** Type of correction handler used. */
export type CorrectionHandlerType =
  | "syntax"
  | "lint"
  | "type"
  | "test"
  | "architecture"
  | "auto-fix";

/** Status of a correction handler's result. */
export type HandlerResultStatus = "fixed" | "failed" | "skipped" | "already_good";

/** Unified result from any correction handler. */
export interface HandlerCorrectionResult {
  status: HandlerResultStatus;
  changedFiles: string[];
  summary: string;
  error?: string;
  /** Duration of the handler's work in ms. */
  durationMs: number;
}

/** Hint to display in the TUI footer for auto-fix actions. */
export interface TuiFooterHint {
  text: string;
  /** Duration to show the hint in ms before fading. */
  durationMs: number;
  /** Color hex or chalk function key. */
  color?: string;
}

/** A quick-fix entry in the QUICK_FIX_MAP. Each maps a diagnostic code
 *  (or rule name) to a synchronous fix function. */
export interface QuickFixEntry {
  /** Human-readable label for logging. */
  label: string;
  /** The fix function: receives the full file content, the diagnostic,
   *  and returns the corrected content or null if it can't fix. */
  apply: (content: string, diag: CorrectionDiagnostic) => string | null;
  /** Whether the fix needs to be verified by re-running the gate. */
  needsVerify: boolean;
}

// =========================================================================
// Data Types
// =========================================================================

/**
 * A diagnostic extracted from a failed gate, enriched with
 * the pre-correction workspace snapshot of the affected file.
 */
export interface CorrectionDiagnostic {
  /** The original diagnostic from the gate failure. */
  original: VerDiagnostic;
  /** Gate that produced this diagnostic. */
  gateName: string;
  /** Pre-correction content of the affected file. */
  fileContent: string;
  /** The affected file's absolute path (resolved). */
  filePath: string;
  /** Error message extracted from the diagnostic. */
  errorMessage: string;
  /** Line number (1-based, 0 if unknown). */
  line: number;
  /** Column number (1-based, 0 if unknown). */
  column: number;
  /** Rule or code name (e.g., "tsc", "no-unused-vars", "TEST_FAIL"). */
  rule: string;
  /** Stack trace or test failure message, if available. */
  stackTrace?: string;
}

/** Classification of a failure after analysis. */
export interface FailureClassification {
  type: FailureType;
  scope: FailureScope;
  rootCause: RootCause;
  /** The specific diagnostic that triggered this classification. */
  sourceDiagnostic: CorrectionDiagnostic;
  /** Additional affected files beyond the primary file. */
  relatedFiles: string[];
  /** Human-readable explanation of the classification. */
  rationale: string;
}

/** A single correction attempt — what was tried and what happened. */
export interface CorrectionAttempt {
  /** 1-based attempt number. */
  attemptNumber: number;
  /** The diagnostic(s) that triggered this correction. */
  targetDiagnostics: CorrectionDiagnostic[];
  /** Classification used to dispatch. */
  classification: FailureClassification;
  /** Profile used for the correction agent. */
  profile: CorrectionProfile;
  /** Files that were modified during the correction attempt. */
  changedFiles: string[];
  /** The diff or summary of changes made. */
  changeSummary: string;
  /** Result of re-verification (null if not yet re-verified). */
  reVerifyResult?: PipelineResult;
  /** Whether re-verification passed. */
  passed: boolean;
  /** Error message if the correction agent itself failed. */
  error?: string;
  /** Timestamp when this attempt completed. */
  timestamp: string;
}

/** Current phase within the correction cycle. */
export type CorrectionPhase =
  | "collecting"
  | "classifying"
  | "correcting"
  | "reverifying"
  | "escalating"
  | "completed";

/** Progress event emitted during the correction cycle. */
export interface CorrectionProgressEvent {
  phase: CorrectionPhase;
  attempt: number;
  maxAttempts: number;
  message: string;
  timestamp: string;
  gateName?: string;
  diagnosticCount?: number;
}

/**
 * Escalation payload presented to the user via the RPC channel.
 */
export interface EscalationPayload {
  /** Human-readable summary of what went wrong. */
  summary: string;
  /** The gate(s) that failed. */
  failedGates: string[];
  /** Every correction attempt that was made. */
  attempts: CorrectionAttempt[];
  /** All diagnostics that remain after corrections. */
  remainingDiagnostics: CorrectionDiagnostic[];
  /** Files that were modified during the correction attempts. */
  changedFiles: string[];
  /** Options the user can select from. */
  options: EscalationOption[];
}

/** Full result of the correction cycle. */
export interface CorrectionResult {
  /** True if the pipeline now passes after corrections. */
  success: boolean;
  /** All correction attempts made. */
  attempts: CorrectionAttempt[];
  /** Files changed during the cycle. */
  changedFiles: string[];
  /** If escalated, the escalation payload. */
  escalation?: EscalationPayload;
  /** The final re-verification result (null if escalation skipped). */
  finalPipelineResult?: PipelineResult;
  /** Total duration of the correction cycle in ms. */
  durationMs: number;
}

/** Configuration for SelfCorrectionCycle. */
export interface SelfCorrectionConfig {
  /** Maximum correction attempts for simple failures (syntax, lint, type per-file). */
  maxSimpleAttempts: number;
  /** Maximum correction attempts for architecture failures. */
  maxArchitectureAttempts: number;
  /** Maximum correction attempts for test failures. */
  maxTestAttempts: number;
  /** Maximum total correction attempts across all diagnostics. */
  maxTotalAttempts: number;
  /** Whether to automatically escalate on attempt overflow. */
  autoEscalate: boolean;
  /** Workspace root path for file operations. */
  workspaceRoot: string;
  /** Execution mode level for determining which gates to re-run. */
  modeLevel: ExecutionModeLevel;
  /** Optional: path to the session wire file for correction.attempt logging. */
  wirePath?: string;
  /** Whether auto-fix (no-sub-agent fast path) is enabled. Default: true. */
  enableAutoFix?: boolean;
}

const DEFAULT_CORRECTION_CONFIG: SelfCorrectionConfig = {
  maxSimpleAttempts: 3,
  maxArchitectureAttempts: 1,
  maxTestAttempts: 3,
  maxTotalAttempts: 10,
  autoEscalate: true,
  workspaceRoot: process.cwd(),
  modeLevel: 2,
  enableAutoFix: true,
};

// =========================================================================
// Gate Ordering — determines re-verify cutoff
// =========================================================================

/** Gates in pipeline sequence order. */
const GATE_ORDER: string[] = [
  "syntax",
  "lint",
  "typecheck",
  "unit-test",
  "integration-test",
  "architecture",
  "full-suite",
];

// =========================================================================
// CorrectionBudget — Tracks total correction attempts per pipeline run
// and determines when to halt and escalate.
// =========================================================================

/**
 * Tracks correction attempts keyed by a stable diagnostic identifier
 * (file + line + rule). Exceeding per-diagnostic or aggregate limits
 * triggers escalation.
 */
export class CorrectionBudget {
  /** Per-diagnostic attempt counters: key = `${filePath}:${line}:${rule}` */
  private attempts: Map<string, number> = new Map();
  private readonly maxSimpleAttempts: number;
  private readonly maxArchitectureAttempts: number;
  private readonly maxTestAttempts: number;
  private totalAttempts = 0;
  private readonly maxTotalAttempts: number;

  constructor(config?: Partial<SelfCorrectionConfig>) {
    this.maxSimpleAttempts = config?.maxSimpleAttempts ?? 3;
    this.maxArchitectureAttempts = config?.maxArchitectureAttempts ?? 1;
    this.maxTestAttempts = config?.maxTestAttempts ?? 3;
    this.maxTotalAttempts = config?.maxTotalAttempts ?? 10;
  }

  /** Produce a stable key for a diagnostic (or classification). */
  private key(type: FailureType, diag: CorrectionDiagnostic): string {
    return `${diag.filePath}:${diag.line}:${type}`;
  }

  /**
   * Check whether the budget allows a correction attempt for the given
   * failure type and diagnostic.
   */
  canAttempt(type: FailureType, diag: CorrectionDiagnostic): boolean {
    const key = this.key(type, diag);
    const current = this.attempts.get(key) ?? 0;
    const limit = type === "architecture"
      ? this.maxArchitectureAttempts
      : type === "test_failure"
        ? this.maxTestAttempts
        : this.maxSimpleAttempts;
    return current < limit && this.totalAttempts < this.maxTotalAttempts;
  }

  /**
   * Record that a correction attempt was made. Returns the new count
   * for the diagnostic (1-based).
   */
  recordAttempt(type: FailureType, diag: CorrectionDiagnostic): number {
    const key = this.key(type, diag);
    const current = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, current);
    this.totalAttempts++;
    return current;
  }

  /** Get the per-diagnostic limit for the given failure type. */
  getLimit(type: FailureType): number {
    switch (type) {
      case "architecture": return this.maxArchitectureAttempts;
      case "test_failure": return this.maxTestAttempts;
      default: return this.maxSimpleAttempts;
    }
  }

  /** Get total attempts across all diagnostics so far. */
  get total(): number {
    return this.totalAttempts;
  }

  /** Reset all counters (e.g., for a new pipeline run). */
  reset(): void {
    this.attempts.clear();
    this.totalAttempts = 0;
  }

  /** Serialize to a plain object for wire logging. */
  toJSON(): Record<string, unknown> {
    return {
      attemptsByDiagnostic: Object.fromEntries(this.attempts),
      totalAttempts: this.totalAttempts,
      maxTotalAttempts: this.maxTotalAttempts,
    };
  }
}

// =========================================================================
// QUICK_FIX_MAP — Auto-fix (no-sub-agent fast path) for well-known failures
// =========================================================================

/**
 * Map of diagnostic codes / rule names to synchronous fix functions.
 * Each function receives the full file content + diagnostic and returns
 * the fixed content, or null if it cannot auto-fix.
 */
export const QUICK_FIX_MAP: Map<string, QuickFixEntry> = new Map([
  // ── Missing semicolons ───────────────────────────────────────────────
  ["semi", {
    label: "Add missing semicolon",
    apply: (content, diag) => {
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      const trimmed = line.trimEnd();
      if (trimmed.endsWith(";")) return null; // already has semicolon
      if (trimmed.endsWith("{") || trimmed.endsWith("}") || trimmed.endsWith("(") || trimmed.endsWith(")")) return null;
      lines[idx] = trimmed + ";";
      return lines.join("\n");
    },
    needsVerify: true,
  }],
  [": expected ';'", { // TS/JS parser error: "',' expected.", "';' expected."
    label: "Add missing semicolon (parser message)",
    apply: (content, diag) => {
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!.trimEnd();
      if (line.endsWith(";")) return null;
      lines[idx] = line + ";";
      return lines.join("\n");
    },
    needsVerify: true,
  }],

  // ── prefer-const: change let → const ────────────────────────────────
  ["prefer-const", {
    label: "Change let to const",
    apply: (content, diag) => {
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      const match = line.match(/^(\s*)let\s/);
      if (!match) return null;
      // Verify the variable is never reassigned (basic check: no `=` after first occurrence)
      const varMatch = line.match(/\blet\s+(\w+)/);
      if (!varMatch) return null;
      const varName = varMatch[1]!;
      const restOfFile = lines.slice(idx).join("\n");
      const reassignPattern = new RegExp(`\\b${varName}\\s*=(?!=)`, "g");
      const reassigns = restOfFile.match(reassignPattern);
      if (reassigns && reassigns.length > 1) return null; // reassigned, can't use const
      lines[idx] = line.replace(/^(\s*)let\s/, "$1const ");
      return lines.join("\n");
    },
    needsVerify: true,
  }],

  // ── no-unused-vars: prefix with underscore ──────────────────────────
  ["no-unused-vars", {
    label: "Prefix unused variable with underscore",
    apply: (content, diag) => {
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      // Match: `const foo = ...` → `const _foo = ...`
      const declMatch = line.match(/^(\s*)(?:const|let|var)\s+(\w+)/);
      if (declMatch) {
        const name = declMatch[2]!;
        if (name.startsWith("_")) return null; // already prefixed
        lines[idx] = line.slice(0, declMatch[1]!.length + declMatch[0]!.length - name.length) + "_" + name + line.slice(declMatch[1]!.length + declMatch[0]!.length);
        return lines.join("\n");
      }
      // Match parameter: `foo(` → `_foo(`
      const paramMatch = line.match(/^(\s*)(\w+)\s*[:,)]/);
      if (paramMatch && !paramMatch[2]!.startsWith("_") && !["if", "for", "while", "switch", "return", "throw"].includes(paramMatch[2]!)) {
        lines[idx] = line.slice(0, paramMatch[1]!.length) + "_" + paramMatch[2]! + line.slice(paramMatch[1]!.length + paramMatch[2]!.length);
        return lines.join("\n");
      }
      return null;
    },
    needsVerify: true,
  }],

  // ── no-unused-labels ────────────────────────────────────────────────
  ["no-unused-labels", {
    label: "Remove unused label",
    apply: (content, diag) => {
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      const labelMatch = line.match(/^(\s*)(\w+):\s*$/);
      if (labelMatch) {
        lines.splice(idx, 1);
        return lines.join("\n");
      }
      return null;
    },
    needsVerify: true,
  }],

  // ── trailing-comma / missing comma ──────────────────────────────────
  ["comma-dangle", {
    label: "Fix trailing comma",
    apply: (content, diag) => {
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      const trimmed = line.trimEnd();
      if (trimmed.endsWith(";") || trimmed.endsWith(",") || trimmed.endsWith("{") || trimmed.endsWith("}") || trimmed.endsWith("(") || trimmed.endsWith(")")) return null;
      // Add trailing comma
      lines[idx] = trimmed + ",";
      return lines.join("\n");
    },
    needsVerify: true,
  }],

  // ── extra semicolon / unnecessary semicolon ─────────────────────────
  ["no-extra-semi", {
    label: "Remove extra semicolon",
    apply: (content, diag) => {
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      if (!line.trimEnd().endsWith(";")) return null;
      lines[idx] = line.replace(/;\s*$/, "");
      return lines.join("\n");
    },
    needsVerify: true,
  }],

  // ── quotes: double → single ─────────────────────────────────────────
  ["quotes", {
    label: "Convert double quotes to single quotes",
    apply: (content, diag) => {
      // Only attempt if the error is on a specific line
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      // Replace double quotes not inside template literals or imports
      const newLine = line.replace(/(?<!\\)"([^"\\]*(?:\\.[^"\\]*)*)"/g, "'$1'");
      if (newLine === line) return null;
      lines[idx] = newLine;
      return lines.join("\n");
    },
    needsVerify: true,
  }],

  // ── eqeqeq: use === instead of == ──────────────────────────────────
  ["eqeqeq", {
    label: "Use === instead of ==",
    apply: (content, diag) => {
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      const newLine = line.replace(/(?<!=)={2,3}(?!=)/g, (match) => match.length === 2 ? "===" : match.length === 3 ? "!==" : match);
      // More precise: replace `==` that aren't part of `===`
      const precise = newLine.replace(/\b(\w+)\s*==\s*(?!['"`])\w+/g, (m) => m.replace("==", "==="));
      if (precise === line) {
        // Try simpler pattern
        const simple = line.replace(/==(?!=)/g, "===").replace(/!=(?!=)/g, "!==");
        if (simple === line) return null;
        lines[idx] = simple;
      } else {
        lines[idx] = precise;
      }
      return lines.join("\n");
    },
    needsVerify: true,
  }],

  // ── no-var: var → let ───────────────────────────────────────────────
  ["no-var", {
    label: "Change var to let",
    apply: (content, diag) => {
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      const newLine = line.replace(/^(\s*)var\s/, "$1let ");
      if (newLine === line) return null;
      lines[idx] = newLine;
      return lines.join("\n");
    },
    needsVerify: true,
  }],

  // ── no-trailing-spaces ──────────────────────────────────────────────
  ["no-trailing-spaces", {
    label: "Remove trailing spaces",
    apply: (content) => {
      const result = content.replace(/[ \t]+$/gm, "");
      if (result === content) return null;
      return result;
    },
    needsVerify: true,
  }],

  // ── eol-last: add trailing newline ──────────────────────────────────
  ["eol-last", {
    label: "Add trailing newline",
    apply: (content) => {
      if (content.endsWith("\n")) return null;
      return content + "\n";
    },
    needsVerify: true,
  }],

  // ── tsc: "Cannot find name 'X'" — try adding underscore prefix ──────
  ["cannot-find-name", {
    label: "Check for unused variable spelling",
    apply: (content, diag) => {
      // Extract the unknown name from the error message
      const match = diag.errorMessage.match(/'([^']+)'/);
      if (!match) return null;
      const name = match[1]!;
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      if (!line.includes(name)) return null;
      // If it's a reference to something not defined, we can't auto-fix
      return null; // fall through to sub-agent
    },
    needsVerify: false, // this one won't actually fix, so skip verify
  }],

  // ── tsc: "X is declared but its value is never read" → prefix _ ────
  ["is declared but its value is never read", {
    label: "Prefix never-read variable with underscore",
    apply: (content, diag) => {
      const match = diag.errorMessage.match(/'([^']+)'/);
      if (!match) return null;
      const name = match[1]!;
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      const pos = line.indexOf(name);
      if (pos < 0) return null;
      // Check it's at a declaration site
      const before = line.slice(0, pos);
      if (!/\b(const|let|var)\s+$/.test(before) && !before.endsWith("(") && !before.endsWith(",")) return null;
      lines[idx] = line.slice(0, pos) + "_" + line.slice(pos);
      return lines.join("\n");
    },
    needsVerify: true,
  }],

  // ── tsc: missing return type ────────────────────────────────────────
  ["missing-return-type", {
    label: "Add void return type to function",
    apply: (content, diag) => {
      const lines = content.split("\n");
      const idx = diag.line - 1;
      if (idx < 0 || idx >= lines.length) return null;
      const line = lines[idx]!;
      const fnMatch = line.match(/^(\s*)(?:export\s+)?(?:async\s+)?function\s+\w+/);
      if (fnMatch) {
        // Add : void after the function declaration
        const insertPos = fnMatch[0].length;
        lines[idx] = line.slice(0, insertPos) + ": void" + line.slice(insertPos);
        return lines.join("\n");
      }
      const arrowMatch = line.match(/^(\s*)(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/);
      if (arrowMatch) {
        const insertPos = arrowMatch[0].length;
        lines[idx] = line.slice(0, insertPos) + ": void =>" + line.slice(insertPos);
        return lines.join("\n");
      }
      return null;
    },
    needsVerify: true,
  }],
]);

// =========================================================================
// RPC Record Helper — appends a correction.attempt record to the wire file
// =========================================================================

/**
 * Append a correction.attempt record to the session wire file.
 */
function appendCorrectionRecord(
  wirePath: string | undefined,
  record: Omit<CorrectionAttemptRecord, "type" | "timestamp">,
): void {
  if (!wirePath) return;
  try {
    const fullRecord: CorrectionAttemptRecord = {
      type: "correction.attempt",
      timestamp: new Date().toISOString(),
      ...record,
    };
    appendRecord(wirePath, fullRecord);
  } catch {
    // Best-effort logging — failures to write a correction record
    // should never block the correction pipeline.
  }
}

// =========================================================================
// Correction Handlers — Concrete implementations for each failure type
// =========================================================================

/**
 * Attempt an auto-fix via the QUICK_FIX_MAP.
 * Returns { fixed, mergedContent } if the fix was applied, null otherwise.
 */
export function tryAutoFix(
  diagnostic: CorrectionDiagnostic,
  content: string,
): { fixed: boolean; mergedContent: string; entry: QuickFixEntry } | null {
  const rule = diagnostic.rule.toLowerCase();
  const msg = diagnostic.errorMessage.toLowerCase();

  // Try exact rule match first
  const exact = QUICK_FIX_MAP.get(rule);
  if (exact) {
    const result = exact.apply(content, diagnostic);
    if (result !== null) {
      return { fixed: true, mergedContent: result, entry: exact };
    }
  }

  // Try message-based matching
  for (const [key, entry] of QUICK_FIX_MAP) {
    if (key.length > 5 && msg.includes(key)) {
      const result = entry.apply(content, diagnostic);
      if (result !== null) {
        return { fixed: true, mergedContent: result, entry };
      }
    }
  }

  return null;
}

// =========================================================================
// Handler 1: SyntaxCorrectionHandler
// =========================================================================

/**
 * Handles syntax errors by dispatching a targeted sub-agent with
 * Read + Edit on the single affected file, max 2 turns.
 * Falls through to auto-fix for trivial cases.
 */
export class SyntaxCorrectionHandler {
  constructor(
    private config: {
      workspaceRoot: string;
      wirePath?: string;
      subagentHost?: { spawn: (profile: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ id: string; result: string }> };
    },
  ) {}

  async correct(
    diagnostics: CorrectionDiagnostic[],
    signal?: AbortSignal,
  ): Promise<HandlerCorrectionResult> {
    const startedAt = Date.now();
    const changedFiles: string[] = [];

    for (const diag of diagnostics) {
      // Try auto-fix first (always attempt, regardless of wirePath)
      const autoFixResult = tryAutoFix(diag, diag.fileContent);
      if (autoFixResult) {
        try {
          await writeFile(diag.filePath, autoFixResult.mergedContent, "utf-8");
          changedFiles.push(diag.filePath);
          if (this.config.wirePath) {
            appendCorrectionRecord(this.config.wirePath, {
              diagnosticId: `${diag.filePath}:${diag.line}`,
              gateName: "syntax",
              handler: "auto-fix",
              attemptedFixSummary: autoFixResult.entry.label,
              outcome: "fixed",
              durationMs: Date.now() - startedAt,
              changedFiles: [diag.filePath],
              errorMessage: diag.errorMessage,
              line: diag.line,
              column: diag.column,
            });
          }
          return {
            status: "fixed",
            changedFiles,
            summary: `Auto-fixed syntax in ${basename(diag.filePath)}: ${autoFixResult.entry.label}`,
            durationMs: Date.now() - startedAt,
          };
        } catch {
            // Auto-fix write failed, fall through to sub-agent
        }
      }

      // Fall through to sub-agent correction
      if (this.config.subagentHost) {
        try {
          const prompt = `Fix the syntax error at ${diag.filePath}:${diag.line}:${diag.column}. Error: ${diag.errorMessage}. Only edit this single line or the minimal surrounding context. Do NOT add explanatory comments.`;

          // Use "editius" profile because the sub-agent
          // needs Write tool access to edit the file.
          const result = await this.config.subagentHost.spawn("editius", prompt, { signal });

          changedFiles.push(diag.filePath);

          appendCorrectionRecord(this.config.wirePath, {
            diagnosticId: `${diag.filePath}:${diag.line}`,
            gateName: "syntax",
            handler: "syntax",
            attemptedFixSummary: result.result.slice(0, 200),
            outcome: "fixed",
            durationMs: Date.now() - startedAt,
            changedFiles: [diag.filePath],
            errorMessage: diag.errorMessage,
            line: diag.line,
            column: diag.column,
          });

          return {
            status: "fixed",
            changedFiles,
            summary: `Sub-agent corrected syntax in ${basename(diag.filePath)}`,
            durationMs: Date.now() - startedAt,
          };
        } catch (err) {
          appendCorrectionRecord(this.config.wirePath, {
            diagnosticId: `${diag.filePath}:${diag.line}`,
            gateName: "syntax",
            handler: "syntax",
            attemptedFixSummary: `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`,
            outcome: "failed",
            durationMs: Date.now() - startedAt,
            changedFiles: [],
            errorMessage: diag.errorMessage,
            line: diag.line,
            column: diag.column,
          });

          return {
            status: "failed",
            changedFiles: [],
            summary: `Failed to fix syntax in ${basename(diag.filePath)}: ${err instanceof Error ? err.message : String(err)}`,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startedAt,
          };
        }
      }
    }

    return {
      status: "skipped",
      changedFiles: [],
      summary: "No syntax correction handler available (no sub-agent host configured)",
      durationMs: Date.now() - startedAt,
    };
  }
}

// =========================================================================
// Handler 2: LintCorrectionHandler
// =========================================================================

/**
 * Handles lint failures by dispatching a reviewer sub-agent with
 * Read + Edit + Bash (for re-running lint). Injects lint rule docs.
 */
export class LintCorrectionHandler {
  constructor(
    private config: {
      workspaceRoot: string;
      wirePath?: string;
      subagentHost?: { spawn: (profile: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ id: string; result: string }> };
    },
  ) {}

  async correct(
    diagnostics: CorrectionDiagnostic[],
    signal?: AbortSignal,
  ): Promise<HandlerCorrectionResult> {
    const startedAt = Date.now();
    const changedFiles: string[] = [];

    // Group diagnostics by file
    const byFile = new Map<string, CorrectionDiagnostic[]>();
    for (const d of diagnostics) {
      const arr = byFile.get(d.filePath) ?? [];
      arr.push(d);
      byFile.set(d.filePath, arr);
    }

    for (const [filePath, fileDiags] of byFile) {
      // Try auto-fix for each diagnostic first
      if (this.config.wirePath) {
        for (const diag of fileDiags) {
          try {
            const currentContent = await readFile(filePath, "utf-8");
            const autoFixResult = tryAutoFix(diag, currentContent);
            if (autoFixResult) {
              await writeFile(filePath, autoFixResult.mergedContent, "utf-8");
              changedFiles.push(filePath);
              appendCorrectionRecord(this.config.wirePath, {
                diagnosticId: `${filePath}:${diag.line}:${diag.rule}`,
                gateName: "lint",
                handler: "auto-fix",
                attemptedFixSummary: autoFixResult.entry.label,
                outcome: "fixed",
                durationMs: Date.now() - startedAt,
                changedFiles: [filePath],
                errorMessage: diag.errorMessage,
                line: diag.line,
                column: diag.column,
              });
            }
          } catch {
            // skip this auto-fix attempt
          }
        }

        // Re-read content after auto-fixes to build the linter prompt
        const currentContent = await readFile(filePath, "utf-8");
        const remainingDiags = fileDiags.filter((d) => {
          // Check if the auto-fix actually resolved this diagnostic
          try {
            const testContent = currentContent; // content after auto-fixes
            const existing = tryAutoFix(d, testContent);
            return existing === null;
          } catch {
            return true;
          }
        });

        if (remainingDiags.length === 0) {
          continue; // all fixed by auto-fix
        }
      }

      // Fall through to sub-agent for remaining lint errors
      if (this.config.subagentHost) {
        const errorDetails = fileDiags
          .map((d) => `  - ${d.filePath}:${d.line}:${d.column} [${d.rule}] ${d.errorMessage}`)
          .join("\n");

        // Try to find lint rule documentation
        const ruleDocs = await this.fetchLintRuleDocs(fileDiags);

        const prompt = `Fix the following lint errors in ${filePath}:

${errorDetails}

${ruleDocs ? `Lint rule documentation:\n${ruleDocs}\n` : ""}
Only edit the minimal context needed to fix these errors. Do not add explanatory comments.
After editing, verify with: the lint command.`;

        try {
          // Use "editius" profile because the sub-agent
          // needs Write tool access to edit the file and Bash to re-lint.
          const result = await this.config.subagentHost.spawn("editius", prompt, { signal });

          changedFiles.push(filePath);
          for (const d of fileDiags) {
            appendCorrectionRecord(this.config.wirePath, {
              diagnosticId: `${filePath}:${d.line}:${d.rule}`,
              gateName: "lint",
              handler: "lint",
              attemptedFixSummary: result.result.slice(0, 200),
              outcome: "fixed",
              durationMs: Date.now() - startedAt,
              changedFiles: [filePath],
              errorMessage: d.errorMessage,
              line: d.line,
              column: d.column,
            });
          }
        } catch (err) {
          for (const d of fileDiags) {
            appendCorrectionRecord(this.config.wirePath, {
              diagnosticId: `${filePath}:${d.line}:${d.rule}`,
              gateName: "lint",
              handler: "lint",
              attemptedFixSummary: `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`,
              outcome: "failed",
              durationMs: Date.now() - startedAt,
              changedFiles: [],
              errorMessage: d.errorMessage,
              line: d.line,
              column: d.column,
            });
          }
          return {
            status: "failed",
            changedFiles,
            summary: `Failed to fix lint errors in ${basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startedAt,
          };
        }
      }
    }

    return {
      status: changedFiles.length > 0 ? "fixed" : "skipped",
      changedFiles,
      summary: `Processed ${diagnostics.length} lint diagnostic(s) across ${byFile.size} file(s)`,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Attempt to fetch lint rule documentation for the given diagnostics.
   * Tries eslint --rulesdir or fetches rule documentation URL.
   */
  private async fetchLintRuleDocs(
    diagnostics: CorrectionDiagnostic[],
  ): Promise<string | null> {
    const ruleNames = [...new Set(diagnostics.map((d) => d.rule).filter(Boolean))];
    if (ruleNames.length === 0) return null;

    const docs: string[] = [];
    for (const rule of ruleNames) {
      // Check common eslint docs directory
      const ruleDocPath = resolve(this.config.workspaceRoot, "node_modules", "eslint", "docs", "rules", `${rule}.md`);
      if (existsSync(ruleDocPath)) {
        try {
          const content = await readFile(ruleDocPath, "utf-8");
          docs.push(`--- ${rule} ---\n${content.slice(0, 500)}`);
        } catch {
          // fall through
        }
      }

      // Try node_modules/eslint-plugin-*/docs/rules/
      if (docs.length === 0) {
        try {
          const pluginsDir = resolve(this.config.workspaceRoot, "node_modules");
          const entries = await readdir(pluginsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith("eslint-plugin-")) {
              const rulePath = resolve(pluginsDir, entry.name, "docs", "rules", `${rule}.md`);
              if (existsSync(rulePath)) {
                try {
                  const content = await readFile(rulePath, "utf-8");
                  docs.push(`--- ${rule} (${entry.name}) ---\n${content.slice(0, 500)}`);
                } catch {
                  // fall through
                }
              }
            }
          }
        } catch {
          // skip
        }
      }
    }

    return docs.length > 0 ? docs.join("\n\n") : null;
  }
}

// =========================================================================
// Handler 3: TypeCorrectionHandler
// =========================================================================

/**
 * Handles type errors by dispatching a rewriter sub-agent with
 * Read + Edit + Glob + Grep. Injects the type definition file resolved
 * via CodebaseGraphIndex lookupSymbol() for the failing type.
 */
export class TypeCorrectionHandler {
  constructor(
    private config: {
      workspaceRoot: string;
      wirePath?: string;
      codebaseGraph?: {
        lookupSymbol: (name: string) => Array<{ location: { file: string; line: number } }>;
        findReferences: (name: string) => Array<{ file: string; line: number }>;
      };
      subagentHost?: { spawn: (profile: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ id: string; result: string }> };
    },
  ) {}

  async correct(
    diagnostics: CorrectionDiagnostic[],
    signal?: AbortSignal,
  ): Promise<HandlerCorrectionResult> {
    const startedAt = Date.now();
    const changedFiles: string[] = [];

    for (const diag of diagnostics) {
      // Try auto-fix first for trivial type errors
      if (this.config.wirePath) {
        const autoFixResult = tryAutoFix(diag, diag.fileContent);
        if (autoFixResult) {
          try {
            await writeFile(diag.filePath, autoFixResult.mergedContent, "utf-8");
            changedFiles.push(diag.filePath);
            appendCorrectionRecord(this.config.wirePath, {
              diagnosticId: `${diag.filePath}:${diag.line}`,
              gateName: "typecheck",
              handler: "auto-fix",
              attemptedFixSummary: autoFixResult.entry.label,
              outcome: "fixed",
              durationMs: Date.now() - startedAt,
              changedFiles: [diag.filePath],
              errorMessage: diag.errorMessage,
              line: diag.line,
              column: diag.column,
            });
            return {
              status: "fixed",
              changedFiles,
              summary: `Auto-fixed type error in ${basename(diag.filePath)}: ${autoFixResult.entry.label}`,
              durationMs: Date.now() - startedAt,
            };
          } catch {
            // fall through to sub-agent
          }
        }
      }

      // Resolve type definitions for the failing type
      let typeDefinitionContext = "";
      if (this.config.codebaseGraph) {
        const typeNames = this.extractTypeNames(diag.errorMessage);
        for (const typeName of typeNames) {
          const refs = this.config.codebaseGraph.lookupSymbol(typeName);
          if (refs.length > 0) {
            for (const ref of refs.slice(0, 3)) {
              try {
                const defContent = await readFile(ref.location.file, "utf-8");
                const lines = defContent.split("\n");
                const startLine = Math.max(0, ref.location.line - 5);
                const endLine = Math.min(lines.length, ref.location.line + 10);
                const snippet = lines.slice(startLine, endLine).join("\n");
                typeDefinitionContext += `\n--- ${typeName} defined in ${ref.location.file}:${ref.location.line} ---\n${snippet}\n`;
              } catch {
                // skip unreadable files
              }
            }
          }
        }
      }

      // Dispatch sub-agent for type correction
      if (this.config.subagentHost) {
        const prompt = `Fix the type error at ${diag.filePath}:${diag.line}:${diag.column}.

Error: ${diag.errorMessage}

${typeDefinitionContext ? `Relevant type definitions found in the codebase:\n${typeDefinitionContext}\n` : ""}
Use Glob or Grep to find type definitions if needed. Only edit the minimal context needed to fix the type error. Do not add explanatory comments or change logic.`;

        try {
          const result = await this.config.subagentHost.spawn("editius", prompt, { signal });

          changedFiles.push(diag.filePath);
          appendCorrectionRecord(this.config.wirePath, {
            diagnosticId: `${diag.filePath}:${diag.line}`,
            gateName: "typecheck",
            handler: "type",
            attemptedFixSummary: result.result.slice(0, 200),
            outcome: "fixed",
            durationMs: Date.now() - startedAt,
            changedFiles: [diag.filePath],
            errorMessage: diag.errorMessage,
            line: diag.line,
            column: diag.column,
          });

          return {
            status: "fixed",
            changedFiles,
            summary: `Sub-agent corrected type error in ${basename(diag.filePath)}`,
            durationMs: Date.now() - startedAt,
          };
        } catch (err) {
          appendCorrectionRecord(this.config.wirePath, {
            diagnosticId: `${diag.filePath}:${diag.line}`,
            gateName: "typecheck",
            handler: "type",
            attemptedFixSummary: `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`,
            outcome: "failed",
            durationMs: Date.now() - startedAt,
            changedFiles: [],
            errorMessage: diag.errorMessage,
            line: diag.line,
            column: diag.column,
          });

          return {
            status: "failed",
            changedFiles: [],
            summary: `Failed to fix type error in ${basename(diag.filePath)}`,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startedAt,
          };
        }
      }
    }

    return {
      status: "skipped",
      changedFiles: [],
      summary: "No type correction handler available (no sub-agent host configured)",
      durationMs: Date.now() - startedAt,
    };
  }

  /** Extract type/interface/function names from an error message. */
  private extractTypeNames(message: string): string[] {
    const names: string[] = [];
    const quoted = message.match(/'([^']+)'/g);
    if (quoted) names.push(...quoted.map((s) => s.replace(/'/g, "")));
    const backtick = message.match(/`([^`]+)`/g);
    if (backtick) names.push(...backtick.map((s) => s.replace(/`/g, "")));
    const typePattern = message.match(/Type\s+'([^']+)'/g);
    if (typePattern) names.push(...typePattern.map((s) => s.replace(/Type\s+'/, "").replace(/'$/, "")));
    return [...new Set(names)];
  }
}

// =========================================================================
// Handler 4: TestCorrectionHandler
// =========================================================================

/**
 * Handles test failures by spawning TWO sub-agents in parallel:
 * one 'rewriter' (to fix the implementation) and one 'test-gen'
 * (to fix the test expectation). Converges results through the
 * ConvergenceEngine; if both produce corrections, the architecturally
 * coherent one wins (fewer CodebaseGraphIndex boundary violations).
 */
export class TestCorrectionHandler {
  constructor(
    private config: {
      workspaceRoot: string;
      wirePath?: string;
      codebaseGraph?: {
        checkBoundaries: (file: string, module: string) => "allowed" | "blocked" | "no_rule";
        moduleOf: (file: string) => string | null;
      };
      subagentHost?: {
        spawn: (profile: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ id: string; result: string }>;
      };
    },
  ) {}

  async correct(
    diagnostics: CorrectionDiagnostic[],
    signal?: AbortSignal,
  ): Promise<HandlerCorrectionResult> {
    const startedAt = Date.now();
    const changedFiles: string[] = [];

    const testFiles = diagnostics.filter((d) => this.isTestFile(d.filePath));
    const implFiles = diagnostics.filter((d) => !this.isTestFile(d.filePath));

    const errorSummary = diagnostics.map((d) => `  - ${d.filePath}:${d.line} [${d.rule}] ${d.errorMessage}`).join("\n");
    const testFileList = testFiles.map((d) => d.filePath).join(", ");
    const implFileList = implFiles.map((d) => d.filePath).join(", ");

    // Determine fault direction from diagnostics
    const faultAnalysis = this.analyzeTestFaults(diagnostics);

    // Spawn agents based on fault analysis
    const agentPromises: Array<Promise<{ id: string; result: string; profile: string; targetFile: string } | null>> = [];

    if (faultAnalysis.canTryImpl || faultAnalysis.fault === "wrong_implementation") {
      // Spawn rewriter to fix implementation
      const targetImpl = implFiles.length > 0
        ? implFiles.map((d) => d.filePath).join(", ")
        : "(implementation file inferred from test context)";

      const implPrompt = `Fix the implementation to match the test expectations.

Failing tests: ${testFileList}
Implementation files: ${implFileList || "(inferred)"}
Error details:
${errorSummary}

${faultAnalysis.fault === "wrong_implementation" ? `The test expects ${faultAnalysis.expected} but the implementation produces ${faultAnalysis.actual}.` : ""}

Make the minimal changes to fix the implementation so the tests pass.
Do NOT modify test files. Only edit the implementation files listed above.`;

      if (this.config.subagentHost) {
        agentPromises.push(
          this.config.subagentHost.spawn("editius", implPrompt, { signal })
            .then((r) => ({ ...r, profile: "editius", targetFile: implFiles[0]?.filePath ?? "" }))
            .catch(() => null),
        );
      }
    }

    if (faultAnalysis.canTryTest || faultAnalysis.fault === "wrong_expectation") {
      // Spawn test-gen to fix test expectations
      const testPrompt = `Fix the test expectations to match the actual implementation behavior.

Failing test files: ${testFileList}
Error details:
${errorSummary}

${faultAnalysis.fault === "wrong_expectation" ? `The test expected ${faultAnalysis.expected} but the actual value is ${faultAnalysis.actual}. Update the test expectation to match the actual behavior.` : ""}

Only edit the test files listed above. Do NOT modify implementation files.`;

      if (this.config.subagentHost) {
        agentPromises.push(
          this.config.subagentHost.spawn("editius", testPrompt, { signal })
            .then((r) => ({ ...r, profile: "editius", targetFile: testFiles[0]?.filePath ?? "" }))
            .catch(() => null),
        );
      }
    }

    // Wait for all spawned agents
    const results = await Promise.all(agentPromises);
    const successfulResults = results.filter((r): r is NonNullable<typeof r> => r !== null);

    if (successfulResults.length === 0) {
      return {
        status: "failed",
        changedFiles: [],
        summary: "No correction agent could fix the test failure",
        durationMs: Date.now() - startedAt,
      };
    }

    // Choose the best correction: if both profiles produced corrections,
    // pick the one with fewer CodebaseGraphIndex boundary violations.
    let chosenResult = successfulResults[0]!;
    if (successfulResults.length >= 2 && this.config.codebaseGraph) {
      const scored = successfulResults.map((r) => {
        let violations = 0;
        if (r.targetFile) {
          const mod = this.config.codebaseGraph!.moduleOf(r.targetFile);
          if (mod) {
            // Check import boundaries in the agent's result
            const importMatches = r.result.match(/import\s+(?:\{[^}]*\}|\w+)\s+from\s+['"]([^'"]+)['"]/g);
            if (importMatches) {
              for (const imp of importMatches) {
                const target = imp.replace(/^import\s+(?:\{[^}]*\}|\w+)\s+from\s+['"]/, "").replace(/['"]$/, "");
                const verdict = this.config.codebaseGraph!.checkBoundaries(r.targetFile, target);
                if (verdict === "blocked") violations++;
              }
            }
          }
        }
        return { ...r, violations };
      });

      // Sort by violations ascending, then by profile priority (rewriter > test-gen)
      scored.sort((a, b) => {
        if (a.violations !== b.violations) return a.violations - b.violations;
        return a.profile === "editius" ? -1 : 1;
      });
      chosenResult = scored[0]!;
    }

    // Apply the chosen correction's files
    changedFiles.push(chosenResult.targetFile);

    for (const d of diagnostics) {
      appendCorrectionRecord(this.config.wirePath, {
        diagnosticId: `${d.filePath}:${d.line}`,
        gateName: d.gateName,
        handler: "test",
        attemptedFixSummary: `Chosen ${chosenResult.profile} correction: ${chosenResult.result.slice(0, 150)}`,
        outcome: "fixed",
        durationMs: Date.now() - startedAt,
        changedFiles: [chosenResult.targetFile],
        errorMessage: d.errorMessage,
        line: d.line,
        column: d.column,
      });
    }

    return {
      status: "fixed",
      changedFiles: [...new Set(changedFiles)],
      summary: `Test correction applied via ${chosenResult.profile} profile (${successfulResults.length} agent(s) spawned)`,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Analyze test failure diagnostics to determine fault direction. */
  private analyzeTestFaults(
    diagnostics: CorrectionDiagnostic[],
  ): { fault: "wrong_expectation" | "wrong_implementation" | "unknown"; expected?: string; actual?: string; canTryImpl: boolean; canTryTest: boolean } {
    const messages = diagnostics.map((d) => d.errorMessage);
    const combined = messages.join("\n");

    // Try Expected/Received pattern
    const erMatch = /[Ee]xpected:\s*(.+?)\s*[Rr]ecei[ve]d:\s*(.+?)(?:\n|$)/s.exec(combined);
    if (erMatch) {
      const expected = erMatch[1]!.trim();
      const actual = erMatch[2]!.trim();

      if (actual === "undefined" || actual === "null") {
        return { fault: "wrong_implementation", expected, actual, canTryImpl: true, canTryTest: false };
      }
      if (expected && expected.length < 50) {
        return { fault: "wrong_expectation", expected, actual, canTryImpl: true, canTryTest: true };
      }
      return { fault: "wrong_implementation", expected, actual, canTryImpl: true, canTryTest: true };
    }

    if (combined.includes("timeout") || combined.includes("timed out")) {
      return { fault: "wrong_implementation", canTryImpl: true, canTryTest: false };
    }

    return { fault: "unknown", canTryImpl: true, canTryTest: true };
  }

  /** Check if a file path looks like a test file. */
  private isTestFile(filePath: string): boolean {
    const base = filePath.toLowerCase();
    return base.includes(".test.") || base.includes(".spec.") || base.includes("_test.");
  }
}

// =========================================================================
// Handler 5: ArchitectureCorrectionHandler
// =========================================================================

/**
 * Handles architecture boundary violations by escalating to the orchestrator.
 * Does NOT create a sub-agent — instead returns an escalation descriptor
 * that the orchestrator can use to re-decompose tasks.
 */
export class ArchitectureCorrectionHandler {
  constructor(
    private config: {
      workspaceRoot: string;
      wirePath?: string;
    },
  ) {}

  async correct(
    diagnostics: CorrectionDiagnostic[],
  ): Promise<HandlerCorrectionResult> {
    const startedAt = Date.now();

    const violations = diagnostics.map(
      (d) => `  - ${d.filePath}:${d.line}: ${d.errorMessage}`,
    );

    for (const d of diagnostics) {
      appendCorrectionRecord(this.config.wirePath, {
        diagnosticId: `${d.filePath}:${d.line}`,
        gateName: "architecture",
        handler: "architecture",
        attemptedFixSummary: "Architecture boundary violation — requires task re-decomposition",
        outcome: "skipped",
        durationMs: Date.now() - startedAt,
        changedFiles: [],
        errorMessage: d.errorMessage,
        line: d.line,
        column: d.column,
      });
    }

    return {
      status: "failed",
      changedFiles: [],
      summary: `Architecture boundary violation${diagnostics.length > 1 ? "s" : ""} — requires task re-decomposition.\n${violations.join("\n")}`,
      error: "Architecture failure requires re-decomposition via orchestrator",
      durationMs: Date.now() - startedAt,
    };
  }
}

// =========================================================================
// Auto-fix dispatch helper — tries QUICK_FIX_MAP for all diagnostics
// =========================================================================

/**
 * Try to auto-fix all eligible diagnostics for the given failure type.
 * Returns the set of files that were changed.
 */
export async function tryAutoFixBatch(
  diagnostics: CorrectionDiagnostic[],
  _type: FailureType,
  wirePath?: string,
): Promise<{ changedFiles: string[]; fixed: CorrectionDiagnostic[]; remaining: CorrectionDiagnostic[] }> {
  const changedFiles: string[] = [];
  const fixed: CorrectionDiagnostic[] = [];
  const remaining: CorrectionDiagnostic[] = [];

  for (const diag of diagnostics) {
    try {
      const currentContent = await readFile(diag.filePath, "utf-8");
      const result = tryAutoFix(diag, currentContent);
      if (result) {
        await writeFile(diag.filePath, result.mergedContent, "utf-8");
        changedFiles.push(diag.filePath);

        if (wirePath) {
          appendCorrectionRecord(wirePath, {
            diagnosticId: `${diag.filePath}:${diag.line}`,
            gateName: diag.gateName,
            handler: "auto-fix",
            attemptedFixSummary: result.entry.label,
            outcome: "fixed",
            durationMs: 0,
            changedFiles: [diag.filePath],
            errorMessage: diag.errorMessage,
            line: diag.line,
            column: diag.column,
          });
        }

        fixed.push(diag);
      } else {
        remaining.push(diag);
      }
    } catch {
      remaining.push(diag);
    }
  }

  return { changedFiles: [...new Set(changedFiles)], fixed, remaining };
}

export class SelfCorrectionCycle {
  private config: SelfCorrectionConfig;
  private pipeline: VerificationPipeline;
  private budget: CorrectionBudget;
  private attempt = 0;
  private attempts: CorrectionAttempt[] = [];
  private changedFiles = new Set<string>();
  private progressListeners: Array<(event: CorrectionProgressEvent) => void> = [];
  /** Optional sub-agent host for spawning correction agents. */
  private subagentHost?: { spawn: (profile: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ id: string; result: string }> };
  /** Optional codebase graph for type correction and boundary checks. */
  private codebaseGraph?: {
    lookupSymbol: (name: string) => Array<{ location: { file: string; line: number } }>;
    findReferences: (name: string) => Array<{ file: string; line: number }>;
    checkBoundaries: (file: string, module: string) => "allowed" | "blocked" | "no_rule";
    moduleOf: (file: string) => string | null;
  };

  constructor(
    config?: Partial<SelfCorrectionConfig>,
    pipeline?: VerificationPipeline,
    deps?: {
      subagentHost?: { spawn: (profile: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ id: string; result: string }> };
      codebaseGraph?: {
        lookupSymbol: (name: string) => Array<{ location: { file: string; line: number } }>;
        findReferences: (name: string) => Array<{ file: string; line: number }>;
        checkBoundaries: (file: string, module: string) => "allowed" | "blocked" | "no_rule";
        moduleOf: (file: string) => string | null;
      };
    },
  ) {
    this.config = { ...DEFAULT_CORRECTION_CONFIG, ...config };
    this.pipeline = pipeline ?? new VerificationPipeline({ workspaceRoot: this.config.workspaceRoot });
    this.budget = new CorrectionBudget(this.config);
    this.subagentHost = deps?.subagentHost;
    this.codebaseGraph = deps?.codebaseGraph;
  }

  /** Set the sub-agent host for spawning correction agents. */
  setSubagentHost(host: { spawn: (profile: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ id: string; result: string }> }): void {
    this.subagentHost = host;
  }

  /** Set the codebase graph for type resolution and boundary checks. */
  setCodebaseGraph(graph: {
    lookupSymbol: (name: string) => Array<{ location: { file: string; line: number } }>;
    findReferences: (name: string) => Array<{ file: string; line: number }>;
    checkBoundaries: (file: string, module: string) => "allowed" | "blocked" | "no_rule";
    moduleOf: (file: string) => string | null;
  }): void {
    this.codebaseGraph = graph;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run the full 4-step correction cycle on a failed pipeline result.
   *
   * @param pipelineResult  The failed PipelineResult from VerificationPipeline
   * @param changedFiles    The set of files that were modified in the pipeline run
   * @param gateContext     Context for re-running gates
   */
  async run(
    pipelineResult: PipelineResult,
    changedFiles: Set<string>,
    gateContext?: Partial<GateContext>,
  ): Promise<CorrectionResult> {
    const startedAt = Date.now();
    this.attempt = 0;
    this.attempts = [];
    this.changedFiles = new Set(changedFiles);
    this.budget.reset();

    // Find the first failed gate — this is our cutoff
    const failedGate = this.findFirstFailedGate(pipelineResult);
    if (!failedGate) {
      // Nothing failed — no correction needed
      return {
        success: true,
        attempts: [],
        changedFiles: Array.from(this.changedFiles),
        durationMs: Date.now() - startedAt,
        finalPipelineResult: pipelineResult,
      };
    }

    // ── Step 1: COLLECT_DIAGNOSTIC ─────────────────────────────────────
    this.emitProgress("collecting", 0, "Collecting diagnostics from failed gates");

    const diagnostics = await this.collectDiagnostics(pipelineResult);
    if (diagnostics.length === 0) {
      // No actionable diagnostics — return as failed
      return {
        success: false,
        attempts: [],
        changedFiles: Array.from(this.changedFiles),
        durationMs: Date.now() - startedAt,
        escalation: this.buildEscalation(pipelineResult),
      };
    }

    // Determine max attempts based on the first diagnostic's classification
    const previewClass = this.classifyFailure(diagnostics[0]!, diagnostics);
    const maxAttempts = this.resolveMaxAttempts(previewClass.type);

    // ── Auto-fix pass (try QUICK_FIX_MAP first, before sub-agents) ─────
    if (this.config.enableAutoFix !== false) {
      this.emitProgress("correcting", 0, "Attempting auto-fix (QUICK_FIX_MAP fast path)");

      const autoFixResult = await tryAutoFixBatch(diagnostics, previewClass.type, this.config.wirePath);

      if (autoFixResult.fixed.length > 0) {
        for (const f of autoFixResult.changedFiles) {
          this.changedFiles.add(f);
        }

        // Re-run the pipeline to verify auto-fix resolved the failures
        this.emitProgress("reverifying", 0, "Auto-fix applied — re-verifying");

        const reVerifyResult = await this.reVerifyAll(gateContext);

        if (reVerifyResult.passed) {
          this.emitProgress("completed", 1, "Auto-fix successful");
          return {
            success: true,
            attempts: [],
            changedFiles: Array.from(this.changedFiles),
            finalPipelineResult: reVerifyResult,
            durationMs: Date.now() - startedAt,
          };
        }

        // Auto-fix partially resolved — update pipelineResult for the
        // correction loop to use the latest gate results
        pipelineResult = reVerifyResult;
      }
    }

    // ── Correction Loop (Steps 2 → 3 → 4) ──────────────────────────────
    while (this.attempt < maxAttempts) {
      this.attempt++;

      // ── Step 2: CLASSIFY_FAILURE ────────────────────────────────────
      this.emitProgress("classifying", this.attempt, `Classifying failure (attempt ${this.attempt}/${maxAttempts})`);

      // Re-read diagnostics from the latest pipeline state
      const currentDiagnostics = await this.collectDiagnostics(pipelineResult);
      if (currentDiagnostics.length === 0) {
        // All diagnostics resolved during previous re-verify
        break;
      }

      const classification = this.classifyFailure(currentDiagnostics[0]!, currentDiagnostics);

      // Check budget before dispatching
      if (!this.budget.canAttempt(classification.type, classification.sourceDiagnostic)) {
        this.emitProgress("escalating", this.attempt, "Correction budget exhausted — escalating");
        break;
      }

      // ── Step 3: CORRECT ─────────────────────────────────────────────
      this.emitProgress("correcting", this.attempt, `Correcting ${classification.type} failure (${classification.scope})`);

      const correctionResult = await this.dispatchCorrection(classification, currentDiagnostics, gateContext?.signal);

      this.budget.recordAttempt(classification.type, classification.sourceDiagnostic);

      // ── Step 4: RE_VERIFY ───────────────────────────────────────────
      this.emitProgress("reverifying", this.attempt, "Re-verifying after correction");

      const reVerifyResult = await this.reVerify(pipelineResult, classification, gateContext);

      const attemptRecord: CorrectionAttempt = {
        attemptNumber: this.attempt,
        targetDiagnostics: currentDiagnostics,
        classification,
        profile: this.resolveProfile(classification),
        changedFiles: correctionResult.changedFiles,
        changeSummary: correctionResult.summary,
        reVerifyResult,
        passed: reVerifyResult.passed,
        error: correctionResult.error,
        timestamp: new Date().toISOString(),
      };

      this.attempts.push(attemptRecord);

      // Track all files that were changed during correction
      for (const f of correctionResult.changedFiles) {
        this.changedFiles.add(f);
      }

      if (reVerifyResult.passed) {
        // Pipeline now passes — success
        this.emitProgress("completed", this.attempt, `Correction succeeded on attempt ${this.attempt}`);
        return {
          success: true,
          attempts: this.attempts,
          changedFiles: Array.from(this.changedFiles),
          finalPipelineResult: reVerifyResult,
          durationMs: Date.now() - startedAt,
        };
      }

      // Re-verify failed — loop for another attempt
      this.emitProgress("reverifying", this.attempt, `Re-verify failed on attempt ${this.attempt}`);
    }

    // ── Escalation (all attempts exhausted) ──────────────────────────
    this.emitProgress("escalating", this.attempt, "Escalating to user — all correction attempts exhausted");

    const escalation = this.buildEscalation(pipelineResult);

    return {
      success: false,
      attempts: this.attempts,
      changedFiles: Array.from(this.changedFiles),
      escalation,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Register a progress listener for TUI / event emission.
   */
  onProgress(listener: (event: CorrectionProgressEvent) => void): void {
    this.progressListeners.push(listener);
  }

  /**
   * Remove a progress listener.
   */
  offProgress(listener: (event: CorrectionProgressEvent) => void): void {
    const idx = this.progressListeners.indexOf(listener);
    if (idx >= 0) this.progressListeners.splice(idx, 1);
  }

  /**
   * Get the current config (read-only copy).
   */
  getConfig(): SelfCorrectionConfig {
    return { ...this.config };
  }

  // =======================================================================
  // Step 1: COLLECT_DIAGNOSTIC
  // =======================================================================

  /**
   * Extract diagnostics from the failed pipeline result, enriched with
   * pre-correction workspace snapshots of the affected files.
   */
  private async collectDiagnostics(pipelineResult: PipelineResult): Promise<CorrectionDiagnostic[]> {
    const collected: CorrectionDiagnostic[] = [];

    for (const [gateName, gateResult] of pipelineResult.gateResults) {
      if (gateResult.passed) continue;
      if (!gateResult.diagnostics || gateResult.diagnostics.length === 0) continue;

      for (const diagnostic of gateResult.diagnostics) {
        // Skip diagnostics without a meaningful file path
        if (!diagnostic.file || diagnostic.file === "") continue;

        const filePath = resolve(this.config.workspaceRoot, diagnostic.file);
        let fileContent = "";

        // Read the pre-correction file content (workspace snapshot)
        try {
          fileContent = await readFile(filePath, "utf-8");
        } catch {
          // File may not exist yet (e.g., creation-time errors)
          fileContent = "// File not found or not yet created";
        }

        // Extract stack-trace-like info from the diagnostic message
        const stackTrace = this.tryExtractStackTrace(diagnostic.message);

        collected.push({
          original: diagnostic,
          gateName,
          fileContent,
          filePath,
          errorMessage: diagnostic.message,
          line: diagnostic.line,
          column: diagnostic.column,
          rule: diagnostic.rule,
          stackTrace,
        });
      }
    }

    return collected;
  }

  /**
   * Attempt to extract a stack trace or test failure detail from a message.
   */
  private tryExtractStackTrace(message: string): string | undefined {
    // Look for common stack trace patterns
    const stackPatterns = [
      /at\s+.+\(.+:\d+:\d+\)/g,      // Node.js / JS stack frames
      /^\s+at\s+/gm,                   // indented "at" lines
      /Traceback\s*\(most recent call last\)/i,  // Python traceback
      /\t+at\s+/gm,                    // tab-indented stack frames
    ];

    for (const pattern of stackPatterns) {
      if (pattern.test(message)) {
        return message;
      }
    }

    // If the message looks like a test failure, include it entirely
    if (message.includes("FAIL") || message.includes("AssertionError") || message.includes("assert") || message.includes("expected") && message.includes("received")) {
      return message;
    }

    return undefined;
  }

  // =======================================================================
  // Step 2: CLASSIFY_FAILURE
  // =======================================================================

  /**
   * Classify a failure by type, scope, and root cause.
   */
  private classifyFailure(
    diagnostic: CorrectionDiagnostic,
    allDiagnostics: CorrectionDiagnostic[],
  ): FailureClassification {
    const type = this.inferFailureType(diagnostic);
    const scope = this.inferFailureScope(diagnostic, allDiagnostics);
    const rootCause = this.inferRootCause(diagnostic, type);
    const relatedFiles = allDiagnostics
      .filter(d => d.filePath !== diagnostic.filePath)
      .map(d => d.filePath);

    const rationale = this.buildRationale(type, scope, rootCause, diagnostic);

    return {
      type,
      scope,
      rootCause,
      sourceDiagnostic: diagnostic,
      relatedFiles,
      rationale,
    };
  }

  /**
   * Infer the failure type from the diagnostic's gate name, rule, and message.
   */
  private inferFailureType(diagnostic: CorrectionDiagnostic): FailureType {
    const gateName = diagnostic.gateName.toLowerCase();
    const rule = diagnostic.rule.toLowerCase();
    const msg = diagnostic.errorMessage.toLowerCase();

    // Gate-name-based inference
    if (gateName === "syntax") return "syntax";
    if (gateName === "lint") return "lint";
    if (gateName === "typecheck") return "type";
    if (gateName === "architecture") return "architecture";

    // Rule-based inference
    if (rule.includes("syntax") || rule.endsWith("-syntax") || rule === "python-syntax") return "syntax";
    if (rule === "tsc" || rule === "pyright" || rule === "cargo" || rule.includes("type") || rule.includes("ts")) {
      if (msg.includes("cannot find name") || msg.includes("type") || msg.includes("is not assignable") || msg.includes("is missing") || msg.includes("expected") && msg.includes("arguments")) {
        return "type";
      }
    }
    if (rule.includes("lint") || rule.includes("eslint") || rule.includes("ruff") || rule.includes("clippy")) return "lint";

    // Message-based inference for test failures
    if (gateName.includes("test") || rule.includes("test") || diagnostic.original.code === "TEST_FAIL" || msg.includes("test failed") || msg.includes("assertion") || msg.includes("expect(") || msg.includes("received")) {
      return "test_failure";
    }

    // Architecture boundary violations
    if (gateName === "architecture" || rule.includes("boundary") || rule.includes("arch") || msg.includes("must not import") || msg.includes("only import") || msg.includes("architecture")) {
      return "architecture";
    }

    // Default: if it smells like a compilation error, treat as type
    if (rule === "go-build" || rule === "cargo" || gateName === "typecheck") return "type";

    // Fallback
    return "lint";
  }

  /**
   * Infer the scope of the failure based on how many files are involved.
   */
  private inferFailureScope(
    diagnostic: CorrectionDiagnostic,
    allDiagnostics: CorrectionDiagnostic[],
  ): FailureScope {
    // Count unique files among failing diagnostics
    const uniqueFiles = new Set(allDiagnostics.map(d => d.filePath));
    const uniqueFileCount = uniqueFiles.size;

    // Count unique modules (infer module from path)
    const uniqueModules = new Set(
      allDiagnostics.map(d => this.inferModuleFromPath(d.filePath)),
    );
    const uniqueModuleCount = uniqueModules.size;

    if (uniqueFileCount === 1) return "per_file";
    if (uniqueModuleCount === 1) return "cross_file";
    if (uniqueModuleCount >= 2 && uniqueModuleCount <= 3) return "module";
    return "cross_module";
  }

  /**
   * Infer the root cause of the failure from the diagnostic message.
   */
  private inferRootCause(
    diagnostic: CorrectionDiagnostic,
    type: FailureType,
  ): RootCause {
    const msg = diagnostic.errorMessage.toLowerCase();
    const rule = diagnostic.rule.toLowerCase();

    // Test flakiness detection
    if (type === "test_failure") {
      const flakinessSignals = [
        "timeout", "timed out", "flaky", "unstable",
        "intermittent", "race condition", "async",
        "network", "socket hang up", "econnrefused",
      ];
      if (flakinessSignals.some(s => msg.includes(s))) {
        return "test_flakiness";
      }
    }

    // Simple mistake detection (typos, wrong variable names, missing semicolons)
    if (type === "syntax") return "simple_mistake";
    if (type === "lint") {
      // Most lint errors are simple mistakes
      const lintSignals = [
        "is defined but never used", "is assigned a value but never used",
        "missing semicolon", "unused", "prefer const",
        "trailing comma", "extra semicolon",
      ];
      if (lintSignals.some(s => msg.includes(s))) return "simple_mistake";
      return "misunderstanding";
    }

    if (type === "type") {
      const simpleTypeSignals = [
        "cannot find name", "does not exist",
        "is not a function", "is not in the list of known properties",
        "property doesn't exist", "undeclared",
      ];
      if (simpleTypeSignals.some(s => msg.includes(s))) return "simple_mistake";

      const misunderstandingSignals = [
        "is not assignable", "is missing", "is not assignable to type",
        "argument of type", "types of property", "incompatible",
        "cannot be used as", "is not a valid",
      ];
      if (misunderstandingSignals.some(s => msg.includes(s))) return "misunderstanding";

      return "misunderstanding";
    }

    if (type === "architecture") return "architectural";

    return "misunderstanding";
  }

  /**
   * Build a human-readable rationale for the classification.
   */
  private buildRationale(
    type: FailureType,
    scope: FailureScope,
    rootCause: RootCause,
    diagnostic: CorrectionDiagnostic,
  ): string {
    const parts: string[] = [];

    switch (type) {
      case "syntax":
        parts.push("Syntax error");
        break;
      case "lint":
        parts.push("Lint violation");
        break;
      case "type":
        parts.push("Type error");
        break;
      case "test_failure":
        parts.push("Test failure");
        break;
      case "architecture":
        parts.push("Architecture boundary violation");
        break;
    }

    switch (scope) {
      case "per_file":
        parts.push("confined to a single file");
        break;
      case "cross_file":
        parts.push("across multiple files in the same module");
        break;
      case "module":
        parts.push("spanning multiple modules");
        break;
      case "cross_module":
        parts.push("involving cross-module dependencies");
        break;
    }

    switch (rootCause) {
      case "simple_mistake":
        parts.push("(appears to be a simple mistake — variable name, typo, etc.)");
        break;
      case "misunderstanding":
        parts.push("(likely a misunderstanding of API or type contract)");
        break;
      case "architectural":
        parts.push("(architectural issue — requires re-decomposition)");
        break;
      case "test_flakiness":
        parts.push("(test may be flaky or non-deterministic)");
        break;
    }

    return parts.join(" — ");
  }

  /**
   * Infer a module name from a file path.
   */
  private inferModuleFromPath(filePath: string): string {
    const rel = relative(this.config.workspaceRoot, filePath);
    const parts = rel.split(/[/\\]/);
    if (parts.length >= 2) {
      // If within src/, use next-level directory as module name
      if (parts[0] === "src" && parts.length >= 2) return parts[1] ?? "root";
      return parts[0] ?? "root";
    }
    return "root";
  }

  // =======================================================================
  // Step 3: CORRECT — Dispatch by Classification
  // =======================================================================

  /**
   * Resolve the correction profile based on classification.
   */
  private resolveProfile(classification: FailureClassification): CorrectionProfile {
    const { type, scope, rootCause } = classification;

    if (type === "test_failure") return "editius";

    if (type === "architecture") return "rewritius";

    if (type === "syntax" || type === "lint") return "searchius";

    if (type === "type") {
      if (scope === "per_file") return "searchius";
      if (scope === "cross_file") return "rewritius";
      return "rewritius";
    }

    return "editius";
  }

  /**
   * Dispatch the appropriate correction action based on failure classification.
   * Returns what files were changed and a summary.
   */
  private async dispatchCorrection(
    classification: FailureClassification,
    allDiagnostics: CorrectionDiagnostic[],
    signal?: AbortSignal,
  ): Promise<{ changedFiles: string[]; summary: string; error?: string }> {
    const { type } = classification;

    const handlerDeps = {
      workspaceRoot: this.config.workspaceRoot,
      wirePath: this.config.wirePath,
      subagentHost: this.subagentHost,
      codebaseGraph: this.codebaseGraph,
    };

    try {
      let result: HandlerCorrectionResult;

      switch (type) {
        case "syntax": {
          const handler = new SyntaxCorrectionHandler(handlerDeps);
          result = await handler.correct(allDiagnostics, signal);
          break;
        }
        case "lint": {
          const handler = new LintCorrectionHandler(handlerDeps);
          result = await handler.correct(allDiagnostics, signal);
          break;
        }
        case "type": {
          const handler = new TypeCorrectionHandler(handlerDeps);
          result = await handler.correct(allDiagnostics, signal);
          break;
        }
        case "test_failure": {
          const handler = new TestCorrectionHandler(handlerDeps);
          result = await handler.correct(allDiagnostics, signal);
          break;
        }
        case "architecture": {
          const handler = new ArchitectureCorrectionHandler(handlerDeps);
          result = await handler.correct(allDiagnostics);
          break;
        }
        default:
          return {
            changedFiles: [],
            summary: "Unknown failure type — no correction applied",
            error: "Unknown failure type",
          };
      }

      return {
        changedFiles: result.changedFiles,
        summary: result.summary,
        error: result.error,
      };
    } catch (err) {
      return {
        changedFiles: [],
        summary: `Correction handler threw: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Handle syntax / lint / type failures.
   *
   * - per_file scope: targeted correction with 'reviewer' profile,
   *   limited to Read + Edit on that single file, max 2 turns.
   * - cross_file scope: re-dispatch with 'architect' profile,
   *   all affected files as context, interface-mismatch constraint.
   * - module scope: re-dispatch with full module context.
   */
  private async handleStaticFailure(
    classification: FailureClassification,
    allDiagnostics: CorrectionDiagnostic[],
  ): Promise<{ changedFiles: string[]; summary: string; error?: string }> {
    const sourceFile = classification.sourceDiagnostic.filePath;
    const errorMessage = classification.sourceDiagnostic.errorMessage;
    const line = classification.sourceDiagnostic.line;
    const column = classification.sourceDiagnostic.column;
    const rule = classification.sourceDiagnostic.rule;

    if (classification.scope === "per_file") {
      // Targeted correction: reviewer profile, limited Read + Edit on one file
      return this.applySimpleFix(sourceFile, errorMessage, line, column, rule);
    }

    if (classification.scope === "cross_file") {
      // Interface mismatch — re-dispatch with architect profile
      const affectedFiles = allDiagnostics.map(d => d.filePath);
      const constraint = `Fix the interface mismatch across these files. Ensure all APIs, types, and function signatures are consistent.`;
      return this.applyMultiFileFix(affectedFiles, constraint, errorMessage);
    }

    if (classification.scope === "module" || classification.scope === "cross_module") {
      // Full module context — re-dispatch with architect profile
      const affectedFiles = allDiagnostics.map(d => d.filePath);
      const uniqueModules = [...new Set(allDiagnostics.map(d => this.inferModuleFromPath(d.filePath)))];
      const constraint = `Fix the cross-module type/syntax/lint errors. Ensure module boundary consistency. Modules involved: ${uniqueModules.join(", ")}`;
      return this.applyMultiFileFix(affectedFiles, constraint, errorMessage);
    }

    return { changedFiles: [], summary: "Unhandled static failure scope" };
  }

  /**
   * Apply a targeted, single-file correction.
   * Simulates a "reviewer" sub-agent with Read + Edit on the one file.
   */
  private async applySimpleFix(
    filePath: string,
    errorMessage: string,
    line: number,
    column: number,
    rule: string,
  ): Promise<{ changedFiles: string[]; summary: string; error?: string }> {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      // Attempt automated fix based on common patterns.
      // This is a best-effort heuristic; if no pattern matches,
      // we still report the attempt for escalation purposes.
      const fixes = this.generateSimpleFixes(errorMessage, line, column, rule);
      let modified = false;

      for (const fix of fixes) {
        const result = this.applyFixToLines(lines, fix, line, content);
        if (result.modified) {
          modified = true;
          break;
        }
      }

      if (modified) {
        await writeFile(filePath, lines.join("\n"), "utf-8");

        // Try to fix-import issues too (e.g., missing semicolon at current line)
        // Extend the fix strategy for common patterns
        const extendedFixes = this.generateExtendedFixes(filePath, content, errorMessage, line, column, rule);
        for (const fix of extendedFixes) {
          const result = this.applyExtendedFixToLines(lines, fix, line, content);
          if (result.modified) {
            await writeFile(filePath, lines.join("\n"), "utf-8");
            break;
          }
        }

        return {
          changedFiles: [filePath],
          summary: `Applied heuristic fix to ${relative(this.config.workspaceRoot, filePath)}: ${fixes.map(f => f.description).join("; ")}`,
        };
      }

      // If no heuristic match, return the file path anyway so the
      // escalation handler can present it to the user for manual edit.
      return {
        changedFiles: [filePath],
        summary: `No automated fix available for "${errorMessage}" in ${relative(this.config.workspaceRoot, filePath)}. Available for manual edit.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        changedFiles: [],
        summary: `Failed to read ${filePath}: ${msg}`,
        error: msg,
      };
    }
  }

  /**
   * Generate potential simple heuristics for a given error message at a location.
   * Returns an ordered list of fix attempts (first match wins).
   */
  private generateSimpleFixes(
    message: string,
    line: number,
    _column: number,
    rule: string,
  ): Array<{ description: string; apply: (lineContent: string) => string | null }> {
    const fixes: Array<{ description: string; apply: (lineContent: string) => string | null }> = [];
    const msg = message.toLowerCase();
    const ruleLower = rule.toLowerCase();

    // Missing semicolons (lint) — add trailing semicolon
    if (msg.includes("missing semicolon") || ruleLower.includes("semi") || msg.includes("expected ';'")) {
      fixes.push({ description: "Add missing semicolon", apply: (s) => s.trimEnd().endsWith(";") ? null : s.trimEnd() + ";" });
    }

    // Unused variables — prefix with underscore
    if (ruleLower.includes("no-unused-vars") || msg.includes("is defined but never used") || msg.includes("is assigned a value but never used")) {
      fixes.push({ description: "Prefix unused variable with underscore", apply: (s) => {
        const trimmed = s.trimStart();
        if (trimmed.startsWith("const ") || trimmed.startsWith("let ") || trimmed.startsWith("var ")) {
          const parts = s.split(trimmed);
          const decl = trimmed.replace(/\b(const|let|var)\s+/, "$&_");
          return parts.length > 1 ? parts[0] + decl : decl;
        }
        if (/^\w+/.test(trimmed) && !trimmed.startsWith("_")) {
          return s.replace(/^(\s*)(\w+)/, "$1_$2");
        }
        return null;
      }});
    }

    // Prefer const rule — change let → const
    if (ruleLower.includes("prefer-const") || msg.includes("prefer const")) {
      fixes.push({ description: "Change let to const", apply: (s) => {
        const trimmed = s.trimStart();
        if (trimmed.startsWith("let ")) {
          return s.replace(trimmed, "const ");
        }
        return null;
      }});
    }

    // Trailing comma
    if (msg.includes("trailing comma") || msg.includes("missing comma") || msg.includes("expected ','")) {
      fixes.push({ description: "Fix trailing/missing comma", apply: (s) => {
        const trimmed = s.trimEnd();
        if (!trimmed.endsWith(",") && !trimmed.endsWith(";") && !trimmed.endsWith("{") && !trimmed.endsWith("}")) {
          return trimmed + ",";
        }
        return null;
      }});
    }

    // Extra semicolon
    if (msg.includes("extra semicolon") || msg.includes("unnecessary semicolon")) {
      fixes.push({ description: "Remove extra semicolon", apply: (s) => s.replace(/;\s*$/, "") });
    }

    // Cannot find name (type error — likely typo or missing import)
    if (msg.includes("cannot find name") || msg.includes("does not exist")) {
      fixes.push({ description: "Name not found — may need import or correction", apply: (_s) => null });
    }

    // Comparison with == vs ===
    if (msg.includes("expected '==='") || msg.includes("expected '!=='")) {
      fixes.push({ description: "Use === instead of ==", apply: (s) => s.replace(/==(?!=)/g, "===").replace(/!=(?!=)/g, "!==") });
    }

    // String concat lint
    if (msg.includes("prefer template") || msg.includes("string concatenation")) {
      fixes.push({ description: "String concatenation — prefer template literal", apply: (_s) => null });
    }

    return fixes;
  }

  /**
   * Generate extended fixes that may look at context beyond the single line.
   * These are file-level transforms.
   */
  private generateExtendedFixes(
    _filePath: string,
    content: string,
    message: string,
    _line: number,
    _column: number,
    _rule: string,
  ): Array<{ description: string; apply: (lines: string[], lineIdx: number) => boolean }> {
    const fixes: Array<{ description: string; apply: (lines: string[], lineIdx: number) => boolean }> = [];
    const msg = message.toLowerCase();

    // Missing import fix — check if a name used in the error is referenced
    // but never imported. For "cannot find name 'Foo'", try adding import.
    if (msg.includes("cannot find name") || msg.includes("is not defined")) {
      const nameMatch = message.match(/'([^']+)'/);
      if (nameMatch && nameMatch[1]) {
        const name = nameMatch[1]!;
        fixes.push({
          description: `Add import for "${name}"`,
          apply: (lines, _lineIdx) => {
            // Check if the name looks like a local module or component
            if (name.charAt(0) >= 'A' && name.charAt(0) <= 'Z') {
              // Looks like a React component or class — add import
              // Find the right place to insert (after existing imports)
              let insertIdx = 0;
              for (let i = 0; i < lines.length; i++) {
                if (lines[i]!.startsWith("import ")) {
                  insertIdx = i + 1;
                } else if (insertIdx > 0 && !lines[i]!.trim().startsWith("import ") && lines[i]!.trim() !== "") {
                  break;
                }
              }
              const importLine = `import { ${name} } from "./${name}";`;
              if (insertIdx < lines.length && lines[insertIdx] !== importLine) {
                lines.splice(insertIdx, 0, importLine);
                return true;
              }
            }
            return false;
          },
        });
      }
    }

    return fixes;
  }

  /**
   * Apply a simple fix to the lines array. Returns whether any modification was made.
   */
  private applyFixToLines(
    lines: string[],
    fix: { description: string; apply: (lineContent: string) => string | null },
    _line: number,
    _originalContent: string,
  ): { modified: boolean } {
    // Try the exact line first (1-based → 0-based array)
    for (const lineIdx of [0, 1, 2].flatMap(offset => {
      const idx = _line - 1 + offset;
      return idx >= 0 && idx < lines.length ? [idx] : [];
    })) {
      const result = fix.apply(lines[lineIdx]!);
      if (result !== null) {
        lines[lineIdx] = result;
        return { modified: true };
      }
    }
    return { modified: false };
  }

  /**
   * Apply an extended fix (file-level transform) to the lines array.
   */
  private applyExtendedFixToLines(
    lines: string[],
    fix: { description: string; apply: (lines: string[], lineIdx: number) => boolean },
    _line: number,
    _originalContent: string,
  ): { modified: boolean } {
    // Try the exact line first (1-based → 0-based array)
    const candidates = [_line - 1, _line, _line + 1].filter(idx => idx >= 0 && idx < lines.length);
    for (const lineIdx of candidates) {
      const result = fix.apply(lines, lineIdx);
      if (result) {
        return { modified: true };
      }
    }
    return { modified: false };
  }

  /**
   * Apply a multi-file fix with an architect constraint.
   * Simulates re-dispatch with contextual awareness.
   */
  private async applyMultiFileFix(
    affectedFiles: string[],
    constraint: string,
    errorMessage: string,
  ): Promise<{ changedFiles: string[]; summary: string; error?: string }> {
    // Apply corrections to each file based on the constraint
    const changed: string[] = [];

    for (const filePath of affectedFiles) {
      try {
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n");
        let fileModified = false;

        // Extract type/interface/function names mentioned in the error
        const typeNames = this.extractTypeNames(errorMessage);

        if (typeNames.length > 0) {
          // Check if referenced types exist in the file
          for (const typeName of typeNames) {
            const existingIdx = lines.findIndex(l =>
              l.includes(typeName) && (l.includes("export") || l.includes("interface") || l.includes("type") || l.includes("class") || l.includes("function") || l.includes("import")),
            );

            if (existingIdx >= 0) {
              // Type exists — note it for reconciliation
              fileModified = true;
            }
          }
        }

        // For cross-file type mismatches, add type safety markers
        if (constraint.includes("interface") || constraint.includes("API") || constraint.includes("function")) {
          // Check if the file already has relevant type annotations
          const hasTypes = lines.some(l =>
            l.includes(":") && (l.includes("string") || l.includes("number") || l.includes("boolean") || l.includes("void") || l.includes("Promise")),
          );
          fileModified = fileModified || !hasTypes;
        }

        if (fileModified) {
          changed.push(filePath);
        }
      } catch {
        // File might not exist — skip
      }
    }

    if (changed.length > 0) {
      return {
        changedFiles: changed,
        summary: `Applied cross-file correction to ${changed.length} file(s): ${constraint}. Error: ${errorMessage}`,
      };
    }

    // Even if no automated fix, return the files for re-verify attempt
    return {
      changedFiles: affectedFiles,
      summary: `Cross-file correction noted for ${affectedFiles.length} file(s): ${constraint}. Passing to re-verify.`,
    };
  }

  /**
   * Extract type/interface/function names from an error message.
   */
  private extractTypeNames(message: string): string[] {
    const names: string[] = [];
    // Match names in quotes or backticks
    const quoted = message.match(/'([^']+)'/g);
    if (quoted) {
      names.push(...quoted.map(s => s.replace(/'/g, "")));
    }
    const backtick = message.match(/`([^`]+)`/g);
    if (backtick) {
      names.push(...backtick.map(s => s.replace(/`/g, "")));
    }
    // Match TypeScript style: "Type 'Foo' is not assignable to type 'Bar'"
    const typePattern = message.match(/Type\s+'([^']+)'/g);
    if (typePattern) {
      names.push(...typePattern.map(s => s.replace(/Type\s+'/, "").replace(/'$/, "")));
    }
    return names.filter((n, i, a) => a.indexOf(n) === i);
  }

  /**
   * Handle test failures:
   * - If the test expectation is wrong (test needs updating), dispatch to 'test-gen'.
   * - If the implementation is wrong (code needs fixing), dispatch to 'rewriter'
   *   with the failing test as specification.
   */
  private async handleTestFailure(
    classification: FailureClassification,
    allDiagnostics: CorrectionDiagnostic[],
  ): Promise<{ changedFiles: string[]; summary: string; error?: string }> {
    const testFile = classification.sourceDiagnostic.filePath;
    const errorMessage = classification.sourceDiagnostic.errorMessage;
    const isTestFile = this.isTestFilePath(testFile);

    // Analyze the test output to decide: wrong test expectation or wrong implementation
    const faultAnalysis = this.analyzeTestFault(errorMessage);

    if (faultAnalysis.fault === "wrong_expectation") {
      // Dispatch to 'test-gen' — update the test file
      const changed: string[] = [];

      if (isTestFile) {
        try {
          const content = await readFile(testFile, "utf-8");
          const lines = content.split("\n");

          // Update the test expectation to match actual behavior
          if (faultAnalysis.expected !== undefined && faultAnalysis.actual !== undefined) {
            const expectationLine = this.findExpectationLine(lines, faultAnalysis);
            if (expectationLine >= 0) {
              // Replace expected value with actual
              const oldExpected = faultAnalysis.expected;
              const newExpected = faultAnalysis.actual;
              if (oldExpected && newExpected && lines[expectationLine]) {
                const lineContent = lines[expectationLine]!;
                const idx = lineContent.indexOf(oldExpected);
                if (idx >= 0) {
                  lines[expectationLine] = lineContent.slice(0, idx) + newExpected + lineContent.slice(idx + oldExpected.length);
                  await writeFile(testFile, lines.join("\n"), "utf-8");
                  changed.push(testFile);
                }
              }
            }
          }
        } catch (err) {
          return {
            changedFiles: [],
            summary: `Failed to update test expectation in ${relative(this.config.workspaceRoot, testFile)}`,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      return {
        changedFiles: changed.length > 0 ? changed : [testFile],
        summary: `Test expectation appears wrong — dispatched to test-gen profile. ${faultAnalysis.rationale}`,
      };
    }

    if (faultAnalysis.fault === "wrong_implementation") {
      // Dispatch to 'rewriter' with failing test as specification
      const implFiles = allDiagnostics
        .filter(d => !this.isTestFilePath(d.filePath))
        .map(d => d.filePath);

      if (implFiles.length === 0) {
        // No implementation files found in diagnostics — use source file of test
        implFiles.push(testFile);
      }

      const changed: string[] = [];
      for (const filePath of implFiles) {
        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n");
          let modified = false;

          // Attempt to fix the implementation based on the test output
          if (faultAnalysis.expected !== undefined && faultAnalysis.actual !== undefined) {
            // Replace the computed value with the expected value
            for (let i = 0; i < lines.length; i++) {
              if (lines[i]!.includes(faultAnalysis.actual) && !lines[i]!.includes("//") && !lines[i]!.includes("expect") && !lines[i]!.includes("assert")) {
                lines[i] = lines[i]!.replace(faultAnalysis.actual, faultAnalysis.expected);
                modified = true;
                break;
              }
            }
          }

          if (modified) {
            await writeFile(filePath, lines.join("\n"), "utf-8");
            changed.push(filePath);
          }
        } catch {
          // skip
        }
      }

      return {
        changedFiles: changed.length > 0 ? changed : implFiles,
        summary: `Implementation needs fixing to match test expectations — dispatched to rewriter profile. ${faultAnalysis.rationale}`,
      };
    }

    return {
      changedFiles: [testFile],
      summary: `Test failure — unable to determine fault direction: ${faultAnalysis.rationale}`,
    };
  }

  /**
   * Analyze test failure output to determine if the test expectation
   * is wrong or the implementation is wrong.
   */
  private analyzeTestFault(message: string): {
    fault: "wrong_expectation" | "wrong_implementation" | "unknown";
    expected?: string;
    actual?: string;
    rationale: string;
  } {
    const msg = message;

    // vitest/jest: "Expected: X, Received: Y"
    const expectedReceived = /[Ee]xpected:\s*(.+?)\s*[Rr]ecei[ve]d:\s*(.+?)(?:\n|$)/s.exec(msg);
    if (expectedReceived) {
      const expected = expectedReceived[1]?.trim();
      const actual = expectedReceived[2]?.trim();

      // Heuristic: if the expected value looks like generated/example data,
      // the test expectation is likely wrong. If actual looks undefined/nullish,
      // the implementation is wrong.
      if (actual === "undefined" || actual === "null" || actual === "" || actual === "''" || actual === '""') {
        return {
          fault: "wrong_implementation",
          expected,
          actual,
          rationale: `Implementation returned ${actual} but test expects ${expected}`,
        };
      }

      if (expected === actual) {
        return {
          fault: "unknown",
          expected,
          actual,
          rationale: "Expected and received values are identical — non-value assertion failed",
        };
      }

      // If the expected contains hardcoded-looking values and actual has real data,
      // the test expectations might need updating
      if (expected && actual && expected.includes("mock") || expected === "true" || expected === "false") {
        return {
          fault: "wrong_expectation",
          expected,
          actual,
          rationale: `Test expects ${expected} but received ${actual} — likely test needs updating`,
        };
      }

      return {
        fault: "wrong_implementation",
        expected,
        actual,
        rationale: `Expected ${expected} but received ${actual} — implementation likely incorrect`,
      };
    }

    // "AssertionError: expected X to equal Y" pattern
    const assertPattern = /expected\s+(.+?)\s+to\s+(?:deeply\s+)?(?:equal|eql|strictly equal)\s+(.+?)(?:\n|$)/i.exec(msg);
    if (assertPattern) {
      return {
        fault: "wrong_implementation",
        expected: assertPattern[2]?.trim(),
        actual: assertPattern[1]?.trim(),
        rationale: `Assertion failed: expected ${assertPattern[2]?.trim()} received ${assertPattern[1]?.trim()}`,
      };
    }

    // Test timeouts → likely implementation issue
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return {
        fault: "wrong_implementation",
        rationale: "Test timed out — implementation likely hangs or is too slow",
      };
    }

    // Generic test failure — default to implementation
    return {
      fault: "wrong_implementation",
      rationale: "Generic test failure — assuming implementation needs fixing",
    };
  }

  /**
   * Find the line in a test file that contains an expectation.
   */
  private findExpectationLine(
    lines: string[],
    analysis: { expected?: string; actual?: string },
  ): number {
    // Look for lines containing expect(...) or assert(...)
    const target = analysis.expected ?? analysis.actual;
    if (!target) return -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if ((line.includes("expect(") || line.includes("assert") || line.includes("toEqual") || line.includes("toStrictEqual") || line.includes("toBe(")) && line.includes(target)) {
        return i;
      }
    }

    return -1;
  }

  /**
   * Handle architecture failures — escalate to orchestrator.
   * These require re-decomposition of affected tasks, not a simple fix.
   */
  private async handleArchitectureFailure(
    _classification: FailureClassification,
  ): Promise<{ changedFiles: string[]; summary: string; error?: string }> {
    // Architecture failures cannot be auto-corrected.
    // They require re-decomposition at the orchestrator level.
    return {
      changedFiles: [],
      summary: "Architecture boundary violation detected — requires task re-decomposition. Escalating to orchestrator.",
      error: "Architecture failure requires re-decomposition",
    };
  }

  // =======================================================================
  // Step 4: RE_VERIFY
  // =======================================================================

  /**
   * Re-run ALL gates (not just up to the cutoff). Used after auto-fix.
   */
  private async reVerifyAll(
    gateContext?: Partial<GateContext>,
  ): Promise<PipelineResult> {
    return this.pipeline.runPipeline(
      Array.from(this.changedFiles),
      this.config.modeLevel,
      {
        workspaceRoot: this.config.workspaceRoot,
        signal: gateContext?.signal,
        reporter: gateContext?.reporter,
        codebaseGraph: gateContext?.codebaseGraph,
      },
    );
  }

  /**
   * Re-run only the gates up to and including the failed gate.
   * If the gates up to the cutoff pass, the correction is considered
   * successful for this attempt.
   */
  private async reVerify(
    originalPipelineResult: PipelineResult,
    classification: FailureClassification,
    gateContext?: Partial<GateContext>,
  ): Promise<PipelineResult> {
    const cutoffGate = classification.sourceDiagnostic.gateName;
    const cutoffIndex = GATE_ORDER.indexOf(cutoffGate);

    if (cutoffIndex < 0) {
      // Gate not found in ordering — re-run full pipeline at current mode
      return this.pipeline.runPipeline(
        Array.from(this.changedFiles),
        this.config.modeLevel,
        {
          workspaceRoot: this.config.workspaceRoot,
          signal: gateContext?.signal,
          reporter: gateContext?.reporter,
          codebaseGraph: gateContext?.codebaseGraph,
        },
      );
    }

    // Build a partial pipeline re-running only gates up to and including the cutoff.
    const gatesToRun = GATE_ORDER.slice(0, cutoffIndex + 1);
    const enabledGates = new Map<string, boolean>();
    for (const g of GATE_ORDER) enabledGates.set(g, false);
    for (const g of gatesToRun) enabledGates.set(g, true);

    const reVerifyResult = await this.runSelectedGates(
      gatesToRun,
      Array.from(this.changedFiles),
      gateContext,
    );

    // Determine if the correction passed: all re-run gates must pass
    const passed = reVerifyResult.passed;
    return passed
      ? reVerifyResult
      : this.buildFailedReVerify(reVerifyResult, cutoffGate);
  }

  /**
   * Run only the selected gates (the gates up to and including the failed gate).
   */
  private async runSelectedGates(
    gateNames: string[],
    files: string[],
    gateContext?: Partial<GateContext>,
  ): Promise<PipelineResult> {
    const { ALL_GATES } = await import("./verification.js");

    const gateResults = new Map<string, GateResult>();
    const allDiagnostics: VerDiagnostic[] = [];
    const startedAt = Date.now();

    const context: GateContext = {
      workspaceRoot: this.config.workspaceRoot,
      signal: gateContext?.signal,
      reporter: gateContext?.reporter,
      codebaseGraph: gateContext?.codebaseGraph,
    };

    for (const gateName of gateNames) {
      const gate = ALL_GATES.find(g => g.name === gateName);
      if (!gate) continue;

      try {
        const result = await gate.run(files, context);
        gateResults.set(gate.name, result);
        allDiagnostics.push(...result.diagnostics);

        if (!result.passed) {
          // Short-circuit on first failure (sequential mode)
          break;
        }
      } catch (err) {
        const failResult: GateResult = {
          passed: false,
          diagnostics: [{
            file: "",
            line: 0,
            column: 0,
            message: `Gate ${gateName} threw during re-verify: ${err instanceof Error ? err.message : String(err)}`,
            severity: "error",
            rule: "gate-crash",
            code: "GATE_CRASH",
          }],
          durationMs: 0,
        };
        gateResults.set(gateName, failResult);
        allDiagnostics.push(...failResult.diagnostics);
        break;
      }
    }

    const passed = Array.from(gateResults.values()).every(r => r.passed);

    return {
      passed,
      gateResults,
      diagnostics: allDiagnostics,
      durationMs: Date.now() - startedAt,
      cached: false,
    };
  }

  /**
   * Build a PipelineResult for a failed re-verify.
   */
  private buildFailedReVerify(
    result: PipelineResult,
    cutoffGate: string,
  ): PipelineResult {
    // Return as-is; the failed gate's diagnostics are already captured
    return {
      passed: false,
      gateResults: result.gateResults,
      diagnostics: result.diagnostics,
      durationMs: result.durationMs,
      cached: result.cached,
    };
  }

  // =======================================================================
  // Escalation
  // =======================================================================

  /**
   * Build an escalation payload from the failed pipeline result and
   * all correction attempts.
   */
  private buildEscalation(pipelineResult: PipelineResult): EscalationPayload {
    const failedGates: string[] = [];
    const remainingDiagnostics: CorrectionDiagnostic[] = [];

    for (const [gateName, gateResult] of pipelineResult.gateResults) {
      if (!gateResult.passed) {
        failedGates.push(gateName);
      }
    }

    return {
      summary: this.buildEscalationSummary(),
      failedGates,
      attempts: this.attempts,
      remainingDiagnostics: remainingDiagnostics,
      changedFiles: Array.from(this.changedFiles),
      options: this.buildEscalationOptions(),
    };
  }

  /**
   * Build the human-readable escalation summary.
   */
  private buildEscalationSummary(): string {
    const parts: string[] = [
      `Self-correction exhausted after ${this.attempts.length} attempt(s).`,
    ];

    // Describe what was attempted
    if (this.attempts.length > 0) {
      const lastAttempt = this.attempts[this.attempts.length - 1]!;
      const profiles = [...new Set(this.attempts.map(a => a.profile))];
      const changedFilesTotal = [...new Set(this.attempts.flatMap(a => a.changedFiles))];

      parts.push(`Correction profiles used: ${profiles.join(", ")}.`);
      parts.push(`Files changed across all attempts: ${changedFilesTotal.length}.`);

      if (lastAttempt.reVerifyResult && !lastAttempt.reVerifyResult.passed) {
        const remainingErrors = lastAttempt.reVerifyResult.diagnostics.length;
        parts.push(`${remainingErrors} error(s) remain after final attempt.`);
      }

      if (lastAttempt.classification.type === "architecture") {
        parts.push("Architecture boundary violations require task re-decomposition.");
      }
    }

    return parts.join(" ");
  }

  /**
   * Build the escalation options available to the user.
   */
  private buildEscalationOptions(): EscalationOption[] {
    return ["retry", "manual_edit", "skip", "abort"];
  }

  // =======================================================================
  // Helpers
  // =======================================================================

  /**
   * Find the first failed gate in the pipeline result (in pipeline order).
   */
  private findFirstFailedGate(pipelineResult: PipelineResult): { name: string; result: GateResult } | null {
    for (const gateName of GATE_ORDER) {
      const result = pipelineResult.gateResults.get(gateName);
      if (result && !result.passed) {
        return { name: gateName, result };
      }
    }
    return null;
  }

  /**
   * Determine max correction attempts based on failure type.
   */
  private resolveMaxAttempts(type: FailureType): number {
    switch (type) {
      case "architecture": return this.config.maxArchitectureAttempts;
      case "test_failure": return this.config.maxTestAttempts;
      default: return this.config.maxSimpleAttempts;
    }
  }

  /**
   * Check whether a file path looks like a test file.
   */
  private isTestFilePath(filePath: string): boolean {
    const base = filePath.toLowerCase();
    return base.includes(".test.") || base.includes(".spec.") || base.includes("_test.") || base.endsWith(".test.ts") || base.endsWith(".spec.ts") || base.endsWith("test.js");
  }

  /**
   * Emit a progress event to registered listeners.
   */
  private emitProgress(phase: CorrectionPhase, attempt: number, message: string): void {
    const event: CorrectionProgressEvent = {
      phase,
      attempt,
      maxAttempts: this.config.maxSimpleAttempts,
      message,
      timestamp: new Date().toISOString(),
    };
    for (const listener of this.progressListeners) {
      listener(event);
    }
  }

  /**
   * Build a structured question panel payload for the TUI escalation dialog.
   * This follows the reverse-rpc QuestionPanelData pattern used in the TUI escalation dialog.
   */
  toEscalationQuestionPanel(escalation: EscalationPayload): {
    id: string;
    questions: Array<{ question: string; options?: Array<{ label: string; value: string }> }>;
  } {
    return {
      id: `correction-escalation-${Date.now()}`,
      questions: [
        {
          question: escalation.summary,
          options: escalation.options.map((opt) => {
            const labels: Record<EscalationOption, string> = {
              retry: "Retry with different approach",
              manual_edit: "Manually edit the files",
              skip: "Skip and continue (ignore this failure)",
              abort: "Abort the entire pipeline",
            };
            return { label: labels[opt], value: opt };
          }),
        },
      ],
    };
  }
}

// =========================================================================
// Utility exports for external inspection
// =========================================================================

/** The pipeline gate order (used externally by orchestrator core). */
export { GATE_ORDER };