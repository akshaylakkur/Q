/**
 * Skills — Built-in skill: init-project
 *
 * Embedded markdown content for scaffolding new Qode projects.
 */
import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

const PSEUDO_PATH = 'builtin://init-project';

const INIT_PROJECT_BODY = `---
name: init-project
description: Initialize a new Qode project in the current working directory.
type: inline
disable-model-invocation: false
arguments:
  - name: name
    description: Project name
    required: false
  - name: dir
    description: Target directory (defaults to current working directory)
    required: false
---

# Initialize a Qode Project

Scaffold a new Qode project in the specified directory (or current working directory). This creates the \`.q/\` directory structure including:

- \`.q/config.toml\` — Project-specific configuration
- \`.q/mcp.json\` — Empty MCP server configuration
- \`.q/skills/\` — Project skill directory
- \`.q/plugins/\` — Plugin directory

## How to use

1. Ask the user for the project name if not provided.
2. Determine the target directory from \`$1\` or \`\${dir}\` argument, defaulting to \`\${Q_CWD}\`.
3. Check if \`.q/\` already exists in the target — if so, warn and ask before overwriting.
4. Create the directory structure:
   - <dir>/.q/config.toml
   - <dir>/.q/mcp.json
   - <dir>/.q/skills/ (empty)
   - <dir>/.q/plugins/ (empty)
5. Write a default \`config.toml\` with basic provider setup.
6. Write an empty \`mcp.json\`: \`{ "mcpServers": {} }\`
7. Inform the user the project is ready.

Do NOT create a separate \`.gitignore\` or modify existing project files unless explicitly asked.
`;

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/init-project.md',
  skillDirName: 'init-project',
  source: 'builtin',
  text: INIT_PROJECT_BODY,
});

export const INIT_PROJECT_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
