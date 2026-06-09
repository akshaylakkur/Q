/**
 * OrchestratedCampaignMode — Deep task decomposition with multi-wave execution.
 *
 * Performs deep task decomposition (20-100+ sub-tasks), constructs a full
 * dependency DAG, and dispatches in multi-wave fashion:
 *   Phase 1: Research + explore
 *   Phase 2: Scaffolding + dependency resolution
 *   Phase 3: Implementation agents in parallel
 *   Phase 4: Test generation + documentation
 *   Phase 5: Full verification with self-correction
 * Converges between each phase.
 */

import { ExecutionModeHandler } from "./handler.js";
import { ExecutionModes } from "./index.js";
import type { ExecutionMode } from "./index.js";
import type { Task, ExecutionResult, SubTask, TaskPhase } from "./types.js";
import type { OrchestratorCore } from "../core.js";

const PHASES: TaskPhase[] = [
  "research",
  "explore",
  "scaffolding",
  "dependency_resolution",
  "implementation",
  "test_generation",
  "documentation",
  "verification",
  "self_correction",
  "convergence",
];

const WAVE_PHASES: Array<{ name: string; phases: TaskPhase[] }> = [
  { name: "Phase 1: Research & Explore", phases: ["research", "explore"] },
  { name: "Phase 2: Scaffolding & Dependencies", phases: ["scaffolding", "dependency_resolution"] },
  { name: "Phase 3: Implementation", phases: ["implementation"] },
  { name: "Phase 4: Tests & Documentation", phases: ["test_generation", "documentation"] },
  { name: "Phase 5: Verification & Self-Correction", phases: ["verification", "self_correction"] },
];

export class OrchestratedCampaignMode extends ExecutionModeHandler {
  readonly mode: ExecutionMode = ExecutionModes.ORCHESTRATED_CAMPAIGN;
  readonly description = "Orchestrated campaign — deep decomposition, multi-wave DAG dispatch, phase-level convergence";

  /**
   * Execute a task in orchestrated campaign mode.
   *
   * Strategy:
   * 1. Deep task decomposition (20-100+ sub-tasks).
   * 2. Build dependency DAG.
   * 3. Execute in 5 waves, converging between each.
   * 4. Full verification with self-correction.
   */
  async execute(task: Task, orchestrator: OrchestratorCore): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const errors: string[] = [];
    const waveResults: ExecutionResult[] = [];
    let allChangedFiles: string[] = [];

