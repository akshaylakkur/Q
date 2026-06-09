/**
 * Config — Zod schema definitions for Qode configuration.
 *
 * Defines the complete VConfig type and all sub-schemas for
 * validation of TOML-based configuration files.
 */
import { z } from "zod/v4";

// ─── Provider sub-schema ────────────────────────────────────────────────────

export const OAuthConfigSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  authorizeUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  redirectPort: z.number().int().positive().optional(),
});

export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

export const ProviderConfigSchema = z.object({
  type: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  oauth: OAuthConfigSchema.optional(),
  envOverrides: z.record(z.string(), z.string()).optional(),
  customHeaders: z.record(z.string(), z.string()).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ProvidersSchema = z.record(z.string(), ProviderConfigSchema);

// ─── Model alias sub-schema ─────────────────────────────────────────────────

export const ModelAliasSchema = z.object({
  provider: z.string(),
  name: z.string(),
  maxContextSize: z.number().int().positive().optional(),
  maxOutputSize: z.number().int().positive().optional(),
  capabilities: z.array(z.string()).optional(),
});

export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const ModelsSchema = z.record(z.string(), ModelAliasSchema);

// ─── Thinking sub-schema ────────────────────────────────────────────────────

export const ThinkingModeSchema = z.enum(["auto", "on", "off"]);

/** Inner (raw) schema — no .default() wrapping for empty objects. */
export const ThinkingConfigInnerSchema = z.object({
  mode: ThinkingModeSchema.default("auto"),
  effort: z.number().min(0).max(100).default(50),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigInnerSchema>;

// ─── Permission sub-schema ──────────────────────────────────────────────────

export const PermissionDecisionSchema = z.enum(["allow", "deny", "ask"]);

export const PermissionRuleSchema = z.object({
  pattern: z.string(),
  decision: PermissionDecisionSchema,
  scope: z.string().optional(),
  reason: z.string().optional(),
});

export const PermissionInnerSchema = z.object({
  rules: z.array(PermissionRuleSchema).default([]),
});

export type PermissionConfig = z.infer<typeof PermissionInnerSchema>;

// ─── Hooks sub-schema ───────────────────────────────────────────────────────

export const HookDefSchema = z.object({
  event: z.string(),
  command: z.string(),
  match: z.string().optional(),
  cwd: z.string().optional(),
});

export type HookDef = z.infer<typeof HookDefSchema>;

export const HooksSchema = z.array(HookDefSchema).default([]);

// ─── Services sub-schema ────────────────────────────────────────────────────

export const ServiceConfigSchema = z.object({
  provider: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
});

export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

export const ServicesInnerSchema = z.object({
  search: ServiceConfigSchema.optional(),
  fetch: ServiceConfigSchema.optional(),
});

export type ServicesConfig = z.infer<typeof ServicesInnerSchema>;

// ─── MCP Server sub-schema ───────────────────────────────────────────────────

const StringRecordSchema = z.record(z.string(), z.string());

const McpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: z.number().int().min(1).optional(),
  toolTimeoutMs: z.number().int().min(1).optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
} as const;

export const McpServerStdioConfigSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: StringRecordSchema.optional(),
  cwd: z.string().optional(),
  ...McpServerCommonFields,
});

export type McpServerStdioConfig = z.infer<typeof McpServerStdioConfigSchema>;

export const McpServerHttpConfigSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...McpServerCommonFields,
});

export type McpServerHttpConfig = z.infer<typeof McpServerHttpConfigSchema>;

const McpServerConfigDiscriminatedSchema = z.discriminatedUnion("transport", [
  McpServerStdioConfigSchema,
  McpServerHttpConfigSchema,
]);

export const McpServerConfigSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ("transport" in obj) return obj;
  if (typeof obj["command"] === "string") return { ...obj, transport: "stdio" };
  if (typeof obj["url"] === "string") return { ...obj, transport: "http" };
  return obj;
}, McpServerConfigDiscriminatedSchema);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ─── Orchestrator sub-schema ────────────────────────────────────────────────

