/**
 * Audit Log Component — renders file-change audit entries in a dim,
 * monospace style. Shows the most recent N entries.
 *
 * No icons — uses text labels like [create], [modify], [delete] per
 * the project rules.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette } from "../types.js";
import type { FileAuditAction } from "@qode-agent/protocol";

interface AuditEntry {
  ts: string;
  action: FileAuditAction;
  path: string;
  bytesAfter?: number;
  bytesBefore?: number;
}

export class AuditLogComponent implements Component {
  private colors: ColorPalette;
  private entries: AuditEntry[] = [];
  private maxEntries: number;

  constructor(colors: ColorPalette, maxEntries: number = 20) {
    this.colors = colors;
    this.maxEntries = maxEntries;
  }

  invalidate(): void {}

  /**
   * Add a new audit entry.
   */
  addEntry(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  render(width: number): string[] {
    if (this.entries.length === 0) return [];

    const lines: string[] = [];
    const dim = chalk.hex(this.colors.textDim);
    const accent = chalk.hex(this.colors.textDim);

    lines.push(dim("  --- File Audit Log ---"));

    for (const entry of this.entries) {
      const label = `[${entry.action}]`;
      const sizeInfo = entry.bytesAfter !== undefined
        ? ` (${formatBytes(entry.bytesAfter)})`
        : "";
      const time = entry.ts.slice(11, 19); // HH:MM:SS
      const line = `  ${dim(time)} ${accent(label.padEnd(10))} ${entry.path}${dim(sizeInfo)}`;
      lines.push(truncateToWidth(line, width));
    }

    return lines;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}