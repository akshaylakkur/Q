/**
 * SubAgentPoolManager — Manages lifecycle, scheduling, and health
 * monitoring of all sub-agents.
 *
 * Integrates with MemorySliceBuilder to build and apply scoped memory
 * slices before spawning each sub-agent, limiting its context to the
 * assigned module.
 */

import { MinPriorityQueue } from "@datastructures-js/priority-queue";
import type { SubTask } from "./modes/types.js";
import { SessionSubagentHost } from "@q/agent-core";
import type { Agent } from "@q/agent-core";
import type { WorkspaceTopology } from "./topology.js";
import type { MemoryCoordinator } from "../memory/coordinator.js";
import { MemorySliceBuilder, buildDecisionsContext, buildBoundaryConstraints } from "./memory_slice.js";
import type { MemorySlice } from "./memory_slice.js";

// =========================================================================
// Types
// =========================================================================

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface SubAgentHandle {
  id: string;
  profile: string;
  state: SubAgentState;
  moduleTarget: string;
  priority: number;
  heartbeat: number;
  errorCount: number;
  tokenUsage: TokenUsage;
  task?: SubTask;
  controller?: AbortController;
  startedAt?: number;
}

export type SubAgentState = "created" | "ready" | "running" | "completed" | "failed" | "timeout";
export type PriorityBucket = 0 | 1 | 2 | 3;

/** Value type stored in the priority queue — priority extracted by the queue. */
interface QueuedTask {
  subTask: SubTask;
  bucket: PriorityBucket;
  moduleTarget: string;
  errorCount: number;
  enqueuedAt: number;
  /** Numeric priority (lower = higher pri). Used as the queue sort key. */
  priority: number;
}

export interface PoolConfig {
  globalConcurrency: number;
  profileLimits: Record<string, number>;
  moduleConcurrency: number;
  heartbeatInterval: number;
  heartbeatTimeoutMs: number;
  bucketCapacities: Record<PriorityBucket, number>;
}

const DEFAULT_POOL_CONFIG: PoolConfig = {
  globalConcurrency: 8,
  profileLimits: { rewritius: 3, searchius: 4, auto: 6 },
  moduleConcurrency: 2,
  heartbeatInterval: 5,
  heartbeatTimeoutMs: 60_000,
  bucketCapacities: { 0: 1, 1: 4, 2: 3, 3: 6 },
};

// =========================================================================
// SubAgentPoolManager
// =========================================================================

export class SubAgentPoolManager {
  private config: PoolConfig;
  private agents: Map<string, SubAgentHandle> = new Map();
  private bucketQueues: Record<PriorityBucket, MinPriorityQueue<QueuedTask>>;
  private runningCount = 0;
  private profileRunningCounts: Map<string, number> = new Map();
  private moduleRunningCounts: Map<string, number> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private completionListeners: Array<(handle: SubAgentHandle) => void> = [];
  private heartbeatListeners: Array<(handle: SubAgentHandle) => void> = [];
  private rootAgent?: Agent;
  private subagentHost?: SessionSubagentHost;

  // Memory slicing dependencies
  private topology?: WorkspaceTopology;
  private memoryCoordinator?: MemoryCoordinator;
  private memorySliceBuilder = new MemorySliceBuilder();

