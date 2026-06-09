/**
 * Step 1 — Welcome screen with bold Q logo and simple introduction.
 */

import chalk from "chalk";
import type { OnboardingState, StepResult, StepValidation, WizardStep } from "../types.js";

const Q_LOGO = `
  ${chalk.hex("#6366f1").bold("QQQQQQQQ")}   ${chalk.hex("#6366f1").bold("QQ")}
  ${chalk.hex("#6366f1").bold("QQ")}        ${chalk.hex("#6366f1").bold("QQ")}
  ${chalk.hex("#6366f1").bold("QQ")}        ${chalk.hex("#6366f1").bold("QQ")}
  ${chalk.hex("#6366f1").bold("QQ")}   QQQQ ${chalk.hex("#6366f1").bold("QQ")}
  ${chalk.hex("#6366f1").bold("QQ")}      QQ ${chalk.hex("#6366f1").bold("QQ")}
  ${chalk.hex("#6366f1").bold("QQ")}      QQ ${chalk.hex("#6366f1").bold("QQ")}
  ${chalk.hex("#6366f1").bold("QQQQQQQQ")}   ${chalk.hex("#6366f1").bold("QQ")}
`;

const TOTAL_STEPS = 4;

export class WelcomeStep implements WizardStep {
  id = "welcome";
  title = "Welcome";

  render(_state: OnboardingState): string {
    const lines: string[] = [];
    lines.push("");
    lines.push(Q_LOGO);
    lines.push("");
    lines.push(chalk.bold.hex("#6366f1")("  Welcome to Q — the autonomous coding agent."));
    lines.push("");
    lines.push(chalk.dim("  Before we get started, we need two quick things:"));
    lines.push(chalk.dim("    a) an AI provider  b) a model to use."));
    lines.push("");
    lines.push(chalk.dim("  Everything you enter will be saved as Q_ environment"));
    lines.push(chalk.dim("  variables so your agent is ready to go immediately."));
    lines.push("");
    lines.push(chalk.hex("#6366f1")("  ── Step 1/4 — Welcome ──"));
    lines.push("");
    lines.push(chalk.bold("  Press Enter to begin"));
    lines.push("");
    return lines.join("\n");
  }

  handleInput(key: string, _state: OnboardingState): StepResult {
    if (key === "\r" || key === "\n") return "next";
    return "stay";
  }

  validate(_state: OnboardingState): StepValidation {
    return { valid: true };
  }
}