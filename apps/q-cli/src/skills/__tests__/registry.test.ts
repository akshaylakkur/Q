/**
 * Tests — Skill registry
 */
import { describe, it, expect, vi } from 'vitest';
import { SkillRegistry, SkillNotFoundError } from '../registry';
import type { SkillDefinition, SkillSource } from '../types';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function createSkill(overrides: Partial<SkillDefinition> & { name: string }): SkillDefinition {
  return {
    description: 'Default description',
    path: `/skills/${overrides.name}.md`,
    dir: '/skills',
    content: '# Skill content',
    metadata: { type: 'inline' },
    source: 'user' as SkillSource,
    ...overrides,
  };
}

// ─── Registration ──────────────────────────────────────────────────────────────

describe('SkillRegistry', () => {
  describe('register / registerBuiltinSkill', () => {
    it('registers a skill', () => {
      const reg = new SkillRegistry();
      const skill = createSkill({ name: 'test-skill' });
      reg.register(skill);
      expect(reg.getSkill('test-skill')).toBe(skill);
    });

    it('case-insensitive name lookup', () => {
      const reg = new SkillRegistry();
      const skill = createSkill({ name: 'MySkill' });
      reg.register(skill);
      expect(reg.getSkill('myskill')).toBe(skill);
      expect(reg.getSkill('MYSKILL')).toBe(skill);
    });

    it('first-wins deduplication by default', () => {
      const reg = new SkillRegistry();
      const first = createSkill({ name: 'dup', description: 'first' });
      const second = createSkill({ name: 'dup', description: 'second' });
      reg.register(first);
      reg.register(second);
      expect(reg.getSkill('dup')!.description).toBe('first');
    });

    it('replace option overwrites existing skill', () => {
      const reg = new SkillRegistry();
      const first = createSkill({ name: 'dup', description: 'first' });
      const second = createSkill({ name: 'dup', description: 'second' });
      reg.register(first);
      reg.register(second, { replace: true });
      expect(reg.getSkill('dup')!.description).toBe('second');
    });

    it('registerBuiltinSkill forces builtin source', () => {
      const reg = new SkillRegistry();
      const skill = createSkill({ name: 'builtin-test', source: 'project' });
      reg.registerBuiltinSkill(skill);
      expect(reg.getSkill('builtin-test')!.source).toBe('builtin');
    });
  });

  // ─── SkillNotFoundError ─────────────────────────────────────────────────────

  describe('SkillNotFoundError', () => {
    it('creates a named error', () => {
      const err = new SkillNotFoundError('missing-skill');
      expect(err.name).toBe('SkillNotFoundError');
      expect(err.message).toContain('missing-skill');
      expect(err.skillName).toBe('missing-skill');
    });
  });

  // ─── Listing ────────────────────────────────────────────────────────────────

  describe('listSkills / listInvocableSkills', () => {
    it('lists all registered skills sorted by name', () => {
      const reg = new SkillRegistry();
      reg.register(createSkill({ name: 'z-skill' }));
      reg.register(createSkill({ name: 'a-skill' }));
      reg.register(createSkill({ name: 'm-skill' }));

      const skills = reg.listSkills();
      expect(skills.map((s) => s.name)).toEqual(['a-skill', 'm-skill', 'z-skill']);
    });

    it('filters out disableModelInvocation and non-inline skills', () => {
      const reg = new SkillRegistry();
      reg.register(createSkill({ name: 'normal', metadata: { type: 'inline' } }));
      reg.register(
        createSkill({
          name: 'disabled',
          metadata: { type: 'inline', disableModelInvocation: true },
        }),
      );
      reg.register(createSkill({ name: 'flow-type', metadata: { type: 'flow' } }));

      const invocable = reg.listInvocableSkills();
      expect(invocable.map((s) => s.name)).toEqual(['normal']);
    });
  });

  // ─── Skill rendering ────────────────────────────────────────────────────────

  describe('renderSkillPrompt', () => {
    it('renders skill content with argument expansion', () => {
      const reg = new SkillRegistry({ sessionId: 'sess-1' });
      const skill = createSkill({
        name: 'greet',
        content: 'Hello $ARGUMENTS',
        dir: '/skills/greet',
      });
      const result = reg.renderSkillPrompt(skill, 'world');
      expect(result).toBe('Hello world');
    });

    it('replaces template variables', () => {
      const reg = new SkillRegistry({ sessionId: 'sess-1' });
      const skill = createSkill({
        name: 'info',
        content: 'Dir: ${Q_SKILL_DIR}, SID: ${Q_SESSION_ID}',
        dir: '/my-skills',
      });
      const result = reg.renderSkillPrompt(skill, '');
      expect(result).toContain('/my-skills');
      expect(result).toContain('sess-1');
    });

    it('handles empty args', () => {
      const reg = new SkillRegistry();
      const skill = createSkill({
        name: 'empty',
        content: 'Static content',
      });
      const result = reg.renderSkillPrompt(skill, '');
      expect(result).toBe('Static content');
    });
  });

  // ─── Model skill listing ────────────────────────────────────────────────────

  describe('getModelSkillListing', () => {
    it('formats invocable skills for system prompt', () => {
      const reg = new SkillRegistry();
      reg.register(
        createSkill({
          name: 'web-search',
          description: 'Search the web for information',
          source: 'builtin',
          metadata: { type: 'inline', whenToUse: 'When you need current info' },
        }),
      );
      reg.register(
        createSkill({
          name: 'hidden',
          description: 'Hidden skill',
          metadata: { type: 'inline', disableModelInvocation: true },
        }),
      );

      const listing = reg.getModelSkillListing();
      expect(listing).toBeTruthy();
      expect(listing).toContain('web-search');
      expect(listing).toContain('When to use');
      expect(listing).not.toContain('hidden');
    });

    it('returns empty string when no invocable skills', () => {
      const reg = new SkillRegistry();
      expect(reg.getModelSkillListing()).toBe('');
    });
  });

  // ─── Skills description ─────────────────────────────────────────────────────

  describe('getModelSkillListing', () => {
    it('returns formatted skill listing', () => {
      const reg = new SkillRegistry();
      reg.register(
        createSkill({ name: 'proj-skill', source: 'project' }),
      );
      reg.register(
        createSkill({ name: 'usr-skill', source: 'user' }),
      );

      const desc = reg.getModelSkillListing();
      expect(desc).toBeTruthy();
    });

    it('returns empty string when no invocable skills', () => {
      const reg = new SkillRegistry();
      expect(reg.getModelSkillListing()).toBe('');
    });
  });

  // ─── loadRoots ──────────────────────────────────────────────────────────────

  describe('loadRoots', () => {
    it('discovers and registers skills from roots', async () => {
      const mockSkills = [
        createSkill({ name: 'discovered-1', source: 'project' }),
        createSkill({ name: 'discovered-2', source: 'user' }),
      ];
      const discover = async () => mockSkills;

      const reg = new SkillRegistry({ discover });
      await reg.loadRoots([
        { path: '/project/skills', source: 'project' },
      ]);

      expect(reg.getSkill('discovered-1')).toBeDefined();
      expect(reg.getSkill('discovered-2')).toBeDefined();
      expect(reg.listSkills()).toHaveLength(2);
    });

    it('tracks root paths', async () => {
      const discover = async () => [];
      const reg = new SkillRegistry({ discover });
      await reg.loadRoots([
        { path: '/a', source: 'project' },
        { path: '/b', source: 'user' },
      ]);
      expect(reg.getSkillRoots()).toEqual(['/a', '/b']);
    });

    it('does not add duplicate roots', async () => {
      const discover = async () => [];
      const reg = new SkillRegistry({ discover });
      await reg.loadRoots([
        { path: '/a', source: 'project' },
        { path: '/a', source: 'user' }, // same path
      ]);
      expect(reg.getSkillRoots()).toEqual(['/a']);
    });

    it('tracks skipped skills', async () => {
      const discover = async (_opts: any) => {
        // Manually call the onSkippedByPolicy
        if (_opts.onSkippedByPolicy) {
          _opts.onSkippedByPolicy({
            path: '/bad/skill.md',
            type: 'weird',
            reason: 'unsupported skill type "weird"',
          });
        }
        return [];
      };

      const reg = new SkillRegistry({ discover });
      await reg.loadRoots([{ path: '/bad', source: 'project' }]);
      expect(reg.getSkippedByPolicy()).toHaveLength(1);
    });
  });
});
