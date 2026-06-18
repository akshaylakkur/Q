/**
 * Text-based loading animations and progress indicators.
 *
 * Per the project rules: NO icons, NO emoji. All visual feedback is conveyed
 * through text augmentation, ASCII box-drawing characters, and animated
 * text frames.
 */

import { writeSync } from "node:fs";

// ─── TextProgressBar ──────────────────────────────────────────────────────────

export interface ProgressOptions {
  label: string;
  /** Total for determinate progress. If undefined, indeterminate spinner. */
  total?: number;
  /** Bar width in chars (default 20). */
  width?: number;
}

/**
 * A text-based progress bar that renders in-place using carriage returns.
 * Designed for pre-TUI use (the connect flow) via process.stderr.
 */
export class TextProgressBar {
  readonly label: string;
  readonly total?: number;
  readonly width: number;
  private current = 0;
  private done = false;
  private lastRender = "";

  constructor(opts: ProgressOptions) {
    this.label = opts.label;
    this.total = opts.total;
    this.width = opts.width ?? 20;
  }

  /**
   * Update progress. If `current` is provided it sets the absolute value;
   * otherwise increments by 1.
   */
  update(current?: number, label?: string): void {
    if (this.done) return;
    this.current = current ?? this.current + 1;
    this.render(label);
  }

  /**
   * Mark as complete with a "done" message.
   */
  complete(message?: string): void {
    this.done = true;
    const label = message ?? this.label;
    this.renderRaw(`\r${padTo(`${label} done`, 70)}\n`);
  }

  /**
   * Mark as failed.
   */
  fail(message?: string): void {
    this.done = true;
    const label = message ?? `${this.label} failed`;
    this.renderRaw(`\r${padTo(`${label}`, 70)}\n`);
  }

  private render(labelOverride?: string): void {
    const label = labelOverride ?? this.label;
    if (this.total !== undefined) {
      const pct = Math.min(100, Math.round((this.current / this.total) * 100));
      const filled = Math.round((this.current / this.total) * this.width);
      const bar = "=".repeat(filled) + " ".repeat(this.width - filled);
      const line = `\r${label} [${bar}] ${pct}%`;
      this.renderRaw(padTo(line, 70));
    } else {
      // Indeterminate spinner
      const frames = ["|", "/", "-", "\\"];
      const frame = frames[this.current % frames.length]!;
      const line = `\r${label} [${frame}]`;
      this.renderRaw(padTo(line, 70));
    }
  }

  private renderRaw(line: string): void {
    this.lastRender = line;
    writeSync(2, line);
  }
}

// ─── Step counter ────────────────────────────────────────────────────────────

/**
 * Renders a multi-step progress sequence:
 *   [1/8] Establishing SSH connection... done
 *   [2/8] Installing remote agent... done
 *   ...
 */
export class StepProgress {
  readonly total: number;
  private current = 0;

  constructor(total: number) {
    this.total = total;
  }

  /**
   * Start the next step. Prints "[N/total] label..." (no newline).
   */
  start(label: string): void {
    this.current++;
    writeSync(2, `\r[${this.current}/${this.total}] ${label}...`);
  }

  /**
   * Complete the current step.
   */
  done(message?: string): void {
    const suffix = message ? ` ${message}` : "";
    writeSync(2, `\r[${this.current}/${this.total}] done${suffix}\n`);
  }

  /**
   * Fail the current step.
   */
  fail(message?: string): void {
    writeSync(2, `\r[${this.current}/${this.total}] FAILED${message ? ` — ${message}` : ""}\n`);
  }
}

// ─── Banner ──────────────────────────────────────────────────────────────────

/**
 * Render a text-based banner box (no icons) for the remote session header.
 */
export function renderBanner(title: string, lines: [string, string][]): string {
  const labelWidth = Math.max(...lines.map(([k]) => k.length)) + 2;
  const valWidth = Math.max(...lines.map(([, v]) => v.length));
  const innerWidth = Math.max(title.length + 4, labelWidth + valWidth + 4, 40);
  const top = `+${"-".repeat(innerWidth + 2)}+`;
  const result: string[] = [top];
  // Title line
  result.push(`| ${padTo(title, innerWidth)} |`);
  result.push(`+${"-".repeat(innerWidth + 2)}+`);
  for (const [key, val] of lines) {
    const line = `  ${padTo(key, labelWidth)} ${val}`;
    result.push(`| ${padTo(line, innerWidth)} |`);
  }
  result.push(top);
  return result.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function padTo(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}