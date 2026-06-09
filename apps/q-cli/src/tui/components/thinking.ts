/**
 * Thinking Component — Renders the agent's chain-of-thought content.
 *
 * Uses the AssistantMessageComponent with kind="thinking" for consistent
 * markdown rendering. Shows a "💭 Thinking" header with amber accent.
 * Content is rendered as markdown with proper formatting.
 */

import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette } from "../types.js";
import { AssistantMessageComponent } from "./assistant-message.js";

export class ThinkingComponent implements Component {
  private inner: AssistantMessageComponent;

  constructor(content: string, colors: ColorPalette) {
    this.inner = new AssistantMessageComponent(colors, { kind: "thinking" });
    if (content) {
      this.inner.setContent(content);
    }
  }

  setContent(content: string): void {
    this.inner.setContent(content);
  }

  appendContent(delta: string): void {
    this.inner.appendContent(delta);
  }

  setStreaming(streaming: boolean): void {
    this.inner.setStreaming(streaming);
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  render(width: number): string[] {
    return this.inner.render(width);
  }
}