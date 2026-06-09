/**
 * Stateful execution scheduler for tool calls in one model step.
 *
 * Tasks with non-conflicting resource accesses may overlap;
 * tasks with conflicting resource accesses wait for the conflicting active tasks.
 */

import { ToolAccesses } from "./tool-access.js";

export interface ToolCallTask<Result> {
  readonly accesses: ToolAccesses;
  readonly start: () => Promise<{ readonly result: Promise<Result> }>;
}

interface ScheduledToolCallTask<Result> extends ToolCallTask<Result> {
  readonly result: {
    resolve: (value: Result) => void;
    reject: (reason: unknown) => void;
    promise: Promise<Result>;
  };
}

export class ToolScheduler<Result> {
  private readonly activeTasks: Array<ScheduledToolCallTask<Result>> = [];
  private queuedTasks: Array<ScheduledToolCallTask<Result>> = [];

  add(task: ToolCallTask<Result>): Promise<Result> {
    let resolve!: (value: Result) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Result>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Suppress unhandled rejections — errors propagate through the promise
    promise.catch(() => undefined);

    const scheduledTask: ScheduledToolCallTask<Result> = { ...task, result: { resolve, reject, promise } };
    if (this.isBlocked(task, this.queuedTasks)) {
      this.queuedTasks.push(scheduledTask);
    } else {
      this.start(scheduledTask);
    }

    return promise;
  }

  private isBlocked(
    task: ToolCallTask<Result>,
    queuedBefore: readonly ToolCallTask<Result>[],
  ): boolean {
    return (
      this.conflictsWithAny(task, this.activeTasks) || this.conflictsWithAny(task, queuedBefore)
    );
  }

  private conflictsWithAny(
    task: ToolCallTask<Result>,
    candidates: readonly ToolCallTask<Result>[],
  ): boolean {
    return candidates.some((candidate) =>
      ToolAccesses.conflict(task.accesses, candidate.accesses),
    );
  }

  private start(task: ScheduledToolCallTask<Result>): void {
    this.activeTasks.push(task);
    let started: Promise<{ readonly result: Promise<Result> }>;
    try {
      started = task.start();
    } catch (error) {
      task.result.reject(error);
      this.finish(task);
      return;
    }

    void started
      .then(({ result }) => result)
      .then(task.result.resolve, task.result.reject)
      .finally(() => {
        this.finish(task);
      });
  }

  private finish(task: ScheduledToolCallTask<Result>): void {
    const index = this.activeTasks.indexOf(task);
    if (index >= 0) this.activeTasks.splice(index, 1);
    this.startQueuedTasks();
  }

  private startQueuedTasks(): void {
    const stillQueued: Array<ScheduledToolCallTask<Result>> = [];
    for (const task of this.queuedTasks) {
      if (this.isBlocked(task, stillQueued)) {
        stillQueued.push(task);
      } else {
        this.start(task);
      }
    }
    this.queuedTasks = stillQueued;
  }
}
