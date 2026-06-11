/**
 * Step Agent Message Component — Displays a step agent's work in the transcript.
 *
 * During streaming: shows tool calls, tool results, chain-of-thought thinking,
 * and the agent's latest text output. Pre-tool-chatter text is replaced
 * by each new assistant message block to avoid repetitive accumulation.
 * After completion: collapses into a compact summary line.
 * Ctrl+I to expand/collapse.
 */

import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import { Container, Markdown, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette } from "../types.js";

export type StepAgentState = "streaming" | "completed" | "failed";

const MESSAGE_INDENT = "  ";

// ── Tool call tracking ─────────────────────────────────────────────────

interface ToolCallEntry {
  id: string;
  name: string;
  args: string; // accumulated arguments
  output: string; // tool result output
  isComplete: boolean;
}

// ── Component ───────────────────────────────────────────────────────────

export class StepAgentMessageComponent implements Component {
  private instructionsContainer: Container;
  private outputContainer: Container;
  private markdownTheme: MarkdownTheme;
  private colors: ColorPalette;

  private stepIndex: number;
  private stepTitle: string;
  private instructions: string;
  /** Latest text output from the current assistant message block.
   *  Cleared each time a new tool call starts, since pre-tool text
   *  is just the LLM's self-talk — only the post-tool summary persists. */
  private textOutput: string = "";
  /** Chain-of-thought thinking text (accumulated across the step) */
  private thinking: string = "";
  /** Completed tool calls with their names, args, and results */
  private toolCalls: Map<string, ToolCallEntry> = new Map();
  /** Whether at least one tool call has completed in this step */
  private hasCompletedTool: boolean = false;
  private agentState: StepAgentState = "streaming";
  private collapsed: boolean = false;
  private contentWidth: number = 0;

  constructor(
    stepIndex: number,
    stepTitle: string,
    instructions: string,
    colors: ColorPalette,
  ) {
    this.stepIndex = stepIndex;
    this.stepTitle = stepTitle;
    this.instructions = instructions;
    this.colors = colors;
    this.markdownTheme = this.createMarkdownTheme();
    this.instructionsContainer = new Container();
    this.outputContainer = new Container();

    // Render instructions
    if (instructions.trim().length > 0) {
      this.instructionsContainer.addChild(
        new Markdown(instructions.trim(), 0, 0, this.markdownTheme),
      );
    }
  }

  private createMarkdownTheme(): MarkdownTheme {
    const c = this.colors;
    return {
      heading: (s: string) => chalk.bold.hex(c.textBright)(s),
      link: (s: string) => chalk.hex(c.info).underline(s),
      linkUrl: (s: string) => chalk.hex(c.textDim).italic(s),
      code: (s: string) =>
        chalk.bgHex(c.codeHighlight)(chalk.hex(c.accent)(s)),
      codeBlock: (s: string) =>
        chalk.bgHex(c.surface)(chalk.hex(c.text)(s)),
      codeBlockBorder: (s: string) => chalk.hex(c.textDim)(s),
      quote: (s: string) => chalk.hex(c.textDim).italic(s),
      quoteBorder: (s: string) => chalk.hex(c.textDim)(s),
      hr: (s: string) => chalk.hex(c.textDim)(s),
      listBullet: (s: string) => chalk.hex(c.primary)(s),
      bold: (s: string) => chalk.bold.hex(c.textBright)(s),
      italic: (s: string) => chalk.italic.hex(c.text)(s),
      strikethrough: (s: string) => chalk.strikethrough.hex(c.textDim)(s),
      underline: (s: string) => chalk.underline.hex(c.text)(s),
      highlightCode: (code: string, _lang?: string) => {
        const lines = code.split("\n");
        return lines.map((line) =>
          chalk.bgHex(c.codeHighlight)(chalk.hex(c.codeText)(line)),
        );
      },
      codeBlockIndent: "  ",
    };
  }

  getStepIndex(): number {
    return this.stepIndex;
  }

  getState(): StepAgentState {
    return this.agentState;
  }

  setState(state: StepAgentState): void {
    this.agentState = state;
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
  }

