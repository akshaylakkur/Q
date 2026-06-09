/**
 * OrchestratorCore — Central state machine & coordinator.
 *
 * Created at session start and lives for the duration of the session.
 * Owns references to all orchestration components and manages the
 * full lifecycle: classify → plan → dispatch → converge → validate → correct.
 */

import { IntentClassifier } from "./intent.js";
import type { SessionContext, ClassificationResult, IntentProfile } from "./intent.js";
import type { ExecutionMode } from "./modes/index.js";
import { ExecutionModes } from "./modes/index.js";
import { DynamicReclassifier } from "./modes/dynamic-reclassifier.js";
import type { ReclassifierThresholds } from "./modes/dynamic-reclassifier.js";
import type { Task, ExecutionResult, ExecutionMetrics, EscalationRecommendation, SubTask } from "./modes/types.js";
import { SubAgentPoolManager } from "./pool.js";
import type { SubAgentHandle, PoolConfig } from "./pool.js";
import { TaskDecomposer } from "./taskgraph.js";
import type { TaskGraph, WaveDispatchResult, WorkspaceTopologyInfo } from "./taskgraph.js";
import { ConvergenceEngine } from "./convergence.js";
import { VerificationPipeline } from "./verification.js";
import type { ExecutionModeLevel, GateContext } from "./verification.js";
import { SelfCorrectionCycle } from "./correction.js";
import type { CorrectionResult } from "./correction.js";
import { MemoryCoordinator } from "../memory/coordinator.js";
import type { Agent, RpcChannel } from "@q/agent-core";
import { WorkingMemory } from "../memory/working.js";
import { LTPMStore } from "../memory/ltpm.js";
import { CompactionProtocolHandler, EpisodeBuilder } from "../memory/episodic.js";
import type { ExtractedFact } from "../memory/types.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PluginManager } from "../plugins/plugin-manager.js";

// =========================================================================
// Types
// =========================================================================

export type OrchestratorState =
  | "idle"
  | "classifying"
  | "planning"
  | "dispatching"
  | "converging"
  | "validating"
  | "correcting"
  | "completed";

export interface OrchestratorStatus {
  state: OrchestratorState;
  mode?: ExecutionMode;
  wave?: number;
  totalWaves?: number;
  progress: number;
  activeAgents: number;
  completedAgents: number;
  failedAgents: number;
  queuedTasks: number;
  currentPhase?: string;
  startedAt?: string;
  durationMs?: number;
}

export interface OrchestratorEvent {
  type: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type OrchestratorEventListener = (event: OrchestratorEvent) => void;

export interface OrchestratorConfig {
  poolConfig?: Partial<PoolConfig>;
  reclassifierThresholds?: Partial<ReclassifierThresholds>;
  defaultMode?: ExecutionMode | "auto";
  convergenceTimeout?: number;
  taskTimeout?: number;
  /** Workspace root directory. Defaults to process.cwd(). */
  workspaceRoot?: string;
}

const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  defaultMode: "auto",
  convergenceTimeout: 60_000,
  taskTimeout: 300_000,
};

// =========================================================================
// OrchestratorCore
// =========================================================================

export class OrchestratorCore {
  // ── State machine ────────────────────────────────────────────────────
  state: OrchestratorState = "idle";
  currentMode?: ExecutionMode;
  currentWave?: number;
  startedAt?: string;

  // ── Component references ──────────────────────────────────────────────
  readonly intentClassifier: IntentClassifier;
  readonly dynamicReclassifier: DynamicReclassifier;
  readonly poolManager: SubAgentPoolManager;
  readonly taskDecomposer: TaskDecomposer;
  readonly memoryCoordinator: MemoryCoordinator;
  readonly convergenceEngine: ConvergenceEngine;
  readonly verificationPipeline: VerificationPipeline;

