/**
 * Tests — IntentClassifier heuristic prompt analysis & execution mode selection.
 *
 * Covers all heuristic axes, decision matrix, edge cases, and
 * integration scenarios.
 */
import { describe, it, expect } from "vitest";
import { IntentClassifier, ExecutionModes } from "../intent.js";
import type { SessionContext } from "../intent.js";

// =========================================================================
// Helpers
// =========================================================================

const classifier = new IntentClassifier();
const emptyContext: SessionContext = { activeDecisions: [] };

function classify(prompt: string, ctx?: Partial<SessionContext>): ReturnType<typeof classifier.classify> {
  return classifier.classify(prompt, { ...emptyContext, ...ctx });
}

// =========================================================================
// 1. Prompt length analysis
// =========================================================================

describe("Prompt length analysis", () => {
  it("short prompt under 50 chars → surface depth", () => {
    const r = classify("Fix the typo in index.ts");
    expect(r.profile.depth).toBe("surface");
  });

  it("moderate prompt 50-200 chars → moderate depth", () => {
    const prompt = "Update the login handler to support OAuth2.0 with Google and GitHub providers. Add token refresh logic.";
    expect(prompt.length).toBeGreaterThanOrEqual(50);
    expect(prompt.length).toBeLessThan(200);
    const r = classify(prompt);
    expect(r.profile.depth).toBe("moderate");
  });

  it("long prompt 200-500 chars → deep depth", () => {
    const prompt = "A".repeat(250);
    const r = classify(prompt);
    expect(r.profile.depth).toBe("deep");
  });

  it("very long prompt over 500 chars → campaign depth", () => {
    const prompt = "A".repeat(550);
    const r = classify(prompt);
    expect(r.profile.depth).toBe("campaign");
  });
});

// =========================================================================
// 2. File reference parsing
// =========================================================================

describe("File reference parsing", () => {
  it("detects single file path", () => {
    const r = classify("Fix the bug in src/utils/parser.ts");
    expect(r.profile.estimatedFiles).toBe(1);
    expect(r.profile.scope).toBe("single_file");
  });

  it("detects multiple file paths", () => {
    const r = classify("Update auth.ts, userService.ts, and types.ts");
    expect(r.profile.estimatedFiles).toBeGreaterThanOrEqual(3);
  });

  it("ignores URLs as file references", () => {
    const r = classify("Look at https://example.com and fix the bug");
    expect(r.profile.scope).toBe("module"); // no file refs → default module
  });

  it("infers module scope from directory references", () => {
    const r = classify("Fix the API module and add validation");
    expect(r.profile.scope).toBe("module");
  });
});

// =========================================================================
// 3. Action verb analysis
// =========================================================================

describe("Action verb analysis", () => {
  it("'fix' verb → surface depth", () => {
    const r = classify("Fix the formatting in the output");
    expect(r.profile.depth).toBe("surface");
  });

  it("'refactor' verb → deep depth", () => {
    const r = classify("Refactor the database layer");
    expect(r.profile.depth).toBe("deep");
  });

  it("'build' verb → campaign depth", () => {
    const r = classify("Build a new authentication system");
    expect(r.profile.depth).toBe("campaign");
  });

  it("'update' verb → surface depth", () => {
    const r = classify("Update the config file");
    expect(r.profile.depth).toBe("surface");
  });

  it("'implement' verb → campaign depth", () => {
    const r = classify("Implement WebSocket support for real-time updates");
    expect(r.profile.depth).toBe("campaign");
  });

  it("no action verbs → defaults to moderate", () => {
    const r = classify("What do you think about the current architecture?");
    // No strong action verbs → moderate
    expect(r.profile.depth).toBe("moderate");
  });
});

// =========================================================================
// 4. Scope indicator analysis
// =========================================================================

