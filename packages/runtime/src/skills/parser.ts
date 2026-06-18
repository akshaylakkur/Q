/**
 * Skills — Parser
 *
 * Reads SKILL.md files with YAML frontmatter between --- fences,
 * extracting metadata using js-yaml and the markdown body.
 * Supports argument expansion in skill templates.
 */
import { readFile } from 'node:fs/promises';
import path from 'pathe';
import { load as loadYaml } from 'js-yaml';

import type { SkillDefinition, SkillMetadata, SkillSource, SkillArgument } from './types';
import { isSupportedSkillType } from './types';

// ─── Error Classes ───────────────────────────────────────────────────────────

export class FrontmatterError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FrontmatterError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, configurable: true });
    }
  }
}

export class SkillParseError extends Error {
  readonly reason?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SkillParseError';
    if (cause !== undefined) this.reason = cause;
  }
}

export class UnsupportedSkillTypeError extends Error {
  readonly skillType: string;

  constructor(skillType: string) {
    super(
      `Skill type "${skillType}" is not supported; only "prompt", "inline", and "flow" are supported.`,
    );
    this.name = 'UnsupportedSkillTypeError';
    this.skillType = skillType;
  }
}

// ─── Options and context types ───────────────────────────────────────────────

export interface ParseSkillOptions {
  readonly skillMdPath: string;
  readonly skillDirName: string;
  readonly source: SkillSource;
}

export interface ParseSkillTextOptions extends ParseSkillOptions {
  readonly text: string;
}

export interface SkillExpandContext {
  readonly skillDir: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly argumentNames?: readonly string[];
}

export interface ParsedFrontmatter {
  readonly data: unknown;
  readonly body: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const FENCE = '---';

const METADATA_ALIASES: Readonly<Record<string, string>> = {
  'when-to-use': 'whenToUse',
  when_to_use: 'whenToUse',
  'disable-model-invocation': 'disableModelInvocation',
  disable_model_invocation: 'disableModelInvocation',
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a skill definition from a SKILL.md file on disk.
 */
export async function parseSkillFromFile(options: ParseSkillOptions): Promise<SkillDefinition> {
  let text: string;
  try {
    text = await readFile(options.skillMdPath, 'utf8');
  } catch (error) {
    throw new SkillParseError(`Failed to read ${options.skillMdPath}`, error);
  }
  return parseSkillText({ ...options, text });
}

/**
 * Parse YAML frontmatter from a markdown text.
 *
 * Looks for `---` fences at the start of the text.
 * Returns { data, body } where body is everything after the closing fence.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) {
    return { data: null, body: text };
  }

  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (close === -1) {
    throw new FrontmatterError('Missing closing frontmatter fence');
  }

  const yamlText = lines.slice(1, close).join('\n').trim();
  const body = lines.slice(close + 1).join('\n');
  if (yamlText === '') {
    return { data: {}, body };
  }

  try {
    return { data: loadYaml(yamlText) ?? {}, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FrontmatterError(message, error);
  }
}

/**
 * Parse a skill definition from text content (already in memory).
 *
 * For directory skills (SKILL.md as filename), frontmatter with name
 * and description is required. For flat .md skills, name is derived
 * from the filename and description from the first content line.
 */
export function parseSkillText(options: ParseSkillTextOptions): SkillDefinition {
  const isDirectorySkill = path.basename(options.skillMdPath) === 'SKILL.md';
  if (isDirectorySkill && options.text.split(/\r?\n/, 1)[0]?.trim() !== FENCE) {
    throw new SkillParseError(`Missing frontmatter in ${options.skillMdPath}`);
  }

  let parsed: ParsedFrontmatter;
  try {
    parsed = parseFrontmatter(options.text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw new SkillParseError(
        `Invalid frontmatter in ${options.skillMdPath}: ${error.message}`,
        error,
      );
    }
    throw error;
  }

  const frontmatter = parsed.data ?? {};
  if (!isRecord(frontmatter)) {
    throw new SkillParseError(
      `Frontmatter in ${options.skillMdPath} must be a mapping at the top level`,
    );
  }

  const metadata = normalizeMetadata(frontmatter);
  if (!isSupportedSkillType(metadata.type)) {
    throw new UnsupportedSkillTypeError(metadata.type ?? String(frontmatter['type']));
  }

  const name = nonEmptyString(metadata.name);
  const description = nonEmptyString(metadata.description);
  if (isDirectorySkill && (name === undefined || description === undefined)) {
    const field = name === undefined ? '"name"' : '"description"';
    throw new SkillParseError(
      `Missing required frontmatter field ${field} in ${options.skillMdPath}`,
    );
  }

  const skillPath = path.resolve(options.skillMdPath);
  const content = parsed.body.trim();
  return {
    name: name ?? options.skillDirName,
    description: description ?? descriptionFromBody(content),
    path: skillPath,
    dir: path.dirname(skillPath),
    content,
    metadata,
    source: options.source,
  };
}

/**
 * Extract declared argument names from skill metadata.
 *
 * Supports both array-of-object form (with `name` field) and
 * space-separated string form.
 */
export function skillArgumentNames(metadata: SkillMetadata): readonly string[] {
  const value = metadata.arguments;
  const isValidName = (name: string): boolean =>
    name.trim() !== '' && !/^\d+$/.test(name);

  if (typeof value === 'string') return value.split(/\s+/).filter(isValidName);

  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is SkillArgument | string => item !== null && item !== undefined)
    .map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item === 'object' && 'name' in item) return (item as SkillArgument).name;
      return '';
    })
    .filter(isValidName);
}

