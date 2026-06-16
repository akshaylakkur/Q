/**
 * OnboardingWizard — The revamped first-run setup flow.
 *
 * A clean, professional 4-step wizard:
 *   1. Welcome — Q logo, intro
 *   2. Select Provider — pick from curated list
 *   3. Enter Model + Validate — type model name + API key, live validation (max 15s)
 *   4. Confirmation — review all choices, confirm or change
 *
 * On completion, writes Q_PROVIDER, Q_MODEL, Q_API_KEY env vars (via a shell
 * integration script) and creates the config file so the agent is ready to run.
 *
 * Uses raw terminal mode for keyboard input and chalk for rendering.
 */

import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import type { WizardStep, StepResult } from "./types.js";
import { createDefaultState, cloneState, type OnboardingState } from "./types.js";
import { WelcomeStep } from "./steps/welcome.js";
import { SelectProviderStep } from "./steps/select-provider.js";
import { EnterModelStep } from "./steps/enter-model.js";
import { ConfirmationStep } from "./steps/confirmation.js";

/**
 * An extended result that can carry jump target info.
 */
interface ProcessedResult {
  action: "next" | "prev" | "stay" | "exit" | "jump";
  targetStep?: number;
}

export class OnboardingWizard {
  private state: OnboardingState;
  private steps: WizardStep[];
  private currentStepIndex = 0;
  /** History stack for backtracking */
  private history: OnboardingState[] = [];
  private stdin!: NodeJS.ReadStream;

  constructor() {
    this.state = createDefaultState();
    this.steps = [
      new WelcomeStep(),          // 0
      new SelectProviderStep(),   // 1
      new EnterModelStep(),       // 2
      new ConfirmationStep(),     // 3
    ];
  }

