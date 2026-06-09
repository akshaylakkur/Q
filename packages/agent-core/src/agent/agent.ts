/**
 * The core Agent class — primary runtime object managing
 * context, tools, permissions, sub-agents, and the turn loop.
 */

import { randomUUID } from "node:crypto";

import type { ProviderConfig } from "@q/qprovs";

import type { Qmain } from "@q/qmain";
import { ConfigState } from "./config/index.js";
import { ContextMemory } from "./context/index.js";
import { TurnFlow } from "./turn/index.js";
import { QprovsLLM } from "./turn/qprovs-llm.js";
import { ToolManager } from "./tool/index.js";
import { PermissionManager } from "./permission/index.js";
import { PlanMode } from "./plan/index.js";
import { UsageRecorder } from "./usage/index.js";
import { BackgroundManager } from "./background/index.js";
import { AgentRecords, InMemoryAgentRecordPersistence } from "./records/index.js";
import { BlobStore } from "./records/blobref.js";
import { InjectionManager } from "./injection/index.js";

export type AgentType = "root" | "sub";

export interface RpcChannel {
  emitEvent?(event: unknown): void;
}

export interface SubagentHost {
  spawnSubagent?(prompt: string, config?: { description?: string; profileName?: string; signal?: AbortSignal }): Promise<{ id: string; result?: string }>;
  cancelAll?(): void;
  cancel?(agentId: string): void;
}

export interface SkillRegistry {
  listSkills?(): string[];
  findSkill?(name: string): unknown;
}

export interface McpConnectionManager {
  listServers(): string[];
}

export interface HookEngine {
  fire?(event: string, data: unknown): Promise<void>;
}

export interface PermissionSettings {
  mode?: "manual" | "yolo" | "auto";
}

export interface TelemetryClient {
  readonly enabled: boolean;
  track?(event: string, properties?: Record<string, unknown>): void;
}

export interface AgentOptions {
  runtime: { qmain: Qmain };
  config: ProviderConfig;
  homedir: string;
  type?: AgentType;
  rpc?: RpcChannel;
  subagentHost?: SubagentHost;
  skills?: SkillRegistry;
  mcp?: McpConnectionManager;
  hooks?: HookEngine;
  permission?: PermissionSettings;
  telemetry?: TelemetryClient;
}

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  cwd: string;
  thinkingLevel: "none" | "low" | "medium" | "high";
}

export class Agent {
  readonly id: string;
  readonly type: AgentType;

  readonly context: ContextMemory;
  readonly config: ConfigState;
  readonly turn: TurnFlow;
  readonly toolManager: ToolManager;
  readonly permissionManager: PermissionManager;
  readonly planMode: PlanMode;
  readonly usageRecorder: UsageRecorder;
  readonly backgroundManager: BackgroundManager;
  readonly records: AgentRecords;
  readonly blobStore: BlobStore | undefined;
  readonly injection: InjectionManager;

  readonly runtime: { qmain: Qmain };
  readonly configData: ProviderConfig;
  readonly homedir: string;
  readonly rpc: RpcChannel;
  readonly subagentHost: SubagentHost;
  readonly skills: SkillRegistry;
  readonly mcp: McpConnectionManager;
  readonly hooks: HookEngine;
  readonly telemetry: TelemetryClient;

  constructor(opts: AgentOptions) {
    this.id = randomUUID();
    this.type = opts.type ?? "root";

    this.runtime = opts.runtime;
    this.configData = opts.config;
    this.homedir = opts.homedir;
    this.rpc = opts.rpc ?? {};
    this.subagentHost = opts.subagentHost ?? {};
    this.skills = opts.skills ?? {};
    this.mcp = opts.mcp ?? { listServers: () => [] };
    this.hooks = opts.hooks ?? {};
    this.telemetry = opts.telemetry ?? { enabled: false };

    this.blobStore = new BlobStore({ blobsDir: this.homedir + "/blobs" });
    this.records = new AgentRecords(this, new InMemoryAgentRecordPersistence());
    this.config = new ConfigState(this);
    this.context = new ContextMemory(this);
    this.injection = new InjectionManager(this);
    this.permissionManager = new PermissionManager(this);
    this.planMode = new PlanMode(this);
    this.usageRecorder = new UsageRecorder(this);
    this.backgroundManager = new BackgroundManager(this);
    this.toolManager = new ToolManager(this);
    this.turn = new TurnFlow(this);

    if (opts.config) {
      this.config.setProviderConfig(opts.config);
    }
  }

  /** Get a QprovsLLM instance configured from current config state */
  get llm(): QprovsLLM {
    const cfg = this.config;
    return new QprovsLLM({
      provider: cfg.provider,
      modelName: cfg.model,
      systemPrompt: cfg.systemPrompt,
    });
  }

  emitEvent(_event: unknown): void {
    if (this.rpc?.emitEvent) {
      this.rpc.emitEvent(_event);
    }
  }

  /**
   * Replace the RPC channel after construction.
   * Used by the orchestrator to inject the real event bridge
   * after the Agent is created (since Agent is created before
   * the orchestrator in the startup sequence).
   */
  setRpcChannel(channel: RpcChannel): void {
    (this as { rpc: RpcChannel }).rpc = channel;
  }

  emitStatusUpdated(): void {
    this.emitEvent({
      type: "agent.status.updated",
      config: this.config.data(),
    });
  }

  get tools(): ToolManager {
    return this.toolManager;
  }

  get permission(): PermissionManager {
    return this.permissionManager;
  }

  get usage(): UsageRecorder {
    return this.usageRecorder;
  }

  get background(): BackgroundManager {
    return this.backgroundManager;
  }

  /**
   * Replay a single recorded event to restore agent state.
   * Accepts an AgentRecord-like object (may come from a serialized
   * SessionRecord that was converted to AgentRecord shape).
   *
   * Used by q-cli's replaySession() to reconstruct agent state
   * from exported session wire files.
   */
  replayRecord(record: Record<string, unknown>): void {
    this.records.restore(record as never);
  }
}