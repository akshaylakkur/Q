/**
 * TurnFlow — Manages the turn lifecycle.
 *
 * Handles prompt/steer launch, cancellation, steer buffering,
 * running the LLM loop, and emitting turn events.
 *
 * Now properly forwards streaming events (text deltas, thinking deltas,
 * tool call deltas, tool calls, tool results) to the agent's RPC channel
 * so the TUI can display real-time streaming output.
 */

import type { Agent } from "../agent.js";
import type { LoopTurnStopReason } from "../../loop/index.js";
import { runTurn as loopRunTurn, createLoopEventDispatcher } from "../../loop/index.js";
import type { LoopRecordedEvent, LoopEvent } from "../../loop/index.js";
import { USER_PROMPT_ORIGIN, type PromptOrigin } from "../context/types.js";

interface ActiveTurn {
  controller: AbortController;
  promise: Promise<TurnEndResult>;
}

interface BufferedSteer {
  readonly input: string;
  readonly origin: PromptOrigin;
}

export interface TurnEndResult {
  readonly stopReason?: LoopTurnStopReason;
}

export class TurnFlow {
  private steerBuffer: BufferedSteer[] = [];
  private turnId = -1;
  private activeTurn: ActiveTurn | null = null;

  constructor(protected readonly agent: Agent) {}

  prompt(
    input: string,
    origin: PromptOrigin = USER_PROMPT_ORIGIN,
  ): number | null {
    return this.launch(input, origin);
  }

