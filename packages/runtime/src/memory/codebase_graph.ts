/**
 * CodebaseGraphIndex — Live codebase graph: symbol table, module graph, dependency tree.
 *
 * Maintains a continuously updated, language-aware model of the entire workspace.
 * Supports incremental refresh on file changes, query methods for symbols, modules,
 * dependencies, boundary checks, and JSON persistence to $HOME/.Q/memory/.
 *
 * Step 26: Full implementation with regex-based import/symbol parsing across
 * TypeScript/JavaScript, Python, Rust, Go, and Java.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, rename, writeFile, mkdir, access, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative, dirname, basename, extname } from "node:path";
import { glob } from "node:fs/promises";
import { homedir } from "node:os";

// =========================================================================
// Types
// =========================================================================

export interface SymbolDef {
  name: string;
  kind: "class" | "function" | "type" | "constant" | "interface" | "method" | "variable";
  scope: "public" | "private" | "exported" | "internal";
  location: { file: string; line: number; column: number };
}

export interface ImportEntry {
  source: string;
  symbols: string[];
  type: "named" | "default" | "namespace" | "side-effect";
}

export interface FileNode {
  symbols: SymbolDef[];
  imports: ImportEntry[];
  language: string;
  astHash: string;
  mtime: number;
}

export interface SymbolRef {
  location: { file: string; line: number; column: number };
  kind: "class" | "function" | "type" | "constant" | "interface" | "method" | "variable";
  scope: "public" | "private" | "exported" | "internal";
}

export interface Module {
  entryPoints: string[];
  internalDeps: string[];
  externalDeps: string[];
}

export interface DependencyRule {
  source: string;
  target: string;
  allowed: boolean;
}

export type BoundaryVerdict = "allowed" | "blocked" | "no_rule";

export interface Location {
  file: string;
  line: number;
  column: number;
}

// =========================================================================
// Config
// =========================================================================

export interface CodebaseGraphConfig {
  /** Root directory for persistence (default $HOME/.Q/memory) */
  persistRoot?: string;
  /** Maximum depth for workspace traversal */
  maxDepth?: number;
  /** Auto-flush interval in ms (default 30000) */
  autoFlushInterval?: number;
  /** Include only files matching these glob pattern(s) */
  includePatterns?: string[];
  /** Exclude patterns */
  excludePatterns?: string[];
}

