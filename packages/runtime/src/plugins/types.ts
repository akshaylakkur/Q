/**
 * Plugin system type definitions.
 *
 * Defines the manifest schema (Zod), runtime plugin instances,
 * hook context types, and all supporting interfaces.
 */

import { z } from "zod/v4";
import { McpServerConfigSchema } from "../config/schema.js";

// =========================================================================
// ToolDefinition (for plugin-provided tools)
// =========================================================================

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(512),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// =========================================================================
// PluginManifest & schema
// =========================================================================

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ALLOWED_HOOKS = [
  'session:start', 'session:end',
  'tool:preUse', 'tool:postUse',
  'subagent:start', 'subagent:stop',
  'convergence:start', 'convergence:end',
  'verification:gateStart', 'verification:gateEnd',
  'memory:decisionRecorded',
] as const;

export const ALLOWED_HOOK_EVENTS: readonly string[] = ALLOWED_HOOKS;

export const PluginManifestSchema = z.object({
  name: z.string()
    .regex(KEBAB_CASE_RE, "Plugin name must be kebab-case (e.g. 'my-plugin')")
    .max(48, "Plugin name must be 48 characters or less"),
  version: z.string()
    .regex(SEMVER_RE, "Version must be semver format X.Y.Z"),
  description: z.string()
    .min(1, "Description is required")
    .max(240, "Description must be 240 characters or less"),
  type: z.enum(["skill", "mcp", "tool", "hook"]),
  entryPoint: z.string().min(1, "Entry point is required"),
  dependencies: z.array(z.string()).optional().default([]),
  skills: z.array(z.string()).optional().default([]),
  mcpServers: z.array(McpServerConfigSchema).optional().default([]),
  tools: z.array(ToolDefinitionSchema).optional().default([]),
  hooks: z.array(
    z.enum(ALLOWED_HOOKS)
  ).optional().default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// =========================================================================
// Plugin type — runtime representation
// =========================================================================

export type PluginType = PluginManifest["type"];

export type PluginStatusValue = "active" | "inactive" | "error";

export interface PluginInstance {
  /** The plugin's manifest (validated + stored). */
  readonly manifest: PluginManifest;
  /** Discovery source directory. */
  readonly pluginDir: string;
  /** Current lifecycle status. */
  status: PluginStatusValue;
  /** Error message when status is 'error'. */
  error?: string;
  /** The dynamically imported module, if activated. */
  module?: Record<string, unknown>;
  /** Number of registered tools. */
  toolCount: number;
  /** Number of skills contributed. */
  skillCount: number;
  /** Number of MCP servers contributed. */
  mcpServerCount: number;
  /** Names of MCP servers registered via this plugin (for cleanup). */
  mcpServerNames: string[];
}

export interface PluginStatus {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly type: PluginType;
  readonly status: PluginStatusValue;
  readonly toolCount: number;
  readonly skillCount: number;
  readonly mcpServerCount: number;
}

// =========================================================================
// Lifecycle hook context types
// =========================================================================

export type HookEvent =
  | 'session:start'
  | 'session:end'
  | 'tool:preUse'
  | 'tool:postUse'
  | 'subagent:start'
  | 'subagent:stop'
  | 'convergence:start'
  | 'convergence:end'
  | 'verification:gateStart'
  | 'verification:gateEnd'
  | 'memory:decisionRecorded';

interface ToolPreUseContext {
  readonly toolName: string;
  readonly args: unknown;
  readonly sessionId: string;
}

interface ToolPostUseContext {
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly sessionId: string;
}

interface SessionContext {
  readonly sessionId: string;
  readonly configPath?: string;
}

interface SubagentContext {
  readonly agentId: string;
  readonly profile: string;
  readonly task: string;
}

interface ConvergenceStartContext {
  readonly round: number;
}

interface ConvergenceEndContext {
  readonly round: number;
  readonly agentsCompleted: number;
  readonly conflicts: number;
  readonly resolutionStrategies: string[];
}

interface VerificationGateContext {
  readonly gateName: string;
}

interface VerificationGateEndContext {
  readonly gateName: string;
  readonly passed: boolean;
}

interface MemoryDecisionContext {
  readonly decision: unknown;
}

/** Maps each hook event to its context type. */
export interface HookContextMap {
  'session:start': SessionContext;
  'session:end': SessionContext;
  'tool:preUse': ToolPreUseContext;
  'tool:postUse': ToolPostUseContext;
  'subagent:start': SubagentContext;
  'subagent:stop': SubagentContext;
  'convergence:start': ConvergenceStartContext;
  'convergence:end': ConvergenceEndContext;
  'verification:gateStart': VerificationGateContext;
  'verification:gateEnd': VerificationGateEndContext;
  'memory:decisionRecorded': MemoryDecisionContext;
}

/** Return type for pre-use hooks — can block execution. */
export interface ToolPreUseResult {
  block: boolean;
  reason?: string;
}

/** Return type for post-use hooks — can transform results. */
export interface ToolPostUseResult {
  transformed: boolean;
  result: unknown;
}

/** Handler type for each event kind. */
export type HookHandler<E extends HookEvent> =
  E extends 'tool:preUse'
    ? (context: HookContextMap[E]) => ToolPreUseResult | undefined | Promise<ToolPreUseResult | undefined>
    : E extends 'tool:postUse'
      ? (context: HookContextMap[E]) => ToolPostUseResult | undefined | Promise<ToolPostUseResult | undefined>
      : (context: HookContextMap[E]) => void | Promise<void>;

// =========================================================================
// PluginContext — provided to activate/deactivate
// =========================================================================

export interface PluginContext {
  readonly skillRegistry: import("../skills/registry.js").SkillRegistry;
  readonly mcpManager: import("../mcp/manager.js").McpConnectionManager;
  readonly toolManager: import("@q/agent-core").ToolManager;
  readonly hookEngine: import("./lifecycle.js").PluginHookEngine;
  readonly logger: Console;
  readonly config: Record<string, unknown>;
}