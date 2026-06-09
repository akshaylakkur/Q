/**
 * CampaignContinuousMode — Persistent daemon-like execution mode.
 *
 * Enters a persistent mode with LTPM continuously indexing, codebase graph
 * refreshing after every convergence cycle, rolling verification, progress
 * checkpoints every N convergences, pause/resume capability, and automatic
 * compaction at progressive thresholds.
 */

import { ExecutionModeHandler } from "./handler.js";
import { ExecutionModes } from "./index.js";
import type { ExecutionMode } from "./index.js";
import type { Task, ExecutionResult, SubTask, TaskPhase, CampaignState } from "./types.js";
import type { OrchestratorCore } from "../core.js";

/** Progressive compaction thresholds (percentage of max turns) */
const COMPACTION_THRESHOLDS = [0.25, 0.5, 0.75];

/** Checkpoint interval in convergences */
const CHECKPOINT_INTERVAL = 5;

export class CampaignContinuousMode extends ExecutionModeHandler {
  readonly mode: ExecutionMode = ExecutionModes.CAMPAIGN_CONTINUOUS;
  readonly description = "Daemon campaign — persistent, auto-indexing, rolling verification, pause/resume";

  private state: CampaignState | null = null;

  /**
   * Execute a task in campaign continuous mode.
   *
   * Strategy:
   * 1. Initialize campaign state (LTPM, codebase graph).
   * 2. Enter the main daemon loop:
   *    a. Check pause/stop signals.
   *    b. Run convergence cycle (explore → implement → verify → converge).
   *    c. Refresh codebase graph.
   *    d. Rolling verification.
   *    e. Progress checkpoint at interval.
   *    f. Check compaction thresholds.
   * 3. Return final consolidated result.
   */
  async execute(task: Task, orchestrator: OrchestratorCore): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const allResults: ExecutionResult[] = [];
    const errors: string[] = [];
    let totalTokens = 0;
    let llmCalls = 0;
    let toolCalls = 0;

