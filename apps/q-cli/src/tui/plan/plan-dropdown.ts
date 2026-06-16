/**
 * Plan Dropdown Component — Presents "Looks good! / Needs revision / Redo / Exit"
 * options to the user after plan generation in plan mode.
 *
 * Mounted as a dialog (replaces editor), uses Focusable for keyboard input.
 *
 * Keyboard navigation:
 *   Up/Down arrows — navigate options
 *   Enter — select highlighted option
 *   Esc — cancel (same as Exit)
 *   If "Needs revision" is selected, transitions to a text input prompt
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
import type { PlanChoice } from "./plan-mode.js";

export interface PlanDropdownOption {
  value: PlanChoice;
  label: string;
  icon: string;
  description: string;
}

const OPTIONS: PlanDropdownOption[] = [
  { value: "looks-good", label: "Looks good!", icon: "✓", description: "Proceed with the plan as-is" },
  { value: "needs-revision", label: "Needs revision", icon: "✏", description: "Provide revision instructions and regenerate" },
  { value: "redo", label: "Redo", icon: "↻", description: "Regenerate the plan from scratch" },
  { value: "exit", label: "Exit", icon: "✕", description: "Exit plan mode and execute directly" },
];

export class PlanDropdownComponent extends Container implements Focusable {
  focused = false;
  private colors: ColorPalette;
  private selectedIndex: number = 0;
  private planFilePath: string = "";
  private onChoice: ((choice: PlanChoice) => void) | null = null;
  private onCancel: (() => void) | null = null;

  constructor(colors: ColorPalette) {
    super();
    this.colors = colors;
  }

  setPlanFilePath(path: string): void {
    this.planFilePath = path;
  }

  setOnChoice(handler: (choice: PlanChoice) => void): void {
    this.onChoice = handler;
  }

  setOnCancel(handler: () => void): void {
    this.onCancel = handler;
  }

  handleInput(data: string): void {
    const key = parseKey(data);

    switch (key) {
      case Key.up:
      case "k": {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        break;
      }
      case Key.down:
      case "j": {
        this.selectedIndex = Math.min(OPTIONS.length - 1, this.selectedIndex + 1);
        break;
      }
      case Key.enter:
      case Key.return: {
        const selected = OPTIONS[this.selectedIndex];
        if (selected && this.onChoice) {
          this.onChoice(selected.value);
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
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const indent = "  ";

    lines.push("");

    // ── Header box ────────────────────────────────────────────────────
    const topBorder = chalk.hex(this.colors.success)("┌─ Plan Review ───────────────────────────────────┐");
    lines.push(truncateToWidth(topBorder, width, "…"));

    const planInfo = chalk.hex(this.colors.text)("  Plan generated successfully");
    lines.push(truncateToWidth(indent + planInfo, width, "…"));

    if (this.planFilePath) {
      const pathInfo = chalk.hex(this.colors.textDim).italic(`  Saved: ${this.planFilePath}`);
      lines.push(truncateToWidth(indent + pathInfo, width, "…"));
    }

    lines.push(indent);

    // ── Options ───────────────────────────────────────────────────────
    lines.push(truncateToWidth(indent + chalk.hex(this.colors.text)("Select an option:"), width, "…"));
    lines.push(indent);

    for (let i = 0; i < OPTIONS.length; i++) {
      const opt = OPTIONS[i]!;
      const isSelected = i === this.selectedIndex;

      const prefix = isSelected ? chalk.hex(this.colors.primary).bold("▸") : " ";
      const icon = chalk.hex(this.colors.success)(opt.icon);
      const label = isSelected
        ? chalk.bold.hex(this.colors.primary)(opt.label)
        : chalk.hex(this.colors.text)(opt.label);
      const desc = isSelected
        ? " " + chalk.hex(this.colors.textDim).italic(opt.description)
        : "";

      lines.push(truncateToWidth(`  ${prefix} ${icon} ${label}${desc}`, width, "…"));
    }

    lines.push(indent);

    // ── Navigation hints ──────────────────────────────────────────────
    const hint = chalk.hex(this.colors.textDim)("  [up/down navigate] [Enter select] [Esc cancel]");
    lines.push(truncateToWidth(hint, width, "…"));

    const bottomBorder = chalk.hex(this.colors.success)("└───────────────────────────────────────────────────┘");
    lines.push(truncateToWidth(bottomBorder, width, "…"));

    lines.push("");
    return lines;
  }
}
