/**
 * Thinking Section Component — A collapsible container for thinking content
 * and tool calls produced during a turn.
 *
 * During streaming: expanded, showing all thinking + tool call work.
 * After turn completes: collapsed, showing just a summary header.
 * Ctrl+I expands to show all details, Ctrl+O toggles visibility entirely.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette } from "../types.js";

/**
 * Possible visibility states for the thinking section
 */
export type ThinkingSectionState = "expanded" | "collapsed" | "hidden";

export class ThinkingSectionComponent implements Component {
  private children: Component[] = [];
  private colors: ColorPalette;
  private state: ThinkingSectionState = "expanded";
  /** Count of tool calls inside this section */
  private toolCallCount: number = 0;
  /** Whether thinking text was produced */
  private hadThinking: boolean = false;

  constructor(colors: ColorPalette) {
    this.colors = colors;
  }

  addChild(component: Component): void {
    this.children.push(component);
  }

  removeChild(component: Component): void {
    const idx = this.children.indexOf(component);
    if (idx !== -1) this.children.splice(idx, 1);
  }

  clear(): void {
    this.children = [];
    this.toolCallCount = 0;
    this.hadThinking = false;
  }

  setToolCallCount(n: number): void {
    this.toolCallCount = n;
  }

  setHadThinking(v: boolean): void {
    this.hadThinking = v;
  }

  /** Collapse: only show a summary header line */
  collapse(): void {
    this.state = "collapsed";
  }

  /** Expand: show all children */
  expand(): void {
    this.state = "expanded";
  }

  /** Toggle expanded/collapsed */
  toggleExpanded(): void {
    this.state =
      this.state === "expanded" ? "collapsed" : "expanded";
  }

  /** Toggle visibility on/off */
  toggleVisibility(): void {
    this.state =
      this.state === "hidden" ? "expanded" : "hidden";
  }

  /** Show the section (make visible) */
  show(): void {
    if (this.state === "hidden") {
      this.state = "expanded";
    }
  }

  isExpanded(): boolean {
    return this.state === "expanded";
  }

  isVisible(): boolean {
    return this.state !== "hidden";
  }

  getContentHeight(): number {
    return this.children.length;
  }

  invalidate(): void {
    for (const child of this.children) {
      child.invalidate?.();
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const indent = "  ";

    if (this.state === "hidden") {
      // Nothing at all — section is completely hidden
      return lines;
    }

    if (this.state === "collapsed") {
      // Show just a summary line
      const parts: string[] = [];
      if (this.hadThinking) parts.push("thinking");
      if (this.toolCallCount > 0) {
        parts.push(
          `${this.toolCallCount} tool call${this.toolCallCount > 1 ? "s" : ""}`,
        );
      }
      const summary =
        parts.length > 0
          ? `• ${parts.join(", ")}`
          : "• work";
      lines.push("");
      lines.push(
        truncateToWidth(
          `${indent}${chalk.hex(this.colors.textDim)(
            `[${summary}]  ${chalk.italic("Ctrl+I to inspect")}`,
          )}`,
          width,
          "…",
        ),
      );
      lines.push("");
      return lines;
    }

    // Expanded — render all children
    for (const child of this.children) {
      const childLines = child.render(width);
      lines.push(...childLines);
    }

    return lines;
  }
}