/**
 * Tool Call Component — Renders tool calls with visual clarity.
 *
 * Shows:
 * - Bold tool name (no icons) as a clear header
 * - File paths, commands, or key arguments inline
 * - Streaming argument preview while the LLM is generating
 * - Rich result display:
 *   - Write/StrReplace → diff preview
 *   - Bash → output with exit code
 *   - Read → file content preview
 *   - Others → truncated output
 * - Expandable/collapsible for long results
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { readFileSync, existsSync } from "node:fs";
import type { ColorPalette, ToolCallBlockData, ToolResultBlockData } from "../types.js";
import { DiffPreviewComponent } from "./diff-preview.js";

export class ToolCallComponent implements Component {
  private data: ToolCallBlockData;
  private colors: ColorPalette;
  private expanded: boolean = false;
  private diffComponent: DiffPreviewComponent | null = null;
  private streamingArgsText: string = "";

  constructor(data: ToolCallBlockData, colors: ColorPalette) {
    this.data = data;
    this.colors = colors;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  setResult(result: ToolResultBlockData): void {
    this.data.result = result;

    // If this tool involves file changes, create a diff preview
    if (this.shouldShowDiff()) {
      const diffData = this.buildDiffData();
      if (diffData) {
        this.diffComponent = new DiffPreviewComponent(diffData, this.colors);
        if (this.expanded) this.diffComponent.setExpanded(true);
      }
    }
  }

  updateStreamingArgs(argsPart: string): void {
    this.streamingArgsText += argsPart;
  }

  invalidate(): void {
    this.diffComponent?.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(20, width - 4);
    const indent = "  ";

    // ── Tool Header ──────────────────────────────────────────────────
    const color = this.getToolColor();
    const headerColor = chalk.hex(color);
    const header = `${headerColor(chalk.bold(this.data.name))}`;

    // Build header description (key args inline)
    let headerDesc = "";
    const argsDesc = this.formatArgsInline();
    if (argsDesc) {
      headerDesc = ` ${chalk.hex(this.colors.textDim)(argsDesc)}`;
    }

    lines.push("");
    lines.push(truncateToWidth(`${indent}${header}${headerDesc}`, width, "…"));

    // ── Streaming arguments ──────────────────────────────────────────
    if (this.streamingArgsText) {
      // Show the args preview as we stream
      const preview = truncateToWidth(
        this.streamingArgsText,
        innerWidth - 6,
        "…",
      );
      const streamingLine = `${indent}  ${chalk.hex(this.colors.primary).italic(preview)}`;
      lines.push(truncateToWidth(streamingLine, width, "…"));
    }

    // ── Result / Output ──────────────────────────────────────────────
    if (this.data.result) {
      const result = this.data.result;

      // If we have a diff component (Write/Edit/etc.), render it
      if (this.diffComponent) {
        const diffLines = this.diffComponent.render(innerWidth);
        for (const dl of diffLines) {
          lines.push(truncateToWidth(dl, width, "…"));
        }
        lines.push("");
        return lines;
      }

      // Otherwise show result inline
      if (result.is_error) {
        const errorHeader = `${indent}  ${chalk.hex(this.colors.error)("✗ Error")}:`;
        lines.push(truncateToWidth(errorHeader, width, "…"));
        const errorLines = result.output.split("\n").slice(0, 10);
        for (const el of errorLines) {
          lines.push(
            `${indent}    ${chalk.hex(this.colors.error)(truncateToWidth(el, innerWidth - 8, "…"))}`,
          );
        }
        if (errorLines.length > 10) {
          lines.push(
            truncateToWidth(
              `${indent}    ${chalk.hex(this.colors.textDim)(`... ${errorLines.length - 10} more lines`)}`,
              width,
              "…",
            ),
          );
        }
      } else if (result.output) {
        this.renderOutput(lines, result.output, indent, innerWidth, width);
      }

      // Success checkmark
      if (!result.is_error && !this.diffComponent) {
        const checkLine = `${indent}  ${chalk.hex(this.colors.success)("✓ Done")}`;
        lines.push(truncateToWidth(checkLine, width, "…"));
      }
    } else if (!this.streamingArgsText) {
      // No result yet and not streaming — show running indicator
      const runningLine = `${indent}  ${chalk.hex(this.colors.primary)("◌ running...")}`;
      lines.push(truncateToWidth(runningLine, width, "…"));
    }

    lines.push("");
    return lines;
  }

  private renderOutput(
    lines: string[],
    output: string,
    indent: string,
    innerWidth: number,
    width: number,
  ): void {
    const outputLines = output.split("\n");

    // Determine how many lines to show
    const maxPreviewLines = this.expanded ? outputLines.length : 5;
    const truncated = outputLines.length > maxPreviewLines;
    const shown = truncated ? outputLines.slice(0, maxPreviewLines) : outputLines;

    for (const ol of shown) {
      const truncatedLine = truncateToWidth(ol, innerWidth - 4, "…");
      const fullLine = `${indent}  ${chalk.hex(this.colors.textDim)(truncatedLine)}`;
      lines.push(truncateToWidth(fullLine, width, "…"));
    }

    if (truncated) {
      const remaining = outputLines.length - maxPreviewLines;
      lines.push(
        truncateToWidth(
          `${indent}  ${chalk.hex(this.colors.textDim)(`... ${remaining} more lines (expand with Ctrl+O)`)}`,
          width,
          "…",
        ),
      );
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private shouldShowDiff(): boolean {
    return ["Write", "StrReplace", "Edit", "apply_diff"].includes(
      this.data.name,
    );
  }

  private buildDiffData(): {
    path: string;
    oldContent: string;
    newContent: string;
    isIncomplete?: boolean;
  } | null {
    const result = this.data.result;
    if (!result) return null;

    const name = this.data.name;
    const path = String(this.data.args.path ?? "");

    if (!path) return null;

    if (name === "StrReplace") {
      // For StrReplace, reconstruct the before/after content:
      // - Read the current file (after state)
      // - Reconstruct the old content by reversing the replacement
      // This gives a proper diff showing what actually changed.
      const oldStr = String(this.data.args.old ?? "");
      const newStr = String(this.data.args.new ?? "");
      const replaceAll = Boolean(this.data.args.replaceAll);

      let currentContent = "";
      try {
        if (existsSync(path)) {
          currentContent = readFileSync(path, "utf-8");
        }
      } catch {
        // If we can't read the file, fall through to use the result output
      }

      if (currentContent && oldStr && newStr) {
        // Reconstruct the "before" content by reversing the replacement.
        // For replaceAll=true, every occurrence of newStr gets reverted back to oldStr.
        // For single replace, only the first occurrence gets reverted.
        let reconstructedOld: string;
        if (replaceAll) {
          // Global replace: revert every occurrence
          // Use split+join to avoid regex escaping issues
          reconstructedOld = currentContent.split(newStr).join(oldStr);
        } else {
          // Single replace: only revert the first occurrence
          const idx = currentContent.indexOf(newStr);
          if (idx !== -1) {
            reconstructedOld =
              currentContent.slice(0, idx) +
              oldStr +
              currentContent.slice(idx + newStr.length);
          } else {
            // newStr not found — file may have been further modified
            reconstructedOld = currentContent;
          }
        }

        return {
          path,
          oldContent: reconstructedOld,
          newContent: currentContent,
          isIncomplete: result.synthetic,
        };
      }

      // Fallback: if we can't read the file, show old→new as inline text diff
      if (oldStr && newStr) {
        // Use a small template to show exactly what was swapped
        const snippet = `${oldStr}\n  ↓\n${newStr}`;
        return {
          path,
          oldContent: oldStr,
          newContent: snippet,
          isIncomplete: result.synthetic,
        };
      }
    }

    // For Write / Edit / apply_diff: use args.content as new content
    const newContent = String(this.data.args.content ?? result.output);
    const oldContent =
      result.synthetic ? "" : (this.data.args.old_content as string) ?? "";

    return {
      path,
      oldContent,
      newContent,
      isIncomplete: result.synthetic,
    };
  }

  private getToolColor(): string {
    const name = this.data.name;
    switch (name) {
      case "Read":
      case "read":
        return this.colors.info;
      case "Write":
      case "write":
        return this.colors.diffAddedStrong;
      case "StrReplace":
      case "str_replace":
      case "Edit":
      case "edit":
        return this.colors.warning;
      case "Glob":
      case "glob":
        return this.colors.info;
      case "Grep":
      case "grep":
        return this.colors.info;
      case "Bash":
      case "bash":
      case "Shell":
      case "shell":
        return this.colors.secondary;
      case "Agent":
      case "agent":
      case "subagent":
        return this.colors.accent;
      case "WebSearch":
      case "web_search":
        return this.colors.info;
      case "WebFetch":
      case "web_fetch":
        return this.colors.info;
      case "TaskList":
      case "task_list":
        return this.colors.textDim;
      case "TaskOutput":
        return this.colors.textDim;
      case "TaskStop":
        return this.colors.error;
      default:
        return this.colors.secondary;
    }
  }

  private formatArgsInline(): string {
    const args = this.data.args;
    const parts: string[] = [];

    if (args.path) {
      parts.push(String(args.path));
    }
    if (args.command) {
      const cmd = String(args.command);
      parts.push(truncateToWidth(cmd, 50, "…"));
    }
    if (args.pattern) {
      parts.push(`glob: ${String(args.pattern)}`);
    }
    if (args.query) {
      parts.push(`search: ${String(args.query)}`);
    }
    if (args.url) {
      parts.push(String(args.url));
    }
    if (args.description) {
      parts.push(String(args.description));
    }
    if (args.content && typeof args.content === "string") {
      const lineCount = args.content.split("\n").length;
      parts.push(`${lineCount} lines`);
    }

    return parts.join("  ");
  }
}