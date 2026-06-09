/**
 * Theme — Color palette and styling for the Qode TUI.
 *
 * Refactored to use the new palette system and pi-tui's Markdown component
 * for proper markdown rendering. The createMarkdownTheme function is
 * re-exported for backward compatibility but internally uses the new
 * palette field names (mapping old -> new as needed).
 */

import chalk from "chalk";
import type { ColorPalette } from "./types.js";

export type { ColorPalette };

/**
 * Create a chalk-based color function from a hex string.
 */
export function hex(color: string): (s: string) => string {
  return (s: string) => chalk.hex(color)(s);
}

/**
 * Apply a color to text using the palette.
 */
export function colorize(text: string, color: string): string {
  return chalk.hex(color)(text);
}

/**
 * Dim text styling.
 */
export function dim(text: string): string {
  return chalk.dim(text);
}

/**
 * Bold text styling.
 */
export function bold(text: string): string {
  return chalk.bold(text);
}

/**
 * Create a markdown theme from a color palette.
 *
 * Uses the enhanced palette fields, falling back to legacy fields
 * for backward compatibility.
 */
export function createMarkdownTheme(colors: ColorPalette) {
  const primary = hex(colors.primary);
  const text = hex(colors.text);
  const textDim = hex(colors.textDim);
  const textBright = hex(colors.textBright);
  const success = hex(colors.success);
  const warning = hex(colors.warning);
  const error = hex(colors.error);
  const info = hex(colors.info);
  const accent = hex(colors.accent);
  const codeHighlight = colors.codeHighlight ?? colors.surface;
  const codeText = colors.codeText ?? colors.text;

  return {
    heading: (s: string) => bold(primary(s)),
    link: (s: string) => info(s),
    linkUrl: (s: string) => dim(s),
    code: (s: string) => chalk.bgHex(codeHighlight)(accent(s)),
    codeBlock: (s: string) => chalk.bgHex(colors.surface)(text(s)),
    codeBlockBorder: (s: string) => dim(s),
    quote: (s: string) => dim(s),
    quoteBorder: (s: string) => dim(s),
    hr: (s: string) => dim(s),
    listBullet: (s: string) => primary(s),
    bold: (s: string) => bold(textBright(s)),
    italic: (s: string) => chalk.italic(text(s)),
    strikethrough: (s: string) => chalk.strikethrough(text(s)),
    underline: (s: string) => chalk.underline(text(s)),
    highlightCode: (code: string, lang?: string) => {
      const lines = code.split("\n");
      return lines.map((line) =>
        chalk.bgHex(codeHighlight)(hex(codeText)(line)),
      );
    },
    codeBlockIndent: "  ",
  };
}

/**
 * Create a default text style from a color palette.
 */
export function createDefaultTextStyle(colors: ColorPalette) {
  return {
    color: (s: string) => chalk.hex(colors.text)(s),
  };
}