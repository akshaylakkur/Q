/**
 * Skills — Built-in skills index
 *
 * Registers all built-in skills with the SkillRegistry.
 */
import type { SkillRegistry } from '../registry';
import { MCP_CONFIG_SKILL } from './mcp-config';
import { INIT_PROJECT_SKILL } from './init-project';

export function registerBuiltinSkills(registry: SkillRegistry): void {
  registry.registerBuiltinSkill(MCP_CONFIG_SKILL);
  registry.registerBuiltinSkill(INIT_PROJECT_SKILL);
}

export { MCP_CONFIG_SKILL, INIT_PROJECT_SKILL };
