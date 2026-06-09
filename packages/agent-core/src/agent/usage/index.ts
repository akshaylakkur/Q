/**
 * UsageRecorder — Token usage tracking.
 */

import type { TokenUsage } from "@q/qprovs";

import type { Agent } from "../agent.js";

export interface UsageStatus {
  byModel?: Record<string, TokenUsage>;
  total?: TokenUsage;
  currentTurn?: TokenUsage;
}

export type UsageRecordScope = "session" | "turn";

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
      : {}),
    ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) }
      : {}),
  };
}

export class UsageRecorder {
  private readonly byModel: Record<string, TokenUsage> = {};
  private currentTurn: TokenUsage | undefined;

  constructor(protected readonly agent?: Agent) {}

  beginTurn(): void {
    this.currentTurn = undefined;
  }

  endTurn(): void {
    this.currentTurn = undefined;
  }

  record(model: string, usage: TokenUsage, scope: UsageRecordScope = "session"): void {
    const current = this.byModel[model];
    this.byModel[model] = current === undefined ? copyUsage(usage) : addUsage(current, usage);

    if (scope === "turn") {
      this.currentTurn =
        this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
    }
    this.agent?.emitStatusUpdated();
  }

  data(): UsageStatus {
    const byModel = this.byModelSnapshot();
    const hasByModel = Object.keys(byModel).length > 0;
    return {
      byModel: hasByModel ? byModel : undefined,
      total: hasByModel ? totalUsage(byModel) : undefined,
      currentTurn: this.currentTurn ? copyUsage(this.currentTurn) : undefined,
    };
  }

  status(): UsageStatus | undefined {
    const status = this.data();
    if (
      status.byModel === undefined &&
      status.total === undefined &&
      status.currentTurn === undefined
    ) {
      return undefined;
    }
    return status;
  }

  private byModelSnapshot(): Record<string, TokenUsage> {
    return Object.fromEntries(
      Object.entries(this.byModel).map(([model, usage]) => [model, copyUsage(usage)]),
    );
  }
}

function totalUsage(byModel: Record<string, TokenUsage>): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const usage of Object.values(byModel)) {
    total = total === undefined ? copyUsage(usage) : addUsage(total, usage);
  }
  return total;
}
