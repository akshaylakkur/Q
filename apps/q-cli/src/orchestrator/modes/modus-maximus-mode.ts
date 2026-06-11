/**
 * ModusMaximusMode — The crown jewel execution mode.
 *
 * Four-phase pipeline:
 *   Phase 1: Generate a highly detailed .md plan (15-50 steps)
 *   Phase 2: User confirmation (Looks good / Needs revision / Redo)
 *   Phase 3: Sequential sub-agent execution (each step = independent agent)
 *   Phase 4: Collapse & summary
 *
 * Design principles:
 *   - Dependency-aware: each step only relies on prior steps' output on disk
 *   - Context purity: each sub-agent is a fresh Agent instance with zero
 *     prior context — it operates solely on the filesystem state
 *   - Synchronous execution: one agent at a time, no parallelism
 *   - Plan persisted to ~/.Q/modes/modus-maximus/<session_id>.md
 */

import { ExecutionModeHandler } from "./handler.js";
import { ExecutionModes } from "./index.js";
import type { ExecutionMode } from "./index.js";
import type { Task, ExecutionResult } from "./types.js";
import type { OrchestratorCore } from "../core.js";
import { runAgentTurn } from "../../agent/wiring.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

// =========================================================================
// Types
// =========================================================================

export type ConfirmationChoice = "looks-good" | "needs-revision" | "redo";

export interface ConfirmationResponse {
  choice: ConfirmationChoice;
  revisionText?: string;
}

export interface ParsedStep {
  index: number;
  title: string;
  instructions: string;
}

export interface StepAgentExecResult {
  stepIndex: number;
  summary: string;
  usage: { promptTokens: number; completionTokens: number };
  success: boolean;
  changedFiles: string[];
}

// =========================================================================
// Constants
// =========================================================================

const MODUS_MAXIMUS_DIR_NAME = "modus-maximus";
const MIN_STEPS = 15;
const MAX_STEPS = 50;

// =========================================================================
// Profile resolution
// =========================================================================

/**
 * Resolve the best agent profile for a given step based on its content.
 * This heuristic inspects the step title and instructions to determine
 * whether it needs a rewriter, test-gen, architect, etc.
 */
function resolveProfileForStep(step: ParsedStep): string {
  const title = step.title.toLowerCase();
  const instructions = step.instructions.toLowerCase();

  if (
    title.includes("test") || title.includes("spec") ||
    instructions.includes("write test") || instructions.includes("unit test") ||
    instructions.includes("integration test") || instructions.includes("e2e")
  ) {
    return "test-gen";
  }
  if (
    title.includes("scaffold") || title.includes("config") ||
    title.includes("project") || title.includes("monorepo") ||
    title.includes("dependenc") || title.includes("package")
  ) {
    return "architect";
  }
  if (
    title.includes("doc") || title.includes("readme") ||
    instructions.includes("document") || instructions.includes("readme")
  ) {
    return "doc-gen";
  }
  if (
    title.includes("validat") || title.includes("verify") ||
    title.includes("review") || title.includes("audit")
  ) {
    return "reviewer";
  }
  if (
    title.includes("architect") || title.includes("design") ||
    title.includes("data model") || title.includes("schema")
  ) {
    return "architect";
  }
  // Default to rewriter for implementation steps
  return "rewriter";
}

// =========================================================================
// Plan generation
// =========================================================================

const PLAN_GENERATION_PROMPT = `You are a master software architect and principal engineer. Your task is to decompose the user's request into a highly detailed, dependency-aware implementation plan.

OUTPUT FORMAT:
Output ONLY a markdown document with the structure shown below. No preamble, no commentary.

# Implementation Plan

> **Purpose**: This plan decomposes the user's request into sequential, dependency-aware implementation steps. Each step builds on the prior ones.

## Overview

[1-2 paragraphs describing the overall architecture and approach]

## Implementation Steps

### Step 1: [First Action - Title]

[Detailed natural language instructions describing what to build, what files to create, what the structure should look like, and what patterns to follow. Include the WHY behind decisions. Use code snippets sparingly — only for critical interfaces, key function signatures, or configuration that must be exact. Most of the step should be descriptive prose that any senior engineer can follow.]

[Include test and validation instructions where appropriate.]

### Step 2: [Second Action - Title]

[Detailed natural language instructions that can assume Step 1 is complete. Reference files/code from Step 1 by name. Describe the approach, the design decisions, and what the implementation should achieve. Use code only for critical patterns that need to be exact.]

[Include test instructions.]

### Step N: [Nth Action - Title]

[... and so on — detailed natural language throughout]

## Validation

[Brief section on how to validate the overall implementation]

RULES:
1. Generate between 15 and 50 steps. Aim for the level of detail needed for a production enterprise application.
2. Each step must be SELF-CONTAINED and DEPENDENCY-AWARE. Step N can ONLY depend on code created in Steps 1..N-1.
3. Each step must be written in DETAILED NATURAL LANGUAGE. Describe the architecture, the design approach, the file organization, the patterns to use. Code snippets are acceptable ONLY for critical interfaces, function signatures, or configuration that must be exact. The bulk of each step must be prose.
4. Include test generation steps (unit tests, integration tests) for major components.
5. Include validation steps that verify the implementation works end-to-end.
6. Be precise in your NATURAL LANGUAGE descriptions. Describe file paths, function responsibilities, data flow, component hierarchy, and state management approach verbally.
7. The plan must be executable by independent sub-agents. Each step will be given to a DIFFERENT agent with NO context from prior steps, so each step must be COMPLETE and STANDALONE in its instructions.

User Request: {{USER_PROMPT}}`;

