/**
 * MediumCampaignMode — Orchestrated multi-wave campaign with convergence and quality gates.
 *
 * Core philosophy: "decompose, wave-dispatch, converge after each wave, verify at Level 2."
 *
 * MediumCampaignMode sits between SpeedCampaignMode (pure parallel) and HighCampaignMode
 * (continuous loops). It implements the full wave-based orchestration pipeline:
 *
 *   1. generateTaskGraph()  — Decompose the task intent into a TaskGraph with ordered waves
 *   2. executeWave()        — Dispatch each wave sequentially through the SubAgentPoolManager
 *   3. runConvergence()     — Run the ConvergenceEngine AFTER each wave to merge results
 *   4. runVerification()    — Run Level 2 gates (syntax + lint + typecheck + unit tests)
 *                             after all waves complete. On failure, initiates self-correction
 *                             via SelfCorrectionCycle with auto-fix.
 *
 * Rich progress events are emitted to the TUI throughout the lifecycle.
 */

import { ExecutionModeHandler } from "./handler.js";
import { ExecutionModes } from "./index.js";
import type { ExecutionMode } from "./index.js";
import type { Task, ExecutionResult, SubTask } from "./types.js";
import type { OrchestratorCore } from "../core.js";
import type { SubAgentHandle, SubAgentPoolManager } from "../pool.js";
import { runAgentTurn } from "../../agent/wiring.js";
import type { TaskGraph, Wave, WaveResult, TaskGraphNode, WorkspaceTopologyInfo } from "../taskgraph.js";
import type { IntentProfile } from "../intent.js";
import type { ConvergenceResult } from "../convergence.js";
import { SyntaxCheckGate, LintCheckGate, TypeCheckGate } from "../verification.js";
import type { Diagnostic, GateResult, PipelineResult, GateContext } from "../verification.js";
import { SelfCorrectionCycle } from "../correction.js";
import type { CorrectionResult } from "../correction.js";
import { resolve } from "node:path";

// =========================================================================
// VerificationResult
// =========================================================================

/**
 * Rich result returned by runVerification().
 *
 * Contains the pass/fail status, optional diagnostics from failed gates,
 * and the full per-gate results map so callers can inspect individual
 * gate outcomes for reporting or escalation.
 */
export interface VerificationResult {
  /** True if all Level 2 gates (and any correction cycle) passed. */
  passed: boolean;
  /** Aggregated diagnostics from all gates that produced errors. */
  diagnostics?: Diagnostic[];
  /** Per-gate results keyed by gate name. */
  gateResults?: Map<string, GateResult>;
  /** True if a self-correction cycle was triggered and executed. */
  correctionApplied?: boolean;
  /** Number of correction attempts made (0 if no correction was needed). */
  correctionAttempts?: number;
}

// =========================================================================
// WaveCompletionState
// =========================================================================

/**
 * Internal state accumulated as waves are executed and converged.
 */
interface WaveCompletionState {
  /** Aggregated changed files across all waves so far. */
  changedFiles: Set<string>;
  /** Aggregated new file contents across all waves (path → content). */
  newContents: Map<string, string>;
  /** Wave results keyed by wave index. */
  waveResults: Map<number, WaveResult>;
  /** One ExecutionResult per wave, not per individual sub-task. */
  subResults: ExecutionResult[];
  /** Error messages accumulated so far. */
  errors: string[];
  /** Total tokens consumed so far. */
  totalTokens: number;
  /** Total LLM calls made so far. */
  llmCallCount: number;
  /** Total tool calls made so far. */
  toolCallCount: number;
}

// =========================================================================
// MediumCampaignMode
// =========================================================================

export class MediumCampaignMode extends ExecutionModeHandler {
  readonly mode: ExecutionMode = ExecutionModes.MEDIUM_CAMPAIGN;
  readonly description = "Medium campaign — orchestrated multi-wave campaign with convergence and quality gates";

