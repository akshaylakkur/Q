/**
 * Step 4 — Confirmation screen showing all selections with
 *          an option to change anything before locking in.
 *
 * Displays a clean summary card with provider, model, and
 * validation status. Actions: Confirm, Change, Cancel.
 */

import chalk from "chalk";
import type { OnboardingState, StepResult, StepValidation, WizardStep } from "../types.js";

export class ConfirmationStep implements WizardStep {
  id = "confirmation";
  title = "Confirmation";

  private actionSelected: "confirm" | "change" | "cancel" = "confirm";

  reset(): void {
    this.actionSelected = "confirm";
  }

  render(state: OnboardingState): string {
    const lines: string[] = [];
    lines.push("");
    lines.push(chalk.bold("  Ready to go?"));
    lines.push("");
    lines.push(chalk.hex("#6366f1")("  ── Step 4/4 — Confirmation ──"));
    lines.push("");

    // ── Summary card ──
    const card = this.buildSummaryCard(state);
    lines.push(card);

    lines.push("");
    lines.push(this.renderActions());
    lines.push("");
    lines.push(chalk.dim("  ↑/↓ navigate  ·  Enter confirm  ·  Esc back"));

    return lines.join("\n");
  }

  private buildSummaryCard(state: OnboardingState): string {
    const border = chalk.hex("#6366f1");
    const labelWidth = 14;

    const rows: string[] = [];
    rows.push(formatRow("Provider:", state.provider?.name ?? "—", labelWidth));
    rows.push(formatRow("Model:", state.model ?? "—", labelWidth));

    if (state.credentials?.apiKey) {
      rows.push(formatRow("API Key:", maskKey(state.credentials.apiKey), labelWidth));
    } else {
      rows.push(formatRow("API Key:", chalk.dim("Not required (Ollama)"), labelWidth));
    }

    // Validation status
    let statusLine: string;
    if (state.validationResult === "success") {
      const lat = state.validationLatencyMs != null ? `${state.validationLatencyMs}ms` : "";
      statusLine = chalk.green(`✓ Verified ${lat ? `(${lat})` : ""}`);
    } else if (state.validationResult === "failure") {
      statusLine = chalk.yellow(`⚠ Not verified (${state.validationError ?? "unknown error"})`);
    } else {
      statusLine = chalk.dim("– Not tested");
    }
    rows.push(formatRow("Status:", statusLine, labelWidth));

    const maxRowLen = Math.max(...rows.map((r) => stripAnsi(r).length));
    const boxWidth = Math.max(maxRowLen + 4, 52);
    const paddedRows = rows.map((r) => padRow(r, boxWidth - 2));

    const cardLines: string[] = [];
    cardLines.push(border("  ╭" + "─".repeat(boxWidth) + "╮"));
    cardLines.push(border("  │") + " ".repeat(boxWidth) + border("│"));

    for (const r of paddedRows) {
      cardLines.push(border("  │ ") + r + border(" │"));
    }

    cardLines.push(border("  │") + " ".repeat(boxWidth) + border("│"));
    cardLines.push(border("  ╰" + "─".repeat(boxWidth) + "╯"));

    // Environment variables note
    cardLines.push("");
    cardLines.push(chalk.dim("  These values will be saved as Q_PROVIDER, Q_MODEL,"));
    cardLines.push(chalk.dim("  and Q_API_KEY environment variables for immediate use."));

    return cardLines.join("\n");
  }

  private renderActions(): string {
    type ActionKey = "confirm" | "change" | "cancel";
    const actions: Array<{ key: ActionKey; label: string }> = [
      { key: "confirm", label: "Looks good — start using Q!" },
      { key: "change", label: "Change something" },
      { key: "cancel", label: "Cancel" },
    ];

    return actions
      .map((a) => {
        if (this.actionSelected === a.key) {
          return chalk.bold.hex("#6366f1")(`  ◆ ${a.label}`);
        }
        return chalk.dim(`    ${a.label}`);
      })
      .join("\n");
  }

  handleInput(key: string, _state: OnboardingState): StepResult {
    if (key === "") return "prev";

    // Navigate actions with up/down arrows
    if (key === "[A" || key === "[B") {
      const actions: Array<"confirm" | "change" | "cancel"> = ["confirm", "change", "cancel"];
      const idx = actions.indexOf(this.actionSelected);
      if (key === "[B" && idx < actions.length - 1) {
        this.actionSelected = actions[idx + 1] as "confirm" | "change" | "cancel";
      }
      if (key === "[A" && idx > 0) {
        this.actionSelected = actions[idx - 1] as "confirm" | "change" | "cancel";
      }
      return "stay";
    }

    if (key === "\r" || key === "\n") {
      if (this.actionSelected === "confirm") {
        return "next";
      }
      if (this.actionSelected === "change") {
        // Jump back to provider selection
        return "jump:1" as unknown as StepResult;
      }
      if (this.actionSelected === "cancel") {
        return "exit" as StepResult;
      }
    }

    return "stay";
  }

  validate(state: OnboardingState): StepValidation {
    if (!state.provider) return { valid: false, error: "No provider selected" };
    if (!state.model) return { valid: false, error: "No model selected" };
    return { valid: true };
  }
}

// ── Helpers ──

function formatRow(label: string, value: string, labelWidth: number): string {
  const padded = label.padEnd(labelWidth);
  return `${chalk.bold(padded)}${value}`;
}

function padRow(row: string, width: number): string {
  const visibleLen = stripAnsi(row).length;
  if (visibleLen >= width) return row;
  return row + " ".repeat(width - visibleLen);
}

function maskKey(key: string): string {
  if (!key || key.length < 8) return chalk.dim("—");
  const prefix = key.substring(0, 4);
  const suffix = key.substring(key.length - 4);
  const dotCount = Math.max(0, key.length - 8);
  if (dotCount <= 0) return chalk.dim(`${prefix}${suffix}`);
  return chalk.dim(`${prefix}${"•".repeat(Math.min(8, dotCount))}${suffix}`);
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}