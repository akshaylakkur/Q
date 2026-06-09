/**
 * Tests — Skill parser
 */
import { describe, it, expect } from 'vitest';
import {
  parseSkillText,
  parseFrontmatter,
  expandSkillParameters,
  skillArgumentNames,
} from '../parser';
import type { SkillMetadata } from '../types';

// ─── Frontmatter parsing ──────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('returns null data and full body when no frontmatter fence is present', () => {
    const result = parseFrontmatter('Just some markdown\n\nWith content');
    expect(result.data).toBeNull();
    expect(result.body).toBe('Just some markdown\n\nWith content');
  });

  it('parses YAML frontmatter between --- fences', () => {
    const result = parseFrontmatter(`---
name: test-skill
description: A test skill
---

# Skill body here`);
    expect(result.data).toEqual({ name: 'test-skill', description: 'A test skill' });
    expect(result.body.trim()).toBe('# Skill body here');
  });

  it('handles empty frontmatter', () => {
    const result = parseFrontmatter(`---

---

Body only`);
    expect(result.data).toEqual({});
    expect(result.body.trim()).toBe('Body only');
  });

  it('throws FrontmatterError for unclosed frontmatter', () => {
    expect(() => parseFrontmatter(`---
name: test
No closing fence`)).toThrow('Missing closing frontmatter fence');
  });

  it('throws FrontmatterError for invalid YAML', () => {
    expect(() => parseFrontmatter(`---
invalid: : yaml : :
---

Body`)).toThrow();
  });
});

// ─── Skill text parsing ───────────────────────────────────────────────────────

describe('parseSkillText', () => {
  const baseOptions = {
    skillMdPath: '/fake/path/my-skill.md',
    skillDirName: 'my-skill',
    source: 'project' as const,
  };

  it('parses a flat .md skill without frontmatter', () => {
    const skill = parseSkillText({
      ...baseOptions,
      text: 'This is a skill description.\n\nSome content here.',
    });
    expect(skill.name).toBe('my-skill');
    expect(skill.description).toBe('This is a skill description.');
    expect(skill.content).toBe('This is a skill description.\n\nSome content here.');
    expect(skill.source).toBe('project');
    expect(skill.path).toContain('my-skill.md');
  });

  it('parses a directory SKILL.md with frontmatter', () => {
    const skill = parseSkillText({
      ...baseOptions,
      skillMdPath: '/fake/path/my-skill/SKILL.md',
      text: `---
name: my-named-skill
description: A named skill
type: prompt
---

Body content`,
    });
    expect(skill.name).toBe('my-named-skill');
    expect(skill.description).toBe('A named skill');
    expect(skill.metadata.type).toBe('prompt');
    expect(skill.content).toBe('Body content');
  });

  it('requires frontmatter for directory SKILL.md', () => {
    expect(() =>
      parseSkillText({
        ...baseOptions,
        skillMdPath: '/fake/path/my-skill/SKILL.md',
        text: 'No frontmatter here',
      }),
    ).toThrow('Missing frontmatter');
  });

  it('requires name and description in directory SKILL.md frontmatter', () => {
    expect(() =>
      parseSkillText({
        ...baseOptions,
        skillMdPath: '/fake/path/my-skill/SKILL.md',
        text: `---
type: inline
---

Body`,
      }),
    ).toThrow('Missing required frontmatter field "name"');
  });

  it('throws UnsupportedSkillTypeError for unknown types', () => {
    expect(() =>
      parseSkillText({
        ...baseOptions,
        text: `---
type: unknown-type
---

Body`,
      }),
    ).toThrow('flow');
  });

  it('generates description from body for flat skills without frontmatter', () => {
    const longLine = 'A'.repeat(300);
    const skill = parseSkillText({
      ...baseOptions,
      text: longLine,
    });
    expect(skill.description).toHaveLength(240); // truncated with ellipsis
  });

  it('handles DOS line endings (\\r\\n)', () => {
    const result = parseFrontmatter('---\r\nname: test\r\n---\r\nBody\r\n');
    expect(result.data).toEqual({ name: 'test' });
    expect(result.body.trim()).toBe('Body');
  });
});

// ─── Metadata aliases ─────────────────────────────────────────────────────────