  /** Internal state tracker to preserve across method calls. */
  private state: WaveCompletionState = this.freshState();

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Execute the given task using the medium-campaign strategy.
   *
   * Full pipeline:
   *   1. Decompose task into a TaskGraph with ordered waves
   *   2. For each wave:
   *      a. Execute wave (dispatch sub-tasks through SubAgentPoolManager)
   *      b. Run convergence on wave results
   *   3. Run Level 2 verification (syntax + lint + typecheck + unit tests).
   *      On failure, self-correction is automatically initiated.
   *   4. Return aggregated ExecutionResult.
   */
  async execute(task: Task, orchestrator: OrchestratorCore): Promise<ExecutionResult> {
    const startedAt = Date.now();
    this.state = this.freshState();

    // ── Emit campaign started event ──────────────────────────────────────
    orchestrator.recordAgentEvent({
      type: "medium-campaign.started",
      taskId: task.id,
      prompt: task.prompt.slice(0, 200),
    });

    try {
      // ── Step 1: Generate TaskGraph ─────────────────────────────────────
      orchestrator.recordAgentEvent({
        type: "medium-campaign.decomposing",
        taskId: task.id,
      });

      const graph = await this.generateTaskGraph(task, orchestrator);

      orchestrator.recordAgentEvent({
        type: "medium-campaign.graph-ready",
        taskId: task.id,
        totalWaves: graph.waves.length,
        totalNodes: graph.nodes.length,
        estimatedTotalWaves: graph.estimatedTotalWaves,
        estimatedTotalTasks: graph.estimatedTotalTasks,
      });

      // ── Step 2: Execute each wave sequentially ─────────────────────────
      orchestrator.recordAgentEvent({
        type: "medium-campaign.wave-execution-starting",
        taskId: task.id,
        totalWaves: graph.waves.length,
      });

      for (const wave of graph.waves) {
        if (wave.taskIds.length === 0) continue;

        // Step 2a: Execute the wave (emits its own started/completed events)
        const waveResult = await this.executeWave(wave, graph, orchestrator);
        this.state.waveResults.set(wave.index, waveResult);

        // Accumulate results
        this.accumulateWaveResult(waveResult);

        // Step 2b: Run convergence after wave if required
        if (wave.convergeAfter) {
          await this.runConvergence(waveResult, orchestrator);
        }

        // Check if we should abort (e.g. wave failure or cancellation)
        if (orchestrator.getAbortSignal().aborted) {
          orchestrator.recordAgentEvent({
            type: "medium-campaign.aborted",
            waveIndex: wave.index,
            reason: "Abort signal received",
          });
          return this.buildAbortedResult(task, startedAt);
        }
      }

      orchestrator.recordAgentEvent({
        type: "medium-campaign.wave-execution-complete",
        taskId: task.id,
        totalWavesCompleted: this.state.waveResults.size,
      });

      // ── Step 3: Run Level 2 verification (with self-correction) ─────────
      const changedFilesArray = Array.from(this.state.changedFiles);
      let verificationResult: VerificationResult;

      if (changedFilesArray.length > 0) {
        verificationResult = await this.runVerification(changedFilesArray, orchestrator);

        orchestrator.recordAgentEvent({
          type: verificationResult.passed
            ? "medium-campaign.verification.passed"
            : "medium-campaign.verification.failed",
          fileCount: changedFilesArray.length,
          correctionApplied: verificationResult.correctionApplied ?? false,
          correctionAttempts: verificationResult.correctionAttempts ?? 0,
        });
      } else {
        verificationResult = { passed: true };
        orchestrator.recordAgentEvent({
          type: "medium-campaign.verification.skipped",
          reason: "No files changed",
        });
      }

      // ── Build the final result ─────────────────────────────────────────
      const duration = Date.now() - startedAt;
      const allTasksSuccess = this.state.errors.length === 0;
      const success = allTasksSuccess && verificationResult.passed;

      // Build the output string (structured)
      const structuredOutput = this.buildOutput(task, success, verificationResult.passed, duration);

      // ── Generate LLM summary on success ───────────────────────────────
      let output = structuredOutput;
      if (success && orchestrator.rootAgent) {
        try {
          const llmSummary = await this.generateSummary(
            task,
            changedFilesArray,
            structuredOutput,
            orchestrator,
          );
          if (llmSummary) {
            output = llmSummary;
          }
        } catch {
          // Best-effort — fall back to structured output
        }
      }

      orchestrator.recordAgentEvent({
        type: "medium-campaign.completed",
        success,
        duration,
        waveCount: this.state.waveResults.size,
        changedFileCount: this.state.changedFiles.size,
        totalTokens: this.state.totalTokens,
        llmCallCount: this.state.llmCallCount,
        toolCallCount: this.state.toolCallCount,
        correctionApplied: verificationResult.correctionApplied ?? false,
        correctionAttempts: verificationResult.correctionAttempts ?? 0,
      });

      // ── Metrics aggregation per spec ────────────────────────────────────
      // totalTokens:   sum across all task results (already accumulated)
      // llmCallCount:  number of tasks + 1 (graph generation)
      // toolCallCount: sum across all task results (already accumulated)
      // changedFiles:  deduplicated union of all wave changed files
      // subResults:    one ExecutionResult per wave
      // errors:        all errors from waves, convergence, and verification
      const llmCallCountFinal = this.state.llmCallCount + 1; // +1 for graph generation

      return {
        success,
        mode: this.mode,
        taskId: task.id,
        output,
        error: success
          ? undefined
          : this.buildErrorSummary(verificationResult.passed, verificationResult.diagnostics),
        totalTokens: this.state.totalTokens,
        llmCallCount: llmCallCountFinal,
        toolCallCount: this.state.toolCallCount,
        durationMs: duration,
        changedFiles: changedFilesArray,
        verificationPassed: verificationResult.passed,
        subResults: this.state.subResults.length > 0 ? this.state.subResults : undefined,
        errors: this.state.errors.length > 0 ? this.state.errors : undefined,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      const duration = Date.now() - startedAt;
      const errorMsg = error instanceof Error ? error.message : String(error);

      orchestrator.recordAgentEvent({
        type: "medium-campaign.completed",
        success: false,
        duration,
        error: errorMsg,
        taskId: task.id,
      });

      return {
        success: false,
        mode: this.mode,
        taskId: task.id,
        error: errorMsg,
        totalTokens: this.state.totalTokens,
        llmCallCount: this.state.llmCallCount + 1, // +1 for graph generation
        toolCallCount: this.state.toolCallCount,
        durationMs: duration,
        output: `Medium campaign failed after ${this.state.waveResults.size} wave(s): ${errorMsg}`,
        subResults: this.state.subResults.length > 0 ? this.state.subResults : undefined,
        errors: [errorMsg, ...this.state.errors],
        completedAt: new Date().toISOString(),
      };
    }
  }

  // =========================================================================
  // Step 1: generateTaskGraph — Decompose the task into a TaskGraph
  // =========================================================================

  /**
   * Generate a TaskGraph from the task's intent profile using the TaskDecomposer.
   *
   * Strategy:
   *   1. If the task provides a `profile` (IntentProfile), use it directly.
   *      Otherwise, run the IntentClassifier to derive one from the prompt.
   *   2. Pass the profile to `orchestrator.taskDecomposer.decompose()` to
   *      produce the TaskGraph with ordered waves.
   *   3. If the workspace topology is available on the orchestrator, include
   *      it so the decomposer can generate nodes scoped to actual modules/files.
   *
   * Edge cases:
   *   - Empty prompt → single-wave graph with a single "implement" node
   *   - No profile available → a minimal default graph with one wave
   *   - No taskDecomposer on orchestrator → fallback minimal graph
   *
   * @param task         The task to decompose
   * @param orchestrator The orchestrator core
   * @returns A fully-constructed TaskGraph
   */
  private async generateTaskGraph(
    task: Task,
    orchestrator: OrchestratorCore,
  ): Promise<TaskGraph> {
    const prompt = task.prompt.trim();

    // ── Edge case: empty prompt ────────────────────────────────────────────
    if (!prompt) {
      return {
        nodes: [
          {
            id: `${task.id}-node-0`,
            profile: "rewriter",
            prompt: "Execute the task",
            dependsOn: [],
            priority: 0,
            estimatedComplexity: 1,
            wave: 0,
            timeout: 300_000,
            verificationRequired: false,
            outputSpec: {},
          },
        ],
        waves: [
          {
            index: 0,
            phase: "implement",
            taskIds: [`${task.id}-node-0`],
            convergeAfter: true,
            gates: [],
          },
        ],
        intentProfile: task.profile ?? {
          scope: "single_file",
          depth: "moderate",
          confidence: 1.0,
          estimatedFiles: 1,
          estimatedTurns: 5,
          requiresParallel: false,
          requiresResearch: false,
          requiresVerification: false,
          hasArchitecturalImpact: false,
        },
        estimatedTotalTasks: 1,
        estimatedTotalWaves: 1,
      };
    }

    // ── Step 1: Resolve the intent profile ────────────────────────────────
    // If the task already carries a profile, use it directly.
    // Otherwise, derive one by running the IntentClassifier.
    let profile: IntentProfile;
    if (task.profile) {
      profile = task.profile;
    } else {
      try {
        const classification = orchestrator.intentClassifier.classify(prompt, {
          activeDecisions: [],
        });
        profile = classification.profile;
      } catch (classifyErr) {
        // If classification itself fails, use a sensible default
        const errorMsg = classifyErr instanceof Error ? classifyErr.message : String(classifyErr);
        orchestrator.recordAgentEvent({
          type: "medium-campaign.classification-fallback",
          error: errorMsg,
        });
        profile = {
          scope: "module",
          depth: "moderate",
          confidence: 0.5,
          estimatedFiles: 3,
          estimatedTurns: 8,
          requiresParallel: false,
          requiresResearch: false,
          requiresVerification: true,
          hasArchitecturalImpact: false,
        };
        // Copy onto the task so downstream callers can also see it
        (task as unknown as { profile: IntentProfile }).profile = profile;
      }
    }

    // ── Step 2: Build topology info from workspace ────────────────────────
    // Construct a minimal WorkspaceTopologyInfo using modules heuristically
    // derived from the profile's scope. This provides the TaskDecomposer with
    // enough context to generate meaningful wave assignments even without a
    // full WorkspaceTopology scan. In a future enhancement, this could use the
    // real `WorkspaceTopology` from `../topology.js`.
    const topologyInfo = await this.buildTopologyInfo(profile, orchestrator);

    // ── Step 3: Decompose ─────────────────────────────────────────────────
    let graph: TaskGraph;
    if (orchestrator.taskDecomposer) {
      try {
        graph = orchestrator.taskDecomposer.decompose(profile, topologyInfo);
      } catch (decomposeErr) {
        const errorMsg = decomposeErr instanceof Error ? decomposeErr.message : String(decomposeErr);
        orchestrator.recordAgentEvent({
          type: "medium-campaign.decomposition-error",
          error: errorMsg,
        });
        // Fallback: build a single-wave graph wrapping the full prompt
        graph = this.buildFallbackGraph(task, prompt, profile);
      }
    } else {
      // No TaskDecomposer available — use the fallback
      graph = this.buildFallbackGraph(task, prompt, profile);
    }

    // Ensure all nodes have the required fields populated
    const normalizedNodes = graph.nodes.map((n) => ({
      ...n,
      timeout: n.timeout ?? 300_000,
      verificationRequired: n.verificationRequired ?? true,
      outputSpec: n.outputSpec ?? {},
    }));
    graph = { ...graph, nodes: normalizedNodes };

    // ── Step 4: Emit the generated event ──────────────────────────────────
    orchestrator.recordAgentEvent({
      type: "medium-campaign.graph.generated",
      waveCount: graph.waves.length,
      taskCount: graph.nodes.length,
      estimatedTotalWaves: graph.estimatedTotalWaves,
      estimatedTotalTasks: graph.estimatedTotalTasks,
    });

    return graph;
  }

  /**
   * Build a heuristic WorkspaceTopologyInfo from the profile scope and
   * the workspace root directory.
   *
   * Strategy:
   *   1. Derive module names from the profile's scope (single_file → ["main"],
   *      module → ["core"], cross_cutting → ["core","api","data"], etc.)
   *   2. Optionally scan the workspace root for top-level src/ or lib/
   *      directories to discover real module names (best-effort; on failure
   *      we fall back to the heuristic list).
   *   3. Return a WorkspaceTopologyInfo with modules, an empty files array,
   *      and an empty dependencies array — the TaskDecomposer's own module
   *      inference is sufficient for the medium-campaign flow.
   *
   * @param profile       The resolved IntentProfile
   * @param orchestrator  The orchestrator core (for workspaceRoot)
   * @returns A WorkspaceTopologyInfo suitable for the TaskDecomposer
   */
  private async buildTopologyInfo(
    profile: IntentProfile,
    orchestrator: OrchestratorCore,
  ): Promise<WorkspaceTopologyInfo> {
    // ── Derive a heuristic module list from the profile scope ─────────────
    let modules: string[];
    switch (profile.scope) {
      case "single_file":
        modules = ["main"];
        break;
      case "multi_file":
        modules = ["module-a", "module-b"];
        break;
      case "module":
        modules = ["core"];
        break;
      case "cross_cutting":
        modules = ["core", "api", "data"];
        break;
      case "codebase_gen":
        modules = ["core", "api", "utils"];
        break;
      default:
        modules = ["core", "api", "utils"];
    }

    // ── Best-effort workspace scan for top-level source directories ───────
    const workspaceRoot = orchestrator.workspaceRoot || process.cwd();
    const sourceDirCandidates = ["src", "lib", "packages", "app"];
    const discoveredModules: string[] = [];

    try {
      const { readdir, stat } = await import("node:fs/promises");
      const { resolve } = await import("node:path");

      for (const dir of sourceDirCandidates) {
        const fullPath = resolve(workspaceRoot, dir);
        try {
          const dirStat = await stat(fullPath);
          if (dirStat.isDirectory()) {
            const entries = await readdir(fullPath, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                discoveredModules.push(entry.name);
              }
            }
            // If we found something under src/lib, stop looking at top-level dirs
            if (discoveredModules.length > 0) break;
          }
        } catch {
          // Directory doesn't exist — try the next candidate
        }
      }
    } catch {
      // File-system scanning failed — that's fine, we'll use heuristic defaults
    }

    // If we discovered real modules, prefer them over the heuristic list
    if (discoveredModules.length > 0) {
      modules = discoveredModules;
    }

    return {
      modules,
      files: [],
      dependencies: [],
    };
  }

