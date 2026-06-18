/**
 * Skills — Built-in skill: mcp-config
 *
 * Embedded markdown content for MCP server configuration guidance.
 */
import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

const PSEUDO_PATH = 'builtin://mcp-config';

const MCP_CONFIG_BODY = `---
name: mcp-config
description: Configure MCP servers and handle MCP OAuth login.
type: inline
disable-model-invocation: true
arguments:
  - name: action
    description: The action to perform (login, list, add, edit, remove)
    required: false
  - name: server
    description: The MCP server name
    required: false
---

# Interactive MCP Server Configuration

The user invoked this skill. Either they want to log into an MCP server that asked for OAuth, or they want to edit the \`mcp.json\` that lists MCP servers. The work is small and local — handle it on this turn yourself, no agents or planning todos.

Pick the flow from the user's message and your tool list:

- An \`mcp__<server>__authenticate\` tool is in your list, the user says "log in" / "auth" / "sign in", they invoke this with \`login <server>\`, or they quote a \`needs-auth\` status → **Login**.
- Add / edit / remove / list of an \`mcp.json\` entry → **Config edit**.
- Bare invocation with no \`authenticate\` tool in your list → **Config edit**. If there were a pending login, the authenticate tool would be in your list.

## Login

Each MCP server in \`needs-auth\` exposes one \`mcp__<server>__authenticate\` tool. Call it for the server the user means — its own description owns the OAuth UX (printing the URL, blocking on the callback, reconnecting on success). Surface its output verbatim, including the authorization URL unchanged; the URL contains state and PKCE parameters that break if edited.

If the user named a server that has no authenticate tool, say so in one sentence and stop — do **not** fall into config edit. They're trying to log in to a server that isn't currently waiting for login; quietly rewriting \`mcp.json\` would be the wrong fix. If multiple authenticate tools exist and the user didn't name one, ask which.

## Config Edit

Config lives in two files; on key collision the project file overrides the user-global one:

- **User-global**: \`~/.Q/mcp.json\`. Use for servers you want everywhere.
- **Project-local**: \`<cwd>/.q/mcp.json\`. Mention once that stdio entries spawn commands at session start, so this should only live in trusted repos.

Both files wrap their entries the same way:

\`\`\`json
{ "mcpServers": { "<name>": { /* entry */ } } }
\`\`\`

A minimal stdio entry needs \`command\` (+ optional \`args\`, \`env\`, \`cwd\`). A minimal http entry needs \`url\`; add \`bearerTokenEnvVar: "ENV_NAME"\` for servers that authenticate with a static bearer token from the environment. Servers that use OAuth take no token field — the login flow above handles them. \`transport\` is inferred from \`command\` vs \`url\`, so omit it. For less common fields (\`enabled\`, \`startupTimeoutMs\`, \`toolTimeoutMs\`, \`enabledTools\`, \`disabledTools\`, \`headers\`) the source of truth is \`McpServerStdioConfigSchema\` / \`McpServerHttpConfigSchema\` in the config schema.

If the user only wants to **see** what's configured, read both files, show a merged view, and stop — no scope prompt, no write.

For changes, the flow is:

1. **Pick a scope.** Infer it from the user's words when you can (project / repo / this checkout / cwd → project; global / everywhere / all projects → user-global). When the request is genuinely scope-less, ask user-global vs project-local, defaulting to user-global. If the user dismisses the scope question, stop; you can't safely guess where they wanted the change.
2. **Read and announce.** Read the target file (a missing or empty file is fine; you'll create \`{ "mcpServers": {} }\`). If JSON parsing fails, surface the error verbatim and stop — silently overwriting a broken file could destroy work. Then show the user the target path, what's currently in it, and the entry you're about to write or delete.
3. **Write and tell them how to reload MCP servers.** Preserve unrelated entries and the \`mcpServers\` wrapper. MCP servers load at session start, so tell the user to start a new session or restart \`q-cli\` for the change to take effect.

## Secrets

Don't store secrets (tokens, keys, passwords) as literals in \`mcp.json\` — it's a plain config file on disk. http servers should use \`bearerTokenEnvVar\` to reference an env var instead; if a stdio entry must inline one in \`env\`, warn the user before writing.
`;

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/mcp-config.md',
  skillDirName: 'mcp-config',
  source: 'builtin',
  text: MCP_CONFIG_BODY,
});

export const MCP_CONFIG_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
    disableModelInvocation: true,
  },
};