  // ── Output methods ──────────────────────────────────────────────────

  /**
   * Append streaming text from the current assistant message block.
   * Pre-tool text (before any tool call occurred) is accumulated.
   * Post-tool text (after the first tool completed) replaces the
   * pre-tool text — only the latest meaningful summary survives.
   */
  appendOutput(delta: string): void {
    if (this.hasCompletedTool) {
      // Post-tool text: this is the actual summary meaningful output.
      // Replace any pre-tool chatter and keep only this.
      this.textOutput = (this.textOutput + delta).trim();
    } else {
      // Pre-tool text: will be discarded when a tool call appears.
      this.textOutput += delta;
    }
    this.rebuildOutputContainer();
  }

  /**
   * Set the final output (used on step completion).
   */
  setOutput(content: string): void {
    this.textOutput = content;
    this.rebuildOutputContainer();
  }

  getOutput(): string {
    return this.textOutput;
  }

  /** Append thinking text (chain-of-thought) */
  appendThinking(delta: string): void {
    this.thinking += delta;
    this.rebuildOutputContainer();
  }

  /**
   * Start tracking a new tool call.
   * Clears any pre-tool text since it was just the LLM's self-talk
   * that led to this tool call — not useful output to keep.
   */
  startToolCall(toolCallId: string, name: string): void {
    if (!this.hasCompletedTool) {
      // Discard pre-tool chatter — the tool call IS the action
      this.textOutput = "";
    }
    this.toolCalls.set(toolCallId, {
      id: toolCallId,
      name,
      args: "",
      output: "",
      isComplete: false,
    });
    this.rebuildOutputContainer();
  }

  /** Append to a tool call's streaming arguments */
  appendToolCallDelta(toolCallId: string, argsPart: string): void {
    const entry = this.toolCalls.get(toolCallId);
    if (entry) {
      entry.args += argsPart;
      this.rebuildOutputContainer();
    }
  }

  /**
   * Set the result/output of a completed tool call.
   * Marks that we now have a completed tool, so any subsequent
   * text.delta is treated as fresh post-tool summary output.
   */
  completeToolCall(toolCallId: string, output: string): void {
    const entry = this.toolCalls.get(toolCallId);
    if (entry) {
      entry.output = output;
      entry.isComplete = true;
      this.hasCompletedTool = true;
      this.rebuildOutputContainer();
    }
  }

  // ── Internal ────────────────────────────────────────────────────────

  private rebuildOutputContainer(): void {
    const parts: string[] = [];

    // 1. Thinking section (always shown if present)
    if (this.thinking.trim()) {
      parts.push(
        chalk.hex(this.colors.textDim).italic("💭 " + this.thinking.trim()),
      );
    }

    // 2. Tool calls
    for (const [, tc] of this.toolCalls) {
      const arrow = chalk.hex(this.colors.primary)("→");
      const name = chalk.bold.hex(this.colors.accent)(tc.name);
      const args =
        tc.args.trim() ||
        chalk.hex(this.colors.textDim).italic("(awaiting args)");

      // Tool call header
      parts.push(`${arrow} ${name}(${args})`);

      // Tool result — only show for completed tools
      if (tc.isComplete && tc.output.trim()) {
        const resultLines = tc.output.trim().split("\n");
        const maxResultLines = 15;
        const displayLines = resultLines.slice(0, maxResultLines);
        const truncated = resultLines.length > maxResultLines;

        for (const line of displayLines) {
          parts.push(`  ${chalk.hex(this.colors.textDim)(line)}`);
        }

        if (truncated) {
          parts.push(
            `  ${chalk.hex(this.colors.textDim).italic(`… (${resultLines.length - maxResultLines} more lines)`)}`,
          );
        }
      } else if (!tc.isComplete) {
        // Running indicator for in-progress tool calls
        parts.push(
          `  ${chalk.hex(this.colors.textDim).italic("running…")}`,
        );
      }
    }

    // 3. Latest text output — only shown if we have post-tool content
    //    OR if no tools have been called yet (initial pre-tool text)
    const showText = this.textOutput.trim();
    if (showText) {
      // If we have completed tools, this is the meaningful summary;
      // if no tools yet, this is the initial plan text (tolerated briefly).
      if (this.hasCompletedTool) {
        // Post-tool summary — highlight as the final output
        parts.push(`---\n${showText}`);
      } else {
        // Pre-tool or no-tool text — shown as-is
        parts.push(showText);
      }
    }

    // Rebuild the Markdown container
    this.outputContainer.clear();
    const combined = parts.join("\n");
    if (combined.trim().length > 0) {
      this.outputContainer.addChild(
        new Markdown(combined.trim(), 0, 0, this.markdownTheme),
      );
    }
  }

