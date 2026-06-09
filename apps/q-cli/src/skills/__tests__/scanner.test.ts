/**
 * Tests — Skill scanner
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveSkillRoots, discoverSkills } from '../scanner';
import type { SkillRoot, SkillDefinition, SkippedSkill } from '../types';
import type { SkillSource } from '../types';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

function mockFileSystem(structure: Record<string, 'file' | 'dir'>) {
  const isFile = async (p: string) => structure[p] === 'file';
  const isDir = async (p: string) => structure[p] === 'dir';
  const readdir = async (p: string): Promise<readonly string[]> => {
    const entries = Object.keys(structure)
      .filter((k) => {
        const dir = k.substring(0, k.lastIndexOf('/'));
        return dir === p || (p === '/' && dir === '');
      })
      .map((k) => k.substring(p.length + 1).split('/')[0]!)
      .filter((v, i, a) => a.indexOf(v) === i);
    if (entries.length === 0) throw new Error(`ENOENT: ${p}`);
    return entries;
  };
  const exists = async (p: string) => structure[p] !== undefined;
  return { isFile, isDir, readdir, exists };
}

// ─── resolveSkillRoots ─────────────────────────────────────────────────────────

describe('resolveSkillRoots', () => {
  const paths = {
    userHomeDir: '/home/user',
    workDir: '/project',
  };

  it('finds project .q/skills/ directory', async () => {
    const isDir = async (p: string) => p.includes('.q/skills') || p.includes('.git');
    const realpath = async (p: string) => p;

    const roots = await resolveSkillRoots({
      paths,
      isDir,
      realpath,
    });

    expect(roots.some((r) => r.source === 'project')).toBe(true);
  });

  it('includes builtin dir when specified', async () => {
    const isDir = async (p: string) => p.includes('/builtin') || p.includes('.git');
    const realpath = async (p: string) => p;

    const roots = await resolveSkillRoots({
      paths,
      builtinDir: '/builtin/skills',
      isDir,
      realpath,
    });

    expect(roots.some((r) => r.source === 'builtin')).toBe(true);
  });

  it('includes extra dirs from config', async () => {
    const isDir = async (p: string) => true;
    const realpath = async (p: string) => p;

    const roots = await resolveSkillRoots({
      paths,
      extraDirs: ['/extra/skills'],
      mergeAllAvailableSkills: true,
      isDir,
      realpath,
    });

    expect(roots.some((r) => r.source === 'extra')).toBe(true);
  });

  it('includes plugin roots', async () => {
    const isDir = async (p: string) => true;
    const realpath = async (p: string) => p;

    const pluginRoots: SkillRoot[] = [
      { path: '/plugin/skills', source: 'plugin' },
    ];

    const roots = await resolveSkillRoots({
      paths,
      pluginSkillRoots: pluginRoots,
      isDir,
      realpath,
    });

    expect(roots.some((r) => r.source === 'plugin')).toBe(true);
  });

  it('deduplicates roots by resolved path', async () => {
    let callCount = 0;
    const isDir = async () => true;
    const realpath = async () => '/real/skills';

    const roots = await resolveSkillRoots({
      paths,
      extraDirs: ['/extra1', '/extra2'],
      builtinDir: '/builtin',
      isDir,
      realpath,
    });

    // All resolve to /real/skills, so only one entry
    expect(roots.filter((r) => r.path === '/real/skills').length).toBe(1);
  });
});

// ─── discoverSkills ───────────────────────────────────────────────────────────

describe('discoverSkills', () => {
  it('discovers directory skills (name/SKILL.md)', async () => {
    let callCount = 0;
    const parse = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          name: 'test-skill',
          description: 'A test',
          path: '/root/test-skill/SKILL.md',
          dir: '/root/test-skill',
          content: '# Test',
          metadata: { type: 'inline' as const },
          source: 'project' as SkillSource,
        };
      }
      return {
        name: 'other',
        description: 'Another',
        path: '/root/other.md',
        dir: '/root',
        content: '# Other',
        metadata: { type: 'inline' as const },
        source: 'project' as SkillSource,
      };
    };

    const roots: SkillRoot[] = [{ path: '/root', source: 'project' }];
    const readdir = async (p: string): Promise<readonly string[]> => {
      if (p === '/root') return ['test-skill', 'other.md', 'node_modules'];
      return [];
    };
    const isFile = async (p: string) => p.endsWith('SKILL.md') || p.endsWith('other.md');
    const isDir = async (p: string) => p === '/root/test-skill';

    const skills = await discoverSkills({ roots, readdir, isFile, isDir, parse });
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name).sort()).toEqual(['other', 'test-skill']);
  });

  it('discovers flat .md skills at root level', async () => {
    const mockSkill = (name: string): SkillDefinition => ({
      name,
      description: 'test',
      path: `/root/${name}.md`,
      dir: '/root',
      content: '# Test',
      metadata: { type: 'inline' as const },
      source: 'project',
    });

    let callIndex = 0;
    const parse = async () => mockSkill(callIndex++ === 0 ? 'skill-a' : 'skill-b');

    const roots: SkillRoot[] = [{ path: '/root', source: 'project' }];
    const readdir = async (): Promise<readonly string[]> => ['skill-a.md', 'skill-b.md'];
    const isFile = async (p: string) => p.endsWith('.md');
    const isDir = async () => false;

    const skills = await discoverSkills({ roots, readdir, isFile, isDir, parse });
    expect(skills).toHaveLength(2);
    expect(skills[0]!.name).toBe('skill-a');
    expect(skills[1]!.name).toBe('skill-b');
  });

  it('deduplicates skills by name (first wins)', async () => {
    const roots: SkillRoot[] = [
      { path: '/root1', source: 'project' },
      { path: '/root2', source: 'user' },
    ];

    let callCount = 0;
    const parse = async () => {
      callCount++;
      return {
        name: 'same-name',
        description: `source ${callCount}`,
        path: `/root${callCount}/same-name/SKILL.md`,
        dir: `/root${callCount}/same-name`,
        content: '# Test',
        metadata: { type: 'inline' as const },
        source: (callCount === 1 ? 'project' : 'user') as SkillSource,
      } as SkillDefinition;
    };

    const readdir = async (p: string): Promise<readonly string[]> => {
      if (p.includes('node_modules')) return [];
      if (p.includes('.git')) return [];
      return ['same-name'];
    };
    const isFile = async (p: string) => p.endsWith('SKILL.md');
    const isDir = async (p: string) => p.includes('same-name');

    const skills = await discoverSkills({ roots, readdir, isFile, isDir, parse });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe('source 1');
  });

  it('skips node_modules and dotfiles/dotdirs', async () => {
    const roots: SkillRoot[] = [{ path: '/root', source: 'project' }];
    const readdir = async (): Promise<readonly string[]> => [
      'node_modules',
      '.git',
      '.hidden.md',
      'visible.md',
    ];
    const isFile = async (p: string) => p.endsWith('.md');
    const isDir = async () => false;
    const parse = async () => ({
      name: 'visible-skill',
      description: 'test',
      path: '/root/visible.md',
      dir: '/root',
      content: '# Test',
      metadata: { type: 'inline' as const },
      source: 'project' as SkillSource,
    });

    const skills = await discoverSkills({ roots, readdir, isFile, isDir, parse });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('visible-skill');
  });

  it('reports skipped skills via callback', async () => {
    const roots: SkillRoot[] = [{ path: '/root', source: 'project' }];
    const readdir = async (): Promise<readonly string[]> => ['bad-type.md'];
    // Only match flat .md files, not SKILL.md in subdirectories
    const isFile = async (p: string) => p === '/root/bad-type.md';
    const isDir = async () => false;
    const parse = async () => {
      throw new (await import('../parser')).UnsupportedSkillTypeError('weird-type');
    };

    const skipped: SkippedSkill[] = [];
    const warn: (m: string) => void = () => {};

    const skills = await discoverSkills({
      roots,
      readdir,
      isFile,
      isDir,
      parse,
      onSkippedByPolicy: (s) => skipped.push(s),
      onWarning: warn,
    });

    expect(skills).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toContain('unsupported skill type');
  });

  it('warns on flat skill that shares name with directory skill', async () => {
    const roots: SkillRoot[] = [{ path: '/root', source: 'project' }];
    const readdir = async (): Promise<readonly string[]> => ['test', 'test.md'];
    const isFile = async (p: string) => p.endsWith('.md') || p.endsWith('SKILL.md');
    const isDir = async (p: string) => p === '/root/test';
    const parse = async () => ({
      name: 'test',
      description: 'test',
      path: '/root/test/SKILL.md',
      dir: '/root/test',
      content: '# Test',
      metadata: { type: 'inline' as const },
      source: 'project' as SkillSource,
    });

    const warnings: string[] = [];
    const skills = await discoverSkills({
      roots,
      readdir,
      isFile,
      isDir,
      parse,
      onWarning: (m) => warnings.push(m),
    });

    expect(skills).toHaveLength(1);
    expect(warnings.some((w) => w.includes('Ignoring flat skill'))).toBe(true);
  });

  it('respects MAX_SKILL_SCAN_DEPTH and stops recursion', async () => {
    // Create a deeply nested structure
    const deepPaths: string[] = [];
    let current = '/deep';
    for (let i = 0; i < 15; i++) {
      deepPaths.push(`${current}/level-${i}/SKILL.md`);
      current = `${current}/level-${i}`;
    }

    const isFile = async (p: string) => p.endsWith('SKILL.md');
    const isDir = async () => true;
    const parse = async () => ({
      name: 'deep-skill',
      description: 'deep',
      path: '/deep/skill',
      dir: '/deep',
      content: '# Test',
      metadata: { type: 'inline' as const },
      source: 'project' as SkillSource,
    });

    let readdirCalls = 0;
    const readdir = async (): Promise<readonly string[]> => {
      readdirCalls++;
      return ['level-0'];
    };

    const roots: SkillRoot[] = [{ path: '/deep', source: 'project' }];
    await discoverSkills({ roots, readdir, isFile, isDir, parse });

    // Should have readdir called at most depth+1 times (within limit)
    expect(readdirCalls).toBeLessThanOrEqual(10);
  });

  it('sorts discovered skills alphabetically', async () => {
    const roots: SkillRoot[] = [{ path: '/root', source: 'project' }];

    const names = ['z-skill', 'a-skill', 'm-skill'];
    let idx = 0;
    const parse = async () => {
      const n = names[idx]!;
      idx++;
      return {
        name: n,
        description: n,
        path: `/root/${n}.md`,
        dir: '/root',
        content: '# Test',
        metadata: { type: 'inline' as const },
        source: 'project' as SkillSource,
      };
    };

    const readdir = async (): Promise<readonly string[]> => names.map((n) => `${n}.md`);
    const isFile = async (p: string) => p.endsWith('.md');
    const isDir = async () => false;

    const skills = await discoverSkills({ roots, readdir, isFile, isDir, parse });
    expect(skills.map((s) => s.name)).toEqual(['a-skill', 'm-skill', 'z-skill']);
  });
});
