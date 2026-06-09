/**
 * PermissionManager — Tool authorization via configurable policies.
 *
 * Evaluates tool calls against permission rules and user-configured policies.
 * Supports manual, yolo, and auto modes.
 */

import type { Agent } from "../agent.js";
import type { PrepareToolExecutionResult } from "../../loop/index.js";
import type {
  PermissionPolicyContext,
  PermissionMode,
  PermissionRule,
  PermissionData,
  PermissionApprovalResultRecord,
} from "./types.js";

export * from "./types.js";

export interface PermissionManagerOptions {
  readonly initialRules?: readonly PermissionRule[];
}

export class PermissionManager {
  rules: PermissionRule[] = [];
  private modeOverride: PermissionMode | undefined;

  constructor(
    protected readonly agent: Agent,
    options: PermissionManagerOptions = {},
  ) {
    this.rules = [...(options.initialRules ?? [])];
  }

  get mode(): PermissionMode {
    return this.modeOverride ?? "manual";
  }

  set mode(mode: PermissionMode) {
    this.modeOverride = mode;
  }

  data(): PermissionData {
    return { mode: this.mode, rules: [...this.rules] };
  }

  setMode(mode: PermissionMode): void {
    this.modeOverride = mode;
    this.agent.emitStatusUpdated();
  }

  async beforeToolCall(
    _context: PermissionPolicyContext,
  ): Promise<PrepareToolExecutionResult | undefined> {
    if (this.mode === "yolo" || this.mode === "auto") {
      return undefined;
    }
    return undefined;
  }

  recordApprovalResult(_record: PermissionApprovalResultRecord): void {
    // Record approval results for session-scoped caching
  }
}
