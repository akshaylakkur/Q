/**
 * Tests — Skill type helpers
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeSkillName,
  isInlineSkillType,
  isUserActivatableSkillType,
  isSupportedSkillType,
  summarizeSkill,
} from '../types';
import type { SkillDefinition, SkillSource } from '../types';

describe('normalizeSkillName', () => {
  it('converts to lowercase', () => {
    expect(normalizeSkillName('HelloWorld')).toBe('helloworld');
  });

  it('handles mixed case and spaces', () => {
    expect(normalizeSkillName('My Skill Name')).toBe('my skill name');
  });
});

describe('isInlineSkillType', () => {
  it('returns true for undefined type', () => {
    expect(isInlineSkillType(undefined)).toBe(true);
  });

  it('returns true for prompt type', () => {
    expect(isInlineSkillType('prompt')).toBe(true);
  });

  it('returns true for inline type', () => {
    expect(isInlineSkillType('inline')).toBe(true);
  });

  it('returns false for flow type', () => {
    expect(isInlineSkillType('flow')).toBe(false);
  });
});

describe('isUserActivatableSkillType', () => {
  it('includes inline types and flow', () => {
    expect(isUserActivatableSkillType('prompt')).toBe(true);
    expect(isUserActivatableSkillType('inline')).toBe(true);
    expect(isUserActivatableSkillType('flow')).toBe(true);
  });

  it('excludes unknown types', () => {
    expect(isUserActivatableSkillType('unknown')).toBe(false);
  });
});

describe('isSupportedSkillType', () => {
  it('supports prompt, inline, and flow', () => {
    expect(isSupportedSkillType('prompt')).toBe(true);
    expect(isSupportedSkillType('inline')).toBe(true);
    expect(isSupportedSkillType('flow')).toBe(true);
  });

  it('rejects unsupported types', () => {
    expect(isSupportedSkillType('weird')).toBe(false);
  });
});

describe('summarizeSkill', () => {
  it('creates a summary from a skill definition', () => {
    const skill: SkillDefinition = {
      name: 'test',
      description: 'Testing',
      path: '/path/to/skill.md',
      dir: '/path/to',
      content: '# Content',
      metadata: { type: 'inline', disableModelInvocation: false },
      source: 'project',
    };

    const summary = summarizeSkill(skill);
    expect(summary.name).toBe('test');
    expect(summary.description).toBe('Testing');
    expect(summary.path).toBe('/path/to/skill.md');
    expect(summary.source).toBe('project');
    expect(summary.type).toBe('inline');
    expect(summary.disableModelInvocation).toBe(false);
  });
});
