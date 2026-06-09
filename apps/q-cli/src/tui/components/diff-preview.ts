/**
 * Diff Preview Component — Renders file changes with rich diff visualization.
 *
 * Uses the `diff` package for proper line-by-line diffs.
 * Shows:
 * - Header with file path and change summary (+N / -M)
 * - Color-coded diff lines (green additions, red deletions)
 * - Line numbers in gutter
 * - THE FULL DIFF is always shown regardless of size.
 *   No windowing, no truncation — the complete diff is rendered
 *   so users can see every changed line in context.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { diffLines } from "diff";
import type { ColorPalette } from "../types.js";

export interface DiffData {
  /** The file path that was changed */
  path: string;
  /** The old content (before the change) */
  oldContent: string;
  /** The new content (after the change) */
  newContent: string;
  /** Whether the diff is still streaming (incomplete) */
  isIncomplete?: boolean;
}

interface RenderedDiffLine {
  kind: "add" | "delete" | "context";
  oldLineNum: number;
  newLineNum: number;
  text: string;
}

export class DiffPreviewComponent implements Component {
  private data: DiffData;
  private colors: ColorPalette;

  constructor(data: DiffData, colors: ColorPalette) {
    this.data = data;
    this.colors = colors;
  }

  setData(data: DiffData): void {
    this.data = data;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(20, width - 6);
    const indent = "    ";

    const diffLines_ = this.computeDiff();
    if (diffLines_.length === 0) {
      lines.push("");
      lines.push(
        truncateToWidth(`${indent}${chalk.hex(this.colors.textDim)("No changes detected")}`, width, "…"),
      );
      lines.push("");
      return lines;
    }

    const added = diffLines_.filter((l) => l.kind === "add").length;
    const removed = diffLines_.filter((l) => l.kind === "delete").length;
    const totalLines = diffLines_.length;

    // Header — show change summary and file path
    const headerParts: string[] = [];
    if (added > 0) {
      headerParts.push(chalk.bold.hex(this.colors.diffAddedStrong)(`+${added}`));
    }
    if (removed > 0) {
      headerParts.push(chalk.bold.hex(this.colors.diffRemovedStrong)(`-${removed}`));
    }
    headerParts.push(chalk.hex(this.colors.textDim)(this.data.path));

    lines.push(truncateToWidth(`${indent}${headerParts.join(" ")}`, width, "…"));

    // Separator line
    lines.push(
      truncateToWidth(
        `${indent}${chalk.hex(this.colors.border)("─".repeat(Math.min(innerWidth - 4, 50)))}`,
        width,
        "…",
      ),
    );

    // ── ALWAYS show the full diff ────────────────────────────────────
    // No windowing, no max-lines truncation. The complete diff is rendered
    // so users see every change in full context, regardless of size.
    const shownLines = diffLines_;

    // Line number gutter width — compute from the full set
    const maxLineNum = diffLines_.reduce(
      (max, dl) => Math.max(max, dl.oldLineNum || dl.newLineNum || 0),
      0,
    );
    const gutterWidth = Math.max(String(maxLineNum).length, 2);

    // Render diff lines
    for (const dl of shownLines) {
      const gutter = this.renderGutter(dl, gutterWidth);
      const maxContentWidth = Math.max(1, width - visibleWidth(indent) - visibleWidth(gutter) - 1);
      const content = this.renderContent(dl, maxContentWidth);
      const fullLine = `${indent}${gutter} ${content}`;
      // Truncate at line level to ensure it fits terminal width
      if (visibleWidth(fullLine) > width) {
        lines.push(truncateToWidth(fullLine, width, "…"));
      } else {
        lines.push(fullLine);
      }
    }

    lines.push(
      truncateToWidth(
        `${indent}${chalk.hex(this.colors.textDim)(`${totalLines} lines in diff`)}`,
        width,
        "…",
      ),
    );

    return lines;
  }

  private renderGutter(line: RenderedDiffLine, width: number): string {
    const oldStr =
      line.kind === "delete" || line.kind === "context"
        ? String(line.oldLineNum || "")
        : "";
    const newStr =
      line.kind === "add" || line.kind === "context"
        ? String(line.newLineNum || "")
        : "";

    const gutterColor = chalk.hex(this.colors.diffGutter);
    const oldPadded = (oldStr || "").padStart(Math.max(1, width));
    const newPadded = (newStr || "").padStart(Math.max(1, width));
    return gutterColor(`${oldPadded} ${newPadded}`);
  }

  private renderContent(line: RenderedDiffLine, maxWidth: number): string {
    const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
    let styled: string;

    switch (line.kind) {
      case "add":
        styled = chalk.hex(this.colors.diffAdded)(`${marker} ${line.text}`);
        break;
      case "delete":
        styled = chalk.hex(this.colors.diffRemoved)(`${marker} ${line.text}`);
        break;
      default:
        styled = chalk.hex(this.colors.textDim)(` ${line.text}`);
    }

    // For very long lines, add a visual overflow indicator
    if (visibleWidth(line.text) > maxWidth - 2) {
      return truncateToWidth(styled, maxWidth, "…");
    }
    return styled;
  }

  private computeDiff(): RenderedDiffLine[] {
    const oldLines = this.data.oldContent || "";
    const newLines = this.data.newContent || "";

    // Use the `diff` package for proper LCS-based line diff
    const changes = diffLines(oldLines, newLines);

    const result: RenderedDiffLine[] = [];
    let oldLineNum = 1;
    let newLineNum = 1;

    for (const change of changes) {
      const lines = change.value.split("\n");
      // The last item from split("\n") is always an empty string
      for (let i = 0; i < lines.length - 1; i++) {
        const text = lines[i] || "";
        if (change.added) {
          result.push({
            kind: "add",
            oldLineNum: oldLineNum - 1,
            newLineNum,
            text,
          });
          newLineNum++;
        } else if (change.removed) {
          result.push({
            kind: "delete",
            oldLineNum,
            newLineNum: newLineNum - 1,
            text,
          });
          oldLineNum++;
        } else {
          result.push({
            kind: "context",
            oldLineNum,
            newLineNum,
            text,
          });
          oldLineNum++;
          newLineNum++;
        }
      }
    }

    // If incomplete (streaming), suppress trailing deletions
    if (this.data.isIncomplete && result.length > 0) {
      let lastNonDelete = result.length - 1;
      while (lastNonDelete >= 0) {
        const dl = result[lastNonDelete];
        if (dl && dl.kind === "delete") {
          lastNonDelete--;
        } else {
          break;
        }
      }
      if (lastNonDelete >= 0) {
        result.length = lastNonDelete + 1;
      } else {
        result.length = 0;
      }
    }

    return result;
  }
}