  /**
   * Build a minimal fallback TaskGraph with a single wave wrapping the
   * full prompt. Used when the TaskDecomposer is unavailable or throws.
   *
   * @param task    The original task (for its id)
   * @param prompt  The trimmed prompt
   * @param profile The resolved IntentProfile
   * @returns A single-wave TaskGraph
   */
  private buildFallbackGraph(
    task: Task,
    prompt: string,
    profile: IntentProfile,
  ): TaskGraph {
    return {
      nodes: [
        {
          id: `${task.id}-node-0`,
          profile: "rewriter",
          prompt,
          dependsOn: [],
          priority: 0,
          estimatedComplexity: 1,
          wave: 0,
          timeout: 300_000,
          verificationRequired: true,
          outputSpec: {},
        },
      ],
      waves: [
        {
          index: 0,
          phase: "implement",
          taskIds: [`${task.id}-node-0`],
          convergeAfter: true,
          gates: [],
        },
      ],
      intentProfile: profile,
      estimatedTotalTasks: 1,
      estimatedTotalWaves: 1,
    };
  }

  // =========================================================================
  // Step 2: executeWave — Dispatch a single wave through the pool manager
  // =========================================================================

  /**
   * Execute a single wave by dispatching all its sub-tasks through the
   * SubAgentPoolManager and collecting results.
   *
   * Strategy:
   *   1. Get all task nodes in this wave: `graph.nodes.filter(n => wave.taskIds.includes(n.id))`
   *   2. Convert nodes to SubTasks using waveTasksToSubTasks()
   *   3. Dispatch all sub-tasks through `orchestrator.poolManager.schedule()`
   *   4. Wait for all to complete using waitForTaskCompletion + Promise.allSettled
   *   5. Collect changed files from completed results
   *   6. Return WaveResult with task results, success flag, and errors
   *
   * Emits events:
   *   - { type: "medium-campaign.wave.started", waveIndex, phase, taskCount }
   *   - { type: "medium-campaign.wave.completed", waveIndex, success, errors }
   *
   * If no pool manager is available, falls back to sequential execution
   * via the root agent (mirroring SpeedCampaignMode's pattern).
   *
   * @param wave         The wave to execute
   * @param graph        The full TaskGraph for context
   * @param orchestrator The orchestrator core
   * @returns A WaveResult with per-task outcomes
   */
  private async executeWave(
    wave: Wave,
    graph: TaskGraph,
    orchestrator: OrchestratorCore,
  ): Promise<WaveResult> {
    const startedAt = Date.now();
    const taskResults = new Map<string, ExecutionResult>();
    const errors: string[] = [];

    // ── Step 1: Get all task nodes in this wave ──────────────────────────
    const nodes = graph.nodes.filter((n): n is TaskGraphNode => wave.taskIds.includes(n.id));

    if (nodes.length === 0) {
      orchestrator.recordAgentEvent({
        type: "medium-campaign.wave.started",
        waveIndex: wave.index,
        phase: wave.phase,
        taskCount: 0,
      });
      orchestrator.recordAgentEvent({
        type: "medium-campaign.wave.completed",
        waveIndex: wave.index,
        success: true,
        errors: [],
      });
      return {
        waveIndex: wave.index,
        taskResults,
        success: true,
        errors: [],
        durationMs: 0,
      };
    }

    // ── Emit wave started event ──────────────────────────────────────────
    orchestrator.recordAgentEvent({
      type: "medium-campaign.wave.started",
      waveIndex: wave.index,
      phase: wave.phase,
      taskCount: nodes.length,
    });

    // ── Step 2: Convert nodes to SubTasks ────────────────────────────────
    const subTasks = this.waveTasksToSubTasks(nodes, graph);

    // ── Fallback: no pool manager → sequential execution via root agent ──
    if (!orchestrator.poolManager) {
      await this.executeWaveSequentialFallback(nodes, wave, orchestrator, taskResults, errors);
      const waveResult: WaveResult = {
        waveIndex: wave.index,
        taskResults,
        success: errors.length === 0,
        errors,
        durationMs: Date.now() - startedAt,
      };
      // Collect changed files from the fallback results
      this.collectChangedFilesFromResults(waveResult);
      orchestrator.recordAgentEvent({
        type: "medium-campaign.wave.completed",
        waveIndex: wave.index,
        success: waveResult.success,
        errors: waveResult.errors.length > 0 ? waveResult.errors : undefined,
      });
      return waveResult;
    }

    // ── Step 3: Dispatch all sub-tasks through the pool manager ──────────
    const completionPromises: Promise<ExecutionResult>[] = [];

    for (const st of subTasks) {
      // Emit sub-task started event
      orchestrator.recordAgentEvent({
        type: "medium-campaign.subtask.started",
        waveIndex: wave.index,
        nodeId: st.id,
        description: st.description.slice(0, 150),
      });

      // Schedule the sub-task
      orchestrator.poolManager.schedule(st as SubTask);

      // Create a completion promise
      completionPromises.push(
        this.waitForTaskCompletion(orchestrator.poolManager, st.id).then((result) => {
          taskResults.set(st.id, result);

          // Record metrics
          orchestrator.recordToolCall(result.success, result.totalTokens ?? 0);
          orchestrator.recordTurn();

          // Emit completion or failure event
          if (result.success) {
            orchestrator.recordAgentEvent({
              type: "medium-campaign.subtask.completed",
              waveIndex: wave.index,
              nodeId: st.id,
              success: true,
            });
          } else {
            const errMsg = result.error ?? `Task ${st.id} failed`;
            orchestrator.recordAgentEvent({
              type: "medium-campaign.subtask.failed",
              waveIndex: wave.index,
              nodeId: st.id,
              error: errMsg,
            });
            errors.push(errMsg);
          }

          return result;
        }),
      );
    }

    // ── Step 4: Wait for all to complete ─────────────────────────────────
    const settled = await Promise.allSettled(completionPromises);

    // Handle any unexpected rejections (defensive — waitForTaskCompletion
    // should always resolve, but handle edge cases)
    for (let i = 0; i < settled.length; i++) {
      const settledItem = settled[i]!;
      if (settledItem.status !== "rejected") continue;
      const st = subTasks[i];
      if (!st || taskResults.has(st.id)) continue;

      const reason = settledItem.reason instanceof Error
        ? settledItem.reason.message
        : String(settledItem.reason);

      const failResult: ExecutionResult = {
        success: false,
        mode: this.mode,
        taskId: st.id,
        error: reason,
        completedAt: new Date().toISOString(),
      };

      taskResults.set(st.id, failResult);
      errors.push(reason);

      orchestrator.recordToolCall(false, 0);
      orchestrator.recordTurn();

      orchestrator.recordAgentEvent({
        type: "medium-campaign.subtask.failed",
        waveIndex: wave.index,
        nodeId: st.id,
        error: reason,
      });
    }

    // ── Step 5: Collect changed files from completed results ──────────
    const waveResult: WaveResult = {
      waveIndex: wave.index,
      taskResults,
      success: errors.length === 0,
      errors,
      durationMs: Date.now() - startedAt,
    };
    this.collectChangedFilesFromResults(waveResult);

    // ── Emit wave completed event ────────────────────────────────────────
    orchestrator.recordAgentEvent({
      type: "medium-campaign.wave.completed",
      waveIndex: wave.index,
      success: waveResult.success,
      errors: waveResult.errors.length > 0 ? waveResult.errors : undefined,
    });

    return waveResult;
  }

