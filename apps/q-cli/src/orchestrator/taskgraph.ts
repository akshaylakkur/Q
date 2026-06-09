/**
 * TaskDecomposer & TaskGraph — DAG construction and wave dispatch.
 *
 * Receives an IntentProfile and produces a TaskGraph with ordered
 * waves of tasks, then dispatches them through the PoolManager.
 */

import { SubAgentPoolManager } from "./pool.js";
import type { SubTask } from "./modes/types.js";
import type { ExecutionResult } from "./modes/types.js";
import type { IntentProfile, IntentScope, IntentDepth } from "./intent.js";

// =========================================================================
// Types
// =========================================================================

export type WavePhase = "research" | "scaffold" | "implement" | "test" | "polish" | "validate";

export type TaskCategory =
  | "per-file"
  | "per-module"
  | "cross-cutting"
  | "infrastructure";

export interface OutputSpec {
  filesToCreate?: string[];
  filesToModify?: string[];
  format?: string;
  constraints?: string[];
}

export interface WaveGateDeclaration {
  type: "lint" | "typecheck" | "test" | "security" | "architecture";
  severity: "required" | "recommended" | "optional";
}

export interface TaskGraphNode {
  id: string;
  profile: string;
  prompt: string;
  dependsOn: string[];
  priority: number;
  estimatedComplexity: number;
  wave: number;
  timeout: number;
  verificationRequired: boolean;
  outputSpec: OutputSpec;
  category?: TaskCategory;
  phase?: string;
}

export interface Wave {
  index: number;
  phase: WavePhase;
  taskIds: string[];
  convergeAfter: boolean;
  gates: WaveGateDeclaration[];
}

export interface TaskGraph {
  nodes: TaskGraphNode[];
  waves: Wave[];
  intentProfile: IntentProfile;
  estimatedTotalTasks: number;
  estimatedTotalWaves: number;
}

export interface WaveResult {
  waveIndex: number;
  taskResults: Map<string, ExecutionResult>;
  success: boolean;
  errors: string[];
  durationMs: number;
}

export interface WaveDispatchResult {
  graph: TaskGraph;
  waveResults: WaveResult[];
  success: boolean;
  errors: string[];
  totalDurationMs: number;
}

export interface WorkspaceTopologyInfo {
  modules: string[];
  files: string[];
  dependencies: Array<{ from: string; to: string }>;
}

// =========================================================================
// Default Wave Configuration
// =========================================================================

const DEFAULT_WAVES: Wave[] = [
  { index: 0, phase: "research", taskIds: [], convergeAfter: false, gates: [] },
  { index: 1, phase: "scaffold", taskIds: [], convergeAfter: true, gates: [] },
  { index: 2, phase: "implement", taskIds: [], convergeAfter: false, gates: [] },
  { index: 3, phase: "test", taskIds: [], convergeAfter: false, gates: [{ type: "test", severity: "required" }] },
  { index: 4, phase: "polish", taskIds: [], convergeAfter: false, gates: [{ type: "lint", severity: "recommended" }] },
  { index: 5, phase: "validate", taskIds: [], convergeAfter: true, gates: [{ type: "test", severity: "required" }, { type: "typecheck", severity: "required" }, { type: "security", severity: "recommended" }, { type: "architecture", severity: "recommended" }] },
];

const CATEGORY_PROFILE_MAP: Record<string, string> = {
  "per-file": "rewriter",
  "per-module": "rewriter",
  "cross-cutting": "architect",
  infrastructure: "deps-resolver",
};

const PHASE_PROFILE_MAP: Record<string, string> = {
  research: "explore",
  scaffold: "rewriter",
  implement: "rewriter",
  test: "test-gen",
  polish: "reviewer",
  validate: "validator",
};

// =========================================================================
// TaskDecomposer
// =========================================================================

export class TaskDecomposer {
  private pool: SubAgentPoolManager;

  constructor(pool: SubAgentPoolManager) {
    this.pool = pool;
  }

