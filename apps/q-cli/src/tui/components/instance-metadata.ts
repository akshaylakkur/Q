/**
 * Instance Metadata Component — renders the remote session info as a
 * bordered box at the top of the TUI transcript.
 *
 * Text-only, no icons — uses box-drawing characters and labels per
 * the project rules.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette } from "../types.js";
import type { RemoteSessionInfo } from "@qode-agent/protocol";

export class InstanceMetadataComponent implements Component {
  private info: RemoteSessionInfo;
  private colors: ColorPalette;

  constructor(info: RemoteSessionInfo, colors: ColorPalette) {
    this.info = info;
    this.colors = colors;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const accent = chalk.hex(this.colors.primary);
    const dim = chalk.hex(this.colors.textDim);

    const hostStr = this.info.user ? `${this.info.user}@${this.info.host}` : this.info.host;
    const entries: [string, string][] = [
      ["Host:", hostStr],
      ["Session:", this.info.sessionId],
      ["Mode:", this.info.mode],
      ["Node:", this.info.remoteNodeVersion],
      ["Arch:", this.info.remoteArch],
      ["Workspace:", this.info.workspace],
      ["Started:", this.info.startedAt],
      ["PID:", String(this.info.pid)],
    ];

    const labelWidth = Math.max(...entries.map(([k]) => k.length)) + 1;
    const maxValWidth = Math.max(...entries.map(([, v]) => visibleWidth(v)));
    const innerWidth = Math.max(30, labelWidth + maxValWidth + 4);

    // Top border
    lines.push(accent("+" + "-".repeat(innerWidth + 2) + "+"));
    // Title
    const title = " QSSH Remote Session ";
    const titlePadded = title + " ".repeat(Math.max(0, innerWidth - title.length + 2));
    lines.push(accent("|") + chalk.hex(this.colors.surface)(titlePadded) + accent("|"));
    lines.push(accent("+" + "-".repeat(innerWidth + 2) + "+"));

    // Entries
    for (const [key, val] of entries) {
      const line = " " + dim(key.padEnd(labelWidth)) + " " + val;
      const padded = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line) + 2));
      lines.push(accent("|") + chalk.hex(this.colors.surface)(truncateToWidth(padded, innerWidth + 2)) + accent("|"));
    }

    // Bottom border
    lines.push(accent("+" + "-".repeat(innerWidth + 2) + "+"));
    lines.push("");

    return lines;
  }
}