// =========================================================================
// ModusMaximusMode
// =========================================================================

export class ModusMaximusMode extends ExecutionModeHandler {
  readonly mode: ExecutionMode = ExecutionModes.MODUS_MAXIMUS;
  readonly description = "Full orchestration pipeline — plan generation, user confirmation, sequential sub-agent execution, and final summary";

  /** Resolver for the confirmation promise (bridged to TUI) */
  private confirmationResolver?: (response: ConfirmationResponse) => void;

  /** Resolver for the revision input promise (bridged to TUI) */
  private revisionResolver?: (revisionText: string) => void;

  // =======================================================================
  // Public execution entry point
  // =======================================================================

  async execute(task: Task, orchestrator: OrchestratorCore): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const sessionId = orchestrator.getSessionId() || randomUUID();
    const planDir = resolve(homedir(), ".Q", "modes", MODUS_MAXIMUS_DIR_NAME);
    const planFilePath = resolve(planDir, `${sessionId}.md`);

    const allStepResults: StepAgentExecResult[] = [];
    const allErrors: string[] = [];
    const allChangedFiles: string[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    try {
      // ── Ensure plan directory exists ────────────────────────────────
      await mkdir(planDir, { recursive: true });

      // ── Phase 1: Generate Plan ─────────────────────────────────────
      let planContent = await this.generatePlan(task, orchestrator, planFilePath);

      // ── Phase 2: Confirmation Loop ─────────────────────────────────
      let confirmed = false;
      while (!confirmed) {
        // Emit plan-completed event to TUI
        orchestrator.recordAgentEvent({
          type: "modus-maximus.plan.completed",
          planFilePath,
          stepCount: this.countSteps(planContent),
          planContent,
        });

        // Wait for user confirmation
        const response = await this.waitForConfirmation(orchestrator);

        switch (response.choice) {
          case "looks-good":
            confirmed = true;
            break;

          case "needs-revision":
            if (response.revisionText?.trim()) {
              // Regenerate with revision context
              planContent = await this.generatePlan(task, orchestrator, planFilePath, response.revisionText);
            }
            break;

          case "redo":
            // Regenerate from scratch
            planContent = await this.generatePlan(task, orchestrator, planFilePath);
            break;
        }
      }

      // ── Phase 3: Sequential Sub-Agent Execution ────────────────────
      const steps = this.parseSteps(planContent);

      // Validate we have enough steps
      if (steps.length < 1) {
        throw new Error("Plan contains no steps. Cannot execute.");
      }

      for (const step of steps) {
        // Check for cancellation
        if (orchestrator.getAbortSignal().aborted) {
          throw new Error("Execution cancelled by user");
        }

        // Emit step started
        orchestrator.recordAgentEvent({
          type: "modus-maximus.step.started",
          stepIndex: step.index,
          stepTitle: step.title,
          instructions: step.instructions,
        });

        // Execute the step via a sub-agent
        try {
          const stepResult = await this.executeStep(step, task, orchestrator);
          allStepResults.push(stepResult);

          if (stepResult.changedFiles) {
            allChangedFiles.push(...stepResult.changedFiles);
          }
          totalPromptTokens += stepResult.usage.promptTokens;
          totalCompletionTokens += stepResult.usage.completionTokens;

          // Emit step completed
          orchestrator.recordAgentEvent({
            type: "modus-maximus.step.completed",
            stepIndex: step.index,
            stepTitle: step.title,
            output: stepResult.summary,
            usage: stepResult.usage,
          });
        } catch (stepErr) {
          const errMsg = `Step ${step.index} ("${step.title}") failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`;
          allErrors.push(errMsg);

          allStepResults.push({
            stepIndex: step.index,
            summary: errMsg,
            usage: { promptTokens: 0, completionTokens: 0 },
            success: false,
            changedFiles: [],
          });

          orchestrator.recordAgentEvent({
            type: "modus-maximus.step.failed",
            stepIndex: step.index,
            stepTitle: step.title,
            error: errMsg,
          });
        }
      }

      // ── Phase 4: Summary ───────────────────────────────────────────
      const summary = this.buildSummary(task, allStepResults, allErrors, startedAt);

      orchestrator.recordAgentEvent({
        type: "modus-maximus.summary",
        totalSteps: steps.length,
        completedSteps: allStepResults.filter((r) => r.success).length,
        failedSteps: allErrors.length,
        changedFiles: [...new Set(allChangedFiles)],
        tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
        summary,
      });

      const success = allErrors.length === 0;
      return {
        success,
        mode: this.mode,
        taskId: task.id,
        output: summary,
        error: allErrors.length > 0 ? allErrors.join("\n") : undefined,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        llmCallCount: steps.length + 1, // plan + each step
        toolCallCount: 0,
        durationMs: Date.now() - startedAt,
        changedFiles: [...new Set(allChangedFiles)],
        verificationPassed: success,
        errors: allErrors.length > 0 ? allErrors : undefined,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        mode: this.mode,
        taskId: task.id,
        output: "",
        error: errMsg,
        durationMs: Date.now() - startedAt,
        errors: [errMsg, ...allErrors],
        completedAt: new Date().toISOString(),
      };
    }
  }

