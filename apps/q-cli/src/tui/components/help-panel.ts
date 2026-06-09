/**
 * HelpPanel — Full-screen `/help` dashboard.
 *
 * Shows all slash commands grouped by category with descriptions,
 * keyboard shortcuts, and a search filter.
 *
 * This mirrors a common help panel pattern but is adapted
 * to the Qode TUI's architecture.
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

import type { ColorPalette } from "../types.js";
import {
  ALL_SLASH_COMMANDS,
  COMMAND_CATEGORIES,
  sortSlashCommands,
  type CommandCategoryGroup,
} from "../commands/registry.js";

// ── Keyboard shortcuts for the help panel ───────────────────────────

export interface KeyboardShortcut {
  readonly keys: string;
  readonly description: string;
}

export const DEFAULT_KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { keys: "Ctrl+I", description: "Expand/collapse thinking section" },
  { keys: "Ctrl+O", description: "Toggle thinking section visibility" },
  { keys: "Ctrl+C", description: "Interrupt streaming / clear input" },
  { keys: "Shift+Enter", description: "Insert newline" },
  { keys: "↑ / ↓", description: "Browse input history" },
  { keys: "Enter", description: "Submit message" },
  { keys: "Esc", description: "Close dialogs / dismiss" },
];

// ── Component ──────────────────────────────────────────────────────

export interface HelpPanelOptions {
  readonly filter?: string;
  readonly colors: ColorPalette;
  readonly onClose: () => void;
  readonly maxVisible?: number;
}

export class HelpPanelComponent extends Container implements Focusable {
  focused = false;
  private opts: HelpPanelOptions;
  private scrollTop = 0;
  private filterText = "";
  private filterBuffer = "";

  constructor(opts: HelpPanelOptions) {
    super();
    this.opts = opts;
    this.filterText = opts.filter?.toLowerCase() ?? "";
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
      this.scrollTop += 1; // render clamps
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 10;
      return;
    }

    // Filter: backspace
    if (matchesKey(data, Key.backspace) || printable === "\x7f") {
      this.filterBuffer = this.filterBuffer.slice(0, -1);
      this.filterText = this.filterBuffer.toLowerCase();
      this.scrollTop = 0;
      return;
    }

    // Filter: printable characters (skip non-printable)
    if (printable.length === 1 && printable.charCodeAt(0) >= 32) {
      this.filterBuffer += printable;
      this.filterText = this.filterBuffer.toLowerCase();
      this.scrollTop = 0;
      return;
    }
  }

  override render(width: number): string[] {
    const colors = this.opts.colors;
    const accent = chalk.hex(colors.primary);
    const dim = chalk.hex(colors.textDim);
    const text = chalk.hex(colors.text);
    const textBright = chalk.hex(colors.textBright);
    const warning = chalk.hex(colors.warning);
    const info = chalk.hex(colors.info);

    // ── Filter commands ──────────────────────────────────────────────
    const filteredCommands = this.filterText
      ? ALL_SLASH_COMMANDS.filter(
          (cmd) =>
            cmd.name.includes(this.filterText) ||
            cmd.description.toLowerCase().includes(this.filterText) ||
            cmd.aliases.some((a) => a.includes(this.filterText)),
        )
      : ALL_SLASH_COMMANDS;

    const sorted = sortSlashCommands(filteredCommands);

    // ── Build lines ──────────────────────────────────────────────────
    const lines: string[] = [];

    // Header
    lines.push(accent("━".repeat(width)));
    lines.push(
      ` ${accent.bold("⌘")} ${chalk.bold("Qode Agent Help")}` +
        `  ${dim("· Esc/Enter/q to close · ↑↓ scroll · type to filter")}`,
    );
    lines.push("");

    // Filter display
    if (this.filterBuffer) {
      lines.push(`  ${info("🔍")} ${textBright(`Filter: ${this.filterBuffer}`)}`);
      lines.push(`  ${dim(`${filteredCommands.length} command${filteredCommands.length !== 1 ? "s" : ""} match`)}`);
      lines.push("");
    } else {
      lines.push(`  ${dim("Tip: type any text to filter commands — try /help model or /help exit")}`);
      lines.push("");
    }

    // Keyboard shortcuts section
    lines.push(`  ${chalk.bold("⌨  Keyboard Shortcuts")}`);
    const kbdWidth = Math.max(8, ...DEFAULT_KEYBOARD_SHORTCUTS.map((s) => s.keys.length));
    for (const s of DEFAULT_KEYBOARD_SHORTCUTS) {
      lines.push(`    ${warning(s.keys.padEnd(kbdWidth))}  ${dim(s.description)}`);
    }
    lines.push("");

    // Commands grouped by category
    if (!this.filterText) {
      // Full view: group by category
      for (const cat of COMMAND_CATEGORIES) {
        const catCommands = sorted.filter((c) => c.category === cat.category);
        if (catCommands.length === 0) continue;
        lines.push(`  ${cat.icon}  ${chalk.bold(cat.label)}`);
        const cmdWidth = Math.max(
          14,
          ...catCommands.map(
            (c) => `/${c.name}`.length + (c.aliases.length > 0 ? 4 + c.aliases.map((a) => `/${a}`).join(", ").length : 0),
          ),
        );
        for (const cmd of catCommands) {
          const aliasesStr =
            cmd.aliases.length > 0
              ? ` ${dim("(" + cmd.aliases.map((a) => `/${a}`).join(", ") + ")")}`
              : "";
          const label = `${accent(`/${cmd.name}`)}${aliasesStr}`;
          lines.push(`    ${label.padEnd(Math.min(cmdWidth + 8, width - 30))}  ${dim(cmd.description)}`);
        }
        lines.push("");
      }
    } else {
      // Filtered view: flat list
      const cmdWidth = Math.max(
        14,
        ...sorted.map(
          (c) =>
            `/${c.name}`.length + (c.aliases.length > 0 ? 4 + c.aliases.map((a) => `/${a}`).join(", ").length : 0),
        ),
      );
      for (const cmd of sorted) {
        const catInfo = COMMAND_CATEGORIES.find((c) => c.category === cmd.category);
        const icon = catInfo?.icon ?? " ";
        const aliasesStr =
          cmd.aliases.length > 0
            ? ` ${dim("(" + cmd.aliases.map((a) => `/${a}`).join(", ") + ")")}`
            : "";
        const label = `${icon} ${accent(`/${cmd.name}`)}${aliasesStr}`;
        lines.push(`  ${label.padEnd(Math.min(cmdWidth + 10, width - 32))}  ${dim(cmd.description)}`);
      }
      if (sorted.length === 0) {
        lines.push(`  ${dim(`No commands match "${this.filterText}"`)}`);
      }
      lines.push("");
    }

    // Footer
    lines.push(accent("━".repeat(width)));

    // ── Scroll windowing ─────────────────────────────────────────────
    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 20);
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