  steer(
    input: string,
    origin: PromptOrigin = USER_PROMPT_ORIGIN,
  ): number | null {
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return null;
    }
    return this.launch(input, origin);
  }

  private launch(
    input: string,
    origin: PromptOrigin,
  ): number | null {
    if (this.activeTurn) {
      this.agent.emitEvent({
        type: "error",
        message: `Cannot launch a new turn while another turn (ID ${this.turnId}) is active`,
      } as never);
      return null;
    }

    this.turnId += 1;
    this.agent.usage.beginTurn();

    this.agent.emitEvent({
      type: "turn.started",
      turnId: this.turnId,
      origin,
    } as never);

    this.agent.context.appendUserMessage(input, origin);

    const controller = new AbortController();
    const promise = this.turnWorker(this.turnId, controller.signal);
    this.activeTurn = { controller, promise };
    return this.turnId;
  }

  cancel(turnId?: number): void {
    if (turnId !== undefined && turnId !== this.currentId) return;
    this.abortTurn();
  }

  get currentId(): number {
    return this.turnId;
  }

  get hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  waitForCurrentTurn(signal?: AbortSignal): Promise<TurnEndResult> {
    const active = this.activeTurn;
    if (active === null) {
      return Promise.reject(new Error("No active turn"));
    }
    signal?.throwIfAborted();
    if (signal === undefined) return active.promise;
    const turnId = this.currentId;
    const onAbort = (): void => {
      this.agent.turn.cancel(turnId);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return active.promise.finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  }

  private abortTurn(): void {
    this.activeTurn?.controller.abort();
    this.activeTurn = null;
  }

  finishResume(): void {
    this.activeTurn = null;
    this.steerBuffer.length = 0;
  }

  private flushSteerBuffer(): boolean {
    const steers = this.steerBuffer;
    if (steers.length === 0) return false;
    for (const steer of steers) {
      this.agent.context.appendUserMessage(steer.input, steer.origin);
    }
    steers.length = 0;
    return true;
  }

  /**
   * Map a loop event to an agent event for the RPC channel.
   * This is the bridge that enables real-time streaming in the TUI.
   */
  private mapLoopEventToAgentEvent(event: LoopEvent, turnId: number): unknown {
    switch (event.type) {
      case "text.delta":
        return {
          type: "assistant.delta",
          turnId,
          delta: event.delta,
        };
      case "thinking.delta":
        return {
          type: "thinking.delta",
          turnId,
          delta: event.delta,
        };
      case "tool.call.delta":
        return {
          type: "tool.call.delta",
          turnId,
          toolCallId: event.toolCallId,
          name: event.name,
          argumentsPart: event.argumentsPart,
        };
      case "tool.call":
        return {
          type: "tool.call.started",
          turnId,
          toolCallId: event.toolCallId,
          name: event.name,
          args: event.args,
          description: event.description,
        };
      case "tool.result":
        return {
          type: "tool.result",
          turnId,
          toolCallId: event.toolCallId,
          output: event.result.output,
          isError: event.result.isError,
        };
      case "tool.progress":
        return {
          type: "tool.progress",
          turnId,
          toolCallId: event.toolCallId,
          update: event.update,
        };
      case "step.begin":
        return {
          type: "turn.step.started",
          turnId,
          step: event.step,
          stepId: event.uuid,
        };
      case "step.end":
        return {
          type: "turn.step.completed",
          turnId,
          step: event.step,
          stepId: event.uuid,
          usage: event.usage,
          finishReason: event.finishReason,
        };
      case "step.retrying":
        return {
          type: "turn.step.retrying",
          turnId,
          step: event.step,
          stepId: event.stepUuid,
          failedAttempt: event.failedAttempt,
          nextAttempt: event.nextAttempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorName: event.errorName,
          errorMessage: event.errorMessage,
          statusCode: event.statusCode,
        };
      case "turn.interrupted":
        return {
          type: "turn.step.interrupted",
          turnId,
          step: event.activeStep ?? event.attemptedSteps,
          reason: event.reason,
          message: event.message,
        };
      default:
        return null;
    }
  }

  private async turnWorker(
    turnId: number,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    const agent = this.agent;

    try {
      const dispatchEvent = createLoopEventDispatcher({
        appendTranscriptRecord: async (event: LoopRecordedEvent) => {
          // Feed tool results and assistant tool-call blocks into
          // context memory so the model sees its own prior decisions
          // between steps.
          agent.context.appendLoopEvent(event);
        },
        emitLiveEvent: (event: LoopEvent) => {
          // Forward streaming events to the agent's RPC channel
          // so the TUI can display real-time output.
          const agentEvent = this.mapLoopEventToAgentEvent(event, turnId);
          if (agentEvent) {
            agent.emitEvent(agentEvent);
          }
        },
      });

      const llm = agent.llm;
      const tools = agent.tools.loopTools;

      const result = await loopRunTurn({
        turnId: String(turnId),
        signal,
        llm,
        buildMessages: async () => agent.context.messages as unknown[],
        dispatchEvent,
        tools,
        hooks: {
          beforeStep: async (_ctx) => {
            await agent.injection?.inject();
            return undefined;
          },
          afterStep: async (_ctx) => {
            // Nothing needed after step
          },
          prepareToolExecution: async (ctx) => {
            const permissionResult = await agent.permission.beforeToolCall({
              turnId: ctx.turnId,
              toolCall: ctx.toolCall,
            });
            return permissionResult;
          },
          finalizeToolResult: async (_ctx) => {
            return undefined;
          },
          shouldContinueAfterStop: async (_ctx) => {
            const steered = this.flushSteerBuffer();
            return { continue: steered };
          },
        },
      });

      agent.usage.endTurn();
      agent.emitEvent({
        type: "turn.ended",
        turnId,
        reason: result.stopReason === "aborted" ? "cancelled" : "completed",
      } as never);

      return { stopReason: result.stopReason };
    } catch (error) {
      agent.usage.endTurn();
      if (signal.aborted) {
        agent.emitEvent({ type: "turn.ended", turnId, reason: "cancelled" } as never);
        return { stopReason: "aborted" };
      }
      agent.emitEvent({
        type: "turn.ended",
        turnId,
        reason: "failed",
        error: String(error),
      } as never);
      throw error;
    } finally {
      this.activeTurn = null;
    }
  }
}