  // =======================================================================
  // Confirmation bridge — called by TUI via orchestrator
  // =======================================================================

  /**
   * Resolve the confirmation promise. Called by the TUI when the user
   * selects an option from the dropdown.
   */
  resolveConfirmation(response: ConfirmationResponse): void {
    if (this.confirmationResolver) {
      this.confirmationResolver(response);
      this.confirmationResolver = undefined;
    }
  }

  /**
   * Resolve the revision input promise. Called by the TUI when the user
   * submits revision text.
   */
  resolveRevision(revisionText: string): void {
    if (this.revisionResolver) {
      this.revisionResolver(revisionText);
      this.revisionResolver = undefined;
    }
  }

  // =======================================================================
  // Phase 1: Plan Generation
  // =======================================================================

  /**
   * Generate the implementation plan by invoking the root agent with
   * a meta-prompt. The plan is streamed to the TUI and saved to disk.
   */
  private async generatePlan(
    task: Task,
    orchestrator: OrchestratorCore,
    planFilePath: string,
    revisionContext?: string,
  ): Promise<string> {
    const agent = orchestrator.rootAgent;
    if (!agent) {
      throw new Error("No root agent configured. Cannot generate plan without an LLM provider.");
    }

    // Build the meta-prompt
    let metaPrompt = PLAN_GENERATION_PROMPT.replace("{{USER_PROMPT}}", task.prompt);

    if (revisionContext) {
      metaPrompt += `\n\nREVISION CONTEXT (apply these changes to the plan):\n${revisionContext}`;
    }

    // Emit plan started event
    orchestrator.recordAgentEvent({
      type: "modus-maximus.plan.started",
      sessionId: orchestrator.getSessionId() || "unknown",
    });

    // Invoke the agent — this will stream via the event system
    const result = await runAgentTurn(agent, metaPrompt, orchestrator.getAbortSignal());

    if (result.error) {
      throw new Error(`Plan generation failed: ${result.error}`);
    }

    const planContent = result.output || "# Implementation Plan\n\nNo plan was generated.";

    // Write the plan to disk
    await writeFile(planFilePath, planContent, "utf-8");

    return planContent;
  }

  // =======================================================================
  // Phase 2: User Confirmation
  // =======================================================================

  /**
   * Wait for the user to respond to the confirmation prompt.
   * Creates a promise that is resolved by the TUI via resolveConfirmation().
   */
  private waitForConfirmation(orchestrator: OrchestratorCore): Promise<ConfirmationResponse> {
    return new Promise((resolve) => {
      this.confirmationResolver = resolve;

      // Emit the confirmation request event to the TUI
      orchestrator.recordAgentEvent({
        type: "modus-maximus.confirmation.request",
      });
    });
  }

  // =======================================================================
  // Phase 3: Step Execution
  // =======================================================================

