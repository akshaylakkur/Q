/**
 * Assistant Message Component — Renders the assistant's response with proper markdown.
 *
 * Uses pi-tui's built-in Markdown component for full markdown support:
 * - Headings, lists, code blocks, tables, links, bold, italic, etc.
 * - Proper syntax highlighting for code blocks
 * - Streaming append support with smooth updates
 *
 * Styles:
 * - Assistant messages get a "Qode Agent" label and purple accent color.
 * - Thinking blocks get a "💭 Thinking" label and amber accent.
 * - A blank line always separates messages for clear visual separation.
 */

import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import { Container, Markdown, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette } from "../types.js";

export type AssistantKind = "assistant" | "thinking";

/** Indent for assistant message content (aligns after the label) */
const MESSAGE_INDENT = "  ";

export class AssistantMessageComponent implements Component {
  private contentContainer: Container;
  private markdownTheme: MarkdownTheme;
  private colors: ColorPalette;
  private kind: AssistantKind;
  private customLabel: string | null;
  private isStreaming: boolean = false;
  private fullText: string = "";
  private contentWidth: number = 0;

  constructor(colors: ColorPalette, options?: { kind?: AssistantKind; label?: string }) {
    this.colors = colors;
    this.kind = options?.kind ?? "assistant";
    this.customLabel = options?.label ?? null;
    this.markdownTheme = this.createMarkdownTheme();
    this.contentContainer = new Container();
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
      highlightCode: (code: string, lang?: string) => {
        const lines = code.split("\n");
        return lines.map((line) =>
          chalk.bgHex(c.codeHighlight)(chalk.hex(c.codeText)(line)),
        );
      },
      codeBlockIndent: "  ",
    };
  }

  getContent(): string {
    return this.fullText;
  }

  setContent(content: string): void {
    this.fullText = content;
    this.contentContainer.clear();
    if (content.trim().length > 0) {
      this.contentContainer.addChild(
        new Markdown(content.trim(), 0, 0, this.markdownTheme),
      );
    }
  }

  appendContent(delta: string): void {
    this.fullText += delta;
    this.contentContainer.clear();
    if (this.fullText.trim().length > 0) {
      // Use consistent spacing for streaming display
      const displayText = this.fullText.trim();
      this.contentContainer.addChild(
        new Markdown(displayText, 0, 0, this.markdownTheme),
      );
    }
  }

  setStreaming(streaming: boolean): void {
    this.isStreaming = streaming;
  }

  invalidate(): void {
    this.contentContainer.invalidate?.();
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Only show if there's content or we're streaming (waiting for content)
    if (!this.fullText.trim() && !this.isStreaming) {
      return lines;
    }

    const indent = MESSAGE_INDENT;
    // Use visibleWidth for the indent to account for any ANSI codes
    const indentWidth = visibleWidth(indent);
    this.contentWidth = Math.max(1, width - indentWidth);

    // Role label — truncate to fit width
    const label = this.renderLabel();
    const truncatedLabel = truncateToWidth(label, width, "…");
    lines.push("");
    lines.push(truncatedLabel);

    if (!this.fullText.trim()) {
      // Still streaming but no content yet — show subtle indicator
      if (this.isStreaming) {
        const workingLine = indent + chalk.hex(this.colors.textDim).italic("working...");
        lines.push(truncateToWidth(workingLine, width, "…"));
      }
      lines.push("");
      return lines;
    }

    // Render the markdown content with indent, truncating each line to fit
    const contentLines = this.contentContainer.render(this.contentWidth);
    for (const cl of contentLines) {
      const fullLine = indent + cl;
      // Even though contentLines should fit contentWidth, ANSI codes or
      // edge cases can cause overflow — truncate to be safe
      if (visibleWidth(fullLine) > width) {
        lines.push(truncateToWidth(fullLine, width, "…"));
      } else {
        lines.push(fullLine);
      }
    }

    // Streaming indicator (blinking/moving dot)
    if (this.isStreaming) {
      const indicatorLine = indent + chalk.hex(this.colors.primary)("●");
      lines.push(truncateToWidth(indicatorLine, width, "…"));
    }

    lines.push("");
    return lines;
  }

  private renderLabel(): string {
    if (this.kind === "thinking") {
      return (
        chalk.hex(this.colors.warning)("💭 Thinking") +
        (this.isStreaming
          ? " " + chalk.hex(this.colors.primary)("●")
          : "")
      );
    }
    // Use custom label if set (e.g. "step-001"), otherwise default to "Qode Agent"
    const labelText = this.customLabel ?? "Qode Agent";
    const label = chalk.bold.hex(this.colors.roleAssistant)(labelText);
    if (this.isStreaming && this.fullText.trim().length > 0) {
      return label + " " + chalk.hex(this.colors.primary)("●");
    }
    return label;
  }
}