const DEFAULT_CONFIG: Required<CodebaseGraphConfig> = {
  persistRoot: "",
  maxDepth: 20,
  autoFlushInterval: 30000,
  includePatterns: ["**/*.{ts,js,tsx,jsx,mjs,cjs,mts,cts,py,rs,go,java}"],
  excludePatterns: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/coverage/**", "**/.q/**", "**/target/**"],
};

// =========================================================================
// Language Map
// =========================================================================

const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript-react",
  js: "javascript",
  jsx: "javascript-react",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
};

// =========================================================================
// Regex-Based Import + Symbol Parsers
// =========================================================================

interface ParseResult {
  imports: ImportEntry[];
  symbols: SymbolDef[];
}

// ---- TypeScript ----

function parseTypeScript(content: string, filePath: string): ParseResult {
  const imports: ImportEntry[] = [];
  const symbols: SymbolDef[] = [];
  const lines = content.split("\n");

  // Import statements
  const importRegex = /(?:import\s+(?:(?:\{[^}]*\}|[^;{]+)\s+from\s+)?["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    const source = m[1] ?? m[2] ?? "";
    if (source) {
      imports.push({ source, symbols: [], type: "named" });
    }
  }

  // Dynamic import()
  const dynamicImportRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamicImportRegex.exec(content)) !== null) {
    if (m[1]) {
      imports.push({ source: m[1], symbols: [], type: "side-effect" });
    }
  }

  // Export / symbol declarations per line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // export default class X / export default function X
    const exportDefaultMatch = line.match(/export\s+default\s+(class|function)\s+(\w+)/);
    if (exportDefaultMatch) {
      const kind = exportDefaultMatch[1] === "class" ? "class" as const : "function" as const;
      symbols.push({ name: exportDefaultMatch[2]!, kind, scope: "exported", location: { file: filePath, line: lineNum, column: line.indexOf(exportDefaultMatch[0]) + 1 } });
    }

    // export default X (identifier)
    const exportDefaultIdMatch = line.match(/export\s+default\s+(\w+)\s*[;=]/);
    if (exportDefaultIdMatch && !exportDefaultMatch) {
      symbols.push({ name: exportDefaultIdMatch[1]!, kind: "function", scope: "exported", location: { file: filePath, line: lineNum, column: line.indexOf(exportDefaultIdMatch[0]) + 1 } });
    }

    // export class X / export interface X / export type X / export function X / export const X / export enum X / export abstract class X
    const exportKWMatch = line.match(/export\s+(?:abstract\s+)?(class|interface|type|function|const|enum|let|var)\s+(\w+)/);
    if (exportKWMatch) {
      const kw = exportKWMatch[1]!;
      const name = exportKWMatch[2]!;
      let kind: SymbolDef["kind"];
      if (kw === "class" || kw === "enum") kind = "class";
      else if (kw === "interface") kind = "interface";
      else if (kw === "type") kind = "type";
      else if (kw === "function") kind = "function";
      else if (kw === "const") kind = "constant";
      else kind = "variable";
      symbols.push({ name, kind, scope: "exported", location: { file: filePath, line: lineNum, column: line.indexOf(exportKWMatch[0]) + 1 } });
    }

    // export { X, Y } — named export list
    const exportListMatch = line.match(/export\s+\{([^}]+)\}/);
    if (exportListMatch) {
      const names = exportListMatch[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
      for (const name of names) {
        symbols.push({ name, kind: "variable", scope: "exported", location: { file: filePath, line: lineNum, column: line.indexOf(name) + 1 } });
      }
    }

    // class X (non-exported, top-level)
    const classMatch = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch && !line.includes("export class") && !line.includes("export default class") && !line.includes("export abstract class")) {
      // Check if already added via export
      if (!symbols.some((s) => s.name === classMatch[1] && s.scope === "exported")) {
        symbols.push({ name: classMatch[1]!, kind: "class", scope: "internal", location: { file: filePath, line: lineNum, column: line.indexOf(classMatch[0]) + 1 } });
      }
    }

    // interface X (non-exported, top-level)
    const ifaceMatch = line.match(/^\s*(?:export\s+)?interface\s+(\w+)/);
    if (ifaceMatch && !line.includes("export interface")) {
      if (!symbols.some((s) => s.name === ifaceMatch[1] && s.scope === "exported")) {
        symbols.push({ name: ifaceMatch[1]!, kind: "interface", scope: "internal", location: { file: filePath, line: lineNum, column: line.indexOf(ifaceMatch[0]) + 1 } });
      }
    }

    // function X (non-exported, top-level)
    const funcMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (funcMatch && !line.includes("export function") && !line.includes("export default function")) {
      if (!symbols.some((s) => s.name === funcMatch[1] && s.scope === "exported")) {
        symbols.push({ name: funcMatch[1]!, kind: "function", scope: "internal", location: { file: filePath, line: lineNum, column: line.indexOf(funcMatch[0]) + 1 } });
      }
    }

    // const X = (non-exported, top-level)
    const constMatch = line.match(/^\s*(?:export\s+)?const\s+(\w+)/);
    if (constMatch && !line.includes("export const")) {
      if (!symbols.some((s) => s.name === constMatch[1] && s.scope === "exported")) {
        symbols.push({ name: constMatch[1]!, kind: "constant", scope: "internal", location: { file: filePath, line: lineNum, column: line.indexOf(constMatch[0]) + 1 } });
      }
    }

    // type X = (non-exported)
    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+(\w+)\s*=/);
    if (typeMatch && !line.includes("export type")) {
      if (!symbols.some((s) => s.name === typeMatch[1] && s.scope === "exported")) {
        symbols.push({ name: typeMatch[1]!, kind: "type", scope: "internal", location: { file: filePath, line: lineNum, column: line.indexOf(typeMatch[0]) + 1 } });
      }
    }

    // Class method detection (indented function-like patterns inside a class)
    // Matches lines like "methodName(params) { ..." or "async methodName(params) { ..."
    // at non-zero indentation, not preceded by function/class/interface/type keywords
    const methodMatch = line.match(/^\s+(?:private\s+|public\s+|protected\s+|static\s+)*(?:async\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*\w+(?:<[^>]+>)?\s*)?\{/);
    if (methodMatch) {
      const name = methodMatch[1]!;
      // Only classify as method if it looks like an instance/class method (not a top-level function)
      // and wasn't already classified as something else
      const indent = line.search(/\S/);
      if (indent > 0 && !symbols.some((s) => s.name === name)) {
        let scope: SymbolDef["scope"] = "public";
        if (/\bprivate\b/.test(line)) scope = "private";
        else if (line.trimStart().startsWith("public")) scope = "public";
        symbols.push({ name, kind: "method", scope, location: { file: filePath, line: lineNum, column: line.indexOf(methodMatch[0]) + 1 } });
      }
    }

    // Private member variable detection: private X = ... or private X: type
    const privateFieldMatch = line.match(/^\s+private\s+(\w+)(?:\s*[=:;]|\s|$)/);
    if (privateFieldMatch && indentLevel(line) > 0) {
      const name = privateFieldMatch[1]!;
      if (!symbols.some((s) => s.name === name)) {
        symbols.push({ name, kind: "variable", scope: "private", location: { file: filePath, line: lineNum, column: line.indexOf(privateFieldMatch[0]) + 1 } });
      }
    }
  }

  return { imports, symbols };
}

/**
 * Helper: compute the indent level (number of leading spaces) of a line.
 */
function indentLevel(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1]!.length : 0;
}

function parseJavaScript(content: string, filePath: string): ParseResult {
  return parseTypeScript(content, filePath);
}

// ---- Python ----

