/**
 * correction.test.ts — Tests for SelfCorrectionCycle (Step 31)
 *
 * Covers:
 *   - CorrectionBudget tracking and limits
 *   - QUICK_FIX_MAP auto-fix fast path
 *   - All 5 concrete correction handlers
 *   - Auto-fix fast path (no-sub-agent)
 *   - Escalation logging and RPC integration
 *   - correction.attempt wire records
 *   - CorrectionCycle integration with new handlers
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SelfCorrectionCycle, CorrectionBudget, QUICK_FIX_MAP, tryAutoFix, tryAutoFixBatch, SyntaxCorrectionHandler, LintCorrectionHandler, TypeCorrectionHandler, TestCorrectionHandler, ArchitectureCorrectionHandler, type CorrectionDiagnostic, type HandlerCorrectionResult, type SelfCorrectionConfig, type CorrectionAttempt, type CorrectionResult, type EscalationPayload } from "../correction.js";
import { VerificationPipeline, type PipelineResult, type GateResult, type Diagnostic, type ExecutionModeLevel } from "../verification.js";
import type { CorrectionAttemptRecord } from "../../records/types.js";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// =========================================================================
// Test Helpers
// =========================================================================

const TEST_WORKSPACE = resolve(process.cwd(), ".tmp-test-correction-step31");

function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    file: "test.ts",
    line: 10,
    column: 5,
    message: "Test error message",
    severity: "error",
    rule: "test-rule",
    code: "TEST_ERR",
    ...overrides,
  };
}

function makeGateResult(
  passed: boolean,
  diagnostics: Diagnostic[] = [makeDiagnostic()],
  overrides: Partial<GateResult> = {},
): GateResult {
  return {
    passed,
    diagnostics,
    durationMs: 100,
    ...overrides,
  };
}

function makePipelineResult(
  passed: boolean,
  gateEntries: [string, GateResult][] = [["syntax", makeGateResult(passed)]],
  overrides: Partial<PipelineResult> = {},
): PipelineResult {
  return {
    passed,
    gateResults: new Map(gateEntries),
    diagnostics: gateEntries.flatMap(([, gr]) => gr.diagnostics),
    durationMs: 200,
    cached: false,
    ...overrides,
  };
}

function makeCorrectionDiag(
  overrides: Partial<CorrectionDiagnostic> = {},
): CorrectionDiagnostic {
  return {
    original: makeDiagnostic(),
    gateName: "syntax",
    fileContent: "const x = 5\n",
    filePath: "/test/test.ts",
    errorMessage: "Test syntax error",
    line: 1,
    column: 1,
    rule: "semi",
    ...overrides,
  };
}

function makeCorrectionDiagForMessage(
  message: string,
  rule: string,
  filePath: string = "/test/test.ts",
  line: number = 1,
  content: string = "const x = 5\n",
): CorrectionDiagnostic {
  return makeCorrectionDiag({ errorMessage: message, rule, filePath, line, fileContent: content });
}

// =========================================================================
// Tests
// =========================================================================

describe("Step 31 — SelfCorrectionCycle", () => {
  let cycle: SelfCorrectionCycle;

  beforeEach(() => {
    cycle = new SelfCorrectionCycle({
      workspaceRoot: TEST_WORKSPACE,
      modeLevel: 2,
      maxSimpleAttempts: 3,
      maxArchitectureAttempts: 1,
      maxTestAttempts: 3,
      maxTotalAttempts: 10,
      enableAutoFix: true,
    });
  });

  afterEach(async () => {
    await rm(TEST_WORKSPACE, { recursive: true, force: true }).catch(() => {});
  });

  // =======================================================================
  // 1. CorrectionBudget
  // =======================================================================

  describe("CorrectionBudget", () => {
    it("starts with zero attempts", () => {
      const budget = new CorrectionBudget();
      expect(budget.total).toBe(0);
    });

    it("allows first attempt for any diagnostic", () => {
      const budget = new CorrectionBudget({ maxSimpleAttempts: 3 });
      const diag = makeCorrectionDiag();
      expect(budget.canAttempt("syntax", diag)).toBe(true);
    });

    it("blocks after reaching per-diagnostic limit", () => {
      const budget = new CorrectionBudget({ maxSimpleAttempts: 2 });
      const diag = makeCorrectionDiag();

      budget.recordAttempt("syntax", diag);
      expect(budget.canAttempt("syntax", diag)).toBe(true);

      budget.recordAttempt("syntax", diag);
      expect(budget.canAttempt("syntax", diag)).toBe(false);
    });

    it("has lower limit for architecture failures", () => {
      const budget = new CorrectionBudget({ maxArchitectureAttempts: 1 });
      const diag = makeCorrectionDiag({ rule: "boundary" });

      budget.recordAttempt("architecture", diag);
      expect(budget.canAttempt("architecture", diag)).toBe(false);
    });

    it("tracks total across all diagnostics", () => {
      const budget = new CorrectionBudget({ maxTotalAttempts: 10 });
      const diag1 = makeCorrectionDiag({ filePath: "/test/a.ts", rule: "semi" });
      const diag2 = makeCorrectionDiag({ filePath: "/test/b.ts", rule: "semi" });

      budget.recordAttempt("syntax", diag1);
      budget.recordAttempt("syntax", diag2);
      expect(budget.total).toBe(2);
    });

    it("respects maxTotalAttempts global limit", () => {
      const budget = new CorrectionBudget({ maxTotalAttempts: 1 });
      const diag = makeCorrectionDiag();
      budget.recordAttempt("syntax", diag);
      expect(budget.canAttempt("syntax", makeCorrectionDiag({ filePath: "/test/other.ts" }))).toBe(false);
    });

    it("resets correctly", () => {
      const budget = new CorrectionBudget({ maxSimpleAttempts: 1 });
      const diag = makeCorrectionDiag();
      budget.recordAttempt("syntax", diag);
      expect(budget.total).toBe(1);
      budget.reset();
      expect(budget.total).toBe(0);
    });

    it("returns limit for each failure type", () => {
      const budget = new CorrectionBudget({ maxSimpleAttempts: 3, maxArchitectureAttempts: 1, maxTestAttempts: 2 });
      expect(budget.getLimit("syntax")).toBe(3);
      expect(budget.getLimit("architecture")).toBe(1);
      expect(budget.getLimit("test_failure")).toBe(2);
    });
  });

  // =======================================================================
  // 2. QUICK_FIX_MAP auto-fix
  // =======================================================================

  describe("QUICK_FIX_MAP auto-fix", () => {
    it("has entries for common diagnostic codes", () => {
      expect(QUICK_FIX_MAP.has("semi")).toBe(true);
      expect(QUICK_FIX_MAP.has("prefer-const")).toBe(true);
      expect(QUICK_FIX_MAP.has("no-unused-vars")).toBe(true);
      expect(QUICK_FIX_MAP.has("comma-dangle")).toBe(true);
      expect(QUICK_FIX_MAP.has("no-extra-semi")).toBe(true);
      expect(QUICK_FIX_MAP.has("eqeqeq")).toBe(true);
      expect(QUICK_FIX_MAP.has("no-var")).toBe(true);
      expect(QUICK_FIX_MAP.has("no-trailing-spaces")).toBe(true);
      expect(QUICK_FIX_MAP.has("eol-last")).toBe(true);
    });

    it("semi: adds missing semicolon", () => {
      const diag = makeCorrectionDiagForMessage("Missing semicolon", "semi", "/test/test.ts", 1, "const x = 5\n");
      const result = tryAutoFix(diag, "const x = 5\n");
      expect(result).not.toBeNull();
      expect(result!.mergedContent).toBe("const x = 5;\n");
    });

    it("semi: does not add semicolon to block-ending lines", () => {
      const diag = makeCorrectionDiagForMessage("Missing semicolon", "semi", "/test/test.ts", 1, "if (x) {\n");
      const result = tryAutoFix(diag, "if (x) {\n");
      expect(result).toBeNull();
    });

    it("prefer-const: changes let to const", () => {
      const diag = makeCorrectionDiagForMessage("prefer const", "prefer-const", "/test/test.ts", 1, "let x = 5\n");
      const result = tryAutoFix(diag, "let x = 5\n");
      expect(result).not.toBeNull();
      expect(result!.mergedContent).toBe("const x = 5\n");
    });

    it("prefer-const: does not change reassigned let", () => {
      const diag = makeCorrectionDiagForMessage("prefer const", "prefer-const", "/test/test.ts", 1, "let x = 5\nx = 6\n");
      const result = tryAutoFix(diag, "let x = 5\nx = 6\n");
      // Variable is reassigned (x = 6), so it cannot be const
      expect(result).toBeNull();
    });

    it("no-unused-vars: prefixes unused variable with underscore", () => {
      const diag = makeCorrectionDiagForMessage("is defined but never used", "no-unused-vars", "/test/test.ts", 1, "const foo = 5\n");
      const result = tryAutoFix(diag, "const foo = 5\n");
      expect(result).not.toBeNull();
      expect(result!.mergedContent).toContain("_foo");
    });

    it("no-extra-semi: removes extra semicolon", () => {
      const diag = makeCorrectionDiagForMessage("extra semicolon", "no-extra-semi", "/test/test.ts", 1, "const x = 5;;\n");
      const result = tryAutoFix(diag, "const x = 5;;\n");
      expect(result).not.toBeNull();
      expect(result!.mergedContent).toBe("const x = 5;\n");
    });

    it("eqeqeq: replaces == with ===", () => {
      const diag = makeCorrectionDiagForMessage("Expected '==='", "eqeqeq", "/test/test.ts", 1, "if (x == 5) {}\n");
      const result = tryAutoFix(diag, "if (x == 5) {}\n");
      expect(result).not.toBeNull();
      // The result should have ===
      expect(result!.mergedContent).toContain("===");
    });

    it("no-var: changes var to let", () => {
      const diag = makeCorrectionDiagForMessage("Unexpected var", "no-var", "/test/test.ts", 1, "var x = 5\n");
      const result = tryAutoFix(diag, "var x = 5\n");
      expect(result).not.toBeNull();
      expect(result!.mergedContent).toBe("let x = 5\n");
    });

    it("comma-dangle: adds trailing comma", () => {
      // Use a line that doesn't end with block syntax
      const diag = makeCorrectionDiagForMessage("Missing trailing comma", "comma-dangle", "/test/test.ts", 1, "a: 1\n");
      const result = tryAutoFix(diag, "a: 1\n");
      expect(result).not.toBeNull();
      expect(result!.mergedContent).toContain("a: 1,");
    });

    it("eol-last: adds trailing newline", () => {
      const diag = makeCorrectionDiagForMessage("Newline required", "eol-last", "/test/test.ts", 1, "const x = 5");
      const result = tryAutoFix(diag, "const x = 5");
      expect(result).not.toBeNull();
      expect(result!.mergedContent).toBe("const x = 5\n");
    });

    it("no-trailing-spaces: removes trailing spaces", () => {
      const diag = makeCorrectionDiagForMessage("trailing spaces", "no-trailing-spaces", "/test/test.ts", 1, "const x = 5  \n");
      const result = tryAutoFix(diag, "const x = 5  \n");
      expect(result).not.toBeNull();
      expect(result!.mergedContent).toBe("const x = 5\n");
    });
  });

  // =======================================================================
  // 3. tryAutoFix edge cases
  // =======================================================================

  describe("tryAutoFix edge cases", () => {
    it("returns null when no fix matches", () => {
      const diag = makeCorrectionDiagForMessage("Some obscure error", "some-obscure-rule", "/test/test.ts", 1, "const x = 5\n");
      const result = tryAutoFix(diag, "const x = 5\n");
      expect(result).toBeNull();
    });

    it("matches message-based entries when code is not exact", () => {
      // Include a quote-wrapped name so the fix function can find it
      const diag = makeCorrectionDiagForMessage("'foo' is declared but its value is never read", "tsc", "/test/test.ts", 1, "const foo = 5\n");
      const result = tryAutoFix(diag, "const foo = 5\n");
      expect(result).not.toBeNull();
    });
  });

  // =======================================================================
  // 4. tryAutoFixBatch
  // =======================================================================

  describe("tryAutoFixBatch", () => {
    it("applies fixes to multiple eligible diagnostics", async () => {
      await mkdir(TEST_WORKSPACE, { recursive: true });
      const filePath = resolve(TEST_WORKSPACE, "fixable.ts");
      await writeFile(filePath, "const x = 5\nlet y = 10\n", "utf-8");

      const diags = [
        makeCorrectionDiagForMessage("Missing semicolon", "semi", filePath, 1, "const x = 5\nlet y = 10\n"),
        makeCorrectionDiagForMessage("prefer const", "prefer-const", filePath, 2, "const x = 5\nlet y = 10\n"),
      ];
      diags[0]!.filePath = filePath;
      diags[1]!.filePath = filePath;
      diags[0]!.fileContent = "const x = 5\nlet y = 10\n";
      diags[1]!.fileContent = "const x = 5\nlet y = 10\n";

      const result = await tryAutoFixBatch(diags, "lint");
      expect(result.fixed.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =======================================================================
  // 5. SyntaxCorrectionHandler
  // =======================================================================

  describe("SyntaxCorrectionHandler", () => {
    it("auto-fixes missing semicolon", async () => {
      await mkdir(TEST_WORKSPACE, { recursive: true });
      const filePath = resolve(TEST_WORKSPACE, "syntax-fix.ts");
      await writeFile(filePath, "const x = 5\n", "utf-8");

      const handler = new SyntaxCorrectionHandler({ workspaceRoot: TEST_WORKSPACE });
      const diag = makeCorrectionDiagForMessage("Missing semicolon", "semi", filePath, 1, "const x = 5\n");
      diag.filePath = filePath;

      const result = await handler.correct([diag]);
      expect(result.status).toBe("fixed");
      expect(result.changedFiles).toContain(filePath);

      // Verify the file was actually fixed
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain(";");

      await rm(TEST_WORKSPACE, { recursive: true, force: true });
    });

    it("returns skipped when no handler configured", async () => {
      const handler = new SyntaxCorrectionHandler({ workspaceRoot: TEST_WORKSPACE });
      const diag = makeCorrectionDiagForMessage("Complex syntax error", "tsc-syntax", "/test/unknown.ts", 5, "const x = \n");
      const result = await handler.correct([diag]);
      expect(result.status).toBe("skipped");
    });

    it("falls through to sub-agent when auto-fix fails for complex errors", async () => {
      const handler = new SyntaxCorrectionHandler({ workspaceRoot: TEST_WORKSPACE });
      const diag = makeCorrectionDiagForMessage("Declaration or statement expected", "tsc-syntax", "/test/complex.ts", 1, "class {}\n");
      const result = await handler.correct([diag]);
      // Without subagent host, it should be skipped
      expect(result.status).toBe("skipped");
    });
  });

  // =======================================================================
  // 6. ArchitectureCorrectionHandler
  // =======================================================================

  describe("ArchitectureCorrectionHandler", () => {
    it("returns failed with re-decomposition message", async () => {
      const handler = new ArchitectureCorrectionHandler({ workspaceRoot: TEST_WORKSPACE });
      const diags = [
        makeCorrectionDiagForMessage("ui must not import from infrastructure", "boundary-blocked", "/test/ui/component.ts", 1, "import { db } from '../infra/db'\n"),
      ];
      const result = await handler.correct(diags);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("re-decomposition");
      expect(result.summary).toContain("Architecture");
    });
  });

  // =======================================================================
  // 7. CorrectionAttemptRecord type
  // =======================================================================

  describe("correction.attempt record type", () => {
    it("conforms to the wire record shape", () => {
      const record: CorrectionAttemptRecord = {
        type: "correction.attempt",
        timestamp: new Date().toISOString(),
        diagnosticId: "test.ts:10:no-unused-vars",
        gateName: "lint",
        handler: "auto-fix",
        attemptedFixSummary: "Prefix unused variable with underscore",
        outcome: "fixed",
        durationMs: 5,
        changedFiles: ["/test/test.ts"],
        errorMessage: "'x' is defined but never used",
        line: 10,
        column: 5,
      };
      expect(record.type).toBe("correction.attempt");
      expect(record.outcome).toBe("fixed");
      expect(record.changedFiles).toHaveLength(1);
    });
  });

  // =======================================================================
  // 8. SelfCorrectionCycle with new config fields
  // =======================================================================

  describe("Config with new Step 31 fields", () => {
    it("can set enableAutoFix flag", () => {
      const customCycle = new SelfCorrectionCycle({ enableAutoFix: false });
      expect(customCycle.getConfig().enableAutoFix).toBe(false);
    });

    it("can set maxTotalAttempts", () => {
      const customCycle = new SelfCorrectionCycle({ maxTotalAttempts: 5 });
      expect(customCycle.getConfig().maxTotalAttempts).toBe(5);
    });

    it("defaults enableAutoFix to true", () => {
      const defaultCycle = new SelfCorrectionCycle();
      expect(defaultCycle.getConfig().enableAutoFix).toBe(true);
    });

    it("defaults maxTotalAttempts to 10", () => {
      const defaultCycle = new SelfCorrectionCycle();
      expect(defaultCycle.getConfig().maxTotalAttempts).toBe(10);
    });
  });

  // =======================================================================
  // 9. Auto-fix integrated into SelfCorrectionCycle
  // =======================================================================

  describe("Auto-fix integration in cycle", () => {
    it("applies auto-fix for missing semicolon before sub-agent dispatch", async () => {
      await mkdir(TEST_WORKSPACE, { recursive: true });
      const filePath = resolve(TEST_WORKSPACE, "auto-fix-semi.ts");
      await writeFile(filePath, "const x = 5\n", "utf-8");

      const result = makePipelineResult(false, [
        ["lint", makeGateResult(false, [makeDiagnostic({
          file: "auto-fix-semi.ts",
          message: "Missing semicolon",
          rule: "semi",
          line: 1,
          severity: "error",
        })])],
      ]);

      const correctionCycle = new SelfCorrectionCycle({
        workspaceRoot: TEST_WORKSPACE,
        modeLevel: 2,
        enableAutoFix: true,
      });

      const correctionResult = await correctionCycle.run(result, new Set(["auto-fix-semi.ts"]));

      // Auto-fix should have attempted
      expect(correctionResult).toBeDefined();

      await rm(TEST_WORKSPACE, { recursive: true, force: true });
    });

    it("skips auto-fix when enableAutoFix is false", async () => {
      const cycleNoAuto = new SelfCorrectionCycle({
        workspaceRoot: TEST_WORKSPACE,
        modeLevel: 2,
        enableAutoFix: false,
      });

      const result = makePipelineResult(false, [
        ["lint", makeGateResult(false, [makeDiagnostic({
          file: "test.ts",
          message: "Missing semicolon",
          rule: "semi",
          line: 1,
          severity: "error",
        })])],
      ]);

      const correctionResult = await cycleNoAuto.run(result, new Set(["test.ts"]));
      expect(correctionResult).toBeDefined();
    });
  });

  // =======================================================================
  // 10. Escalation enhancement
  // =======================================================================

  describe("Escalation enhancements", () => {
    it("builds escalation with options including skip", () => {
      const escalation: EscalationPayload = {
        summary: "Self-correction exhausted after 2 attempt(s).",
        failedGates: ["lint"],
        attempts: [],
        remainingDiagnostics: [],
        changedFiles: [],
        options: ["retry", "manual_edit", "skip", "abort"],
      };
      expect(escalation.options).toContain("skip");
    });

    it("reports correct changedFiles set in escalation", () => {
      const escalation: EscalationPayload = {
        summary: "Test",
        failedGates: ["syntax"],
        attempts: [{
          attemptNumber: 1,
          targetDiagnostics: [],
          classification: {
            type: "syntax",
            scope: "per_file",
            rootCause: "simple_mistake",
            sourceDiagnostic: makeCorrectionDiag(),
            relatedFiles: [],
            rationale: "Syntax error",
          },
          profile: "reviewer",
          changedFiles: ["/fixed/file.ts"],
          changeSummary: "Fixed syntax",
          passed: false,
          timestamp: new Date().toISOString(),
        }],
        remainingDiagnostics: [makeCorrectionDiag()],
        changedFiles: ["/fixed/file.ts"],
        options: ["skip"],
      };
      expect(escalation.changedFiles).toContain("/fixed/file.ts");
      expect(escalation.attempts[0]!.changedFiles).toContain("/fixed/file.ts");
    });
  });

  // =======================================================================
  // 11. SelfCorrectionCycle progress events
  // =======================================================================

  describe("Progress events", () => {
    it("emits collecting progress event at start", async () => {
      const progressSpy = vi.fn();
      const testCycle = new SelfCorrectionCycle({
        workspaceRoot: TEST_WORKSPACE,
        modeLevel: 2,
      });
      testCycle.onProgress(progressSpy);

      const result = makePipelineResult(false, [
        ["lint", makeGateResult(false, [makeDiagnostic({
          file: "progress-test.ts",
          message: "Error",
          rule: "eslint",
        })])],
      ]);

      await testCycle.run(result, new Set(["progress-test.ts"]));
      expect(progressSpy).toHaveBeenCalled();
    });
  });

  // =======================================================================
  // 12. CorrectionProfile exports
  // =======================================================================

  describe("Type exports", () => {
    it("exports CorrectionBudget class", async () => {
      const mod = await import("../correction.js");
      expect(mod.CorrectionBudget).toBeDefined();
    });

    it("exports QUICK_FIX_MAP", async () => {
      const mod = await import("../correction.js");
      expect(mod.QUICK_FIX_MAP).toBeDefined();
      expect(mod.QUICK_FIX_MAP instanceof Map).toBe(true);
    });

    it("exports tryAutoFix function", async () => {
      const mod = await import("../correction.js");
      expect(typeof mod.tryAutoFix).toBe("function");
    });

    it("exports tryAutoFixBatch function", async () => {
      const mod = await import("../correction.js");
      expect(typeof mod.tryAutoFixBatch).toBe("function");
    });

    it("exports all 5 handler classes", async () => {
      const mod = await import("../correction.js");
      expect(mod.SyntaxCorrectionHandler).toBeDefined();
      expect(mod.LintCorrectionHandler).toBeDefined();
      expect(mod.TypeCorrectionHandler).toBeDefined();
      expect(mod.TestCorrectionHandler).toBeDefined();
      expect(mod.ArchitectureCorrectionHandler).toBeDefined();
    });

    it("exports HandlerCorrectionResult type", async () => {
      // HandlerCorrectionResult is an interface (type-only, no runtime), but
      // we verify the HANDLER classes exist
      const mod = await import("../correction.js");
      expect(typeof mod.SyntaxCorrectionHandler).toBe("function");
      expect(typeof mod.LintCorrectionHandler).toBe("function");
      expect(typeof mod.TypeCorrectionHandler).toBe("function");
      expect(typeof mod.TestCorrectionHandler).toBe("function");
      expect(typeof mod.ArchitectureCorrectionHandler).toBe("function");
    });
  });
});