describe("Scope indicator analysis", () => {
  it("'in this file' → single_file scope", () => {
    const r = classify("Fix the bug in this file");
    expect(r.profile.scope).toBe("single_file");
  });

  it("'fix this' → single_file scope", () => {
    const r = classify("Fix this error in the renderer");
    expect(r.profile.scope).toBe("single_file");
  });

  it("'across the project' → codebase_gen scope", () => {
    const r = classify("Update the logger across the project");
    expect(r.profile.scope).toBe("codebase_gen");
  });

  it("'everywhere' → codebase_gen scope", () => {
    const r = classify("Replace console.log everywhere with the logger");
    expect(r.profile.scope).toBe("codebase_gen");
  });

  it("'module' keyword → module scope", () => {
    const r = classify("Refactor the auth module");
    expect(r.profile.scope).toBe("module");
  });

  it("'component' keyword → module scope", () => {
    const r = classify("Redesign the button component");
    expect(r.profile.scope).toBe("module");
  });

  it("'cross-cutting' → cross_cutting scope", () => {
    const r = classify("Implement cross-cutting logging for all services");
    expect(r.profile.scope).toBe("cross_cutting");
  });

  it("no scope hints + no file refs → module (default)", () => {
    const r = classify("Make the app better");
    expect(r.profile.scope).toBe("module");
  });
});

// =========================================================================
// 5. Historical context
// =========================================================================

describe("Historical context", () => {
  it("3+ active decisions raises depth", () => {
    const ctx: SessionContext = {
      activeDecisions: [
        { id: "1", description: "Changed auth", timestamp: "t1" },
        { id: "2", description: "Added DB layer", timestamp: "t2" },
        { id: "3", description: "Refactored API", timestamp: "t3" },
      ],
    };
    const r = classify("Fix the formatting", ctx);
    // Short "Fix" prompt is surface by length, but history pushes it up
    expect(r.profile.depth).not.toBe("surface");
  });

  it("no active decisions does not affect depth", () => {
    const r = classify("Fix the formatting", emptyContext);
    expect(r.profile.depth).toBe("surface");
  });
});

// =========================================================================
// 6. Structural patterns (parallelism)
// =========================================================================

describe("Parallel structure detection", () => {
  it("bullet points → requiresParallel", () => {
    const r = classify("Do these:\n- Fix auth\n- Add logging\n- Update tests");
    expect(r.profile.requiresParallel).toBe(true);
  });

  it("numbered items → requiresParallel", () => {
    const r = classify("Here's what I need:\n1. Add the API\n2. Update the frontend\n3. Write tests");
    expect(r.profile.requiresParallel).toBe(true);
  });

  it("'in parallel' phrase → requiresParallel", () => {
    const r = classify("Run both tasks in parallel");
    expect(r.profile.requiresParallel).toBe(true);
  });

  it("single bullet point → not parallel", () => {
    const r = classify("- Fix the auth bug");
    expect(r.profile.requiresParallel).toBe(false);
  });

  it("no structured items → not parallel", () => {
    const r = classify("Fix the auth bug");
    expect(r.profile.requiresParallel).toBe(false);
  });
});

// =========================================================================
// 7. Verification detection
// =========================================================================

describe("Verification detection", () => {
  it("'test' mentioned → requiresVerification", () => {
    const r = classify("Fix the bug and write tests");
    expect(r.profile.requiresVerification).toBe(true);
  });

  it("'lint' mentioned → requiresVerification", () => {
    const r = classify("Fix the lint error");
    expect(r.profile.requiresVerification).toBe(true);
  });

  it("'ensure' pattern → requiresVerification", () => {
    const r = classify("Ensure all edge cases are covered");
    expect(r.profile.requiresVerification).toBe(true);
  });

  it("no verification mentions → false", () => {
    const r = classify("Fix the typo");
    expect(r.profile.requiresVerification).toBe(false);
  });
});

// =========================================================================
// 8. Research detection
// =========================================================================

describe("Research detection", () => {
  it("'search' keyword → requiresResearch", () => {
    const r = classify("Search for the latest API changes");
    expect(r.profile.requiresResearch).toBe(true);
  });

  it("'how to' phrase → requiresResearch", () => {
    const r = classify("Find out how to implement SSR");
    expect(r.profile.requiresResearch).toBe(true);
  });

  it("'npm package' reference → requiresResearch", () => {
    const r = classify("Use an npm package for CSV parsing");
    expect(r.profile.requiresResearch).toBe(true);
  });

  it("no research indicators → false", () => {
    const r = classify("Fix the typo");
    expect(r.profile.requiresResearch).toBe(false);
  });
});

// =========================================================================
// 9. Architectural impact
// =========================================================================

