/**
 * WorkspaceTopology — Live model of files, modules & dependencies.
 *
 * Maintains a real-time model of the workspace: file tree, module graph,
 * dependency graph, entry points. Supports incremental updates via
 * onFileCreated/Modified/Deleted and full initial build via build(cwd).
 */

import { createHash } from "node:crypto";
import { readFile, stat, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, dirname, basename, extname } from "node:path";
import { glob } from "node:fs/promises";
import Ignore from "ignore";

// =========================================================================
// Types
// =========================================================================

export interface FileNode {
  path: string;
  language: string;
  lastKnownHash: string;
  dependencies: Set<string>;
  size: number;
  mtimeMs: number;
  parsedImports: string[];
  parsedExports: string[];
}

export interface Module {
  name: string;
  files: string[];
  exports: Set<string>;
  imports: Array<{ source: string; symbols: string[] }>;
  boundaries: DependencyRule[];
}

export interface DependencyRule {
  type: "must_not_import" | "can_import" | "only_import";
  source: string;
  target: string;
  /**
   * Whether the edge is allowed. Mirrors the shape used by
   * `CodebaseGraphIndex` (Step 26) so `checkBoundaries()` can share the
   * same rules.
   */
  allowed: boolean;
}

/** Result of `WorkspaceTopology.checkBoundaries()`. */
export type BoundaryVerdict = "allowed" | "blocked" | "no_rule";

export interface DependencyInfo {
  direct: Map<string, string>;
  transitive: Set<string>;
}

export interface TopologyBuildOptions {
  maxDepth: number;
  includePatterns: string[];
  excludePatterns: string[];
}

