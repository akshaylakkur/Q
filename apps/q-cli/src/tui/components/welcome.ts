/**
 * Welcome Component — Clean welcome banner with logo and session info.
 *
 * Shows:
 * - Qode Agent logo (ASCII art)
 * - Brief help hint
 * - Session metadata (model, mode, workdir) in a compact format
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette, TuiAppState } from "../types.js";

export class WelcomeComponent implements Component {
  private state: TuiAppState;
  private colors: ColorPalette;

  constructor(state: TuiAppState, colors: ColorPalette) {
    this.state = state;
    this.colors = colors;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const c = this.colors;
    const primary = chalk.hex(c.primary);
    const dim = chalk.hex(c.textDim);
    const text = chalk.hex(c.text);
    const indent = "  ";

    const innerWidth = Math.max(10, width - 4);

    // ── Logo ──────────────────────────────────────────────────────────
    const logo: string[] = [
      "▐█▛█▛█▌",
      "▐█████▌",
    ];
    const logoWidth = Math.max(...logo.map((row) => visibleWidth(row)));
    const gap = "  ";
    const textWidth = Math.max(4, innerWidth - logoWidth - gap.length);

    const rightRow0 = truncateToWidth(
      chalk.bold.hex(c.primary)("Qode Agent"),
      textWidth,
      "…",
    );
    const rightRow1 = truncateToWidth(
      dim("Type /help for all commands, /status for session info."),
      textWidth,
      "…",
    );

    lines.push("");
    const logoRow0: string = logo[0] ?? "";
    const logoRow1: string = logo[1] ?? "";
    const logoLine0 = `${indent}${primary(logoRow0.padEnd(logoWidth))}${gap}${rightRow0}`;
    const logoLine1 = `${indent}${primary(logoRow1.padEnd(logoWidth))}${gap}${rightRow1}`;
    lines.push(truncateToWidth(logoLine0, width, "…"));
    lines.push(truncateToWidth(logoLine1, width, "…"));
    lines.push("");

    // ── Session info ──────────────────────────────────────────────────
    const infoParts: string[] = [];
    if (this.state.model) {
      infoParts.push(
        `${primary("▸")} ${dim("Model:")} ${text(this.state.model)}`,
      );
    }
    infoParts.push(
      `${primary("▸")} ${dim("Mode:")} ${text(this.state.permissionMode)}`,
    );
    if (this.state.planMode) {
      infoParts.push(`${primary("▸")} ${dim("Plan mode enabled")}`);
    }

    if (infoParts.length > 0) {
      const infoLine = infoParts.join(`  `);
      lines.push(truncateToWidth(`${indent}${infoLine}`, width, "…"));
    }

    // ── CWD ───────────────────────────────────────────────────────────
    lines.push(
      truncateToWidth(`${indent}${dim("CWD:")} ${text(this.state.workDir)}`, width, "…"),
    );

    lines.push("");
    return lines;
  }
}