  // ── In-progress state ─────────────────────────────────────────────────
  private activeTask?: Task;
  private activeGraph?: TaskGraph;
  private activeResult?: ExecutionResult;
  private lastPipelineResult?: import("./verification.js").PipelineResult;
  private abortController = new AbortController();
  private previousMetrics?: ExecutionMetrics;
  private turnCount = 0;
  private totalTokensUsed = 0;
  private totalToolCalls = 0;
  private totalFailedToolCalls = 0;
  private originalProfile?: IntentProfile;
  private config: OrchestratorConfig;

  // ── Agent reference ─────────────────────────────────────────────────────
  rootAgent: Agent | null = null;

  // ── Session tracking ─────────────────────────────────────────────────
  private _sessionId = "";
  private _topology: import("./topology.js").WorkspaceTopology | null = null;

  // ── Workspace root (scoped to the terminal's cwd) ──────────────────
  private _workspaceRoot: string;

  // ── Event listeners ───────────────────────────────────────────────────
  private eventListeners: OrchestratorEventListener[] = [];

  // ── Pause support ─────────────────────────────────────────────────────
  private _pauseResolver?: () => void;
  private _paused = false;

  // ── Plugin system ──────────────────────────────────────────────────────
  private _pluginManager: PluginManager | null = null;

