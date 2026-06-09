/**
 * Agent barrel — re-exports all agent subsystems.
 */

export { Agent } from "./agent.js";
export type { AgentOptions, AgentConfig, RpcChannel, SubagentHost, SkillRegistry, McpConnectionManager, HookEngine, PermissionSettings, TelemetryClient, AgentType } from "./agent.js";

export { ConfigState } from "./config/index.js";
export type { AgentConfigData, AgentConfigUpdateData } from "./config/index.js";

export { ContextMemory } from "./context/index.js";
export { project, estimateTokenCount } from "./context/projector.js";
export type { ContextMessage, PromptOrigin, AgentContextData, UserPromptOrigin, InjectionOrigin, CompactionSummaryOrigin, BackgroundTaskOrigin } from "./context/types.js";
export { USER_PROMPT_ORIGIN } from "./context/types.js";

export { TurnFlow } from "./turn/index.js";
export { QprovsLLM } from "./turn/qprovs-llm.js";

export { ToolManager } from "./tool/index.js";
export { applyAgentProfile } from "./tool/apply-profile.js";
export type { ToolInfo, ToolSource, UserToolRegistration } from "./tool/index.js";

export { PermissionManager } from "./permission/index.js";
export type { PermissionMode, PermissionRule, PermissionData, PermissionRuleDecision, PermissionRuleScope } from "./permission/types.js";

export { PlanMode } from "./plan/index.js";
export type { PlanData } from "./plan/index.js";

export { UsageRecorder } from "./usage/index.js";
export type { UsageStatus, UsageRecordScope } from "./usage/index.js";

export { BackgroundManager } from "./background/index.js";
export type { BackgroundTaskInfo, BackgroundTaskStatus } from "./background/index.js";

export { AgentRecords, InMemoryAgentRecordPersistence, FileSystemAgentRecordPersistence, BlobStore, isBlobRef } from "./records/index.js";
export type { AgentRecord, AgentRecordPersistence, BlobStoreOptions } from "./records/index.js";

export { InjectionManager } from "./injection/index.js";

// Sub-agent system
export {
  SessionSubagentHost,
  DEFAULT_AGENT_PROFILES,
} from "./subagent.js";
export type {
  SubagentResult,
  ChildAgent,
  SpawnSubagentOptions,
  ResumeSubagentOptions,
} from "./subagent.js";

// Profiles
export {
  loadAllProfiles,
  resolveAgentProfile,
  resolveAgentProfiles,
  SystemPromptRenderer,
  renderTemplate,
} from "./profiles/loader.js";
export type {
  RawProfile,
  ResolvedProfile,
  RenderContext,
} from "./profiles/loader.js";
