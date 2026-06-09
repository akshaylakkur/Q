/**
 * Skills — Runtime integration verification
 *
 * Exercises the real skill system code paths (parser, scanner, registry,
 * built-in skills) without mocking, to ensure everything works in a real
 * runtime environment.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  SkillRegistry,
  registerBuiltinSkills,
  MCP_CONFIG_SKILL,
  INIT_PROJECT_SKILL,
  parseFrontmatter,
  parseSkillText,
  expandSkillParameters,
  skillArgumentNames,
  normalizeSkillName,
  summarizeSkill,
  isInlineSkillType,
  isUserActivatableSkillType,
  isSupportedSkillType,
  SkillNotFoundError,
  FrontmatterError,
  SkillParseError,
  UnsupportedSkillTypeError,
} from '../index.js';

// ─── 1. Type Helpers ─────────────────────────────────────────────────────────────

describe('normalizeSkillName', () => {
  it('lowercases input', () => {
    expect(normalizeSkillName('MCP-Config')).toBe('mcp-config');
    expect(normalizeSkillName('Init-Project')).toBe('init-project');
    expect(normalizeSkillName('SKILL_A')).toBe('skill_a');
  });
});

describe('isInlineSkillType / isUserActivatableSkillType / isSupportedSkillType', () => {
  it('undefined is treated as inline', () => {
    expect(isInlineSkillType(undefined)).toBe(true);
    expect(isUserActivatableSkillType(undefined)).toBe(true);
    expect(isSupportedSkillType(undefined)).toBe(true);
  });

  it('prompt and inline are inline types', () => {
    expect(isInlineSkillType('prompt')).toBe(true);
    expect(isInlineSkillType('inline')).toBe(true);
    expect(isInlineSkillType('flow')).toBe(false);
  });

  it('flow is user-activatable but not inline', () => {
    expect(isUserActivatableSkillType('flow')).toBe(true);
    expect(isSupportedSkillType('flow')).toBe(true);
  });

  it('unknown types are not supported', () => {
    expect(isSupportedSkillType('weird-type')).toBe(false);
    expect(isUserActivatableSkillType('weird-type')).toBe(false);
  });
});

describe('summarizeSkill', () => {
  it('produces a summary', () => {
    const skill = MCP_CONFIG_SKILL;
    const summary = summarizeSkill(skill);
    expect(summary.name).toBe('mcp-config');
    expect(summary.description).toBeTruthy();
    expect(summary.source).toBe('builtin');
    expect(summary.disableModelInvocation).toBe(true);
  });
});

// ─── 2. Parser (Real) ────────────────────────────────────────────────────────────

describe('parseFrontmatter (real)', () => {
  const SKILL_WITH_FM = `---
name: test-skill
description: A test skill
type: inline
when-to-use: When testing
disable-model-invocation: true
arguments:
  - name: input
    description: The input to process
    required: true
---

# Test Skill

This is a test skill body.

## Usage

Call this with \$ARGUMENTS`;

  it('parses frontmatter and body', () => {
    const result = parseFrontmatter(SKILL_WITH_FM);
    expect(result.data).toBeTruthy();
    expect(result.body).toContain('Test Skill');
    expect(result.body).toContain('ARGUMENTS');
  });

  it('resolves aliases: when-to-use and disable-model-invocation', () => {
    const skill = parseSkillText({
      skillMdPath: '/test/SKILL.md',
      skillDirName: 'test-skill',
      source: 'builtin',
      text: SKILL_WITH_FM,
    });
    expect(skill.metadata.whenToUse).toBe('When testing');
    expect(skill.metadata.disableModelInvocation).toBe(true);
    expect(skill.metadata.arguments).toBeInstanceOf(Array);
    expect(skill.metadata.arguments).toHaveLength(1);
  });

  it('name and description come from frontmatter for directory skills', () => {
    const skill = parseSkillText({
      skillMdPath: '/test/SKILL.md',
      skillDirName: 'test-skill',
      source: 'builtin',
      text: SKILL_WITH_FM,
    });
    expect(skill.name).toBe('test-skill');
    expect(skill.description).toBe('A test skill');
  });

  it('name derived from filename for flat skills without frontmatter name', () => {
    const skill = parseSkillText({
      skillMdPath: '/root/my-flat-skill.md',
      skillDirName: 'my-flat-skill',
      source: 'project',
      text: '# My Skill\n\nContent here',
    });
    expect(skill.name).toBe('my-flat-skill');
    // Description falls back to the first content line (including markdown format)
    expect(skill.description).toContain('My Skill');
  });

  it('no frontmatter returns null data and full body', () => {
    const result = parseFrontmatter('# Just markdown\n\nNo frontmatter here.');
    expect(result.data).toBeNull();
    expect(result.body).toBe('# Just markdown\n\nNo frontmatter here.');
  });

  it('throws on missing closing fence', () => {
    expect(() => parseFrontmatter('---\nname: foo')).toThrow(FrontmatterError);
  });

  it('throws on unsupported skill type', () => {
    expect(() => parseSkillText({
      skillMdPath: '/test/SKILL.md',
      skillDirName: 'test',
      source: 'project',
      text: '---\nname: test\ndescription: test\ntype: weird-type\n---\n# body',
    })).toThrow(UnsupportedSkillTypeError);
  });
});

// ─── 3. Argument Expansion ───────────────────────────────────────────────────────

describe('expandSkillParameters (real)', () => {
  it('$ARGUMENTS expands to full raw args', () => {
    const result = expandSkillParameters('Args: $ARGUMENTS', 'hello world', { skillDir: '/s' });
    expect(result).toBe('Args: hello world');
  });

  it('$ARGUMENTS[N] expands to Nth token', () => {
    const result = expandSkillParameters('First: $ARGUMENTS[0], Second: $ARGUMENTS[1]', 'foo bar', { skillDir: '/s' });
    expect(result).toBe('First: foo, Second: bar');
  });

  it('$N expands to Nth positional arg', () => {
    const result = expandSkillParameters('$0 and $1', 'alpha beta', { skillDir: '/s' });
    expect(result).toBe('alpha and beta');
  });

  it('named $<name> expands from declared argument names', () => {
    const result = expandSkillParameters('Project: $name at $dir', 'myproj /tmp', {
      skillDir: '/s',
      argumentNames: ['name', 'dir'],
    });
    expect(result).toBe('Project: myproj at /tmp');
  });

  it('${Q_SKILL_DIR} expands to skill directory', () => {
    const result = expandSkillParameters('Dir: ${Q_SKILL_DIR}', '', { skillDir: '/my/skills/myskill' });
    expect(result).toBe('Dir: /my/skills/myskill');
  });

  it('${Q_SESSION_ID} expands to session ID', () => {
    const result = expandSkillParameters('Session: ${Q_SESSION_ID}', '', { skillDir: '/s', sessionId: 'abc-123' });
    expect(result).toBe('Session: abc-123');
  });

  it('${Q_CWD} expands to cwd', () => {
    const result = expandSkillParameters('Cwd: ${Q_CWD}', '', { skillDir: '/s', cwd: '/home/user/project' });
    expect(result).toBe('Cwd: /home/user/project');
  });

  it('appends ARGUMENTS line when no placeholder found but args given', () => {
    const result = expandSkillParameters('Hello', 'raw args here', { skillDir: '/s' });
    expect(result).toBe('Hello\n\nARGUMENTS: raw args here');
  });

  it('does not append when args string is empty', () => {
    const result = expandSkillParameters('Hello', '', { skillDir: '/s' });
    expect(result).toBe('Hello');
  });

  it('handles quoted args in tokenization', () => {
    const result = expandSkillParameters('$0 $1 $2', 'one "two three" four', { skillDir: '/s' });
    expect(result).toBe('one two three four');
  });
});

// ─── 4. skillArgumentNames ─────────────────────────────────────────────────────

describe('skillArgumentNames (real)', () => {
  it('returns empty for missing args', () => {
    expect(skillArgumentNames({})).toEqual([]);
  });

  it('parses array-of-objects with name field', () => {
    const names = skillArgumentNames({
      arguments: [
        { name: 'foo', description: 'Foo param', required: true },
        { name: 'bar', description: 'Bar param', required: false },
      ],
    });
    expect(names).toEqual(['foo', 'bar']);
  });

  it('parses space-separated string form', () => {
    const names = skillArgumentNames({ arguments: 'name dir extra' });
    expect(names).toEqual(['name', 'dir', 'extra']);
  });
});

// ─── 5. Registry (Real Built-in Skills) ─────────────────────────────────────────

describe('SkillRegistry with real built-in skills', () => {
  let reg: SkillRegistry;

  beforeAll(() => {
    reg = new SkillRegistry({ sessionId: 'test-session' });
    registerBuiltinSkills(reg);
  });

  it('registered mcp-config and init-project', () => {
    const skills = reg.listSkills();
    expect(skills.length).toBe(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['init-project', 'mcp-config']);
  });

  it('getSkill is case-insensitive', () => {
    expect(reg.getSkill('MCP-CONFIG')).toBeDefined();
    expect(reg.getSkill('Init-Project')).toBeDefined();
    expect(reg.getSkill('nonexistent')).toBeUndefined();
  });

  it('listInvocableSkills excludes mcp-config (disableModelInvocation)', () => {
    const invocable = reg.listInvocableSkills();
    expect(invocable.length).toBe(1);
    expect(invocable[0]!.name).toBe('init-project');
  });

  it('getModelSkillListing contains init-project but not mcp-config', () => {
    const listing = reg.getModelSkillListing();
    expect(listing).toContain('init-project');
    expect(listing).not.toContain('mcp-config');
    expect(listing).toContain('DISREGARD any earlier skill listings');
  });

  it('getSkillsDescription shows all skills by source group', () => {
    const desc = reg.getSkillsDescription();
    expect(desc).toContain('mcp-config');
    expect(desc).toContain('init-project');
    expect(desc).toContain('Built-in');
    expect(desc).toContain('Path:');
  });

  it('renderSkillPrompt with session context', () => {
    const rendered = reg.renderSkillPrompt(INIT_PROJECT_SKILL, '');
    expect(rendered).toContain('Initialize a Qode Project');
    expect(rendered).toContain('.q/config.toml');
  });

  it('renderSkillPrompt expands declared argument placeholders', () => {
    const rendered = reg.renderSkillPrompt(INIT_PROJECT_SKILL, '');
    // The init-project skill has `dir` as a declared argument;
    // ${dir} in the body gets expanded to the 1st token (empty string here)
    expect(rendered).toContain('Initialize a Qode Project');
    expect(rendered).toContain('.q/config.toml');
  });

  it('register with replace option works', () => {
    const custom = { ...INIT_PROJECT_SKILL, name: 'init-project', description: 'Custom override' };
    reg.register(custom, { replace: true });
    const skill = reg.getSkill('init-project')!;
    expect(skill.description).toBe('Custom override');
    // Re-register builtins to restore for other tests
    registerBuiltinSkills(reg);
  });

  it('registerBuiltinSkill overrides source to builtin', () => {
    const custom = { ...INIT_PROJECT_SKILL, source: 'user' as const };
    reg.registerBuiltinSkill(custom);
    expect(reg.getSkill('init-project')!.source).toBe('builtin');
    registerBuiltinSkills(reg);
  });
});

// ─── 6. Activation Tracking ──────────────────────────────────────────────────────

describe('Skill activation', () => {
  it('activateSkill returns <v-skill-loaded> XML', () => {
    const reg = new SkillRegistry({ sessionId: 'test' });
    registerBuiltinSkills(reg);

    const result = reg.activateSkill('init-project', '--name test', 'slash-command');
    expect(result).toBeDefined();
    expect(result).toContain('<v-skill-loaded');
    expect(result).toContain('activationId="activation-1"');
    expect(result).toContain('skillName="init-project"');
    expect(result).toContain('args="--name test"');
    expect(result).toContain('trigger="slash-command"');
    expect(result).toContain('</v-skill-loaded>');
  });

  it('activateSkill returns undefined for unknown skill', () => {
    const reg = new SkillRegistry();
    expect(reg.activateSkill('nonexistent', '', 'tool')).toBeUndefined();
  });

  it('recordActivation and getActivations work', () => {
    const reg = new SkillRegistry();
    const act = reg.recordActivation('my-skill', 'arg1 arg2', 'auto');
    expect(act.skillName).toBe('my-skill');
    expect(act.args).toBe('arg1 arg2');
    expect(act.trigger).toBe('auto');
    expect(act.activationId).toBeTruthy();

    const all = reg.getActivations();
    expect(all).toHaveLength(1);
    expect(all[0]!.skillName).toBe('my-skill');
  });
});

// ─── 7. Error Classes ───────────────────────────────────────────────────────────

describe('Skill error classes', () => {
  it('SkillNotFoundError', () => {
    const err = new SkillNotFoundError('missing');
    expect(err.message).toContain('missing');
    expect(err.skillName).toBe('missing');
  });

  it('FrontmatterError', () => {
    const err = new FrontmatterError('bad yaml');
    expect(err.message).toBe('bad yaml');
  });

  it('SkillParseError with cause', () => {
    const cause = new Error('inner');
    const err = new SkillParseError('outer', cause);
    expect(err.message).toBe('outer');
    expect(err.reason).toBe(cause);
  });

  it('UnsupportedSkillTypeError', () => {
    const err = new UnsupportedSkillTypeError('weird');
    expect(err.skillType).toBe('weird');
    expect(err.message).toContain('weird');
  });
});

// ─── 8. Registry Methods ─────────────────────────────────────────────────────────

describe('SkillRegistry edge cases', () => {
  it('empty registry has no skills', () => {
    const reg = new SkillRegistry();
    expect(reg.listSkills()).toHaveLength(0);
    expect(reg.listInvocableSkills()).toHaveLength(0);
    expect(reg.getSkillRoots()).toHaveLength(0);
    expect(reg.getSkippedByPolicy()).toHaveLength(0);
    expect(reg.getActivations()).toHaveLength(0);
  });

  it('getSkillsDescription returns "No skills" when empty', () => {
    const reg = new SkillRegistry();
    expect(reg.getSkillsDescription()).toBe('No skills');
  });

  it('getModelSkillListing returns empty string when no invocable skills', () => {
    const reg = new SkillRegistry();
    expect(reg.getModelSkillListing()).toBe('');
  });

  it('loadRoots with empty array does nothing', async () => {
    const reg = new SkillRegistry();
    await reg.loadRoots([]);
    expect(reg.listSkills()).toHaveLength(0);
  });

  it('built-in skill metadata is complete', () => {
    expect(MCP_CONFIG_SKILL.metadata.type).toBe('inline');
    expect(MCP_CONFIG_SKILL.metadata.disableModelInvocation).toBe(true);
    expect(INIT_PROJECT_SKILL.metadata.type).toBe('inline');
    expect(INIT_PROJECT_SKILL.metadata.disableModelInvocation).toBe(false);
  });

  it('register with plugin source is preserved when source is already builtin', () => {
    const reg = new SkillRegistry();
    const skill = { ...MCP_CONFIG_SKILL, source: 'project' as const };
    reg.registerBuiltinSkill(skill);
    expect(reg.getSkill('mcp-config')!.source).toBe('builtin');
  });
});
