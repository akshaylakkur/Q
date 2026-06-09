/**
 * ExecutionModeHandler — Common interface for all mode handlers.
 *
 * Each mode handler implements `execute(task, orchestrator)` and returns
 * an `ExecutionResult`.  Handlers also expose their mode identifier and
 * a human-readable description.
 */

import type { Task, ExecutionResult } from "./types.js";
import type { OrchestratorCore } from "../core.js";
import type { ExecutionMode } from "./index.js";

/**
 * Abstract base class for execution mode handlers.
 */
export abstract class ExecutionModeHandler {
  /** The execution mode this handler implements. */
  abstract readonly mode: ExecutionMode;

  /** Human-readable description of this mode. */
  abstract readonly description: string;

  /**
   * Execute the given task using this mode's strategy.
   *
   * @param task         The task to execute.
   * @param orchestrator The orchestrator core (provides access to agents,
   *                     pool manager, convergence engine, etc.).
   */
  abstract execute(task: Task, orchestrator: OrchestratorCore): Promise<ExecutionResult>;
}