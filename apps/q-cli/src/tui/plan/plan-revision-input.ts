/**
 * Plan Revision Input Component — Text input for capturing revision instructions
 * in the plan mode confirmation flow.
 *
 * Mounted as a dialog after "Needs revision" is selected from the dropdown.
 *
 * Keyboard:
 *   Enter — submit the revision text
 *   Esc — cancel (returns to the confirmation dropdown)
 */

import {
  Container,
  matchesKey,
  Key,
  parseKey,
  truncateToWidth,
  type Focusable,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette } from "../types.js";

export class PlanRevisionInputComponent extends Container implements Focusable {
  focused = false;
  private colors: ColorPalette;
  private value: string = "";
  private cursor: number = 0;
  private onSubmit: ((text: string) => void) | null = null;
  private onCancel: (() => void) | null = null;

  constructor(colors: ColorPalette) {
    super();
    this.colors = colors;
  }

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }

  setOnSubmit(handler: (text: string) => void): void {
    this.onSubmit = handler;
  }

  setOnCancel(handler: () => void): void {
    this.onCancel = handler;
  }

  handleInput(data: string): void {
    const key = parseKey(data);

    switch (key) {
      case Key.enter:
      case Key.return: {
        if (this.value.trim().length > 0 && this.onSubmit) {
          this.onSubmit(this.value.trim());
        }
        break;
      }
      case Key.esc:
      case Key.escape: {
        if (this.onCancel) {
          this.onCancel();
        }
        break;
      }
      case Key.backspace: {
        if (this.cursor > 0) {
          this.value =
            this.value.slice(0, this.cursor - 1) +
            this.value.slice(this.cursor);
          this.cursor--;
        }
        break;
      }
      case Key.delete: {
        if (this.cursor < this.value.length) {
          this.value =
            this.value.slice(0, this.cursor) +
            this.value.slice(this.cursor + 1);
        }
        break;
      }
      case Key.left: {
        if (this.cursor > 0) this.cursor--;
        break;
      }
      case Key.right: {
        if (this.cursor < this.value.length) this.cursor++;
        break;
      }
      case Key.home: {
        this.cursor = 0;
        break;
      }
      case Key.end: {
        this.cursor = this.value.length;
        break;
      }
      default: {
        // Insert printable characters (single chars with valid codes)
        if (key && key.length === 1 && key.charCodeAt(0) >= 32) {
          this.value =
            this.value.slice(0, this.cursor) +
            key +
            this.value.slice(this.cursor);
          this.cursor++;
        }
        break;
      }
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(20, width - 6);
    const indent = "  ";

    lines.push("");

    // ── Box top ───────────────────────────────────────────────────────
    const topBorder = chalk.hex(this.colors.info)("┌─ Plan Revision ──────────────────────────────────┐");
    lines.push(truncateToWidth(topBorder, width, "…"));

    const prompt = chalk.hex(this.colors.text)("  Describe what needs to change in the plan:");
    lines.push(truncateToWidth(prompt, width, "…"));

    lines.push(indent);

    // ── Input field ───────────────────────────────────────────────────
    const inputField = chalk.hex(this.colors.primary)("> ");
    const displayText = this.value;

    // Cursor marker
    const beforeCursor = displayText.slice(0, this.cursor);
    const afterCursor = displayText.slice(this.cursor);
    const cursorChar = this.focused ? "█" : " ";

    const renderedInput = `${inputField}${beforeCursor}${cursorChar}${afterCursor}`;
    lines.push(truncateToWidth(renderedInput, width, "…"));

    lines.push(indent);

    // ── Hints ─────────────────────────────────────────────────────────
    const hint = chalk.hex(this.colors.textDim)(
      "  [Enter submit] [Esc cancel] [left/right navigate]",
    );
    lines.push(truncateToWidth(hint, width, "…"));

    const bottomBorder = chalk.hex(this.colors.info)("└───────────────────────────────────────────────────┘");
    lines.push(truncateToWidth(bottomBorder, width, "…"));

    lines.push("");
    return lines;
  }
}