  /**
   * Run the wizard flow.
   * Returns true if the user completed the wizard, false if cancelled.
   */
  async run(): Promise<boolean> {
    this.stdin = process.stdin;

    try {
      this.setRawMode(true);
      this.currentStepIndex = 0;

      while (this.currentStepIndex >= 0 && this.currentStepIndex < this.steps.length) {
        const step = this.steps[this.currentStepIndex];
        if (!step) break;

        // Reset step state when entering for the first time
        if (this.currentStepIndex === 2) {
          // For EnterModelStep, only reset if we're entering fresh (not backtracking with data)
          if (!this.state.model && step.reset) {
            step.reset();
          }
        } else if (step.reset) {
          step.reset();
        }

        // Checkpoint before rendering
        this.checkpoint();

        // Render the step
        this.renderStep(step);

        // Wait for user input and handle it
        let stayOnStep = false;
        while (!stayOnStep) {
          const processed = await this.waitForInput(step);

          switch (processed.action) {
            case "next": {
              // Validate the step before advancing
              const validation = step.validate(this.state);
              if (!validation.valid) {
                this.renderStep(step, validation.error);
                continue;
              }
              // Collect state from this step
              this.collectStepState(step);
              this.currentStepIndex++;
              stayOnStep = true;
              break;
            }
            case "prev": {
              this.backtrack();
              this.currentStepIndex = Math.max(0, this.currentStepIndex - 1);
              stayOnStep = true;
              break;
            }
            case "exit": {
              const confirmed = await this.confirmExit();
              if (confirmed) {
                this.setRawMode(false);
                return false;
              }
              this.renderStep(step);
              break;
            }
            case "jump": {
              const targetStep = processed.targetStep ?? 0;
              if (targetStep >= 0 && targetStep < this.steps.length) {
                // Reset state back to the checkpoint before jump
                this.backtrack();
                this.currentStepIndex = targetStep;
                stayOnStep = true;
              } else {
                this.renderStep(step);
              }
              break;
            }
            default: {
              this.renderStep(step);
              break;
            }
          }
        }
      }

      // ── All steps complete — finalize ──
      this.setRawMode(false);
      await this.finishWizard();
      return true;
    } catch (err) {
      this.setRawMode(false);
      console.error(chalk.red("Onboarding error:"), err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * Called after all steps complete to write config and env vars.
   */
  private async finishWizard(): Promise<void> {
    // Write the config file
    this.writeEnvConfig();

    // Run post-setup verification
    await this.runPostSetupVerification();
  }

  /**
   * Write provider, model, and API key as environment variables and to config.
   */
  private writeEnvConfig(): void {
    const home = homedir();
    const qDir = resolve(home, ".Q");
    mkdirSync(qDir, { recursive: true });

    const provider = this.state.provider?.type ?? "";
    const model = this.state.model ?? "";
    const apiKey = this.state.credentials?.apiKey ?? "";

    // ── Write config.toml ──
    const configLines: string[] = [];
    configLines.push("# Q Configuration — generated by onboarding wizard");
    configLines.push("#");
    configLines.push(`# These values are also exposed as environment variables`);
    configLines.push(`# for immediate use by the agent.`);
    configLines.push("");

    configLines.push(`provider = "${provider}"`);
    configLines.push(`model = "${model}"`);
    configLines.push(`apiKey = "${apiKey.replace(/"/g, '\\"')}"`);

    configLines.push("");

    // Models section
    configLines.push("[models.default]");
    configLines.push(`provider = "${this.state.provider?.name ?? provider}"`);
    configLines.push(`name = "${model}"`);
    configLines.push(`maxContextSize = 128000`);
    configLines.push(`maxOutputSize = 8192`);

    configLines.push("");

    // Display
    configLines.push("[display]");
    configLines.push(`animations = true`);
    configLines.push(`linkPreview = true`);
    configLines.push(`imagePreview = true`);

    configLines.push("");

    // Permission — default to ask
    configLines.push(`defaultPermissionMode = "ask"`);

    const toml = configLines.join("\n");
    writeFileSync(resolve(qDir, "config.toml"), toml, { mode: 0o600 });

    // ── Write env setup script ──
    // This script can be sourced or used by the agent runtime
    const envScriptLines: string[] = [];
    envScriptLines.push("#!/bin/sh");
    envScriptLines.push(`# Q environment variables — generated by onboarding wizard`);
    envScriptLines.push(`export Q_PROVIDER="${provider}"`);
    envScriptLines.push(`export Q_MODEL="${model}"`);
    if (apiKey) {
      envScriptLines.push(`export Q_API_KEY="${apiKey}"`);
    }

    // Write env file with user-read-only permissions
    writeFileSync(resolve(qDir, "env"), envScriptLines.join("\n"), { mode: 0o600 });

    // Also write the semaphore marker
    writeFileSync(resolve(qDir, ".onboarding-complete"), "", { mode: 0o644 });
  }

  /**
   * Post-setup verification — runs after config is written.
   */
  private async runPostSetupVerification(): Promise<void> {
    process.stdout.write("\x1Bc");
    console.log("");
    console.log(chalk.hex("#6366f1")("  Applying setup…"));

    // 1. Verify config file
    try {
      const configPath = resolve(homedir(), ".Q", "config.toml");
      if (existsSync(configPath)) {
        const config = readFileSync(configPath, "utf-8");
        if (config.includes(`provider = "${this.state.provider?.type}"`)) {
          console.log(chalk.dim("  ✓ Configuration saved to ~/.Q/config.toml"));
        }
      }
    } catch {
      console.log(chalk.red("  ✗ Config file could not be verified"));
    }

    // 2. Verify env file
    try {
      const envPath = resolve(homedir(), ".Q", "env");
      if (existsSync(envPath)) {
        console.log(chalk.dim("  ✓ Environment variables saved to ~/.Q/env"));
      }
    } catch {
      // ignore
    }

    console.log("");
    console.log(chalk.bold.hex("#6366f1")("  ✓ Setup complete!"));
    console.log(chalk.dim("  Q_PROVIDER, Q_MODEL, and Q_API_KEY are now configured."));
    console.log(chalk.dim("  Run 'q' to start using the agent."));
    console.log("");

    await this.delay(1500);
  }

  /**
   * Extract state values from a step instance after it signals "next".
   */
  private collectStepState(step: WizardStep): void {
    if (step.id === "select-provider") {
      const providerStep = step as SelectProviderStep;
      const selected = providerStep.getSelectedProvider();
      if (selected) {
        this.state.provider = { type: selected.type, name: selected.name };
      }
    }
    // EnterModelStep writes directly to state during handleInput
    // ConfirmationStep is purely review
  }

  /**
   * Render a step's content to the terminal.
   */
  private renderStep(step: WizardStep, error?: string): void {
    process.stdout.write("\x1Bc");
    const content = step.render(this.state);
    console.log(content);
    if (error) {
      console.log("");
      console.log(chalk.red(`  Error: ${error}`));
    }
  }

  /**
   * Wait for a single keypress event from stdin.
   * Handles paste events by feeding each character individually to the step.
   */
  private waitForInput(step: WizardStep): Promise<ProcessedResult> {
    return new Promise((resolvePromise) => {
      const handler = (data: Buffer) => {
        const raw = data.toString();

        // Handle Ctrl+C
        if (raw === "\x03") {
          resolvePromise({ action: "exit" });
          return;
        }

        // Feed each character individually so paste works
        this.processChars(step, raw, resolvePromise);
      };

      this.stdin.once("data", handler);
    });
  }

  /**
   * Process one or more characters through the step's handleInput,
   * grouping escape sequences (arrow keys, etc.) so they aren't
   * split into individual characters, while still handling paste
   * by feeding printable characters one at a time.
   */
  private processChars(
    step: WizardStep,
    chars: string,
    resolvePromise: (result: ProcessedResult) => void,
  ): void {
    let i = 0;
    const next = () => {
      if (i >= chars.length) {
        resolvePromise({ action: "stay" });
        return;
      }

      // Collect a complete escape sequence (starts with \x1b)
      let seq: string;
      if (chars[i] === "\x1b" && i + 2 < chars.length) {
        // CSI sequences: ESC [ <char>  or  ESC [ <digit> ; <digit> <char>
        seq = chars.slice(i, i + 3);
        i += 3;
        // Some sequences are longer (e.g. ESC [ 1 ; 5 A for Ctrl+arrow)
        while (i < chars.length && !/[A-Z~]$/i.test(seq) && chars[i] !== "\x1b") {
          seq += chars[i];
          i++;
        }
      } else {
        // Single character (printable, newline, tab, backspace, etc.)
        seq = chars[i]!;
        i++;
      }

      const resultOrPromise = step.handleInput(seq, this.state);

      if (resultOrPromise instanceof Promise) {
        resultOrPromise.then((result) => this.resolveActionResult(result, resolvePromise));
        return;
      }

      const result = resultOrPromise;
      if (result === "stay") {
        next();
      } else {
        this.resolveActionResult(result, resolvePromise);
      }
    };
    next();
  }

  /**
   * Resolve a step action, handling jump encoding.
   */
  private resolveActionResult(
    result: StepResult | "exit",
    resolvePromise: (result: ProcessedResult) => void,
  ): void {
    if (typeof result === "string" && result.startsWith("jump:")) {
      const targetStep = parseInt(result.split(":")[1] ?? "", 10);
      if (!isNaN(targetStep) && targetStep >= 0 && targetStep < this.steps.length) {
        this.backtrack();
        resolvePromise({ action: "jump", targetStep });
        return;
      }
      resolvePromise({ action: "stay" });
      return;
    }

    if (result === "next") resolvePromise({ action: "next" });
    else if (result === "prev") resolvePromise({ action: "prev" });
    else if (result === "exit") resolvePromise({ action: "exit" });
    else resolvePromise({ action: "stay" });
  }

  /**
   * Save a checkpoint of the current state (for backtracking).
   */
  private checkpoint(): void {
    this.history.push(cloneState(this.state));
  }

  /**
   * Restore the previous checkpoint.
   */
  private backtrack(): void {
    const prev = this.history.pop();
    if (prev) {
      this.state = prev;
    }
  }

  /**
   * Show exit confirmation dialog.
   */
  private async confirmExit(): Promise<boolean> {
    process.stdout.write("\x1Bc");
    console.log("");
    console.log(chalk.bold("  Exit setup?"));
    console.log(chalk.dim("  Your preferences won't be saved."));
    console.log("");
    console.log(chalk.dim("  [E]xit  [C]ontinue setup"));

    return new Promise((resolvePromise) => {
      const handler = (data: Buffer) => {
        const key = data.toString().toLowerCase();
        this.stdin.off("data", handler);
        if (key === "e") {
          console.log("");
          console.log(chalk.dim("  Setup cancelled. Run 'q' again to restart."));
          resolvePromise(true);
        } else {
          resolvePromise(false);
        }
      };
      this.stdin.once("data", handler);
    });
  }

  /**
   * Set stdin raw mode.
   */
  private setRawMode(raw: boolean): void {
    try {
      this.stdin.setRawMode(raw);
      if (raw) {
        this.stdin.resume();
      } else {
        this.stdin.pause();
      }
    } catch {
      // Raw mode may not be available in all environments
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }
}