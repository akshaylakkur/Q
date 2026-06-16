/**
 * Profile loader — Loads agent profiles from YAML files, resolves
 * the extends chain, and renders system prompt templates.
 *
 * Uses a minimal custom YAML parser sufficient for our profile schema.
 *
 * Supports two modes:
 *   1. **Filesystem** — Loads YAML files from a profiles directory (dev mode)
 *   2. **Embedded** — Loads profiles from an in-memory registry (SEA binary mode)
 */

import { readFileSync } from "node:fs";
import { readdirSync, existsSync } from "node:fs";
import { join, extname, dirname } from "pathe";

/** Raw profile data parsed from YAML */
export interface RawProfile {
  name: string;
  extends?: string | null;
  description?: string;
  systemPromptTemplate?: string;
  promptVars?: Record<string, string>;
  tools?: string[];
  subagents?: string[];
}

/** Resolved profile after merging extends chain */
export interface ResolvedProfile {
  name: string;
  description: string;
  systemPromptTemplate: string;
  promptVars: Record<string, string>;
  tools: string[];
  subagents: string[];
}

/** Template variables provided at render time */
export interface RenderContext {
  cwd: string;
  model: string;
  sessionId: string;
  toolDescriptions: string;
  skillListing: string;
  profileName: string;
  [key: string]: string;
}

// ── Embedded profile registry ──────────────────────────────────────────────
// Used in SEA binary mode where there is no filesystem to read YAML files from.

const EMBEDDED_PROFILES: Record<string, string> = {};

/**
 * Register a profile YAML string in the embedded registry.
 * Called at module load time by the profiles index.
 */
export function registerEmbeddedProfile(name: string, yaml: string): void {
  EMBEDDED_PROFILES[name] = yaml;
}

/**
 * Resolve the directory that holds the agent-core profile YAML files.
 *
 * Two cases to handle:
 *
 * 1. **Dev / source:** `import.meta.url` points at the source file under
 *    `packages/agent-core/src/agent/profiles/`, so `dirname(...)` already
 *    is the profiles directory.
 *
 * 2. **Built bundle:** `import.meta.url` points at `dist/index.mjs` (a
 *    single-file bundle). The profiles directory no longer exists next
 *    to the file. Walk up the tree from `dist/` looking for the
 *    `@q/agent-core` package root, then look for the bundled profiles
 *    directory. If that also fails, fall back to `process.cwd()` and
 *    the consumer's resolved work directory.
 *
 * The result is cached so the walk happens at most once per process.
 */
function resolveProfileDir(): string {
  // 1. The directory of the source/bundled file
  const here = dirname(new URL(import.meta.url).pathname);
  if (existsSync(join(here, "auto.yaml"))) {
    return here;
  }

  // 2. Walk up the tree from here looking for a `profiles/` directory that
  //    contains `auto.yaml` (the canonical profile). This handles
  //    pnpm hoisting, monorepo layouts, and the bundled dist case where
  //    the YAMLs are copied alongside `dist/`.
  let cursor = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cursor, "profiles");
    if (existsSync(join(candidate, "auto.yaml"))) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  // 3. Last resort: try alongside `node_modules/@q/agent-core/profiles`.
  //    This is for pnpm-style installs where the package is nested.
  const nmPath = join(here, "..", "..", "..", "profiles");
  if (existsSync(join(nmPath, "auto.yaml"))) {
    return nmPath;
  }

  return here; // Will return empty profiles; loader returns empty map.
}

const PROFILE_DIR = resolveProfileDir();

/** Simple template renderer (replaces {{ varName }} with values) */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match: string, key: string): string => {
    if (key in vars) return vars[key] as string;
    return "{{ " + key + " }}";
  });
}

