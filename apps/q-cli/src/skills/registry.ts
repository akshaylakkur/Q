/**
 * Skills — Registry
 *
 * SkillRegistry manages discovered skills with methods for loading,
 * querying, rendering, and activation tracking.
 */
import { expandSkillParameters, skillArgumentNames } from './parser';
import { discoverSkills, type DiscoverSkillsOptions } from './scanner';
import type { SkillActivation, SkillDefinition, SkillRoot, SkillSource, SkippedSkill } from './types';
import { isInlineSkillType, normalizeSkillName } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const LISTING_DESC_MAX = 250;

// ─── Error Classes ────────────────────────────────────────────────────────────

export class SkillNotFoundError extends Error {
  readonly skillName: string;

  constructor(skillName: string) {
    super(`Skill "${skillName}" is not registered`);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}

// ─── Registry Options ─────────────────────────────────────────────────────────

export interface SkillRegistryOptions {
  readonly discover?: typeof discoverSkills;
  readonly onWarning?: (message: string, cause?: unknown) => void;
  readonly sessionId?: string;
  readonly cwd?: string;
}

// ─── SkillRegistry ───────────────────────────────────────────────────────────

export class SkillRegistry {
  private readonly byName = new Map<string, SkillDefinition>();
  private readonly roots: string[] = [];
  private readonly skipped: SkippedSkill[] = [];
  private readonly discoverImpl: typeof discoverSkills;
  private readonly onWarning: (message: string, cause?: unknown) => void;
  readonly sessionId?: string;
  readonly cwd?: string;

  /** Ordered array of skill activations for this session */
  private activations: SkillActivation[] = [];
  private activationCounter = 0;

