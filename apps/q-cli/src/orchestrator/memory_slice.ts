/**
 * MemorySlice — Scoped context per sub-agent.
 *
 * Step 22: Sub-Agent Memory Slicing.
 *
 * Builds a restricted view of project memory tailored to a single sub-agent's
 * assigned module. Filters four memory tiers (episodic, LTPM, codebase graph)
 * to only what is relevant to the target module + its direct dependencies,
 * then injects the result into the sub-agent's context before its first turn.
 *
 * Depends on: WorkspaceTopology, EpisodicRecall (Step 24),
 * LTPM (Step 25), CodebaseGraphIndex (Step 26), MemoryCoordinator (Step 28).
 * Consumed by: PoolManager — when dispatching a task, builds the
 * slice before calling spawn().
 */

import type { Agent } from "@q/agent-core";
import type { WorkspaceTopology, Module } from "./topology.js";
import type { TaskGraphNode } from "./taskgraph.js";
import type { MemoryCoordinator } from "../memory/coordinator.js";
import type { Episode, ConsolidatedFact, Decision, CodebaseSubgraph } from "../memory/types.js";

export type { Episode, ConsolidatedFact, Decision, CodebaseSubgraph };

// =========================================================================
// MemorySlice
// =========================================================================

/**
 * A scoped view of project memory that a sub-agent receives.
 *
 * All fields are pre-filtered to only the sub-agent's target module
 * plus its direct dependency chain, so the agent sees no irrelevant
 * project context.
 */
export interface MemorySlice {
  /**
   * Working memory for this agent: task prompt + dependency results from
   * parent tasks in the DAG, plus a module graph subset showing only
   * files relevant to this agent's module.
   */
  workingMemory: string;

  /** Episodes touching the allocated module (filtered from EpisodicRecall). */
  episodes: Episode[];

  /** Consolidated facts with overlapping file paths or tags (from LTPM). */
  facts: ConsolidatedFact[];

  /** Decisions on the same module or affected modules (from LTPM). */
  decisions: Decision[];

  /** Subgraph consisting of module root + direct dependencies + dependents. */
  codebaseGraph: CodebaseSubgraph;
}

// =========================================================================
// MemorySliceBuilder
// =========================================================================

/**
 * Builds a MemorySlice for a given agent profile, task, and topology.
 *
 * Usage (from PoolManager dispatch path):
 * ```
 * const slice = new MemorySliceBuilder()
 *   .build(agentProfile, taskNode, topology, memoryCoordinator);
 * applySlice(agent, slice);
 * ```
 */
export class MemorySliceBuilder {
  /**
   * Build a scoped memory slice for a sub-agent.
   *
   * @param agentProfile - The profile name of the target agent (e.g. "rewritius")
   * @param task - The TaskGraphNode being dispatched
   * @param topology - The workspace topology (WorkspaceTopology instance)
   * @param memoryCoordinator - The memory coordinator (Step 28)
   * @returns A fully-filtered MemorySlice
   */
  build(
    agentProfile: string,
    task: TaskGraphNode,
    topology: WorkspaceTopology,
    memoryCoordinator: MemoryCoordinator,
  ): MemorySlice {
    // Step 1: Determine the target module from the task's outputSpec.files
    const targetModule = this.resolveTargetModule(task, topology);

    // Step 2: Query the workspace topology for the module's dependency chain
    const depChain = this.resolveDependencyChain(targetModule, topology);

    // Step 3: Build the module graph subset (working memory prefix)
    const moduleSubset = this.buildModuleSubset(targetModule, depChain, topology);

    // Step 4: Query the MemoryCoordinator for relevant episodes, facts, decisions
    const allEpisodes = memoryCoordinator.queryEpisodes(targetModule) ?? [];
    const allFacts = memoryCoordinator.queryFacts(targetModule) ?? [];
    const allDecisions = memoryCoordinator.queryDecisions(targetModule) ?? [];

    // Step 5: Filter to only the scope of the module + direct dependencies
    const scopePaths = new Set<string>([
      ...(moduleSubset.moduleFiles ?? []),
      ...(moduleSubset.dependencies ?? []),
      ...(moduleSubset.dependents ?? []),
    ]);
    const scopeModules = new Set<string>(
      depChain.map((m) => m.name),
    );

    const episodes = this.filterEpisodes(allEpisodes, scopeModules, scopePaths);
    // Build scope tags from module names for tag-based fact matching
    const scopeTags = new Set<string>(Array.from(scopeModules));
    const facts = this.filterFacts(allFacts, scopePaths, scopeTags);
    const decisions = this.filterDecisions(allDecisions, scopeModules);

    // Step 6: Gather dependency results (stub — populated from DAG in real usage)
    const depResults = this.collectDependencyResults(task);

    // Step 7: Compile working memory
    const workingMemory = this.compileWorkingMemory(
      task,
      targetModule,
      depChain,
      depResults,
      moduleSubset,
    );

    return {
      workingMemory,
      episodes,
      facts,
      decisions,
      codebaseGraph: moduleSubset,
    };
  }

