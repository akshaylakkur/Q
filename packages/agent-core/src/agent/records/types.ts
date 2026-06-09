/**
 * AgentRecord types — discriminated union of all persisted agent events.
 */

import type { TokenUsage } from "@q/qprovs";

import type { LoopRecordedEvent } from "../../loop/index.js";

export interface AgentRecordEvents {
  metadata: {
    protocol_version: string;
    created_at: number;
  };

  "turn.prompt": {
    input: readonly string[];
    origin: { kind: string };
  };
  "turn.steer": {
    input: readonly string[];
    origin: { kind: string };
  };
  "turn.cancel": { turnId?: number };

  "config.update": Record<string, unknown>;

  "permission.set_mode": {
    mode: string;
  };
  "permission.record_approval_result": Record<string, unknown>;

  "plan_mode.enter": {
    id: string;
  };
  "plan_mode.cancel": {
    id?: string;
  };
  "plan_mode.exit": {
    id?: string;
  };

  "tools.register_user_tool": {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  "tools.unregister_user_tool": {
    name: string;
  };
  "tools.set_active_tools": {
    names: readonly string[];
  };

  "background.stop": {
    taskId: string;
  };

  "usage.record": {
    model: string;
    usage: TokenUsage;
  };

  "context.append_message": { message: Record<string, unknown> };
  "context.append_loop_event": { event: LoopRecordedEvent };
  "context.clear": {};
  "context.apply_compaction": {
    summary: string;
    compactedCount: number;
    tokensAfter: number;
  };

  "tools.update_store": {
    key: string;
    value: unknown;
  };
}

export type AgentRecord = {
  [K in keyof AgentRecordEvents]: Readonly<AgentRecordEvents[K]> & {
    readonly type: K;
    readonly time?: number;
  };
}[keyof AgentRecordEvents];

export type AgentRecordOf<K extends keyof AgentRecordEvents> = Extract<
  AgentRecord,
  { readonly type: K }
>;

export interface AgentRecordPersistence {
  read(): AsyncIterable<AgentRecord>;
  append(input: AgentRecord): void;
  rewrite(records: readonly AgentRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