  constructor(options: SkillRegistryOptions = {}) {
    this.discoverImpl = options.discover ?? discoverSkills;
    this.onWarning = options.onWarning ?? (() => {});
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  /**
   * Load skills from the given roots. Discovers and registers all skills,
   * deduplicating by case-insensitive normalized name (first wins).
   */
  async loadRoots(roots: readonly SkillRoot[]): Promise<void> {
    for (const root of roots) {
      if (!this.roots.includes(root.path)) this.roots.push(root.path);
    }

    const skills = await this.discoverImpl({
      roots,
      onWarning: this.onWarning,
      onSkippedByPolicy: (skill) => this.skipped.push(skill),
    });

    for (const skill of skills) {
      const key = normalizeSkillName(skill.name);
      // First wins — do not overwrite existing entries
      if (!this.byName.has(key)) {
        this.byName.set(key, skill);
      }
    }
  }

  // ─── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a single skill, optionally replacing an existing registration.
   * The normal loadRoots already deduplicates (first wins) so this method
   * is used for programmatic insertion such as built-in skills.
   */
  register(skill: SkillDefinition, options: { readonly replace?: boolean } = {}): void {
    const key = normalizeSkillName(skill.name);
    if (options.replace === true || !this.byName.has(key)) {
      this.byName.set(key, skill);
    }
  }

  /**
   * Register a skill as a builtin (overrides source to 'builtin').
   */
  registerBuiltinSkill(skill: SkillDefinition): void {
    this.register(skill.source === 'builtin' ? skill : { ...skill, source: 'builtin' });
  }

  // ─── Querying ─────────────────────────────────────────────────────────────

  /**
   * Get a skill by name (case-insensitive).
   */
  getSkill(name: string): SkillDefinition | undefined {
    return this.byName.get(normalizeSkillName(name));
  }

  /**
   * List all registered skills, sorted alphabetically by name.
   */
  listSkills(): readonly SkillDefinition[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * List skills that can be invoked by the model (excludes
   * disableModelInvocation skills and non-inline types).
   */
  listInvocableSkills(): readonly SkillDefinition[] {
    return this.listSkills().filter(
      (skill) =>
        skill.metadata.disableModelInvocation !== true &&
        isInlineSkillType(skill.metadata.type),
    );
  }

  /**
   * Get the registered skill root paths.
   */
  getSkillRoots(): readonly string[] {
    return [...this.roots];
  }

  /**
   * Get skills that were skipped during loading (e.g., unsupported types).
   */
  getSkippedByPolicy(): readonly SkippedSkill[] {
    return [...this.skipped];
  }

  // ─── Activation Tracking ──────────────────────────────────────────────────

  /**
   * Record a skill activation and return the activation record.
   */
  recordActivation(
    skillName: string,
    args: string,
    trigger: SkillActivation['trigger'],
  ): SkillActivation {
    this.activationCounter++;
    const activation: SkillActivation = {
      activationId: `activation-${this.activationCounter}`,
      skillName,
      args,
      trigger,
    };
    this.activations.push(activation);
    return activation;
  }

  /**
   * Get all recorded activations for this session.
   */
  getActivations(): readonly SkillActivation[] {
    return [...this.activations];
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  /**
   * Render a skill's content with argument expansion.
   *
   * Expands $ARGUMENTS, $0, $1, named args, and template variables
   * (${Q_SKILL_DIR}, ${Q_SESSION_ID}, ${Q_CWD}) in the skill body.
   */
  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    const argumentNames = skillArgumentNames(skill.metadata);
    const content = expandSkillParameters(skill.content, rawArgs, {
      skillDir: skill.dir,
      sessionId: this.sessionId,
      cwd: this.cwd,
      argumentNames,
    });
    return content;
  }

  /**
   * Get a human-readable description of all skills.
   */
  getSkillsDescription(): string {
    const rendered = renderGroupedSkills(this.listSkills(), formatFullSkill);
    return rendered.length === 0 ? 'No skills' : rendered;
  }

  /**
   * Get a formatted skill listing suitable for system prompt injection.
   *
   * Returns a string like:
   *   DISREGARD any earlier skill listings. Current available skills:
   *   ### Project
   *   - skill-name: Description
   *     When to use: ...
   */
  getModelSkillListing(): string {
    const lines = ['DISREGARD any earlier skill listings. Current available skills:'];
    const listing = renderGroupedSkills(this.listInvocableSkills(), formatModelSkill);
    if (listing.length > 0) {
      lines.push(listing);
    }
    return lines.length === 1 ? '' : lines.join('\n');
  }

  /**
   * Activate a skill: records the activation and returns the rendered
   * content wrapped as a <v-skill-loaded> system reminder for context injection.
   */
  activateSkill(name: string, rawArgs: string, trigger: SkillActivation['trigger']): string | undefined {
    const skill = this.getSkill(name);
    if (skill === undefined) return undefined;

    const activation = this.recordActivation(name, rawArgs, trigger);
    const rendered = this.renderSkillPrompt(skill, rawArgs);

    return (
      `<v-skill-loaded activationId="${activation.activationId}" ` +
      `skillName="${escapeAttr(skill.name)}" args="${escapeAttr(rawArgs)}" ` +
      `trigger="${trigger}">\n${rendered}\n</v-skill-loaded>`
    );
  }
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

const SOURCE_GROUPS: ReadonlyArray<{ readonly source: SkillSource; readonly label: string }> = [
  { source: 'project', label: 'Project' },
  { source: 'user', label: 'User' },
  { source: 'extra', label: 'Extra' },
  { source: 'plugin', label: 'Plugin' },
  { source: 'builtin', label: 'Built-in' },
];

function renderGroupedSkills(
  skills: readonly SkillDefinition[],
  format: (skill: SkillDefinition) => readonly string[],
): string {
  const lines: string[] = [];
  for (const group of SOURCE_GROUPS) {
    const groupSkills = skills.filter((skill) => skill.source === group.source);
    if (groupSkills.length === 0) continue;
    lines.push(`### ${group.label}`);
    for (const skill of groupSkills) {
      lines.push(...format(skill));
    }
  }
  return lines.join('\n');
}

function formatFullSkill(skill: SkillDefinition): readonly string[] {
  return [
    `- ${skill.name}`,
    `  - Path: ${skill.path}`,
    `  - Description: ${skill.description}`,
  ];
}

function formatModelSkill(skill: SkillDefinition): readonly string[] {
  const lines = [`- ${skill.name}: ${truncate(skill.description, LISTING_DESC_MAX)}`];
  if (typeof skill.metadata.whenToUse === 'string' && skill.metadata.whenToUse.length > 0) {
    lines.push(`  When to use: ${skill.metadata.whenToUse}`);
  }
  lines.push(`  Path: ${skill.path}`);
  return lines;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}
