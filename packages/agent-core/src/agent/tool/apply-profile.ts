/**
 * applyAgentProfile — Load a YAML profile and apply it to the agent.
 *
 * Renders the profile's system prompt template with agent context
 * (cwd, model, session id, etc.), stores it on `agent.config`, and
 * activates the profile's tool list on `agent.tools`.
 *
 * Also checks for a `Q.md` or `AGENTS.md` file in the working directory
 * and appends its content as a project-level system reminder, so that
 * project-specific conventions and guidelines are always available to
 * the agent.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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
 * @param profileName  Name of the profile (e.g. "auto", "editius", "rewritius", "searchius").
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
  let systemPrompt = renderer.render(renderContext);

  // ── Inject Q.md / AGENTS.md content if present ────────────────────
  const projectRules = loadProjectRules(agent.config.cwd);
  if (projectRules) {
    systemPrompt += `\n\n# ── PROJECT RULES (from ${projectRules.source}) ──────────────────────\n${projectRules.content}\n`;
  }

  agent.config.update({ systemPrompt, profileName });
  agent.tools.setActiveTools(profile.tools);

  return systemPrompt;
}

/**
 * Load project-level rules from Q.md or AGENTS.md in the given directory.
 * Returns the content and source filename, or null if neither file exists.
 */
function loadProjectRules(
  cwd: string,
): { source: string; content: string } | null {
  for (const filename of ["Q.md", "AGENTS.md"]) {
    const filePath = resolve(cwd, filename);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8").trim();
        if (content) {
          return { source: filename, content };
        }
      } catch {
        // Ignore read errors — file might be locked or unreadable
      }
    }
  }
  return null;
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
