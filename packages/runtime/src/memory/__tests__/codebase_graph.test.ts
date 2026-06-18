/**
 * Tests for CodebaseGraphIndex — Live codebase graph.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodebaseGraphIndex } from "../codebase_graph.js";

describe("CodebaseGraphIndex", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "codebase-graph-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Helpers ----

  function writeFile(relPath: string, content: string): string {
    const fullPath = join(tmpDir, relPath);
    mkdirSync(join(tmpDir, dirname(relPath)), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
    return fullPath;
  }

  function dirname(p: string): string {
    const parts = p.split("/");
    parts.pop();
    return parts.join("/") || ".";
  }

  // ===================================================================
  // build()
  // ===================================================================

  it("should build index from workspace with TS files", async () => {
    writeFile("src/core/index.ts", "export class CoreService {}");
    writeFile("src/core/utils.ts", "export function helper() {}");
    writeFile("src/ui/Button.tsx", "export const Button = () => {};");

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    expect(index.files.size).toBe(3);

    // Check file nodes
    const coreIndex = index.files.get(join(tmpDir, "src/core/index.ts"));
    expect(coreIndex).toBeDefined();
    expect(coreIndex!.language).toBe("typescript");
    expect(coreIndex!.astHash).toBeTruthy();
    expect(coreIndex!.symbols).toHaveLength(1);
    expect(coreIndex!.symbols[0]!.name).toBe("CoreService");
    expect(coreIndex!.symbols[0]!.kind).toBe("class");
    expect(coreIndex!.symbols[0]!.scope).toBe("exported");

    // Check symbol map
    const coreServiceRefs = index.lookupSymbol("CoreService");
    expect(coreServiceRefs).toHaveLength(1);

    const helperRefs = index.lookupSymbol("helper");
    expect(helperRefs).toHaveLength(1);

    // Check modules
    expect(index.modules.has("core")).toBe(true);
    expect(index.modules.has("ui")).toBe(true);
  });

  it("should handle files with no parsable content", async () => {
    writeFile("empty.ts", "");
    writeFile("readme.md", "# Just a readme");

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    // Empty TS file should have empty symbols/imports but still be tracked
    const emptyNode = index.files.get(join(tmpDir, "empty.ts"));
    expect(emptyNode).toBeDefined();
    expect(emptyNode!.symbols).toHaveLength(0);
    expect(emptyNode!.imports).toHaveLength(0);
    expect(emptyNode!.language).toBe("typescript");

    // .md files are not in the include pattern, so should not be present
    expect(index.files.has(join(tmpDir, "readme.md"))).toBe(false);
  });

  it("should parse imports and exports for TypeScript", async () => {
    writeFile("src/app.ts", `
      import { Component } from "./component";
      import React from "react";
      import * as Utils from "./utils";
      import "./styles.css";
      export class App {}
      export function render() {}
      export interface Props {}
      export type State = Record<string, unknown>;
      export const VERSION = "1.0";
      class InternalHelper {}
      function internalUtil() {}
    `);

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    const appFile = join(tmpDir, "src/app.ts");
    const node = index.files.get(appFile);
    expect(node).toBeDefined();

    // Imports
    expect(node!.imports).toHaveLength(4);
    const reactImport = node!.imports.find((i) => i.source === "react");
    expect(reactImport).toBeDefined();

    // Symbols: exported ones + internal
    expect(node!.symbols.length).toBeGreaterThanOrEqual(7); // App, render, Props, State, VERSION, InternalHelper, internalUtil
    expect(node!.symbols.some((s) => s.name === "App" && s.scope === "exported")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "render" && s.scope === "exported")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "Props" && s.scope === "exported")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "State" && s.scope === "exported")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "VERSION" && s.scope === "exported")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "InternalHelper" && s.scope === "internal")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "internalUtil" && s.scope === "internal")).toBe(true);
  });

  it("should parse Python files", async () => {
    writeFile("src/main.py", `
      import os
      from typing import List, Optional
      from .utils import helper

      class MyService:
          pass

      def run():
          pass
    `);

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    const file = join(tmpDir, "src/main.py");
    const node = index.files.get(file);
    expect(node).toBeDefined();
    expect(node!.language).toBe("python");
    expect(node!.imports.length).toBeGreaterThanOrEqual(3);
    expect(node!.symbols.some((s) => s.name === "MyService" && s.kind === "class")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "run" && s.kind === "function")).toBe(true);
  });

  it("should parse Rust files", async () => {
    writeFile("src/lib.rs", `
      use std::collections::HashMap;
      use crate::utils::helper;

      pub struct Config {
          pub name: String,
      }

      pub fn start() {}
      fn internal_helper() {}
    `);

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    const file = join(tmpDir, "src/lib.rs");
    const node = index.files.get(file);
    expect(node).toBeDefined();
    expect(node!.language).toBe("rust");
    expect(node!.symbols.some((s) => s.name === "Config" && s.kind === "class" && s.scope === "exported")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "start" && s.kind === "function" && s.scope === "exported")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "internal_helper" && s.scope === "internal")).toBe(true);
  });

  it("should parse Go files", async () => {
    writeFile("src/server.go", `
      package server

      import (
          "fmt"
          "net/http"
      )

      func Start() {}
      func handleRequest() {}
      type Config struct {}
    `);

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    const file = join(tmpDir, "src/server.go");
    const node = index.files.get(file);
    expect(node).toBeDefined();
    expect(node!.language).toBe("go");
    expect(node!.symbols.some((s) => s.name === "Start" && s.scope === "exported")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "handleRequest" && s.scope === "internal")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "Config" && s.kind === "type" && s.scope === "exported")).toBe(true);
  });

  it("should parse Java files", async () => {
    writeFile("src/com/example/App.java", `
      package com.example;
      import java.util.List;
      import java.util.ArrayList;

      public class App {
          public static void main(String[] args) {}
      }

      class Helper {}
    `);

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    const file = join(tmpDir, "src/com/example/App.java");
    const node = index.files.get(file);
    expect(node).toBeDefined();
    expect(node!.language).toBe("java");
    expect(node!.symbols.some((s) => s.name === "App" && s.kind === "class" && s.scope === "public")).toBe(true);
    expect(node!.symbols.some((s) => s.name === "Helper" && s.kind === "class" && s.scope === "internal")).toBe(true);
  });

  // ===================================================================
  // onFileChanged()
  // ===================================================================

  it("should detect changes and re-parse on file change", async () => {
    writeFile("src/mod.ts", "export const VERSION = 1;");

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    expect(index.lookupSymbol("VERSION")).toHaveLength(1);

    // Modify file
    writeFile("src/mod.ts", "export const VERSION = 2;\nexport function upgrade() {}");
    await index.onFileChanged(join(tmpDir, "src/mod.ts"));

    expect(index.lookupSymbol("VERSION")).toHaveLength(1);
    expect(index.lookupSymbol("upgrade")).toHaveLength(1);
  });

  it("should skip if file hash is unchanged", async () => {
    writeFile("src/mod.ts", "export const X = 1;");

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    const initialHash = index.files.get(join(tmpDir, "src/mod.ts"))!.astHash;

    // "Change" with same content
    await index.onFileChanged(join(tmpDir, "src/mod.ts"));

    expect(index.files.get(join(tmpDir, "src/mod.ts"))!.astHash).toBe(initialHash);
  });

  // ===================================================================
  // onFileDeleted()
  // ===================================================================

  it("should remove symbols and file entry on deletion", async () => {
    writeFile("src/a.ts", "export class A {}");
    writeFile("src/b.ts", "export class B {}");

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    expect(index.lookupSymbol("A")).toHaveLength(1);
    expect(index.lookupSymbol("B")).toHaveLength(1);
    expect(index.files.has(join(tmpDir, "src/a.ts"))).toBe(true);

    await index.onFileDeleted(join(tmpDir, "src/a.ts"));

    expect(index.lookupSymbol("A")).toHaveLength(0);
    expect(index.files.has(join(tmpDir, "src/a.ts"))).toBe(false);
    expect(index.lookupSymbol("B")).toHaveLength(1); // B should remain
  });

  // ===================================================================
  // Query Methods
  // ===================================================================

  describe("query methods", () => {
    beforeEach(async () => {
      writeFile("src/core/service.ts", `
        import { Logger } from "./logger";
        import { Config } from "../config/settings";

        export class Service {
            start() {}
        }

        function internalSetup() {}
      `);
      writeFile("src/core/logger.ts", "export class Logger {}");
      writeFile("src/config/settings.ts", "export class Config {}");
    });

    it("lookupSymbol", async () => {
      const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
      await index.build(tmpDir);

      const refs = index.lookupSymbol("Service");
      expect(refs).toHaveLength(1);
      expect(refs[0]!.location.file).toContain("service.ts");

      // Unknown symbol
      expect(index.lookupSymbol("NonExistent")).toEqual([]);
    });

    it("findReferences", async () => {
      const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
      await index.build(tmpDir);

      const locs = index.findReferences("Service");
      expect(locs).toHaveLength(1);

      // Filter by file
      const filtered = index.findReferences("Service", join(tmpDir, "src/core/service.ts"));
      expect(filtered).toHaveLength(1);

      const noMatch = index.findReferences("Service", join(tmpDir, "nonexistent.ts"));
      expect(noMatch).toHaveLength(0);
    });

    it("moduleOf", async () => {
      const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
      await index.build(tmpDir);

      const mod1 = index.moduleOf(join(tmpDir, "src/core/service.ts"));
      expect(mod1).not.toBeNull();
      expect(mod1!.internalDeps).toContain("config");
      expect(mod1!.externalDeps).toEqual([]);

      // Non-existent file
      const mod2 = index.moduleOf(join(tmpDir, "nonexistent.ts"));
      expect(mod2).toBeNull();
    });

    it("dependentsOfModule", async () => {
      const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
      await index.build(tmpDir);

      const deps = index.dependentsOfModule("config");
      expect(deps).toContain("core");
    });

    it("dependentsOf", async () => {
      const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
      await index.build(tmpDir);

      const loggerPath = join(tmpDir, "src/core/logger.ts");
      const deps = index.dependentsOf(loggerPath);
      expect(deps).toContain(join(tmpDir, "src/core/service.ts"));
    });

    it("affectedModules", async () => {
      const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
      await index.build(tmpDir);

      const affected = index.affectedModules([join(tmpDir, "src/core/logger.ts")]);
      expect(affected).toContain("core");
      // config is not affected by changes to logger
      expect(affected).not.toContain("config");
    });

    it("checkBoundaries", async () => {
      const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
      index.boundaries.push(
        { source: "ui", target: "infrastructure", allowed: false },
        { source: "core", target: "data", allowed: true },
      );

      expect(index.checkBoundaries("ui/Button.tsx", "infrastructure/db.ts")).toBe("blocked");
      expect(index.checkBoundaries("core/service.ts", "data/repo.ts")).toBe("allowed");
      expect(index.checkBoundaries("ui/Button.tsx", "core/service.ts")).toBe("no_rule");
    });
  });

  // ===================================================================
  // Module Graph Building
  // ===================================================================

  it("should correctly resolve internal and external deps", async () => {
    writeFile("src/app/main.ts", `
      import { Helper } from "../lib/helper";
      import express from "express";
      import fs from "node:fs";
    `);
    writeFile("src/lib/helper.ts", "export class Helper {}");

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    const appMod = index.modules.get("app");
    expect(appMod).toBeDefined();
    expect(appMod!.internalDeps).toContain("lib");
    expect(appMod!.externalDeps).toContain("express");
    expect(appMod!.externalDeps).toContain("node:fs");
  });

  // ===================================================================
  // Persistence
  // ===================================================================

  it("should serialize and deserialize correctly", async () => {
    writeFile("src/mod.ts", "export const X = 1;\nexport class Y {}");

    const index1 = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index1.build(tmpDir);

    const filePath = join(tmpDir, "src/mod.ts");
    expect(index1.files.has(filePath)).toBe(true);
    expect(index1.lookupSymbol("X")).toHaveLength(1);
    expect(index1.lookupSymbol("Y")).toHaveLength(1);
    expect(index1.modules.size).toBeGreaterThan(0);

    // Serialize
    await index1.serialize();

    // Create a new index and deserialize
    const index2 = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    const loaded = await index2.deserialize();
    expect(loaded).toBe(true);

    expect(index2.files.has(filePath)).toBe(true);
    expect(index2.lookupSymbol("X")).toHaveLength(1);
    expect(index2.lookupSymbol("Y")).toHaveLength(1);
    expect(index2.files.get(filePath)!.astHash).toBe(index1.files.get(filePath)!.astHash);
  });

  it("should handle deserialize from non-existent file", async () => {
    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory/nonexistent") });
    const loaded = await index.deserialize();
    expect(loaded).toBe(false);
  });

  // ===================================================================
  // Auto-Flush
  // ===================================================================

  it("should start and stop auto-flush timer", async () => {
    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory"), autoFlushInterval: 500 });
    index.startAutoFlush();
    expect((index as any)._flushTimer).not.toBeNull();

    index.stopAutoFlush();
    expect((index as any)._flushTimer).toBeNull();
  });

// ===================================================================
  // Scope & Kind Inference
  // ===================================================================

  it("should detect private scope and method kind in TypeScript class methods", async () => {
    writeFile("src/service.ts", `
      export class Service {
        private secret: string;
        public name: string;
        private validate(): boolean { return true; }
        public execute(): void {}
        helper(): void {}
      }
    `);

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    const file = join(tmpDir, "src/service.ts");
    const node = index.files.get(file);
    expect(node).toBeDefined();

    // Private field
    const secret = node!.symbols.find((s) => s.name === "secret");
    expect(secret).toBeDefined();
    expect(secret!.scope).toBe("private");
    expect(secret!.kind).toBe("variable");

    // Private method
    const validateSym = node!.symbols.find((s) => s.name === "validate");
    expect(validateSym).toBeDefined();
    expect(validateSym!.scope).toBe("private");
    expect(validateSym!.kind).toBe("method");

    // Public method (explicit)
    const executeSym = node!.symbols.find((s) => s.name === "execute");
    expect(executeSym).toBeDefined();
    expect(executeSym!.kind).toBe("method");

    // Implicit public method (no access modifier)
    const helperSym = node!.symbols.find((s) => s.name === "helper" && s.kind === "method");
    expect(helperSym).toBeDefined();
    expect(helperSym!.scope).toBe("public");
  });

  it("should detect private members in Java", async () => {
    writeFile("src/com/example/Service.java", `
      package com.example;
      public class Service {
        private int counter;
        private void helper() {}
        public String name;
      }
    `);

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    const file = join(tmpDir, "src/com/example/Service.java");
    const node = index.files.get(file);
    expect(node).toBeDefined();

    const counterSym = node!.symbols.find((s) => s.name === "counter");
    expect(counterSym).toBeDefined();
    expect(counterSym!.scope).toBe("private");
    expect(counterSym!.kind).toBe("variable");

    const helperSym = node!.symbols.find((s) => s.name === "helper");
    expect(helperSym).toBeDefined();
    expect(helperSym!.scope).toBe("private");
    expect(helperSym!.kind).toBe("method");
  });

  // ===================================================================
  // export default
  // ===================================================================

  it("should detect export default declarations", async () => {
    writeFile("src/app.ts", `
      export default class App {}
    `);
    writeFile("src/util.ts", `
      export default function run() {}
    `);

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    const appFile = join(tmpDir, "src/app.ts");
    const appNode = index.files.get(appFile);
    expect(appNode).toBeDefined();
    expect(appNode!.symbols.some((s) => s.name === "App" && s.scope === "exported" && s.kind === "class")).toBe(true);

    const utilFile = join(tmpDir, "src/util.ts");
    const utilNode = index.files.get(utilFile);
    expect(utilNode).toBeDefined();
    expect(utilNode!.symbols.some((s) => s.name === "run" && s.scope === "exported" && s.kind === "function")).toBe(true);
  });

  // ===================================================================
  // Dependency Propagation on Deletion
  // ===================================================================

  it("should propagate dependency changes on file deletion", async () => {
    writeFile("src/moduleA/a.ts", `
      import { B } from "../moduleB/b";
      export class A {}
    `);
    writeFile("src/moduleB/b.ts", "export class B {}");
    writeFile("src/moduleC/c.ts", "export class C {}");

    const index = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index.build(tmpDir);

    // Verify initial module deps
    const moduleA = index.modules.get("moduleA");
    expect(moduleA).toBeDefined();
    expect(moduleA!.internalDeps).toContain("moduleB");

    // Verify dependents
    const bPath = join(tmpDir, "src/moduleB/b.ts");
    const depsBefore = index.dependentsOf(bPath);
    expect(depsBefore).toContain(join(tmpDir, "src/moduleA/a.ts"));

    // Delete b.ts
    await index.onFileDeleted(bPath);

    // Module B should be gone
    expect(index.modules.has("moduleB")).toBe(false);
    expect(index.files.has(bPath)).toBe(false);
    expect(index.lookupSymbol("B")).toHaveLength(0);

    // A should no longer have moduleB dep (modules rebuilt)
    const moduleAAfter = index.modules.get("moduleA");
    expect(moduleAAfter).toBeDefined();
    expect(moduleAAfter!.internalDeps).not.toContain("moduleB");

    // C should be unaffected
    expect(index.modules.has("moduleC")).toBe(true);
    expect(index.lookupSymbol("C")).toHaveLength(1);
  });

  // ===================================================================
  // Check serialization preserves workspaceRoot
  // ===================================================================

  it("should preserve workspace root across serialize/deserialize", async () => {
    writeFile("src/mod.ts", "export const X = 1;");

    const index1 = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index1.build(tmpDir);

    expect(index1.getWorkspaceRoot()).toBe(tmpDir);

    // Serialize
    await index1.serialize();

    // Deserialize
    const index2 = new CodebaseGraphIndex({ persistRoot: join(tmpDir, ".Q/memory") });
    await index2.deserialize();

    expect(index2.getWorkspaceRoot()).toBe(tmpDir);
  });
});