  constructor(config?: Partial<PoolConfig>) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };

    // Each bucket queue extracts priority from the QueuedTask
    const makeQueue = () => new MinPriorityQueue<QueuedTask>(
      (t) => t.priority,
    );

    this.bucketQueues = {
      0: makeQueue(),
      1: makeQueue(),
      2: makeQueue(),
      3: makeQueue(),
    };
  }

  /** Set the root agent for sub-agent spawning. Must be called before scheduling. */
  setRootAgent(agent: Agent): void {
    this.rootAgent = agent;
    this.subagentHost = new SessionSubagentHost(agent);
  }

  /** Start the health-monitoring heartbeat loop. */
  start(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.checkHealth(), 10_000);
  }

  /** Stop the monitors and abort all running agents. */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.subagentHost?.cancelAll();
    for (const [, handle] of this.agents) {
      if (handle.state === "running" && handle.controller) {
        handle.controller.abort();
      }
      handle.state = "failed";
    }
    this.agents.clear();
    for (const b of [0, 1, 2, 3] as PriorityBucket[]) this.bucketQueues[b].clear();
    this.runningCount = 0;
    this.profileRunningCounts.clear();
    this.moduleRunningCounts.clear();
  }

  // -----------------------------------------------------------------------
  // Scheduling
  // -----------------------------------------------------------------------

  /**
   * Schedule a sub-task for execution.
   * @returns The SubAgentHandle if dispatched immediately, or null if queued.
   */
  schedule(subTask: SubTask): SubAgentHandle | null {
    const bucket = this.classifyBucket(subTask);
    const moduleTarget = this.resolveModuleTarget(subTask);
    const priority = this.computePriority(subTask, bucket);
    const handle: SubAgentHandle = {
      id: subTask.id,
      profile: subTask.assignedAgent ?? "searchius",
      state: "created",
      moduleTarget,
      priority,
      heartbeat: Date.now(),
      errorCount: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      task: subTask,
    };

    this.agents.set(subTask.id, handle);

    if (this.canDispatch(handle)) {
      this.dispatch(handle);
      return handle;
    }

    this.bucketQueues[bucket].enqueue({
      subTask, bucket, moduleTarget,
      errorCount: 0,
      enqueuedAt: Date.now(),
      priority,
    });
    handle.state = "ready";
    return null;
  }

  /**
   * Called when a sub-task completes.
   * Dequeues conflicting waits and dispatches any that no longer conflict.
   */
  onTaskComplete(completedTaskId: string): void {
    const handle = this.agents.get(completedTaskId);
    if (!handle) return;
    this.runningCount--;
    this.decrementProfileCount(handle.profile);
    this.decrementModuleCount(handle.moduleTarget);
    for (const listener of this.completionListeners) listener(handle);
    this.dequeueReadyTasks();
  }

  /** Check if a task's dependencies are all met. */
  dependenciesMet(subTask: SubTask): boolean {
    if (!subTask.dependencies || subTask.dependencies.length === 0) return true;
    return subTask.dependencies.every((depId) => {
      const dep = this.agents.get(depId);
      return dep?.state === "completed" || dep?.state === "failed";
    });
  }

  /** Set the codebase graph index for conflict detection. */
  setCodebaseGraphIndex(index: unknown): void {
    this._codebaseGraphIndex = index;
  }
  private _codebaseGraphIndex: unknown = null;

  // -----------------------------------------------------------------------
  // Memory Slice Integration
  // -----------------------------------------------------------------------

  /**
   * Set the workspace topology reference for memory slicing.
   */
  setTopology(topology: WorkspaceTopology): void {
    this.topology = topology;
  }

  /**
   * Set the memory coordinator reference for memory slicing.
   */
  setMemoryCoordinator(coordinator: MemoryCoordinator): void {
    this.memoryCoordinator = coordinator;
  }

  /**
   * Build a MemorySlice for a sub-agent about to be dispatched.
   * Returns the slice if topology and coordinator are available, or null otherwise.
   */
  buildMemorySlice(agentProfile: string, task: SubTask): MemorySlice | null {
    if (!this.topology || !this.memoryCoordinator) return null;

    // Convert SubTask to a minimal TaskGraphNode for MemorySliceBuilder
    const taskNode = {
      id: task.id,
      profile: task.assignedAgent ?? "searchius",
      prompt: task.description || "",
      dependsOn: task.dependencies ?? [],
      priority: 50,
      estimatedComplexity: 1,
      wave: 0,
      timeout: 300_000,
      verificationRequired: false,
      outputSpec: {},
    };

    return this.memorySliceBuilder.build(
      agentProfile,
      taskNode,
      this.topology,
      this.memoryCoordinator,
    );
  }

  // -----------------------------------------------------------------------
  // Dispatch
  // -----------------------------------------------------------------------

  private dispatch(handle: SubAgentHandle): void {
    handle.state = "running";
    handle.startedAt = Date.now();
    handle.controller = new AbortController();
    this.runningCount++;
    this.incrementProfileCount(handle.profile);
    this.incrementModuleCount(handle.moduleTarget);
    this.spawnAgent(handle);
  }

  private async spawnAgent(handle: SubAgentHandle): Promise<void> {
    const task = handle.task;
    if (!task) return;

    // Fallback: simulate execution when no root agent is wired
    // (used by tests that create standalone SubAgentPoolManager)
    if (!this.subagentHost) {
      try {
        const heartbeatTimer = setInterval(() => this.recordHeartbeat(handle.id), 5_000);

        await new Promise<void>((resolve) => {
          const checkDone = setInterval(() => {
            if (handle.controller?.signal.aborted) {
              clearInterval(heartbeatTimer);
              clearInterval(checkDone);
              handle.state = "timeout";
              handle.errorCount++;
              this.onTaskComplete(handle.id);
              resolve();
            }
          }, 500);

          setTimeout(() => {
            clearInterval(heartbeatTimer);
            clearInterval(checkDone);
            handle.state = "completed";
            handle.tokenUsage = { promptTokens: 100, completionTokens: 50 };
            this.onTaskComplete(handle.id);
            resolve();
          }, 100);
        });
      } catch {
        handle.state = "failed";
        handle.errorCount++;
        this.onTaskComplete(handle.id);
      }
      return;
    }

    // Real sub-agent spawning via SessionSubagentHost
    const profileName = task.assignedAgent ?? "searchius";
    let prompt = task.description || task.phase || "Execute the assigned task";

    // Build and apply memory slice before spawning
    const memorySlice = this.buildMemorySlice(profileName, task);
    if (memorySlice) {
      // Include all slice data (working memory + decisions + constraints)
      // as scoped context for the agent before its first turn.
      const parts: string[] = [memorySlice.workingMemory];

      if (memorySlice.decisions.length > 0) {
        parts.push(buildDecisionsContext(memorySlice.decisions));
        const constraints = buildBoundaryConstraints(memorySlice);
        if (constraints) parts.push(constraints);
      }

      prompt = `${parts.join("\n\n---\n\n")}\n\n---\n\n${prompt}`;
    }

    try {
      const heartbeatTimer = setInterval(() => this.recordHeartbeat(handle.id), 5_000);

      const result = await this.subagentHost.spawn(
        profileName,
        prompt,
        { signal: handle.controller?.signal },
      );

      clearInterval(heartbeatTimer);

      handle.state = "completed";
      handle.tokenUsage = {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      };
      this.onTaskComplete(handle.id);
    } catch (err) {
      handle.state = "failed";
      handle.errorCount++;
      this.onTaskComplete(handle.id);
    }
  }

  // -----------------------------------------------------------------------
  // Bucket classification
  // -----------------------------------------------------------------------

  private classifyBucket(subTask: SubTask): PriorityBucket {
    const phase = subTask.phase;
    const profile = subTask.assignedAgent ?? "";
    if (phase === "dependency_resolution" || profile === "rewritius") return 0;
    if (phase === "scaffolding" || phase === "research" || phase === "explore" || profile === "searchius") return 1;
    if (phase === "test_generation" || phase === "documentation" || profile === "editius") return 3;
    return 2;
  }

  // -----------------------------------------------------------------------
  // Conflict detection
  // -----------------------------------------------------------------------

  private canDispatch(handle: SubAgentHandle): boolean {
    if (this.runningCount >= this.config.globalConcurrency) return false;

    const profileLimit = this.config.profileLimits[handle.profile];
    if (profileLimit !== undefined) {
      if ((this.profileRunningCounts.get(handle.profile) ?? 0) >= profileLimit) return false;
    }

    const _bucket = handle.task ? this.classifyBucket(handle.task) : 2;
    if ((_bucket === 0 || _bucket === 2) && (this.moduleRunningCounts.get(handle.moduleTarget) ?? 0) >= this.config.moduleConcurrency) return false;

    if (this.hasModuleConflict(handle)) return false;

    if (handle.task && !this.dependenciesMet(handle.task)) return false;

    return true;
  }

  /** Bucket 2 tasks writing to the same module cannot run concurrently. */
  private hasModuleConflict(handle: SubAgentHandle): boolean {
    const bucket = handle.task ? this.classifyBucket(handle.task) : 2;
    if (bucket === 0 || bucket === 1 || bucket === 3) return false;
    for (const [, other] of this.agents) {
      if (other.state !== "running") continue;
      if (other.id === handle.id) continue;
      if (other.moduleTarget === handle.moduleTarget) return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Priority & fairness
  // -----------------------------------------------------------------------

  private computePriority(subTask: SubTask, bucket: PriorityBucket): number {
    return bucket * 100 + (subTask.dependencies?.length ?? 0) * 5;
  }

  private resolveModuleTarget(subTask: SubTask): string {
    const desc = subTask.description.toLowerCase();
    const keywords = ["module", "service", "component", "plugin", "package", "api", "lib"];
    for (const kw of keywords) {
      if (desc.includes(kw)) return kw;
    }
    return subTask.phase ?? "general";
  }

  /**
   * Dequeue tasks that are now ready to run.
   * Processes buckets in priority order (0 → 1 → 2 → 3).
   */
  private dequeueReadyTasks(): void {
    for (const bucket of [0, 1, 2, 3] as PriorityBucket[]) {
      const queue = this.bucketQueues[bucket];
      if (queue.isEmpty()) continue;

      const candidates: QueuedTask[] = [];
      while (!queue.isEmpty()) {
        const entry = queue.dequeue();
        if (!entry) break;
        const handle = this.agents.get(entry.subTask.id);
        if (!handle) continue;

        if (!this.dependenciesMet(entry.subTask)) {
          queue.enqueue(entry);
          continue;
        }

        if (this.canDispatch(handle)) {
          candidates.push(entry);
        } else {
          queue.enqueue(entry);
          break;
        }
      }

      for (const candidate of candidates) {
        const handle = this.agents.get(candidate.subTask.id);
        if (handle) this.dispatch(handle);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Heartbeat & health monitoring
  // -----------------------------------------------------------------------

  /** Record a heartbeat for a sub-agent. Called by the agent loop. */
  recordHeartbeat(agentId: string): void {
    const handle = this.agents.get(agentId);
    if (!handle) return;
    handle.heartbeat = Date.now();
    for (const listener of this.heartbeatListeners) listener(handle);
  }

  /** Periodic health check — marks stale agents as timed out. */
  private checkHealth(): void {
    const now = Date.now();
    for (const [id, handle] of this.agents) {
      if (handle.state !== "running") continue;
      if (now - handle.heartbeat <= this.config.heartbeatTimeoutMs) continue;

      if (handle.controller) handle.controller.abort();
      handle.state = "timeout";
      handle.errorCount++;
      this.runningCount--;
      this.decrementProfileCount(handle.profile);
      this.decrementModuleCount(handle.moduleTarget);

      if (handle.task && handle.errorCount < 3) {
        const bucket = handle.task.phase ? this.classifyBucket(handle.task) : 2;
        this.bucketQueues[bucket].enqueue({
          subTask: handle.task,
          bucket,
          moduleTarget: handle.moduleTarget,
          errorCount: handle.errorCount,
          enqueuedAt: Date.now(),
          priority: this.computePriority(handle.task, bucket),
        });
      }

      for (const listener of this.completionListeners) listener(handle);
    }
  }

  // -----------------------------------------------------------------------
  // Event listeners
  // -----------------------------------------------------------------------

  onCompletion(listener: (handle: SubAgentHandle) => void): void {
    this.completionListeners.push(listener);
  }
  /** Remove a completion listener. */
  offCompletion(listener: (handle: SubAgentHandle) => void): void {
    const idx = this.completionListeners.indexOf(listener);
    if (idx >= 0) this.completionListeners.splice(idx, 1);
  }

  onHeartbeat(listener: (handle: SubAgentHandle) => void): void {
    this.heartbeatListeners.push(listener);
  }
  /** Remove a heartbeat listener. */
  offHeartbeat(listener: (handle: SubAgentHandle) => void): void {
    const idx = this.heartbeatListeners.indexOf(listener);
    if (idx >= 0) this.heartbeatListeners.splice(idx, 1);
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  getAgent(agentId: string): SubAgentHandle | undefined {
    return this.agents.get(agentId);
  }
  getAllAgents(): SubAgentHandle[] {
    return Array.from(this.agents.values());
  }
  getAgentsByState(state: SubAgentState): SubAgentHandle[] {
    return this.getAllAgents().filter((h) => h.state === state);
  }
  getRunningCount(): number {
    return this.runningCount;
  }
  getQueueSize(): number {
    let size = 0;
    for (const b of [0, 1, 2, 3] as PriorityBucket[]) size += this.bucketQueues[b].size();
    return size;
  }
  getStateCounts(): Record<SubAgentState, number> {
    const counts: Record<SubAgentState, number> = { created: 0, ready: 0, running: 0, completed: 0, failed: 0, timeout: 0 };
    for (const handle of this.agents.values()) counts[handle.state]++;
    return counts;
  }
  getConfig(): PoolConfig { return { ...this.config }; }
  updateConfig(partial: Partial<PoolConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private incrementProfileCount(profile: string): void {
    this.profileRunningCounts.set(profile, (this.profileRunningCounts.get(profile) ?? 0) + 1);
  }
  private decrementProfileCount(profile: string): void {
    const c = this.profileRunningCounts.get(profile) ?? 0;
    if (c <= 1) this.profileRunningCounts.delete(profile);
    else this.profileRunningCounts.set(profile, c - 1);
  }
  private incrementModuleCount(module: string): void {
    this.moduleRunningCounts.set(module, (this.moduleRunningCounts.get(module) ?? 0) + 1);
  }
  private decrementModuleCount(module: string): void {
    const c = this.moduleRunningCounts.get(module) ?? 0;
    if (c <= 1) this.moduleRunningCounts.delete(module);
    else this.moduleRunningCounts.set(module, c - 1);
  }
}