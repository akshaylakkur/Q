/**
 * VerificationPipeline — Multi-Gate Validation Framework (Step 30)
 *
 * Runs a configurable sequence of validation gates on a set of modified files.
 * Each gate implements VerificationGate and returns structured diagnostics.
 *
 * Step 30 (verification & polish) — full implementation of all seven gates:
 *   1. SyntaxCheckGate        — TS, JS (Babel), Python, Rust, Go
 *   2. LintCheckGate          — eslint, ruff, golangci-lint, clippy (SARIF → JSON → text)
 *   3. TypeCheckGate          — tsc, pyright, cargo, go build (modified files + dependents)
 *   4. UnitTestGate           — vitest, jest, pytest, cargo test, go test
 *   5. IntegrationTestGate    — cross-module tests, AbortSignal.timeout per test
 *   6. ArchitectureCheckGate  — delegates to CodebaseGraphIndex.checkBoundaries()
 *   7. FullTestSuiteGate      — runs the entire test suite (Campaign-mode only)
 *
 * Each gate is wrapped with per-gate AbortSignal.timeout() and a SHA-256 file
 * hash cache so unchanged files are skipped. Progress is emitted through
 * PipelineReporter (an EventEmitter) as plain objects that round-trip through
 * JSON.stringify for RPC transport.
 */

import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename, extname, dirname } from "node:path";
import { EventEmitter } from "node:events";
import { parse as babelParse } from "@babel/parser";

// Lazy TypeScript import — the typescript package has side effects on import
// that dump enum definitions to stdout. We use a dynamic import to avoid this
// until the first time TypeScript parsing is actually needed.
let _ts: typeof import("typescript") | null = null;
async function getTS(): Promise<typeof import("typescript")> {
  if (!_ts) {
    _ts = await import("typescript");
  }
  return _ts;
}
import type { WorkspaceTopology } from "./topology.js";


// =========================================================================
// Types
// =========================================================================

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: DiagnosticSeverity;
  rule: string;
  code: string;
}

export interface GateResult {
  passed: boolean;
  diagnostics: Diagnostic[];
  durationMs: number;
  /** Optional short message used by the TUI to show a hint for the next step. */
  correctionHint?: string;
  /** True when the gate did not run because no tool was detected. */
  skipped?: boolean;
  /** Reason text when `skipped` is true. */
  skipReason?: string;
  /** Optional summary line for full-suite / test results. */
  summary?: string;
}

export interface GateContext {
  workspaceRoot: string;
  codebaseGraph?: WorkspaceTopology;
  reporter?: PipelineReporter;
  signal?: AbortSignal;
  /**
   * Internal hook for the integration gate's per-test timeout. The pipeline
   * sets this when invoking `IntegrationTestGate` so the gate can compose
   * the per-gate signal with `AbortSignal.timeout(perTest)`.
   */
  _perTestMs?: number;
}

export type GateScope = "modified_files" | "affected_modules" | "transitive_dependents" | "full_suite";

export interface VerificationGate {
  name: string;
  scope: GateScope;
  /** Default per-gate timeout in ms (overridable by TimeoutConfig). */
  defaultTimeoutMs: number;
  run(files: string[], context: GateContext): Promise<GateResult>;
}

export interface PipelineResult {
  passed: boolean;
  gateResults: Map<string, GateResult>;
  diagnostics: Diagnostic[];
  durationMs: number;
  cached: boolean;
}

type ProgressEventType =
  | "gate.started"
  | "gate.passed"
  | "gate.failed"
  | "gate.skipped"
  | "pipeline.passed"
  | "pipeline.failed";

export interface PipelineProgressEvent {
  type: ProgressEventType;
  gateName?: string;
  /** Files the gate was asked to verify. */
  files?: string[];
  /** Reason text used by `gate.skipped`. */
  reason?: string;
  /** Name of the first failing gate (used by `pipeline.failed`). */
  failingGate?: string;
  durationMs?: number;
  diagnosticCount?: number;
  /**
   * Actual diagnostic objects — included on `gate.failed` so the TUI can
   * display the full error list without round-tripping through the
   * `gateResults` map.
   */
  diagnostics?: Diagnostic[];
  /** Names of all gates the pipeline ran (used by pipeline events). */
  gates?: string[];
  timestamp: string;
}

// =========================================================================
// PipelineReporter
// =========================================================================

/**
 * Emits structured progress events through Node's EventEmitter.
 * Each event is a plain object that JSON-serializes for the RPC channel.
 */
export class PipelineReporter extends EventEmitter {
  emitProgress(event: PipelineProgressEvent): void {
    this.emit("progress", event);
  }
}

// =========================================================================
// Utility Functions
// =========================================================================

/** Grace period (ms) before SIGKILL is sent after SIGTERM. */
const SIGKILL_GRACE_MS = 5_000;

/** Per spec: `child_process.execFile` with `maxBuffer: 10 * 1024 * 1024` (10MB). */
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

function iso(): string {
  return new Date().toISOString();
}

/** SHA-256 of the file content (matches the spec's `fileHashes: Map<path,SHA-256>`). */
function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function getLanguage(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
    py: "python", rs: "rust", go: "go",
  };
  return map[ext] ?? "unknown";
}

/** Check if a binary exists on PATH (resolves via `which`). */
function binaryExists(bin: string): boolean {
  // Use `which` so we don't need an extra npm dep.
  try {
    const r = spawnSync("which", [bin], { encoding: "utf-8" });
    return r.status === 0 && !!r.stdout?.trim();
  } catch {
    return false;
  }
}

/** Find the nearest Cargo.toml by walking up from a file path. */
function findCargoManifest(filePath: string): string | null {
  let dir = dirname(filePath);
  while (true) {
    if (existsSync(resolve(dir, "Cargo.toml"))) return resolve(dir, "Cargo.toml");
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function execWithAbort(
  file: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number; notFound?: boolean }> {
  return new Promise((resolveP, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    let child;
    try {
      child = execFile(file, args, {
        cwd: options.cwd,
        maxBuffer: EXEC_MAX_BUFFER,
        timeout: options.timeout,
      }, (error, stdout, stderr) => {
        if (error && (error as { code?: string }).code === "ENOENT") {
          settle(() => resolveP({ stdout, stderr: stderr || "", exitCode: -1, notFound: true }));
          return;
        }
        const exitCode = error ? (typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : 1) : 0;
        settle(() => resolveP({ stdout, stderr: stderr || "", exitCode }));
      });
    } catch (err) {
      settle(() => reject(err));
      return;
    }

    if (options.signal) {
      const abortHandler = () => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, SIGKILL_GRACE_MS);
        settle(() => reject(new Error("Command aborted by signal")));
      };
      if (options.signal.aborted) {
        abortHandler();
        return;
      }
      options.signal.addEventListener("abort", abortHandler, { once: true });
      child.on("exit", () => options.signal?.removeEventListener("abort", abortHandler));
    }
  });
}

// =========================================================================
// Linter Detection
// =========================================================================

interface LinterConfig {
  name: string;
  configFiles: string[];
  binary: string;
  args: (files: string[]) => string[];
  /** Returns null if the output is not parseable. */
  parse: (stdout: string, stderr: string) => Diagnostic[] | null;
  /** Returns null if the output is not parseable. */
  parseSarif?: (stdout: string) => Diagnostic[] | null;
}

function tryParseLinterOutput(stdout: string, stderr: string, parse: (s: string, e: string) => Diagnostic[] | null): Diagnostic[] {
  if (parse) {
    const diags = parse(stdout, stderr);
    if (diags !== null) return diags;
  }
  return parseLineBased(stdout + "\n" + stderr);
}