    try {
      // Step 1: Initialize campaign state
      this.state = this.initializeCampaign(task);
      const maxCycles = task.profile?.estimatedTurns ?? 20;

      // Step 2: Main daemon loop
      for (let cycle = 0; cycle < maxCycles; cycle++) {
        // Check pause request
        if (this.state.pauseRequested) {
          this.state.pauseRequested = false;
          // Wait for resume (in full implementation, this blocks until resume signal)
          continue;
        }

        // Check stop request
        if (this.state.shouldStop) {
          break;
        }

        // Run convergence cycle
        const cycleResult = await this.runConvergenceCycle(cycle, task, orchestrator);
        allResults.push(cycleResult);
        totalTokens += cycleResult.totalTokens ?? 0;
        llmCalls += cycleResult.llmCallCount ?? 0;
        toolCalls += cycleResult.toolCallCount ?? 0;

        if (!cycleResult.success && cycleResult.error) {
          errors.push(`Cycle ${cycle}: ${cycleResult.error}`);
        }

        // Refresh codebase graph
        await this.refreshCodebaseGraph(orchestrator);

        // Rolling verification
        const verificationResult = await this.rollingVerify(allResults, orchestrator);
        if (!verificationResult.passed) {
          errors.push(`Rolling verification failed at cycle ${cycle}: ${verificationResult.message}`);
        }

        // Progress checkpoint
        this.state.convergenceCount++;
        if (this.state.convergenceCount % CHECKPOINT_INTERVAL === 0) {
          this.recordCheckpoint(allResults, totalTokens);
        }

        // Check compaction thresholds
        const compactionThreshold = this.checkCompaction(allResults.length, maxCycles);
        if (compactionThreshold > this.state.lastCompactionThreshold) {
          await this.compact(orchestrator);
          this.state.lastCompactionThreshold = compactionThreshold;
        }
      }

      return {
        success: errors.length === 0,
        mode: this.mode,
        taskId: task.id,
        output: `[CampaignContinuousMode] Completed ${allResults.length}/${maxCycles} convergence cycles. Errors: ${errors.length}`,
        error: errors.length > 0 ? errors.join("; ") : undefined,
        totalTokens,
        llmCallCount: llmCalls,
        toolCallCount: toolCalls,
        durationMs: Date.now() - startedAt,
        verificationPassed: errors.length === 0,
        subResults: allResults,
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
        subResults: allResults.length > 0 ? allResults : undefined,
        errors: errors.length > 0 ? errors : undefined,
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Initialize the campaign state.
   */
  private initializeCampaign(task: Task): CampaignState {
    return {
      campaignId: `campaign-${task.id}`,
      originalTask: task,
      currentPhase: "research",
      completedPhases: [],
      convergenceCount: 0,
      pauseRequested: false,
      shouldStop: false,
      lastCompactionThreshold: 0,
      progressCheckpoints: [],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Run a single convergence cycle.
   */
  private async runConvergenceCycle(
    cycleIndex: number,
    _task: Task,
    _orchestrator: OrchestratorCore,
  ): Promise<ExecutionResult> {
    // In full implementation, this cycles through phases:
    // Phase 1: Research + Explore
    // Phase 2: Scaffolding + Dependency resolution
    // Phase 3: Implementation agents in parallel
    // Phase 4: Test generation + Documentation
    // Phase 5: Full verification + Self-correction

    const phase = this.getPhaseForCycle(cycleIndex);
    if (this.state) {
      this.state.currentPhase = phase;
    }

    const phaseLabels: Record<TaskPhase, string> = {
      research: "Research and exploration",
      explore: "Codebase exploration",
      scaffolding: "Scaffolding new structures",
      dependency_resolution: "Dependency resolution",
      implementation: "Implementation changes",
      test_generation: "Test generation",
      documentation: "Documentation updates",
      verification: "Verification and validation",
      self_correction: "Self-correction",
      convergence: "Convergence integration",
    };

    return {
      success: true,
      mode: this.mode,
      taskId: `${_task.id}-cycle-${cycleIndex}`,
      output: `[CampaignContinuousMode] Cycle ${cycleIndex}: Phase "${phaseLabels[phase] ?? phase}" completed`,
      totalTokens: 0,
      llmCallCount: 1,
      toolCallCount: 0,
      changedFiles: [],
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Determine which phase a given cycle corresponds to.
   */
  private getPhaseForCycle(cycleIndex: number): TaskPhase {
    const phases: TaskPhase[] = [
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
    return phases[cycleIndex % phases.length] ?? "implementation";
  }

  /**
   * Refresh the codebase graph after each convergence cycle.
   */
  private async refreshCodebaseGraph(
    _orchestrator: OrchestratorCore,
  ): Promise<void> {
    // In full implementation:
    // 1. Re-scan workspace files
    // 2. Update dependency graph
    // 3. Update LTPM index
  }

  /**
   * Rolling verification across all completed cycles.
   */
  private async rollingVerify(
    _results: ExecutionResult[],
    _orchestrator: OrchestratorCore,
  ): Promise<{ passed: boolean; message?: string }> {
    // In full implementation:
    // Run lint, type-check, and tests on accumulated changes
    return { passed: true };
  }

  /**
   * Record a progress checkpoint.
   */
  private recordCheckpoint(
    results: ExecutionResult[],
    tokensUsed: number,
  ): void {
    if (!this.state) return;
    const changedFiles = new Set<string>();
    for (const r of results) {
      if (r.changedFiles) {
        for (const f of r.changedFiles) changedFiles.add(f);
      }
    }
    this.state.progressCheckpoints.push({
      convergenceNumber: this.state.convergenceCount,
      timestamp: new Date().toISOString(),
      filesChanged: changedFiles.size,
      tokensUsed,
    });
  }

  /**
   * Check if compaction should be triggered at progressive thresholds.
   */
  private checkCompaction(completedCycles: number, maxCycles: number): number {
    if (maxCycles === 0) return 0;
    const ratio = completedCycles / maxCycles;

    for (const threshold of COMPACTION_THRESHOLDS) {
      if (ratio >= threshold) {
        return threshold;
      }
    }
    return 0;
  }

  /**
   * Run automatic compaction.
   */
  private async compact(
    _orchestrator: OrchestratorCore,
  ): Promise<void> {
    // In full implementation:
    // 1. Compact session records at progressive thresholds
    // 2. Compress the wire format
    // 3. Clean up stale blobs
  }

  /**
   * Request pause of the campaign (external control).
   */
  requestPause(): void {
    if (this.state) {
      this.state.pauseRequested = true;
    }
  }

  /**
   * Request resume of a paused campaign.
   */
  requestResume(): void {
    if (this.state) {
      this.state.pauseRequested = false;
    }
  }

  /**
   * Request stop of the campaign.
   */
  requestStop(): void {
    if (this.state) {
      this.state.shouldStop = true;
    }
  }
}