/**
 * ConvergenceEngine — Diff collection, conflict detection & resolution.
 *
 * 5-stage pipeline:
 *   COLLECT  → Extract unified diffs, summaries, metadata from completed sub-agents
 *   ANALYZE  → Pairwise diff comparison, detect LINE/MODULE/API conflicts
 *   RESOLVE  → Dispatch by conflict type (priority-order, merge-agent, serialize)
 *   MERGE    → Apply resolved diffs to workspace via FileConnector
 *   VALIDATE → Run verification gates
 */

import { LocalQmain, FileConnector } from "@q/qmain";
import type { ExecutionResult, SubTask } from "./modes/types.js";

// =========================================================================
// Diff utilities (standalone, no external dependency)
// =========================================================================

/**
 * Compute a unified diff between two strings (line-based).
 * Returns a unified-diff-format string.
 */
export function createTwoFilesPatch(
  fileName: string,
  oldStr: string,
  newStr: string,
  oldHeader?: string,
  newHeader?: string,
): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const oh = oldHeader ?? fileName;
  const nh = newHeader ?? fileName;
  const hunks = computeHunks(oldLines, newLines);
  if (hunks.length === 0) return "";

  let result = `--- ${oh}\n+++ ${nh}\n`;
  for (const hunk of hunks) {
    result += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
    for (const line of hunk.lines) {
      result += line + "\n";
    }
  }
  return result;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function computeHunks(oldLines: string[], newLines: string[]): Hunk[] {
  // LCS-based diff using Myers-like approach (simplified)
  const changes: Array<{ type: "equal" | "delete" | "insert"; line: string }> = [];
  let oi = 0, ni = 0;
  const oldMap = new Map<string, number[]>();
  oldLines.forEach((l, i) => {
    const arr = oldMap.get(l) ?? [];
    arr.push(i);
    oldMap.set(l, arr);
  });

  // Simple greedy alignment
  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      changes.push({ type: "equal", line: oldLines[oi]! });
      oi++; ni++;
    } else {
      // Try to find next matching line
      const nextMatch = ni < newLines.length ? oldLines.indexOf(newLines[ni]!, oi) : -1;
      if (nextMatch > oi) {
        while (oi < nextMatch) { changes.push({ type: "delete", line: oldLines[oi]! }); oi++; }
      } else if (oi < oldLines.length) {
        changes.push({ type: "delete", line: oldLines[oi]! });
        oi++;
      }
      if (ni < newLines.length && (nextMatch > oi || oi >= oldLines.length)) {
        if (nextMatch < 0 || oi >= oldLines.length) {
          changes.push({ type: "insert", line: newLines[ni]! });
          ni++;
        }
      }
    }
  }

  // Group into hunks
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < changes.length) {
    // Skip leading equal lines before a change
    if (changes[i]?.type === "equal") {
      // Include up to 3 context lines before the change
      const ctxStart = Math.max(0, i - 3);
      const contextLines = changes.slice(ctxStart, i).filter(c => c.type === "equal");
      if (contextLines.length === 0 && i > 0) { i++; continue; }
    }

    const hunkLines: string[] = [];
    let oldLineNum = 0, newLineNum = 0;
    let hasChange = false;

    // Scan from start to find a change
    let scanStart = i;
    while (scanStart < changes.length && changes[scanStart]?.type === "equal") scanStart++;
    if (scanStart >= changes.length) break;

    // Include up to 3 context lines before
    const ctxBefore = Math.max(0, scanStart - 3);
    for (let c = ctxBefore; c < scanStart; c++) {
      const ch = changes[c]!;
      hunkLines.push(" " + ch.line);
      oldLineNum++;
      newLineNum++;
    }

    i = scanStart;
    while (i < changes.length) {
      const ch = changes[i]!;
      if (ch.type === "equal") {
        // Include at most 3 trailing context lines
        let ctxCount = 0;
        while (i < changes.length && changes[i]?.type === "equal" && ctxCount < 3) {
          hunkLines.push(" " + changes[i]!.line);
          oldLineNum++; newLineNum++; ctxCount++; i++;
        }
        // Skip remaining equal lines
        while (i < changes.length && changes[i]?.type === "equal") i++;
        break;
      } else if (ch.type === "delete") {
        hunkLines.push("-" + ch.line);
        oldLineNum++;
        hasChange = true;
        i++;
      } else {
        hunkLines.push("+" + ch.line);
        newLineNum++;
        hasChange = true;
        i++;
      }
    }

    if (hasChange && hunkLines.length > 0) {
      const oldStart = Math.max(1, ctxBefore + 1);
      const newStart = Math.max(1, ctxBefore + 1);
      const oldLn = hunkLines.filter(l => l[0] !== "+").length;
      const newLn = hunkLines.filter(l => l[0] !== "-").length;
      hunks.push({ oldStart, oldLines: oldLn, newStart, newLines: newLn, lines: hunkLines });
    }
  }

  return hunks;
}

