/**
 * BackgroundManager — Manages background bash/agent tasks and notifications.
 */

import type { Agent } from "../agent.js";

export interface BackgroundTaskInfo {
  readonly taskId: string;
  readonly description: string;
  readonly status: "running" | "completed" | "failed" | "killed" | "timed_out";
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly timedOut?: boolean;
}

export interface BackgroundTaskStatus {
  running: Map<string, BackgroundTaskInfo>;
  completed: BackgroundTaskInfo[];
  maxRunningTasks: number;
}

export class BackgroundManager {
  private readonly tasks: Map<string, BackgroundTaskInfo> = new Map();
  private readonly maxRunningTasks: number;
  private runningCount = 0;

  constructor(
    public readonly agent: Agent,
    options: { maxRunningTasks?: number } = {},
  ) {
    this.maxRunningTasks = options.maxRunningTasks ?? 5;
  }

  registerTask(info: BackgroundTaskInfo): void {
    this.tasks.set(info.taskId, info);
    if (info.status === "running") {
      this.runningCount++;
    }
    this.agent.emitStatusUpdated();
  }

  updateTask(taskId: string, update: Partial<BackgroundTaskInfo>): void {
    const existing = this.tasks.get(taskId);
    if (existing) {
      const wasRunning = existing.status === "running";
      const merged: BackgroundTaskInfo = {
        ...existing,
        ...update,
        status: (update.status ?? existing.status) as BackgroundTaskInfo["status"],
        endedAt: update.endedAt ?? existing.endedAt,
      };
      this.tasks.set(taskId, merged);
      const nowRunning = merged.status === "running";
      if (wasRunning && !nowRunning) this.runningCount--;
      if (!wasRunning && nowRunning) this.runningCount++;
    }
    this.agent.emitStatusUpdated();
  }

  async stop(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      this.tasks.set(taskId, {
        ...task,
        status: "killed",
        endedAt: Date.now(),
      });
      if (this.runningCount > 0) this.runningCount--;
    }
    this.agent.emitStatusUpdated();
  }

  async stopAll(): Promise<void> {
    for (const [taskId] of this.tasks) {
      await this.stop(taskId);
    }
  }

  readOutput(_taskId: string, _tail?: number): Promise<{ preview: string }> {
    return Promise.resolve({ preview: "" });
  }

  getOutputPath(_taskId: string): string | undefined {
    return undefined;
  }

  list(activeOnly: boolean = false, _limit?: number): BackgroundTaskInfo[] {
    const all = Array.from(this.tasks.values());
    if (activeOnly) {
      return all.filter((t) => t.status === "running");
    }
    return all;
  }

  canStartTask(): boolean {
    return this.runningCount < this.maxRunningTasks;
  }

  getStatus(): BackgroundTaskStatus {
    return {
      running: new Map(
        Array.from(this.tasks.entries()).filter(([, t]) => t.status === "running"),
      ),
      completed: Array.from(this.tasks.values()).filter(
        (t) => t.status !== "running",
      ),
      maxRunningTasks: this.maxRunningTasks,
    };
  }
}
