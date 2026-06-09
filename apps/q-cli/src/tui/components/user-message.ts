/**
 * User Message Component — Renders a user's input message in the transcript.
 *
 * Styled with a clear "You" label, cyan accent, and proper text wrapping.
 * A blank line separates messages for visual clarity.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette } from "../types.js";

export class UserMessageComponent implements Component {
  private content: string;
  private colors: ColorPalette;

  constructor(content: string, colors: ColorPalette) {
    this.content = content;
    this.colors = colors;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(10, width - 4);

    // User label — bright cyan, bold — truncate to fit
    const label = chalk.bold.hex(this.colors.roleUser)("You");
    lines.push("");
    lines.push(truncateToWidth(label, width, "…"));

    // Content with word wrapping
    const words = this.content.split(/\s+/);
    let currentLine = "  ";
    const prefixWidth = visibleWidth("  ");

    for (const word of words) {
      let displayWord = word;
      if (visibleWidth(word) > innerWidth - prefixWidth) {
        displayWord = truncateToWidth(
          word,
          innerWidth - prefixWidth - 1,
          "…",
        );
      }

      const testLine = currentLine + displayWord + " ";
      if (
        visibleWidth(testLine) > innerWidth &&
        currentLine !== "  "
      ) {
        // Truncate the completed line to fit width
        const renderedLine = chalk.hex(this.colors.text)(currentLine);
        lines.push(truncateToWidth(renderedLine, width, "…"));
        currentLine = "  " + displayWord + " ";
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine.trim()) {
      const renderedLine = chalk.hex(this.colors.text)(currentLine);
      const finalLine = truncateToWidth(renderedLine, width, "…");
      lines.push(finalLine);
    }

    lines.push("");
    return lines;
  }
}