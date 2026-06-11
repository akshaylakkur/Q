/**
 * SpeedCampaignMode — Fast parallel dispatch of independent sub-tasks.
 *
 * Core philosophy: "decompose, dispatch in parallel, collect results, validate lightly."
 *
 * This handler is the fastest of the three campaign modes. It does NOT create waves,
 * does NOT run convergence, does NOT ask the user for confirmation, and does NOT run
 * the full verification pipeline. It is designed for situations where the user has
 * multiple independent tasks (e.g., "fix the typo in index.ts AND update the README
 * AND add tests for auth.ts") and wants them done as fast as possible.
 *
 * Execution flow:
 *   1. decomposeTask()   — Split the prompt into independent sub-tasks
 *   2. dispatchAll()     — Fire all sub-tasks through the pool manager in parallel
 *   3. collectResults()  — Gather results as they complete
 *   4. validateResults() — Run minimal syntax/type check on changed files
 */

import { ExecutionModeHandler } from "./handler.js";
import { ExecutionModes } from "./index.js";
import type { ExecutionMode } from "./index.js";
import type { Task, ExecutionResult, SubTask } from "./types.js";
import type { OrchestratorCore } from "../core.js";
import type { SubAgentHandle, SubAgentPoolManager } from "../pool.js";
import { runAgentTurn } from "../../agent/wiring.js";
import { SyntaxCheckGate } from "../verification.js";
import type { GateResult } from "../verification.js";
import { randomUUID } from "node:crypto";

export class SpeedCampaignMode extends ExecutionModeHandler {
  readonly mode: ExecutionMode = ExecutionModes.SPEED_CAMPAIGN;
  readonly description = "Speed campaign — fast parallel dispatch of independent sub-tasks";

  async execute(task: Task, orchestrator: OrchestratorCore): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const subResults: ExecutionResult[] = [];

    // Store reference to orchestrator so collectResults can emit events
    this._orchestrator = orchestrator;

    try {
      // Step 1: Decompose the task into independent sub-tasks
      const subTasks = await this.decomposeTask(task, orchestrator);

      // ── Emit started event with sub-task count ──────────────────────────
      orchestrator.recordAgentEvent({
        type: "speed-campaign.started",
        subTaskCount: subTasks.length,
        taskId: task.id,
      });

      // Step 2: Dispatch all sub-tasks in parallel through the pool manager
      await this.dispatchAll(subTasks, orchestrator);

      // Step 3: Collect results — aggregate sub-task results, deduplicate
      //          changed files, merge newContents with conflict detection,
      //          and compute aggregate metrics.
      const { aggregateResult, changedFiles, errors } = this.collectResults(
        this._completedResults,
        subTasks,
      );
      subResults.push(...aggregateResult.subResults ?? []);

      // Step 4: Run minimal validation on changed files
      const { passed: validationPassed, diagnostics: syntaxDiagnostics } =
        await this.validateResults(changedFiles, orchestrator);

      // Log syntax diagnostics as info-level events for visibility
      if (syntaxDiagnostics.length > 0) {
        orchestrator.recordAgentEvent({
          type: 'speed-campaign.syntax-diagnostics',
          count: syntaxDiagnostics.length,
          diagnostics: syntaxDiagnostics.map(d => ({
            file: d.file,
            line: d.line,
            column: d.column,
            message: d.message,
            severity: d.severity,
          })),
        });
      }

      // Determine overall success: all sub-tasks succeeded AND validation passed
      const allTasksSuccess = aggregateResult.success ?? false;
      const success = allTasksSuccess && validationPassed;
      const duration = Date.now() - startedAt;

      // ── Emit completed event ────────────────────────────────────────────
      orchestrator.recordAgentEvent({
        type: "speed-campaign.completed",
        success,
        duration,
        subTaskCount: subTasks.length,
        taskId: task.id,
      });

      // ── Generate LLM summary ──────────────────────────────────────────
      // Use the root agent to produce a natural-language conclusion that
      // answers the user's original request, summarizing what was done,
      // what files changed, and the overall outcome.
      const structuredOutput = this.buildOutput(task, subTasks, aggregateResult, validationPassed, errors);
      let llmSummary: string | undefined;
      if (success && orchestrator.rootAgent) {
        try {
          const summaryResult = await this.generateSummary(task, changedFiles, structuredOutput, orchestrator);
          if (summaryResult && typeof summaryResult === 'string') {
            llmSummary = summaryResult;
          }
        } catch {
          // Summary generation is best-effort — fall back to structured output
        }
      }

      return {
        success,
        mode: this.mode,
        taskId: task.id,
        output: llmSummary ?? structuredOutput,
        error: success ? undefined : this.buildErrorSummary(subResults, validationPassed),
        totalTokens: aggregateResult.totalTokens ?? 0,
        llmCallCount: aggregateResult.llmCallCount ?? 0,
        toolCallCount: aggregateResult.toolCallCount ?? 0,
        durationMs: duration,
        changedFiles,
        verificationPassed: validationPassed,
        subResults,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      const duration = Date.now() - startedAt;
      const errorMsg = error instanceof Error ? error.message : String(error);

      // ── Emit completed event with success: false ────────────────────────
      orchestrator.recordAgentEvent({
        type: "speed-campaign.completed",
        success: false,
        duration,
        error: errorMsg,
        taskId: task.id,
        partialResultCount: subResults.length,
      });

      return {
        success: false,
        mode: this.mode,
        taskId: task.id,
        error: errorMsg,
        durationMs: duration,
        // Return all partial results collected before the failure
        subResults: subResults.length > 0 ? subResults : undefined,
        output: subResults.length > 0
          ? `Speed campaign failed after ${subResults.length} sub-task(s) completed: ${errorMsg}`
          : undefined,
        errors: [errorMsg],
        completedAt: new Date().toISOString(),
      };
    }
  }

