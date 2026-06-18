/**
 * IntentClassifier — Heuristic prompt analysis & execution mode selection.
 *
 * Analyzes incoming user prompts across multiple heuristic axes to produce
 * an IntentProfile, then maps it to an ExecutionMode via a decision matrix.
 */

import { ExecutionModes } from "./modes/index.js";
import type { ExecutionMode } from "./modes/index.js";
export { ExecutionModes };
export type { ExecutionMode };

// =========================================================================
// Types
// =========================================================================

/**
 * Scope describes the breadth of the intended change.
 */
export type IntentScope = "single_file" | "multi_file" | "module" | "cross_cutting" | "codebase_gen";

/**
 * Depth describes the complexity / number of turns expected.
 */
export type IntentDepth = "surface" | "moderate" | "deep" | "campaign";

/**
 * A structured profile produced by the IntentClassifier.
 */
export interface IntentProfile {
  scope: IntentScope;
  depth: IntentDepth;
  confidence: number;
  estimatedFiles: number;
  estimatedTurns: number;
  requiresParallel: boolean;
  requiresResearch: boolean;
  requiresVerification: boolean;
  hasArchitecturalImpact: boolean;
}

/**
 * Prior decision recorded in the session.
 */
export interface SessionDecision {
  id: string;
  description: string;
  timestamp: string;
  scope?: string;
}

/**
 * Context passed into the classifier alongside the raw prompt.
 */
export interface SessionContext {
  /** Prior decisions made during this session that raise the depth baseline. */
  activeDecisions: SessionDecision[];
  /** Workspace root path (used for file reference normalization). */
  workspaceRoot?: string;
  /** Recent prompt history (last N prompts) for user-pattern analysis. */
  recentPrompts?: string[];
}

/**
 * Result of a classification.
 */
export interface ClassificationResult {
  profile: IntentProfile;
  mode: ExecutionMode;
  reason: string;
}

// =========================================================================
// IntentClassifier
// =========================================================================

/**
 * Heuristic prompt classifier that analyzes a user prompt and session context
 * to produce an IntentProfile and ExecutionMode.
 */
export class IntentClassifier {
  /**
   * Classify a user prompt given session context.
   */
  classify(prompt: string, context: SessionContext): ClassificationResult {
    const profile = this.computeProfile(prompt, context);
    const { mode, reason } = this.modeForProfile(profile);
    return { profile, mode, reason };
  }

  // -----------------------------------------------------------------------
  // Heuristic pipeline
  // -----------------------------------------------------------------------

  private computeProfile(prompt: string, context: SessionContext): IntentProfile {
    const trimmed = prompt.trim();

    // Step 1: Prompt length analysis
    const lengthDepth = this.analyzeLength(trimmed);

    // Step 2: File reference parsing
    const fileRefs = this.parseFileReferences(trimmed);

    // Step 3: Action verb analysis
    const verbs = this.analyzeVerbs(trimmed);

    // Step 4: Scope indicator analysis
    const scopeHints = this.analyzeScopeIndicators(trimmed);

    // Step 5: Historical context
    const historyDepth = this.considerHistory(context);

    // Step 6: Structural patterns (parallelism)
    const requiresParallel = this.checkParallelStructure(trimmed);

    // Step 7: Verification / testing mentions
    const requiresVerification = this.checkVerificationNeeded(trimmed);

    // ---- Synthesize ----

    // Scope: combine file refs and scope hints
    const scope = this.resolveScope(fileRefs, scopeHints);

    // Depth: take the max from length, verb analysis, and history
    let depth = this.resolveDepth(lengthDepth, verbs.depth, historyDepth);

    // Boost depth for broader scopes — cross_cutting/codebase_gen imply more work
    if (scopeHints !== null) {
      if (scopeHints === "codebase_gen" && depth === "surface") depth = "moderate";
      if (scopeHints === "cross_cutting" && depth === "surface") depth = "moderate";
    }

    // Confidence: compute from signal agreement
    const confidence = this.computeConfidence(trimmed, fileRefs, verbs, scopeHints, depth, requiresParallel, requiresVerification);

    // Estimated files: based on scope and file references
    const estimatedFiles = this.estimateFiles(scope, fileRefs);

    // Estimated turns: based on depth and scope
    const estimatedTurns = this.estimateTurns(scope, depth);

    // Research need: check for web/search/documentation keywords
    const requiresResearch = this.checkResearchNeeded(trimmed);

    // Architectural impact: module/cross_cutting scope or specific keywords
    const hasArchitecturalImpact = this.checkArchitecturalImpact(scope, trimmed);

    return {
      scope,
      depth,
      confidence,
      estimatedFiles,
      estimatedTurns,
      requiresParallel,
      requiresResearch,
      requiresVerification,
      hasArchitecturalImpact,
    };
  }

