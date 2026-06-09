/**
 * StatusDashboard — Rich `/status` panel showing session info.
 *
 * Displays: model, provider, permission mode, plan mode, session ID,
 * CWD, context window usage (tokens used / max), uptime, turn count,
 * thinking mode, and memory pressure.
 */

import {
  Container,
  matchesKey,
  Key,
  decodeKittyPrintable,
  truncateToWidth,
  type Focusable,
} from "@earendil-works/pi-tui";
import chalk from "chalk";

import type { ColorPalette, TuiAppState } from "../types.js";

// ── Component ──────────────────────────────────────────────────────

export interface StatusDashboardOptions {
  readonly state: TuiAppState;
  readonly turnCount: number;
  readonly uptimeMs: number;
  readonly colors: ColorPalette;
  readonly onClose: () => void;
  readonly maxVisible?: number;
}

export class StatusDashboardComponent extends Container implements Focusable {
  focused = false;
  private opts: StatusDashboardOptions;
  private scrollTop = 0;

  constructor(opts: StatusDashboardOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    const printable = decodeKittyPrintable(data) ?? data;

    // Close on Esc / Enter / q / Q
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      printable === "q" ||
      printable === "Q"
    ) {
      this.opts.onClose();
      return;
    }

    // Scrolling
    if (matchesKey(data, Key.up)) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTop += 1;
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 10;
    }
  }

  override render(width: number): string[] {
    const { state, colors, turnCount, uptimeMs } = this.opts;
    const accent = chalk.hex(colors.primary);
    const dim = chalk.hex(colors.textDim);
    const text = chalk.hex(colors.text);
    const textBright = chalk.hex(colors.textBright);
    const success = chalk.hex(colors.success);
    const warning = chalk.hex(colors.warning);
    const error = chalk.hex(colors.error);
    const info = chalk.hex(colors.info);

    const lines: string[] = [];

    // ── Header ───────────────────────────────────────────────────────
    lines.push(accent("━".repeat(width)));
    lines.push(
      ` ${accent.bold("◆")} ${chalk.bold("Qode Agent Status")}` +
        `  ${dim("· Esc/Enter/q to close · ↑↓ scroll")}`,
    );
    lines.push("");

    // ── Session Info Group ───────────────────────────────────────────
    lines.push(`  ${info("■")}  ${chalk.bold("Session")}`);
    lines.push(`    ${dim("ID:")}      ${textBright(state.sessionId.slice(0, 24))}`);
    lines.push(`    ${dim("CWD:")}     ${text(state.workDir)}`);
    lines.push(`    ${dim("Uptime:")}  ${text(formatDuration(uptimeMs))}`);
    lines.push(`    ${dim("Turns:")}   ${text(String(turnCount))}`);
    lines.push("");

    // ── Model & Provider Group ───────────────────────────────────────
    lines.push(`  ${info("■")}  ${chalk.bold("Model & Provider")}`);
    lines.push(`    ${dim("Model:")}       ${textBright(state.model || "not set")}`);
    lines.push(`    ${dim("Version:")}     ${text(state.version)}`);
    if (state.thinking) {
      lines.push(`    ${dim("Thinking:")}     ${success("enabled")}`);
    } else {
      lines.push(`    ${dim("Thinking:")}     ${dim("disabled")}`);
    }
    lines.push("");

    // ── Mode Group ───────────────────────────────────────────────────
    lines.push(`  ${info("■")}  ${chalk.bold("Mode")}`);
    const permissionColor =
      state.permissionMode === "yolo"
        ? warning
        : state.permissionMode === "auto"
          ? success
          : text;
    lines.push(`    ${dim("Permission:")}  ${permissionColor(state.permissionMode)}`);
    lines.push(
      `    ${dim("Plan:")}        ${state.planMode ? success("active") : dim("inactive")}`,
    );

    const phaseLabel = formatPhase(state.streamingPhase);
    const phaseColor =
      state.streamingPhase === "idle" ? dim : state.streamingPhase === "waiting" ? warning : success;
    lines.push(`    ${dim("Streaming:")}   ${phaseColor(phaseLabel)}`);

    lines.push(`    ${dim("Compacting:")}  ${state.isCompacting ? warning("yes") : dim("no")}`);
    lines.push(`    ${dim("Replaying:")}   ${state.isReplaying ? warning("yes") : dim("no")}`);
    lines.push("");

    // ── Context Window Group ─────────────────────────────────────────
    lines.push(`  ${info("■")}  ${chalk.bold("Context Window")}`);
    const maxCtx = state.maxContextTokens || 128_000;
    const used = state.contextTokens || 0;
    const pct = maxCtx > 0 ? Math.round((used / maxCtx) * 100) : 0;
    const bar = renderProgressBar(pct, Math.min(40, width - 30));
    const barColor = pct > 80 ? error : pct > 60 ? warning : success;
    lines.push(`    ${dim("Tokens:")}    ${text(`${used.toLocaleString()} / ${maxCtx.toLocaleString()}`)}`);
    lines.push(`    ${dim("Usage:")}    ${barColor(bar)} ${barColor(`${pct}%`)}`);
    lines.push("");

    // ── Footer ───────────────────────────────────────────────────────
    lines.push(accent("━".repeat(width)));

    // ── Scroll windowing ─────────────────────────────────────────────
    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
    if (content.length > maxVisible) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
      const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
      const scrollInfo = dim(
        `  ${this.scrollTop + 1}-${this.scrollTop + slice.length} of ${content.length}`,
      );
      return [lines[0] ?? "", ...slice, scrollInfo, lines.at(-1) ?? ""].map((line) =>
        truncateToWidth(line, width),
      );
    }
    this.scrollTop = 0;
    return lines.map((line) => truncateToWidth(line, width));
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatPhase(phase: string): string {
  switch (phase) {
    case "idle":
      return "idle";
    case "waiting":
      return "⏳ waiting...";
    case "thinking":
      return "🧠 thinking";
    case "composing":
      return "✍️  composing";
    case "tool":
      return "🔧 tool call";
    default:
      return phase;
  }
}

function renderProgressBar(pct: number, width: number): string {
  if (width < 3) return "";
  const filled = Math.round((pct / 100) * (width - 2));
  const empty = width - 2 - filled;
  return "[" + "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, empty)) + "]";
}