describe('metadata aliases', () => {
  it('resolves when-to-use alias', () => {
    const skill = parseSkillText({
      skillMdPath: '/fake/skill.md',
      skillDirName: 'test',
      source: 'user',
      text: `---
name: test
description: Test
when-to-use: When testing
---

Body`,
    });
    expect(skill.metadata.whenToUse).toBe('When testing');
  });

  it('resolves disable-model-invocation alias', () => {
    const skill = parseSkillText({
      skillMdPath: '/fake/skill.md',
      skillDirName: 'test',
      source: 'user',
      text: `---
name: test
description: Test
disable-model-invocation: true
---

Body`,
    });
    expect(skill.metadata.disableModelInvocation).toBe(true);
  });
});

// ─── Argument names ────────────────────────────────────────────────────────────

describe('skillArgumentNames', () => {
  it('extracts names from string list', () => {
    const meta = { arguments: 'name description verbose' } as unknown as SkillMetadata;
    expect(skillArgumentNames(meta)).toEqual(['name', 'description', 'verbose']);
  });

  it('extracts names from object array with name fields', () => {
    const meta = {
      arguments: [
        { name: 'name', description: 'The name', required: true },
        { name: 'dir', description: 'Target dir', required: false },
      ],
    } as unknown as SkillMetadata;
    expect(skillArgumentNames(meta)).toEqual(['name', 'dir']);
  });

  it('returns empty array for missing arguments', () => {
    const meta = {} as SkillMetadata;
    expect(skillArgumentNames(meta)).toEqual([]);
  });

  it('filters out numeric-only names', () => {
    const meta = { arguments: '0 1 name' } as unknown as SkillMetadata;
    expect(skillArgumentNames(meta)).toEqual(['name']);
  });
});

// ─── Argument expansion ────────────────────────────────────────────────────────

describe('expandSkillParameters', () => {
  const ctx = {
    skillDir: '/skills',
    sessionId: 'session-123',
    cwd: '/project',
    argumentNames: ['name', 'dir'],
  };

  it('replaces $ARGUMENTS with full raw args', () => {
    const result = expandSkillParameters('Args: $ARGUMENTS', 'hello world', ctx);
    expect(result).toBe('Args: hello world');
  });

  it('replaces $ARGUMENTS[N] with Nth token', () => {
    const result = expandSkillParameters('First: $ARGUMENTS[0], Second: $ARGUMENTS[1]', 'alpha beta', ctx);
    expect(result).toBe('First: alpha, Second: beta');
  });

  it('replaces $N with positional args', () => {
    const result = expandSkillParameters('$0 $1 $2', 'a b c', ctx);
    expect(result).toBe('a b c');
  });

  it('replaces named $<name> with positional args', () => {
    const result = expandSkillParameters('Name: $name, Dir: $dir', 'myproj /tmp', ctx);
    expect(result).toBe('Name: myproj, Dir: /tmp');
  });

  it('replaces ${Q_SKILL_DIR}', () => {
    const result = expandSkillParameters('Dir: ${Q_SKILL_DIR}', '', ctx);
    expect(result).toBe('Dir: /skills');
  });

  it('replaces ${Q_SESSION_ID}', () => {
    const result = expandSkillParameters('SID: ${Q_SESSION_ID}', '', ctx);
    expect(result).toBe('SID: session-123');
  });

  it('replaces ${Q_CWD}', () => {
    const result = expandSkillParameters('CWD: ${Q_CWD}', '', ctx);
    expect(result).toBe('CWD: /project');
  });

  it('appends ARGUMENTS suffix when no placeholder used but args given', () => {
    const result = expandSkillParameters('Static content', 'extra args', ctx);
    expect(result).toContain('ARGUMENTS: extra args');
  });

  it('does not append ARGUMENTS when placeholder was used', () => {
    const result = expandSkillParameters('Args: $ARGUMENTS', 'extra args', ctx);
    expect(result).not.toContain('ARGUMENTS: extra args');
  });

  it('handles quoted tokens in args', () => {
    const result = expandSkillParameters('$0 - $1', 'hello "multi word"', ctx);
    expect(result).toBe('hello - multi word');
  });

  it('returns empty string for out-of-bounds indexes', () => {
    const result = expandSkillParameters('$0 $5 $99', 'only_one', ctx);
    expect(result).toBe('only_one  ');
  });
});
