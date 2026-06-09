/**
 * SessionSubagentHost — Manages spawning, resuming, and cancellation
 * of sub-agents for a parent agent.
 *
 * Each sub-agent is a full Agent instance with type: "sub", configured
 * with a resolved profile (system prompt, tool set), running in its own
 * turn loop with the parent's cwd, model alias, and thinking level.
 */

import { Agent, type AgentOptions, type AgentType } from "./agent.js";
import { runTurn as loopRunTurn, createLoopEventDispatcher } from "../loop/index.js";
import type {
  LoopEvent,
  LoopRecordedEvent,
  TurnResult,
} from "../loop/index.js";
import type { TokenUsage } from "@q/qprovs";

import {
  loadAllProfiles,
  resolveAgentProfile,
  SystemPromptRenderer,
  type ResolvedProfile,
  type RenderContext,
  type RawProfile,
} from "./profiles/loader.js";

/** Default agent profiles available for sub-agent spawning */
export const DEFAULT_AGENT_PROFILES: Record<string, RawProfile> = /* #__PURE__ */ loadAllProfiles();

/**
 * Result returned from spawning a sub-agent.
 */
export interface SubagentResult {
  /** The child agent's UUID — matches ChildAgent.id */
  id: string;
  /** The text output from the sub-agent's final response */
  result: string;
  /** Aggregated token usage across all steps */
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
}

/**
 * Internal tracking data for each spawned child agent.
 */
export interface ChildAgent {
  readonly id: string;
  readonly agent: Agent;
  readonly profile: ResolvedProfile;
  controller: AbortController;
  promise: Promise<SubagentResult>;
  state: "running" | "completed" | "failed" | "cancelled";
  result?: SubagentResult;
  error?: string;
}

/**
 * Options for spawning a sub-agent.
 */
export interface SpawnSubagentOptions {
  /** Optional override for the profile name (defaults to the one passed to spawn) */
  profileName?: string;
  /** Optional parent signal for cancellation linking */
  signal?: AbortSignal;
  /** Optional description for logging/tracking */
  description?: string;
}

/**
 * Options for resuming a previously terminated sub-agent.
 */
export interface ResumeSubagentOptions {
  /** New task prompt for the resumed agent */
  prompt: string;
}

/**
 * SessionSubagentHost — Manages sub-agent lifecycle for a parent agent.
 *
 * Features:
 * - Spawn sub-agents with profile-based configuration
 * - Track children in activeChildren map
 * - Cancel all foreground children recursively
 * - Resume previously completed sub-agents
 */
export class SessionSubagentHost {
  /** Map of active child agents keyed by agent ID */
  readonly activeChildren: Map<string, ChildAgent> = new Map();

  private readonly parentAgent: Agent;
  private readonly profileMap: Record<string, RawProfile>;

  constructor(parentAgent: Agent, profileMap?: Record<string, RawProfile>) {
    this.parentAgent = parentAgent;
    this.profileMap = profileMap ?? DEFAULT_AGENT_PROFILES;
  }