  // -----------------------------------------------------------------------
  // Step 1: Resolve target module
  // -----------------------------------------------------------------------

  /**
   * Resolve the target module from a task's outputSpec or topology.
   */
  private resolveTargetModule(
    task: TaskGraphNode,
    topology: WorkspaceTopology,
  ): string {
    // Check outputSpec.filesToModify / filesToCreate first
    const files = [
      ...(task.outputSpec.filesToModify ?? []),
      ...(task.outputSpec.filesToCreate ?? []),
    ];
    if (files.length > 0) {
      // Infer module from the first file
      const moduleName = this.moduleForFile(files[0]!, topology);
      if (moduleName) return moduleName;
    }

    // Try to extract module name from the task prompt
    const modFromPrompt = this.extractModuleFromPrompt(task.prompt, topology);
    if (modFromPrompt) return modFromPrompt;

    // Last resort: return the first available module or "root"
    const knownModules = Array.from(topology.moduleGraph.keys());
    return knownModules.length > 0 ? knownModules[0]! : "root";
  }

  // -----------------------------------------------------------------------
  // Step 2: Resolve dependency chain
  // -----------------------------------------------------------------------

  /**
   * Get the module + its direct dependencies from the topology.
   */
  private resolveDependencyChain(
    moduleName: string,
    topology: WorkspaceTopology,
  ): Module[] {
    const result: Module[] = [];
    const seen = new Set<string>();

    const mod = topology.queryModule(moduleName);
    if (mod) {
      result.push(mod);
      seen.add(moduleName);
    }

    // Resolve direct dependencies: scan imports of module files
    if (mod) {
      for (const filePath of mod.files) {
        const fileNode = topology.query(filePath);
        if (!fileNode) continue;

        for (const depPath of fileNode.dependencies) {
          const depModuleName = this.moduleForFile(depPath, topology);
          if (depModuleName && !seen.has(depModuleName)) {
            seen.add(depModuleName);
            const depMod = topology.queryModule(depModuleName);
            if (depMod) {
              result.push(depMod);
            }
          }
        }
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Step 3: Build module subset (CodebaseSubgraph)
  // -----------------------------------------------------------------------

  /**
   * Build a CodebaseSubgraph for the module + its direct dependencies.
   */
  private buildModuleSubset(
    moduleName: string,
    depChain: Module[],
    topology: WorkspaceTopology,
  ): CodebaseSubgraph {
    const moduleFiles: string[] = [];
    const dependencyPaths = new Set<string>();
    const dependentPaths = new Set<string>();
    const edges: Array<{ from: string; to: string }> = [];

    // Collect the primary module's files
    const primaryModule = topology.queryModule(moduleName);
    if (primaryModule) {
      moduleFiles.push(...primaryModule.files);
    }

    // Collect direct dependency files
    for (const mod of depChain) {
      if (mod.name === moduleName) continue;
      for (const f of mod.files) dependencyPaths.add(f);
    }

    // Collect direct dependents (modules that depend on our module)
    const allModules = Array.from(topology.moduleGraph.values());
    for (const mod of allModules) {
      if (mod.name === moduleName) continue;
      for (const imp of mod.imports) {
        if (moduleFiles.some((f) => imp.source.includes(f) || f.includes(imp.source))) {
          dependentPaths.add(mod.name);
          for (const f of mod.files) dependentPaths.add(f);
        }
      }
    }

    // Build edges — file-level dependency pairs scoped to our module
    for (const mf of moduleFiles) {
      const fileNode = topology.query(mf);
      if (!fileNode) continue;
      for (const dep of fileNode.dependencies) {
        if (dependencyPaths.has(dep) || moduleFiles.includes(dep)) {
          edges.push({ from: mf, to: dep });
        }
      }
    }

    return {
      moduleRoot: moduleName,
      moduleFiles,
      dependencies: Array.from(dependencyPaths),
      dependents: Array.from(dependentPaths),
      edges,
    };
  }

  // -----------------------------------------------------------------------
  // Step 4-5: Filtering
  // -----------------------------------------------------------------------

  /**
   * Filter episodes to only those touching the scoped module or its files.
   */
  private filterEpisodes(
    episodes: Episode[],
    scopeModules: Set<string>,
    scopePaths: Set<string>,
  ): Episode[] {
    return episodes.filter((ep) => {
      // Check if episode touches any scoped module
      if (ep.moduleScope.some((m) => scopeModules.has(m))) return true;
      // Check if episode touches any scoped file
      return ep.affectedFiles.some((f) => scopePaths.has(f));
    });
  }

  /**
   * Filter facts to only those with overlapping file paths or tags.
   */
  private filterFacts(
    facts: ConsolidatedFact[],
    scopePaths: Set<string>,
    scopeTags?: Set<string>,
  ): ConsolidatedFact[] {
    // Extract module-level identifiers from scope paths for more precise matching
    const scopeIdentifiers = new Set<string>();
    for (const p of scopePaths) {
      // Extract directory/file names from paths
      const parts = p.split(/[/\\]/).filter(Boolean);
      for (const part of parts) {
        const clean = part.replace(/\.[a-z]+$/i, "").toLowerCase();
        if (clean.length > 2) scopeIdentifiers.add(clean);
      }
    }
    if (scopeTags) {
      for (const t of scopeTags) scopeIdentifiers.add(t.toLowerCase());
    }

    return facts.filter((fact) => {
      const claimLower = fact.claim.toLowerCase();
      // Match if the claim references any scope-identifier as a whole word
      for (const ident of scopeIdentifiers) {
        // Use word-boundary matching to avoid substring false positives
        const regex = new RegExp(`\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (regex.test(claimLower)) return true;
      }
      return false;
    });
  }

  /**
   * Filter decisions to only those on the same module or affected modules.
   */
  private filterDecisions(
    decisions: Decision[],
    scopeModules: Set<string>,
  ): Decision[] {
    return decisions.filter((dec) => {
      // Check if any affected path matches a scope module
      for (const p of dec.affectedPaths) {
        for (const mod of scopeModules) {
          if (p.toLowerCase().includes(mod.toLowerCase())) return true;
        }
      }
      // Check if any tag matches a scope module
      for (const t of dec.tags) {
        for (const mod of scopeModules) {
          if (t.toLowerCase().includes(mod.toLowerCase())) return true;
        }
      }
      // Check if context/chosen mentions a scope module
      for (const mod of scopeModules) {
        if (dec.context.toLowerCase().includes(mod.toLowerCase())) return true;
        if (dec.chosen.toLowerCase().includes(mod.toLowerCase())) return true;
      }
      return false;
    });
  }

  // -----------------------------------------------------------------------
  // Step 6: Dependency results
  // -----------------------------------------------------------------------

  /**
   * Collect results from parent/dependency tasks in the DAG.
   *
   * In the real flow, this reads from the completed task results map.
   * Here we return a placeholder string — the full integration with the
   * DAG execution results happens in PoolManager.
   */
  private collectDependencyResults(task: TaskGraphNode): string {
    if (!task.dependsOn || task.dependsOn.length === 0) {
      return "No dependency tasks.";
    }
    return `This task depends on: ${task.dependsOn.join(", ")}. ` +
      "Dependency results will be populated from the DAG execution.";
  }

  // -----------------------------------------------------------------------
  // Step 7: Compile working memory
  // -----------------------------------------------------------------------

  /**
   * Compile the working memory string: task prompt + dependency results
   * + module graph subset.
   */
  private compileWorkingMemory(
    task: TaskGraphNode,
    moduleName: string,
    depChain: Module[],
    depResults: string,
    moduleSubset: CodebaseSubgraph,
  ): string {
    const parts: string[] = [];

    // Task prompt
    parts.push(`=== TASK ===`);
    parts.push(task.prompt);

    // Target module
    parts.push(`\n=== TARGET MODULE ===`);
    parts.push(`Module: ${moduleName}`);

    // Dependency chain
    parts.push(`\n=== MODULE DEPENDENCIES ===`);
    if (depChain.length > 1) {
      for (const mod of depChain) {
        if (mod.name !== moduleName) {
          parts.push(`  - ${mod.name} (${mod.files.length} file(s))`);
        }
      }
    } else {
      parts.push(`  No direct module dependencies.`);
    }

    // Module graph subset
    parts.push(`\n=== MODULE FILES ===`);
    for (const f of moduleSubset.moduleFiles) {
      parts.push(`  ${f}`);
    }

    if (moduleSubset.dependencies.length > 0) {
      parts.push(`\n=== DEPENDENCY FILES (read-only) ===`);
      for (const f of moduleSubset.dependencies) {
        parts.push(`  ${f} (read-only dependency)`);
      }
    }

    if (moduleSubset.dependents.length > 0) {
      parts.push(`\n=== DEPENDENT MODULES (may be affected) ===`);
      for (const f of moduleSubset.dependents) {
        parts.push(`  ${f}`);
      }
    }

    // Dependency results
    parts.push(`\n=== DEPENDENCY RESULTS ===`);
    parts.push(depResults);

    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Infer the module name for a given file path using the topology.
   */
  private moduleForFile(
    filePath: string,
    topology: WorkspaceTopology,
  ): string | null {
    for (const [modName, mod] of topology.moduleGraph) {
      if (mod.files.includes(filePath)) {
        return modName;
      }
    }
    return null;
  }

  /**
   * Attempt to extract a module name from a prompt string.
   */
  private extractModuleFromPrompt(
    prompt: string,
    topology: WorkspaceTopology,
  ): string | null {
    const knownModules = Array.from(topology.moduleGraph.keys());
    const lowerPrompt = prompt.toLowerCase();

    for (const mod of knownModules) {
      if (lowerPrompt.includes(mod.toLowerCase())) {
        return mod;
      }
    }

    return null;
  }
}

// =========================================================================
// applySlice
// =========================================================================

/**
 * Configure a sub-agent's context with the memory slice before its first turn.
 *
 * Three injections:
 * 1. Module summary injected as a `<system-reminder>` via appendSystemReminder
 * 2. Relevant prior decisions populated as context messages
 * 3. Boundary constraints added to the system prompt area
 *
 * @param agent - The sub-agent to configure
 * @param memorySlice - The pre-built memory slice for this agent
 */
export function applySlice(agent: Agent, memorySlice: MemorySlice): void {
  // ── 1. Module summary as system reminder ─────────────────────────────
  const moduleSummary = buildModuleSummary(memorySlice);
  agent.context.appendSystemReminder(moduleSummary, {
    kind: "system_trigger",
    name: "memory_slice_module_summary",
  });

  // ── 2. Relevant prior decisions ──────────────────────────────────────
  if (memorySlice.decisions.length > 0) {
    const decisionsText = buildDecisionsContext(memorySlice.decisions);
    agent.context.appendUserMessage(decisionsText, {
      kind: "injection",
      variant: "memory_slice_decisions",
    });
  }

  // ── 3. Boundary constraints ──────────────────────────────────────────
  if (memorySlice.codebaseGraph) {
    const boundaryText = buildBoundaryConstraints(memorySlice);
    if (boundaryText) {
      agent.context.appendSystemReminder(boundaryText, {
        kind: "system_trigger",
        name: "memory_slice_boundary_constraints",
      });
    }
  }
}

// =========================================================================
// Injection builders
// =========================================================================

/**
 * Build the module summary system reminder text.
 */
export function buildModuleSummary(slice: MemorySlice): string {
  const cg = slice.codebaseGraph;
  const lines: string[] = [];

  lines.push(`[Memory Slice] Module: ${cg.moduleRoot}`);
  lines.push(`Files in this module: ${cg.moduleFiles.length}`);
  lines.push(`Direct dependencies: ${cg.dependencies.length} file(s)`);
  lines.push(`Direct dependents: ${cg.dependents.length} file(s)`);

  if (cg.moduleFiles.length > 0) {
    lines.push(`\nModule files (editable):`);
    for (const f of cg.moduleFiles) {
      lines.push(`  - ${f}`);
    }
  }

  if (cg.dependencies.length > 0) {
    lines.push(`\nDependency files (read-only — do not modify):`);
    for (const f of cg.dependencies) {
      lines.push(`  - ${f}`);
    }
  }

  if (slice.episodes.length > 0) {
    lines.push(`\nRelated past episodes: ${slice.episodes.length}`);
    for (const ep of slice.episodes.slice(0, 5)) {
      lines.push(`  - [${ep.timestamp}] ${ep.summary.slice(0, 120)}`);
    }
    if (slice.episodes.length > 5) {
      lines.push(`  - ... and ${slice.episodes.length - 5} more`);
    }
  }

  // Module tree reference
  if (slice.facts.length > 0) {
    lines.push(`\nRelated facts (${slice.facts.length}):`);
    for (const fact of slice.facts.slice(0, 5)) {
      lines.push(`  - ${fact.claim.slice(0, 120)}`);
    }
    if (slice.facts.length > 5) {
      lines.push(`  - ... and ${slice.facts.length - 5} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Build the prior decisions context message.
 */
export function buildDecisionsContext(decisions: Decision[]): string {
  const lines: string[] = [
    "=== RELEVANT PRIOR DECISIONS ===",
    `The following ${decisions.length} prior decision(s) are relevant to your module:`,
    "",
  ];

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i]!;
    lines.push(`${i + 1}. ${d.chosen}`);
    lines.push(`   Context: ${d.context}`);
    lines.push(`   Rationale: ${d.rationale}`);
    if (d.alternatives.length > 0) {
      lines.push(`   Alternatives considered: ${d.alternatives.join(", ")}`);
    }
    lines.push("");
  }

  lines.push("These decisions should inform your approach. " +
    "Do not contradict them without strong justification.");

  return lines.join("\n");
}

/**
 * Build boundary constraints from module boundaries and decisions.
 */
export function buildBoundaryConstraints(slice: MemorySlice): string {
  const cg = slice.codebaseGraph;
  const lines: string[] = [];

  lines.push("[Boundary Constraints]");

  // Module boundary: which files are in scope vs. read-only
  if (cg.dependencies.length > 0) {
    lines.push("You MUST NOT modify dependency files outside your module.");
    lines.push(`Read-only dependency count: ${cg.dependencies.length}`);
  }

  if (cg.dependents.length > 0) {
    lines.push("Changes to your module may affect dependent modules.");
    lines.push(`Potentially affected dependents: ${cg.dependents.length}`);
  }

  // Decision-based constraints
  if (slice.decisions.length > 0) {
    const allConstraints: string[] = [];
    for (const d of slice.decisions) {
      if (d.rationale && !allConstraints.includes(d.rationale)) {
        allConstraints.push(d.rationale);
      }
    }
    if (allConstraints.length > 0) {
      lines.push(`\nDecision-imposed constraints (${allConstraints.length}):`);
      for (const c of allConstraints) {
        lines.push(`  - ${c}`);
      }
    }
  }

  // Boundary rules from topology (if any)
  lines.push("\nRespect module boundaries. Do not introduce circular dependencies.");

  return lines.join("\n");
}