  // -----------------------------------------------------------------------
  // Step 1: Prompt length analysis
  // -----------------------------------------------------------------------

  private analyzeLength(prompt: string): IntentDepth {
    const len = prompt.length;
    if (len < 50) return "surface";
    if (len < 150) return "moderate";
    if (len < 500) return "deep";
    return "campaign"; // 500+ chars signals substantial specification
  }

  // -----------------------------------------------------------------------
  // Step 2: File reference parsing
  // -----------------------------------------------------------------------

  private parseFileReferences(prompt: string): string[] {
    const refs: string[] = [];
    // Match explicit file paths with extensions
    const fileRegex = /\b[\w./-]+\.[a-z]+\b/g;
    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(prompt)) !== null) {
      const ref = match[0];
      // Filter out URLs and domains (e.g. "http://...", "example.com")
      if (ref.startsWith("http") || ref.includes("://")) continue;
      // Only filter domain names if they lack a file-like extension
      // Common code extensions are 1-4 chars (ts, js, py, tsx, json, yaml, etc.)
      // We only skip if the extension is a common TLD (com, org, net, io, etc.)
      // AND there's no path separator
      const domainTLDs = /^\.(com|org|net|io|co|uk|dev|app|gov|edu|mil|int)$/;
      if (
        !ref.includes("/") &&
        /^[\w-]+\.[a-z]{2,4}$/.test(ref) &&
        domainTLDs.test(ref.slice(ref.lastIndexOf(".")))
      ) {
        continue;
      }
      refs.push(ref);
    }
    return refs;
  }

  // -----------------------------------------------------------------------
  // Step 3: Action verb analysis
  // -----------------------------------------------------------------------

  private analyzeVerbs(prompt: string): { depth: IntentDepth; verbs: string[] } {
    const lower = prompt.toLowerCase();
    const found: string[] = [];

    // Surface-level verbs: fix, change, update, tweak, adjust, correct
    const surfaceVerbs = /\b(fix(?:es|ed|ing)?|change[ds]?|update[ds]?|tweak(?:ed|ing)?|adjust(?:ed|ing)?|correct(?:ed|ing)?|patch(?:es|ed|ing)?|improve[ds]?|clean[su]p|bump)\b/g;
    // Deep-level verbs: refactor, redesign, migrate, restructure, overhaul
    const deepVerbs = /\b(refactor(?:ed|ing)?|redesign(?:ed|ing)?|migrate[ds]?|restructure[ds]?|overhaul(?:ed|ing)?|rewrite|rework|reorganize[ds]?|optimize[ds]?|modularize)\b/g;
    // Campaign-level verbs: build, create, generate, implement, develop, architect
    const campaignVerbs = /\b(build|create[ds]?|generate[ds]?|implement[eds]?|develop[eds]?|architect|scaffold|establish|set\s*up|init(?:ialize)?)\b/g;

    let m: RegExpExecArray | null;

    while ((m = surfaceVerbs.exec(lower)) !== null) found.push(m[1] ?? m[0]);
    while ((m = deepVerbs.exec(lower)) !== null) found.push(m[1] ?? m[0]);
    while ((m = campaignVerbs.exec(lower)) !== null) found.push(m[1] ?? m[0]);

    // Determine depth from strongest verb signal
    // Check in reverse priority: campaign > deep > surface
    const hasCampaign = campaignVerbs.lastIndex > 0 || /\b(build|create|generate|implement|develop|architect|scaffold|establish|set\s*up)\b/i.test(lower);
    const hasDeep = !hasCampaign && /\b(refactor|redesign|migrate|restructure|overhaul|rewrite|rework|optimize|modularize)\b/i.test(lower);
    const hasSurface = !hasDeep && !hasCampaign && /\b(fix|change|update|tweak|adjust|correct|patch|improve|bump)\b/i.test(lower);

    let depth: IntentDepth = "moderate"; // default
    if (hasSurface) depth = "surface";
    if (hasDeep) depth = "deep";
    if (hasCampaign) depth = "campaign";

    return { depth, verbs: found };
  }

  // -----------------------------------------------------------------------
  // Step 4: Scope indicator analysis
  // -----------------------------------------------------------------------

  private analyzeScopeIndicators(prompt: string): IntentScope | null {
    const lower = prompt.toLowerCase();

    // Codebase-gen indicators (check FIRST — broadest)
    if (
      /\b(across|throughout)\s+(the\s+)?(project|codebase|repo|entire)\b/.test(lower) ||
      /\beverywhere\b/.test(lower) ||
      /\b(whole|entire)\s+(project|codebase|repo|app)\b/.test(lower) ||
      /\ball\s+(the\s+)?files\b/.test(lower)
    ) {
      return "codebase_gen";
    }

    // Cross-cutting (check before single-file to avoid field-level false positives)
    if (
      /\bcross[\s-]cutting\b/.test(lower) ||
      /\bthroughout\b/.test(lower) ||
      /\bglobal\b/.test(lower) ||
      /\bconsistent\w*\s+(change|update|pattern)\b/.test(lower)
    ) {
      return "cross_cutting";
    }

    // Multi-file indicators (moderate scope)
    if (
      /\b(in|across)\s+(several|multiple|a\s+few)\s+files\b/.test(lower) ||
      /\b(in|across)\s+the\s+(src|lib|app)\b/.test(lower) ||
      /\bupdate\s+(all|several|multiple)\b/.test(lower)
    ) {
      return "multi_file";
    }

    // Module-level indicators
    if (
      /\bmodule\b/.test(lower) ||
      /\bcomponent\b/.test(lower) ||
      /\bservice\b/.test(lower) ||
      /\bplugin\b/.test(lower) ||
      /\bpackage\b/.test(lower) ||
      /\bapi\b/.test(lower) ||
      /\bendpoint\b/.test(lower)
    ) {
      return "module";
    }

    // Single-file indicators (narrowest — check last to avoid overriding broader scopes)
    if (
      /\bin\s+this\s+file\b/.test(lower) ||
      /\bfix\s+this\b/.test(lower) ||
      /\bhere\s*:\s*$/m.test(lower) ||
      /\bchange\s+this\b/.test(lower)
    ) {
      return "single_file";
    }

    // Start-of-prompt patterns — only apply when the prompt is very short
    // AND there are few or no file references
    if (
      (lower.startsWith("fix ") || lower.startsWith("update ")) &&
      lower.length < 100
    ) {
      // Check how many file references exist — if multiple, this isn't single_file
      const fileRefCount = (prompt.match(/\b[\w./-]+\.[a-z]+\b/g) || []).length;
      if (fileRefCount <= 1) {
        return "single_file";
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Step 5: Historical context
  // -----------------------------------------------------------------------

  private considerHistory(context: SessionContext): number {
    // activeDecisions raise the depth baseline
    const decisionCount = context.activeDecisions?.length ?? 0;
    if (decisionCount === 0) return 0;
    // Each active decision adds depth; 3+ decisions pushes toward deep
    return Math.min(decisionCount / 3, 1);
  }

  // -----------------------------------------------------------------------
  // Step 6: Structural patterns (parallelism)
  // -----------------------------------------------------------------------

  private checkParallelStructure(prompt: string): boolean {
    // Bullet points: lines starting with -, *, •, or numbered items (1., 2., etc.)
    const bulletLines = prompt.match(/^[\s]*[-*•]\s/gm);
    const numberedItems = prompt.match(/^\s*\d+[.)]\s/gm);

    // At least 2 structural items of the same kind indicates parallel work
    if (bulletLines && bulletLines.length >= 2) return true;
    if (numberedItems && numberedItems.length >= 2) return true;

    // "and also", "meanwhile", "in parallel", "at the same time", "simultaneously"
    if (
      /\b(and\s+also|meanwhile|in\s+parallel|at\s+the\s+same\s+time|simultaneously)\b/i.test(prompt)
    ) {
      return true;
    }

    // Multiple "then" steps could indicate sequential but not parallel
    return false;
  }

  // -----------------------------------------------------------------------
  // Step 7: Verification / testing mentions
  // -----------------------------------------------------------------------

  private checkVerificationNeeded(prompt: string): boolean {
    const lower = prompt.toLowerCase();

    // Direct mentions
    if (
      /\b(test(?:s|ing|ed)?|lint(?:ing|ed|s)?|type-check|typecheck|verify|verification|validate|validation|check\s+(types|coverage))\b/.test(lower)
    ) {
      return true;
    }

    // Ensure / make sure patterns
    if (/\b(ensure|make\s+sure)\b/i.test(lower)) return true;

    return false;
  }

  // -----------------------------------------------------------------------
  // Research need
  // -----------------------------------------------------------------------

  private checkResearchNeeded(prompt: string): boolean {
    const lower = prompt.toLowerCase();

    // Web search / documentation / API lookup indicators
    if (
      /\b(search|look\s+up|find\s+out|research|documentation|docs\b|api\s+ref|how\s+to|tutorial|example\s+of)\b/.test(lower)
    ) {
      return true;
    }

    // References to external libraries, packages, or APIs
    if (
      /\b(npm\s+package|pypi|maven|crates\.io|npmjs|github\.com|stackoverflow)\b/.test(lower)
    ) {
      return true;
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Architectural impact
  // -----------------------------------------------------------------------

  private checkArchitecturalImpact(scope: IntentScope, prompt: string): boolean {
    if (scope === "cross_cutting" || scope === "codebase_gen") return true;

    const lower = prompt.toLowerCase();
    // Keywords that suggest architectural changes
    if (
      /\b(architect|architecture|refactor|restructure|redesign|migration|migrate|overhaul)\b/.test(lower)
    ) {
      return true;
    }

    // References to module boundaries, interfaces, contracts
    if (
      /\b(interface|contract|abstraction|boundary|dependency|module\s*boundary)\b/.test(lower)
    ) {
      return true;
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Synthesizers
  // -----------------------------------------------------------------------

  private resolveScope(fileRefs: string[], scopeHints: IntentScope | null): IntentScope {
    // If scope indicators were found, trust them
    if (scopeHints !== null) return scopeHints;

    // Infer from file references
    const uniqueDirs = new Set<string>();
    for (const ref of fileRefs) {
      const parts = ref.split("/");
      if (parts.length >= 2) {
        uniqueDirs.add(parts.slice(0, -1).join("/"));
      }
    }

    if (fileRefs.length === 0) {
      // No file references — default to module (middle of the range)
      return "module";
    }

    if (fileRefs.length === 1) {
      return "single_file";
    }

    if (fileRefs.length <= 3 && uniqueDirs.size <= 2) {
      return "multi_file";
    }

    if (uniqueDirs.size <= 3) {
      return "module";
    }

    return "cross_cutting";
  }

  private resolveDepth(
    lengthDepth: IntentDepth,
    verbDepth: IntentDepth,
    historyFactor: number,
  ): IntentDepth {
    // Depth hierarchy: surface(0) < moderate(1) < deep(2) < campaign(3)
    const depthValues: Record<IntentDepth, number> = {
      surface: 0,
      moderate: 1,
      deep: 2,
      campaign: 3,
    };

    const lengthVal = depthValues[lengthDepth] ?? 1;
    const verbVal = depthValues[verbDepth] ?? 1;

    // Take the max of length and verb analysis
    let combined = Math.max(lengthVal, verbVal);

    // History factor pushes depth up by at most 1 level
    if (historyFactor > 0.5) {
      combined = Math.min(combined + 1, 3);
    } else if (historyFactor > 0) {
      // Slight nudge if there are decisions but less than 2
      combined = Math.min(combined + 0, 3); // no change for weak history
    }

    // Map back to depth string
    const reverseDepth: Record<number, IntentDepth> = {
      0: "surface",
      1: "moderate",
      2: "deep",
      3: "campaign",
    };

    return reverseDepth[combined] ?? "moderate";
  }

  private computeConfidence(
    prompt: string,
    fileRefs: string[],
    verbs: { depth: IntentDepth; verbs: string[] },
    scopeHints: IntentScope | null,
    depth: IntentDepth,
    requiresParallel: boolean,
    requiresVerification: boolean,
  ): number {
    let score = 0.5; // baseline

    // More signals = higher confidence
    if (fileRefs.length > 0) score += 0.1 * Math.min(fileRefs.length, 3);
    if (verbs.verbs.length > 0) score += 0.1;
    if (scopeHints !== null) score += 0.15;
    if (requiresParallel) score += 0.05;
    if (requiresVerification) score += 0.05;

    // Penalize very short prompts (ambiguous)
    if (prompt.trim().length < 20) score -= 0.2;
    else if (prompt.trim().length < 30) score -= 0.1;

    // Boost for longer, detailed prompts
    if (prompt.trim().length > 300) score += 0.1;
    if (prompt.trim().length > 600) score += 0.1;

    // Boost when we have both an explicit file reference AND a scope hint
    if (fileRefs.length > 0 && scopeHints !== null) score += 0.1;

    // Penalize conflicting signals: surface scope + deep verbs
    if (scopeHints === "single_file" && (depth === "deep" || depth === "campaign")) {
      score -= 0.1;
    }
    if (scopeHints === "codebase_gen" && depth === "surface") {
      score -= 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  private estimateFiles(scope: IntentScope, fileRefs: string[]): number {
    // If we have explicit file refs, that's the best estimate
    if (fileRefs.length > 0) return fileRefs.length;

    // Otherwise estimate from scope
    switch (scope) {
      case "single_file": return 1;
      case "multi_file": return 3;
      case "module": return 8;
      case "cross_cutting": return 15;
      case "codebase_gen": return 30;
    }
  }

  private estimateTurns(scope: IntentScope, depth: IntentDepth): number {
    // Matrix: scope × depth → estimated turns
    const turnTable: Record<IntentScope, Record<IntentDepth, number>> = {
      single_file:   { surface: 1, moderate: 2, deep: 4, campaign: 6 },
      multi_file:    { surface: 2, moderate: 3, deep: 6, campaign: 10 },
      module:        { surface: 3, moderate: 5, deep: 10, campaign: 15 },
      cross_cutting: { surface: 4, moderate: 8, deep: 15, campaign: 25 },
      codebase_gen:  { surface: 5, moderate: 10, deep: 20, campaign: 40 },
    };

    return turnTable[scope]?.[depth] ?? 3;
  }

  // -----------------------------------------------------------------------
  // Decision matrix — IntentProfile → ExecutionMode
  //
  // AUTO mode is the default natural system behavior: the IntentClassifier
  // analyzes every prompt and the orchestrator handles execution based on
  // the profile's scope, depth, and confidence metrics. The profile data
  // (estimated files, turns, parallelism, verification needs) is passed
  // through so downstream systems can adapt their behavior accordingly.
  // -----------------------------------------------------------------------

  private modeForProfile(profile: IntentProfile): { mode: ExecutionMode; reason: string } {
    const { scope, depth, confidence } = profile;

    // AUTO: the natural system-default mode. Everything flows through
    // the orchestrator's standard pipeline using the profile data.
    return {
      mode: ExecutionModes.AUTO,
      reason: `Auto mode selected — profile: ${scope}, ${depth} (confidence: ${(confidence * 100).toFixed(0)}%). The orchestrator will determine the optimal execution strategy.`,
    };
  }
}