  /**
   * Execute a single step by spawning a sub-agent.
   * The sub-agent is a fresh Agent instance with NO prior context.
   */
  private async executeStep(
    step: ParsedStep,
    task: Task,
    orchestrator: OrchestratorCore,
  ): Promise<StepAgentExecResult> {
    const poolManager = orchestrator.poolManager;
    const subagentHost = (poolManager as any).subagentHost as
      | { spawn: (profile: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ id: string; result: string; usage: { promptTokens: number; completionTokens: number } }> }
      | undefined;

    if (!subagentHost) {
      throw new Error("Sub-agent host not available. Ensure root agent is configured.");
    }

    // Resolve the best profile for this step
    const profile = resolveProfileForStep(step);

    // Build the sub-agent prompt — includes only the original user request
    // and this specific step's instructions. No prior step context.
    const agentPrompt = `You are working on a large project. Your task is a SINGLE STEP of a larger plan.

ORIGINAL USER REQUEST:
${task.prompt}

YOUR ASSIGNED STEP:
${step.instructions}

Execute this step completely. Create all necessary files, write all code, and ensure it works.
Do NOT skip ahead to future steps — only implement what this step requires.
After completing, provide a brief summary of what you did and what files were changed.`;

    // Spawn the sub-agent (synchronous — we await the result)
    const result = await subagentHost.spawn(profile, agentPrompt, {
      signal: orchestrator.getAbortSignal(),
    });

    return {
      stepIndex: step.index,
      summary: result.result || "(no output)",
      usage: result.usage || { promptTokens: 0, completionTokens: 0 },
      success: true,
      changedFiles: [], // Sub-agent result doesn't track files yet
    };
  }

  // =======================================================================
  // Plan Parsing
  // =======================================================================

  /**
   * Parse the generated markdown plan into individual steps.
   * Steps are extracted from ### Step N: Title or ## Step N: Title headings.
   */
  parseSteps(mdContent: string): ParsedStep[] {
    const steps: ParsedStep[] = [];

    // First pass: collect all step headings with their positions
    const headingRegex = /^(#{2,3})\s+Step\s+(\d+)[:\s]+(.+)$/gm;
    const matches: Array<{ index: number; title: string; startPos: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = headingRegex.exec(mdContent)) !== null) {
      matches.push({
        index: parseInt(match[2]!, 10),
        title: match[3]!.trim(),
        startPos: match.index,
      });
    }

    // Second pass: extract instructions between each heading and the next
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      const currentHeadingEnd = mdContent.indexOf("\n", m.startPos);
      const contentStart = currentHeadingEnd !== -1 ? currentHeadingEnd + 1 : m.startPos;

      // End position: either the next heading's start, or end of content
      const endPos = i + 1 < matches.length ? matches[i + 1]!.startPos : mdContent.length;

      const instructions = mdContent.slice(contentStart, endPos).trim();

      if (instructions.length > 0) {
        steps.push({
          index: m.index,
          title: m.title,
          instructions,
        });
      }
    }

    // Sort by index to ensure correct order
    steps.sort((a, b) => a.index - b.index);

    return steps;
  }

  /**
   * Count the number of steps in the plan.
   */
  private countSteps(mdContent: string): number {
    return this.parseSteps(mdContent).length;
  }

  // =======================================================================
  // Phase 4: Summary
  // =======================================================================

  /**
   * Build the final summary string.
   */
  private buildSummary(
    task: Task,
    stepResults: StepAgentExecResult[],
    errors: string[],
    startedAt: number,
  ): string {
    const totalSteps = stepResults.length;
    const completedSteps = stepResults.filter((r) => r.success).length;
    const failedSteps = errors.length;
    const duration = ((Date.now() - startedAt) / 1000).toFixed(1);

    const lines: string[] = [];
    lines.push(`# Modus Maximus — Execution Complete`);
    lines.push(``);
    lines.push(`**Original Request:** ${task.prompt.slice(0, 100)}${task.prompt.length > 100 ? "..." : ""}`);
    lines.push(``);
    lines.push(`## Summary`);
    lines.push(``);
    lines.push(`- **Total Steps:** ${totalSteps}`);
    lines.push(`- **Completed:** ${completedSteps}`);
    lines.push(`- **Failed:** ${failedSteps}`);
    lines.push(`- **Duration:** ${duration}s`);
    lines.push(``);

    if (errors.length > 0) {
      lines.push(`## Errors`);
      lines.push(``);
      for (const err of errors) {
        lines.push(`- ❌ ${err}`);
      }
      lines.push(``);
    }

    lines.push(`## Step Results`);
    lines.push(``);
    for (const sr of stepResults) {
      const icon = sr.success ? "✅" : "❌";
      lines.push(`${icon} **Step ${sr.stepIndex}:** ${sr.summary.slice(0, 150)}${sr.summary.length > 150 ? "..." : ""}`);
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(`*Modus Maximus completed in ${duration}s*`);

    return lines.join("\n");
  }
}