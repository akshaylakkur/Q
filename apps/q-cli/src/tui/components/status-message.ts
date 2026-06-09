/**
 * Status Message Component — Renders status, notice, and error messages.
 *
 * Clear visual separation with:
 * - Icon prefix based on message type (info ℹ, success ✓, warning ⚠, error ✗)
 * - Appropriate color for each type
 * - Proper spacing
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette } from "../types.js";

export type StatusType = "info" | "success" | "warning" | "error" | "plain";

export class StatusMessageComponent implements Component {
  private content: string;
  private colors: ColorPalette;
  private type: StatusType;
  private detail?: string;

  constructor(
    content: string,
    colors: ColorPalette,
    type?: StatusType,
    detail?: string,
  ) {
    this.content = content;
    this.colors = colors;
    this.type = type ?? "info";
    this.detail = detail;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(10, width - 4);
    const indent = "  ";

    const { icon, color } = this.getStyle();
    const styled = chalk.hex(color);

    lines.push("");
    if (this.type === "plain") {
      lines.push(truncateToWidth(`${indent}${styled(this.content)}`, width, "…"));
    } else {
      lines.push(truncateToWidth(`${indent}${icon} ${styled(this.content)}`, width, "…"));
    }

    if (this.detail) {
      const wrapped = this.wrapText(this.detail, innerWidth);
      for (const wLine of wrapped) {
        const styledLine = chalk.hex(this.colors.textDim)(wLine);
        lines.push(truncateToWidth(styledLine, width, "…"));
      }
    }

    lines.push("");
    return lines;
  }

  private getStyle(): { icon: string; color: string } {
    switch (this.type) {
      case "success":
        return { icon: "✓", color: this.colors.statusSuccess };
      case "warning":
        return { icon: "⚠", color: this.colors.statusWarning };
      case "error":
        return { icon: "✗", color: this.colors.statusError };
      case "plain":
        return { icon: "", color: this.colors.textDim };
      case "info":
      default:
        return { icon: "ℹ", color: this.colors.statusInfo };
    }
  }

  private wrapText(text: string, maxWidth: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = "    ";
    const prefixWidth = visibleWidth("    ");

    for (const word of words) {
      let displayWord = word;
      if (visibleWidth(word) > maxWidth - prefixWidth) {
        displayWord = truncateToWidth(
          word,
          maxWidth - prefixWidth - 1,
          "…",
        );
      }

      const testLine = currentLine + displayWord + " ";
      if (
        visibleWidth(testLine) > maxWidth &&
        currentLine !== "    "
      ) {
        lines.push(currentLine);
        currentLine = "    " + displayWord + " ";
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine.trim()) {
      lines.push(currentLine);
    }

    return lines;
  }
}