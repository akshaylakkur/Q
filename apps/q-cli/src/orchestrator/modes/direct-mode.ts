/**
 * DirectMode — Zero-overhead execution mode.
 *
 * Invokes the root agent's turn loop directly with the user prompt.
 * Single LLM round-trip, no task graph, no sub-agents.
 */

import { ExecutionModeHandler } from "./handler.js";
import { ExecutionModes } from "./index.js";
import type { ExecutionMode } from "./index.js";
import type { Task, ExecutionResult } from "./types.js";
import type { OrchestratorCore } from "../core.js";
import { runAgentTurn } from "../../agent/wiring.js";

const CONFIG_HOWTO = `⚠️  No LLM provider configured.

To fix, set one of:
  export Q_PROVIDER=anthropic
  export Q_MODEL=claude-sonnet-4-20250514
  export Q_API_KEY=sk-...

Or create .q/config.toml with provider, model, api_key.`;

export class DirectMode extends ExecutionModeHandler {
  readonly mode: ExecutionMode = ExecutionModes.AUTO;
  readonly description = "Direct execution — zero orchestration overhead, single LLM round-trip";

  async execute(task: Task, orchestrator: OrchestratorCore): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const completedAt = new Date().toISOString();

    try {
      const result = await this.invokeAgentTurn(task, orchestrator);

      return {
        success: true,
        mode: this.mode,
        taskId: task.id,
        output: result.error ? CONFIG_HOWTO : result.output,
        totalTokens: 0,
        llmCallCount: result.error ? 0 : 1,
        toolCallCount: result.toolCalls,
        durationMs: Date.now() - startedAt,
        changedFiles: [],
        verificationPassed: !result.error,
        completedAt,
      };
    } catch (error) {
      return {
        success: true,
        mode: this.mode,
        taskId: task.id,
        output: CONFIG_HOWTO,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        completedAt,
      };
    }
  }

  private async invokeAgentTurn(
    task: Task,
    orchestrator: OrchestratorCore,
  ): Promise<{ output: string; toolCalls: number; error?: string }> {
    const agent = orchestrator.rootAgent;
    if (!agent) {
      return { output: "", toolCalls: 0, error: "No root agent configured." };
    }

    const result = await runAgentTurn(agent, task.prompt, orchestrator.getAbortSignal());
    return result;
  }
}
