/**
 * Step 2 — Provider selection with clean, minimal UI.
 *
 * User picks a provider from a curated list. Each entry shows
 * name, a short description, and feature badges.
 */

import chalk from "chalk";
import type { OnboardingState, StepResult, StepValidation, WizardStep } from "../types.js";
import { PROVIDERS } from "../types.js";

export class SelectProviderStep implements WizardStep {
  id = "select-provider";
  title = "Select Provider";

  private selectedIndex = 0;

  reset(): void {
    this.selectedIndex = 0;
  }

  render(_state: OnboardingState): string {
    const lines: string[] = [];
    lines.push("");
    lines.push(chalk.bold("  Choose your AI provider"));
    lines.push("");
    lines.push(chalk.hex("#6366f1")("  ── Step 2/4 — Select Provider ──"));
    lines.push("");

    PROVIDERS.forEach((p, i) => {
      const selected = i === this.selectedIndex;
      const prefix = selected ? chalk.hex("#6366f1")("◆ ") : "  ";
      const name = selected
        ? chalk.bold.hex("#6366f1")(p.name)
        : chalk.bold(p.name);
      const desc = chalk.dim(p.description);
      const badges = chalk.dim(p.badges);

      lines.push(`${prefix}${name}`);
      lines.push(`   ${desc}`);
      if (badges) lines.push(`   ${badges}`);
      lines.push("");
    });

    lines.push(chalk.dim("  ↑/↓ navigate  ·  Enter select  ·  Esc back"));
    return lines.join("\n");
  }

  handleInput(key: string, state: OnboardingState): StepResult {
    if (key === "[A") {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
      }
      return "stay";
    }
    if (key === "[B") {
      if (this.selectedIndex < PROVIDERS.length - 1) {
        this.selectedIndex++;
      }
      return "stay";
    }
    if (key === "\r" || key === "\n") {
      const selected = this.getSelectedProvider();
      if (selected) {
        state.provider = { type: selected.type, name: selected.name };
      }
      return "next";
    }
    if (key === "" || key === "\x7f") {
      return "prev";
    }
    return "stay";
  }

  validate(state: OnboardingState): StepValidation {
    if (!state.provider) {
      return { valid: false, error: "No provider selected" };
    }
    return { valid: true };
  }

  /** Get the currently selected provider entry */
  getSelectedProvider(): (typeof PROVIDERS)[number] | null {
    return PROVIDERS[this.selectedIndex] ?? null;
  }

  /** Public accessor for wizard to extract selection */
  getSelectedIndex(): number {
    return this.selectedIndex;
  }
}