    try {
      // Step 1: Deep decomposition
      const subTasks = await this.deepDecompose(task, orchestrator);

      // Step 2: Build dependency DAG
      const dag = await this.buildDependencyDAG(subTasks, task, orchestrator);

      // Step 3: Execute waves
      for (const wave of WAVE_PHASES) {
        if (task.metadata?.cancelled) break;

        const waveResult = await this.executeWave(wave, dag, subTasks, task, orchestrator);
        waveResults.push(waveResult);

        if (waveResult.changedFiles) {
          allChangedFiles.push(...waveResult.changedFiles);
        }

        if (!waveResult.success) {
          errors.push(`Wave "${wave.name}" failed: ${waveResult.error ?? "unknown error"}`);
        }

        // Converge between phases
        const convergeResult = await this.convergePhase(waveResult, subTasks, task, orchestrator);
        if (!convergeResult.success && convergeResult.error) {
          errors.push(`Convergence after ${wave.name}: ${convergeResult.error}`);
        }
      }

      // Step 4: Final convergence
      const finalConvergence = await this.convergePhase(
        { success: errors.length === 0, mode: this.mode, taskId: task.id, output: "Final convergence" },
        subTasks,
        task,
        orchestrator,
      );

      return {
        success: errors.length === 0,
        mode: this.mode,
        taskId: task.id,
        output: `[OrchestratedCampaignMode] Completed ${WAVE_PHASES.length} waves across ${subTasks.length} sub-tasks. Errors: ${errors.length}`,
        error: errors.length > 0 ? errors.join("; ") : undefined,
        totalTokens: waveResults.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0),
        llmCallCount: subTasks.length + 1,
        toolCallCount: waveResults.reduce((sum, r) => sum + (r.toolCallCount ?? 0), 0),
        durationMs: Date.now() - startedAt,
        changedFiles: [...new Set(allChangedFiles)],
        verificationPassed: errors.length === 0,
        subResults: waveResults,
        errors: errors.length > 0 ? errors : undefined,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        mode: this.mode,
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        subResults: waveResults.length > 0 ? waveResults : undefined,
        errors: errors.length > 0 ? errors : undefined,
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Deep task decomposition — generates 20-100+ sub-tasks.
   * Stub — will delegate to TaskDecomposer.decomposeDeep() in Step 16.
   */
  private async deepDecompose(
    _task: Task,
    _orchestrator: OrchestratorCore,
  ): Promise<SubTask[]> {
    // In full implementation (Step 16):
    // return orchestrator.taskDecomposer.decomposeDeep(task, 20, 100);

    // Return a representative set of sub-tasks for each phase
    const subTasks: SubTask[] = [];
    const now = new Date().toISOString();

    for (const phase of PHASES) {
      subTasks.push({
        id: `${_task.id}-${phase}-1`,
        parentTaskId: _task.id,
        description: `Execute phase: ${phase}`,
        phase,
        status: "pending",
        createdAt: now,
      });
    }

    return subTasks;
  }

  /**
   * Build a dependency DAG from the sub-tasks.
   * Stub — will use TaskDecomposer.buildDAG() in Step 16.
   */
  private async buildDependencyDAG(
    subTasks: SubTask[],
    _task: Task,
    _orchestrator: OrchestratorCore,
  ): Promise<Map<string, SubTask[]>> {
    // In full implementation:
    // return orchestrator.taskDecomposer.buildDAG(subTasks);

    // Flat dependencies for now — sequential phase ordering
    const dag = new Map<string, SubTask[]>();
    for (let i = 0; i < subTasks.length; i++) {
      const deps: SubTask[] = [];
      if (i > 0) {
        deps.push(subTasks[i - 1]!);
      }
      dag.set(subTasks[i]!.id, deps);
    }
    return dag;
  }

  /**
   * Execute a single wave (collection of phases).
   */
  private async executeWave(
    wave: { name: string; phases: TaskPhase[] },
    _dag: Map<string, SubTask[]>,
    subTasks: SubTask[],
    _task: Task,
    _orchestrator: OrchestratorCore,
  ): Promise<ExecutionResult> {
    const waveSubTasks = subTasks.filter((st) => st.phase && wave.phases.includes(st.phase));

    // In full implementation:
    // 1. Identify ready sub-tasks (dependencies met)
    // 2. Dispatch them via PoolManager
    // 3. Wait for completion
    // 4. Handle failures

    for (const st of waveSubTasks) {
      st.status = "completed";
    }

    return {
      success: true,
      mode: this.mode,
      taskId: _task.id,
      output: `[OrchestratedCampaignMode] Wave "${wave.name}" completed (${waveSubTasks.length} sub-tasks)`,
      totalTokens: 0,
      llmCallCount: waveSubTasks.length,
      toolCallCount: 0,
      changedFiles: [],
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Converge after a phase completes.
   * Stub — will use ConvergenceEngine.converge() in Step 18.
   */
  private async convergePhase(
    _phaseResult: ExecutionResult,
    _subTasks: SubTask[],
    _task: Task,
    _orchestrator: OrchestratorCore,
  ): Promise<ExecutionResult> {
    return {
      success: true,
      mode: this.mode,
      taskId: _task.id,
      output: "[OrchestratedCampaignMode] Phase convergence complete",
      completedAt: new Date().toISOString(),
    };
  }
}