  invalidate(): void {
    this.instructionsContainer.invalidate?.();
    this.outputContainer.invalidate?.();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const indent = MESSAGE_INDENT;
    const indentWidth = visibleWidth(indent);
    this.contentWidth = Math.max(1, width - indentWidth);

    lines.push("");

    // ── Instructions label ────────────────────────────────────────────
    const stepLabelRaw = `Instructions - step ${String(this.stepIndex).padStart(3, "0")}`;
    const stepLabel = chalk.bold.hex(this.colors.secondary)(
      this.stepTitle ? `${stepLabelRaw}: ${this.stepTitle}` : stepLabelRaw,
    );
    const truncatedLabel = truncateToWidth(stepLabel, width, "…");
    lines.push(truncatedLabel);

    // If collapsed and completed/failed — show collapsed summary
    if (this.collapsed && (this.agentState === "completed" || this.agentState === "failed")) {
      const icon = this.agentState === "completed" ? "✅" : "❌";
      const toolCallsCount = this.toolCalls.size;
      const titleSuffix = this.stepTitle ? `: ${this.stepTitle}` : "";
      const summaryLine = indent + chalk.hex(this.colors.textDim)(
        `${icon} Step ${this.stepIndex}${titleSuffix} — ${this.agentState === "completed" ? "completed" : "failed"} ${toolCallsCount > 0 ? `· ${toolCallsCount} tool calls` : ""} ${chalk.italic("(Ctrl+I to inspect)")}`,
      );
      lines.push(truncateToWidth(summaryLine, width, "…"));
      lines.push("");
      return lines;
    }

    // ── Instructions content ──────────────────────────────────────────
    if (this.instructions.trim()) {
      const instrLines = this.instructionsContainer.render(this.contentWidth);
      for (const il of instrLines) {
        const fullLine = indent + il;
        if (visibleWidth(fullLine) > width) {
          lines.push(truncateToWidth(fullLine, width, "…"));
        } else {
          lines.push(fullLine);
        }
      }
    }

    lines.push("");

    // ── Agent label ──────────────────────────────────────────────────
    const agentLabel = chalk.bold.hex(this.colors.roleAssistant)(
      `step-${String(this.stepIndex).padStart(3, "0")}`,
    );
    const streamingIndicator = this.agentState === "streaming"
      ? " " + chalk.hex(this.colors.primary)("●")
      : "";
    lines.push(truncateToWidth(agentLabel + streamingIndicator, width, "…"));

    // ── Agent output ──────────────────────────────────────────────────
    const hasOutput =
      this.textOutput.trim() ||
      this.thinking.trim() ||
      this.toolCalls.size > 0;

    if (hasOutput) {
      const outLines = this.outputContainer.render(this.contentWidth);
      for (const ol of outLines) {
        const fullLine = indent + ol;
        if (visibleWidth(fullLine) > width) {
          lines.push(truncateToWidth(fullLine, width, "…"));
        } else {
          lines.push(fullLine);
        }
      }
    } else if (this.agentState === "streaming") {
      // Still waiting for output
      const waitingLine = indent + chalk.hex(this.colors.textDim).italic("working...");
      lines.push(truncateToWidth(waitingLine, width, "…"));
    }

    // Streaming indicator
    if (this.agentState === "streaming") {
      const indicatorLine = indent + chalk.hex(this.colors.primary)("●");
      lines.push(truncateToWidth(indicatorLine, width, "…"));
    }

    lines.push("");
    return lines;
  }
}