  // ===========================================================================
  // Step 1: Decompose — Split the user prompt into independent sub-tasks
  // ===========================================================================

  /**
   * Decompose the task into a list of independent sub-tasks.
   *
   * Decomposition follows a two-path strategy:
   *
   * Path A — Prompt-based decomposition (preferred):
   *   If a root agent is available on the orchestrator, invoke it with a
   *   meta-prompt asking the LLM to split the work into independent units.
   *   The response is parsed via parseSubTasksFromOutput().
   *
   * Path B — Fallback heuristic:
   *   If no agent is available, split the prompt on bullet-point or
   *   numbered-list markers. If fewer than 2 items are found, treat the
   *   entire prompt as a single sub-task.
   *
   * Edge cases:
   *   - Empty prompt          → single sub-task with description "Execute the task"
   *   - Very long (>1000 char)→ capped to at most 5 sub-tasks
   *   - No identifiable structure → single sub-task wrapping the full prompt
   */
  private async decomposeTask(
    task: Task,
    orchestrator: OrchestratorCore,
  ): Promise<SubTask[]> {
    const prompt = task.prompt.trim();

    // ── Edge case: empty prompt ────────────────────────────────────────────
    if (!prompt) {
      return [
        {
          id: `${task.id}-sub-${randomUUID().slice(0, 8)}`,
          parentTaskId: task.id,
          description: "Execute the task",
          status: "pending",
          phase: "implementation",
          createdAt: new Date().toISOString(),
        },
      ];
    }

    // ── Path A: Prompt-based decomposition via root agent (preferred) ──────
    const agent = orchestrator.rootAgent;
    if (agent) {
      try {
        const metaPrompt =
          `Break down the following task into independent sub-tasks that can be executed in parallel. ` +
          `Each sub-task must produce output that does not depend on any other sub-task. ` +
          `Output ONLY a numbered list with one sub-task per line. Do not add explanations.\n\n` +
          `Task: ${prompt}`;

        const result = await runAgentTurn(agent, metaPrompt);

        if (!result.error && result.output) {
          const parsed = this.parseSubTasksFromOutput(result.output, task.id);

          // Cap at 5 for very long prompts (>1000 chars)
          const maxSubTasks = prompt.length > 1000 ? 5 : Infinity;
          const capped = parsed.slice(0, maxSubTasks);

          if (capped.length > 0) {
            return capped;
          }
          // If parsing yielded nothing, fall through to Path B
        }
      } catch {
        // Agent invocation failed — fall through to Path B
      }
    }

    // ── Path B: Fallback heuristic splitting ──────────────────────────────
    return this.heuristicSplit(prompt, task.id);
  }

