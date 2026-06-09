/**
 * ConfigState — Manages the agent's current configuration state.
 * Model, system prompt, CWD, thinking level, and profile name.
 */

import type { ModelCapability, ChatProvider, ProviderConfig } from "@q/qprovs";
import { ProviderFactory } from "@q/qprovs";

import type { Agent } from "../agent.js";

export interface AgentConfigData {
  cwd: string;
  modelAlias?: string;
  provider?: ProviderConfig;
  modelCapabilities: ModelCapability;
  profileName?: string;
  thinkingLevel: string;
  systemPrompt: string;
}

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
}>;

const DEFAULT_CAPABILITY: ModelCapability = {
  maxContextSize: 128_000,
  maxOutputSize: 4_096,
  supportsThinking: false,
  supportsStreaming: true,
  supportsToolUse: true,
  supportsMedia: false,
  supportsStructuredOutput: false,
  supportsParallelToolCalls: true,
};

export function resolveThinkingLevel(requested: string | undefined): string {
  if (!requested || requested.trim().length === 0) return "off";
  const normalized = requested.trim().toLowerCase();
  if (normalized === "off" || normalized === "none") return "off";
  if (normalized === "on") return "high";
  if (["low", "medium", "high"].includes(normalized)) return normalized;
  return "high";
}

export class ConfigState {
  private _cwd: string;
  private _modelAlias: string | undefined;
  private _profileName: string | undefined;
  private _thinkingLevel: string = "off";
  private _systemPrompt: string = "";
  private _providerConfig: ProviderConfig | undefined;
  private _modelCapabilities: ModelCapability = DEFAULT_CAPABILITY;

  constructor(protected readonly agent: Agent) {
    this._cwd = process.cwd();
  }

  update(changed: AgentConfigUpdateData): void {
    if (Object.keys(changed).length === 0) return;

    if (changed.cwd !== undefined) {
      this._cwd = changed.cwd;
    }
    if (changed.modelAlias !== undefined) {
      this._modelAlias = changed.modelAlias;
    }
    if (changed.profileName !== undefined) {
      this._profileName = changed.profileName;
    }
    if (changed.thinkingLevel !== undefined) {
      this._thinkingLevel = resolveThinkingLevel(changed.thinkingLevel);
    }
    if (changed.systemPrompt !== undefined) {
      this._systemPrompt = changed.systemPrompt;
    }
    this.agent.emitStatusUpdated();
  }

  setProviderConfig(config: ProviderConfig): void {
    this._providerConfig = config;
  }

  setModelCapabilities(caps: ModelCapability): void {
    this._modelCapabilities = caps;
  }

  data(): AgentConfigData {
    return {
      cwd: this.cwd,
      provider: this._providerConfig,
      modelAlias: this._modelAlias,
      modelCapabilities: this._modelCapabilities,
      profileName: this.profileName,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.systemPrompt,
    };
  }

  get cwd(): string {
    return this._cwd;
  }

  get hasModel(): boolean {
    return this._modelAlias !== undefined;
  }

  get hasProvider(): boolean {
    return this._providerConfig !== undefined;
  }

  get provider(): ChatProvider {
    if (!this._providerConfig || !this._modelAlias) {
      throw new Error("Provider or model not configured");
    }
    return ProviderFactory.create(
      this._providerConfig.type,
      this._modelAlias,
      this._providerConfig,
    );
  }

  get model(): string {
    if (!this._modelAlias) {
      throw new Error("Model not configured");
    }
    return this._modelAlias;
  }

  get modelAlias(): string | undefined {
    return this._modelAlias;
  }

  get thinkingLevel(): string {
    return this._thinkingLevel;
  }

  get profileName(): string | undefined {
    return this._profileName;
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get modelCapabilities(): ModelCapability {
    return this._modelCapabilities;
  }
}