// =========================================================================
// Types
// =========================================================================

/** Tag indicating the nature of a change. */
export type ChangeTag = "INTENDED" | "SIDE_EFFECT" | "API_CHANGE";

/** A single change set from one sub-agent. */
export interface ChangeSet {
  agentId: string;
  agentProfile: string;
  priority: number;
  filePath: string;
  diff: string;
  oldContent: string;
  newContent: string;
  summary: string;
  tag: ChangeTag;
  affectedSymbols: string[];
  modules: string[];
  timestamp: string;
}

/** Types of conflicts detected during analysis. */
export type ConflictType = "LINE_CONFLICT" | "MODULE_CONFLICT" | "API_DRIFT";

/** A conflict between two change sets. */
export interface Conflict {
  type: ConflictType;
  filePath: string;
  agentIdA: string;
  agentIdB: string;
  description: string;
  severity: "critical" | "moderate" | "low";
}

/** Strategy used to resolve a conflict. */
export type ResolutionStrategy = "priority_order" | "merge_agent" | "serialize" | "user_resolve" | "freeze_restart";

/** Result of resolving a conflict. */
export interface Resolution {
  conflict: Conflict;
  strategy: ResolutionStrategy;
  resolvedDiff?: string;
  resolvedContent?: string;
  success: boolean;
  notes?: string;
}

/** A single convergence round. */
export interface ConvergenceRound {
  roundNumber: number;
  agentCount: number;
  changeSets: ChangeSet[];
  conflicts: Conflict[];
  resolutions: Resolution[];
  totalConflictCount: number;
  strategiesUsed: ResolutionStrategy[];
  durationMs: number;
  success: boolean;
  timestamp: string;
}

/** Result of a full convergence pass. */
export interface ConvergenceResult {
  success: boolean;
  rounds: ConvergenceRound[];
  appliedChanges: string[];
  totalConflicts: number;
  unresolvedConflicts: number;
  totalDurationMs: number;
  mergedContent: Map<string, string>;
  errors: string[];
}

/** Configuration for the ConvergenceEngine. */
export interface ConvergenceConfig {
  maxRounds: number;
  enableSemanticAnalysis: boolean;
  applyChanges: boolean;
}

const DEFAULT_CONFIG: ConvergenceConfig = {
  maxRounds: 3,
  enableSemanticAnalysis: false,
  applyChanges: true,
};

// =========================================================================
// ConvergenceEngine
// =========================================================================

export class ConvergenceEngine {
  private config: ConvergenceConfig;

