/**
 * Step 3 — Enter model name & API key (if needed) with live validation.
 *
 * A single unified page where the user types their model name and, if the
 * selected provider requires one, their API key. On submit, the wizard
 * performs a live validation ping against the provider (max 15s timeout).
 * Success → advance; Failure → show error and offer retry or edit.
 *
 * The flow is provider-aware:
 *   - Ollama: just a model name (no API key needed)
 *   - Others: model name + API key input
 */

import chalk from "chalk";
import type { OnboardingState, StepResult, StepValidation, WizardStep } from "../types.js";
import { ProviderFactory } from "@q/qprovs";

const VALIDATION_TIMEOUT_MS = 15_000;

export class EnterModelStep implements WizardStep {
  id = "enter-model";
  title = "Enter Model";

  private modelBuffer: string[] = [];
  private apiKeyBuffer: string[] = [];
  private focusField: "model" | "apikey" = "model";

  private isValidating = false;
  private validationDone = false;
  private validationOk = false;
  private latencyMs: number | null = null;
  private errorMessage: string | null = null;

  reset(): void {
    this.modelBuffer = [];
    this.apiKeyBuffer = [];
    this.focusField = "model";
    this.isValidating = false;
    this.validationDone = false;
    this.validationOk = false;
    this.latencyMs = null;
    this.errorMessage = null;
  }

  render(state: OnboardingState): string {
    const lines: string[] = [];
    lines.push("");
    lines.push(chalk.bold("  Configure your model"));
    lines.push("");
    lines.push(chalk.hex("#6366f1")("  ── Step 3/4 — Model Setup ──"));
    lines.push("");

    const isOllama = state.provider?.type === "ollama";

    // Show the provider badge
    const providerName = state.provider?.name ?? "Unknown";
    lines.push(chalk.dim(`  Provider: ${chalk.bold(providerName)}`));
    lines.push("");

    // ── Model name input ──
    if (!this.validationDone) {
      if (this.focusField === "model") {
        lines.push(chalk.hex("#6366f1")("▸ ") + chalk.bold("Model name"));
      } else {
        lines.push("  " + chalk.bold("Model name"));
      }
      const modelInput = this.modelBuffer.join("") || chalk.dim(isOllama ? "(e.g. llama3.2, mistral, deepseek-r1)" : "(e.g. claude-sonnet-4-20250514, gpt-4o)");
      lines.push(`    ${modelInput}`);
      lines.push("");

      // ── API key input (only for non-Ollama providers) ──
      if (!isOllama) {
        if (this.focusField === "apikey") {
          lines.push(chalk.hex("#6366f1")("▸ ") + chalk.bold("API key"));
        } else {
          lines.push("  " + chalk.bold("API key"));
        }
        const masked = this.apiKeyBuffer.map(() => "•").join("");
        const keyDisplay = masked || chalk.dim("(paste your API key)");
        lines.push(`    ${keyDisplay}`);
        lines.push("");
      } else {
        lines.push(chalk.dim("  No API key needed for Ollama."));
        lines.push("");
      }

      lines.push(chalk.dim("  Tab to switch fields  ·  Enter to validate  ·  Esc back"));
    }

    // ── Validation spinner / result ──
    if (this.isValidating) {
      lines.push("");
      lines.push(chalk.hex("#6366f1")("  ⏳ Validating connection…"));
      lines.push(chalk.dim(`  Sending test prompt to ${state.provider?.name ?? "provider"}…`));
    }

    if (this.validationDone && this.validationOk) {
      const latencyColor = this.latencyMs !== null && this.latencyMs < 3000 ? chalk.green : chalk.yellow;
      lines.push("");
      lines.push(chalk.green("  ✓ Connection successful!"));
      if (this.latencyMs !== null) {
        lines.push(latencyColor(`    Response in ${this.latencyMs}ms`));
      }
      lines.push("");
      lines.push(chalk.dim("  Press Enter to continue"));
    }

    if (this.validationDone && !this.validationOk) {
      lines.push("");
      lines.push(chalk.red("  ✗ Validation failed"));
      lines.push(chalk.yellow(`    ${this.errorMessage ?? "Provider did not respond."}`));
      lines.push("");
      lines.push(chalk.dim("  [R]etry  ·  [E]dit inputs  ·  [S]kip & continue"));
    }

    return lines.join("\n");
  }