describe("Architectural impact detection", () => {
  it("cross_cutting scope → always architectural", () => {
    const r = classify("Cross-cutting logging change");
    expect(r.profile.hasArchitecturalImpact).toBe(true);
  });

  it("codebase_gen scope → always architectural", () => {
    const r = classify("Generate the entire project");
    expect(r.profile.hasArchitecturalImpact).toBe(true);
  });

  it("'refactor' keyword → architectural", () => {
    const r = classify("Refactor the module");
    expect(r.profile.hasArchitecturalImpact).toBe(true);
  });

  it("'interface' keyword → architectural", () => {
    const r = classify("Update the service interface");
    expect(r.profile.hasArchitecturalImpact).toBe(true);
  });

  it("simple single-file fix → not architectural", () => {
    const r = classify("Fix the typo in index.ts");
    expect(r.profile.hasArchitecturalImpact).toBe(false);
  });
});

// =========================================================================
// 10. Decision matrix — ExecutionMode mapping
// =========================================================================

describe("Decision matrix", () => {
  it("all classifications return AUTO mode (default natural behavior)", () => {
    const r = classify("Fix the typo in index.ts");
    expect(r.mode).toBe(ExecutionModes.AUTO);
  });

  it("multi-file prompts also return AUTO mode", () => {
    const r = classify("Update auth.ts, userService.ts, and types.ts");
    expect(r.mode).toBe(ExecutionModes.AUTO);
  });

  it("all classifications return AUTO mode (default natural behavior)", () => {
    const r = classify("Fix a bug in index.ts");
    expect(r.mode).toBe(ExecutionModes.AUTO);
  });

  it("module + deep returns AUTO mode", () => {
    const r = classify("This is a moderately long prompt that should trigger deep analysis. Refactor the entire auth module. We need to completely redesign the authentication flow to support modern security patterns.");
    expect(r.profile.scope).toBe("module");
    expect(r.mode).toBe(ExecutionModes.AUTO);
  });

  it("cross_cutting + deep returns AUTO mode", () => {
    const r = classify("Cross-cutting change to all services. This is a long detailed description of a cross-cutting concern that affects many different parts of the system. We need to carefully redesign the logging infrastructure, update all service boundaries, and ensure consistent error handling across the board. This will touch multiple modules and require careful orchestration.");
    expect(r.mode).toBe(ExecutionModes.AUTO);
  });

  it("codebase_gen scope returns AUTO mode", () => {
    const r = classify("Build a new microservice across the project");
    expect(r.mode).toBe(ExecutionModes.AUTO);
  });

  it("campaign depth returns AUTO mode", () => {
    const r = classify("Generate a comprehensive auth system with OAuth");
    expect(r.profile.depth).toBe("campaign");
    expect(r.mode).toBe(ExecutionModes.AUTO);
  });

  it("module + surface + parallel returns AUTO mode", () => {
    const r = classify("Update the API:\n- Add new endpoint\n- Update docs\n- Write tests");
    expect(r.profile.scope).toBe("module");
    expect(r.profile.requiresParallel).toBe(true);
    expect(r.mode).toBe(ExecutionModes.AUTO);
  });

  it("cross_cutting + moderate returns AUTO mode", () => {
    const r = classify("Cross-cutting update to error handling patterns");
    expect(r.profile.depth).toBe("moderate");
    expect(r.mode).toBe(ExecutionModes.AUTO);
  });
});

// =========================================================================
// 11. Confidence scoring
// =========================================================================

describe("Confidence scoring", () => {
  it("short ambiguous prompt has lower confidence", () => {
    const r = classify("Hi");
    expect(r.profile.confidence).toBeLessThan(0.5);
  });

  it("detailed prompt with multiple signals has high confidence", () => {
    const r = classify("Fix the typo in src/utils/parser.ts and verify with tests");
    expect(r.profile.confidence).toBeGreaterThan(0.6);
  });

  it("confidence is clamped between 0 and 1", () => {
    const r = classify("A".repeat(600) + " Fix this. " + "B".repeat(600) + " And also do all of this stuff " + "C".repeat(600));
    expect(r.profile.confidence).toBeGreaterThanOrEqual(0);
    expect(r.profile.confidence).toBeLessThanOrEqual(1);
  });
});

// =========================================================================
// 12. Reason string
// =========================================================================

