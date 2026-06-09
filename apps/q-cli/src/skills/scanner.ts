/**
 * Skills — Scanner
 *
 * Discovers skills from multiple roots: project (.q/skills/),
 * user ($HOME/.Q/skills/), extra (configured dirs from --skills-dir
 * and config), and builtin.
 *
 * Supports both directory skills (SKILL.md inside a named directory)
 * and flat .md skills at the top level of a root.
 */
import { promises as fs } from 'node:fs';
import path from 'pathe';

import { SkillParseError, UnsupportedSkillTypeError, parseSkillFromFile } from './parser';
import type { SkillDefinition, SkillRoot, SkillSource, SkippedSkill } from './types';
import { normalizeSkillName } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Brand-specific skill dirs for Qode */
const PROJECT_BRAND_DIRS = ['.q/skills'] as const;

/** Generic skill dirs for backward compatibility */
const PROJECT_GENERIC_DIRS = ['.agents/skills'] as const;

const USER_BRAND_DIRS = ['skills'] as const; // relative to $HOME/.Q/
const USER_GENERIC_DIRS = ['.agents/skills'] as const;

/** Max recursion depth for skill scanning (prevents symlink cycles) */
const MAX_SKILL_SCAN_DEPTH = 8;

// ─── Context types ────────────────────────────────────────────────────────────

export interface SkillPathContext {
  readonly userHomeDir: string;
  readonly workDir: string;
}

export interface ResolveSkillRootsOptions {
  readonly paths: SkillPathContext;
  readonly builtinDir?: string;
  readonly explicitDirs?: readonly string[];
  readonly extraDirs?: readonly string[];
  readonly pluginSkillRoots?: readonly SkillRoot[];
  readonly mergeAllAvailableSkills?: boolean;
  readonly realpath?: (p: string) => Promise<string>;
  readonly isDir?: (p: string) => Promise<boolean>;
}

export interface DiscoverSkillsOptions {
  readonly roots: readonly SkillRoot[];
  readonly onWarning?: (message: string, cause?: unknown) => void;
  readonly onSkippedByPolicy?: (skill: SkippedSkill) => void;
  readonly onDiscoveredSkill?: (skill: SkillDefinition) => void;
  readonly readdir?: (p: string) => Promise<readonly string[]>;
  readonly isFile?: (p: string) => Promise<boolean>;
  readonly isDir?: (p: string) => Promise<boolean>;
  readonly parse?: (input: {
    readonly skillMdPath: string;
    readonly skillDirName: string;
    readonly source: SkillSource;
  }) => Promise<SkillDefinition>;
}

// ─── Root Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve all skill roots from the given configuration.
 *
 * Priority order:
 * 1. Project .q/skills/
 * 2. User $HOME/.Q/skills/
 * 3. Extra dirs (from config or --skills-dir)
 * 4. Plugin roots
 * 5. Builtin dir
 */
export async function resolveSkillRoots(
  options: ResolveSkillRootsOptions,
): Promise<readonly SkillRoot[]> {
  const isDir = options.isDir ?? defaultIsDir;
  const realpath =
    options.realpath ??
    ((p: string) => fs.realpath(p).then((r) => r.replaceAll('\\', '/')));
  const roots: SkillRoot[] = [];
  const mergeAllAvailableSkills = options.mergeAllAvailableSkills ?? true;
  const { userHomeDir, workDir } = options.paths;
  const projectRoot = await findProjectRoot(workDir);

  // Explicit dirs bypass normal root resolution
  if (options.explicitDirs !== undefined && options.explicitDirs.length > 0) {
    await pushConfiguredDirs(
      roots,
      options.explicitDirs,
      projectRoot,
      userHomeDir,
      'user',
      isDir,
      realpath,
    );
  } else {
    // Project brand dirs: .q/skills/
    await pushBrandGroup(
      roots,
      PROJECT_BRAND_DIRS,
      projectRoot,
      'project',
      mergeAllAvailableSkills,
      isDir,
      realpath,
    );
    // Project generic dirs: .agents/skills/
    await pushFirstExisting(roots, PROJECT_GENERIC_DIRS, projectRoot, 'project', isDir, realpath);

    // User brand dirs: $HOME/.Q/skills/
    const userVDir = path.join(userHomeDir, '.Q');
    await pushBrandGroup(
      roots,
      USER_BRAND_DIRS,
      userVDir,
      'user',
      mergeAllAvailableSkills,
      isDir,
      realpath,
    );
    // User generic dirs: $HOME/.agents/skills/
    await pushFirstExisting(roots, USER_GENERIC_DIRS, userHomeDir, 'user', isDir, realpath);
  }

  // Extra directories from config or --skills-dir
  if (options.extraDirs !== undefined) {
    await pushConfiguredDirs(
      roots,
      options.extraDirs,
      projectRoot,
      userHomeDir,
      'extra',
      isDir,
      realpath,
    );
  }

  // Plugin skill roots
  if (options.pluginSkillRoots !== undefined) {
    for (const root of options.pluginSkillRoots) {
      await pushProvidedRoot(roots, root, isDir, realpath);
    }
  }

  // Builtin skill directory
  if (options.builtinDir !== undefined) {
    await pushExistingRoot(roots, options.builtinDir, 'builtin', isDir, realpath);
  }

  return roots;
}

