/**
 * Plugins — Plugin system
 *
 * Discovery, manifest validation, lifecycle hooks, MCP integration.
 */

export { PluginManager } from "./plugin-manager.js";
export { PluginValidator } from "./validator.js";
export { PluginHookEngine } from "./lifecycle.js";
export {
  PluginManifestSchema,
  ToolDefinitionSchema,
  ALLOWED_HOOK_EVENTS,
  type PluginManifest,
  type PluginInstance,
  type PluginStatus,
  type PluginStatusValue,
  type PluginType,
  type PluginContext,
  type HookEvent,
  type HookContextMap,
  type ToolDefinition,
  type ToolPreUseResult,
  type ToolPostUseResult,
} from "./types.js";