/**
 * Agent Wiring — Bridges the orchestrator / TUI to the real agent-core engine.
 *
 * Creates a fully functional Agent with LLM provider, Qmain runtime,
 * and all tool connectors wired in.
 */

import { Agent, applyAgentProfile } from "@q/agent-core";
import { ProviderFactory } from "@q/qprovs";
import type { ProviderConfig } from "@q/qprovs";
import { LocalQmain } from "@q/qmain";
import type { Qmain } from "@q/qmain";
import { readFileSync, accessSync, constants } from "node:fs";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedProviderConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  thinkingLevel?: "none" | "low" | "medium" | "high";
}

export interface AgentWiringOptions {
  workDir: string;
  resolvedProvider?: ResolvedProviderConfig;
  yolo?: boolean;
  auto?: boolean;
}

// ---------------------------------------------------------------------------
// Provider Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve provider config from multiple sources (env, config files).
 * Priority: 1) env vars, 2) .q/config.toml, 3) $HOME/.Q/config.toml
 */
export function resolveProviderConfig(workDir: string): ResolvedProviderConfig | null {
  // 1. Environment variables (highest priority)
  const envProvider = process.env.Q_PROVIDER;
  const envModel = process.env.Q_MODEL;
  const envApiKey = process.env.Q_API_KEY;
  if (envProvider && envModel && (envApiKey || envProvider === "ollama")) {
    return {
      provider: envProvider,
      model: envModel,
      apiKey: envApiKey ?? "",
      baseUrl: process.env.Q_BASE_URL,
      thinkingLevel: (process.env.Q_THINKING as any) ?? "medium",
    };
  }

  // 2. Project-level config: walk up from workDir to find the nearest .q/config.toml
  let current = resolve(workDir);
  while (true) {
    const configPath = resolve(current, ".q", "config.toml");
    try {
      accessSync(configPath, constants.R_OK);
      const cfg = readConfigToml(configPath);
      if (cfg?.provider && cfg?.model && (cfg?.apiKey || cfg?.provider === "ollama")) {
        return cfg;
      }
    } catch {
      // No config here
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // 3. User-global config: $HOME/.Q/config.toml
  const globalConfigPath = resolve(homedir(), ".Q", "config.toml");
  if (existsSync(globalConfigPath)) {
    const cfg = readConfigToml(globalConfigPath);
    if (cfg?.provider && cfg?.model && (cfg?.apiKey || cfg?.provider === "ollama")) {
      return cfg;
    }
  }

  return null;
}

function readConfigToml(path: string): ResolvedProviderConfig | null {
  try {
    const content = readFileSync(path, "utf-8");
    const provider = extractTomlValue(content, "provider");
    const model = extractTomlValue(content, "model");
    const apiKey = extractTomlValue(content, "api_key") || extractTomlValue(content, "apiKey");
    const baseUrl = extractTomlValue(content, "base_url") || extractTomlValue(content, "baseUrl");
    const thinking = extractTomlValue(content, "thinking") as any;

    if (provider && model && (apiKey || provider === "ollama")) {
      return {
        provider,
        model,
        apiKey: apiKey ?? "",
        baseUrl: baseUrl ?? undefined,
        thinkingLevel: thinking ?? "medium",
      };
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function extractTomlValue(content: string, key: string): string | null {
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m");
  const m = regex.exec(content);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Agent Factory
// ---------------------------------------------------------------------------

/**
 * Create a real Agent with LLM provider and Qmain runtime.
 */
export function createAgent(opts: AgentWiringOptions): Agent | null {
  const providerCfg = opts.resolvedProvider ?? resolveProviderConfig(opts.workDir);
  if (!providerCfg) {
    return null;
  }

  const qmain: Qmain = new LocalQmain(opts.workDir);

  const qprovsProvider = ProviderFactory.create(
    providerCfg.provider,
    providerCfg.model,
    {
      type: providerCfg.provider,
      apiKey: providerCfg.apiKey,
      baseUrl: providerCfg.baseUrl,
    },
  );

  const permissionMode: "manual" | "yolo" | "auto" = opts.yolo
    ? "yolo"
    : opts.auto
      ? "auto"
      : "manual";

  const providerConfig: ProviderConfig = {
    type: providerCfg.provider,
    name: providerCfg.provider,
    apiKey: providerCfg.apiKey,
    baseUrl: providerCfg.baseUrl,
    defaultModel: providerCfg.model,
  };

  const agent = new Agent({
    runtime: { qmain: qmain },
    config: providerConfig,
    homedir: resolve(homedir(), ".Q"),
    type: "root",
    permission: { mode: permissionMode },
    rpc: {
      emitEvent: (_event) => {
        // Events flow through orchestrator.onEvent → TUI
      },
    },
  });

  agent.config.update({
    modelAlias: providerCfg.model,
    thinkingLevel: providerCfg.thinkingLevel,
  });

  agent.config.update({ cwd: opts.workDir });
  agent.tools.setShellCwd(opts.workDir);

  try {
    applyAgentProfile(agent, "auto", {
      cwd: opts.workDir,
      sessionId: "",
    });
  } catch (err) {
    console.error("[wiring] Failed to apply default profile:", err);
  }

  return agent;
}

/**
 * Run a single turn with the agent and return the assistant's response text.
 */
export async function runAgentTurn(
  agent: Agent,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ output: string; toolCalls: number; durationMs: number; error?: string }> {
  const startedAt = Date.now();
  try {
    const turnId = agent.turn.prompt(prompt);
    if (turnId === null) {
      return { output: "", toolCalls: 0, durationMs: 0, error: "Could not launch turn (another turn is active)" };
    }
    await agent.turn.waitForCurrentTurn(signal);
    const messages = agent.context.messages;
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const output = lastAssistant?.content ?? "(no assistant response)";
    return {
      output,
      toolCalls: 0,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: "", toolCalls: 0, durationMs: Date.now() - startedAt, error: msg };
  }
}