function parsePython(content: string, filePath: string): ParseResult {
  const imports: ImportEntry[] = [];
  const symbols: SymbolDef[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // import X / import X as Y
    const importMatch = line.match(/^\s*import\s+(\S+)/);
    if (importMatch) {
      imports.push({ source: importMatch[1]!.split(" as ")[0]!.trim(), symbols: [], type: "named" });
    }

    // from X import Y
    const fromMatch = line.match(/^\s*from\s+(\S+)\s+import\s+(.+)/);
    if (fromMatch) {
      const source = fromMatch[1]!;
      const symbolsList = fromMatch[2]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
      imports.push({ source, symbols: symbolsList, type: "named" });
    }

    // def X / async def X (top-level)
    const defMatch = line.match(/^\s*(?:async\s+)?def\s+(\w+)/);
    if (defMatch) {
      symbols.push({ name: defMatch[1]!, kind: "function", scope: "public", location: { file: filePath, line: lineNum, column: line.indexOf(defMatch[0]) + 1 } });
    }

    // class X (top-level)
    const classMatch = line.match(/^\s*class\s+(\w+)/);
    if (classMatch) {
      symbols.push({ name: classMatch[1]!, kind: "class", scope: "public", location: { file: filePath, line: lineNum, column: line.indexOf(classMatch[0]) + 1 } });
    }
  }

  return { imports, symbols };
}

// ---- Rust ----

function parseRust(content: string, filePath: string): ParseResult {
  const imports: ImportEntry[] = [];
  const symbols: SymbolDef[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // use X::Y / use X as Y / use X::{Y, Z}
    const useMatch = line.match(/^\s*use\s+([^;]+);/);
    if (useMatch) {
      imports.push({ source: useMatch[1]!.trim(), symbols: [], type: "named" });
    }

    // pub fn X / pub struct X / pub enum X / pub trait X / pub type X / pub const X
    const pubMatch = line.match(/^\s*pub\s+(?:fn|struct|enum|trait|type|const)\s+(\w+)/);
    if (pubMatch) {
      const kw = line.match(/^\s*pub\s+(fn|struct|enum|trait|type|const)/);
      let kind: SymbolDef["kind"] = "function";
      if (kw) {
        if (kw[1] === "fn") kind = "function";
        else if (kw[1] === "struct" || kw[1] === "enum") kind = "class";
        else if (kw[1] === "trait") kind = "interface";
        else if (kw[1] === "type") kind = "type";
        else if (kw[1] === "const") kind = "constant";
      }
      symbols.push({ name: pubMatch[1]!, kind, scope: "exported", location: { file: filePath, line: lineNum, column: line.indexOf(pubMatch[0]) + 1 } });
    }

    // fn X (non-pub, top-level)
    const fnMatch = line.match(/^\s*fn\s+(\w+)/);
    if (fnMatch && !line.trimStart().startsWith("pub")) {
      symbols.push({ name: fnMatch[1]!, kind: "function", scope: "internal", location: { file: filePath, line: lineNum, column: line.indexOf(fnMatch[0]) + 1 } });
    }
  }

  return { imports, symbols };
}

// ---- Go ----

function parseGo(content: string, filePath: string): ParseResult {
  const imports: ImportEntry[] = [];
  const symbols: SymbolDef[] = [];
  const lines = content.split("\n");

  // Multi-line import block: import ( "X" ; "Y" )
  const importBlockRegex = /import\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = importBlockRegex.exec(content)) !== null) {
    const blockContent = m[1]!;
    const pkgs = blockContent.split("\n").map((l) => l.trim().replace(/^"/, "").replace(/"$/, "").replace(/\/\/.*$/, "").trim()).filter((l) => l.length > 0 && !l.startsWith("//"));
    for (const pkg of pkgs) {
      // Split on whitespace for aliased imports like alias "path"
      const parts = pkg.split(/\s+/);
      const source = parts[parts.length - 1]!.replace(/^"/, "").replace(/"$/, "");
      if (source) imports.push({ source, symbols: [], type: "named" });
    }
  }

  // Single import: import "X"
  const singleImportRegex = /^\s*import\s+"([^"]+)"/gm;
  while ((m = singleImportRegex.exec(content)) !== null) {
    if (m[1]) imports.push({ source: m[1], symbols: [], type: "named" });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Exported (capitalized) top-level declarations
    const topLevelMatch = line.match(/^\s*(?:func|type|const|var)\s+([A-Z]\w*)/);
    if (topLevelMatch) {
      const kw = line.match(/^\s*(func|type|const|var)/);
      let kind: SymbolDef["kind"] = "function";
      if (kw) {
        if (kw[1] === "func") kind = "function";
        else if (kw[1] === "type") kind = "type";
        else if (kw[1] === "const") kind = "constant";
        else if (kw[1] === "var") kind = "variable";
      }
      symbols.push({ name: topLevelMatch[1]!, kind, scope: "exported", location: { file: filePath, line: lineNum, column: line.indexOf(topLevelMatch[0]) + 1 } });
    }

    // Unexported (lowercase) top-level declarations
    const lowerMatch = line.match(/^\s*(?:func|type|const|var)\s+([a-z]\w*)/);
    if (lowerMatch) {
      const kw = line.match(/^(func|type|const|var)/);
      let kind: SymbolDef["kind"] = "function";
      if (kw) {
        if (kw[1] === "func") kind = "function";
        else if (kw[1] === "type") kind = "type";
        else if (kw[1] === "const") kind = "constant";
        else if (kw[1] === "var") kind = "variable";
      }
      symbols.push({ name: lowerMatch[1]!, kind, scope: "internal", location: { file: filePath, line: lineNum, column: line.indexOf(lowerMatch[0]) + 1 } });
    }
  }

  return { imports, symbols };
}