// ─── Skill Discovery ──────────────────────────────────────────────────────────

/**
 * Discover skills by walking skill roots.
 *
 * - Directory skills: <name>/SKILL.md — name derived from directory name.
 * - Flat skills: <name>.md at the top level — name derived from filename.
 * - node_modules, dotfiles, and dotdirs are excluded.
 * - Max scan depth is 8.
 * - Dedup on case-insensitive normalized name (first wins).
 */
export async function discoverSkills(
  options: DiscoverSkillsOptions,
): Promise<readonly SkillDefinition[]> {
  const readdir = options.readdir ?? ((p: string) => fs.readdir(p));
  const isFile = options.isFile ?? defaultIsFile;
  const isDir = options.isDir ?? defaultIsDir;
  const parse = options.parse ?? parseSkillFromFile;
  const warn = options.onWarning ?? (() => {});
  const skip = options.onSkippedByPolicy ?? (() => {});
  const byName = new Map<string, SkillDefinition>();

  async function walkSkillDir(
    dirPath: string,
    root: SkillRoot,
    isTopLevel: boolean,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_SKILL_SCAN_DEPTH) return;

    let entries: readonly string[];
    try {
      entries = [...(await readdir(dirPath))].sort();
    } catch (error) {
      warn(`Failed to read skill directory ${dirPath}`, error);
      return;
    }

    const directorySkills = new Set<string>();
    const subdirs: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry);

      // A directory holding SKILL.md is a skill bundle
      if (await isFile(path.join(entryPath, 'SKILL.md'))) {
        directorySkills.add(entry);
        continue;
      }

      // Skip node_modules and dotfiles/dotdirs
      if (entry === 'node_modules' || entry.startsWith('.')) continue;

      if (await isDir(entryPath)) subdirs.push(entry);
    }

    // Register directory skills
    for (const entry of directorySkills) {
      await parseAndRegister({
        parse,
        byName,
        skillMdPath: path.join(dirPath, entry, 'SKILL.md'),
        skillDirName: entry,
        root,
        onDiscoveredSkill: options.onDiscoveredSkill,
        warn,
        skip,
      });
    }

    // Flat .md skills count only at a root's top level
    if (isTopLevel) {
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        if (entry === 'SKILL.md') continue;

        const skillName = entry.slice(0, -'.md'.length);
        if (directorySkills.has(skillName)) {
          warn(
            `Ignoring flat skill ${path.join(dirPath, entry)} because ${path.join(dirPath, skillName, 'SKILL.md')} exists with the same name`,
          );
          continue;
        }

        const skillMdPath = path.join(dirPath, entry);
        if (!(await isFile(skillMdPath))) continue;

        await parseAndRegister({
          parse,
          byName,
          skillMdPath,
          skillDirName: skillName,
          root,
          onDiscoveredSkill: options.onDiscoveredSkill,
          warn,
          skip,
        });
      }
    }

    // Recurse into subdirectories
    for (const entry of subdirs) {
      await walkSkillDir(path.join(dirPath, entry), root, false, depth + 1);
    }
  }

  for (const root of options.roots) {
    await walkSkillDir(root.path, root, true, 0);
  }

  return sortSkills([...byName.values()]);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sortSkills(skills: readonly SkillDefinition[]): readonly SkillDefinition[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

async function pushFirstExisting(
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
  isDir: (p: string) => Promise<boolean>,
  realpath: (p: string) => Promise<string>,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(out, path.join(base, dir), source, isDir, realpath)) return;
  }
}