/**
 * Parse a simple YAML string of the form:
 *
 *   key: scalar
 *   key: ~
 *   key: >
 *     block text
 *   key:
 *     subkey: value
 *   key:
 *     - item1
 *     - item2
 *
 * Returns a flat map where nested maps are stored as their own Record.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Normalize line endings
  const text = yaml.replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  // First pass: identify top-level keys and their content
  // A top-level key is a non-empty, non-comment, non-indented line containing ":"
  const topLevelKeys: Array<{ key: string; start: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // Top-level keys are not indented
    if (line[0] === " " || line[0] === "\t") continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key === "") continue;
    topLevelKeys.push({ key, start: i });
  }

  // Process each top-level entry
  for (let tk = 0; tk < topLevelKeys.length; tk++) {
    const entry = topLevelKeys[tk] as { key: string; start: number };
    const { key, start } = entry;
    const nextEntry = tk + 1 < topLevelKeys.length ? topLevelKeys[tk + 1] : undefined;
    const end = nextEntry ? nextEntry.start : lines.length;

    // Get the value portion on the same line
    const firstLine = lines[start] as string;
    const colonIdx = firstLine.indexOf(":");
    const valuePart = firstLine.slice(colonIdx + 1).trim();

    // Extract the content lines belonging to this key (excluding the first line)
    const contentLines = lines.slice(start + 1, end);
    // Remove trailing empty lines
    while (contentLines.length > 0 && (contentLines[contentLines.length - 1] as string).trim() === "") {
      contentLines.pop();
    }

    if (valuePart === "|" || valuePart === ">") {
      // Block scalar — collect indented lines
      const blockText = collectBlockLines(contentLines);
      result[key] = blockText;
    } else if (valuePart === "" || valuePart === "-") {
      // Could be a list or a nested map — check actual content
      const nonEmpty = contentLines.find((l: string) => l.trim() !== "");
      if (!nonEmpty) {
        result[key] = [];
        continue;
      }
      const trimmedFE = (nonEmpty as string).trim();
      if (trimmedFE.startsWith("- ")) {
        // List
        const items = collectListItems(contentLines);
        result[key] = items;
      } else if (trimmedFE.includes(":")) {
        // Nested map
        const subMap = collectMapEntries(contentLines);
        result[key] = subMap;
      } else {
        result[key] = "";
      }
    } else if (valuePart === "~" || valuePart === "null") {
      result[key] = null;
    } else if (valuePart === "true") {
      result[key] = true;
    } else if (valuePart === "false") {
      result[key] = false;
    } else if (
      (valuePart.startsWith('"') && valuePart.endsWith('"')) ||
      (valuePart.startsWith("'") && valuePart.endsWith("'"))
    ) {
      result[key] = valuePart.slice(1, -1);
    } else {
      result[key] = valuePart;
    }
  }

  return result;
}

/** Collect block scalar text from indented content lines */
function collectBlockLines(lines: string[]): string {
  const blockLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" && blockLines.length > 0) {
      blockLines.push("");
    } else if (trimmed !== "") {
      blockLines.push(trimmed);
    }
  }
  // Trim trailing blank lines
  while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
    blockLines.pop();
  }
  return blockLines.join("\n");
}

/** Collect list items from indented content lines */
function collectListItems(lines: string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2).trim());
    } else if (trimmed === "-") {
      items.push("");
    }
  }
  return items;
}

/** Collect nested map entries from indented content lines */
function collectMapEntries(lines: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const k = trimmed.slice(0, colonIdx).trim();
    let v = trimmed.slice(colonIdx + 1).trim();
    // Remove surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) {
      map[k] = v;
    }
  }
  return map;
}

/** Convert parsed YAML map to RawProfile */
function yamlToRawProfile(raw: Record<string, unknown>): RawProfile {
  const profile: RawProfile = {
    name: String(raw.name ?? ""),
  };

  if (raw.extends !== undefined && raw.extends !== null) {
    const ext = raw.extends;
    profile.extends = ext === true || ext === false ? undefined : String(ext);
  }
  if (raw.description && typeof raw.description === "string") {
    profile.description = raw.description as string;
  }
  if (raw.systemPromptTemplate && typeof raw.systemPromptTemplate === "string") {
    profile.systemPromptTemplate = raw.systemPromptTemplate as string;
  }
  if (raw.promptVars && typeof raw.promptVars === "object" && !Array.isArray(raw.promptVars)) {
    profile.promptVars = raw.promptVars as Record<string, string>;
  }
  if (Array.isArray(raw.tools)) {
    profile.tools = (raw.tools as string[]).map(String);
  }
  if (Array.isArray(raw.subagents)) {
    profile.subagents = (raw.subagents as string[]).map(String);
  }

  return profile;
}

/** Parse a YAML string into a RawProfile */
function parseYamlString(yaml: string): RawProfile | null {
  try {
    const parsed = parseSimpleYaml(yaml);
    return yamlToRawProfile(parsed);
  } catch {
    return null;
  }
}

/** Load a single YAML profile file */
function loadProfileFile(filePath: string): RawProfile | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    return parseYamlString(content);
  } catch {
    return null;
  }
}