export const DefaultExecutionModeSchema = z.enum([
  "auto",
  "lightweight",
  "speed_campaign",
  "medium_campaign",
  "high_campaign",
  "modus_maximus",
]);

export const OrchestratorInnerSchema = z.object({
  maxParallelAgents: z.number().int().positive().default(8),
  defaultMode: DefaultExecutionModeSchema.default("auto"),
  convergenceTimeout: z.number().int().positive().default(60000),
  taskTimeout: z.number().int().positive().default(300000),
});

export type OrchestratorConfig = z.infer<typeof OrchestratorInnerSchema>;

// ─── Memory sub-schema ──────────────────────────────────────────────────────

export const MemoryInnerSchema = z.object({
  episodicRecallMaxCount: z.number().int().positive().default(500),
  ltpmEnabled: z.boolean().default(true),
  compactionTriggerRatio: z.number().min(0).max(1).default(0.75),
  reservedContextSize: z.number().int().positive().default(4096),
});

export type MemoryConfig = z.infer<typeof MemoryInnerSchema>;

// ─── Loop Control sub-schema ────────────────────────────────────────────────

export const LoopControlInnerSchema = z.object({
  maxStepsPerTurn: z.number().int().positive().default(50),
  maxRetriesPerStep: z.number().int().min(0).default(3),
  compactionTriggerRatio: z.number().min(0).max(1).default(0.75),
});

export type LoopControlConfig = z.infer<typeof LoopControlInnerSchema>;

// ─── Background sub-schema ──────────────────────────────────────────────────

export const BackgroundInnerSchema = z.object({
  maxRunningTasks: z.number().int().positive().default(5),
  keepAliveOnExit: z.boolean().default(false),
  agentTaskTimeoutS: z.number().int().positive().default(900),
});

export type BackgroundConfig = z.infer<typeof BackgroundInnerSchema>;

// ─── Telemetry sub-schema ───────────────────────────────────────────────────

export const TelemetryInnerSchema = z.object({
  enabled: z.boolean().default(true),
  crashReporting: z.boolean().default(true),
});

export type TelemetryConfig = z.infer<typeof TelemetryInnerSchema>;

// ─── Display sub-schema ─────────────────────────────────────────────────────

export const DisplayInnerSchema = z.object({
  linkPreview: z.boolean().default(true),
  imagePreview: z.boolean().default(true),
  animations: z.boolean().default(true),
});

export type DisplayConfig = z.infer<typeof DisplayInnerSchema>;

// ─── Default permission mode ────────────────────────────────────────────────

export const DefaultPermissionModeSchema = z.enum(["accept", "reject", "ask"]);

// ─── Known field names to track for passthrough ─────────────────────────────

/** Known top-level keys in the VConfig schema. */
export const KNOWN_CONFIG_KEYS = new Set([
  "providers", "models", "thinking", "permission", "hooks", "services",
  "orchestrator", "memory", "loopControl", "background",
  "planMode", "defaultPermissionMode", "mergeAllAvailableSkills", "extraSkillDirs",
  "telemetry", "display", "raw",
]);

// ─── Nested object key → inner schema mapping ───────────────────────────────

const NESTED_INNER_SCHEMAS: Record<string, any> = {
  thinking: ThinkingConfigInnerSchema,
  permission: PermissionInnerSchema,
  services: ServicesInnerSchema,
  orchestrator: OrchestratorInnerSchema,
  memory: MemoryInnerSchema,
  loopControl: LoopControlInnerSchema,
  background: BackgroundInnerSchema,
  telemetry: TelemetryInnerSchema,
  display: DisplayInnerSchema,
};

// ─── Root VConfig schema ────────────────────────────────────────────────────

