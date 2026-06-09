/**
 * Agent profiles — YAML-based profile definitions
 */
export const DEFAULT_AGENT_PROFILES = {
  orchestrator: { name: "orchestrator", extends: undefined, tools: [] },
  rewriter: { name: "rewriter", extends: undefined, tools: [] },
  "test-gen": { name: "test-gen", extends: undefined, tools: [] },
  "doc-gen": { name: "doc-gen", extends: undefined, tools: [] },
  explore: { name: "explore", extends: undefined, tools: [] },
  plan: { name: "plan", extends: undefined, tools: [] },
  reviewer: { name: "reviewer", extends: undefined, tools: [] },
  validator: { name: "validator", extends: undefined, tools: [] },
  "deps-resolver": { name: "deps-resolver", extends: undefined, tools: [] },
  "security-auditor": { name: "security-auditor", extends: undefined, tools: [] },
  architect: { name: "architect", extends: undefined, tools: [] },
  researcher: { name: "researcher", extends: undefined, tools: [] },
} as const;

export type AgentProfileName = keyof typeof DEFAULT_AGENT_PROFILES;