  /**
   * Spawn a sub-agent with the given profile name and task prompt.
   *
   * Resolution flow:
   * 1. Resolve the sub-agent profile from DEFAULT_AGENT_PROFILES
   * 2. Create a new Agent instance with type: "sub"
   * 3. Create an AbortController linked to the caller's signal
   * 4. Track the child in activeChildren
   * 5. Call runChild() which inherits parent's cwd, model alias, thinking level
   * 6. Apply the profile (system prompt, tool set)
   * 7. Drive the child agent's turn loop with the task prompt
   * 8. Wait for turn completion (reason === "completed")
   * 9. Check summary length — if < 200 chars, append continuation prompt
   * 10. Return { result, usage }
   */
  async spawn(
    profileName: string,
    prompt: string,
    options?: SpawnSubagentOptions,
  ): Promise<SubagentResult> {
    // 1. Resolve profile
    const profile = resolveAgentProfile(profileName, this.profileMap);
    if (!profile) {
      throw new Error(`Unknown sub-agent profile: "${profileName}". Available: ${Object.keys(this.profileMap).join(", ")}`);
    }

    // 2. Create a new Agent instance with type: "sub"
    const parentConfig = this.parentAgent.config;

    const agentOptions: AgentOptions = {
      runtime: this.parentAgent.runtime,
      config: this.parentAgent.configData,
      homedir: this.parentAgent.homedir,
      rpc: this.parentAgent.rpc,
      subagentHost: undefined, // sub-agents don't need their own sub-agent host
      skills: this.parentAgent.skills,
      mcp: this.parentAgent.mcp,
      hooks: this.parentAgent.hooks,
      permission: this.parentAgent.rpc ? { mode: "auto" } : undefined,
      telemetry: this.parentAgent.telemetry,
    };

    const childAgent = new Agent(agentOptions);

    // Override type to "sub"
    (childAgent as { type: AgentType }).type = "sub";

    // 3. Create AbortController linked to parent signal
    const controller = new AbortController();
    const parentSignal = options?.signal;
    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort();
      } else {
        const onParentAbort = () => controller.abort();
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
        controller.signal.addEventListener("abort", () => {
          parentSignal.removeEventListener("abort", onParentAbort);
        }, { once: true });
      }
    }

    // 5. Inherit parent's cwd, model alias, thinking level
    childAgent.config.update({
      cwd: parentConfig.cwd,
      modelAlias: parentConfig.modelAlias,
      thinkingLevel: parentConfig.thinkingLevel,
    });

    // 6. Apply profile: build system prompt and set tools
    const renderer = new SystemPromptRenderer(profile);
    const toolDescriptions = this.buildToolDescriptions(profile);
    const skillListing = this.buildSkillListing();
    const renderContext: RenderContext = {
      cwd: parentConfig.cwd,
      model: parentConfig.modelAlias ?? "default",
      sessionId: this.parentAgent.id,
      toolDescriptions,
      skillListing,
      profileName: profile.name,
    };
    const systemPrompt = renderer.render(renderContext);

    childAgent.config.update({
      systemPrompt,
      profileName: profile.name,
    });

    // Set active tools based on profile
    this.applyProfileTools(childAgent, profile);

    // 4. Track the child
    const childId = childAgent.id;
    const child: ChildAgent = {
      id: childId,
      agent: childAgent,
      profile,
      controller,
      promise: this.runChild(childAgent, prompt, controller.signal),
      state: "running",
    };

    this.activeChildren.set(childId, child);

    try {
      // 7, 8. Drive the turn loop and wait for completion
      const result = await child.promise;

      // 9. Check summary length — if < 200 characters, append continuation prompt
      if (result.result.length < 200) {
        const continuationPrompt =
          "Your response was brief. Please expand your answer with more detail, provide examples, and ensure it thoroughly addresses the task. Include a comprehensive summary of what you did and the key findings.";

        const child2 = this.activeChildren.get(childId);
        if (child2 && child2.state === "completed") {
          const expandResult = await this.runChild(
            childAgent,
            continuationPrompt,
            controller.signal,
          );
          return {
            id: childId,
            result: result.result + "\n\n" + expandResult.result,
            usage: {
              promptTokens: result.usage.promptTokens + expandResult.usage.promptTokens,
              completionTokens: result.usage.completionTokens + expandResult.usage.completionTokens,
            },
          };
        }
      }

      return result;
    } catch (error) {
      const childEntry = this.activeChildren.get(childId);
      if (childEntry) {
        childEntry.state = "failed";
        childEntry.error = String(error);
      }
      throw error;
    } finally {
      // Keep in map for resume, but mark as completed/cancelled
      // (don't delete — resume needs the agent instance)
    }
  }

  /**
   * Adapter to the SubagentHost interface used by the Agent tool.
   *
   * The Agent tool calls `subagentHost.spawnSubagent(prompt, { description,
   * profileName, signal })` and expects `{ id, result }` back. This method
   * bridges to the full `spawn(profileName, prompt, options)` API.
   *
   * The `description` is currently ignored (it would be useful for the
   * TaskList UI but no sub-agent UI exists yet).
   */
  async spawnSubagent(
    prompt: string,
    config?: { description?: string; profileName?: string; signal?: AbortSignal },
  ): Promise<{ id: string; result?: string }> {
    const profileName = config?.profileName ?? "general";
    const result = await this.spawn(profileName, prompt, { signal: config?.signal });
    return { id: result.id, result: result.result };
  }

  /**
   * Resume a previously terminated sub-agent.
   * Re-aligns the agent to the parent's current model and restarts its turn.
   */
  async resume(
    agentId: string,
    prompt: string,
    options?: ResumeSubagentOptions,
  ): Promise<SubagentResult> {
    const child = this.activeChildren.get(agentId);
    if (!child) {
      throw new Error(`No sub-agent found with ID "${agentId}"`);
    }

    // Re-align to parent's current model
    const parentConfig = this.parentAgent.config;
    child.agent.config.update({
      modelAlias: parentConfig.modelAlias,
      thinkingLevel: parentConfig.thinkingLevel,
      cwd: parentConfig.cwd,
    });

    // Create a new controller for the resumed turn
    const controller = new AbortController();
    child.controller = controller;
    child.state = "running";

    const taskPrompt = options?.prompt ?? prompt;
    child.promise = this.runChild(child.agent, taskPrompt, controller.signal);

    try {
      const result = await child.promise;
      return result;
    } catch (error) {
      child.state = "failed";
      child.error = String(error);
      throw error;
    }
  }

  /**
   * Cancel all foreground children recursively.
   */
  cancelAll(): void {
    for (const [, child] of this.activeChildren) {
      if (child.state === "running") {
        child.controller.abort();
        child.state = "cancelled";
      }
    }
  }

  /**
   * Cancel a specific child agent.
   */
  cancel(agentId: string): void {
    const child = this.activeChildren.get(agentId);
    if (child && child.state === "running") {
      child.controller.abort();
      child.state = "cancelled";
    }
  }

  /**
   * Get the status summary of all children.
   */
  status(): Array<{ id: string; profile: string; state: string; error?: string }> {
    return Array.from(this.activeChildren.values()).map((c) => ({
      id: c.id,
      profile: c.profile.name,
      state: c.state,
      error: c.error,
    }));
  }

  /**
   * Run the child agent's turn loop with the given prompt.
   * This drives the LLM interaction and returns the final result.
   */
  private async runChild(
    childAgent: Agent,
    prompt: string,
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    childAgent.context.appendUserMessage(prompt);

    const dispatchEvent = createLoopEventDispatcher({
      appendTranscriptRecord: async (_event: LoopRecordedEvent) => {
        // Sub-agent events are not recorded to parent's persistence
      },
      emitLiveEvent: (_event: LoopEvent) => {
        // Emit to UI via parent
        this.parentAgent.emitEvent({
          type: "subagent.event",
          agentId: childAgent.id,
          event: _event,
        } as never);
      },
    });

    const llm = childAgent.llm;
    const tools = childAgent.tools.loopTools;

    try {
      const turnResult: TurnResult = await loopRunTurn({
        turnId: "0", // Single turn for sub-agent
        signal,
        llm,
        buildMessages: async () => childAgent.context.messages as unknown[],
        dispatchEvent,
        tools,
        hooks: {
          beforeStep: async (_ctx) => {
            // No injection needed for sub-agents in base flow
            return undefined;
          },
          afterStep: async (_ctx) => {
            // Nothing needed
          },
          prepareToolExecution: async (ctx) => {
            const permissionResult = await childAgent.permission.beforeToolCall({
              turnId: ctx.turnId,
              toolCall: ctx.toolCall,
            });
            return permissionResult;
          },
          finalizeToolResult: async (_ctx) => {
            return undefined;
          },
          shouldContinueAfterStop: async (_ctx) => {
            return { continue: false };
          },
        },
      });

      // Record usage to parent
      const modelName = childAgent.config.modelAlias ?? "unknown";
      const usage: TokenUsage = turnResult.usage;
      this.parentAgent.usage.record(modelName, usage, "session");

      // Mark child as completed
      const entry = this.activeChildren.get(childAgent.id);
      if (entry) {
        entry.state = "completed";
      }

      // Extract the result from the last assistant message
      const messages = childAgent.context.messages;
      let result = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as { role: string; content: string };
        if (msg.role === "assistant" && msg.content) {
          result = msg.content;
          break;
        }
      }

      const finalResult: SubagentResult = {
        id: childAgent.id,
        result,
        usage: {
          promptTokens: turnResult.usage.promptTokens,
          completionTokens: turnResult.usage.completionTokens,
        },
      };

      const entry2 = this.activeChildren.get(childAgent.id);
      if (entry2) {
        entry2.result = finalResult;
      }

      return finalResult;
    } catch (error) {
      if (signal.aborted) {
        const entry = this.activeChildren.get(childAgent.id);
        if (entry) {
          entry.state = "cancelled";
        }
        throw new Error("Sub-agent turn was cancelled");
      }
      const entry = this.activeChildren.get(childAgent.id);
      if (entry) {
        entry.state = "failed";
        entry.error = String(error);
      }
      throw error;
    }
  }

  /** Build a human-readable tool description string for the system prompt */
  private buildToolDescriptions(profile: ResolvedProfile): string {
    const parts: string[] = [];
    for (const toolName of profile.tools) {
      if (toolName === "mcp:*") {
        parts.push("- All MCP tools");
      } else {
        parts.push(`- ${toolName}`);
      }
    }
    return parts.join("\n");
  }

  /** Build a listing of available skills for the system prompt */
  private buildSkillListing(): string {
    const skillNames = this.parentAgent.skills.listSkills?.() ?? [];
    if (skillNames.length === 0) return "None";
    return skillNames.map((s) => `- ${s}`).join("\n");
  }

  /** Apply profile tools to the child agent */
  private applyProfileTools(childAgent: Agent, profile: ResolvedProfile): void {
    const toolNames = profile.tools.filter((t) => t !== "mcp:*");
    childAgent.tools.setActiveTools(toolNames);
  }
}