  handleInput(key: string, state: OnboardingState): StepResult | Promise<StepResult> {
    // ── Post-validation state ──
    if (this.validationDone && this.validationOk) {
      if (key === "\r" || key === "\n") return "next";
      return "stay";
    }

    if (this.validationDone && !this.validationOk) {
      if (key === "r" || key === "R") {
        this.isValidating = false;
        this.validationDone = false;
        this.validationOk = false;
        this.errorMessage = null;
        this.latencyMs = null;
        return this.runValidation(state);
      }
      if (key === "e" || key === "E") {
        this.isValidating = false;
        this.validationDone = false;
        this.validationOk = false;
        this.errorMessage = null;
        this.latencyMs = null;
        return "stay";
      }
      if (key === "s" || key === "S") {
        // Skip validation — store what we have
        state.model = this.modelBuffer.join("").trim();
        return "next";
      }
      if (key === "\r" || key === "\n") {
        return this.runValidation(state);
      }
      return "stay";
    }

    // ── During validation, ignore input except Esc ──
    if (this.isValidating) {
      return "stay";
    }

    // ── Pre-validation editing state ──
    if (key === "") {
      this.reset();
      return "prev";
    }

    // Tab to switch fields
    if (key === "\t") {
      const isOllama = state.provider?.type === "ollama";
      if (isOllama) {
        // Only one field for Ollama — Tab does nothing meaningful, but Enter submits
        return "stay";
      }
      if (this.focusField === "model") {
        this.focusField = "apikey";
      } else {
        this.focusField = "model";
      }
      return "stay";
    }

    // Enter to submit and validate
    if (key === "\r" || key === "\n") {
      const modelName = this.modelBuffer.join("").trim();
      if (!modelName) return "stay";
      // Store model in state
      state.model = modelName;

      const isOllama = state.provider?.type === "ollama";
      if (!isOllama) {
        const apiKey = this.apiKeyBuffer.join("").trim();
        if (!apiKey) return "stay";
        state.credentials = { apiKey };
      }

      return this.runValidation(state);
    }

    // Backspace / delete
    if (key === "\x7f" || key === "\b") {
      if (this.focusField === "model" && this.modelBuffer.length > 0) {
        this.modelBuffer.pop();
      } else if (this.focusField === "apikey" && this.apiKeyBuffer.length > 0) {
        this.apiKeyBuffer.pop();
      }
      return "stay";
    }

    // Printable characters
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      if (this.focusField === "model") {
        this.modelBuffer.push(key);
      } else {
        this.apiKeyBuffer.push(key);
      }
      return "stay";
    }

    return "stay";
  }

  validate(state: OnboardingState): StepValidation {
    if (!state.model) return { valid: false, error: "No model name entered" };
    if (state.provider?.type !== "ollama") {
      const apiKey = this.apiKeyBuffer.join("").trim();
      if (!apiKey) return { valid: false, error: "No API key entered" };
    }
    if (!this.validationOk) {
      return { valid: false, error: "Model validation has not passed yet." };
    }
    return { valid: true };
  }

  /**
   * Run a live validation against the provider.
   * Sends a minimal test prompt and measures latency.
   * On success or failure, updates internal state.
   */
  private async runValidation(state: OnboardingState): Promise<StepResult> {
    this.isValidating = true;
    this.validationDone = false;
    this.errorMessage = null;
    this.latencyMs = null;

    try {
      const modelName = this.modelBuffer.join("").trim();
      const isOllama = state.provider?.type === "ollama";
      const apiKey = isOllama ? "" : this.apiKeyBuffer.join("").trim();

      const provider = ProviderFactory.create(
        state.provider!.type,
        modelName,
        {
          type: state.provider!.type,
          apiKey,
          baseUrl: undefined,
        },
      );

      const startTime = Date.now();
      await provider.generate({
        messages: [{ role: "user", content: 'Reply with exactly: ok' }],
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
      this.latencyMs = Date.now() - startTime;

      this.validationOk = true;
      this.validationDone = true;
      state.validationResult = "success";
      state.validationLatencyMs = this.latencyMs;
      state.validationError = null;
    } catch (err) {
      this.validationOk = false;
      this.validationDone = true;
      this.errorMessage = err instanceof Error ? err.message : String(err);
      state.validationResult = "failure";
      state.validationError = this.errorMessage;
      state.validationLatencyMs = null;
    } finally {
      this.isValidating = false;
    }

    return "stay";
  }
}