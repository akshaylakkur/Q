/**
 * ContextMemory — Manages the agent's conversation history.
 *
 * Maintains message history, token counting, open steps tracking,
 * pending tool results, and deferred messages.
 */

import type { Agent } from "../agent.js";
import type { ExecutableToolResult, LoopRecordedEvent } from "../../loop/index.js";
import { project, estimateTokenCount } from "./projector.js";
import {
  USER_PROMPT_ORIGIN,
  type AgentContextData,
  type ContextMessage,
  type PromptOrigin,
} from "./types.js";

const TOOL_ERROR_STATUS = "<system>ERROR: Tool execution failed.</system>";
const TOOL_EMPTY_STATUS = "<system>Tool output is empty.</system>";
const TOOL_OUTPUT_EMPTY_TEXT = "Tool output is empty.";

export class ContextMemory {
  private _history: ContextMessage[] = [];
  private _tokenCount = 0;
  private tokenCountCoveredMessageCount = 0;

  constructor(protected readonly agent: Agent) {}

  appendUserMessage(
    content: string,
    origin: PromptOrigin = USER_PROMPT_ORIGIN,
  ): void {
    this.appendMessage({
      role: "user" as const,
      content,
      origin,
    });
  }

  appendSystemReminder(content: string, origin: PromptOrigin): void {
    const text = `<system-reminder>\n${content}\n</system-reminder>`;
    this.appendMessage({
      role: "user" as const,
      content: text,
      origin,
    });
  }

  clear(): void {
    this._history = [];
    this._tokenCount = 0;
    this.tokenCountCoveredMessageCount = 0;
    this.agent.emitStatusUpdated();
  }

  applyCompaction(summary: { summary: string; compactedCount: number; tokensAfter: number }): void {
    this._history = [
      {
        role: "assistant" as const,
        content: summary.summary,
        origin: { kind: "compaction_summary" },
      },
      ...this._history.slice(summary.compactedCount),
    ];
    this._tokenCount = summary.tokensAfter;
    this.tokenCountCoveredMessageCount = this._history.length;
    this.agent.emitStatusUpdated();
  }

  data(): AgentContextData {
    return {
      history: this.history,
      tokenCount: this.tokenCount,
    };
  }

  get tokenCount(): number {
    return this._tokenCount;
  }

  get tokenCountWithPending(): number {
    const pendingMessages = this._history.slice(this.tokenCountCoveredMessageCount);
    return this._tokenCount + estimateTokenCount(project(pendingMessages));
  }

  get history(): readonly ContextMessage[] {
    return this._history;
  }

  get messages(): ContextMessage[] {
    return project(this._history);
  }

  appendLoopEvent(event: LoopRecordedEvent): void {
    switch (event.type) {
      case "step.begin":
      case "step.end":
      case "content.part":
        return;
      case "tool.call":
        return;
      case "assistant.message": {
        // Persist the assistant's response (text, tool calls, or both)
        // so the model sees its own reasoning between steps. Without this
        // the model loses continuity and may re-request the same tool calls
        // endlessly or lose text output entirely.
        const message: ContextMessage = {
          role: "assistant" as const,
          content: event.content,
          toolCalls: event.toolCalls.length > 0
            ? event.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: tc.arguments,
                },
              }))
            : undefined,
        };
        this.pushHistory(message);
        return;
      }
      case "tool.result": {
        const message: ContextMessage = {
          role: "tool" as const,
          content: toolResultOutputForModel(event.result),
          toolCallId: event.toolCallId,
          isError: event.result.isError,
        };
        this.pushHistory(message);
        return;
      }
    }
  }

  appendMessage(message: ContextMessage): void {
    if (message.origin?.kind === "user" && message.origin.blockedByHook) {
      return;
    }
    this.pushHistory(message);
  }

  async buildMessages(): Promise<ContextMessage[]> {
    return project(this._history);
  }

  private pushHistory(...messages: ContextMessage[]): void {
    this._history.push(...messages);
  }
}

function toolResultOutputForModel(result: ExecutableToolResult): string {
  const output = result.output;
  if (typeof output === "string") {
    if (result.isError === true) {
      if (output.length === 0) return TOOL_EMPTY_STATUS;
      return `${TOOL_ERROR_STATUS}\n${output}`;
    }
    return isEmptyOutputText(output) ? TOOL_EMPTY_STATUS : output;
  }
  if (result.isError === true) {
    return `${TOOL_ERROR_STATUS}\n${JSON.stringify(output)}`;
  }
  return JSON.stringify(output);
}

function isEmptyOutputText(output: string): boolean {
  return output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}