describe("Reason string", () => {
  it("includes the mode name and profile in the reason", () => {
    const r = classify("Fix the typo in index.ts");
    expect(r.reason).toContain("Auto");
    expect(r.reason).toContain("profile");
  });

  it("includes confidence percentage", () => {
    const r = classify("Fix the typo in index.ts");
    expect(r.reason).toContain("%");
  });

  it("is non-empty for all classifications", () => {
    const prompts = [
      "Fix this",
      "Big refactor of the auth module across the entire project",
      "Build a new system",
      "Hey",
    ];
    for (const p of prompts) {
      const r = classify(p);
      expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});

// =========================================================================
// 13. Estimated turns
// =========================================================================

describe("Estimated turns", () => {
  it("single_file + surface → 1 turn", () => {
    const r = classify("Fix the typo in index.ts");
    expect(r.profile.estimatedTurns).toBe(1);
  });

  it("codebase_gen + campaign → 40 turns", () => {
    const r = classify("Build an entire microservice platform across the whole project with comprehensive features");
    expect(r.profile.scope).toBe("codebase_gen");
    expect(r.profile.estimatedTurns).toBe(40);
  });
});

// =========================================================================
// 14. Edge cases
// =========================================================================

describe("Edge cases", () => {
  it("empty prompt defaults to moderate depth and module scope", () => {
    const r = classify("");
    expect(r.profile.depth).toBe("moderate");
    expect(r.profile.scope).toBe("module");
    expect(r.profile.confidence).toBeGreaterThanOrEqual(0);
  });

  it("whitespace-only prompt", () => {
    const r = classify("   \n  \t  ");
    expect(r.profile.scope).toBe("module");
  });

  it("prompt with only URLs", () => {
    const r = classify("Check https://example.com/docs and https://api.example.com/ref");
    expect(r.profile.scope).toBe("module"); // no valid file refs
  });

  it("prompt with both test and search", () => {
    const r = classify("Search for best practices and write tests");
    expect(r.profile.requiresResearch).toBe(true);
    expect(r.profile.requiresVerification).toBe(true);
  });

  it("multi-line prompt with mixed content", () => {
    const prompt = [
      "I need you to update the payment processing module.",
      "",
      "1. Refactor the Stripe integration in src/payments/stripe.ts",
      "2. Add tests for the refund flow",
      "3. Update the API docs",
      "",
      "Make sure all edge cases are covered.",
    ].join("\n");
    const r = classify(prompt);
    expect(r.profile.requiresParallel).toBe(true);
    expect(r.profile.requiresVerification).toBe(true);
    expect(r.profile.scope).toBe("module");
  });

  it("session context with decisions pushes depth up", () => {
    const ctx: SessionContext = {
      activeDecisions: [
        { id: "a", description: "Initial setup", timestamp: "t1" },
        { id: "b", description: "Added auth", timestamp: "t2" },
      ],
      recentPrompts: ["Fix something", "Add another thing"],
    };
    const r = classify("Fix the formatting", ctx);
    // Short prompt + fix verb → surface, but history may nudge
    // With 2 decisions, historyFactor = 2/3 ≈ 0.66 which is > 0.5, so it pushes
    expect(r.profile.depth).not.toBe("campaign"); // at most 1 level up
  });
});

// =========================================================================
// 15. Integration — end-to-end classification
// =========================================================================

describe("End-to-end classification", () => {
  it("classify returns a complete ClassificationResult with all fields", () => {
    const r = classify("Fix the typo in src/utils/parser.ts");
    expect(r).toHaveProperty("profile");
    expect(r).toHaveProperty("mode");
    expect(r).toHaveProperty("reason");
    expect(r.profile).toHaveProperty("scope");
    expect(r.profile).toHaveProperty("depth");
    expect(r.profile).toHaveProperty("confidence");
    expect(r.profile).toHaveProperty("estimatedFiles");
    expect(r.profile).toHaveProperty("estimatedTurns");
    expect(r.profile).toHaveProperty("requiresParallel");
    expect(r.profile).toHaveProperty("requiresResearch");
    expect(r.profile).toHaveProperty("requiresVerification");
    expect(r.profile).toHaveProperty("hasArchitecturalImpact");
  });

  it("produces deterministic results", () => {
    const prompt = "Fix the bug in src/parser.ts";
    const r1 = classify(prompt);
    const r2 = classify(prompt);
    expect(r1).toEqual(r2);
  });

  it("classify with empty context doesn't throw", () => {
    expect(() => classifier.classify("hello", { activeDecisions: [] })).not.toThrow();
    expect(() => classifier.classify("hello", { activeDecisions: [], workspaceRoot: undefined })).not.toThrow();
  });
});