/**
 * q-remote agent-factory — creates a headless Agent wired with the runtime's
 * orchestrator/memory/tool subsystems, but with the RPC channel pointed at
 * the {@link EventBridge} so all events flow out as NDJSON.
 *
 * Unlike the local {@link createAgent} (which reads config from disk), this
 * variant takes a decrypted {@link CredentialPayload} directly.
 */

import { Agent, applyAgentProfile } from "@q/agent-core";
import { ProviderFactory, type ProviderConfig } from "@q/qprovs";
import { LocalQmain } from "@q/qmain";
import type { Qmain } from "@q/qmain";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { CredentialPayload } from "@qode-agent/protocol";
import type { EventBridge } from "./event-bridge.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HeadlessAgentOptions {
  workspace: string;
  credentials: CredentialPayload;
  eventBridge: EventBridge;
  /** Permission mode for the remote agent. Default "yolo" (autonomous). */
  permissionMode?: "manual" | "yolo" | "auto";
  /** Profile to apply (e.g. "auto"). Default "auto". */
  profile?: string;
  /** Session ID (for memory linking). */
  sessionId?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a headless Agent for remote execution.
 *
 * All agent events are routed through the EventBridge as NDJSON envelopes
 * with kind="agent".
 */
export function createHeadlessAgent(opts: HeadlessAgentOptions): Agent {
  const creds = opts.credentials;

  const qmain: Qmain = new LocalQmain(opts.workspace);

  const provider = ProviderFactory.create(
    creds.provider,
    creds.model,
    {
      type: creds.provider,
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
    },
  );

  const permissionMode = opts.permissionMode ?? "yolo";

  const providerConfig: ProviderConfig = {
    type: creds.provider,
    name: creds.provider,
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl,
    defaultModel: creds.model,
  };

  const agent = new Agent({
    runtime: { qmain },
    config: providerConfig,
    homedir: resolve(homedir(), ".Q"),
    type: "root",
    permission: { mode: permissionMode },
    rpc: {
      emitEvent: (event: unknown) => {
        // Route all agent events to the NDJSON bridge
        opts.eventBridge.emitAgentEvent(event);
      },
    },
  });

  agent.config.update({
    modelAlias: creds.model,
    thinkingLevel: creds.thinkingLevel ?? "medium",
  });

  agent.config.update({ cwd: opts.workspace });
  agent.tools.setShellCwd(opts.workspace);

  // Apply the requested profile
  const profile = opts.profile ?? "auto";
  try {
    applyAgentProfile(agent, profile, {
      cwd: opts.workspace,
      sessionId: opts.sessionId ?? "",
    });
  } catch (err) {
    // Non-fatal — fall back to default tools
    opts.eventBridge.emit("system", "warning", {
      message: `Failed to apply profile "${profile}": ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return agent;
}