/**
 * Agent profiles — YAML-based profile definitions
 *
 * These are the user-facing agent profiles that can be selected via /agent.
 * Each profile has a corresponding YAML file in packages/agent-core/src/agent/profiles/
 * that defines the system prompt template and tool set.
 *
 * Available profiles:
 *   - auto:      Default general-purpose agent (all tools)
 *   - editius:   Code editing agent (StrReplace specialist)
 *   - rewritius: Code rewriting agent (Write specialist)
 *   - searchius: Codebase search agent (Read/Glob/Grep specialist)
 */
export const DEFAULT_AGENT_PROFILES = {
  auto: { name: "auto", extends: undefined, tools: [] },
  editius: { name: "editius", extends: undefined, tools: [] },
  rewritius: { name: "rewritius", extends: undefined, tools: [] },
  searchius: { name: "searchius", extends: undefined, tools: [] },
} as const;

export type AgentProfileName = keyof typeof DEFAULT_AGENT_PROFILES;
