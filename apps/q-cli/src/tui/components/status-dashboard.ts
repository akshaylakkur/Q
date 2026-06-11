/**
 * StatusDashboard — Rich `/status` panel showing session info.
 *
 * Displays: model, provider, permission mode, plan mode, session ID,
 * CWD, context window usage (tokens used / max), uptime, turn count,
 * thinking mode, memory pressure, and campaign progress when active.
 */

import {
  Container,
  matchesKey,
  Key,
  decodeKittyPrintable,
  truncateToWidth,
  type Focusable,
} from "@earendil-works/pi-tui";
import chalk, { type ChalkInstance } from "chalk";

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
    lines.push(
      `    ${dim("Execution:")}   ${textBright(state.executionMode || "not set")}`,
    );

    const phaseLabel = formatPhase(state.streamingPhase);
    const phaseColor =
      state.streamingPhase === "idle" ? dim : state.streamingPhase === "waiting" ? warning : success;
    lines.push(`    ${dim("Streaming:")}   ${phaseColor(phaseLabel)}`);

    lines.push(`    ${dim("Compacting:")}  ${state.isCompacting ? warning("yes") : dim("no")}`);
    lines.push(`    ${dim("Replaying:")}   ${state.isReplaying ? warning("yes") : dim("no")}`);
    lines.push("");

    // ── Campaign Progress Group (only when a campaign mode is active) ──
    const campaignLines = this.renderCampaignProgress(state, { dim, text, textBright, success, warning, error, info, accent });
    if (campaignLines.length > 0) {
      lines.push(...campaignLines);
    }

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

  /**
   * Render campaign-specific progress section when a campaign mode is active.
   * Returns an array of formatted lines (empty if no campaign mode is active).
   */
  private renderCampaignProgress(
    state: TuiAppState,
    colors: {
      dim: ChalkInstance;
      text: ChalkInstance;
      textBright: ChalkInstance;
      success: ChalkInstance;
      warning: ChalkInstance;
      error: ChalkInstance;
      info: ChalkInstance;
      accent: ChalkInstance;
    },
  ): string[] {
    const { dim, text, textBright, success, warning, error, info, accent } = colors;
    const mode = state.executionMode ?? "";

    // ── Speed Campaign ───────────────────────────────────────────────
    if (mode.startsWith("speed-campaign")) {
      const completed = state.campaignCompletedCount ?? 0;
      const total = state.campaignSubTaskCount ?? 0;
      const progress = state.campaignProgress ?? (total > 0 ? Math.round((completed / total) * 100) : 0);
      const phase = state.campaignPhase ?? "dispatched";

      const lines: string[] = [];
      lines.push(`  ${accent("⚡")}  ${chalk.bold("Speed Campaign")}`);
      lines.push(`    ${dim("Phase:")}      ${textBright(phase)}`);

      if (total > 0) {
        const ratioColor = completed >= total ? success : warning;
        lines.push(`    ${dim("Sub-tasks:")}  ${ratioColor(`${completed} / ${total}`)}`);
        const barWidth = Math.min(36, 40);
        const bar = renderProgressBar(progress, barWidth);
        const barColor = progress >= 100 ? success : progress > 50 ? warning : text;
        lines.push(`    ${dim("Progress:")}   ${barColor(bar)} ${barColor(`${progress}%`)}`);
      } else {
        lines.push(`    ${dim("Sub-tasks:")}  ${dim("awaiting dispatch...")}`);
      }

      lines.push("");
      return lines;
    }

    // ── Medium Campaign ──────────────────────────────────────────────
    if (mode.startsWith("medium-campaign")) {
      const phase = state.campaignPhase ?? "initializing";
      const convergence = state.campaignConvergenceCount ?? 0;
      const gateStatus = state.campaignGateStatus;
      const progress = state.campaignProgress ?? 0;

      const lines: string[] = [];
      lines.push(`  ${info("◈")}  ${chalk.bold("Medium Campaign")}`);
      lines.push(`    ${dim("Wave/Phase:")}  ${textBright(phase)}`);

      const convergenceColor = convergence > 0 ? success : dim;
      lines.push(`    ${dim("Convergence:")} ${convergenceColor(`${convergence} cycle${convergence !== 1 ? "s" : ""}`)}`);

      // Gate status with color coding
      if (gateStatus) {
        const gateColor =
          gateStatus === "pass" || gateStatus === "passed"
            ? success
            : gateStatus === "fail" || gateStatus === "failed"
              ? error
              : gateStatus === "running" || gateStatus === "pending"
                ? warning
                : text;
        lines.push(`    ${dim("Gate:")}       ${gateColor(gateStatus)}`);
      } else {
        lines.push(`    ${dim("Gate:")}       ${dim("pending")}`);
      }

      // Show overall progress bar
      if (progress > 0) {
        const barWidth = Math.min(36, 40);
        const bar = renderProgressBar(progress, barWidth);
        const barColor = progress >= 100 ? success : progress > 50 ? warning : text;
        lines.push(`    ${dim("Progress:")}   ${barColor(bar)} ${barColor(`${progress}%`)}`);
      }

      lines.push("");
      return lines;
    }

    // ── High Campaign ────────────────────────────────────────────────
    if (mode.startsWith("high-campaign")) {
      const cycleCount = state.campaignConvergenceCount ?? 0;
      const filesChanged = state.campaignFilesChanged ?? 0;
      const verificationStatus = state.campaignVerificationStatus;
      const progress = state.campaignProgress ?? 0;
      const phase = state.campaignPhase ?? "converging";

      const lines: string[] = [];
      lines.push(`  ${accent("⟁")}  ${chalk.bold("High Campaign")}`);
      lines.push(`    ${dim("Phase:")}            ${textBright(phase)}`);

      const cycleColor = cycleCount > 0 ? success : dim;
      lines.push(`    ${dim("Convergence:")}      ${cycleColor(`${cycleCount} cycle${cycleCount !== 1 ? "s" : ""}`)}`);

      const filesColor = filesChanged > 0 ? info : dim;
      lines.push(`    ${dim("Files changed:")}    ${filesColor(String(filesChanged))}`);

      // Verification status with color coding
      if (verificationStatus) {
        const verifyColor =
          verificationStatus === "passing"
            ? success
            : verificationStatus === "failing"
              ? error
              : verificationStatus === "running"
                ? warning
                : text;
        lines.push(`    ${dim("Verification:")}     ${verifyColor(verificationStatus)}`);
      } else {
        lines.push(`    ${dim("Verification:")}     ${dim("not started")}`);
      }

      // Show overall progress bar
      if (progress > 0) {
        const barWidth = Math.min(36, 40);
        const bar = renderProgressBar(progress, barWidth);
        const barColor = progress >= 100 ? success : progress > 50 ? warning : text;
        lines.push(`    ${dim("Progress:")}        ${barColor(bar)} ${barColor(`${progress}%`)}`);
      }

      lines.push("");
      return lines;
    }

    // Not a campaign mode
    return [];
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