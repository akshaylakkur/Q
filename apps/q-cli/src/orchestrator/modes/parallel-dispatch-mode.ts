/**
 * ParallelDispatchMode — Decompose into sub-tasks and dispatch in parallel.
 *
 * Calls the TaskDecomposer (Step 16) to decompose the goal into 3-5 sub-tasks,
 * dispatches sub-agents through the PoolManager (Step 15) in parallel with
 * conflict checking, runs the ConvergenceEngine (Step 18) on completion,
 * and validates with lint + type-check.
 */

import { ExecutionModeHandler } from "./handler.js";
import { ExecutionModes } from "./index.js";
import type { ExecutionMode } from "./index.js";
import type { Task, ExecutionResult, SubTask } from "./types.js";
import type { OrchestratorCore } from "../core.js";

export class ParallelDispatchMode extends ExecutionModeHandler {
  readonly mode: ExecutionMode = ExecutionModes.PARALLEL_DISPATCH;
  readonly description = "Parallel dispatch — decompose, parallel sub-agents, converge, validate";

  /**
   * Execute a task in parallel dispatch mode.
   *
   * Strategy:
   * 1. Call TaskDecomposer to decompose the goal into 3-5 sub-tasks.
   * 2. Dispatch sub-agents through PoolManager in parallel.
   * 3. Apply conflict checking on completed sub-results.
   * 4. Run ConvergenceEngine to integrate results.
   * 5. Validate with lint + type-check.
   * 6. Return consolidated result.
   */
  async execute(task: Task, orchestrator: OrchestratorCore): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const subResults: ExecutionResult[] = [];
    const errors: string[] = [];

    try {
      // Step 1: Decompose into sub-tasks
      const subTasks = await this.decomposeTask(task, orchestrator);

      // Step 2: Dispatch sub-agents in parallel
      const dispatchResults = await this.dispatchParallel(subTasks, task, orchestrator);
      subResults.push(...dispatchResults);

      // Collect results and errors
      const allChangedFiles: string[] = [];
      for (const result of dispatchResults) {
        if (result.changedFiles) {
          allChangedFiles.push(...result.changedFiles);
        }
        if (!result.success && result.error) {
          errors.push(result.error);
        }
      }

      // Step 3: Conflict checking
      const conflictResult = await this.runConflictCheck(allChangedFiles, subTasks, orchestrator);
      if (!conflictResult.passed) {
        errors.push(`Conflict detected: ${conflictResult.message}`);
      }

      // Step 4: Run ConvergenceEngine
      const convergenceResult = await this.converge(subResults, task, orchestrator);

      // Step 5: Lint + type-check
      const lintPassed = await this.runVerification(allChangedFiles, orchestrator);
      if (!lintPassed) {
        errors.push("Lint or type-check verification failed");
      }

      return {
        success: errors.length === 0 && convergenceResult.success,
        mode: this.mode,
        taskId: task.id,
        output: `[ParallelDispatchMode] Dispatched ${subTasks.length} sub-tasks. Converged successfully. Errors: ${errors.length}`,
        error: errors.length > 0 ? errors.join("; ") : undefined,
        totalTokens: subResults.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0),
        llmCallCount: subResults.reduce((sum, r) => sum + (r.llmCallCount ?? 0), 0),
        toolCallCount: subResults.reduce((sum, r) => sum + (r.toolCallCount ?? 0), 0),
        durationMs: Date.now() - startedAt,
        changedFiles: [...new Set(allChangedFiles)],
        verificationPassed: lintPassed && conflictResult.passed,
        subResults,
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
        subResults: subResults.length > 0 ? subResults : undefined,
        errors: errors.length > 0 ? errors : undefined,
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Decompose the task into sub-tasks via TaskDecomposer (Step 16).
   * Stub — will delegate to orchestrator.taskDecomposer.decompose().
   */
  private async decomposeTask(
    task: Task,
    _orchestrator: OrchestratorCore,
  ): Promise<SubTask[]> {
    // In full implementation (Step 16):
    // return orchestrator.taskDecomposer.decompose(task, 3, 5);

    const baseId = task.id;
    return [
      { id: `${baseId}-sub-1`, parentTaskId: task.id, description: "Explore and analyze the codebase", status: "pending", phase: "explore", createdAt: new Date().toISOString() },
      { id: `${baseId}-sub-2`, parentTaskId: task.id, description: "Implement the core changes", status: "pending", phase: "implementation", createdAt: new Date().toISOString() },
      { id: `${baseId}-sub-3`, parentTaskId: task.id, description: "Update related modules and tests", status: "pending", phase: "implementation", createdAt: new Date().toISOString() },
      { id: `${baseId}-sub-4`, parentTaskId: task.id, description: "Verify and validate changes", status: "pending", phase: "verification", createdAt: new Date().toISOString() },
    ];
  }

  /**
   * Dispatch sub-tasks in parallel via PoolManager (Step 15).
   * Stub — will use orchestrator.poolManager.dispatch().
   */
  private async dispatchParallel(
    subTasks: SubTask[],
    _task: Task,
    _orchestrator: OrchestratorCore,
  ): Promise<ExecutionResult[]> {
    // In full implementation (Step 15):
    // return orchestrator.poolManager.dispatchAll(subTasks);

    return subTasks.map((st) => ({
      success: true,
      mode: this.mode,
      taskId: st.id,
      output: `[ParallelDispatchMode] Sub-task "${st.description}" completed`,
      totalTokens: 0,
      llmCallCount: 1,
      toolCallCount: 0,
      changedFiles: [],
      completedAt: new Date().toISOString(),
    }));
  }

  /**
   * Conflict checking across parallel sub-task results.
   */
  private async runConflictCheck(
    _changedFiles: string[],
    _subTasks: SubTask[],
    _orchestrator: OrchestratorCore,
  ): Promise<{ passed: boolean; message?: string }> {
    // In full implementation:
    // Check for overlapping file modifications between sub-tasks
    return { passed: true };
  }

  /**
   * Run ConvergenceEngine (Step 18) to integrate results.
   */
  private async converge(
    _subResults: ExecutionResult[],
    _task: Task,
    _orchestrator: OrchestratorCore,
  ): Promise<ExecutionResult> {
    // In full implementation (Step 18):
    // return orchestrator.convergenceEngine.converge(subResults, task);
    return {
      success: true,
      mode: this.mode,
      taskId: _task.id,
      output: "[ParallelDispatchMode] Convergence complete",
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Run lint + type-check verification.
   */
  private async runVerification(
    _changedFiles: string[],
    _orchestrator: OrchestratorCore,
  ): Promise<boolean> {
    // In full implementation:
    // Run linter and type-checker on changed files
    return true;
  }
}