/** Load all profile files from the profiles directory */
export function loadAllProfiles(
  profileDir?: string,
): Record<string, RawProfile> {
  const dir = profileDir ?? PROFILE_DIR;
  const profiles: Record<string, RawProfile> = {};

  // 1. Try loading from filesystem
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f: string) => extname(f).toLowerCase() === ".yaml",
    );
  } catch {
    files = [];
  }

  for (const file of files) {
    const filePath = join(dir, file);
    const profile = loadProfileFile(filePath);
    if (profile && profile.name) {
      profiles[profile.name] = profile;
    }
  }

  // 2. Fall back to embedded profiles (for SEA binary mode)
  //    Only use embedded if filesystem returned nothing, to allow
  //    dev mode to still work with live YAML files.
  if (Object.keys(profiles).length === 0 && Object.keys(EMBEDDED_PROFILES).length > 0) {
    for (const [name, yaml] of Object.entries(EMBEDDED_PROFILES)) {
      const profile = parseYamlString(yaml);
      if (profile && profile.name) {
        profiles[profile.name] = profile;
      }
    }
  }

  return profiles;
}

/** Resolve a profile by walking the extends chain with cycle detection */
export function resolveAgentProfile(
  profileName: string,
  profileMap: Record<string, RawProfile>,
): ResolvedProfile | null {
  const visited = new Set<string>();
  const chain: RawProfile[] = [];
  let current: RawProfile | undefined = profileMap[profileName];

  if (!current) return null;

  while (current) {
    if (visited.has(current.name)) {
      throw new Error(
        "Circular profile extends chain detected: " +
        Array.from(visited).join(" -> ") +
        " -> " + current.name,
      );
    }
    visited.add(current.name);
    chain.push(current);

    if (!current.extends) break;
    const parent: RawProfile | undefined = profileMap[current.extends];
    if (!parent) {
      throw new Error(
        'Profile "' + current.name + '" extends "' + current.extends + '" but that profile was not found',
      );
    }
    current = parent;
  }

  // Walk chain from parent-most to child to apply merges
  const resolved: ResolvedProfile = {
    name: profileName,
    description: "",
    systemPromptTemplate: "",
    promptVars: {},
    tools: [],
    subagents: [],
  };

  for (const raw of chain.reverse()) {
    // Override entire tool list if child specifies tools
    if (raw.tools !== undefined) {
      resolved.tools = [...raw.tools];
    }
    // Override system prompt template if child specifies one
    if (raw.systemPromptTemplate !== undefined) {
      resolved.systemPromptTemplate = raw.systemPromptTemplate;
    }
    // Override description if child specifies one
    if (raw.description !== undefined) {
      resolved.description = raw.description;
    }
    // Shallow merge promptVars (child wins)
    if (raw.promptVars !== undefined) {
      resolved.promptVars = { ...resolved.promptVars, ...raw.promptVars };
    }
    // Merge subagents (children add to parent's list)
    if (raw.subagents !== undefined) {
      resolved.subagents = mergeUnique(resolved.subagents, raw.subagents);
    }
  }

  return resolved;
}

/** Merge two arrays, keeping only unique values, preserving order */
function mergeUnique<T>(base: T[], addition: T[]): T[] {
  const set = new Set(base);
  const result = [...base];
  for (const item of addition) {
    if (!set.has(item)) {
      set.add(item);
      result.push(item);
    }
  }
  return result;
}

/**
 * Resolve multiple profiles and return them in a map.
 * Each profile is independently resolved with its own extends chain.
 */
export function resolveAgentProfiles(
  profileNames: string[],
  profileMap: Record<string, RawProfile>,
): Record<string, ResolvedProfile> {
  const resolved: Record<string, ResolvedProfile> = {};
  for (const name of profileNames) {
    const r = resolveAgentProfile(name, profileMap);
    if (r) resolved[name] = r;
  }
  return resolved;
}

/**
 * SystemPromptRenderer — Renders a resolved profile's system prompt template
 * with agent-specific variables.
 */
export class SystemPromptRenderer {
  private readonly profile: ResolvedProfile;

  constructor(profile: ResolvedProfile) {
    this.profile = profile;
  }

  /** Render the system prompt template with given context variables */
  render(context: Partial<RenderContext>): string {
    const vars: Record<string, string> = {};
    // Start with profile defaults
    if (this.profile.promptVars) {
      for (const [k, v] of Object.entries(this.profile.promptVars)) {
        vars[k] = v;
      }
    }
    // Override with provided context
    for (const [k, v] of Object.entries(context)) {
      if (v !== undefined) {
        vars[k] = v;
      }
    }
    return renderTemplate(this.profile.systemPromptTemplate, vars);
  }
}