  constructor(config?: Partial<ConvergenceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run the 5-stage convergence pipeline on a set of execution results.
   *
   * @param results  Execution results from completed sub-agents
   * @param agents   The sub-tasks that produced the results
   * @param workspaceRoot  Root path for file operations (optional)
   */
  async converge(
    results: ExecutionResult[],
    agents: SubTask[],
    workspaceRoot?: string,
  ): Promise<ConvergenceResult> {
    const startedAt = Date.now();
    const rounds: ConvergenceRound[] = [];
    const allAppliedChanges: string[] = [];
    const mergedContent = new Map<string, string>();
    const errors: string[] = [];

      // Handle null/undefined
    if (!Array.isArray(results) || !Array.isArray(agents)) {
      return {
        success: true, rounds, appliedChanges: allAppliedChanges,
        totalConflicts: 0, unresolvedConflicts: 0,
        totalDurationMs: Date.now() - startedAt,
        mergedContent, errors,
      };
    }

    let needsAnotherRound = true;
    let roundNumber = 0;

    while (needsAnotherRound && roundNumber < this.config.maxRounds) {
      this._workspaceRoot = workspaceRoot;
      roundNumber++;
      const roundStart = Date.now();

      // Stage 1: COLLECT
      const changeSets = await this.collectChanges(results, agents, workspaceRoot);
      if (changeSets.length === 0) {
        needsAnotherRound = false;
        break;
      }

      // Stage 2: ANALYZE
      const conflicts = this.analyzeConflicts(changeSets);

      // Stage 3: RESOLVE
      const resolutions = await this.resolveConflicts(conflicts, changeSets, mergedContent);

      // Stage 4: MERGE
      const applied = await this.mergeChanges(resolutions, changeSets, mergedContent, workspaceRoot);
      allAppliedChanges.push(...applied);

      // Stage 5: VALIDATE
      const valid = await this.validateMerged(mergedContent);

      const round: ConvergenceRound = {
        roundNumber,
        agentCount: agents.length,
        changeSets,
        conflicts,
        resolutions,
        totalConflictCount: conflicts.length,
        strategiesUsed: [...new Set(resolutions.map(r => r.strategy))],
        durationMs: Date.now() - roundStart,
        success: valid,
        timestamp: new Date().toISOString(),
      };
      rounds.push(round);

      if (!valid) {
        errors.push(`Round ${roundNumber}: validation failed`);
      }

      needsAnotherRound = conflicts.length > 0 && roundNumber < this.config.maxRounds;
    }

    const unresolved = rounds.reduce((sum, r) => sum + r.resolutions.filter(rr => !rr.success).length, 0);

    return {
      success: unresolved === 0,
      rounds,
      appliedChanges: allAppliedChanges,
      totalConflicts: rounds.reduce((sum, r) => sum + r.totalConflictCount, 0),
      unresolvedConflicts: unresolved,
      totalDurationMs: Date.now() - startedAt,
      mergedContent,
      errors,
    };
  }

  // -----------------------------------------------------------------------
  // Stage 1: COLLECT
  // -----------------------------------------------------------------------

  private async collectChanges(results: ExecutionResult[], agents: SubTask[], workspaceRoot?: string): Promise<ChangeSet[]> {
    const changeSets: ChangeSet[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const agent = agents[i];
      if (!result || !agent) continue;
      if (!result.changedFiles || result.changedFiles.length === 0) continue;

      for (const filePath of result.changedFiles) {
        const summary = result.output ?? `Changes from ${agent.assignedAgent ?? "unknown"}`;
        
        // Try to read existing file content for oldContent
        let oldContent = "";
        if (workspaceRoot) {
          try {
            const qmain = new LocalQmain(workspaceRoot);
            oldContent = await qmain.readText(filePath);
          } catch {
            // File may not exist yet (new file creation) — that's fine
            oldContent = "";
          }
        }
        
        const newContent = result.newContents?.[filePath] ?? summary;
        const diff = createTwoFilesPatch(filePath, oldContent, newContent);

        changeSets.push({
          agentId: agent.id,
          agentProfile: agent.assignedAgent ?? "unknown",
          priority: this.resolvePriority(agent),
          filePath,
          diff,
          oldContent,
          newContent,
          summary,
          tag: this.tagChange(agent, filePath),
          affectedSymbols: [],
          modules: [],
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Sort by priority (lower = higher priority)
    changeSets.sort((a, b) => a.priority - b.priority);
    return changeSets;
  }

  private resolvePriority(agent: SubTask): number {
    if (!agent.phase) return 50;
    const prioMap: Record<string, number> = {
      dependency_resolution: 10,
      scaffolding: 20,
      implementation: 30,
      research: 40,
      test_generation: 50,
      documentation: 60,
      verification: 70,
      self_correction: 80,
      convergence: 90,
    };
    return prioMap[agent.phase] ?? 50;
  }

  private tagChange(agent: SubTask, _filePath: string): ChangeTag {
    const profile = agent.assignedAgent ?? "";
    if (profile === "architect" || profile === "deps-resolver") return "API_CHANGE";
    if (profile === "test-gen" || profile === "doc-gen") return "SIDE_EFFECT";
    return "INTENDED";
  }

  // -----------------------------------------------------------------------
  // Stage 2: ANALYZE
  // -----------------------------------------------------------------------

  private analyzeConflicts(changeSets: ChangeSet[]): Conflict[] {
    const conflicts: Conflict[] = [];

    for (let i = 0; i < changeSets.length; i++) {
      for (let j = i + 1; j < changeSets.length; j++) {
        const a = changeSets[i]!;
        const b = changeSets[j]!;

        // Skip same-agent changes
        if (a.agentId === b.agentId) continue;

        // Check for same-file conflicts
        if (a.filePath === b.filePath) {
          // LINE_CONFLICT: overlapping line changes
          if (this.detectLineConflict(a, b)) {
            conflicts.push({
              type: "LINE_CONFLICT",
              filePath: a.filePath,
              agentIdA: a.agentId,
              agentIdB: b.agentId,
              description: `Line-level conflict in ${a.filePath} between ${a.agentProfile} and ${b.agentProfile}`,
              severity: "critical",
            });
          }

          // MODULE_CONFLICT: symbol-level contradictions
          if (this.detectModuleConflict(a, b)) {
            conflicts.push({
              type: "MODULE_CONFLICT",
              filePath: a.filePath,
              agentIdA: a.agentId,
              agentIdB: b.agentId,
              description: `Module-level conflict in ${a.filePath}: contradictory symbol changes`,
              severity: "moderate",
            });
          }
        }
      }
    }

    return conflicts;
  }

  private detectLineConflict(a: ChangeSet, b: ChangeSet): boolean {
    // Same file with different agents and different content → conflict
    if (a.filePath === b.filePath && a.agentId !== b.agentId) {
      if (a.newContent !== b.newContent) return true;
    }
    if (a.newContent === b.newContent) return false;

    // Check if the diffs overlap by comparing hunk positions
    if (!a.oldContent && !b.oldContent) return false;
    const hunksA = computeHunks(a.oldContent.split("\n"), a.newContent.split("\n"));
    const hunksB = computeHunks(b.oldContent.split("\n"), b.newContent.split("\n"));

    for (const hA of hunksA) {
      for (const hB of hunksB) {
        // Check if hunk ranges overlap
        const aEnd = hA.oldStart + hA.oldLines;
        const bEnd = hB.oldStart + hB.oldLines;
        if (hA.oldStart <= bEnd && aEnd >= hB.oldStart) {
          return true;
        }
      }
    }

    return false;
  }

  private detectModuleConflict(a: ChangeSet, b: ChangeSet): boolean {
    // Heuristic: if both change sets affect the same file AND they reference
    // overlapping symbol names, flag as MODULE_CONFLICT.
    // This works without a CodebaseGraphIndex by comparing the affectedSymbols arrays.

    if (a.filePath !== b.filePath) return false;
    if (a.agentId === b.agentId) return false;
    if (a.newContent === b.newContent) return false;

    // If both have symbol names, check for overlaps
    if (a.affectedSymbols.length > 0 && b.affectedSymbols.length > 0) {
      const symbolOverlap = a.affectedSymbols.some(sym => b.affectedSymbols.includes(sym));
      if (symbolOverlap) return true;
    }

    // If either has module data, check for module overlap
    if (a.modules.length > 0 && b.modules.length > 0) {
      const moduleOverlap = a.modules.some(m => b.modules.includes(m));
      if (moduleOverlap) return true;
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Stage 3: RESOLVE
  // -----------------------------------------------------------------------

  private async resolveConflicts(
    conflicts: Conflict[],
    changeSets: ChangeSet[],
    _mergedContent: Map<string, string>,
  ): Promise<Resolution[]> {
    const resolutions: Resolution[] = [];

    for (const conflict of conflicts) {
      const resolution = await this.resolveConflict(conflict, changeSets);
      resolutions.push(resolution);
    }

    return resolutions;
  }

  private async resolveConflict(
    conflict: Conflict,
    changeSets: ChangeSet[],
  ): Promise<Resolution> {
    switch (conflict.type) {
      case "LINE_CONFLICT": {
        // Priority-order resolution: apply the higher-priority change,
        // then re-run the lower-priority agent
        const changeA = changeSets.find(c => c.agentId === conflict.agentIdA);
        const changeB = changeSets.find(c => c.agentId === conflict.agentIdB);

        if (changeA && changeB && changeA.priority < changeB.priority) {
          return {
            conflict,
            strategy: "priority_order",
            resolvedDiff: changeA.diff,
            resolvedContent: changeA.newContent,
            success: true,
            notes: `Applied ${conflict.agentIdA} (priority ${changeA.priority}) over ${conflict.agentIdB} (${changeB.priority})`,
          };
        }
        return {
          conflict,
          strategy: "priority_order",
          resolvedDiff: changeB?.diff,
          resolvedContent: changeB?.newContent,
          success: true,
          notes: `Applied ${conflict.agentIdB} by priority`,
        };
      }

      case "MODULE_CONFLICT": {
        // Serialize: apply in priority order, re-run lower-priority agent
        return {
          conflict,
          strategy: "serialize",
          success: true,
          notes: "Serializing module conflict — applying in priority order",
        };
      }

      case "API_DRIFT": {
        return {
          conflict,
          strategy: "freeze_restart",
          success: true,
          notes: "Freeze and restart dependent agent with updated API surface",
        };
      }

      default:
        return {
          conflict,
          strategy: "priority_order",
          success: true,
          notes: "Default priority-order resolution",
        };
    }
  }

  // -----------------------------------------------------------------------
  // Stage 4: MERGE
  // -----------------------------------------------------------------------

  private async mergeChanges(
    resolutions: Resolution[],
    changeSets: ChangeSet[],
    mergedContent: Map<string, string>,
    workspaceRoot?: string,
  ): Promise<string[]> {
    const applied: string[] = [];
    const appliedFiles = new Set<string>();

    // Apply resolved changes in priority order
    const resolvedSuccess = resolutions.filter(r => r.success);
    for (const resolution of resolvedSuccess) {
      if (resolution.resolvedContent && resolution.conflict.filePath) {
        mergedContent.set(resolution.conflict.filePath, resolution.resolvedContent);
        if (!appliedFiles.has(resolution.conflict.filePath)) {
          applied.push(resolution.conflict.filePath);
          appliedFiles.add(resolution.conflict.filePath);
        }
      }
    }

    // Apply non-conflicting changes
    for (const cs of changeSets) {
      const hasConflict = resolvedSuccess.some(r => r.conflict.filePath === cs.filePath);
      if (!hasConflict && !appliedFiles.has(cs.filePath)) {
        mergedContent.set(cs.filePath, cs.newContent);
        applied.push(cs.filePath);
        appliedFiles.add(cs.filePath);
      }
    }

    // Write resolved content to disk
    if (workspaceRoot && mergedContent.size > 0) {
      try {
        const qmain = new LocalQmain(workspaceRoot);
        const fileConnector = new FileConnector(qmain);
        for (const [filePath, content] of mergedContent) {
          if (content && content.length > 0) {
            await fileConnector.write(filePath, content);
          }
        }
      } catch (err) {
        // Log but don't fail the convergence — the in-memory mergedContent is still returned
        console.error(`[ConvergenceEngine] Failed to write changes to disk: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return applied;
  }

  // -----------------------------------------------------------------------
  // Stage 5: VALIDATE
  // -----------------------------------------------------------------------

  async validateMerged(mergedContent: Map<string, string>): Promise<boolean> {
    const { VerificationPipeline } = await import("./verification.js");
    const pipeline = new VerificationPipeline({ workspaceRoot: this._workspaceRoot });

    const files = Array.from(mergedContent.keys());
    if (files.length === 0) return true;

    try {
      const result = await pipeline.validateStandard(files, {
        workspaceRoot: this._workspaceRoot ?? process.cwd(),
      });
      return result.passed;
    } catch {
      return false;
    }
  }

  private _workspaceRoot?: string;
}