  constructor(config?: OrchestratorConfig) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
    this._workspaceRoot = config?.workspaceRoot ?? process.cwd();
    this.poolManager = new SubAgentPoolManager(this.config.poolConfig);
    this.intentClassifier = new IntentClassifier();
    this.dynamicReclassifier = new DynamicReclassifier(this.config.reclassifierThresholds);
    this.taskDecomposer = new TaskDecomposer(this.poolManager);
    this.convergenceEngine = new ConvergenceEngine();
    this.verificationPipeline = new VerificationPipeline();
    this.memoryCoordinator = new MemoryCoordinator();
    this.poolManager.setMemoryCoordinator(this.memoryCoordinator);
  }

  // =======================================================================
  // Public API
  // =======================================================================

  /**
   * Submit a user prompt for orchestration.
   * Orchestrates the full lifecycle and returns an ExecutionResult.
   */
  async submitPrompt(
    prompt: string,
    context?: SessionContext,
    topology?: WorkspaceTopologyInfo,
  ): Promise<ExecutionResult> {
    if (this.state !== "idle") {
      throw new Error(`Orchestrator is not idle (state: ${this.state}). Cancel or wait.`);
    }

    this.emitEvent({ type: "orchestration.start", timestamp: iso(), data: { prompt: prompt.slice(0, 200) } });

    const startedAt = Date.now();
    this.startedAt = iso();
    this.activeTask = { id: crypto.randomUUID(), prompt, createdAt: this.startedAt };

    try {
      // ── Step 1: Classify ────────────────────────────────────────────
      this.transitionTo("classifying");
      const classification = this.intentClassifier.classify(prompt, context ?? { activeDecisions: [] });
      this.emitEvent({ type: "classification.complete", timestamp: iso(), data: { mode: classification.mode, scope: classification.profile.scope, depth: classification.profile.depth, reason: classification.reason } });
      this.originalProfile = classification.profile;

      // Determine execution mode — user-selected mode takes priority,
      // otherwise falls back to the classifier recommendation (which returns AUTO).
      const mode: ExecutionMode = this.config.defaultMode === "auto"
        ? classification.mode
        : (this.config.defaultMode as ExecutionMode);
      this.currentMode = mode;

      // ── Step 2: Execute through the standard agentic loop.
      // All modes flow through the same execution path at this stage.
      // Future implementations will wire each mode to its specific strategy.
      const result = await this.executeDirectOrLightweight(mode, classification);
      this.activeResult = result;
      this.transitionTo("idle");
      this.emitEvent({ type: "orchestration.complete", timestamp: iso(), data: { success: result.success, mode } });
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.activeResult = {
        success: false,
        mode: this.currentMode ?? ExecutionModes.AUTO,
        taskId: this.activeTask?.id ?? "unknown",
        error: errMsg,
        durationMs: Date.now() - startedAt,
        completedAt: iso(),
      };
      this.emitEvent({ type: "orchestration.error", timestamp: iso(), data: { error: errMsg } });
      this.transitionTo("idle");
      return this.activeResult!;
    }
  }

  /**
   * Set the root agent for LLM execution.
   *
   * Also wires `agent.subagentHost` to the SubAgentPoolManager's
   * SessionSubagentHost, so the Agent tool can spawn sub-agents.
   */
  setAgent(agent: Agent): void {
    this.rootAgent = agent;
    this.poolManager.setRootAgent(agent);

    // Share the pool's SessionSubagentHost with the root agent so the
    // Agent tool's resolveExecution can call subagentHost.spawnSubagent.
    const host = (this.poolManager as unknown as { subagentHost?: { spawnSubagent: (...args: unknown[]) => unknown } }).subagentHost;
    if (host && typeof (host as { spawnSubagent?: unknown }).spawnSubagent === "function") {
      (agent as unknown as { subagentHost: typeof host }).subagentHost = host as typeof host;
    }
  }

  /**
   * Initialize the complete multi-tier memory system.
   *
   * Wires up all four memory tiers and connects the WorkingMemory compaction
   * flush events to the EpisodicRecall store via the CompactionProtocolHandler.
   *
   * Must be called after setAgent() so that WorkingMemory can be constructed
   * with the real Agent instance.
   *
   * Sets up:
   * - WorkingMemory wrapping the root Agent (with priority retention/compaction)
   * - LTPMStore + SemanticRecallIndex for persistent disk-backed storage
   * - CompactionProtocolHandler bridging WorkingMemory → EpisodicRecall
   * - Agent RPC channel → compaction event bridge
   * - sessionId on the MemoryCoordinator
   * - Loads prior session state into WorkingMemory for session resume
   */
  async initMemorySystem(
    sessionId: string,
    ltpmConfig?: Partial<import("../memory/ltpm.js").LTPMConfig>,
  ): Promise<void> {
    const agent = this.rootAgent;
    if (!agent) {
      return; // No agent yet — will be wired later when agent is available
    }

    // ── 1. Create WorkingMemory wrapping the root Agent ────────────────
    const workingMemory = new WorkingMemory(agent);
    this.memoryCoordinator.setWorkingMemory(workingMemory);

    // ── 2. Create LTPM + SemanticRecall and wire them ─────────────────
    const ltpmStore = new LTPMStore(ltpmConfig);
    await ltpmStore.init();
    await this.memoryCoordinator.initLTPM(ltpmStore);

    // ── 3. Set session ID on all components that need it ───────────────
    this.memoryCoordinator.setSessionId(sessionId);

    // ── 4. Create CompactionProtocolHandler to bridge
    //       WorkingMemory.compactTier3() → EpisodicRecall → LTPM ─────────
    const episodeBuilder = new EpisodeBuilder(sessionId);
    const compactionHandler = new CompactionProtocolHandler(
      this.memoryCoordinator.episodicStore,
      episodeBuilder,
      async (episode) => {
        // LTPM flush callback
        if (ltpmStore) {
          try {
            await ltpmStore.storeEpisode(episode);
          } catch (err) {
            console.error("[Orchestrator] LTPM episode flush failed:", err);
          }
        }
      },
    );

    // ── 5. Wire Agent's RPC emitEvent so compaction events flow through ─
    // Capture existing RPC emission, then add our bridge on top
    const existingEmitEvent = agent["rpc"]?.emitEvent;
    const bridgeRpc: RpcChannel = {
      emitEvent: (event: unknown) => {
        // Forward to existing RPC handler (if any)
        if (existingEmitEvent) {
          existingEmitEvent(event);
        }

        // Handle memory.compaction.flush events from WorkingMemory
        if (
          event &&
          typeof event === "object" &&
          "type" in event &&
          (event as Record<string, unknown>).type === "memory.compaction.flush"
        ) {
          const flushEvent = event as unknown as { pendingFacts: ExtractedFact[]; timestamp: string };
          const result = compactionHandler.handleCompaction(
            flushEvent.pendingFacts ?? [],
            undefined,
            "compaction",
          );
          if (result) {
            // Inject the episode recap back into WorkingMemory
            // as a system reminder
            workingMemory.appendSystemReminder(result.recapText);
          }
        }

        // Also forward to the orchestrator's event system
        // so the TUI can display compaction events
        this.emitEvent({
          type: "memory.compaction",
          timestamp: iso(),
          data: event as Record<string, unknown>,
        });
      },
    };

    // Inject the bridge RPC back into the Agent for live event routing
    // The agent uses setRpcChannel to replace its initial empty stub
    if (typeof (agent as any).setRpcChannel === "function") {
      (agent as any).setRpcChannel(bridgeRpc);
    }
  }

  /**
   * Get or set the workspace root directory.
   */
  get workspaceRoot(): string {
    return this._workspaceRoot;
  }

  setWorkspaceRoot(root: string): void {
    this._workspaceRoot = root;
  }

  /**
   * Set the workspace topology for memory slicing.
   */
  setTopology(topology: import("./topology.js").WorkspaceTopology): void {
    this._topology = topology;
    this.poolManager.setTopology(topology);
  }

  /**
   * Attach a PluginManager for plugin lifecycle on session start.
   */
  setPluginManager(pm: PluginManager): void {
    this._pluginManager = pm;
  }

  /**
   * Set the session ID for this orchestration session.
   * Propagated to the memory coordinator so episodes and decisions
   * are correctly linked to this session.
   */
  setSessionId(sessionId: string): void {
    this._sessionId = sessionId;
    this.memoryCoordinator.setSessionId(sessionId);
  }

  /**
   * Cancel all active operations.
   */
  cancel(): void {
    this.abortController.abort("User cancelled");
    this.poolManager.stop();
    this.emitEvent({ type: "orchestration.cancelled", timestamp: iso() });
    this.transitionTo("idle");
  }

  /**
   * Pause execution (freeze state for later resume).
   */
  async pause(): Promise<void> {
    if (this._paused) return;
    this._paused = true;
    this.emitEvent({ type: "orchestration.paused", timestamp: iso() });

    // Wait for resume
    await new Promise<void>((resolve) => {
      this._pauseResolver = resolve;
    });
  }

  /**
   * Resume from pause.
   */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    if (this._pauseResolver) {
      this._pauseResolver();
      this._pauseResolver = undefined;
    }
    this.emitEvent({ type: "orchestration.resumed", timestamp: iso() });
  }

  /**
   * Get current orchestrator status for TUI display.
   */
  getStatus(): OrchestratorStatus {
    const stateCounts = this.poolManager.getStateCounts();
    return {
      state: this.state,
      mode: this.currentMode,
      wave: this.currentWave,
      totalWaves: this.activeGraph?.waves.length,
      progress: this.activeGraph ? ((this.currentWave ?? 0) / (this.activeGraph.waves.length || 1)) : 0,
      activeAgents: stateCounts.running,
      completedAgents: stateCounts.completed,
      failedAgents: stateCounts.failed + stateCounts.timeout,
      queuedTasks: this.poolManager.getQueueSize(),
      currentPhase: this.activeGraph?.waves[this.currentWave ?? 0]?.phase,
      startedAt: this.startedAt,
      durationMs: this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : 0,
    };
  }

  // =======================================================================
  // Event system
  // =======================================================================

  /** Register an event listener for TUI event emission. */
  onEvent(listener: OrchestratorEventListener): void {
    this.eventListeners.push(listener);
  }

  /** Remove an event listener. */
  offEvent(listener: OrchestratorEventListener): void {
    const idx = this.eventListeners.indexOf(listener);
    if (idx >= 0) this.eventListeners.splice(idx, 1);
  }

  // =======================================================================
  // Internal: State machine
  // =======================================================================

  getAbortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  private transitionTo(newState: OrchestratorState): void {
    const prev = this.state;
    this.state = newState;
    this.emitEvent({ type: `state.${newState}`, timestamp: iso(), data: { from: prev, to: newState } });
  }

  // =======================================================================
  // Internal: AUTO/DIRECT/LIGHTWEIGHT_PLAN execution
  // =======================================================================

  private async executeDirectOrLightweight(
    mode: ExecutionMode,
    classification: ClassificationResult,
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();

    // AUTO/DIRECT/LIGHTWEIGHT_PLAN applies Invisibility Principle: no pool/convergence events emitted
    this.emitEvent({ type: "mode.execute", timestamp: iso(), data: { mode, scope: classification.profile.scope } });

    // Build a minimal task
    const task: Task = {
      id: this.activeTask?.id ?? crypto.randomUUID(),
      prompt: this.activeTask?.prompt ?? "",
      profile: classification.profile,
      mode,
    };

    let result: ExecutionResult;

    // AUTO mode: use the DIRECT handler as the natural default
    if (mode === ExecutionModes.AUTO || mode === ExecutionModes.DIRECT) {
      const { DirectMode } = await import("./modes/direct-mode.js");
      const handler = new DirectMode();
      result = await handler.execute(task, this);
    } else {
      const { LightweightPlanMode } = await import("./modes/lightweight-plan-mode.js");
      const handler = new LightweightPlanMode();
      result = await handler.execute(task, this);
    }

    // Override the result mode to reflect what was actually requested
    // (handlers always return their own hardcoded mode constant)
    result.mode = mode;

    return result;
  }

  // =======================================================================
  // Internal: Convergence — collects completed agent results and runs the
  //            ConvergenceEngine (COLLECT → ANALYZE → RESOLVE → MERGE → VALIDATE)
  // =======================================================================

  private async runConvergence(): Promise<void> {
    this.transitionTo("converging");
    this.emitEvent({ type: "convergence.start", timestamp: iso() });

    // Collect completed sub-agent results from the pool
    const completedHandles = this.poolManager.getAgentsByState("completed");
    const agentResults: ExecutionResult[] = [];
    const agentTasks: SubTask[] = [];

    for (const handle of completedHandles) {
      if (!handle.task) continue;
      agentTasks.push(handle.task);
      agentResults.push({
        success: true,
        mode: this.currentMode ?? ExecutionModes.LIGHTWEIGHT_PLAN,
        taskId: handle.id,
        output: `Changes from ${handle.profile}`,
        totalTokens: handle.tokenUsage.promptTokens + handle.tokenUsage.completionTokens,
        changedFiles: [],
        completedAt: new Date().toISOString(),
      });
    }

    // Run the convergence pipeline
    const convergeResult = await this.convergenceEngine.converge(
      agentResults,
      agentTasks,
      this._workspaceRoot,
    );

    // Emit conflict stats
    this.emitEvent({
      type: "convergence.complete",
      timestamp: iso(),
      data: {
        success: convergeResult.success,
        totalConflicts: convergeResult.totalConflicts,
        unresolvedConflicts: convergeResult.unresolvedConflicts,
        appliedChanges: convergeResult.appliedChanges.length,
        rounds: convergeResult.rounds.length,
      },
    });

    // If convergence failed, log the errors
    if (!convergeResult.success && convergeResult.errors.length > 0) {
      this.emitEvent({
        type: "convergence.error",
        timestamp: iso(),
        data: { errors: convergeResult.errors },
      });
    }

    // Reclassification check (retain from original stub)
    const metrics = this.buildMetrics();
    if (this.previousMetrics && this.currentMode) {
      const escalation = this.dynamicReclassifier.reclassify(metrics, this.previousMetrics);
      if (escalation.shouldEscalate && escalation.recommendedMode && escalation.recommendedMode !== this.currentMode) {
        this.emitEvent({ type: "mode.escalation", timestamp: iso(), data: { from: this.currentMode, to: escalation.recommendedMode, reason: escalation.reason } });
        this.currentMode = escalation.recommendedMode;
      }
    }
    this.previousMetrics = metrics;
  }

  // =======================================================================
  // Internal: Validation — runs the VerificationPipeline (all 7 gates)
  //            at the appropriate gate level for the current execution mode.
  // =======================================================================

  private async runValidation(dispatchResult: WaveDispatchResult): Promise<boolean> {
    this.emitEvent({ type: "validation.start", timestamp: iso() });

    // Collect changed files from completed wave results
    const changedFiles = new Set<string>();
    if (dispatchResult.waveResults) {
      for (const wr of dispatchResult.waveResults) {
        for (const [, taskResult] of wr.taskResults) {
          if (taskResult.changedFiles && taskResult.changedFiles.length > 0) {
            for (const f of taskResult.changedFiles) {
              if (typeof f === "string") changedFiles.add(f);
            }
          }
        }
      }
    }

    // If no real files changed, skip the gate pipeline (nothing to validate)
    const filesToCheck = Array.from(changedFiles).filter(f => f.length > 0);
    if (filesToCheck.length === 0) {
      this.emitEvent({ type: "validation.complete", timestamp: iso(), data: { pass: true, reason: "no files changed" } });
      return true;
    }

    // Determine ExecutionModeLevel from the current mode
    const modeLevel = this.modeToLevel(this.currentMode);

    // Gate context
    const context = {
      workspaceRoot: this._workspaceRoot,
      codebaseGraph: undefined,
      reporter: this.verificationPipeline.getReporter(),
      signal: this.getAbortSignal(),
    };

    const pipelineResult = await this.verificationPipeline.runPipeline(
      filesToCheck,
      modeLevel,
      context,
    );

    // Store for self-correction cycle
    this.lastPipelineResult = pipelineResult;

    // Emit validation outcome
    this.emitEvent({
      type: "validation.complete",
      timestamp: iso(),
      data: {
        pass: pipelineResult.passed,
        gateResults: Object.fromEntries(pipelineResult.gateResults),
        diagnosticCount: pipelineResult.diagnostics.length,
        cached: pipelineResult.cached,
        durationMs: pipelineResult.durationMs,
      },
    });

    return pipelineResult.passed;
  }

  /** Map an ExecutionMode to a VerificationPipeline ExecutionModeLevel (0-4). */
  private modeToLevel(mode?: ExecutionMode): ExecutionModeLevel {
    switch (mode) {
      case ExecutionModes.AUTO: return 0;
      case ExecutionModes.DIRECT: return 0;
      case ExecutionModes.LIGHTWEIGHT_PLAN: return 1;
      case ExecutionModes.MODUS_MAXIMUS: return 4;
      default: return 0;
    }
  }

  // =======================================================================
  // Internal: Self-correction — runs SelfCorrectionCycle on the
  //            failed PipelineResult and handles escalation.
  // =======================================================================

  private async runSelfCorrection(dispatchResult: WaveDispatchResult): Promise<boolean> {
    this.emitEvent({ type: "correction.correcting", timestamp: iso() });

    // Collect changed files from the dispatch result
    const changedFiles = new Set<string>();
    if (dispatchResult.waveResults) {
      for (const wr of dispatchResult.waveResults) {
        for (const [, taskResult] of wr.taskResults) {
          if (taskResult.changedFiles && taskResult.changedFiles.length > 0) {
            for (const f of taskResult.changedFiles) {
              if (typeof f === "string") changedFiles.add(f);
            }
          }
        }
      }
    }

    // If there's no pipeline result to correct against, fall back to stub behavior
    if (!this.lastPipelineResult) {
      const stateCounts = this.poolManager.getStateCounts();
      const totalFailed = stateCounts.failed + stateCounts.timeout;
      this.emitEvent({ type: "correction.result", timestamp: iso(), data: { corrected: false, remaining: totalFailed, reason: "no pipeline result" } });
      return false;
    }

    // Build the SelfCorrectionCycle with Step 31 enhancements:
    // subagentHost for real sub-agent correction, codebaseGraph for type
    // resolution, wirePath for correction.attempt logging, and auto-fix.
    const modeLevel = this.modeToLevel(this.currentMode);
    const wirePath = this._sessionId
      ? resolve(this._workspaceRoot, ".Q", "sessions", this._sessionId, "wire.jsonl")
      : undefined;
    const correctionCycle = new SelfCorrectionCycle(
      {
        workspaceRoot: this._workspaceRoot,
        modeLevel,
        autoEscalate: true,
        enableAutoFix: true,
        wirePath,
      },
      this.verificationPipeline,
      {
        subagentHost: this.rootAgent?.subagentHost as
          | { spawn: (profile: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ id: string; result: string }> }
          | undefined,
        codebaseGraph: this._topology as any,
      },
    );

    // Forward progress events to the orchestrator event system
    correctionCycle.onProgress((event) => {
      this.emitEvent({
        type: "correction.progress",
        timestamp: event.timestamp,
        data: {
          phase: event.phase,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          message: event.message,
          gateName: event.gateName,
          diagnosticCount: event.diagnosticCount,
        },
      });
    });

    // Gate context for re-verification
    const gateContext = {
      workspaceRoot: this._workspaceRoot,
      reporter: this.verificationPipeline.getReporter(),
      signal: this.getAbortSignal(),
    };

    // Run the correction cycle
    const correctionResult = await correctionCycle.run(
      this.lastPipelineResult,
      changedFiles,
      gateContext,
    );

    // Handle escalation if correction failed
    if (!correctionResult.success && correctionResult.escalation) {
      this.emitEvent({
        type: "correction.escalation",
        timestamp: iso(),
        data: {
          summary: correctionResult.escalation.summary,
          failedGates: correctionResult.escalation.failedGates,
          attemptCount: correctionResult.attempts.length,
          options: correctionResult.escalation.options,
        },
      });
    }

    // Update the last pipeline result with the final re-verify result
    if (correctionResult.finalPipelineResult) {
      this.lastPipelineResult = correctionResult.finalPipelineResult;
    }

    this.emitEvent({
      type: "correction.result",
      timestamp: iso(),
      data: {
        corrected: correctionResult.success,
        attempts: correctionResult.attempts.length,
        changedFiles: correctionResult.changedFiles.length,
        escalated: !!correctionResult.escalation,
      },
    });

    return correctionResult.success;
  }

  /**
   * Escalate an architecture or complex correction to the orchestrator.
   * Schedules boundary research tasks through the pool manager and
   * re-dispatches with explicit architectural constraints.
   */
  async escalate(
    escalation: {
      summary: string;
      failedGates: string[];
      diagnostics: string[];
      affectedModules: string[];
    },
  ): Promise<boolean> {
    this.emitEvent({
      type: "correction.escalation.redecompose",
      timestamp: iso(),
      data: {
        summary: escalation.summary,
        failedGates: escalation.failedGates,
        affectedModules: escalation.affectedModules,
      },
    });

    if (!this.activeGraph) {
      this.emitEvent({
        type: "correction.escalation.failed",
        timestamp: iso(),
        data: { reason: "No active task graph to re-decompose" },
      });
      return false;
    }

    try {
      const researchTaskId = crypto.randomUUID();
      const researchPrompt = `Research the module boundaries for: ${escalation.affectedModules.join(", ")}.
Architecture violations found:
${escalation.diagnostics.join("\n")}

Goal: Understand the correct module boundaries and produce a constraints document
for implementation agents. Identify which modules should depend on which others,
note circular dependencies, and suggest boundary rules.`;

      // Schedule research task through pool manager
      const researchSubTask = {
        id: researchTaskId,
        parentTaskId: this.activeTask?.id ?? "escalation",
        description: researchPrompt,
        assignedAgent: "architect",
        phase: "research" as const,
        dependencies: [],
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      };

      this.poolManager.schedule(researchSubTask);

      // Wait for it
      const startTime = Date.now();
      let researchDone = false;
      while (Date.now() - startTime < 120_000) {
        const stateCounts = this.poolManager.getStateCounts();
        if (stateCounts.completed > 0) {
          researchDone = true;
          break;
        }
        if (stateCounts.failed > 0 || stateCounts.timeout > 0) {
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      this.emitEvent({
        type: "correction.escalation.complete",
        timestamp: iso(),
        data: { researchTaskId, success: researchDone },
      });

      return researchDone;
    } catch (err) {
      this.emitEvent({
        type: "correction.escalation.error",
        timestamp: iso(),
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  }

  // =======================================================================
  // Internal: Metrics & reclassification
  // =======================================================================

  private buildMetrics(): ExecutionMetrics {
    const stateCounts = this.poolManager.getStateCounts();
    return {
      usage: {
        totalTokens: this.totalTokensUsed,
        inputTokens: Math.floor(this.totalTokensUsed / 2),
        outputTokens: Math.floor(this.totalTokensUsed / 2),
      },
      toolCalls: {
        total: this.totalToolCalls,
        failed: this.totalFailedToolCalls,
      },
      turnCount: this.turnCount,
      userAddedContext: false,
      currentMode: this.currentMode ?? ExecutionModes.LIGHTWEIGHT_PLAN,
    };
  }

  // =======================================================================
  // Internal: Result building
  // =======================================================================

  private buildFinalResult(
    dispatchResult: WaveDispatchResult,
    validationPassed: boolean,
    durationMs: number,
  ): ExecutionResult {
    const allErrors: string[] = [...dispatchResult.errors];

    return {
      success: dispatchResult.success && validationPassed,
      mode: this.currentMode ?? ExecutionModes.LIGHTWEIGHT_PLAN,
      taskId: this.activeTask?.id ?? "unknown",
      output: `Orchestration completed in ${(durationMs / 1000).toFixed(1)}s. ${dispatchResult.waveResults.length} waves executed.${validationPassed ? " All validations passed." : " Validation failed."}`,
      error: allErrors.length > 0 ? allErrors.join("; ") : undefined,
      totalTokens: this.totalTokensUsed,
      durationMs,
      verificationPassed: validationPassed,
      errors: allErrors.length > 0 ? allErrors : undefined,
      completedAt: iso(),
      subResults: dispatchResult.waveResults.map((wr) => ({
        success: wr.success,
        mode: this.currentMode ?? ExecutionModes.LIGHTWEIGHT_PLAN,
        taskId: `wave-${wr.waveIndex}`,
        output: `Wave ${wr.waveIndex}: ${wr.errors.length} error(s)`,
        durationMs: wr.durationMs,
        errors: wr.errors.length > 0 ? wr.errors : undefined,
        completedAt: iso(),
      })),
    };
  }

  // =======================================================================
  // Internal: Event emission with Invisibility Principle
  // =======================================================================

  private emitEvent(event: OrchestratorEvent): void {
    const mode = this.currentMode;

    // Invisibility Principle:
    // AUTO/DIRECT/LIGHTWEIGHT_PLAN: no pool or convergence events
    if (mode === ExecutionModes.AUTO || mode === ExecutionModes.DIRECT || mode === ExecutionModes.LIGHTWEIGHT_PLAN) {
      if (event.type.startsWith("convergence") || event.type.startsWith("pool")) return;
      if (event.type === "state.dispatching" || event.type === "state.converging" || event.type === "state.validating") return;
    }

    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  /**
   * Record a tool call for metrics tracking (called by mode handlers).
   */
  recordToolCall(success: boolean, tokenDelta?: number): void {
    this.totalToolCalls++;
    if (!success) this.totalFailedToolCalls++;
    if (tokenDelta) this.totalTokensUsed += tokenDelta;
  }

  /**
   * Forward an event emitted by the root Agent (via its RPC channel) to all
   * TUI subscribers. Used to bridge agent-side events (turn.started,
   * turn.ended, agent.status.updated, streaming deltas, etc.) to the TUI
   * transcript and live pane.
   *
   * Bypasses the visibility filter in the private emitEvent because
   * agent-emitted events are outside the orchestrator's mode-based
   * filtering scheme — they should always reach the TUI.
   */
  recordAgentEvent(event: unknown): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event as OrchestratorEvent);
      } catch {
        // Listeners must not break the agent loop.
      }
    }
  }

  /**
   * Record a completed turn (called by mode handlers).
   */
  recordTurn(): void {
    this.turnCount++;
  }

  /** Get the current wave index. */
  setCurrentWave(wave: number): void {
    this.currentWave = wave;
  }
}

function iso(): string {
  return new Date().toISOString();
}