const VConfigInnerSchema = z.object({
  providers: ProvidersSchema.default({}),
  models: ModelsSchema.default({}),

  thinking: ThinkingConfigInnerSchema.default({
    mode: "auto" as const,
    effort: 50,
  }),

  permission: PermissionInnerSchema.default({ rules: [] }),
  hooks: HooksSchema,

  services: ServicesInnerSchema.default({}),

  orchestrator: OrchestratorInnerSchema.default({
    maxParallelAgents: 8,
    defaultMode: "auto" as const,
    convergenceTimeout: 60000,
    taskTimeout: 300000,
  }),

  memory: MemoryInnerSchema.default({
    episodicRecallMaxCount: 500,
    ltpmEnabled: true,
    compactionTriggerRatio: 0.75,
    reservedContextSize: 4096,
  }),

  loopControl: LoopControlInnerSchema.default({
    maxStepsPerTurn: 50,
    maxRetriesPerStep: 3,
    compactionTriggerRatio: 0.75,
  }),

  background: BackgroundInnerSchema.default({
    maxRunningTasks: 5,
    keepAliveOnExit: false,
    agentTaskTimeoutS: 900,
  }),

  planMode: z.boolean().default(false),
  defaultPermissionMode: DefaultPermissionModeSchema.default("ask"),
  mergeAllAvailableSkills: z.boolean().default(false),
  extraSkillDirs: z.array(z.string()).default([]),

  telemetry: TelemetryInnerSchema.default({
    enabled: true,
    crashReporting: true,
  }),

  display: DisplayInnerSchema.default({
    linkPreview: true,
    imagePreview: true,
    animations: true,
  }),

  /** Catch-all for unknown keys. */
  raw: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Parse and validate a VConfig from a raw object.
 * Unknown keys are extracted into the `.raw` field.
 *
 * This function also applies deep defaults: Zod v4's .default({})
 * only fires when the input is undefined, but when a TOML file has
 * `[thinking]` with no sub-keys, the parsed value is `{}`, not undefined.
 * We handle this by pre-processing the input for known nested object keys.
 *
 * Additionally, `null` values for nested objects are converted to defaults
 * (Zod's .default({}) does NOT handle null, only undefined).
 */
export function parseVConfig(input: Record<string, unknown>): VConfig {
  // Pre-process to expand nested empty/null objects to defaults
  const expanded = expandNestedDefaults(input);

  // Extract known vs unknown keys
  const knownInput: Record<string, unknown> = {};
  const rawInput: Record<string, unknown> = {};

  for (const key of Object.keys(expanded)) {
    if (KNOWN_CONFIG_KEYS.has(key)) {
      knownInput[key] = expanded[key];
    } else {
      rawInput[key] = expanded[key];
    }
  }

  // Parse known keys
  const result = VConfigInnerSchema.parse(knownInput) as VConfigRaw;

  // Add unknown keys as raw
  result.raw = { ...(result.raw ?? {}), ...rawInput };

  return result as unknown as VConfig;
}

/**
 * Expand empty or null nested objects to their default values.
 * Iterates known object keys and replaces `{}` or `null` with a parsed default.
 */
function expandNestedDefaults(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...input };

  for (const [key, schema] of Object.entries(NESTED_INNER_SCHEMAS)) {
    const val = result[key];
    if (val === undefined) {
      // Let Zod defaults handle undefined (it fires .default({}))
      continue;
    }
    if (val === null) {
      // Zod .default({}) does NOT fire for null, so expand to defaults
      result[key] = schema.parse({});
      continue;
    }
    if (typeof val === "object" && !Array.isArray(val) && Object.keys(val as Record<string, unknown>).length === 0) {
      // Empty object — expand to defaults
      result[key] = schema.parse({});
    }
  }

  return result;
}

/**
 * Safe-parse a VConfig from a raw object.
 * On failure, returns defaults.
 */
export function safeParseVConfig(
  input: Record<string, unknown>,
): { success: true; data: VConfig } | { success: false; error: Error } {
  try {
    const data = parseVConfig(input);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Raw type from the inner schema
type VConfigRaw = z.infer<typeof VConfigInnerSchema>;

export type VConfig = VConfigRaw & { raw: Record<string, unknown> };

/**
 * Config source tiers in precedence order (higher = higher priority).
 */
export enum ConfigTier {
  Defaults = 0,
  User = 1,
  Project = 2,
  Session = 3,
}

export interface ConfigSource {
  tier: ConfigTier;
  label: string;
  filePath?: string;
  raw: Record<string, unknown>;
}