const LINTER_CONFIGS: LinterConfig[] = [
  {
    name: "eslint",
    configFiles: [".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yaml", ".eslintrc.yml", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"],
    binary: "npx",
    args: (files) => ["eslint", "--format", "json", ...files],
    parse: parseESLintJson,
    parseSarif: parseSarif,
  },
  {
    name: "ruff",
    configFiles: ["ruff.toml", ".ruff.toml", "pyproject.toml"],
    binary: "ruff",
    args: (files) => ["check", "--output-format", "json", ...files],
    parse: parseRuffJson,
  },
  {
    name: "golangci-lint",
    configFiles: [".golangci.yml", ".golangci.yaml", ".golangci.json", ".golangci.toml"],
    binary: "golangci-lint",
    args: (files) => ["run", "--out-format", "json", ...files],
    parse: parseGolangciJson,
  },
  {
    name: "clippy",
    configFiles: ["clippy.toml", ".clippy.toml"],
    binary: "cargo",
    args: () => ["clippy", "--message-format", "json"],
    parse: parseCargoJson,
  },
];

async function detectLinter(workspaceRoot: string): Promise<LinterConfig | null> {
  for (const linter of LINTER_CONFIGS) {
    for (const configFile of linter.configFiles) {
      if (await fileExists(resolve(workspaceRoot, configFile))) {
        return linter;
      }
    }
  }
  try {
    const pkgPath = resolve(workspaceRoot, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    if (pkg.devDependencies?.eslint || pkg.dependencies?.eslint) {
      return LINTER_CONFIGS.find(l => l.name === "eslint") ?? null;
    }
    if (pkg.devDependencies?.ruff || pkg.dependencies?.ruff) {
      return LINTER_CONFIGS.find(l => l.name === "ruff") ?? null;
    }
  } catch {
    // ignore
  }
  return null;
}

// =========================================================================
// Type Checker Detection
// =========================================================================

interface TypeCheckerConfig {
  name: string;
  configFiles: string[];
  binary: string;
  args: (files: string[], workspaceRoot: string) => string[];
  parse: (stdout: string, stderr: string) => Diagnostic[] | null;
}

const TYPE_CHECKER_CONFIGS: TypeCheckerConfig[] = [
  {
    name: "tsc",
    configFiles: ["tsconfig.json"],
    binary: "npx",
    args: () => ["tsc", "--noEmit", "--pretty", "false"],
    parse: parseTscOutput,
  },
  {
    name: "pyright",
    configFiles: ["pyrightconfig.json", "pyproject.toml"],
    binary: "npx",
    args: (files) => ["pyright", ...files],
    parse: parsePyrightOutput,
  },
  {
    name: "cargo-check",
    configFiles: ["Cargo.toml"],
    binary: "cargo",
    args: () => ["check", "--message-format", "json"],
    parse: parseCargoJson,
  },
  {
    name: "go-build",
    configFiles: ["go.mod"],
    binary: "go",
    args: () => ["build", "./..."],
    parse: parseGoBuildOutput,
  },
];

async function detectTypeChecker(workspaceRoot: string): Promise<TypeCheckerConfig | null> {
  for (const checker of TYPE_CHECKER_CONFIGS) {
    for (const configFile of checker.configFiles) {
      if (await fileExists(resolve(workspaceRoot, configFile))) {
        return checker;
      }
    }
  }
  return null;
}

// =========================================================================
// Test Framework Detection
// =========================================================================

interface TestFrameworkConfig {
  name: string;
  configFiles: string[];
  binary: string;
  args: (files: string[]) => string[];
  parse: (stdout: string, stderr: string) => { passed: boolean; diagnostics: Diagnostic[]; summary?: string };
}

const TEST_FRAMEWORKS: TestFrameworkConfig[] = [
  {
    name: "vitest",
    configFiles: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs", "vitest.config.mts"],
    binary: "npx",
    args: (files) => ["vitest", "run", "--reporter=json", ...files],
    parse: parseVitestJson,
  },
  {
    name: "jest",
    configFiles: ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"],
    binary: "npx",
    args: (files) => ["jest", "--json", ...files],
    parse: parseJestJson,
  },
  {
    name: "pytest",
    configFiles: ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"],
    binary: "python",
    args: (files) => ["-m", "pytest", "--json-report", ...files],
    parse: parsePytestJson,
  },
  {
    name: "cargo-test",
    configFiles: ["Cargo.toml"],
    binary: "cargo",
    args: () => ["test", "--no-run", "--message-format", "json"],
    parse: parseCargoTestJson,
  },
  {
    name: "go-test",
    configFiles: ["go.mod"],
    binary: "go",
    args: (files) => ["test", "-json", ...files],
    parse: parseGoTestJson,
  },
];

async function detectTestFramework(workspaceRoot: string): Promise<TestFrameworkConfig | null> {
  for (const framework of TEST_FRAMEWORKS) {
    for (const configFile of framework.configFiles) {
      if (await fileExists(resolve(workspaceRoot, configFile))) {
        return framework;
      }
    }
  }
  try {
    const pkgPath = resolve(workspaceRoot, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    const testScript = pkg.scripts?.test ?? "";
    if (testScript.includes("vitest")) return TEST_FRAMEWORKS.find(f => f.name === "vitest") ?? null;
    if (testScript.includes("jest")) return TEST_FRAMEWORKS.find(f => f.name === "jest") ?? null;
    if (testScript.includes("pytest")) return TEST_FRAMEWORKS.find(f => f.name === "pytest") ?? null;
  } catch {
    // ignore
  }
  return null;
}

// =========================================================================
// Output Parsers
// =========================================================================

function parseESLintJson(stdout: string, _stderr: string): Diagnostic[] | null {
  try {
    const results = JSON.parse(stdout) as Array<{
      filePath: string;
      messages: Array<{ line: number; column: number; message: string; severity: number; ruleId?: string; rule?: string }>;
    }>;
    const out: Diagnostic[] = [];
    for (const result of results) {
      for (const msg of result.messages) {
        out.push({
          file: result.filePath,
          line: msg.line ?? 0,
          column: msg.column ?? 0,
          message: msg.message,
          severity: msg.severity === 2 ? "error" : "warning",
          rule: msg.ruleId ?? msg.rule ?? "unknown",
          code: msg.ruleId ?? "ESLINT",
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

function parseRuffJson(stdout: string, _stderr: string): Diagnostic[] | null {
  try {
    const results = JSON.parse(stdout) as Record<string, Array<{
      code: string; message: string; location: { row: number; column: number };
    }>>;
    const out: Diagnostic[] = [];
    for (const [file, msgs] of Object.entries(results)) {
      for (const msg of msgs) {
        out.push({
          file,
          line: msg.location?.row ?? 0,
          column: msg.location?.column ?? 0,
          message: msg.message,
          severity: "warning",
          rule: msg.code ?? "RUFF",
          code: msg.code ?? "RUFF",
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

function parseGolangciJson(stdout: string, _stderr: string): Diagnostic[] | null {
  try {
    const data = JSON.parse(stdout) as {
      Issues?: Array<{ Pos: { Filename: string; Line: number; Column: number }; Text: string; FromLinter: string; Severity?: string }>;
    };
    const out: Diagnostic[] = [];
    for (const issue of data.Issues ?? []) {
      out.push({
        file: issue.Pos?.Filename ?? "unknown",
        line: issue.Pos?.Line ?? 0,
        column: issue.Pos?.Column ?? 0,
        message: issue.Text,
        severity: (issue.Severity?.toLowerCase() as DiagnosticSeverity) ?? "warning",
        rule: issue.FromLinter,
        code: issue.FromLinter,
      });
    }
    return out;
  } catch {
    return null;
  }
}

function parseCargoJson(stdout: string, _stderr: string): Diagnostic[] | null {
  const out: Diagnostic[] = [];
  let parsed = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as {
        reason?: string; message?: { level: string; message: string; spans: Array<{ file_name: string; line_start: number; column_start: number }> };
      };
      parsed = true;
      if (msg.reason === "compiler-message" && msg.message) {
        const span = msg.message.spans?.[0];
        if (span) {
          out.push({
            file: span.file_name,
            line: span.line_start,
            column: span.column_start,
            message: msg.message.message,
            severity: msg.message.level === "error" ? "error" : "warning",
            rule: "cargo",
            code: "CARGO",
          });
        }
      }
    } catch {
      // skip
    }
  }
  return parsed ? out : null;
}

function parseTscOutput(stdout: string, stderr: string): Diagnostic[] | null {
  const combined = stdout + stderr;
  // tsc output format: "path(line,col): error TSxxxx: message"
  const regex = /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(.*?):\s*(.*)$/gm;
  const out: Diagnostic[] = [];
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = regex.exec(combined)) !== null) {
    matched = true;
    out.push({
      file: m[1]?.trim() ?? "",
      line: parseInt(m[2]!, 10) || 0,
      column: parseInt(m[3]!, 10) || 0,
      message: m[6]?.trim() ?? "",
      severity: (m[4] as DiagnosticSeverity) ?? "warning",
      rule: "tsc",
      code: m[5]?.trim() ?? "TS0000",
    });
  }
  if (!matched && !combined.includes("error TS")) return null;
  return out;
}

function parsePyrightOutput(stdout: string, _stderr: string): Diagnostic[] | null {
  const regex = /^(.*):(\d+):(\d+)\s+-\s+(error|warning):\s+(.*)$/gm;
  const out: Diagnostic[] = [];
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = regex.exec(stdout)) !== null) {
    matched = true;
    out.push({
      file: m[1]?.trim() ?? "",
      line: parseInt(m[2]!, 10) || 0,
      column: parseInt(m[3]!, 10) || 0,
      message: m[5]?.trim() ?? "",
      severity: (m[4] as DiagnosticSeverity) ?? "warning",
      rule: "pyright",
      code: "PYRIGHT",
    });
  }
  if (!matched) return null;
  return out;
}

function parseGoBuildOutput(stdout: string, stderr: string): Diagnostic[] | null {
  const combined = stdout + stderr;
  const regex = /^(.*):(\d+):(\d+):\s*(.*)$/gm;
  const out: Diagnostic[] = [];
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = regex.exec(combined)) !== null) {
    matched = true;
    out.push({
      file: m[1]?.trim() ?? "",
      line: parseInt(m[2]!, 10) || 0,
      column: parseInt(m[3]!, 10) || 0,
      message: m[4]?.trim() ?? "",
      severity: "error",
      rule: "go-build",
      code: "GO",
    });
  }
  if (!matched) return null;
  return out;
}

function parseVitestJson(stdout: string, _stderr: string): { passed: boolean; diagnostics: Diagnostic[]; summary?: string } {
  try {
    const data = JSON.parse(stdout) as {
      success?: boolean;
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      startTime?: number;
      testResults?: Array<{ name: string; status: string; message?: string }>;
    };
    const diags: Diagnostic[] = [];
    for (const tr of data.testResults ?? []) {
      if (tr.status !== "passed") {
        diags.push({
          file: tr.name,
          line: 0,
          column: 0,
          message: tr.message ?? `Test failed: ${tr.name}`,
          severity: "error",
          rule: "vitest",
          code: "TEST_FAIL",
        });
      }
    }
    const passed = (data.success ?? false) && diags.length === 0;
    const summary = typeof data.numTotalTests === "number"
      ? `${data.numPassedTests ?? 0} passed / ${data.numFailedTests ?? 0} failed / ${data.numPendingTests ?? 0} skipped (${data.numTotalTests} total)`
      : undefined;
    return { passed, diagnostics: diags, summary };
  } catch {
    return { passed: !stdout.includes("FAIL"), diagnostics: parseLineBased(stdout), summary: undefined };
  }
}

function parseJestJson(stdout: string, _stderr: string): { passed: boolean; diagnostics: Diagnostic[]; summary?: string } {
  try {
    const data = JSON.parse(stdout) as {
      success?: boolean;
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      testResults?: Array<{ name: string; status: string; message?: string }>;
    };
    const diags: Diagnostic[] = [];
    for (const tr of data.testResults ?? []) {
      if (tr.status !== "passed") {
        diags.push({
          file: tr.name,
          line: 0,
          column: 0,
          message: tr.message ?? `Test failed: ${tr.name}`,
          severity: "error",
          rule: "jest",
          code: "TEST_FAIL",
        });
      }
    }
    const passed = data.success !== false;
    const summary = typeof data.numTotalTests === "number"
      ? `${data.numPassedTests ?? 0} passed / ${data.numFailedTests ?? 0} failed / ${data.numPendingTests ?? 0} skipped (${data.numTotalTests} total)`
      : undefined;
    return { passed, diagnostics: diags, summary };
  } catch {
    return { passed: !stdout.includes("FAIL"), diagnostics: parseLineBased(stdout) };
  }
}

function parsePytestJson(stdout: string, stderr: string): { passed: boolean; diagnostics: Diagnostic[]; summary?: string } {
  const combined = stdout + stderr;
  // Try to parse the JSON report first.
  try {
    const data = JSON.parse(stdout) as {
      summary?: { total?: number; passed?: number; failed?: number; skipped?: number };
    };
    if (data.summary) {
      const failed = data.summary.failed ?? 0;
      return {
        passed: failed === 0,
        diagnostics: [],
        summary: `${data.summary.passed ?? 0} passed / ${failed} failed / ${data.summary.skipped ?? 0} skipped (${data.summary.total ?? 0} total)`,
      };
    }
  } catch {
    // fall through
  }
  return { passed: !combined.includes("FAILED") && !combined.includes("ERROR"), diagnostics: [], summary: undefined };
}

function parseCargoTestJson(stdout: string, _stderr: string): { passed: boolean; diagnostics: Diagnostic[]; summary?: string } {
  const diags: Diagnostic[] = [];
  let passed = 0, failed = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as { type?: string; event?: string; name?: string; message?: string };
      if (msg.type === "test" && msg.event === "failed") {
        failed++;
        diags.push({
          file: "unknown",
          line: 0,
          column: 0,
          message: msg.message ?? `Test failed: ${msg.name ?? "unknown"}`,
          severity: "error",
          rule: "cargo-test",
          code: "TEST_FAIL",
        });
      } else if (msg.type === "test" && msg.event === "ok") {
        passed++;
      }
    } catch {
      // skip
    }
  }
  const summary = (passed + failed) > 0 ? `${passed} passed / ${failed} failed` : undefined;
  return { passed: diags.length === 0, diagnostics: diags, summary };
}

function parseGoTestJson(stdout: string, _stderr: string): { passed: boolean; diagnostics: Diagnostic[]; summary?: string } {
  const diags: Diagnostic[] = [];
  let passed = 0, failed = 0, skipped = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as { Action?: string; Test?: string; Output?: string };
      if (msg.Test) {
        if (msg.Action === "pass") passed++;
        else if (msg.Action === "fail") {
          failed++;
          diags.push({
            file: msg.Test,
            line: 0,
            column: 0,
            message: msg.Output ?? `Test failed: ${msg.Test}`,
            severity: "error",
            rule: "go-test",
            code: "TEST_FAIL",
          });
        } else if (msg.Action === "skip") skipped++;
      }
    } catch {
      // skip
    }
  }
  const total = passed + failed + skipped;
  const summary = total > 0 ? `${passed} passed / ${failed} failed / ${skipped} skipped` : undefined;
  return { passed: diags.length === 0, diagnostics: diags, summary };
}

// Exported so the test suite (and any future programmatic consumer) can
// drive the parsers directly without going through a child process.
export function parseSarif(stdout: string): Diagnostic[] | null {
  // SARIF v2.1.0: top-level { $schema, runs: [{ tool, results: [...] }] }
  if (!stdout.includes("\"runs\"") || !stdout.includes("sarif")) return null;
  try {
    const data = JSON.parse(stdout) as {
      runs?: Array<{
        results?: Array<{
          ruleId?: string;
          rule?: { id?: string };
          level?: string; // "error" | "warning" | "note"
          message?: { text?: string };
          locations?: Array<{
            physicalLocation?: {
              artifactLocation?: { uri?: string };
              region?: { startLine?: number; startColumn?: number };
            };
          }>;
        }>;
      }>;
    };
    const out: Diagnostic[] = [];
    for (const run of data.runs ?? []) {
      for (const r of run.results ?? []) {
        const loc = r.locations?.[0]?.physicalLocation;
        const file = loc?.artifactLocation?.uri ?? "unknown";
        const line = loc?.region?.startLine ?? 0;
        const col = loc?.region?.startColumn ?? 0;
        const message = r.message?.text ?? r.ruleId ?? "SARIF result";
        const level = (r.level ?? "warning").toLowerCase();
        const severity: DiagnosticSeverity = level === "error" ? "error" : level === "note" ? "info" : "warning";
        out.push({
          file,
          line,
          column: col,
          message,
          severity,
          rule: r.ruleId ?? r.rule?.id ?? "SARIF",
          code: r.ruleId ?? r.rule?.id ?? "SARIF",
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

function parseLineBased(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const regex = /^(.*?)\((\d+),(\d+)\)?:?\s*(error|warning|info|note|hint):?\s*(.*)$/gim;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(output)) !== null) {
    const rawSeverity = m[4]?.toLowerCase() ?? "warning";
    const severity: DiagnosticSeverity =
      rawSeverity === "error" ? "error"
      : rawSeverity === "warning" ? "warning"
      : rawSeverity === "info" || rawSeverity === "note" || rawSeverity === "hint" ? "info"
      : "warning";
    diagnostics.push({
      file: m[1]?.trim() ?? "",
      line: parseInt(m[2]!, 10) || 0,
      column: parseInt(m[3]!, 10) || 0,
      message: m[5]?.trim() ?? "",
      severity,
      rule: "unknown",
      code: "UNKNOWN",
    });
  }
  return diagnostics;
}

function isTestFile(filePath: string): boolean {
  const base = basename(filePath).toLowerCase();
  return base.includes(".test.") || base.includes(".spec.") || base.includes("_test.") || base === "test.ts" || base === "test.js";
}

/** Per spec: "No [detector] configuration detected — skipping [gate]" pattern. */
function skipResult(gateName: string, reason: string, durationMs: number, code?: string): GateResult {
  return {
    passed: true,
    diagnostics: [{
      file: "",
      line: 0,
      column: 0,
      message: reason,
      severity: "info",
      rule: `${gateName}-detection`,
      code: code ?? `${gateName.toUpperCase().replace(/-/g, "")}_SKIP`,
    }],
    durationMs,
    skipped: true,
    skipReason: reason,
  };
}

// =========================================================================
// Gate Implementations
// =========================================================================

/** 1. SyntaxCheckGate — parses each file in-process. */
export class SyntaxCheckGate implements VerificationGate {
  name = "syntax";
  scope: GateScope = "modified_files";
  defaultTimeoutMs = 30_000;

  async run(files: string[], context: GateContext): Promise<GateResult> {
    const startedAt = Date.now();
    const diagnostics: Diagnostic[] = [];

    for (const file of files) {
      if (context.signal?.aborted) break;
      const lang = getLanguage(file);
      const resolved = resolve(context.workspaceRoot, file);

      try {
        switch (lang) {
          case "typescript": {
            const src = await readFile(resolved, "utf-8");
            // Lazy-load TypeScript to avoid side effects on module import
            const ts = await getTS();
            // Spec: "for TypeScript use ts.createSourceFile() from typescript
            // package (fast in-process parsing)". This is the primary call.
            const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);

            // TypeScript's `SourceFile` carries parse diagnostics on an
            // internal field. The public type doesn't expose it, so we read
            // it via a typed view of the internal shape.
            interface InternalSourceFile extends ts.SourceFile {
              parseDiagnostics?: ReadonlyArray<ts.Diagnostic>;
            }
            const parseDiags = (sf as InternalSourceFile).parseDiagnostics ?? [];
            for (const d of parseDiags) {
              const start = d.start ?? 0;
              const { line, character } = sf.getLineAndCharacterOfPosition(start);
              diagnostics.push({
                file,
                line: line + 1,
                column: character + 1,
                message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
                severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
                rule: "tsc-syntax",
                code: `TS${d.code}`,
              });
            }
            break;
          }
          case "javascript": {
            const src = await readFile(resolved, "utf-8");
            const isJsx = extname(file) === ".jsx";
            try {
              babelParse(src, {
                sourceType: "module",
                plugins: isJsx ? ["jsx"] : [],
                errorRecovery: false,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const locMatch = /(\d+):(\d+)/.exec(msg);
              diagnostics.push({
                file,
                line: locMatch ? parseInt(locMatch[1]!, 10) || 0 : 0,
                column: locMatch ? parseInt(locMatch[2]!, 10) || 0 : 0,
                message: msg,
                severity: "error",
                rule: "babel-syntax",
                code: "BABEL_SYNTAX",
              });
            }
            break;
          }
          case "python": {
            if (!binaryExists("python3")) {
              diagnostics.push({
                file,
                line: 0,
                column: 0,
                message: "python3 not on PATH; cannot run py_compile",
                severity: "info",
                rule: "python-missing",
                code: "PY_MISSING",
              });
              break;
            }
            // Per spec: `python3 -c "compile(open(path).read(), path, 'exec')"`
            // Spec: "python3 -c "compile(open(path).read(), path, 'exec')"".
            // We pass the path as argv so it's not interpolated into the
            // script (avoids quoting issues with paths containing
            // apostrophes or shell metacharacters).
            const script = "import sys\n"
              + "src = open(sys.argv[1], 'r').read()\n"
              + "compile(src, sys.argv[1], 'exec')";
            const { exitCode, stderr } = await execWithAbort("python3", ["-c", script, resolved], { cwd: context.workspaceRoot, signal: context.signal });
            if (exitCode !== 0) {
              // Parse Python's "File \"...\", line N" syntax error.
              const m = /File ".*?", line (\d+)/.exec(stderr);
              const line = m ? parseInt(m[1]!, 10) || 0 : 0;
              const colMatch = /line \d+\s*$/.test(stderr.split("\n").pop() ?? "") ? /\s+(\d+)\s*\n\s*\^/.exec(stderr) : null;
              diagnostics.push({
                file,
                line,
                column: colMatch ? parseInt(colMatch[1]!, 10) || 0 : 0,
                message: stderr.split("\n").slice(0, 2).join(" ").trim() || "Python syntax error",
                severity: "error",
                rule: "python-syntax",
                code: "PY_SYNTAX",
              });
            }
            break;
          }
          case "rust": {
            const manifest = findCargoManifest(resolved);
            if (!manifest) {
              diagnostics.push({
                file,
                line: 0,
                column: 0,
                message: "No Cargo.toml found; cannot run cargo check",
                severity: "info",
                rule: "rust-manifest",
                code: "CARGO_NO_MANIFEST",
              });
              break;
            }
            const { exitCode, stdout, stderr } = await execWithAbort(
              "cargo",
              ["check", "--manifest-path", manifest, "--message-format", "json"],
              { cwd: context.workspaceRoot, signal: context.signal },
            );
            if (exitCode !== 0) {
              const diags = parseCargoJson(stdout, stderr) ?? [];
              diagnostics.push(...diags);
            }
            break;
          }
          case "go": {
            if (!binaryExists("go")) {
              diagnostics.push({
                file,
                line: 0,
                column: 0,
                message: "go not on PATH; cannot run go vet",
                severity: "info",
                rule: "go-missing",
                code: "GO_MISSING",
              });
              break;
            }
            const { exitCode, stdout, stderr } = await execWithAbort("go", ["vet", resolved], { cwd: context.workspaceRoot, signal: context.signal });
            if (exitCode !== 0) {
              const diags = parseGoBuildOutput(stdout, stderr) ?? [];
              diagnostics.push(...diags);
            }
            break;
          }
          default: {
            // unknown — try TypeScript's parser as a best-effort (covers .json etc).
            if (await fileExists(resolved)) {
              try {
                const src = await readFile(resolved, "utf-8");
                const ts = await getTS();
                ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
              } catch {
                // not parseable — silently skip
              }
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics.push({
          file,
          line: 0,
          column: 0,
          message: msg,
          severity: "error",
          rule: `${lang}-syntax`,
          code: "SYNTAX_ERR",
        });
      }
    }

    const passed = diagnostics.filter(d => d.severity === "error").length === 0;
    return {
      passed,
      diagnostics,
      durationMs: Date.now() - startedAt,
      correctionHint: passed ? undefined : `Fix syntax errors in ${diagnostics.map(d => d.file).filter(Boolean).join(", ")}`,
    };
  }
}

/** 2. LintCheckGate — SARIF → JSON → text. */
export class LintCheckGate implements VerificationGate {
  name = "lint";
  scope: GateScope = "modified_files";
  defaultTimeoutMs = 30_000;

  async run(files: string[], context: GateContext): Promise<GateResult> {
    const startedAt = Date.now();
    const linter = await detectLinter(context.workspaceRoot);

    if (!linter) {
      return skipResult("lint", "No linter configuration detected — skipping lint check", Date.now() - startedAt, "LINT_SKIP");
    }

    // Refuse to run on empty file lists (linter would lint the whole repo).
    if (files.length === 0) {
      return skipResult("lint", "No files to lint", Date.now() - startedAt, "LINT_SKIP");
    }

    const resolvedFiles = files.map(f => resolve(context.workspaceRoot, f));
    try {
      const { stdout, stderr, notFound } = await execWithAbort(
        linter.binary,
        linter.args(resolvedFiles),
        { cwd: context.workspaceRoot, signal: context.signal },
      );
      if (notFound) {
        return skipResult("lint", `Linter binary ${linter.binary} not found on PATH`, Date.now() - startedAt, "LINT_SKIP");
      }
      // Spec order: SARIF → JSON → text.
      let diagnostics: Diagnostic[] = [];
      if (linter.parseSarif) {
        const sarif = linter.parseSarif(stdout);
        if (sarif) diagnostics = sarif;
      }
      if (diagnostics.length === 0) {
        const parsed = tryParseLinterOutput(stdout, stderr, linter.parse);
        diagnostics = parsed;
      }
      const passed = diagnostics.filter(d => d.severity === "error").length === 0;
      return {
        passed,
        diagnostics,
        durationMs: Date.now() - startedAt,
        correctionHint: passed ? undefined : `Fix lint errors (${linter.name}) in ${files.join(", ")}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        diagnostics: [{
          file: "",
          line: 0,
          column: 0,
          message: `Linter (${linter.name}) execution failed: ${msg}`,
          severity: "error",
          rule: "lint-exec",
          code: "LINT_FAIL",
        }],
        durationMs: Date.now() - startedAt,
        correctionHint: `Check linter (${linter.name}) configuration and fix errors`,
      };
    }
  }
}

/** 3. TypeCheckGate — runs on modified files + their dependents. */
export class TypeCheckGate implements VerificationGate {
  name = "typecheck";
  scope: GateScope = "affected_modules";
  defaultTimeoutMs = 60_000;

  async run(files: string[], context: GateContext): Promise<GateResult> {
    const startedAt = Date.now();
    const checker = await detectTypeChecker(context.workspaceRoot);

    if (!checker) {
      return skipResult("typecheck", "No type checker configuration detected — skipping type check", Date.now() - startedAt, "TYPE_SKIP");
    }

    // Spec: "run on modified files + their dependents (computed via
    // CodebaseGraphIndex.dependentsOf())". Use the affected-modules union too.
    const expandedFiles = new Set(files);
    if (context.codebaseGraph) {
      for (const file of files) {
        const deps = context.codebaseGraph.dependentsOf(file);
        for (const dep of deps) expandedFiles.add(dep);
      }
      const affectedModules = context.codebaseGraph.modulesAffectedBy(files);
      for (const modName of affectedModules) {
        const mod = context.codebaseGraph.queryModule(modName);
        if (mod) {
          for (const f of mod.files) expandedFiles.add(f);
        }
      }
    }

    try {
      const { stdout, stderr, notFound } = await execWithAbort(
        checker.binary,
        checker.args(Array.from(expandedFiles), context.workspaceRoot),
        { cwd: context.workspaceRoot, signal: context.signal },
      );
      if (notFound) {
        return skipResult("typecheck", `Type checker binary ${checker.binary} not found on PATH`, Date.now() - startedAt, "TYPE_SKIP");
      }
      const diagnostics = checker.parse(stdout, stderr) ?? [];
      const passed = diagnostics.filter(d => d.severity === "error").length === 0;
      return {
        passed,
        diagnostics,
        durationMs: Date.now() - startedAt,
        correctionHint: passed ? undefined : `Fix type errors (${checker.name}) — check ${diagnostics[0]?.file ?? "affected files"}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        diagnostics: [{
          file: "",
          line: 0,
          column: 0,
          message: `Type checker (${checker.name}) execution failed: ${msg}`,
          severity: "error",
          rule: "type-exec",
          code: "TYPE_FAIL",
        }],
        durationMs: Date.now() - startedAt,
        correctionHint: `Check type checker (${checker.name}) configuration`,
      };
    }
  }
}

/** 4. UnitTestGate — runs only tests in modules affected by the changes. */
export class UnitTestGate implements VerificationGate {
  name = "unit-test";
  scope: GateScope = "affected_modules";
  defaultTimeoutMs = 120_000;

  async run(files: string[], context: GateContext): Promise<GateResult> {
    const startedAt = Date.now();
    const framework = await detectTestFramework(context.workspaceRoot);

    if (!framework) {
      return skipResult("unit-test", "No test framework detected — skipping unit tests", Date.now() - startedAt, "TEST_SKIP");
    }

    // Spec: "run only the tests in modules affected by the changes (mapped via
    // CodebaseGraphIndex)".
    const testFiles: string[] = [];
    if (context.codebaseGraph) {
      const affectedModules = context.codebaseGraph.modulesAffectedBy(files);
      for (const modName of affectedModules) {
        const mod = context.codebaseGraph.queryModule(modName);
        if (mod) {
          for (const f of mod.files) {
            if (isTestFile(f)) testFiles.push(f);
          }
        }
      }
    }

    const targets = testFiles.length > 0 ? testFiles : files.filter(f => isTestFile(f));
    if (targets.length === 0) {
      return skipResult("unit-test", "No test files found in affected modules — skipping", Date.now() - startedAt, "TEST_SKIP");
    }

    try {
      const { stdout, stderr, notFound } = await execWithAbort(
        framework.binary,
        framework.args(targets),
        { cwd: context.workspaceRoot, signal: context.signal },
      );
      if (notFound) {
        return skipResult("unit-test", `Test runner binary ${framework.binary} not found on PATH`, Date.now() - startedAt, "TEST_SKIP");
      }
      const { passed, diagnostics, summary } = framework.parse(stdout, stderr);
      return {
        passed,
        diagnostics,
        durationMs: Date.now() - startedAt,
        summary,
        correctionHint: passed ? undefined : `Fix failing unit tests (${framework.name}) in ${targets.map(t => basename(t)).join(", ")}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        diagnostics: [{
          file: "",
          line: 0,
          column: 0,
          message: `Test runner (${framework.name}) execution failed: ${msg}`,
          severity: "error",
          rule: "test-exec",
          code: "TEST_FAIL",
        }],
        durationMs: Date.now() - startedAt,
        correctionHint: `Check test runner (${framework.name}) configuration`,
      };
    }
  }
}

/** 5. IntegrationTestGate — cross-module tests with per-test timeout. */
export class IntegrationTestGate implements VerificationGate {
  name = "integration-test";
  scope: GateScope = "transitive_dependents";
  defaultTimeoutMs = 300_000;

  /**
   * Resolve a list of import strings into the set of module names they
   * point at. Uses the topology's own `queryModule()` for exact module
   * names, then falls back to a suffix-strip on `.ts`/`.js` so a
   * `../core/utils` import resolves to the `core` module rather than
   * matching a substring anywhere.
   */
  private collectModulesForImports(graph: WorkspaceTopology, imports: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (const imp of imports) {
      // Strip the file extension and any leading path segments.
      const cleaned = imp.replace(/^\.\.?\//, "").replace(/\.(ts|js|tsx|jsx|mjs|cjs|mts|cts)$/, "");
      // Try exact module match first.
      if (graph.moduleGraph.has(cleaned)) {
        out.add(cleaned);
        continue;
      }
      // Walk up the import path until a known module is found.
      const segments = cleaned.split("/");
      for (let i = segments.length; i > 0; i--) {
        const candidate = segments.slice(0, i).join("/");
        if (graph.moduleGraph.has(candidate)) {
          out.add(candidate);
          break;
        }
      }
    }
    return out;
  }

  async run(files: string[], context: GateContext): Promise<GateResult> {
    const startedAt = Date.now();
    const framework = await detectTestFramework(context.workspaceRoot);

    if (!framework) {
      return skipResult("integration-test", "No test framework detected — skipping integration tests", Date.now() - startedAt, "INTEGRATION_SKIP");
    }

    // Spec: "identify cross-module tests via CodebaseGraphIndex (tests that
    // import symbols from multiple modules)".
    const crossModuleTests: string[] = [];
    if (context.codebaseGraph) {
      const affectedModules = context.codebaseGraph.modulesAffectedBy(files);
      for (const [, node] of context.codebaseGraph.fileTree) {
        if (!isTestFile(node.path)) continue;
        const testModules = this.collectModulesForImports(context.codebaseGraph, node.parsedImports);
        // Only count as cross-module if at least two of the test's imports
        // land in modules that overlap with the change-affected set.
        const overlap = [...testModules].filter(m => affectedModules.has(m));
        if (overlap.length >= 2) {
          crossModuleTests.push(node.path);
        }
      }
    }

    if (crossModuleTests.length === 0) {
      return skipResult("integration-test", "No cross-module integration tests found — skipping", Date.now() - startedAt, "INTEGRATION_SKIP");
    }

    // Spec: "configurable timeout (default 5 minutes per test) using
    // AbortSignal.timeout". Compose the per-gate signal with the per-test
    // signal; whichever fires first aborts.
    const perTestMs = context._perTestMs ?? 300_000;
    const perTestSignal = AbortSignal.timeout(perTestMs);

    try {
      const { stdout, stderr, notFound } = await execWithAbort(
        framework.binary,
        framework.args(crossModuleTests),
        { cwd: context.workspaceRoot, signal: perTestSignal },
      );
      if (notFound) {
        return skipResult("integration-test", `Test runner binary ${framework.binary} not found on PATH`, Date.now() - startedAt, "INTEGRATION_SKIP");
      }
      const { passed, diagnostics, summary } = framework.parse(stdout, stderr);
      return {
        passed,
        diagnostics,
        durationMs: Date.now() - startedAt,
        summary,
        correctionHint: passed ? undefined : `Fix failing integration tests (${framework.name})`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Detect the per-test timeout explicitly.
      if (perTestSignal.aborted || /abort/i.test(msg)) {
        return {
          passed: false,
          diagnostics: [{
            file: "",
            line: 0,
            column: 0,
            message: `Integration test exceeded per-test timeout (${perTestMs}ms): ${msg}`,
            severity: "error",
            rule: "integration-timeout",
            code: "INTEGRATION_TIMEOUT",
          }],
          durationMs: Date.now() - startedAt,
          correctionHint: `Split long-running integration tests or raise integrationPerTest timeout`,
        };
      }
      return {
        passed: false,
        diagnostics: [{
          file: "",
          line: 0,
          column: 0,
          message: `Integration test runner (${framework.name}) failed: ${msg}`,
          severity: "error",
          rule: "integration-exec",
          code: "INTEGRATION_FAIL",
        }],
        durationMs: Date.now() - startedAt,
      };
    }
  }
}

/** 6. ArchitectureCheckGate — delegates to CodebaseGraphIndex.checkBoundaries(). */
export class ArchitectureCheckGate implements VerificationGate {
  name = "architecture";
  scope: GateScope = "full_suite";
  defaultTimeoutMs = 30_000;

  /**
   * Find the module that owns a given file in the topology's moduleGraph.
   */
  private findFileModule(graph: WorkspaceTopology, filePath: string): string | null {
    for (const [modName, mod] of graph.moduleGraph) {
      if (mod.files.includes(filePath)) return modName;
    }
    return null;
  }

  /**
   * Resolve which module an import string points to. Tries exact module
   * name first, then walks the import to find any module whose name
   * appears in the import path.
   */
  private findTargetModule(graph: WorkspaceTopology, imp: string): string | null {
    for (const [modName] of graph.moduleGraph) {
      if (imp === modName) return modName;
    }
    for (const [modName, mod] of graph.moduleGraph) {
      if (mod.files.some(f => f.includes(imp) || imp.includes(modName))) {
        return modName;
      }
    }
    return null;
  }

  async run(files: string[], context: GateContext): Promise<GateResult> {
    const startedAt = Date.now();
    const diagnostics: Diagnostic[] = [];

    if (!context.codebaseGraph) {
      return skipResult("architecture", "No codebase graph available — skipping architecture check", Date.now() - startedAt, "ARCH_SKIP");
    }

    // Spec: "query the CodebaseGraphIndex's checkBoundaries() for each file
    // the changes touch; report any violations with the specific files and
    // boundaries crossed."
    const cb = context.codebaseGraph as WorkspaceTopology;

    for (const file of files) {
      if (context.signal?.aborted) break;
      const node = context.codebaseGraph.query(file);
      if (!node) continue;

      // The file's own module is the "source" of every import edge it has.
      const fileModule = this.findFileModule(cb, node.path);
      if (!fileModule) continue;

      for (const imp of node.parsedImports) {
        const targetModule = this.findTargetModule(cb, imp);
        if (!targetModule || targetModule === fileModule) continue;

        const verdict = cb.checkBoundaries(node.path, targetModule);

        if (verdict === "blocked") {
          diagnostics.push({
            file: node.path,
            line: 1,
            column: 1,
            message: `Architecture violation: ${fileModule} may not import from ${targetModule} (rule: must_not_import; import: ${imp})`,
            severity: "error",
            rule: "boundary-blocked",
            code: "ARCH_BOUNDARY",
          });
          continue;
        }

        if (verdict === "no_rule") {
          // No topology-level rule covers the edge; check the *target
          // module's* declared rules (e.g. `only_import`).
          const targetMod = cb.moduleGraph.get(targetModule);
          if (!targetMod) continue;
          for (const rule of targetMod.boundaries) {
            if (rule.type === "only_import" && targetModule !== rule.target) {
              diagnostics.push({
                file: node.path,
                line: 1,
                column: 1,
                message: `Architecture violation: ${targetModule} may only import from ${rule.target} (got: ${imp})`,
                severity: "warning",
                rule: "boundary-only-import",
                code: "ARCH_BOUNDARY",
              });
            }
          }
        }
      }
    }

    const passed = diagnostics.filter(d => d.severity === "error").length === 0;
    return {
      passed,
      diagnostics,
      durationMs: Date.now() - startedAt,
      correctionHint: passed ? undefined : `Fix architecture boundary violations: ${diagnostics.map(d => `${d.file} -> ${d.message}`).join("; ")}`,
    };
  }
}

/** 7. FullTestSuiteGate — Campaign mode only; runs the entire suite. */
export class FullTestSuiteGate implements VerificationGate {
  name = "full-suite";
  scope: GateScope = "full_suite";
  defaultTimeoutMs = 600_000;

  async run(_files: string[], context: GateContext): Promise<GateResult> {
    const startedAt = Date.now();
    const framework = await detectTestFramework(context.workspaceRoot);

    if (!framework) {
      return skipResult("full-suite", "No test framework detected — skipping full suite", Date.now() - startedAt, "FULLSUITE_SKIP");
    }

    try {
      const { stdout, stderr, notFound } = await execWithAbort(
        framework.binary,
        framework.args([]),
        { cwd: context.workspaceRoot, signal: context.signal },
      );
      if (notFound) {
        return skipResult("full-suite", `Test runner binary ${framework.binary} not found on PATH`, Date.now() - startedAt, "FULLSUITE_SKIP");
      }
      const { passed, diagnostics, summary } = framework.parse(stdout, stderr);
      return {
        passed,
        diagnostics,
        durationMs: Date.now() - startedAt,
        summary,
        correctionHint: passed ? undefined : `Fix failing tests in full suite run (${framework.name})`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        diagnostics: [{
          file: "",
          line: 0,
          column: 0,
          message: `Full suite test runner (${framework.name}) failed: ${msg}`,
          severity: "error",
          rule: "fullsuite-exec",
          code: "FULLSUITE_FAIL",
        }],
        durationMs: Date.now() - startedAt,
      };
    }
  }
}

// =========================================================================
// VerificationPipeline
// =========================================================================

export interface TimeoutConfig {
  syntax: number;
  lint: number;
  typecheck: number;
  unitTests: number;
  integrationTests: number;
  /** Per-test timeout used by IntegrationTestGate (default 5 minutes). */
  integrationPerTest: number;
  fullSuite: number;
}

export interface VerificationPipelineConfig {
  workspaceRoot?: string;
  timeouts?: Partial<TimeoutConfig>;
  enableCache?: boolean;
  maxCacheEntries?: number;
}

const DEFAULT_TIMEOUTS: TimeoutConfig = {
  syntax: 30_000,
  lint: 30_000,
  typecheck: 60_000,
  unitTests: 120_000,
  integrationTests: 300_000,
  integrationPerTest: 300_000,
  fullSuite: 600_000,
};

export const ALL_GATES: VerificationGate[] = [
  new SyntaxCheckGate(),
  new LintCheckGate(),
  new TypeCheckGate(),
  new UnitTestGate(),
  new IntegrationTestGate(),
  new ArchitectureCheckGate(),
  new FullTestSuiteGate(),
];

export type ExecutionModeLevel = 0 | 1 | 2 | 3 | 4;

export class VerificationPipeline {
  private config: VerificationPipelineConfig;
  private timeouts: TimeoutConfig;
  /** Per spec: `fileHashes: Map<string, string>` (file path → SHA-256). */
  private fileHashes: Map<string, string> = new Map();
  private reporter: PipelineReporter;

  constructor(config?: VerificationPipelineConfig) {
    this.config = { enableCache: true, maxCacheEntries: 1000, ...config };
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config?.timeouts };
    this.reporter = new PipelineReporter();
  }

  getReporter(): PipelineReporter {
    return this.reporter;
  }

  async runPipeline(
    files: string[],
    mode: ExecutionModeLevel,
    context: GateContext,
  ): Promise<PipelineResult> {
    const startedAt = Date.now();
    const gateResults = new Map<string, GateResult>();
    const allDiagnostics: Diagnostic[] = [];

    const enabledGates = this.resolveEnabledGates(mode);

    const uncachedFiles = this.config.enableCache
      ? files.filter(f => !this.isCached(f, context.workspaceRoot))
      : [...files];

    const cached = this.config.enableCache && files.length > 0 && uncachedFiles.length === 0;

    if (cached) {
      // Honor the abortable contract: a pre-aborted call must NOT report success.
      if (context.signal?.aborted) {
        this.reporter.emitProgress({
          type: "pipeline.failed",
          timestamp: iso(),
          failingGate: undefined,
          diagnosticCount: 0,
          gates: Array.from(enabledGates.keys()).filter(g => enabledGates.get(g)),
        });
        return {
          passed: false,
          gateResults,
          diagnostics: [{
            file: "",
            line: 0,
            column: 0,
            message: "Pipeline aborted before verification started",
            severity: "error",
            rule: "pipeline-abort",
            code: "PIPELINE_ABORTED",
          }],
          durationMs: Date.now() - startedAt,
          cached: true,
        };
      }
      this.reporter.emitProgress({
        type: "pipeline.passed",
        timestamp: iso(),
        diagnosticCount: 0,
        gates: Array.from(enabledGates.keys()).filter(g => enabledGates.get(g)),
      });
      return {
        passed: true,
        gateResults,
        diagnostics: allDiagnostics,
        durationMs: Date.now() - startedAt,
        cached: true,
      };
    }

    const shouldParallel = mode >= 3;
    const gatesToRun = ALL_GATES.filter(g => enabledGates.get(g.name));

    if (shouldParallel) {
      const results = await Promise.allSettled(
        gatesToRun.map(async (gate) => {
          const timeout = this.resolveTimeout(gate.name);
          const signal = this.createTimeoutSignal(timeout, context.signal);
          // For integration tests, also wire the per-test timeout into the
          // context so the gate can compose both signals.
          const ctx: GateContext = gate.name === "integration-test"
            ? { ...context, signal, reporter: this.reporter, _perTestMs: this.timeouts.integrationPerTest }
            : { ...context, signal, reporter: this.reporter };
          return this.runSingleGate(gate, uncachedFiles, ctx);
        }),
      );

      for (let i = 0; i < gatesToRun.length; i++) {
        const gate = gatesToRun[i]!;
        const result = results[i]!;
        if (result.status === "fulfilled") {
          gateResults.set(gate.name, result.value);
          allDiagnostics.push(...result.value.diagnostics);
        } else {
          const failResult: GateResult = {
            passed: false,
            diagnostics: [{
              file: "",
              line: 0,
              column: 0,
              message: `Gate ${gate.name} crashed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
              severity: "error",
              rule: "gate-crash",
              code: "GATE_CRASH",
            }],
            durationMs: 0,
          };
          gateResults.set(gate.name, failResult);
          allDiagnostics.push(...failResult.diagnostics);
        }
      }
    } else {
      for (const gate of gatesToRun) {
        if (context.signal?.aborted) break;

        const timeout = this.resolveTimeout(gate.name);
        const signal = this.createTimeoutSignal(timeout, context.signal);
        const ctx: GateContext = gate.name === "integration-test"
          ? { ...context, signal, reporter: this.reporter, _perTestMs: this.timeouts.integrationPerTest }
          : { ...context, signal, reporter: this.reporter };
        const result = await this.runSingleGate(gate, uncachedFiles, ctx);

        gateResults.set(gate.name, result);
        allDiagnostics.push(...result.diagnostics);

        if (!result.passed && mode < 3) {
          const failingGate = gate.name;
          this.reporter.emitProgress({
            type: "pipeline.failed",
            timestamp: iso(),
            gateName: failingGate,
            failingGate,
            diagnosticCount: allDiagnostics.length,
            gates: gatesToRun.map(g => g.name),
          });
          break;
        }
      }
    }

    if (this.config.enableCache) {
      for (const file of uncachedFiles) {
        try {
          const content = await readFile(resolve(context.workspaceRoot, file), "utf-8");
          this.fileHashes.set(file, sha256(content));
        } catch {
          // file may not exist
        }
      }
      this.trimCache();
    }

    const gatesRan = Array.from(gateResults.keys());
    const passed = gatesRan.every(n => gateResults.get(n)?.passed);
    const eventType: ProgressEventType = passed ? "pipeline.passed" : "pipeline.failed";
    const failingGate = !passed ? gatesRan.find(n => !gateResults.get(n)?.passed) : undefined;
    this.reporter.emitProgress({
      type: eventType,
      timestamp: iso(),
      failingGate,
      diagnosticCount: allDiagnostics.length,
      gates: gatesRan,
    });

    return {
      passed,
      gateResults,
      diagnostics: allDiagnostics,
      durationMs: Date.now() - startedAt,
      cached: false,
    };
  }

  async validateSyntax(files: string[], context: GateContext): Promise<PipelineResult> {
    return this.runPipeline(files, 0, context);
  }

  async validateStandard(files: string[], context: GateContext): Promise<PipelineResult> {
    return this.runPipeline(files, 2, context);
  }

  async validateFull(files: string[], context: GateContext): Promise<PipelineResult> {
    return this.runPipeline(files, 3, context);
  }

  async validateCampaign(files: string[], context: GateContext): Promise<PipelineResult> {
    return this.runPipeline(files, 4, context);
  }

  invalidateCache(): void {
    this.fileHashes.clear();
  }

  /** Internal: per-spec "if a file's hash hasn't changed since last
   *  verification, skip re-verification using fileHashes". */
  isFileCached(file: string, workspaceRoot: string): boolean {
    return this.isCached(file, workspaceRoot);
  }

  private async runSingleGate(
    gate: VerificationGate,
    files: string[],
    context: GateContext,
  ): Promise<GateResult> {
    // Spec: "gate.started { name, files } → TUI shows verifying spinner"
    this.reporter.emitProgress({
      type: "gate.started",
      timestamp: iso(),
      gateName: gate.name,
      files,
    });

    try {
      const result = gate.scope === "full_suite" && files.length === 0
        ? await gate.run([], context)
        : await gate.run(files, context);

      // Spec: "gate.skipped { name, reason } → dimmed indicator"
      if (result.skipped) {
        this.reporter.emitProgress({
          type: "gate.skipped",
          timestamp: iso(),
          gateName: gate.name,
          reason: result.skipReason ?? "skipped",
        });
        return result;
      }

      const eventType: ProgressEventType = result.passed ? "gate.passed" : "gate.failed";
      this.reporter.emitProgress({
        type: eventType,
        timestamp: iso(),
        gateName: gate.name,
        durationMs: result.durationMs,
        diagnosticCount: result.diagnostics.length,
        diagnostics: result.passed ? undefined : result.diagnostics,
      });
      return result;
    } catch (err) {
      const failResult: GateResult = {
        passed: false,
        diagnostics: [{
          file: "",
          line: 0,
          column: 0,
          message: `Gate ${gate.name} threw: ${err instanceof Error ? err.message : String(err)}`,
          severity: "error",
          rule: "gate-exception",
          code: "GATE_EXCEPTION",
        }],
        durationMs: 0,
      };
      this.reporter.emitProgress({
        type: "gate.failed",
        timestamp: iso(),
        gateName: gate.name,
        diagnosticCount: 1,
        diagnostics: failResult.diagnostics,
      });
      return failResult;
    }
  }

  private resolveEnabledGates(mode: ExecutionModeLevel): Map<string, boolean> {
    const map = new Map<string, boolean>();
    for (const gate of ALL_GATES) map.set(gate.name, false);

    map.set("syntax", true);
    if (mode >= 1) map.set("lint", true);
    if (mode >= 2) {
      map.set("typecheck", true);
      map.set("unit-test", true);
    }
    if (mode >= 3) {
      map.set("integration-test", true);
      map.set("architecture", true);
    }
    if (mode >= 4) map.set("full-suite", true);

    return map;
  }

  private isCached(file: string, workspaceRoot: string): boolean {
    const cachedHash = this.fileHashes.get(file);
    if (!cachedHash) return false;
    try {
      const content = readFileSync(resolve(workspaceRoot, file), "utf-8");
      return sha256(content) === cachedHash;
    } catch {
      return false;
    }
  }

  private trimCache(): void {
    const max = this.config.maxCacheEntries ?? 1000;
    if (this.fileHashes.size <= max) return;
    const entries = Array.from(this.fileHashes.entries());
    this.fileHashes = new Map(entries.slice(entries.length - max));
  }

  private resolveTimeout(gateName: string): number {
    switch (gateName) {
      case "syntax": return this.timeouts.syntax;
      case "lint": return this.timeouts.lint;
      case "typecheck": return this.timeouts.typecheck;
      case "unit-test": return this.timeouts.unitTests;
      case "integration-test": return this.timeouts.integrationTests;
      case "full-suite": return this.timeouts.fullSuite;
      default: return 30_000;
    }
  }

  /**
   * Build the per-gate AbortSignal — spec calls for `AbortSignal.timeout()`.
   * We compose it with the parent signal (if any) via `AbortSignal.any()`
   * so the gate is cancelled by EITHER the parent or the timeout, and
   * neither path leaks timers.
   */
  private createTimeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(ms);
    if (!parent) return timeoutSignal;
    if (parent.aborted) return parent;
    return AbortSignal.any([parent, timeoutSignal]);
  }
}

// =========================================================================
// Module-private augmentation: GateContext may carry `_perTestMs` for the
// integration gate. The field is declared directly on GateContext above, so
// no declaration merging is required here.
// =========================================================================
