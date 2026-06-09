/**
 * Diff Preview Component — Renders file changes with rich diff visualization.
 *
 * Uses the `diff` package for proper line-by-line diffs.
 * Shows:
 * - Header with file path and change summary (+N / -M)
 * - Color-coded diff lines (green additions, red deletions)
 * - Line numbers in gutter
 * - The changed snippet (additions/deletions) with ~10 lines of unmodified
 *   context buffer above and below each change region.
 * - Omitted sections between non-adjacent change regions marked with "...".
 * - The full changed snippet is always shown — no truncation of changes.
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
  /**
   * Number of unmodified context lines to show as buffer
   * above and below each change region.
   */
  private contextBufferLines: number = 10;
  /**
   * Line used as a separator marker when content is omitted.
   */
  private omitMarker: string = "~";

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

    // ── Window around change regions with context buffer ────────────
    // Find all change regions (contiguous blocks of add/delete lines),
    // and for each one show the change lines plus contextBufferLines
    // of unmodified context above and below. Omitted sections with
    // only context lines are replaced by "...".
    const shownLines = this.windowAroundChanges(diffLines_);

    // Line number gutter width — compute from the full set for consistency
    const maxLineNum = diffLines_.reduce(
      (max, dl) => Math.max(max, dl.oldLineNum || dl.newLineNum || 0),
      0,
    );
    const gutterWidth = Math.max(String(maxLineNum).length, 2);

    // Render diff lines
    for (const dl of shownLines) {
      // Handle omit markers
      if (dl.kind === "context" && dl.text === this.omitMarker) {
        const omitLine = `${indent}${chalk.hex(this.colors.textDim)(this.omitMarker.repeat(Math.min(gutterWidth * 2 + 6, innerWidth - 4)))}`;
        lines.push(truncateToWidth(omitLine, width, "…"));
        continue;
      }

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

    return lines;
  }

  /**
   * Windows the diff lines around the actual change regions (additions/deletions).
   *
   * Instead of showing the entire file diff or the first N lines,
   * this method:
   * 1. Identifies all contiguous change regions (groups of add/delete lines).
   * 2. For each region, includes a buffer of unmodified context lines
   *    before and after so the user can see where the change happens
   *    relative to the surrounding code.
   * 3. Omits large runs of pure context lines with a "~" separator.
   * 4. Does NOT cap at any maximum — all change lines + buffer context
   *    are always shown in full.
   */
  private windowAroundChanges(allLines: RenderedDiffLine[]): RenderedDiffLine[] {
    // Find indices of all change (add/delete) lines
    const changeIndices: number[] = [];
    for (let idx = 0; idx < allLines.length; idx++) {
      const line = allLines[idx];
      if (line && line.kind !== "context") {
        changeIndices.push(idx);
      }
    }

    // No changes at all — just show first few context lines
    if (changeIndices.length === 0) {
      return allLines.slice(0, this.contextBufferLines);
    }

    // Build a list of "windows" — each window is a change region plus
    // surrounding context buffer. A change region is a contiguous block
    // of non-context lines.
    const windows: { start: number; end: number }[] = [];
    let regionStart: number = changeIndices[0] as number;

    for (let i = 1; i <= changeIndices.length; i++) {
      const currIdx = changeIndices[i];
      const prevIdx = changeIndices[i - 1] as number;

      if (currIdx !== undefined && currIdx - prevIdx === 1) {
        // Contiguous, keep extending the region
        continue;
      }

      // Region ended at prevIdx
      const regionEnd = prevIdx;

      // Add buffer context lines before and after
      const winStart = Math.max(0, regionStart - this.contextBufferLines);
      const winEnd = Math.min(allLines.length - 1, regionEnd + this.contextBufferLines);

      // Merge with previous window if they overlap or nearly touch
      if (windows.length > 0) {
        const lastWin = windows[windows.length - 1] as { start: number; end: number };
        if (winStart - lastWin.end <= this.contextBufferLines + 1) {
          // Merge windows
          lastWin.end = winEnd;
        } else {
          windows.push({ start: winStart, end: winEnd });
        }
      } else {
        windows.push({ start: winStart, end: winEnd });
      }

      // Start new region
      if (currIdx !== undefined) {
        regionStart = currIdx;
      }
    }

    // Assemble the final result from the windows, with omission markers
    // between non-adjacent windows
    const result: RenderedDiffLine[] = [];
    let previousEnd = -1;

    for (const win of windows) {
      // If there's a gap between the previous window and this one, add an omission marker
      if (previousEnd >= 0 && win.start > previousEnd + 1) {
        result.push({
          kind: "context",
          oldLineNum: 0,
          newLineNum: 0,
          text: this.omitMarker,
        });
      }

      // Add the window lines (change lines + context buffer)
      for (let i = win.start; i <= win.end; i++) {
        const line = allLines[i];
        if (line) {
          result.push(line);
        }
      }

      previousEnd = win.end;
    }

    // Add leading omission if the first window doesn't start at the beginning
    const firstWin = windows[0];
    if (firstWin && firstWin.start > 0) {
      result.unshift({
        kind: "context",
        oldLineNum: 0,
        newLineNum: 0,
        text: this.omitMarker,
      });
    }

    // Add trailing omission if the last window doesn't end at the end
    const lastWin = windows[windows.length - 1];
    if (lastWin && lastWin.end < allLines.length - 1) {
      result.push({
        kind: "context",
        oldLineNum: 0,
        newLineNum: 0,
        text: this.omitMarker,
      });
    }

    return result;
  }

  private renderGutter(line: RenderedDiffLine, width: number): string {
    if (line.text === this.omitMarker) {
      return chalk.hex(this.colors.diffGutter)(" ".repeat(width * 2 + 1));
    }

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
    if (line.text === this.omitMarker) {
      return "";
    }

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