  /**
   * Fallback heuristic: split the prompt on bullet-point or numbered-list
   * markers.  If fewer than 2 items are found, return a single sub-task
   * wrapping the full prompt.
   */
  private heuristicSplit(prompt: string, parentTaskId: string): SubTask[] {
    const lines = prompt.split("\n");
    const items: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Match bullet points: "- ", "* ", "• "
      const bulletMatch = trimmed.match(/^[-*\u2022]\s+(.+)$/);
      if (bulletMatch && bulletMatch[1]) {
        items.push(bulletMatch[1].trim());
        continue;
      }

      // Match numbered lists: "1.", "2)", "1)", "2.", etc.
      const numMatch = trimmed.match(/^\d+[.)]\s*(.+)$/);
      if (numMatch && numMatch[1]) {
        items.push(numMatch[1].trim());
        continue;
      }
    }

    // If we found at least 2 items, use them; otherwise wrap the whole prompt
    const descriptions = items.length >= 2 ? items : [prompt];

    // Cap at 5 for very long prompts (>1000 chars)
    const maxSubTasks = prompt.length > 1000 ? 5 : Infinity;
    const capped = descriptions.slice(0, maxSubTasks);

    return capped.map((desc) => ({
      id: `${parentTaskId}-sub-${randomUUID().slice(0, 8)}`,
      parentTaskId,
      description: desc,
      status: "pending" as const,
      phase: "implementation" as const,
      createdAt: new Date().toISOString(),
    }));
  }

  /**
   * Parse the LLM's numbered-list response into SubTask objects.
   *
   * 1. Split the output on newlines
   * 2. Filter lines matching `^\s*\d+[.)]\s+`
   * 3. Strip the numbering prefix
   * 4. Create a SubTask for each remaining line
   */
  private parseSubTasksFromOutput(output: string, parentTaskId: string): SubTask[] {
    const lines = output.split("\n");
    const subTasks: SubTask[] = [];
    let index = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // Match numbered list items: optional whitespace, digits, then "." or ")", then whitespace
      const match = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (!match || !match[1]) continue;

      const description = match[1].trim();
      if (!description) continue;

      subTasks.push({
        id: `${parentTaskId}-sub-${index}`,
        parentTaskId,
        description,
        status: "pending",
        phase: "implementation",
        createdAt: new Date().toISOString(),
      });

      index++;
    }

    return subTasks;
  }

  // ===========================================================================
  // Step 2: Dispatch — Fire all sub-tasks in parallel via the pool manager
  // ===========================================================================

  /**
   * Dispatch all sub-tasks through the pool manager for parallel execution.
   *
   * The key insight is that SpeedCampaignMode's "parallel" means "schedule all
   * tasks at once and let the pool's concurrency control handle actual parallelism."
   *
   * This method:
   *   1. Schedules every sub-task with `orchestrator.poolManager.schedule()`
   *   2. Creates one promise per sub-task using `waitForTaskCompletion()`
   *   3. Waits for all promises via `Promise.allSettled()`
   *   4. Emits start/completion events for each sub-task
   *
   * If `orchestrator.poolManager` is not available (no sub-agent host), falls
   * back to sequential execution by calling `runAgentTurn` for each sub-task
   * directly through the orchestrator's root agent.
   */
  private async dispatchAll(
    subTasks: SubTask[],
    orchestrator: OrchestratorCore,
  ): Promise<void> {
    // ── Fallback: no pool manager → sequential execution via root agent ──
    if (!orchestrator.poolManager) {
      await this.sequentialFallback(subTasks, orchestrator);
      return;
    }

    // ── Primary path: schedule all through the pool manager ──────────────
    const completionPromises: Promise<ExecutionResult>[] = [];

    // Mark each sub-task as pending and track the promise
    const resultMap = new Map<string, ExecutionResult>();

    for (const subTask of subTasks) {
      // Emit "subtask.started" event
      orchestrator.recordAgentEvent({
        type: "speed-campaign.subtask.started",
        subTaskId: subTask.id,
        description: subTask.description,
      });

      // Schedule the sub-task in the pool
      orchestrator.poolManager.schedule(subTask);

      // Create a promise that resolves when this sub-task completes
      const completionPromise = this.waitForTaskCompletion(
        orchestrator.poolManager,
        subTask.id,
      ).then((result) => {
        resultMap.set(subTask.id, result);

        // Record metrics for this sub-task execution
        orchestrator.recordToolCall(result.success, result.totalTokens ?? 0);
        orchestrator.recordTurn();

        // Emit completion or failure event
        if (result.success) {
          orchestrator.recordAgentEvent({
            type: "speed-campaign.subtask.completed",
            subTaskId: subTask.id,
            success: true,
          });
        } else {
          orchestrator.recordAgentEvent({
            type: "speed-campaign.subtask.failed",
            subTaskId: subTask.id,
            error: result.error ?? "Unknown error",
          });
        }

        return result;
      });

      completionPromises.push(completionPromise);
    }

    // Wait for all sub-tasks to complete (both successes and failures)
    const settled = await Promise.allSettled(completionPromises);

    // Collect any unexpected rejections (should not happen since
    // waitForTaskCompletion catches errors internally, but handle defensively)
    for (const subTask of subTasks) {
      if (!resultMap.has(subTask.id)) {
        // Find the corresponding settled result
        const idx = subTasks.indexOf(subTask);
        const settledResult = settled[idx];

        if (settledResult && settledResult.status === "rejected") {
          const reason = settledResult.reason instanceof Error
            ? settledResult.reason.message
            : String(settledResult.reason);

          resultMap.set(subTask.id, {
            success: false,
            mode: this.mode,
            taskId: subTask.id,
            error: reason,
            completedAt: new Date().toISOString(),
          });

          // Record metrics for the unexpected rejection
          orchestrator.recordToolCall(false, 0);
          orchestrator.recordTurn();

          orchestrator.recordAgentEvent({
            type: "speed-campaign.subtask.failed",
            subTaskId: subTask.id,
            error: reason,
          });
        }
      }
    }

    // Store the results map on the instance so collectResults can retrieve it
    this._completedResults = resultMap;
  }

  /**
   * Instance-level cache of completed sub-task results, populated by
   * dispatchAll and consumed by collectResults.
   */
  private _completedResults: Map<string, ExecutionResult> = new Map();

  /**
   * Reference to the orchestrator, stored during execute() so that
   * collectResults can emit warning events (e.g. file conflicts).
   */
  private _orchestrator: OrchestratorCore | null = null;

  /**
   * Create a promise that resolves when a specific sub-task completes in the pool.
   *
   * Registers a one-shot listener on `poolManager.onCompletion()`. When the
   * completion event matches the given taskId, the promise is resolved with an
   * ExecutionResult constructed from the SubAgentHandle's state.
   *
   * Handles both "completed" and "failed"/"timeout" states. Polls every 250ms
   * as a safety net in case the completion listener fires before registration.
   *
   * @param poolManager - The pool manager to listen on
   * @param taskId      - The ID of the sub-task to wait for
   * @returns A promise that resolves to an ExecutionResult
   */
  private waitForTaskCompletion(
    poolManager: SubAgentPoolManager,
    taskId: string,
  ): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>((resolve) => {
      // Safety net: poll for completion in case the event fires before we register
      const pollTimer = setInterval(() => {
        const handle = poolManager.getAgent(taskId);
        if (!handle) return;

        if (handle.state === "completed" || handle.state === "failed" || handle.state === "timeout") {
          clearInterval(pollTimer);
          resolve(this.buildResultFromHandle(handle));
        }
      }, 250);

      // One-shot completion listener
      const listener = (handle: SubAgentHandle): void => {
        if (handle.id === taskId) {
          clearInterval(pollTimer);
          poolManager.offCompletion(listener);
          resolve(this.buildResultFromHandle(handle));
        }
      };

      poolManager.onCompletion(listener);

      // Also check immediately if the task already completed
      const existing = poolManager.getAgent(taskId);
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
        ? `Sub-task completed (${handle.profile}): ${handle.task?.description ?? handle.id}`
        : undefined,
      error: isSuccess
        ? undefined
        : handle.state === "timeout"
          ? `Sub-task timed out after ${handle.state === "timeout" ? "exceeding timeout threshold" : "unknown reason"}`
          : `Sub-task failed after ${handle.errorCount} error(s)`,
      totalTokens,
      llmCallCount: 1,
      toolCallCount: 0,
      durationMs: handle.startedAt ? Date.now() - handle.startedAt : 0,
      changedFiles: [],
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Fallback: execute sub-tasks sequentially through the root agent when
   * no pool manager is available.
   *
   * This uses `runAgentTurn` directly on the orchestrator's root agent,
   * executing one sub-task at a time. Results are stored in _completedResults
   * so collectResults can read them uniformly.
   */
  private async sequentialFallback(
    subTasks: SubTask[],
    orchestrator: OrchestratorCore,
  ): Promise<void> {
    const resultMap = new Map<string, ExecutionResult>();

    for (const subTask of subTasks) {
      // Emit start event
      orchestrator.recordAgentEvent({
        type: "speed-campaign.subtask.started",
        subTaskId: subTask.id,
        description: subTask.description,
      });

      const startedAt = Date.now();

      if (!orchestrator.rootAgent) {
        // No agent at all — produce a minimal failure result
        const result: ExecutionResult = {
          success: false,
          mode: this.mode,
          taskId: subTask.id,
          error: "No agent available to execute sub-task",
          durationMs: Date.now() - startedAt,
          completedAt: new Date().toISOString(),
        };
        resultMap.set(subTask.id, result);

        // Record metrics for the failed execution
        orchestrator.recordToolCall(false, 0);
        orchestrator.recordTurn();

        orchestrator.recordAgentEvent({
          type: "speed-campaign.subtask.failed",
          subTaskId: subTask.id,
          error: "No agent available to execute sub-task",
        });
        continue;
      }

      try {
        const turnResult = await runAgentTurn(
          orchestrator.rootAgent,
          subTask.description,
          orchestrator.getAbortSignal(),
        );

        const success = !turnResult.error && turnResult.output.length > 0;
        const result: ExecutionResult = {
          success,
          mode: this.mode,
          taskId: subTask.id,
          output: turnResult.output,
          error: turnResult.error,
          totalTokens: 0,
          llmCallCount: 1,
          toolCallCount: turnResult.toolCalls,
          durationMs: turnResult.durationMs,
          completedAt: new Date().toISOString(),
        };
        resultMap.set(subTask.id, result);

        // Record metrics for this sub-task execution
        orchestrator.recordToolCall(success, 1);
        orchestrator.recordTurn();

        orchestrator.recordAgentEvent({
          type: success ? "speed-campaign.subtask.completed" : "speed-campaign.subtask.failed",
          subTaskId: subTask.id,
          success,
          error: turnResult.error,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const result: ExecutionResult = {
          success: false,
          mode: this.mode,
          taskId: subTask.id,
          error: errorMsg,
          durationMs: Date.now() - startedAt,
          completedAt: new Date().toISOString(),
        };
        resultMap.set(subTask.id, result);

        // Record metrics for this sub-task execution (failed)
        orchestrator.recordToolCall(false, 0);
        orchestrator.recordTurn();

        orchestrator.recordAgentEvent({
          type: "speed-campaign.subtask.failed",
          subTaskId: subTask.id,
          error: errorMsg,
        });
      }
    }

    this._completedResults = resultMap;
  }

  // ===========================================================================
  // Step 3: Collect — Gather results from completed sub-tasks
  // ===========================================================================

  /**
   * Collect results from all completed sub-tasks, aggregate them into a
   * final summary, and deduplicate changed files.
   *
   * Reads from the provided `results` map (populated by `dispatchAll`),
   * keyed by sub-task ID. For any sub-task that does not have a result in
   * the map, a default failure result is created to ensure the caller
   * always gets a complete set.
   *
   * Aggregation steps:
   *   1. Separate successful results from failed ones
   *   2. Collect all `changedFiles` arrays into a single deduplicated set
   *   3. Collect all `newContents` maps into a single merged map with
   *      conflict detection — if two sub-tasks changed the same file,
   *      emit a warning event (`speed-campaign.file-conflict`) and keep
   *      the first one
   *   4. Calculate aggregate metrics: totalTokens, llmCallCount, toolCallCount
   *      (sum across all sub-results)
   *   5. Build the output string with a summary line per sub-task showing
   *      its success/failure status
   *
   * @param results  - Map of sub-task ID → ExecutionResult from dispatch
   * @param subTasks - The list of sub-tasks that were dispatched
   * @returns An object containing:
   *   - aggregateResult: Partial ExecutionResult with aggregated fields
   *     (success, output, totalTokens, llmCallCount, toolCallCount, subResults)
   *   - changedFiles: Deduplicated array of file paths
   *   - errors: Array of error strings from failed sub-tasks
   */
  private collectResults(
    results: Map<string, ExecutionResult>,
    subTasks: SubTask[],
  ): { aggregateResult: Partial<ExecutionResult>; changedFiles: string[]; errors: string[] } {
    // ── Ensure every sub-task has a result ─────────────────────────────────
    const resolvedResults: ExecutionResult[] = [];
    const errors: string[] = [];

    for (const subTask of subTasks) {
      const result = results.get(subTask.id);
      if (result) {
        resolvedResults.push(result);
        if (!result.success && result.error) {
          errors.push(result.error);
        }
      } else {
        // Sub-task did not produce a result — create a default failure
        const fallback: ExecutionResult = {
          success: false,
          mode: this.mode,
          taskId: subTask.id,
          error: `No result collected for sub-task "${subTask.description}"`,
          completedAt: new Date().toISOString(),
        };
        resolvedResults.push(fallback);
        errors.push(`No result collected for sub-task "${subTask.description}"`);
      }
    }

    // ── Step 1: Separate successful results from failed ones ────────────────
    const successfulResults = resolvedResults.filter((r) => r.success);
    const failedResults = resolvedResults.filter((r) => !r.success);

    // ── Step 2: Collect all changedFiles into a deduplicated set ────────────
    const changedFilesSet = new Set<string>();
    for (const result of resolvedResults) {
      if (result.changedFiles) {
        for (const file of result.changedFiles) {
          changedFilesSet.add(file);
        }
      }
    }
    const changedFiles = Array.from(changedFilesSet);

    // ── Step 3: Merge newContents maps with conflict detection ──────────────
    const mergedNewContents: Record<string, string> = {};
    const seenFiles = new Set<string>();
    const orchestrator = this._orchestrator;

    for (const result of resolvedResults) {
      if (!result.newContents) continue;
      for (const [filePath, content] of Object.entries(result.newContents)) {
        if (seenFiles.has(filePath)) {
          // Conflict detected — emit warning and skip the second one
          const msg = `File conflict: "${filePath}" was already changed by another sub-task. Skipping duplicate.`;
          if (orchestrator) {
            orchestrator.recordAgentEvent({
              type: "speed-campaign.file-conflict",
              filePath,
              message: msg,
            });
          }
          // Log to console as well for visibility
          console.warn(`[SpeedCampaign] ${msg}`);
        } else {
          mergedNewContents[filePath] = content;
          seenFiles.add(filePath);
        }
      }
    }

    // ── Step 4: Calculate aggregate metrics ─────────────────────────────────
    const totalTokens = resolvedResults.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
    const llmCallCount = resolvedResults.reduce((sum, r) => sum + (r.llmCallCount ?? 0), 0);
    const toolCallCount = resolvedResults.reduce((sum, r) => sum + (r.toolCallCount ?? 0), 0);

    // ── Step 5: Build the summary output string ────────────────────────────
    const outputLines: string[] = [];
    outputLines.push(`## Results (${resolvedResults.length} sub-tasks)`);
    for (let i = 0; i < subTasks.length; i++) {
      const sub = subTasks[i];
      const result = resolvedResults[i];
      if (!sub || !result) continue;
      const icon = result.success ? "✓" : "✗";
      const summary = result.success
        ? (result.output?.split("\n")[0] ?? "Completed")
        : (result.error ?? "Failed without error message");
      outputLines.push(`${icon} ${sub.description}: ${summary}`);
    }
    outputLines.push("");
    outputLines.push("## Summary");
    outputLines.push(`- Completed: ${successfulResults.length} / ${resolvedResults.length}`);
    outputLines.push(`- Failed: ${failedResults.length}`);
    // Duration is computed externally in execute(), so we omit it here

    const output = outputLines.join("\n");

    // ── Compose aggregate result ───────────────────────────────────────────
    const aggregateResult: Partial<ExecutionResult> = {
      success: failedResults.length === 0,
      output,
      totalTokens,
      llmCallCount,
      toolCallCount,
      subResults: resolvedResults,
      changedFiles,
      newContents: mergedNewContents,
      errors: errors.length > 0 ? errors : undefined,
    };

    return { aggregateResult, changedFiles, errors };
  }

  // ===========================================================================
  // Step 4: Validate — Run minimal syntax/type check on changed files
  // ===========================================================================

  /**
   * Run minimal syntax validation on files changed by sub-task execution.
   *
   * Uses only the SyntaxCheckGate from the VerificationPipeline (Level 0).
   * Does NOT run lint, type checks, tests, architecture checks, or the full
   * test suite — speed is the priority.
   *
   * If the changed-files list is empty, validation is trivially passed with
   * no diagnostics. Otherwise, each file is parsed in-process by the
   * SyntaxCheckGate, which supports TypeScript (via ts.createSourceFile),
   * JavaScript (via Babel), Python (via py_compile), Rust (via cargo check),
   * and Go (via go vet).
   *
   * Diagnostics with severity error cause validation to fail. Warning and
   * info-level diagnostics are collected but do not block success.
   *
   * @param changedFiles - Array of file paths that were modified
   * @param orchestrator - Orchestrator core for workspace root and abort signal
   * @returns GateResult with passed boolean and diagnostics array
   */
  private async validateResults(
    changedFiles: string[],
    orchestrator: OrchestratorCore,
  ): Promise<GateResult> {
    // ── Edge case: no files to validate ──────────────────────────────────
    if (changedFiles.length === 0) {
      return { passed: true, diagnostics: [], durationMs: 0 };
    }

    // ── Instantiate SyntaxCheckGate and run it ──────────────────────────
    const syntaxGate = new SyntaxCheckGate();
    let result: GateResult;

    try {
      result = await syntaxGate.run(changedFiles, {
        workspaceRoot: orchestrator.workspaceRoot,
        signal: orchestrator.getAbortSignal(),
      });
    } catch (err) {
      // Gate threw unexpectedly — treat as a hard failure
      const errorMsg = err instanceof Error ? err.message : String(err);
      result = {
        passed: false,
        diagnostics: [{
          file: '',
          line: 0,
          column: 0,
          message: `Syntax check gate threw unexpectedly: ${errorMsg}`,
          severity: 'error',
          rule: 'syntax-gate-crash',
          code: 'SYNTAX_GATE_CRASH',
        }],
        durationMs: 0,
      };
    }

    // ── Log error-level diagnostics as info events ──────────────────────
    const errorDiagnostics = result.diagnostics.filter(d => d.severity === 'error');
    if (errorDiagnostics.length > 0) {
      orchestrator.recordAgentEvent({
        type: 'speed-campaign.syntax-error',
        count: errorDiagnostics.length,
        details: errorDiagnostics.map(d => ({
          file: d.file,
          line: d.line,
          message: d.message,
        })),
      });
    }

    return result;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Build a human-readable output summary mirroring the LightweightPlanMode format.
   *
   * Output format:
   * ```
   * # [Task prompt summary]
   *
   * ## Results (N sub-tasks)
   * ✓ [title]: [brief output summary]
   * ✗ [title]: [error message]
   *
   * ## Summary
   * - Completed: X / N
   * - Failed: Y
   * - Duration: Zs
   * ```
   */
  private buildOutput(
    task: Task,
    subTasks: SubTask[],
    aggregateResult: Partial<ExecutionResult>,
    validationPassed: boolean,
    errors: string[],
  ): string {
    const lines: string[] = [];

    // Title: task prompt summary (first 200 chars)
    const promptSummary = task.prompt.length > 200
      ? task.prompt.slice(0, 200) + "..."
      : task.prompt;
    lines.push(`# ${promptSummary}`);
    lines.push("");

    // Results section
    const subResults = aggregateResult.subResults ?? [];
    lines.push(`## Results (${subResults.length} sub-tasks)`);
    for (let i = 0; i < subTasks.length; i++) {
      const sub = subTasks[i];
      const result = subResults[i];
      if (!sub || !result) continue;

      const icon = result.success ? "✓" : "✗";
      const summary = result.success
        ? (result.output?.split("\n")[0]?.trim() ?? "Completed")
        : (result.error ?? "Failed without error message");
      lines.push(`${icon} ${sub.description}: ${summary}`);
    }

    lines.push("");

    // Summary section
    const successCount = subResults.filter((r) => r.success).length;
    const failedCount = subResults.filter((r) => !r.success).length;
    const durationMs = aggregateResult.durationMs ?? 0;
    const durationSec = (durationMs / 1000).toFixed(1);

    lines.push("## Summary");
    lines.push(`- Completed: ${successCount} / ${subResults.length}`);
    lines.push(`- Failed: ${failedCount}`);
    lines.push(`- Duration: ${durationSec}s`);

    // Validation status
    if (!validationPassed) {
      lines.push("- Validation: FAILED");
    }

    // Aggregated metrics
    lines.push(`- Total tokens: ${aggregateResult.totalTokens ?? 0}`);
    lines.push(`- LLM calls: ${aggregateResult.llmCallCount ?? 0}`);
    lines.push(`- Tool calls: ${aggregateResult.toolCallCount ?? 0}`);

    // Changed files
    const changedFiles = aggregateResult.changedFiles;
    if (changedFiles && changedFiles.length > 0) {
      lines.push(`- Files changed: ${changedFiles.length}`);
    }

    // Errors if any
    if (errors.length > 0) {
      lines.push("");
      lines.push("### Errors");
      for (const err of errors) {
        lines.push(`- ${err}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Build an error summary string from failed sub-tasks and/or validation.
   */
  private buildErrorSummary(
    subResults: ExecutionResult[],
    validationPassed: boolean,
  ): string | undefined {
    const errors: string[] = [];

    if (!validationPassed) {
      errors.push("Validation failed");
    }

    const failedTasks = subResults.filter((r) => !r.success);
    for (const task of failedTasks) {
      if (task.error) {
        errors.push(task.error);
      } else {
        errors.push(`Sub-task ${task.taskId} failed`);
      }
    }

    return errors.length > 0 ? errors.join("; ") : undefined;
  }

  /**
   * Generate a natural-language summary via the root agent.
   *
   * After all sub-tasks complete and validation passes, this method
   * calls the root agent with a meta-prompt that includes the original
   * user request, the structured results, and the list of changed files.
   * The agent writes a concise concluding message answering the user's
   * original question and describing what was done.
   *
   * This is best-effort — if the agent is unavailable or the call fails,
   * the method returns undefined and the caller falls back to the
   * structured buildOutput().
   *
   * @param task            The original task (for the user prompt)
   * @param changedFiles    Array of file paths that were modified
   * @param structuredOutput The structured output from buildOutput()
   * @param orchestrator    The orchestrator core (for root agent access)
   * @returns The LLM-generated summary text, or undefined on failure
   */
  private async generateSummary(
    task: Task,
    changedFiles: string[],
    structuredOutput: string,
    orchestrator: OrchestratorCore,
  ): Promise<string | undefined> {
    const agent = orchestrator.rootAgent;
    if (!agent) return undefined;

    // Build a concise summary of changed files for the prompt
    const fileList = changedFiles.length > 0
      ? changedFiles.map((f) => `  - ${f}`).join("\n")
      : "  (no files changed)";

    const summaryPrompt =
      `You are a senior engineer providing a final summary after completing a task.\n\n` +
      `The task has been decomposed into sub-tasks and executed in parallel. ` +
      `Below are the structured results and the list of files that were changed.\n\n` +
      `## Original Request\n${task.prompt}\n\n` +
      `## Results\n${structuredOutput}\n\n` +
      `## Files Changed\n${fileList}\n\n` +
      `Write a concise, natural-language summary that answers the user's original request. ` +
      `Explain what was done, what was found (if anything went wrong), what files were changed, ` +
      `and the overall outcome. Be specific — reference actual file names and issues found. ` +
      `This summary will be shown to the user as the final response.`;

    orchestrator.recordAgentEvent({
      type: "speed-campaign.summary.generating",
    });

    const result = await runAgentTurn(agent, summaryPrompt, orchestrator.getAbortSignal());

    if (result.error) {
      orchestrator.recordAgentEvent({
        type: "speed-campaign.summary.failed",
        error: result.error,
      });
      return undefined;
    }

    return result.output || undefined;
  }
}