const DEFAULT_BUILD_OPTIONS: TopologyBuildOptions = {
  maxDepth: 20,
  includePatterns: ["**/*.{ts,js,tsx,jsx,mjs,cjs,mts,cts,py,rs,go,json,yaml,yml,toml,md}"],
  excludePatterns: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/coverage/**", "**/.q/**"],
};

// =========================================================================
// Language Detection Map (30+ mappings)
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
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  scala: "scala",
  swift: "swift",
  c: "c",
  h: "c-header",
  cpp: "cpp",
  hpp: "cpp-header",
  cs: "csharp",
  php: "php",
  r: "r",
  dart: "dart",
  lua: "lua",
  elm: "elm",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  ml: "ocaml",
  zig: "zig",
  vue: "vue",
  svelte: "svelte",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
};

// =========================================================================
// Lightweight Import Parsers
// =========================================================================

type ImportParser = (content: string, filePath: string) => { imports: string[]; exports: string[] };

const IMPORT_PARSERS: Record<string, ImportParser> = {
  typescript: parseTypeScriptImports,
  "typescript-react": parseTypeScriptImports,
  javascript: parseJavaScriptImports,
  "javascript-react": parseJavaScriptImports,
  python: parsePythonImports,
  rust: parseRustImports,
  go: parseGoImports,
};

function parseTypeScriptImports(content: string, _filePath: string): { imports: string[]; exports: string[] } {
  const imports: string[] = [];
  const exports: string[] = [];

  // import statements
  const importRegex = /(?:import\s+(?:(?:\{[^}]*\}|[^;{]+)\s+from\s+)?["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    imports.push(m[1] ?? m[2] ?? "");
  }

  // dynamic import()
  const dynamicImportRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamicImportRegex.exec(content)) !== null) {
    if (m[1]) imports.push(m[1]);
  }

  // export declarations
  const exportRegex = /export\s+(?:(?:default|const|let|var|function|class|interface|type|enum|abstract)\s+)?(\w+)/g;
  while ((m = exportRegex.exec(content)) !== null) {
    if (m[1]) exports.push(m[1]);
  }

  // export { ... }
  const exportListRegex = /export\s+\{([^}]+)\}/g;
  while ((m = exportListRegex.exec(content)) !== null) {
    const symbols = m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
    exports.push(...symbols);
  }

  // export * from
  const exportStarRegex = /export\s+\*\s+from\s+["']([^"']+)["']/g;
  while ((m = exportStarRegex.exec(content)) !== null) {
    if (m[1]) exports.push(`*:${m[1]}`);
  }

  return { imports, exports };
}

function parseJavaScriptImports(content: string, filePath: string): { imports: string[]; exports: string[] } {
  return parseTypeScriptImports(content, filePath);
}

function parsePythonImports(content: string, _filePath: string): { imports: string[]; exports: string[] } {
  const imports: string[] = [];
  const exports: string[] = [];

  // import X / import X as Y / from X import Y
  const importRegex = /^(?:import\s+(\S+)|from\s+(\S+)\s+import\s+(.+))/gm;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    if (m[1]) imports.push(m[1]);
    if (m[2]) imports.push(m[2]);
  }

  // def / class top-level declarations
  const defRegex = /^(?:def|class|async def)\s+(\w+)/gm;
  while ((m = defRegex.exec(content)) !== null) {
    if (m[1]) exports.push(m[1]);
  }

  return { imports, exports };
}

function parseRustImports(content: string, _filePath: string): { imports: string[]; exports: string[] } {
  const imports: string[] = [];
  const exports: string[] = [];

  // use X::Y or use X as Y
  const useRegex = /^use\s+([^;]+);/gm;
  let m: RegExpExecArray | null;
  while ((m = useRegex.exec(content)) !== null) {
    if (m[1]) imports.push(m[1]);
  }

  // pub fn / pub struct / pub enum / pub trait / pub type / pub const
  const pubRegex = /^pub\s+(?:fn|struct|enum|trait|type|const|mod|use)\s+(\w+)/gm;
  while ((m = pubRegex.exec(content)) !== null) {
    if (m[1]) exports.push(m[1]);
  }

  return { imports, exports };
}

function parseGoImports(content: string, _filePath: string): { imports: string[]; exports: string[] } {
  const imports: string[] = [];
  const exports: string[] = [];

  // import "X" / import ( "X" ; "Y" )
  const importRegex = /import\s+(?:\(([^)]*)\)|"([^"]+)")/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    if (m[1]) {
      const lines = m[1].split("\n").map(l => l.trim().replace(/^"/, "").replace(/"$/, "")).filter(Boolean);
      imports.push(...lines);
    }
    if (m[2]) imports.push(m[2]);
  }

  // func / type / const / var at top level (exported = capitalized)
  const topLevelRegex = /^(?:func|type|const|var)\s+([A-Z]\w*)/gm;
  let m2: RegExpExecArray | null;
  while ((m2 = topLevelRegex.exec(content)) !== null) {
    if (m2[1]) exports.push(m2[1]);
  }

  return { imports, exports };
}

// =========================================================================
// Entry Point Detection
// =========================================================================

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

const ENTRY_POINT_FILES = ["index.ts", "index.js", "main.ts", "main.js", "main.rs", "main.go", "cli.ts", "cli.js", "app.ts", "app.js"];

// =========================================================================
// WorkspaceTopology
// =========================================================================

export class WorkspaceTopology {
  /** Map of absolute paths to FileNode objects. */
  readonly fileTree = new Map<string, FileNode>();
  /** Map of module names to Module objects. */
  readonly moduleGraph = new Map<string, Module>();
  /** Map of package names to version constraints. */
  readonly dependencyGraph = new Map<string, string>();
  /** Set of file paths that are entry points. */
  readonly entryPoints = new Set<string>();
  /** Transitive dependency tracking. */
  readonly transitiveDependencies = new Set<string>();
  /**
   * Architecture boundary rules. Each rule says `source` (a module pattern)
   * may or may not import from `target` (a module pattern). Consumed by
   * `checkBoundaries()` and the Step 30 ArchitectureCheckGate.
   */
  boundaries: DependencyRule[] = [];

  private ig: ReturnType<typeof Ignore> | null = null;
  private workspaceRoot = "";
  private buildOptions: TopologyBuildOptions;

  constructor(options?: Partial<TopologyBuildOptions>) {
    this.buildOptions = { ...DEFAULT_BUILD_OPTIONS, ...options };
  }

  // -----------------------------------------------------------------------
  // Initial Build
  // -----------------------------------------------------------------------

  /**
   * Walk the workspace directory and build the full topology.
   */
  async build(cwd: string): Promise<void> {
    this.workspaceRoot = resolve(cwd);
    this.fileTree.clear();
    this.moduleGraph.clear();
    this.dependencyGraph.clear();
    this.entryPoints.clear();
    this.transitiveDependencies.clear();

    // Set up .gitignore filtering
    this.ig = await this.loadGitignore(this.workspaceRoot);

    // Walk the workspace
    const entries: string[] = [];
    for await (const entry of glob(this.buildOptions.includePatterns.join("|"), {
      cwd: this.workspaceRoot,
      withFileTypes: false,
    })) {
      const fullPath = resolve(this.workspaceRoot, entry);
      if (!this.shouldInclude(fullPath)) continue;
      entries.push(fullPath);
    }

    // Process each file
    for (const filePath of entries) {
      await this.processFile(filePath);
    }

    // Build module graph
    this.buildModuleGraph();
  }

  // -----------------------------------------------------------------------
  // Incremental Updates
  // -----------------------------------------------------------------------

  /**
   * Handle a file creation event. Re-scans the file, parses imports,
   * re-hashes, and propagates to the module graph.
   */
  async onFileCreated(filePath: string): Promise<void> {
    if (!this.shouldInclude(filePath)) return;
    await this.processFile(filePath);
    this.buildModuleGraph();
  }

  /**
   * Handle a file modification event. Re-reads the file, computes new hash,
   * and if changed, re-parses imports and propagates.
   */
  async onFileModified(filePath: string): Promise<void> {
    if (!this.shouldInclude(filePath)) return;
    const existing = this.fileTree.get(filePath);
    if (!existing) {
      await this.processFile(filePath);
      return;
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const hash = this.hashContent(content);
      if (hash === existing.lastKnownHash) return; // no change

      // Re-process
      await this.processFile(filePath);
      this.buildModuleGraph();
    } catch {
      // File may have been deleted between event and read
      this.fileTree.delete(filePath);
    }
  }

  /**
   * Handle a file deletion event. Removes the file from the tree,
   * updates module graph, and dependency graph.
   */
  async onFileDeleted(filePath: string): Promise<void> {
    this.fileTree.delete(filePath);
    this.entryPoints.delete(filePath);

    // Remove from module files
    for (const [, mod] of this.moduleGraph) {
      const idx = mod.files.indexOf(filePath);
      if (idx >= 0) mod.files.splice(idx, 1);
      // Clean up exports from this file
      const node = this.fileTree.get(filePath);
      if (node) {
        for (const exp of node.parsedExports) mod.exports.delete(exp);
      }
    }

    this.buildModuleGraph();
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Query a file node by path, with full dependency chain.
   * Returns null if the path is not in the file tree.
   */
  query(path: string): FileNode | null {
    return this.fileTree.get(resolve(this.workspaceRoot, path)) ?? null;
  }

  /**
   * Query a module by name.
   */
  queryModule(name: string): Module | null {
    return this.moduleGraph.get(name) ?? null;
  }

  /**
   * Get the set of file paths that depend on the given file
   * (reverse dependency lookup).
   */
  dependentsOf(path: string): Set<string> {
    const resolvedPath = resolve(this.workspaceRoot, path);
    const dependents = new Set<string>();

    for (const [filePath, node] of this.fileTree) {
      if (node.dependencies.has(resolvedPath)) {
        dependents.add(filePath);
      }
    }

    return dependents;
  }

  /**
   * Get the set of module names affected by changes to the given file paths.
   */
  modulesAffectedBy(paths: string[]): Set<string> {
    const affected = new Set<string>();

    for (const p of paths) {
      const resolvedPath = resolve(this.workspaceRoot, p);

      // Direct module membership
      for (const [modName, mod] of this.moduleGraph) {
        if (mod.files.includes(resolvedPath)) {
          affected.add(modName);
        }
      }

      // Dependents' modules
      const dependents = this.dependentsOf(resolvedPath);
      for (const dep of dependents) {
        for (const [modName, mod] of this.moduleGraph) {
          if (mod.files.includes(dep)) {
            affected.add(modName);
          }
        }
      }
    }

    return affected;
  }

  /**
   * Check if a dependency from `file` to `target` is allowed by the
   * architecture's boundary rules. Used by VerificationPipeline's
   * ArchitectureCheckGate (Step 30).
   *
   * Returns:
   *   "blocked"  — a `must_not_import` rule forbids this edge.
   *   "allowed"  — a `can_import` / `only_import` rule explicitly permits it.
   *   "no_rule"  — no rule covers this edge; the gate may apply heuristics
   *                (e.g. peer-module checks) to decide.
   */
  /**
   * Check if a dependency from `file` to `target` is allowed by the
   * architecture's boundary rules. Used by VerificationPipeline's
   * ArchitectureCheckGate (Step 30).
   *
   * Both `file` and `target` may be either absolute file paths OR module
   * names. The function uses `inferModuleName` on a path-style input and
   * treats inputs without a separator as a module name directly.
   *
   * Returns:
   *   "blocked"  — a `must_not_import` rule forbids this edge.
   *   "allowed"  — a `can_import` / `only_import` rule explicitly permits it.
   *   "no_rule"  — no rule covers this edge; the gate may apply heuristics
   *                (e.g. peer-module checks) to decide.
   */
  checkBoundaries(file: string, target: string): BoundaryVerdict {
    const fileModule = this._resolveModule(file);
    const targetModule = this._resolveModule(target);
    for (const rule of this.boundaries) {
      if (this._globMatch(fileModule, rule.source) && this._globMatch(targetModule, rule.target)) {
        return rule.allowed ? "allowed" : "blocked";
      }
    }
    return "no_rule";
  }

  /**
   * Resolve an input (file path OR module name) to a module name.
   * Used by `checkBoundaries()` so callers can pass either shape.
   */
  private _resolveModule(input: string): string {
    if (!input.includes("/") && !input.includes("\\")) {
      return input;
    }
    return this.inferModuleName(resolve(this.workspaceRoot, input));
  }

  /**
   * Get the workspace root path.
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Get the full topology as a plain object (for TaskDecomposer).
   */
  toTopology(): { modules: string[]; files: string[]; dependencies: Array<{ from: string; to: string }> } {
    return {
      modules: Array.from(this.moduleGraph.keys()),
      files: Array.from(this.fileTree.keys()),
      dependencies: this.extractDependencyPairs(),
    };
  }

  // -----------------------------------------------------------------------
  // Internal: File Processing
  // -----------------------------------------------------------------------

  private async processFile(filePath: string): Promise<void> {
    try {
      const stats = await stat(filePath);
      const content = await readFile(filePath, "utf-8");
      const ext = extname(filePath).slice(1).toLowerCase();
      const language = LANGUAGE_MAP[ext] ?? "unknown";
      const hash = this.hashContent(content);

      // Parse imports and exports
      const parser = IMPORT_PARSERS[language];
      let parsedImports: string[] = [];
      let parsedExports: string[] = [];

      if (parser) {
        const result = parser(content, filePath);
        parsedImports = result.imports;
        parsedExports = result.exports;
      }

      // Resolve import paths to absolute file dependencies
      const resolvedDeps = this.resolveDependencies(parsedImports, filePath);

      const node: FileNode = {
        path: filePath,
        language,
        lastKnownHash: hash,
        dependencies: new Set(resolvedDeps),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        parsedImports,
        parsedExports,
      };

      this.fileTree.set(filePath, node);

      // Check for entry points
      if (this.isEntryPoint(filePath, content)) {
        this.entryPoints.add(filePath);
      }

      // Track transitive deps from package.json-style files
      if (basename(filePath) === "package.json" || basename(filePath) === "Cargo.toml" || basename(filePath) === "go.mod") {
        this.parseDependencyFile(filePath, content);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  private resolveDependencies(imports: string[], sourceFile: string): string[] {
    const resolved: string[] = [];
    const sourceDir = dirname(sourceFile);

    for (const imp of imports) {
      // Skip bare module specifiers (npm packages, std libs)
      if (!imp.startsWith(".") && !imp.startsWith("/") && !imp.startsWith("..")) continue;

      // Resolve relative to source file
      let resolvedPath: string;
      if (imp.startsWith("/")) {
        resolvedPath = resolve(this.workspaceRoot, "." + imp);
      } else {
        resolvedPath = resolve(sourceDir, imp);
      }

      // Try common extensions
      const candidates = [resolvedPath, `${resolvedPath}.ts`, `${resolvedPath}.tsx`, `${resolvedPath}.js`, `${resolvedPath}.jsx`, `${resolvedPath}/index.ts`, `${resolvedPath}/index.js`, `${resolvedPath}/mod.ts`];

      for (const candidate of candidates) {
        if (this.fileTree.has(candidate) || existsSync(candidate)) {
          resolved.push(candidate);
          break;
        }
      }
    }

    return resolved;
  }

  private isEntryPoint(filePath: string, content: string): boolean {
    const baseName = basename(filePath);
    if (ENTRY_POINT_FILES.includes(baseName)) return true;
    for (const pattern of ENTRY_POINT_PATTERNS) {
      if (pattern.test(content)) return true;
    }
    return false;
  }

  private parseDependencyFile(filePath: string, content: string): void {
    const baseName = basename(filePath);

    try {
      if (baseName === "package.json") {
        const pkg = JSON.parse(content);
        for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
          this.dependencyGraph.set(name, String(version));
        }
        for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
          this.dependencyGraph.set(name, String(version));
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // -----------------------------------------------------------------------
  // Internal: Module Graph Building
  // -----------------------------------------------------------------------

  private buildModuleGraph(): void {
    this.moduleGraph.clear();

    // Group files into modules based on directory structure
    for (const [filePath, node] of this.fileTree) {
      const moduleName = this.inferModuleName(filePath);

      let mod = this.moduleGraph.get(moduleName);
      if (!mod) {
        mod = { name: moduleName, files: [], exports: new Set(), imports: [], boundaries: [] };
        this.moduleGraph.set(moduleName, mod);
      }

      mod.files.push(filePath);

      // Collect exports
      for (const exp of node.parsedExports) {
        mod.exports.add(exp);
      }

      // Collect imports
      for (const imp of node.parsedImports) {
        if (!mod.imports.some((i) => i.source === imp)) {
          mod.imports.push({ source: imp, symbols: [] });
        }
      }
    }

    // Infer boundaries from module names
    // Per-module boundary inference (used by per-module enforcement
    // in the ArchitectureCheckGate).
    for (const [, mod] of this.moduleGraph) {
      mod.boundaries = this.inferBoundaries(mod.name);
    }

    // Aggregate inferred rules onto the topology-level boundaries list so
    // that `checkBoundaries()` can return verdicts based on the union of
    // every module's rules.
    this.boundaries = [];
    for (const [, mod] of this.moduleGraph) {
      for (const rule of mod.boundaries) {
        this.boundaries.push({ ...rule });
      }
    }
  }

  private inferModuleName(filePath: string): string {
    const rel = relative(this.workspaceRoot, filePath);
    const parts = rel.split(/[/\\]/);

    // Try to infer module from top-level directory
    if (parts.length >= 2) {
      const topDir = parts[0]!;
      // src/ or lib/ — next level is the module
      if (topDir === "src" || topDir === "lib" || topDir === "app") {
        if (parts.length >= 3) return parts[1]!;
        return "root";
      }
      return topDir;
    }

    return "root";
  }

  private inferBoundaries(moduleName: string): DependencyRule[] {
    const rules: DependencyRule[] = [];

    // Common architecture rules
    if (moduleName === "ui" || moduleName === "components") {
      rules.push({ type: "must_not_import", source: moduleName, target: "infrastructure", allowed: false });
    }

    if (moduleName === "core" || moduleName === "domain") {
      rules.push({ type: "can_import", source: moduleName, target: "data", allowed: true });
    }

    return rules;
  }

  // -----------------------------------------------------------------------
  // Internal: Helpers
  // -----------------------------------------------------------------------

  private async loadGitignore(root: string): Promise<ReturnType<typeof Ignore> | null> {
    const ig = Ignore();
    ig.add(DEFAULT_BUILD_OPTIONS.excludePatterns);

    try {
      const gitignorePath = resolve(root, ".gitignore");
      const gitignoreContent = await readFile(gitignorePath, "utf-8");
      ig.add(gitignoreContent);
    } catch {
      // No .gitignore found — that's fine
    }

    return ig;
  }

  private shouldInclude(filePath: string): boolean {
    if (!this.ig) return true;

    const rel = relative(this.workspaceRoot, filePath);
    if (rel.startsWith("..")) return false;

    // Check depth
    const depth = rel.split(/[/\\]/).length;
    if (depth > this.buildOptions.maxDepth) return false;

    return !this.ig.ignores(rel);
  }

  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Glob-style match used by `checkBoundaries`. Supports:
   *   "*"   — match any single segment
   *   "**"  — match any number of segments (only at start/end)
   *   "?"    — match any one character
   *
   * If `pattern` is a plain name with no glob characters, it must match
   * exactly.
   */
  private _globMatch(value: string, pattern: string): boolean {
    if (!pattern.includes("*") && !pattern.includes("?")) {
      return value === pattern;
    }
    // Convert glob to a regex.
    const re = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "::DOUBLESTAR::")
          .replace(/\*/g, "[^/]*")
          .replace(/::DOUBLESTAR::/g, ".*")
          .replace(/\?/g, ".") +
        "$",
    );
    return re.test(value);
  }

  private extractDependencyPairs(): Array<{ from: string; to: string }> {
    const pairs: Array<{ from: string; to: string }> = [];

    for (const [filePath, node] of this.fileTree) {
      for (const dep of node.dependencies) {
        pairs.push({ from: filePath, to: dep });
      }
    }

    return pairs;
  }
}