  // =========================================================================
  // Helpers for executeWave
  // =========================================================================

  /**
   * Convert TaskGraph nodes into SubTasks for the pool manager.
   *
   * Mirrors the same conversion pattern used by `TaskDecomposer.waveTasksToSubTasks()`
   * but adapted for the MediumCampaignMode's context.
   *
   * Each node becomes a SubTask with:
   *   - id: the node's ID
   *   - parentTaskId: derived from the graph's intent profile scope
   *   - description: the node's prompt
   *   - phase: mapped from the node's phase or wave index
   *   - dependencies: non-empty dependent IDs
   *   - assignedAgent: the node's profile
   *   - status: "pending"
   *
   * @param nodes - The TaskGraphNodes belonging to the current wave
   * @param graph - The full TaskGraph (used for intent profile context)
   * @returns An array of SubTask-compatible objects
   */
  private waveTasksToSubTasks(
    nodes: TaskGraphNode[],
    graph: TaskGraph,
  ): Array<Omit<SubTask, "result">> {
    return nodes.map((node) => ({
      id: node.id,
      parentTaskId: "medium-campaign-" + graph.intentProfile.scope,
      description: node.prompt,
      phase: this.nodePhaseToTaskPhase(node),
      dependencies: node.dependsOn.length > 0 ? node.dependsOn : undefined,
      assignedAgent: node.profile,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    }));
  }

  /**
   * Collect changed files from all completed task results in a WaveResult.
   *
   * Iterates through every ExecutionResult in the wave's taskResults map
   * and adds any reported changedFiles to the associated wave result's
   * output structure.
   *
   * @param waveResult - The WaveResult to scan for changed files
   */
  private collectChangedFilesFromResults(waveResult: WaveResult): void {
    for (const [, result] of waveResult.taskResults) {
      if (result.changedFiles && result.changedFiles.length > 0) {
        for (const file of result.changedFiles) {
          this.state.changedFiles.add(file);
        }
      }
    }
  }