// ---- Java ----

function parseJava(content: string, filePath: string): ParseResult {
  const imports: ImportEntry[] = [];
  const symbols: SymbolDef[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // import X.Y.Z
    const importMatch = line.match(/^import\s+([^;]+);/);
    if (importMatch) {
      imports.push({ source: importMatch[1]!, symbols: [], type: "named" });
    }

    // public class X / public interface X / public enum X
    const publicMatch = line.match(/public\s+(class|interface|enum)\s+(\w+)/);
    if (publicMatch) {
      const kw = publicMatch[1]!;
      const name = publicMatch[2]!;
      const kind: SymbolDef["kind"] = kw === "class" || kw === "enum" ? "class" : "interface";
      symbols.push({ name, kind, scope: "public", location: { file: filePath, line: lineNum, column: line.indexOf(publicMatch[0]) + 1 } });
    }

    // class X (package-private)
    const classMatch = line.match(/^\s*(?:abstract\s+|final\s+)?(?:class|interface|enum)\s+(\w+)/);
    if (classMatch && !line.includes("public") && !line.includes("private")) {
      const kwLine = line.match(/\b(class|interface|enum)\b/);
      const kind: SymbolDef["kind"] = kwLine && kwLine[1] === "interface" ? "interface" : "class";
      symbols.push({ name: classMatch[1]!, kind, scope: "internal", location: { file: filePath, line: lineNum, column: line.indexOf(classMatch[0]) + 1 } });
    }

    // private member detection (Java)
    const privateMatch = line.match(/private\s+(?:static\s+|final\s+|transient\s+|volatile\s+)*(\w+)\s+(\w+)/);
    if (privateMatch) {
      const memberKind = privateMatch[1] === "void" || privateMatch[1] === "int" || privateMatch[1] === "String" || privateMatch[1] === "boolean" || privateMatch[1] === "long" || privateMatch[1] === "double" || privateMatch[1] === "float" || privateMatch[1] === "char" || privateMatch[1] === "byte" || privateMatch[1] === "short"
        ? "method" as const
        : "variable" as const;
      // If it looks like a method (has parentheses)
      const isMethod = /\w+\s*\(/.test(line);
      symbols.push({ name: privateMatch[2]!, kind: isMethod ? "method" : "variable", scope: "private", location: { file: filePath, line: lineNum, column: line.indexOf(privateMatch[0]) + 1 } });
    }
  }

  return { imports, symbols };
}

// ---- Parser Dispatch ----

type ParserFn = (content: string, filePath: string) => ParseResult;

const IMPORT_PARSERS: Record<string, ParserFn> = {
  typescript: parseTypeScript,
  "typescript-react": parseTypeScript,
  javascript: parseJavaScript,
  "javascript-react": parseJavaScript,
  python: parsePython,
  rust: parseRust,
  go: parseGo,
  java: parseJava,
};

// =========================================================================
// Utilities
// =========================================================================

/**
 * Atomically write a JSON file: write to a temp path then rename.
 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp.${randomUUID().slice(0, 8)}`;
  const content = JSON.stringify(data, null, 2);
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await access(dirPath, constants.F_OK);
  } catch {
    await mkdir(dirPath, { recursive: true });
  }
}

// =========================================================================
// Serializable Shapes (for JSON persistence)
// =========================================================================

interface SerializableFileNode {
  symbols: SymbolDef[];
  imports: ImportEntry[];
  language: string;
  astHash: string;
  mtime: number;
}

interface SerializableSymbolRef {
  location: { file: string; line: number; column: number };
  kind: string;
  scope: string;
}

interface SerializableModule {
  entryPoints: string[];
  internalDeps: string[];
  externalDeps: string[];
}

interface SerializedIndex {
  version: number;
  workspaceRoot: string;
  files: Record<string, SerializableFileNode>;
  symbols: Record<string, SerializableSymbolRef[]>;
  modules: Record<string, SerializableModule>;
  boundaries: DependencyRule[];
}

// =========================================================================
// Entry Point Detection
// =========================================================================

const ENTRY_POINT_FILES = new Set(["index.ts", "index.js", "main.ts", "main.js", "main.rs", "main.go", "cli.ts", "cli.js", "app.ts", "app.js"]);

const ENTRY_POINT_PATTERNS = [
  /["']main["']\s*:/,
  /["']scripts["']\s*:/,
  /["']bin["']\s*:/,
  /^\s*const\s+main\s*=/m,
  /^\s*async\s+function\s+main\b/m,
  /^\s*fn\s+main\s*\(/m,
  /^\s*func\s+main\s*\(/m,
  /^\s*if\s+__name__\s*==\s*["']__main__["']/m,
  /^\s*public\s+static\s+void\s+main\b/m,
];

function isEntryPoint(filePath: string, content: string): boolean {
  if (ENTRY_POINT_FILES.has(basename(filePath))) return true;
  for (const pattern of ENTRY_POINT_PATTERNS) {
    if (pattern.test(content)) return true;
  }
  return false;
}

// =========================================================================
// CodebaseGraphIndex
// =========================================================================

export class CodebaseGraphIndex {
  /** Map of file paths → FileNode */
  readonly files = new Map<string, FileNode>();
  /** Map of symbol names → SymbolRef[] (definitions + references) */
  readonly symbols = new Map<string, SymbolRef[]>();
  /** Map of module names → Module */
  readonly modules = new Map<string, Module>();
  /** List of boundary rules */
  readonly boundaries: DependencyRule[] = [];

  private _config: Required<CodebaseGraphConfig>;
  private _workspaceRoot = "";
  private _persistPath = "";
  private _dirty = false;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _flushInterval: number;

  constructor(config?: CodebaseGraphConfig) {
    const root = config?.persistRoot ?? resolve(homedir(), ".Q", "memory");
    this._config = { ...DEFAULT_CONFIG, ...config, persistRoot: root };
    this._persistPath = resolve(this._config.persistRoot, "codebase-graph.json");
    this._flushInterval = this._config.autoFlushInterval;
  }

  // -----------------------------------------------------------------------
  // Build
  // -----------------------------------------------------------------------

  /**
   * Walk the workspace and build the full index.
   */
  async build(root: string): Promise<void> {
    this._workspaceRoot = resolve(root);
    this.files.clear();
    this.symbols.clear();
    this.modules.clear();
    this.boundaries.length = 0;

    // Walk workspace
    const pattern = this._config.includePatterns.join("|");
    const entries: string[] = [];

    for await (const entry of glob(pattern, { cwd: this._workspaceRoot })) {
      const fullPath = resolve(this._workspaceRoot, entry);
      if (this._shouldExclude(fullPath)) continue;
      entries.push(fullPath);
    }

    // Process each file
    for (const filePath of entries) {
      await this._processFile(filePath);
    }

    // Build module graph
    this._buildModules();

    // Infer boundary rules from module structure
    this._inferBoundaries();

    // Persist
    this._dirty = true;
    await this.flush();
  }

  // -----------------------------------------------------------------------
  // Incremental Updates
  // -----------------------------------------------------------------------

  /**
   * Handle a file change event — re-parse and propagate.
   */
  async onFileChanged(filePath: string): Promise<void> {
    const resolvedPath = resolve(this._workspaceRoot, filePath);

    try {
      const stats = await stat(resolvedPath);
      const content = await readFile(resolvedPath, "utf-8");
      const hash = this._hashContent(content);

      // Check if unchanged
      const existing = this.files.get(resolvedPath);
      if (existing && existing.astHash === hash) return;

      // Remove old symbols
      if (existing) {
        this._removeFileSymbols(resolvedPath, existing);
      }

      // Re-process
      await this._processFileWithContent(resolvedPath, content, stats.mtimeMs);
      this._rebuildModules();
      this._dirty = true;

      // Auto-flush is handled by the timer
    } catch {
      // File may have been deleted between event and read
      this.onFileDeleted(resolvedPath).catch(() => {});
    }
  }

  /**
   * Handle a file deletion event — remove symbols and propagate.
   */
  async onFileDeleted(filePath: string): Promise<void> {
    const resolvedPath = resolve(this._workspaceRoot, filePath);
    const existing = this.files.get(resolvedPath);
    if (!existing) return;

    // Remove symbols from this file
    this._removeFileSymbols(resolvedPath, existing);

    // Remove file entry
    this.files.delete(resolvedPath);

    // Update module membership
    this._rebuildModules();
    this._dirty = true;
  }

  // -----------------------------------------------------------------------
  // Query Methods
  // -----------------------------------------------------------------------

  /**
   * Look up all definitions and references for a symbol name.
   */
  lookupSymbol(name: string): SymbolRef[] {
    return this.symbols.get(name) ?? [];
  }

  /**
   * Find all reference locations for a symbol, optionally filtered by file.
   */
  findReferences(symbolName: string, file?: string): Location[] {
    const refs = this.symbols.get(symbolName);
    if (!refs) return [];

    return refs
      .filter((r) => !file || r.location.file === file)
      .map((r) => ({ file: r.location.file, line: r.location.line, column: r.location.column }));
  }

  /**
   * Get the module that contains the given file, or null.
   */
  moduleOf(filePath: string): Module | null {
    const resolvedPath = resolve(this._workspaceRoot, filePath);
    for (const [, mod] of this.modules) {
      if (mod.entryPoints.includes(resolvedPath)) {
        return mod;
      }
    }

    const moduleName = this._inferModuleName(resolvedPath);
    return this.modules.get(moduleName) ?? null;
  }

  /**
   * Get module names that depend on the given module.
   */
  dependentsOfModule(moduleName: string): string[] {
    const dependents: string[] = [];
    for (const [name, mod] of this.modules) {
      if (name !== moduleName && mod.internalDeps.includes(moduleName)) {
        dependents.push(name);
      }
    }
    return dependents;
  }

  /**
   * Get file paths that directly depend on the given file.
   */
  dependentsOf(filePath: string): string[] {
    const resolvedPath = resolve(this._workspaceRoot, filePath);
    const dependents: string[] = [];

    for (const [fPath, node] of this.files) {
      for (const imp of node.imports) {
        // Check if import resolves to the target file
        const resolved = this._resolveImport(imp.source, fPath);
        if (resolved === resolvedPath) {
          dependents.push(fPath);
          break;
        }
      }
    }

    return dependents;
  }

  /**
   * Returns the set of module names affected by changes to the given files.
   */
  affectedModules(filePaths: string[]): string[] {
    const affected = new Set<string>();

    for (const p of filePaths) {
      const resolvedPath = resolve(this._workspaceRoot, p);

      // Direct module membership
      const modName = this._inferModuleName(resolvedPath);
      if (this.modules.has(modName)) {
        affected.add(modName);
      }

      // Dependents' modules
      const deps = this.dependentsOf(resolvedPath);
      for (const depPath of deps) {
        const depModName = this._inferModuleName(depPath);
        if (this.modules.has(depModName)) {
          affected.add(depModName);
        }
      }
    }

    return Array.from(affected);
  }

  /**
   * Check if a dependency from `file` to `target` is allowed by boundary rules.
   */
  checkBoundaries(file: string, target: string): BoundaryVerdict {
    for (const rule of this.boundaries) {
      if (this._globMatch(file, rule.source) && this._globMatch(target, rule.target)) {
        return rule.allowed ? "allowed" : "blocked";
      }
    }
    return "no_rule";
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Serialize the full index to disk as JSON.
   */
  async serialize(): Promise<void> {
    await ensureDir(dirname(this._persistPath));

    const files: Record<string, SerializableFileNode> = {};
    for (const [path, node] of this.files) {
      files[path] = {
        symbols: node.symbols,
        imports: node.imports,
        language: node.language,
        astHash: node.astHash,
        mtime: node.mtime,
      };
    }

    const symbols: Record<string, SerializableSymbolRef[]> = {};
    for (const [name, refs] of this.symbols) {
      symbols[name] = refs.map((r) => ({
        location: { file: r.location.file, line: r.location.line, column: r.location.column },
        kind: r.kind,
        scope: r.scope,
      }));
    }

    const modules: Record<string, SerializableModule> = {};
    for (const [name, mod] of this.modules) {
      modules[name] = {
        entryPoints: mod.entryPoints,
        internalDeps: mod.internalDeps,
        externalDeps: mod.externalDeps,
      };
    }

    const data: SerializedIndex = { version: 1, workspaceRoot: this._workspaceRoot, files, symbols, modules, boundaries: this.boundaries };
    await atomicWriteJson(this._persistPath, data);
  }

  /**
   * Deserialize the index from disk.
   */
  async deserialize(): Promise<boolean> {
    try {
      const content = await readFile(this._persistPath, "utf-8");
      const data = JSON.parse(content) as SerializedIndex;

      this.files.clear();
      this.symbols.clear();
      this.modules.clear();
      this.boundaries.length = 0;

      for (const [path, node] of Object.entries(data.files)) {
        this.files.set(path, {
          symbols: node.symbols,
          imports: node.imports,
          language: node.language,
          astHash: node.astHash,
          mtime: node.mtime,
        });
      }

      for (const [name, refs] of Object.entries(data.symbols)) {
        this.symbols.set(name, refs.map((r) => ({
          location: { file: r.location.file, line: r.location.line, column: r.location.column },
          kind: r.kind as SymbolRef["kind"],
          scope: r.scope as SymbolRef["scope"],
        })));
      }

      for (const [name, mod] of Object.entries(data.modules)) {
        this.modules.set(name, {
          entryPoints: mod.entryPoints,
          internalDeps: mod.internalDeps,
          externalDeps: mod.externalDeps,
        });
      }

      this.boundaries.push(...data.boundaries);

      // Use stored workspace root
      if (data.workspaceRoot) {
        this._workspaceRoot = data.workspaceRoot;
      } else if (this.files.size > 0) {
        // Fallback: infer from first file path (legacy format without workspaceRoot)
        const firstPath = this.files.keys().next().value!;
        const parts = firstPath.split("/");
        this._workspaceRoot = parts.slice(0, Math.max(3, parts.indexOf("src") + 1)).join("/") || "/";
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Flush dirty state to disk (if dirty).
   */
  async flush(): Promise<void> {
    if (!this._dirty) return;
    await this.serialize();
    this._dirty = false;
  }

  /**
   * Start auto-flush timer.
   */
  startAutoFlush(intervalMs?: number): void {
    if (this._flushTimer) return;
    const interval = intervalMs ?? this._flushInterval;
    this._flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, interval);
  }

  /**
   * Stop auto-flush timer.
   */
  stopAutoFlush(): void {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  /**
   * Get the workspace root path.
   */
  getWorkspaceRoot(): string {
    return this._workspaceRoot;
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  private _hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private _shouldExclude(filePath: string): boolean {
    const rel = relative(this._workspaceRoot, filePath);
    if (rel.startsWith("..")) return true;

    for (const pattern of this._config.excludePatterns) {
      // Simple glob matching for exclude patterns
      if (pattern.includes("**")) {
        const parts = pattern.replace(/\*\*/g, ".*").split("/");
        const regexStr = parts.map((p) => p.replace(/\*/g, "[^/]*")).join("/");
        const regex = new RegExp(`^${regexStr}$`);
        if (regex.test(rel) || regex.test(`/${rel}`)) return true;
      } else {
        const simple = pattern.replace(/\*/g, "[^/]*");
        const regex = new RegExp(`^${simple}$`);
        if (regex.test(rel)) return true;
      }
    }

    return false;
  }

  private async _processFile(filePath: string): Promise<void> {
    try {
      const stats = await stat(filePath);
      const content = await readFile(filePath, "utf-8");
      await this._processFileWithContent(filePath, content, stats.mtimeMs);
    } catch {
      // Skip files that can't be read
    }
  }

  private async _processFileWithContent(filePath: string, content: string, mtimeMs: number): Promise<void> {
    const ext = extname(filePath).slice(1).toLowerCase();
    const language = LANGUAGE_MAP[ext] ?? "unknown";
    const hash = this._hashContent(content);

    const parser = IMPORT_PARSERS[language];
    let imports: ImportEntry[] = [];
    let symbols: SymbolDef[] = [];

    if (parser) {
      const result = parser(content, filePath);
      imports = result.imports;
      symbols = result.symbols;
    }

    const node: FileNode = {
      symbols,
      imports,
      language,
      astHash: hash,
      mtime: mtimeMs,
    };

    this.files.set(filePath, node);

    // Index symbols
    for (const def of symbols) {
      const ref: SymbolRef = {
        location: { file: def.location.file, line: def.location.line, column: def.location.column },
        kind: def.kind,
        scope: def.scope,
      };

      const existing = this.symbols.get(def.name);
      if (existing) {
        // Avoid duplicates
        if (!existing.some((r) => r.location.file === ref.location.file && r.location.line === ref.location.line)) {
          existing.push(ref);
        }
      } else {
        this.symbols.set(def.name, [ref]);
      }
    }
  }

  private _removeFileSymbols(filePath: string, node: FileNode): void {
    for (const def of node.symbols) {
      const refs = this.symbols.get(def.name);
      if (!refs) continue;

      const filtered = refs.filter((r) => r.location.file !== filePath);
      if (filtered.length === 0) {
        this.symbols.delete(def.name);
      } else {
        this.symbols.set(def.name, filtered);
      }
    }
  }

  private _inferModuleName(filePath: string): string {
    const rel = relative(this._workspaceRoot, filePath);
    const parts = rel.split(/[/\\]/);

    if (parts.length >= 2) {
      const topDir = parts[0]!;
      if (topDir === "src" || topDir === "lib" || topDir === "app") {
        if (parts.length >= 3) return parts[1]!;
        return "root";
      }
      return topDir;
    }

    return "root";
  }

  private _resolveImport(importSource: string, sourceFile: string, indexOnly = false): string | null {
    // Skip bare module specifiers (external packages)
    if (!importSource.startsWith(".") && !importSource.startsWith("/") && !importSource.startsWith("..")) {
      return null;
    }

    const sourceDir = dirname(sourceFile);
    let resolvedPath: string;
    if (importSource.startsWith("/")) {
      resolvedPath = resolve(this._workspaceRoot, "." + importSource);
    } else {
      resolvedPath = resolve(sourceDir, importSource);
    }

    // Try common extensions
    const candidates = [
      resolvedPath,
      `${resolvedPath}.ts`,
      `${resolvedPath}.tsx`,
      `${resolvedPath}.js`,
      `${resolvedPath}.jsx`,
      `${resolvedPath}.mjs`,
      `${resolvedPath}.mts`,
      `${resolvedPath}/index.ts`,
      `${resolvedPath}/index.js`,
      `${resolvedPath}/index.mjs`,
      `${resolvedPath}/mod.ts`,
      `${resolvedPath}/__init__.py`,
      `${resolvedPath}.py`,
      `${resolvedPath}.rs`,
      `${resolvedPath}.go`,
      `${resolvedPath}.java`,
    ];

    for (const candidate of candidates) {
      if (this.files.has(candidate) || (!indexOnly && existsSync(candidate))) {
        return candidate;
      }
    }

    return null;
  }

  private _buildModules(): void {
    this.modules.clear();

    for (const [filePath, node] of this.files) {
      const moduleName = this._inferModuleName(filePath);

      let mod = this.modules.get(moduleName);
      if (!mod) {
        mod = { entryPoints: [], internalDeps: [], externalDeps: [] };
        this.modules.set(moduleName, mod);
      }

      mod.entryPoints.push(filePath);

      // Classify imports as internal or external
      for (const imp of node.imports) {
        // During initial build, allow filesystem resolution so cross-module deps
        // resolve even if the target hasn't been processed yet
        const resolved = this._resolveImport(imp.source, filePath, false);
        if (resolved) {
          // Internal dependency
          const depModule = this._inferModuleName(resolved);
          if (depModule !== moduleName && !mod.internalDeps.includes(depModule)) {
            mod.internalDeps.push(depModule);
          }
        } else if (!imp.source.startsWith(".") && !imp.source.startsWith("/") && !imp.source.startsWith("..")) {
          // External dependency (bare specifier)
          const pkgName = imp.source.startsWith("@")
            ? imp.source.split("/").slice(0, 2).join("/")
            : imp.source.split("/")[0]!;
          if (!mod.externalDeps.includes(pkgName)) {
            mod.externalDeps.push(pkgName);
          }
        }
      }
    }
  }

  private _rebuildModules(): void {
    // Preserve workspace root, rebuild modules from current file set
    const savedRoot = this._workspaceRoot;
    this.modules.clear();

    // Use index-only resolution so deleted files aren't resolved
    for (const [filePath, node] of this.files) {
      const moduleName = this._inferModuleName(filePath);

      let mod = this.modules.get(moduleName);
      if (!mod) {
        mod = { entryPoints: [], internalDeps: [], externalDeps: [] };
        this.modules.set(moduleName, mod);
      }

      mod.entryPoints.push(filePath);

      for (const imp of node.imports) {
        const resolved = this._resolveImport(imp.source, filePath, true); // indexOnly = true
        if (resolved) {
          const depModule = this._inferModuleName(resolved);
          if (depModule !== moduleName && !mod.internalDeps.includes(depModule)) {
            mod.internalDeps.push(depModule);
          }
        } else if (!imp.source.startsWith(".") && !imp.source.startsWith("/") && !imp.source.startsWith("..")) {
          const pkgName = imp.source.startsWith("@")
            ? imp.source.split("/").slice(0, 2).join("/")
            : imp.source.split("/")[0]!;
          if (!mod.externalDeps.includes(pkgName)) {
            mod.externalDeps.push(pkgName);
          }
        }
      }
    }

    this._workspaceRoot = savedRoot;

    // Re-infer boundaries
    this._inferBoundaries();
  }

  private _inferBoundaries(): void {
    this.boundaries.length = 0;

    for (const moduleName of this.modules.keys()) {
      // Common architecture rules
      if (moduleName === "ui" || moduleName === "components") {
        this.boundaries.push({ source: moduleName, target: "infrastructure", allowed: false });
      }
      if (moduleName === "core" || moduleName === "domain") {
        this.boundaries.push({ source: moduleName, target: "data", allowed: true });
      }
    }
  }

  /**
   * Simple glob pattern matching for module paths.
   * Supports * and ** glob characters.
   * A bare pattern (no glob chars) matches as a path prefix (module path).
   */
  private _globMatch(path: string, pattern: string): boolean {
    // Normalize: strip leading ./ and trailing /
    const normalizedPath = path.replace(/^\.\//, "").replace(/\/$/, "");
    const normalizedPattern = pattern.replace(/^\.\//, "").replace(/\/$/, "");

    // If pattern has no glob chars, match as path prefix
    if (!normalizedPattern.includes("*") && !normalizedPattern.includes("?") && !normalizedPattern.includes("[")) {
      return normalizedPath === normalizedPattern ||
        normalizedPath.startsWith(normalizedPattern + "/");
    }

    // Convert glob pattern to regex
    let regexStr = "^";
    for (let i = 0; i < normalizedPattern.length; i++) {
      const ch = normalizedPattern[i]!;
      if (ch === "*") {
        if (normalizedPattern[i + 1] === "*") {
          // ** matches everything
          regexStr += ".*";
          i++; // skip next *
          // Skip subsequent /
          if (normalizedPattern[i + 1] === "/") i++;
        } else {
          // * matches until next /
          regexStr += "[^/]*";
        }
      } else if (ch === "?") {
        regexStr += ".";
      } else if (ch === "." || ch === "/" || ch === "(" || ch === ")" || ch === "+" || ch === "[" || ch === "]" || ch === "{" || ch === "}" || ch === "!" || ch === "^" || ch === "$") {
        regexStr += "\\" + ch;
      } else {
        regexStr += ch;
      }
    }
    regexStr += "$";

    try {
      const regex = new RegExp(regexStr);
      return regex.test(normalizedPath);
    } catch {
      return false;
    }
  }
}