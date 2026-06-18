/**
 * Skills — Core type definitions
 *
 * SkillDefinition, metadata, sources, helpers, and activation tracking.
 */

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin' | 'plugin';

export type SkillType = 'prompt' | 'inline' | 'flow';

export interface SkillArgument {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

export interface SkillMetadata {
  readonly name?: string;
  readonly description?: string;
  readonly type?: SkillType;
  readonly whenToUse?: string;
  readonly disableModelInvocation?: boolean;
  readonly arguments?: readonly SkillArgument[] | string;
  readonly safe?: boolean;
  readonly [key: string]: unknown;
}

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly dir: string;
  readonly content: string;
  readonly metadata: SkillMetadata;
  readonly source: SkillSource;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: SkillSource;
  readonly type?: SkillType;
  readonly disableModelInvocation?: boolean;
}

export interface SkillRoot {
  readonly path: string;
  readonly source: SkillSource;
}

export interface SkippedSkill {
  readonly path: string;
  readonly type: string;
  readonly reason: string;
}

export interface SkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly args: string;
  readonly trigger: 'tool' | 'slash-command' | 'auto';
}

export interface SkillCatalog {
  getSkill(name: string): SkillDefinition | undefined;
  listSkills(): readonly SkillDefinition[];
  listInvocableSkills(): readonly SkillDefinition[];
}

/**
 * Normalize a skill name for case-insensitive deduplication.
 */
export function normalizeSkillName(name: string): string {
  return name.toLowerCase();
}

/**
 * Check if a skill type is inline (i.e., content is injected as instructions).
 * prompt and inline types are injected; flow types may be handled differently.
 */
export function isInlineSkillType(type: string | undefined): boolean {
  return type === undefined || type === 'prompt' || type === 'inline';
}

/**
 * Check if a skill type is user-activatable.
 */
export function isUserActivatableSkillType(type: string | undefined): boolean {
  return isInlineSkillType(type) || type === 'flow';
}

/**
 * Check if a skill type is supported.
 */
export function isSupportedSkillType(type: string | undefined): boolean {
  return isUserActivatableSkillType(type);
}

/**
 * Summarize a skill for listing purposes.
 */
export function summarizeSkill(skill: SkillDefinition): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    source: skill.source,
    type: skill.metadata.type,
    disableModelInvocation: skill.metadata.disableModelInvocation,
  };
}