/**
 * Expand argument placeholders in a skill body.
 *
 * Placeholder syntax:
 *   $ARGUMENTS      → full raw args string
 *   $ARGUMENTS[N]   → Nth token
 *   $<name>         → named argument (for declared arguments)
 *   $0, $1, etc.    → positional arguments
 *   ${Q_SKILL_DIR}  → skill directory
 *   ${Q_SESSION_ID} → session ID
 *   ${Q_CWD}        → current working directory
 *
 * If no argument placeholder is found and rawArgs is non-empty,
 * appends "ARGUMENTS: <rawArgs>" at the end.
 */
export function expandSkillParameters(
  body: string,
  rawArgs: string,
  context: SkillExpandContext,
): string {
  const tokens = tokenizeArgs(rawArgs);
  let content = body;

  // Expand named $<name> placeholders for declared arguments (positional)
  const argumentNames = context.argumentNames ?? [];
  for (let index = 0; index < argumentNames.length; index++) {
    const name = argumentNames[index];
    if (name === undefined) continue;
    const escaped = escapeRegex(name);
    content = content.replaceAll(
      new RegExp(`\\$${escaped}(?![\\[\\w])`, 'g'),
      tokens[index] ?? '',
    );
  }

  // $ARGUMENTS[N] → Nth token
  content = content.replaceAll(/\$ARGUMENTS\[(\d+)\]/g, (_match, indexText: string) => {
    const index = Number.parseInt(indexText, 10);
    return tokens[index] ?? '';
  });

  // $N (positional, e.g., $0, $1) → Nth token
  content = content.replaceAll(/\$(\d+)(?!\w)/g, (_match, indexText: string) => {
    const index = Number.parseInt(indexText, 10);
    return tokens[index] ?? '';
  });

  // $ARGUMENTS → full raw args string
  content = content.replaceAll('$ARGUMENTS', rawArgs);

  // Track whether any argument placeholder was expanded
  const hasArgumentPlaceholder = content !== body;

  // Template variables
  content = content
    .replaceAll('${Q_SKILL_DIR}', context.skillDir)
    .replaceAll('${Q_SESSION_ID}', context.sessionId ?? '')
    .replaceAll('${Q_CWD}', context.cwd ?? '');

  // If no argument placeholder was used but args were given, append them
  if (!hasArgumentPlaceholder && rawArgs.length > 0) {
    return `${content}\n\nARGUMENTS: ${rawArgs}`;
  }

  return content;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function normalizeMetadata(raw: Record<string, unknown>): SkillMetadata {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = METADATA_ALIASES[rawKey] ?? rawKey;
    out[key] = value;
  }

  const type = nonEmptyString(out['type']);
  if (type !== undefined) out['type'] = type;

  const name = nonEmptyString(out['name']);
  if (name !== undefined) out['name'] = name;

  const description = nonEmptyString(out['description']);
  if (description !== undefined) out['description'] = description;

  // Normalize arguments from YAML array-of-objects format if applicable
  if (Array.isArray(out['arguments'])) {
    out['arguments'] = (out['arguments'] as unknown[]).map((arg) => {
      if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
        const a = arg as Record<string, unknown>;
        return {
          name: String(a['name'] ?? ''),
          description: String(a['description'] ?? ''),
          required: Boolean(a['required']),
        };
      }
      return arg;
    });
  }

  return out as SkillMetadata;
}

function descriptionFromBody(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return 'No description provided.';
  return firstLine.length > 240 ? `${firstLine.slice(0, 239)}…` : firstLine;
}

/**
 * Tokenize a raw argument string, respecting single and double quotes.
 */
function tokenizeArgs(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let hasContent = false;

  for (const char of raw) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
        hasContent = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        out.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }

  if (hasContent) out.push(current);
  return out;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Escape regex special characters in a string.
 */
function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
