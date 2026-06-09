/**
 * applyAgentProfile — Load a YAML profile and apply it to the agent.
 *
 * Renders the profile's system prompt template with agent context
 * (cwd, model, session id, etc.), stores it on `agent.config`, and
 * activates the profile's tool list on `agent.tools`.
 *
 * This is the single entry point that wires a profile's "what tools are
 * available" and "what should the system prompt say" into a real Agent.
 */

import {
  loadAllProfiles,
  resolveAgentProfile,
  SystemPromptRenderer,
} from "../profiles/index.js";
import type { Agent } from "../agent.js";

/**
 * Apply a named profile to the agent.
 *
 * @param agent        The agent to configure.
 * @param profileName  Name of the profile (e.g. "rewriter", "explore", "plan").
 * @param context      Optional overrides for prompt template variables.
 * @returns            The rendered system prompt (also stored on the agent).
 * @throws             If the profile is not found.
 */
export function applyAgentProfile(
  agent: Agent,
  profileName: string,
  context?: { sessionId?: string; skillListing?: string; [key: string]: string | undefined },
): string {
  const profileMap = loadAllProfiles();
  const profile = resolveAgentProfile(profileName, profileMap);
  if (!profile) {
    const available = Object.keys(profileMap).sort().join(", ");
    throw new Error(
      `Unknown agent profile: "${profileName}". Available: ${available || "(none)"}`,
    );
  }

  const toolDescriptions = buildToolDescriptions(agent, profile.tools);
  const renderer = new SystemPromptRenderer(profile);
  const renderContext = {
    cwd: agent.config.cwd,
    model: safeModel(agent),
    sessionId: context?.sessionId ?? "",
    profileName,
    toolDescriptions,
    skillListing: context?.skillListing ?? "",
  };
  const systemPrompt = renderer.render(renderContext);

  agent.config.update({ systemPrompt, profileName });
  agent.tools.setActiveTools(profile.tools);

  return systemPrompt;
}

/** Build a markdown list of tool descriptions for the active tool set. */
function buildToolDescriptions(agent: Agent, toolNames: readonly string[]): string {
  const infos = new Map<string, { name: string; description: string }>();
  for (const info of agent.tools.toolInfos()) {
    infos.set(info.name, { name: info.name, description: info.description });
  }
  const lines: string[] = [];
  for (const name of toolNames) {
    const info = infos.get(name);
    if (!info) {
      lines.push(`- ${name}: (description unavailable)`);
    } else {
      lines.push(`- ${info.name}: ${info.description}`);
    }
  }
  return lines.join("\n");
}

/** Best-effort fetch of the model name without throwing. */
function safeModel(agent: Agent): string {
  try {
    return agent.config.model;
  } catch {
    return "unknown";
  }
}