async function pushBrandGroup(
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
  mergeAllAvailableSkills: boolean,
  isDir: (p: string) => Promise<boolean>,
  realpath: (p: string) => Promise<string>,
): Promise<void> {
  if (!mergeAllAvailableSkills) {
    await pushFirstExisting(out, dirs, base, source, isDir, realpath);
    return;
  }
  for (const dir of dirs) {
    await pushExistingRoot(out, path.join(base, dir), source, isDir, realpath);
  }
}

async function pushConfiguredDirs(
  out: SkillRoot[],
  dirs: readonly string[],
  projectRoot: string,
  userHomeDir: string,
  source: SkillSource,
  isDir: (p: string) => Promise<boolean>,
  realpath: (p: string) => Promise<string>,
): Promise<void> {
  for (const dir of dirs) {
    await pushExistingRoot(
      out,
      resolveConfiguredDir(dir, projectRoot, userHomeDir),
      source,
      isDir,
      realpath,
    );
  }
}

async function pushExistingRoot(
  out: SkillRoot[],
  dir: string,
  source: SkillSource,
  isDir: (p: string) => Promise<boolean>,
  realpath: (p: string) => Promise<string>,
): Promise<boolean> {
  if (!(await isDir(dir))) return false;
  const resolved = await realpath(dir);
  if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
  return true;
}

async function pushProvidedRoot(
  out: SkillRoot[],
  root: SkillRoot,
  isDir: (p: string) => Promise<boolean>,
  realpath: (p: string) => Promise<string>,
): Promise<boolean> {
  if (!(await isDir(root.path))) return false;
  const resolved = await realpath(root.path);
  if (!out.some((existing) => existing.path === resolved)) {
    out.push({ ...root, path: resolved });
    return true;
  }
  return true;
}

async function parseAndRegister(input: {
  readonly parse: NonNullable<DiscoverSkillsOptions['parse']>;
  readonly byName: Map<string, SkillDefinition>;
  readonly skillMdPath: string;
  readonly skillDirName: string;
  readonly root: SkillRoot;
  readonly onDiscoveredSkill?: (skill: SkillDefinition) => void;
  readonly warn: (message: string, cause?: unknown) => void;
  readonly skip: (skill: SkippedSkill) => void;
}): Promise<void> {
  try {
    const skill = await input.parse({
      skillMdPath: input.skillMdPath,
      skillDirName: input.skillDirName,
      source: input.root.source,
    });
    input.onDiscoveredSkill?.(skill);
    const key = normalizeSkillName(skill.name);
    // First wins: do not overwrite if already registered
    if (!input.byName.has(key)) {
      input.byName.set(key, skill);
    }
  } catch (error) {
    if (error instanceof UnsupportedSkillTypeError) {
      input.skip({
        path: input.skillMdPath,
        type: error.skillType,
        reason: `unsupported skill type "${error.skillType}"`,
      });
    } else if (error instanceof SkillParseError) {
      input.warn(`Skipping invalid skill at ${input.skillMdPath}: ${error.message}`, error);
    } else {
      input.warn(`Skipping skill at ${input.skillMdPath} due to unexpected error`, error);
    }
  }
}

async function defaultIsDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function defaultIsFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function findProjectRoot(workDir: string): Promise<string> {
  const start = path.resolve(workDir);
  let current = start;
  while (true) {
    if (await exists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function resolveConfiguredDir(dir: string, projectRoot: string, userHomeDir: string): string {
  if (dir === '~') return userHomeDir;
  if (dir.startsWith('~/')) return path.join(userHomeDir, dir.slice(2));
  if (path.isAbsolute(dir)) return dir;
  return path.resolve(projectRoot, dir);
}