  /**
   * Fallback for executeWave: run nodes sequentially through the root agent
   * when no pool manager is available.
   */
  private async executeWaveSequentialFallback(
    nodes: TaskGraphNode[],
    wave: Wave,
    orchestrator: OrchestratorCore,
    taskResults: Map<string, ExecutionResult>,
    errors: string[],
  ): Promise<void> {
    for (const node of nodes) {
      orchestrator.recordAgentEvent({
        type: "medium-campaign.subtask.started",
        waveIndex: wave.index,
        nodeId: node.id,
        description: node.prompt.slice(0, 150),
      });

      const startedAt = Date.now();

      if (!orchestrator.rootAgent) {
        const failResult: ExecutionResult = {
          success: false,
          mode: this.mode,
          taskId: node.id,
          error: "No agent available to execute node",
          durationMs: Date.now() - startedAt,
          completedAt: new Date().toISOString(),
        };
        taskResults.set(node.id, failResult);
        errors.push(`No agent available to execute node ${node.id}`);

        orchestrator.recordToolCall(false, 0);
        orchestrator.recordTurn();

        orchestrator.recordAgentEvent({
          type: "medium-campaign.subtask.failed",
          waveIndex: wave.index,
          nodeId: node.id,
          error: "No agent available",
        });
        continue;
      }

      try {
        const turnResult = await runAgentTurn(
          orchestrator.rootAgent,
          node.prompt,
          orchestrator.getAbortSignal(),
        );

        const success = !turnResult.error && turnResult.output.length > 0;
        const result: ExecutionResult = {
          success,
          mode: this.mode,
          taskId: node.id,
          output: turnResult.output,
          error: turnResult.error,
          totalTokens: 0,
          llmCallCount: 1,
          toolCallCount: turnResult.toolCalls,
          durationMs: turnResult.durationMs,
          completedAt: new Date().toISOString(),
        };
        taskResults.set(node.id, result);

        orchestrator.recordToolCall(success, 1);
        orchestrator.recordTurn();

        if (success) {
          orchestrator.recordAgentEvent({
            type: "medium-campaign.subtask.completed",
            waveIndex: wave.index,
            nodeId: node.id,
            success: true,
          });
        } else {
          errors.push(turnResult.error ?? `Task ${node.id} failed`);
          orchestrator.recordAgentEvent({
            type: "medium-campaign.subtask.failed",
            waveIndex: wave.index,
            nodeId: node.id,
            error: turnResult.error,
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const result: ExecutionResult = {
          success: false,
          mode: this.mode,
          taskId: node.id,
          error: errorMsg,
          durationMs: Date.now() - startedAt,
          completedAt: new Date().toISOString(),
        };
        taskResults.set(node.id, result);
        errors.push(errorMsg);

        orchestrator.recordToolCall(false, 0);
        orchestrator.recordTurn();

        orchestrator.recordAgentEvent({
          type: "medium-campaign.subtask.failed",
          waveIndex: wave.index,
          nodeId: node.id,
          error: errorMsg,
        });
      }
    }
  }

  // =========================================================================
  // Step 3: runConvergence — Merge results from a wave
  // =========================================================================

  /**
   * Run the ConvergenceEngine on the results produced by a wave.
   *
   * The convergence process:
   *   1. Collect execution results and sub-tasks from the wave
   *   2. Pass them to the OrchestratorCore's ConvergenceEngine
   *   3. Apply resolved changes to the internal state (changedFiles, newContents)
   *   4. Emit convergence events to the TUI
   *
   * If the ConvergenceEngine is not available on the orchestrator, this method
   * accumulates changed files directly from the execution results.
   *
   * @param waveResult   The WaveResult from the just-completed wave
   * @param orchestrator The orchestrator core
   */
  private async runConvergence(
    waveResult: WaveResult,
    orchestrator: OrchestratorCore,
  ): Promise<void> {
    orchestrator.recordAgentEvent({
      type: "medium-campaign.convergence.starting",
      waveIndex: waveResult.waveIndex,
      taskCount: waveResult.taskResults.size,
    });

    // ── Primary path: use OrchestratorCore's ConvergenceEngine ──────────
    if (orchestrator.convergenceEngine) {
      try {
        // Step 1: Collect all ExecutionResults from the completed wave's tasks
        const executionResults: ExecutionResult[] = [];
        for (const [, result] of waveResult.taskResults) {
          executionResults.push(result);
        }

        // Step 2: Collect the corresponding SubTasks from the pool manager
        const subTasks: SubTask[] = [];
        for (const taskId of waveResult.taskResults.keys()) {
          const handle = orchestrator.poolManager.getAgent(taskId);
          if (handle?.task) {
            subTasks.push(handle.task);
          }
        }

        // Step 3: Run the convergence pipeline
        const convergeResult: ConvergenceResult = await orchestrator.convergenceEngine.converge(
          executionResults,
          subTasks,
          orchestrator.workspaceRoot,
        );

        // Step 4: Handle the ConvergenceResult
        // If success: false and there are unresolvedConflicts, log them as errors
        if (!convergeResult.success && convergeResult.unresolvedConflicts > 0) {
          for (const round of convergeResult.rounds) {
            for (const resolution of round.resolutions) {
              if (!resolution.success) {
                const errMsg = `Unresolved conflict: ${resolution.conflict.description} (strategy: ${resolution.strategy})`;
                this.state.errors.push(errMsg);
                orchestrator.recordAgentEvent({
                  type: "medium-campaign.convergence.conflict.unresolved",
                  waveIndex: waveResult.waveIndex,
                  conflict: resolution.conflict.description,
                  strategy: resolution.strategy,
                });
              }
            }
          }
        }

        // Collect appliedChanges for file tracking
        for (const appliedChange of convergeResult.appliedChanges) {
          this.state.changedFiles.add(appliedChange);
        }

        // Collect mergedContent to pass to subsequent waves
        if (convergeResult.mergedContent) {
          for (const [filePath, content] of convergeResult.mergedContent) {
            this.state.newContents.set(filePath, content);
            this.state.changedFiles.add(filePath);
          }
        }

        // Step 5: Emit convergence complete event with exact type and field names
        orchestrator.recordAgentEvent({
          type: "medium-campaign.convergence.complete",
          waveIndex: waveResult.waveIndex,
          success: convergeResult.success,
          conflicts: convergeResult.totalConflicts,
          unresolved: convergeResult.unresolvedConflicts,
          appliedChanges: convergeResult.appliedChanges.length,
          rounds: convergeResult.rounds.length,
        });

        return;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.state.errors.push(`Convergence error: ${errorMsg}`);
        orchestrator.recordAgentEvent({
          type: "medium-campaign.convergence.error",
          waveIndex: waveResult.waveIndex,
          errors: [errorMsg],
        });
        // Fall through to the simple accumulation below
      }
    }

    // ── Fallback: simply collect changed files from task results ────────
    for (const [, result] of waveResult.taskResults) {
      if (result.changedFiles) {
        for (const file of result.changedFiles) {
          this.state.changedFiles.add(file);
        }
      }
    }

    orchestrator.recordAgentEvent({
      type: "medium-campaign.convergence.complete",
      waveIndex: waveResult.waveIndex,
      success: true,
      conflicts: 0,
      unresolved: 0,
      appliedChanges: this.state.changedFiles.size,
      rounds: 0,
    });
  }

  // =========================================================================
  // Step 4: runVerification — Run Level 2 gates on changed files
  //          with self-correction on failure
  // =========================================================================

  /**
   * Run Level 2 verification on the files changed during execution.
   *
   * Level 2 gates (as defined by VerificationPipeline.resolveEnabledGates):
   * - syntax (always on)
   * - lint (mode >= 1)
   * - typecheck (mode >= 2)
   * - unit-test (mode >= 2)
   *
   * Strategy:
   *   1. If no files changed, verification trivially passes
   *   2. Use the OrchestratorCore's VerificationPipeline.runPipeline()
   *      with ExecutionModeLevel 2
   *   3. Emit per-gate progress events to the TUI
   *   4. If the pipeline passes, return `{ passed: true }`
   *   5. If the pipeline fails, build a SelfCorrectionCycle instance,
   *      wire it to the orchestrator's event system, and run it.
   *      If correction succeeds, re-verify and return the result.
   *      If correction fails, return `{ passed: false, diagnostics }`.
   *
   * Emitted events (via orchestrator.recordAgentEvent):
   *   - { type: "medium-campaign.verification.started", fileCount }
   *   - { type: "medium-campaign.verification.complete", passed, gateResults }
   *   - { type: "medium-campaign.correction.started" } (if correction triggered)
   *   - { type: "medium-campaign.correction.complete", success, attempts }
   *
   * @param changedFiles  Array of changed file paths
   * @param orchestrator  The orchestrator core
   * @returns A VerificationResult with pass/fail status and diagnostics
   */
  private async runVerification(
    changedFiles: string[],
    orchestrator: OrchestratorCore,
  ): Promise<VerificationResult> {
    // ── Edge case: no files to validate ──────────────────────────────────
    if (changedFiles.length === 0) {
      return { passed: true };
    }

    // ── Emit verification started event ──────────────────────────────────
    orchestrator.recordAgentEvent({
      type: "medium-campaign.verification.started",
      fileCount: changedFiles.length,
    });

    // ── Primary path: use OrchestratorCore's VerificationPipeline ────────
    if (orchestrator.verificationPipeline) {
      try {
        const gateContext: GateContext = {
          workspaceRoot: orchestrator.workspaceRoot,
          codebaseGraph: undefined,
          reporter: orchestrator.verificationPipeline.getReporter(),
          signal: orchestrator.getAbortSignal(),
        };

        const pipelineResult: PipelineResult = await orchestrator.verificationPipeline.runPipeline(
          changedFiles,
          2, // ExecutionModeLevel 2: syntax + lint + typecheck + unit tests
          gateContext,
        );

        // Store pipeline result on orchestrator so the caller can retrieve it
        // for self-correction. Uses a type-safe approach via the known field.
        (orchestrator as unknown as { lastPipelineResult: PipelineResult }).lastPipelineResult = pipelineResult;

        // Emit per-gate results as events
        for (const [gateName, gateResult] of pipelineResult.gateResults) {
          const diagnosticCount = gateResult.diagnostics.length;
          const errorDiagnostics = gateResult.diagnostics.filter(
            (d) => d.severity === "error",
          );

          orchestrator.recordAgentEvent({
            type: gateResult.passed
              ? "medium-campaign.gate.passed"
              : "medium-campaign.gate.failed",
            gateName,
            passed: gateResult.passed,
            diagnosticCount,
            errorCount: errorDiagnostics.length,
            durationMs: gateResult.durationMs,
            diagnostics: errorDiagnostics.length > 0
              ? errorDiagnostics.map((d) => ({
                  file: d.file,
                  line: d.line,
                  column: d.column,
                  message: d.message,
                  severity: d.severity,
                }))
              : undefined,
          });
        }

        // Log error diagnostics at the campaign level
        const allErrorDiagnostics = pipelineResult.diagnostics.filter(
          (d) => d.severity === "error",
        );
        if (allErrorDiagnostics.length > 0) {
          orchestrator.recordAgentEvent({
            type: "medium-campaign.verification.diagnostics",
            count: allErrorDiagnostics.length,
            diagnostics: allErrorDiagnostics.map((d) => ({
              file: d.file,
              line: d.line,
              column: d.column,
              message: d.message,
              severity: d.severity,
              rule: d.rule,
              code: d.code,
            })),
          });
        }

        // ── If pipeline passes, return success ─────────────────────────
        if (pipelineResult.passed) {
          // Emit verification complete event
          orchestrator.recordAgentEvent({
            type: "medium-campaign.verification.complete",
            passed: true,
            gateResults: Array.from(pipelineResult.gateResults.entries()).map(([name, gr]) => ({
              gateName: name,
              passed: gr.passed,
              diagnosticCount: gr.diagnostics.length,
              durationMs: gr.durationMs,
              skipped: gr.skipped,
            })),
          });

          return {
            passed: true,
            diagnostics: pipelineResult.diagnostics,
            gateResults: pipelineResult.gateResults,
          };
        }

        // ── Pipeline failed — initiate self-correction ─────────────────
        orchestrator.recordAgentEvent({
          type: "medium-campaign.correction.started",
        });

        const correctionResult = await this.runSelfCorrection(
          pipelineResult,
          changedFiles,
          orchestrator,
        );

        // After correction, re-verify if it was applied
        if (correctionResult.success) {
          // Correction succeeded — re-verify
          const reVerifyResult: PipelineResult = await orchestrator.verificationPipeline.runPipeline(
            Array.from(this.state.changedFiles),
            2,
            gateContext,
          );

          // Store the re-verify result
          (orchestrator as unknown as { lastPipelineResult: PipelineResult }).lastPipelineResult = reVerifyResult;

          // Emit correction complete event
          orchestrator.recordAgentEvent({
            type: "medium-campaign.correction.complete",
            success: reVerifyResult.passed,
            attempts: correctionResult.attempts?.length ?? 0,
          });

          // Emit verification complete event
          orchestrator.recordAgentEvent({
            type: "medium-campaign.verification.complete",
            passed: reVerifyResult.passed,
            gateResults: Array.from(reVerifyResult.gateResults.entries()).map(([name, gr]) => ({
              gateName: name,
              passed: gr.passed,
              diagnosticCount: gr.diagnostics.length,
              durationMs: gr.durationMs,
              skipped: gr.skipped,
            })),
          });

          return {
            passed: reVerifyResult.passed,
            diagnostics: reVerifyResult.diagnostics,
            gateResults: reVerifyResult.gateResults,
            correctionApplied: true,
            correctionAttempts: correctionResult.attempts?.length ?? 0,
          };
        }

        // Correction failed — emit events and return failure
        orchestrator.recordAgentEvent({
          type: "medium-campaign.correction.complete",
          success: false,
          attempts: correctionResult.attempts?.length ?? 0,
        });

        orchestrator.recordAgentEvent({
          type: "medium-campaign.verification.complete",
          passed: false,
          gateResults: Array.from(pipelineResult.gateResults.entries()).map(([name, gr]) => ({
            gateName: name,
            passed: gr.passed,
            diagnosticCount: gr.diagnostics.length,
            durationMs: gr.durationMs,
            skipped: gr.skipped,
          })),
        });

        return {
          passed: false,
          diagnostics: pipelineResult.diagnostics,
          gateResults: pipelineResult.gateResults,
          correctionApplied: false,
          correctionAttempts: correctionResult.attempts?.length ?? 0,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        orchestrator.recordAgentEvent({
          type: "medium-campaign.verification.error",
          error: errorMsg,
        });
        this.state.errors.push(`Verification pipeline crashed: ${errorMsg}`);

        orchestrator.recordAgentEvent({
          type: "medium-campaign.verification.complete",
          passed: false,
          gateResults: [],
        });

        return {
          passed: false,
          diagnostics: [{
            file: "",
            line: 0,
            column: 0,
            message: errorMsg,
            severity: "error",
            rule: "verification-crash",
            code: "VERIFY_CRASH",
          }],
        };
      }
    }

    // ── Fallback: run individual gates manually ──────────────────────────
    try {
      const syntaxGate = new SyntaxCheckGate();
      const lintGate = new LintCheckGate();
      const typeGate = new TypeCheckGate();

      // Run gates sequentially
      const fallbackContext = {
        workspaceRoot: orchestrator.workspaceRoot,
        signal: orchestrator.getAbortSignal(),
      };

      // 1. Syntax check
      const syntaxResult = await syntaxGate.run(changedFiles, fallbackContext);
      if (!syntaxResult.passed) {
        this.emitGateDiagnostics("syntax", syntaxResult, orchestrator);

        orchestrator.recordAgentEvent({
          type: "medium-campaign.verification.complete",
          passed: false,
          gateResults: [{ gateName: "syntax", passed: false, diagnosticCount: syntaxResult.diagnostics.length, durationMs: syntaxResult.durationMs, skipped: false }],
        });

        return {
          passed: false,
          diagnostics: syntaxResult.diagnostics,
        };
      }

      // 2. Lint check
      const lintResult = await lintGate.run(changedFiles, fallbackContext);
      if (!lintResult.passed) {
        this.emitGateDiagnostics("lint", lintResult, orchestrator);

        orchestrator.recordAgentEvent({
          type: "medium-campaign.verification.complete",
          passed: false,
          gateResults: [{ gateName: "lint", passed: false, diagnosticCount: lintResult.diagnostics.length, durationMs: lintResult.durationMs, skipped: false }],
        });

        return {
          passed: false,
          diagnostics: lintResult.diagnostics,
        };
      }

      // 3. Type check
      const typeResult = await typeGate.run(changedFiles, fallbackContext);
      if (!typeResult.passed) {
        this.emitGateDiagnostics("typecheck", typeResult, orchestrator);

        orchestrator.recordAgentEvent({
          type: "medium-campaign.verification.complete",
          passed: false,
          gateResults: [{ gateName: "typecheck", passed: false, diagnosticCount: typeResult.diagnostics.length, durationMs: typeResult.durationMs, skipped: false }],
        });

        return {
          passed: false,
          diagnostics: typeResult.diagnostics,
        };
      }

      orchestrator.recordAgentEvent({
        type: "medium-campaign.verification.complete",
        passed: true,
        gateResults: [
          { gateName: "syntax", passed: true, diagnosticCount: 0, durationMs: syntaxResult.durationMs, skipped: false },
          { gateName: "lint", passed: true, diagnosticCount: 0, durationMs: lintResult.durationMs, skipped: false },
          { gateName: "typecheck", passed: true, diagnosticCount: 0, durationMs: typeResult.durationMs, skipped: false },
        ],
      });

      return { passed: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      orchestrator.recordAgentEvent({
        type: "medium-campaign.verification.error",
        error: errorMsg,
      });
      this.state.errors.push(`Fallback verification crashed: ${errorMsg}`);

      orchestrator.recordAgentEvent({
        type: "medium-campaign.verification.complete",
        passed: false,
        gateResults: [],
      });

      return {
        passed: false,
        diagnostics: [{
          file: "",
          line: 0,
          column: 0,
          message: errorMsg,
          severity: "error",
          rule: "fallback-crash",
          code: "FALLBACK_CRASH",
        }],
      };
    }
  }

  // =========================================================================
  // Self-correction support
  // =========================================================================

  /**
   * Run the SelfCorrectionCycle on a failed verification pipeline result.
   *
   * The correction cycle classifies failures, applies auto-fixes, and
   * re-runs the relevant gates. If the fix succeeds, the changed files
   * set is updated and the method returns true.
   *
   * @param pipelineResult   The failed PipelineResult from verification
   * @param changedFiles     The set of changed file paths
   * @param orchestrator     The orchestrator core
   * @returns True if correction was applied and fixed the issues
   */
  private async runSelfCorrection(
    pipelineResult: PipelineResult,
    changedFiles: string[],
    orchestrator: OrchestratorCore,
  ): Promise<CorrectionResult> {
    try {
      const modeLevel = 2; // Level 2 for medium campaign

      // Build the SelfCorrectionCycle
      const wirePath = orchestrator.getSessionId
        ? resolve(orchestrator.workspaceRoot, ".Q", "sessions", orchestrator.getSessionId(), "wire.jsonl")
        : undefined;

      const correctionCycle = new SelfCorrectionCycle(
        {
          workspaceRoot: orchestrator.workspaceRoot,
          modeLevel,
          autoEscalate: true,
          enableAutoFix: true,
          wirePath,
        },
        orchestrator.verificationPipeline,
        {
          subagentHost: orchestrator.rootAgent?.subagentHost as
            | { spawn: (profile: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ id: string; result: string }> }
            | undefined,
          codebaseGraph: undefined,
        },
      );

      // Forward progress events to the orchestrator
      correctionCycle.onProgress((event) => {
        orchestrator.recordAgentEvent({
          type: "medium-campaign.correction.progress",
          ...event,
        });
      });

      // Run the correction cycle
      const correctionResult: CorrectionResult = await correctionCycle.run(
        pipelineResult,
        new Set(changedFiles),
        {
          workspaceRoot: orchestrator.workspaceRoot,
          signal: orchestrator.getAbortSignal(),
        },
      );

      // Update our changed files set with any new files from correction
      if (correctionResult.changedFiles) {
        for (const file of correctionResult.changedFiles) {
          this.state.changedFiles.add(file);
        }
      }

      // Emit correction result event
      orchestrator.recordAgentEvent({
        type: "medium-campaign.correction.result",
        success: correctionResult.success,
        attempts: correctionResult.attempts?.length ?? 0,
        fixedCount: correctionResult.attempts ? correctionResult.attempts.length : 0,
        remainingErrors: correctionResult.attempts && correctionResult.attempts.length > 0
          ? correctionResult.attempts.filter(a => !a.passed).length
          : 0,
        escalated: !!correctionResult.escalation,
      });

      // If fixed, add to the correction tracker
      if (correctionResult.success && correctionResult.changedFiles) {
        this.state.changedFiles = new Set([
          ...Array.from(this.state.changedFiles),
          ...correctionResult.changedFiles,
        ]);
      }

      return correctionResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      orchestrator.recordAgentEvent({
        type: "medium-campaign.correction.error",
        error: errorMsg,
      });
      this.state.errors.push(`Self-correction cycle crashed: ${errorMsg}`);

      // Return a failed CorrectionResult so the caller can handle it
      return {
        success: false,
        attempts: [],
        changedFiles: [],
        durationMs: 0,
      };
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Create a fresh WaveCompletionState.
   */
  private freshState(): WaveCompletionState {
    return {
      changedFiles: new Set(),
      newContents: new Map(),
      waveResults: new Map(),
      subResults: [],
      errors: [],
      totalTokens: 0,
      llmCallCount: 0,
      toolCallCount: 0,
    };
  }

  /**
   * Accumulate results from a WaveResult into the internal state.
   *
   * Per the specification:
   * - subResults: one ExecutionResult per wave (not per individual task)
   * - llmCallCount: number of tasks (graph nodes) across all waves, not summed
   * - totalTokens: sum across all task results
   * - toolCallCount: sum across all task results
   * - changedFiles: deduplicated union
   */
  private accumulateWaveResult(waveResult: WaveResult): void {
    // Build a wave-level ExecutionResult for subResults
    const waveTaskCount = waveResult.taskResults.size;
    const waveSuccessCount = Array.from(waveResult.taskResults.values()).filter(
      (r) => r.success,
    ).length;
    const waveErrors: string[] = [];
    let waveTokens = 0;
    let waveToolCalls = 0;
    const waveChangedFiles: string[] = [];

    for (const [, result] of waveResult.taskResults) {
      if (result.changedFiles) {
        for (const file of result.changedFiles) {
          this.state.changedFiles.add(file);
          waveChangedFiles.push(file);
        }
      }

      if (result.newContents) {
        for (const [filePath, content] of Object.entries(result.newContents)) {
          this.state.newContents.set(filePath, content);
        }
      }

      waveTokens += result.totalTokens ?? 0;
      waveToolCalls += result.toolCallCount ?? 0;

      if (result.error) {
        waveErrors.push(result.error);
      }
    }

    // Accumulate into global state
    this.state.totalTokens += waveTokens;
    this.state.toolCallCount += waveToolCalls;
    this.state.llmCallCount += waveTaskCount; // Count tasks, not aggregated llmCallCount

    // Push one ExecutionResult per wave
    this.state.subResults.push({
      success: waveResult.success,
      mode: this.mode,
      taskId: `wave-${waveResult.waveIndex}`,
      output: `Wave ${waveResult.waveIndex}: ${waveSuccessCount}/${waveTaskCount} tasks completed in ${(waveResult.durationMs / 1000).toFixed(1)}s`,
      error: waveErrors.length > 0 ? waveErrors.join("; ") : undefined,
      totalTokens: waveTokens,
      llmCallCount: waveTaskCount,
      toolCallCount: waveToolCalls,
      durationMs: waveResult.durationMs,
      changedFiles: waveChangedFiles.length > 0 ? [...new Set(waveChangedFiles)] : undefined,
      errors: waveResult.errors.length > 0 ? waveResult.errors : undefined,
      completedAt: new Date().toISOString(),
    });

    this.state.errors.push(...waveResult.errors);
  }

  /**
   * Map a TaskGraphNode's phase to a TaskPhase.
   */
  private nodePhaseToTaskPhase(node: TaskGraphNode): import("./types.js").TaskPhase {
    const phase = node.phase ?? node.profile;
    switch (phase) {
      case "research": return "research";
      case "explore": return "explore";
      case "scaffold": return "scaffolding";
      case "implement": return "implementation";
      case "test": return "test_generation";
      case "polish": return "documentation";
      case "validate": return "verification";
      default: return "implementation";
    }
  }

  /**
   * Create a promise that resolves when a specific sub-task completes in the pool.
   *
   * Registers a one-shot listener on `poolManager.onCompletion()`. When the
   * completion event matches the given nodeId, the promise is resolved with an
   * ExecutionResult constructed from the SubAgentHandle's state.
   *
   * Handles both "completed" and "failed"/"timeout" states. Polls every 250ms
   * as a safety net in case the completion listener fires before registration.
   *
   * @param poolManager - The pool manager to listen on
   * @param nodeId      - The ID of the node to wait for
   * @returns A promise that resolves to an ExecutionResult
   */
  private waitForTaskCompletion(
    poolManager: SubAgentPoolManager,
    nodeId: string,
  ): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>((resolve) => {
      // Safety net: poll for completion in case the event fires before we register
      const pollTimer = setInterval(() => {
        const handle = poolManager.getAgent(nodeId);
        if (!handle) return;

        if (handle.state === "completed" || handle.state === "failed" || handle.state === "timeout") {
          clearInterval(pollTimer);
          resolve(this.buildResultFromHandle(handle));
        }
      }, 250);

      // One-shot completion listener
      const listener = (handle: SubAgentHandle): void => {
        if (handle.id === nodeId) {
          clearInterval(pollTimer);
          poolManager.offCompletion(listener);
          resolve(this.buildResultFromHandle(handle));
        }
      };

      poolManager.onCompletion(listener);

      // Also check immediately if the task already completed
      const existing = poolManager.getAgent(nodeId);
      if (existing && (existing.state === "completed" || existing.state === "failed" || existing.state === "timeout")) {
        clearInterval(pollTimer);
        poolManager.offCompletion(listener);
        resolve(this.buildResultFromHandle(existing));
      }
    });
  }

  /**
   * Build an ExecutionResult from a SubAgentHandle's current state.
   */
  private buildResultFromHandle(handle: SubAgentHandle): ExecutionResult {
    const isSuccess = handle.state === "completed";
    const totalTokens = handle.tokenUsage.promptTokens + handle.tokenUsage.completionTokens;

    return {
      success: isSuccess,
      mode: this.mode,
      taskId: handle.id,
      output: isSuccess
        ? `Node completed (${handle.profile}): ${handle.task?.description ?? handle.id}`
        : undefined,
      error: isSuccess
        ? undefined
        : handle.state === "timeout"
          ? `Node timed out after exceeding timeout threshold`
          : `Node failed after ${handle.errorCount} error(s)`,
      totalTokens,
      llmCallCount: 1,
      toolCallCount: 0,
      durationMs: handle.startedAt ? Date.now() - handle.startedAt : 0,
      changedFiles: [],
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Emit gate diagnostics as TUI events.
   */
  private emitGateDiagnostics(
    gateName: string,
    gateResult: GateResult,
    orchestrator: OrchestratorCore,
  ): void {
    const errorDiagnostics = gateResult.diagnostics.filter(
      (d) => d.severity === "error",
    );

    orchestrator.recordAgentEvent({
      type: "medium-campaign.gate.failed",
      gateName,
      passed: false,
      diagnosticCount: gateResult.diagnostics.length,
      errorCount: errorDiagnostics.length,
      durationMs: gateResult.durationMs,
      diagnostics: errorDiagnostics.map((d) => ({
        file: d.file,
        line: d.line,
        column: d.column,
        message: d.message,
        severity: d.severity,
      })),
    });
  }

  /**
   * Build the execution summary output string.
   */
  private buildOutput(
    task: Task,
    success: boolean,
    verificationPassed: boolean,
    durationMs: number,
  ): string {
    const lines: string[] = [];

    // Title
    const promptSummary = task.prompt.length > 200
      ? task.prompt.slice(0, 200) + "..."
      : task.prompt;
    lines.push(`# ${promptSummary}`);
    lines.push("");

    // Wave results summary
    lines.push(`## Waves (${this.state.waveResults.size} total)`);
    for (const [waveIndex, waveResult] of this.state.waveResults) {
      const icon = waveResult.success ? "✓" : "✗";
      const taskCount = waveResult.taskResults.size;
      const successCount = Array.from(waveResult.taskResults.values()).filter(
        (r) => r.success,
      ).length;
      lines.push(
        `${icon} Wave ${waveIndex}: ${successCount}/${taskCount} tasks completed in ${(waveResult.durationMs / 1000).toFixed(1)}s`,
      );
    }
    lines.push("");

    // Summary
    const totalSubResults = this.state.subResults.length;
    const totalSuccess = this.state.subResults.filter((r) => r.success).length;
    const durationSec = (durationMs / 1000).toFixed(1);

    lines.push("## Summary");
    lines.push(`- Completed: ${totalSuccess} / ${totalSubResults} sub-tasks`);
    lines.push(`- Failed: ${totalSubResults - totalSuccess}`);
    lines.push(`- Duration: ${durationSec}s`);

    // Verification status
    if (verificationPassed) {
      lines.push("- Verification: PASSED");
    } else {
      lines.push("- Verification: FAILED");
    }

    // Overall success
    lines.push(`- Overall: ${success ? "SUCCESS" : "FAILED"}`);

    // Aggregated metrics (+1 for graph generation in LLM call count)
    lines.push(`- Total tokens: ${this.state.totalTokens}`);
    lines.push(`- LLM calls: ${this.state.llmCallCount + 1}`);
    lines.push(`- Tool calls: ${this.state.toolCallCount}`);

    // Changed files
    if (this.state.changedFiles.size > 0) {
      lines.push(`- Files changed: ${this.state.changedFiles.size}`);
    }

    // Errors if any
    if (this.state.errors.length > 0) {
      lines.push("");
      lines.push("### Errors");
      for (const err of this.state.errors) {
        lines.push(`- ${err}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Build an error summary string.
   */
  private buildErrorSummary(verificationPassed: boolean, diagnostics?: Diagnostic[]): string {
    const parts: string[] = [];

    if (!verificationPassed) {
      parts.push("Verification failed at Level 2 (syntax + lint + typecheck + unit tests)");
    }

    // Include diagnostic messages from verification gates
    if (diagnostics && diagnostics.length > 0) {
      const errorDiags = diagnostics.filter((d) => d.severity === "error");
      if (errorDiags.length > 0) {
        parts.push(`Verification diagnostics (${errorDiags.length} error(s)):`);
        for (const d of errorDiags.slice(0, 10)) {
          parts.push(`  ${d.file}:${d.line}:${d.column} — ${d.message} [${d.rule}]`);
        }
        if (errorDiags.length > 10) {
          parts.push(`  ... and ${errorDiags.length - 10} more`);
        }
      }
    }

    if (this.state.errors.length > 0) {
      parts.push(...this.state.errors);
    }

    const failedTasks = this.state.subResults.filter((r) => !r.success);
    for (const task of failedTasks) {
      if (task.error) {
        parts.push(task.error);
      }
    }

    return parts.length > 0 ? parts.join("; ") : "Unknown error";
  }

  /**
   * Build a result for an aborted execution (e.g. abort signal received).
   */
  private buildAbortedResult(task: Task, startedAt: number): ExecutionResult {
    return {
      success: false,
      mode: this.mode,
      taskId: task.id,
      error: "Execution aborted",
      output: `Medium campaign aborted after ${this.state.waveResults.size} wave(s)`,
      totalTokens: this.state.totalTokens,
      llmCallCount: this.state.llmCallCount + 1, // +1 for graph generation
      toolCallCount: this.state.toolCallCount,
      durationMs: Date.now() - startedAt,
      changedFiles: Array.from(this.state.changedFiles),
      subResults: this.state.subResults.length > 0 ? this.state.subResults : undefined,
      errors: ["Execution aborted", ...this.state.errors],
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Generate a natural-language summary via the root agent.
   *
   * After all waves complete and verification passes, this method
   * calls the root agent with the original request, structured results,
   * and changed files to produce a concise concluding message.
   *
   * Best-effort — returns the structured output on failure.
   */
  private async generateSummary(
    task: Task,
    changedFiles: string[],
    structuredOutput: string,
    orchestrator: OrchestratorCore,
  ): Promise<string | undefined> {
    const agent = orchestrator.rootAgent;
    if (!agent) return undefined;

    const fileList = changedFiles.length > 0
      ? changedFiles.map((f) => `  - ${f}`).join("\n")
      : "  (no files changed)";

    const summaryPrompt =
      `You are a senior engineer providing a final summary after completing a task.\n\n` +
      `The task was executed using a multi-wave campaign with convergence and quality gates. ` +
      `Below are the structured results and the list of files that were changed.\n\n` +
      `## Original Request\n${task.prompt}\n\n` +
      `## Results\n${structuredOutput}\n\n` +
      `## Files Changed\n${fileList}\n\n` +
      `Write a concise, natural-language summary that answers the user's original request. ` +
      `Explain what was done, what was found (if anything went wrong), what files were changed, ` +
      `and the overall outcome. Be specific — reference actual file names and issues found. ` +
      `This summary will be shown to the user as the final response.`;

    orchestrator.recordAgentEvent({
      type: "medium-campaign.summary.generating",
    });

    const result = await runAgentTurn(agent, summaryPrompt, orchestrator.getAbortSignal());

    if (result.error) {
      orchestrator.recordAgentEvent({
        type: "medium-campaign.summary.failed",
        error: result.error,
      });
      return undefined;
    }

    return result.output || undefined;
  }
}