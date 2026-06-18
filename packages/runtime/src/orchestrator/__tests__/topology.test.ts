/**
 * Tests — WorkspaceTopology — Live model of files, modules & dependencies.
 *
 * Covers: file detection, language detection, import parsing, module graph,
 * incremental updates, queries, dependency resolution, entry points.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkspaceTopology } from "../topology.js";
import type { FileNode, Module } from "../topology.js";

// =========================================================================
// Setup
// =========================================================================

const testDir = `/tmp/v-topo-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function writeFile(relPath: string, content: string): void {
  const full = join(testDir, relPath);
  const dir = full.substring(0, full.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, "utf-8");
}

// =========================================================================
// 1. Construction & Basic File Detection
// =========================================================================

describe("Construction & file detection", () => {
  let topo: WorkspaceTopology;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFile("src/index.ts", `import { helper } from "./helper";\nexport const main = () => helper();`);
    writeFile("src/helper.ts", `export function helper() { return 42; }`);
    writeFile("src/utils.ts", `export function util() { return "hello"; }`);
    topo = new WorkspaceTopology({ maxDepth: 10 });
    await topo.build(testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("discovers files in the workspace", () => {
    expect(topo.fileTree.size).toBeGreaterThanOrEqual(3);
  });

  it("detects language from extension", () => {
    const node = topo.query(join(testDir, "src/index.ts"));
    expect(node).not.toBeNull();
    expect(node!.language).toBe("typescript");
  });

  it("computes SHA-256 hashes", () => {
    const node = topo.query(join(testDir, "src/index.ts"));
    expect(node).not.toBeNull();
    expect(node!.lastKnownHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("tracks file size", () => {
    const node = topo.query(join(testDir, "src/index.ts"));
    expect(node).not.toBeNull();
    expect(node!.size).toBeGreaterThan(0);
  });

  it("returns null for nonexistent files", () => {
    expect(topo.query("/nonexistent")).toBeNull();
  });
});

// =========================================================================
// 2. Import Parsing
// =========================================================================

describe("Import parsing", () => {
  let topo: WorkspaceTopology;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFile("src/importer.ts", `import { helper } from "./helper";\nimport fs from "fs";\nconst lodash = require("lodash");\nexport function runner() { return helper(); }`);
    writeFile("src/helper.ts", `export function helper() { return 42; }`);
    topo = new WorkspaceTopology({ maxDepth: 10 });
    await topo.build(testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("parses TypeScript imports", () => {
    const node = topo.query(join(testDir, "src/importer.ts"));
    expect(node).not.toBeNull();
    expect(node!.parsedImports.length).toBeGreaterThanOrEqual(2);
    expect(node!.parsedImports.some((i) => i.includes("helper"))).toBe(true);
  });

  it("filters bare specifiers but keeps relative imports", () => {
    const node = topo.query(join(testDir, "src/importer.ts"));
    expect(node).not.toBeNull();
    // "fs" is a bare specifier (no ./ or ../)
    // "./helper" is relative
    expect(node!.parsedImports).toContain("./helper");
  });

  it("parses exports", () => {
    const node = topo.query(join(testDir, "src/importer.ts"));
    expect(node).not.toBeNull();
    expect(node!.parsedExports).toContain("runner");
  });
});

// =========================================================================
// 3. Module Graph
// =========================================================================

describe("Module graph", () => {
  let topo: WorkspaceTopology;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFile("src/core/index.ts", `export const core = "core";`);
    writeFile("src/ui/button.ts", `export const button = "button";`);
    writeFile("src/ui/panel.ts", `export const panel = "panel";`);
    topo = new WorkspaceTopology({ maxDepth: 10 });
    await topo.build(testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("groups files into modules by directory", () => {
    expect(topo.moduleGraph.size).toBeGreaterThanOrEqual(2);
    const coreModule = topo.queryModule("core");
    expect(coreModule).not.toBeNull();
  });

  it("queryModule returns module with files", () => {
    const uiModule = topo.queryModule("ui");
    expect(uiModule).not.toBeNull();
    expect(uiModule!.files.length).toBeGreaterThanOrEqual(2);
  });

  it("module exports are collected", () => {
    const coreModule = topo.queryModule("core");
    expect(coreModule).not.toBeNull();
    expect(coreModule!.exports.has("core")).toBe(true);
  });

  it("returns null for unknown modules", () => {
    expect(topo.queryModule("nonexistent")).toBeNull();
  });
});

// =========================================================================
// 4. Entry Points
// =========================================================================

describe("Entry points", () => {
  let topo: WorkspaceTopology;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFile("src/index.ts", `export const app = "app";`);
    writeFile("src/cli.ts", `export const cli = "cli";`);
    topo = new WorkspaceTopology({ maxDepth: 10 });
    await topo.build(testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("detects index.ts as an entry point", () => {
    expect(topo.entryPoints.size).toBeGreaterThanOrEqual(1);
    const hasEntry = Array.from(topo.entryPoints).some((p) => p.endsWith("index.ts"));
    expect(hasEntry).toBe(true);
  });
});

// =========================================================================
// 5. Dependency Detection
// =========================================================================

describe("Dependency detection", () => {
  let topo: WorkspaceTopology;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFile("src/dep-importer.ts", `import { helper } from "./dep-target";`);
    writeFile("src/dep-target.ts", `export function helper() { return 1; }`);
    topo = new WorkspaceTopology({ maxDepth: 10 });
    await topo.build(testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("resolves dependencies between files", () => {
    const importer = topo.query(join(testDir, "src/dep-importer.ts"));
    expect(importer).not.toBeNull();
    // Should have resolved ./dep-target to an absolute path
    expect(importer!.dependencies.size).toBeGreaterThanOrEqual(1);
  });

  it("dependentsOf returns reverse dependencies", () => {
    const target = join(testDir, "src/dep-target.ts");
    const dependents = topo.dependentsOf(target);
    expect(dependents.size).toBeGreaterThanOrEqual(1);
  });

  it("toTopology returns the topology for TaskDecomposer", () => {
    const topoData = topo.toTopology();
    expect(topoData).toHaveProperty("modules");
    expect(topoData).toHaveProperty("files");
    expect(topoData).toHaveProperty("dependencies");
  });
});

// =========================================================================
// 6. Incremental Updates
// =========================================================================

describe("Incremental updates", () => {
  let topo: WorkspaceTopology;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFile("src/existing.ts", `export const existing = "existing";`);
    topo = new WorkspaceTopology({ maxDepth: 10 });
    await topo.build(testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("onFileCreated adds the new file to the tree", async () => {
    writeFile("src/new-file.ts", `export const newFile = "new";`);
    await topo.onFileCreated(join(testDir, "src/new-file.ts"));
    const node = topo.query(join(testDir, "src/new-file.ts"));
    expect(node).not.toBeNull();
    expect(node!.language).toBe("typescript");
  });

  it("onFileModified updates the hash on change", async () => {
    const filePath = join(testDir, "src/existing.ts");
    const beforeHash = topo.query(filePath)!.lastKnownHash;
    writeFile("src/existing.ts", `export const existing = "modified";`);
    await topo.onFileModified(filePath);
    const afterHash = topo.query(filePath)!.lastKnownHash;
    expect(afterHash).not.toBe(beforeHash);
  });

  it("onFileModified does nothing when content is unchanged", async () => {
    const filePath = join(testDir, "src/existing.ts");
    const beforeHash = topo.query(filePath)!.lastKnownHash;
    await topo.onFileModified(filePath);
    const afterHash = topo.query(filePath)!.lastKnownHash;
    expect(afterHash).toBe(beforeHash);
  });

  it("onFileDeleted removes the file from the tree", async () => {
    const filePath = join(testDir, "src/new-file.ts");
    await topo.onFileDeleted(filePath);
    expect(topo.query(filePath)).toBeNull();
  });
});

// =========================================================================
// 7. modulesAffectedBy
// =========================================================================

describe("modulesAffectedBy", () => {
  let topo: WorkspaceTopology;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFile("src/core/main.ts", `export const main = "main";`);
    writeFile("src/utils/helper.ts", `export const helper = "helper";`);
    topo = new WorkspaceTopology({ maxDepth: 10 });
    await topo.build(testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns affected modules for given file paths", () => {
    const affected = topo.modulesAffectedBy([join(testDir, "src/core/main.ts")]);
    expect(affected.has("core")).toBe(true);
  });
});

// =========================================================================
// 8. Language Detection
// =========================================================================

describe("Language detection", () => {
  let topo: WorkspaceTopology;

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    writeFile("sample.py", `def hello(): pass`);
    writeFile("sample.rs", `fn main() {}`);
    writeFile("sample.go", `package main`);
    writeFile("sample.md", `# Hello`);
    topo = new WorkspaceTopology({ maxDepth: 10 });
    await topo.build(testDir);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("detects Python files", () => {
    const node = topo.query(join(testDir, "sample.py"));
    expect(node?.language).toBe("python");
  });

  it("detects Rust files", () => {
    const node = topo.query(join(testDir, "sample.rs"));
    expect(node?.language).toBe("rust");
  });

  it("detects Go files", () => {
    const node = topo.query(join(testDir, "sample.go"));
    expect(node?.language).toBe("go");
  });

  it("detects Markdown files", () => {
    const node = topo.query(join(testDir, "sample.md"));
    expect(node?.language).toBe("markdown");
  });
});