  /**
   * Decompose an IntentProfile into a TaskGraph.
   */
  decompose(profile: IntentProfile, topology?: WorkspaceTopologyInfo): TaskGraph {
    const scope = profile.scope;
    const depth = profile.depth;
    const modules = topology?.modules ?? this.inferModules(profile);
    const files = topology?.files ?? [];

    // Step 1: Generate task candidates
    const candidates = this.generateCandidates(scope, depth, modules, files, profile);

    // Step 2: Order by dependency
    const ordered = this.orderByDependency(candidates);

    // Step 3: Group by parallelism and assign waves
    const { nodes, waves } = this.assignWaves(ordered);

    // Step 4: Assign agent profiles (preserve wave-0/explore profiles)
    this.assignProfiles(nodes);

    // Step 5: Build the graph
    return {
      nodes,
      waves,
      intentProfile: profile,
      estimatedTotalTasks: nodes.length,
      estimatedTotalWaves: waves.length,
    };
  }

  /**
   * Dispatch the waves of a TaskGraph through the PoolManager.
   */
  async dispatchWaves(
    graph: TaskGraph,
    convergeCallback?: () => Promise<void>,
  ): Promise<WaveDispatchResult> {
    const startedAt = Date.now();
    const waveResults: WaveResult[] = [];
    const errors: string[] = [];

    for (const wave of graph.waves) {
      if (wave.taskIds.length === 0) continue;

      const result = await this.executeWave(wave, graph);
      waveResults.push(result);

      if (!result.success) {
        errors.push(...result.errors);
      }

      if (wave.convergeAfter && convergeCallback) {
        try {
          await convergeCallback();
        } catch (err) {
          errors.push(`Convergence after wave ${wave.index} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return {
      graph,
      waveResults,
      success: errors.length === 0,
      errors,
      totalDurationMs: Date.now() - startedAt,
    };
  }

  // -----------------------------------------------------------------------
  // Step 1: Generate Task Candidates
  // -----------------------------------------------------------------------

  private generateCandidates(
    scope: IntentScope,
    depth: IntentDepth,
    modules: string[],
    files: string[],
    profile: IntentProfile,
  ): TaskGraphNode[] {
    const candidates: TaskGraphNode[] = [];
    let nextId = 1;
    const id = () => `task-${nextId++}`;

    // Research wave 0 — always present
    candidates.push(this.makeNode(id(), {
      profile: "explore", prompt: "Explore and analyze the codebase", wave: 0, dependsOn: [],
      priority: 0, estimatedComplexity: 1, timeout: 60_000, verificationRequired: false, category: "per-file",
    }));

    // Wave 1 — scaffold + dependency resolution
    if (scope !== "single_file") {
      const scaffoldDep = `task-${nextId - 1}`;
      for (const mod of modules) {
        candidates.push(this.makeNode(id(), {
          profile: "rewriter", prompt: `Scaffold ${mod} module`, wave: 1,
          dependsOn: [scaffoldDep], priority: 10, estimatedComplexity: 2, timeout: 120_000,
          verificationRequired: false, category: "per-module", phase: "scaffold",
        }));
      }
    }

    // Infrastructure — wave 1
    candidates.push(this.makeNode(id(), {
      profile: "deps-resolver", prompt: "Resolve dependencies", wave: 1, dependsOn: [],
      priority: 5, estimatedComplexity: 1, timeout: 60_000, verificationRequired: false,
      category: "infrastructure", phase: "scaffold",
    }));

    // Wave 2 — implementation
    const fileCount = this.fileCountForScope(scope, files);
    for (let i = 0; i < fileCount; i++) {
      const fn = files[i] ?? `${modules[0] ?? "main"}/file-${i + 1}`;
      candidates.push(this.makeNode(id(), {
        profile: "rewriter", prompt: `Implement changes in ${fn}`, wave: 2, dependsOn: [],
        priority: 20, estimatedComplexity: depth === "deep" ? 3 : 1, timeout: 180_000,
        verificationRequired: depth === "deep" || depth === "campaign",
        category: "per-file", phase: "implement",
      }));
    }

    // Cross-cutting — wave 2
    if (scope === "cross_cutting" || scope === "codebase_gen") {
      candidates.push(this.makeNode(id(), {
        profile: "architect", prompt: "Ensure cross-cutting consistency", wave: 2,
        dependsOn: [], priority: 15, estimatedComplexity: 3, timeout: 120_000,
        verificationRequired: true, category: "cross-cutting", phase: "implement",
      }));
    }

    // Wave 3 — test + doc
    if (profile.requiresVerification || depth !== "surface") {
      for (const mod of modules) {
        candidates.push(this.makeNode(id(), {
          profile: "test-gen", prompt: `Generate tests for ${mod}`, wave: 3, dependsOn: [],
          priority: 30, estimatedComplexity: 2, timeout: 120_000, verificationRequired: true,
          category: "per-module", phase: "test",
        }));
      }
    }
    for (const mod of modules) {
      candidates.push(this.makeNode(id(), {
        profile: "doc-gen", prompt: `Document ${mod}`, wave: 3, dependsOn: [],
        priority: 35, estimatedComplexity: 1, timeout: 60_000, verificationRequired: false,
        category: "per-module", phase: "test",
      }));
    }

    // Wave 5 — validation
    if (profile.requiresVerification || depth !== "surface") {
      candidates.push(this.makeNode(id(), {
        profile: "validator", prompt: "Run full validation", wave: 5, dependsOn: [],
        priority: 60, estimatedComplexity: 2, timeout: 300_000, verificationRequired: true,
        category: "cross-cutting", phase: "validate",
      }));
    }
    if (depth === "deep" || depth === "campaign") {
      candidates.push(this.makeNode(id(), {
        profile: "security-auditor", prompt: "Security review", wave: 5, dependsOn: [],
        priority: 50, estimatedComplexity: 3, timeout: 120_000, verificationRequired: true,
        category: "cross-cutting", phase: "validate",
      }));
    }

    return candidates;
  }

  // -----------------------------------------------------------------------
  // Step 2: Dependency Ordering
  // -----------------------------------------------------------------------

  private orderByDependency(candidates: TaskGraphNode[]): TaskGraphNode[] {
    const phaseOrder: Record<string, number> = {
      research: 0, scaffold: 1, implement: 2, test: 3, polish: 4, validate: 5,
    };
    return [...candidates].sort((a, b) => {
      const wa = a.phase ? (phaseOrder[a.phase] ?? a.wave) : a.wave;
      const wb = b.phase ? (phaseOrder[b.phase] ?? b.wave) : b.wave;
      if (wa !== wb) return wa - wb;
      return a.priority - b.priority;
    });
  }

  // -----------------------------------------------------------------------
  // Step 3: Wave Assignment
  // -----------------------------------------------------------------------

  private assignWaves(nodes: TaskGraphNode[]): { nodes: TaskGraphNode[]; waves: Wave[] } {
    const waves = DEFAULT_WAVES.map((w) => ({ ...w, taskIds: [] as string[] }));
    const phaseWaveMap: Record<string, number> = {
      research: 0, scaffold: 1, implement: 2, test: 3, polish: 4, validate: 5,
    };
    const updated = nodes.map((n) => {
      const wi = n.phase ? Math.max(0, Math.min(phaseWaveMap[n.phase] ?? n.wave, 5)) : n.wave;
      const w = Math.max(0, Math.min(wi, 5));
      const node = { ...n, wave: w };
      waves[w]!.taskIds.push(node.id);
      return node;
    });
    return { nodes: updated, waves };
  }

  // -----------------------------------------------------------------------
  // Step 4: Profile Assignment
  // -----------------------------------------------------------------------

  private assignProfiles(nodes: TaskGraphNode[]): void {
    for (const node of nodes) {
      // Preserve wave-0 (explore/research) and explicitly-set useful profiles
      if (node.wave === 0) { node.profile = "explore"; continue; }
      if (node.profile && node.profile !== "explore") continue;

      if (node.phase && PHASE_PROFILE_MAP[node.phase]) {
        node.profile = PHASE_PROFILE_MAP[node.phase]!;
      } else if (node.category && CATEGORY_PROFILE_MAP[node.category]) {
        node.profile = CATEGORY_PROFILE_MAP[node.category]!;
      } else {
        node.profile = "explore";
      }
    }
  }

  // -----------------------------------------------------------------------
  // Wave Execution
  // -----------------------------------------------------------------------

  private async executeWave(wave: Wave, graph: TaskGraph): Promise<WaveResult> {
    const taskResults = new Map<string, ExecutionResult>();
    const errors: string[] = [];
    const startedAt = Date.now();

    const waveTasks = graph.nodes.filter((n) => wave.taskIds.includes(n.id));
    const subTasks = this.waveTasksToSubTasks(waveTasks, graph);
    const dispatchPromises: Promise<ExecutionResult>[] = [];

    for (const st of subTasks) {
      this.pool.schedule(st as SubTask);
      dispatchPromises.push(this.waitForTask(st.id));
    }

    const settled = await Promise.allSettled(dispatchPromises);

    for (let i = 0; i < settled.length; i++) {
      const st = subTasks[i];
      if (!st) continue;
      const sr = settled[i]!;

      if (sr.status === "fulfilled") {
        taskResults.set(st.id, sr.value);
        if (!sr.value.success && sr.value.error) {
          errors.push(`Task ${st.id}: ${sr.value.error}`);
        }
      } else {
        const reason = sr.reason instanceof Error ? sr.reason.message : String(sr.reason);
        errors.push(`Task ${st.id}: ${reason}`);
        taskResults.set(st.id, { success: false, mode: "LIGHTWEIGHT_PLAN" as any, taskId: st.id, error: reason, completedAt: new Date().toISOString() });
      }
    }

    return {
      waveIndex: wave.index,
      taskResults,
      success: errors.length === 0,
      errors,
      durationMs: Date.now() - startedAt,
    };
  }

  private waveTasksToSubTasks(
    nodes: TaskGraphNode[],
    graph: TaskGraph,
  ): Array<Omit<SubTask, "result">> {
    return nodes.map((node) => ({
      id: node.id,
      parentTaskId: "taskgraph-" + graph.intentProfile.scope,
      description: node.prompt,
      phase: (node.phase ?? this.inferPhaseFromNode(node)) as any,
      dependencies: node.dependsOn.length > 0 ? node.dependsOn : undefined,
      assignedAgent: node.profile,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    }));
  }

  private inferPhaseFromNode(node: TaskGraphNode): string | undefined {
    if (node.phase) return node.phase;
    const pm: Record<number, string> = {
      0: "research", 1: "scaffolding", 2: "implementation",
      3: "test_generation", 4: "verification", 5: "convergence",
    };
    return pm[node.wave];
  }

  private waitForTask(taskId: string): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const listener = (handle: { id: string; state: string; tokenUsage: { promptTokens: number; completionTokens: number }; task?: { id: string } }) => {
        if (handle.id === taskId || handle.task?.id === taskId) {
          this.pool.offCompletion(listener);
          resolve({
            success: handle.state === "completed",
            mode: "LIGHTWEIGHT_PLAN" as any,
            taskId: handle.id,
            output: `Task ${handle.id}: ${handle.state}`,
            totalTokens: handle.tokenUsage.promptTokens + handle.tokenUsage.completionTokens,
            completedAt: new Date().toISOString(),
          });
        }
      };
      this.pool.onCompletion(listener);
    });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private makeNode(id: string, fields: {
    profile: string; prompt: string; wave: number; dependsOn: string[];
    priority: number; estimatedComplexity: number; timeout: number;
    verificationRequired: boolean; category?: TaskCategory; phase?: string;
  }): TaskGraphNode {
    return { id, ...fields, outputSpec: {} };
  }

  private fileCountForScope(scope: IntentScope, _files: string[]): number {
    switch (scope) {
      case "single_file": return 1;
      case "multi_file": return 3;
      case "module": return 8;
      case "cross_cutting": return 15;
      case "codebase_gen": return 30;
    }
  }

  private inferModules(profile: IntentProfile): string[] {
    switch (profile.scope) {
      case "single_file": return ["main"];
      case "multi_file": return ["module-a", "module-b"];
      case "module": return ["core"];
      case "cross_cutting": return ["core", "api", "data"];
      case "codebase_gen": return ["core", "api", "data", "ui", "utils"];
    }
  }
}