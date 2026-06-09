/**
 * File Explorer Component — Shows files in the current directory with tree view.
 * Supports navigation, file content preview, and modification tracking.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, relative, basename, extname } from "node:path";
import type { ColorPalette, FileExplorerNode } from "../types.js";

export class FileExplorerComponent implements Component {
  private colors: ColorPalette;
  private rootPath: string;
  private rootNode: FileExplorerNode;
  private selectedPath: string | null = null;
  private scrollOffset: number = 0;
  private modifiedFiles: Set<string> = new Set();
  private previewContent: string | null = null;
  private previewPath: string | null = null;
  private collapsed: boolean = false;

  constructor(rootPath: string, colors: ColorPalette) {
    this.rootPath = rootPath;
    this.colors = colors;
    this.rootNode = this.buildTree(rootPath);
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
  }

  markModified(path: string): void {
    this.modifiedFiles.add(path);
    // Refresh the tree to update the display
    this.rootNode = this.buildTree(this.rootPath);
  }

  selectNext(): void {
    const flat = this.flattenTree(this.rootNode, 0);
    const currentIdx = flat.findIndex((n) => n.path === this.selectedPath);
    if (currentIdx < flat.length - 1) {
      this.selectedPath = flat[currentIdx + 1]!.path;
    }
  }

  selectPrev(): void {
    const flat = this.flattenTree(this.rootNode, 0);
    const currentIdx = flat.findIndex((n) => n.path === this.selectedPath);
    if (currentIdx > 0) {
      this.selectedPath = flat[currentIdx - 1]!.path;
    }
  }

  toggleExpand(): void {
    if (!this.selectedPath) return;
    const node = this.findNode(this.rootNode, this.selectedPath);
    if (node && node.type === "directory") {
      node.expanded = !node.expanded;
    }
  }

  getSelectedPath(): string | null {
    return this.selectedPath;
  }

  getPreviewContent(): string | null {
    return this.previewContent;
  }

  getPreviewPath(): string | null {
    return this.previewPath;
  }

  refresh(): void {
    this.rootNode = this.buildTree(this.rootPath);
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.collapsed) {
      return [truncateToWidth(chalk.hex(this.colors.primary)(`  📁 Files (${this.modifiedFiles.size} modified)`), width, "…"), ""];
    }

    const lines: string[] = [];
    const innerWidth = Math.max(10, width - 2);

    // Header
    const headerColor = chalk.hex(this.colors.primary);
    lines.push(truncateToWidth(headerColor(chalk.bold(`  📁 ${basename(this.rootPath)}`)), width, "…"));
    lines.push(truncateToWidth(chalk.hex(this.colors.textDim)(`  ${"─".repeat(Math.min(innerWidth, 30))}`), width, "…"));

    // Render tree
    const flat = this.flattenTree(this.rootNode, 0);
    const visible = flat.slice(this.scrollOffset, this.scrollOffset + 20);

    for (const node of visible) {
      const indent = "  " + "  ".repeat(node.depth);
      const isSelected = node.path === this.selectedPath;
      const isModified = this.modifiedFiles.has(node.path);

      let prefix = "";
      let icon = "";
      let nameColor = this.colors.text;

      if (node.type === "directory") {
        icon = node.expanded ? "📂" : "📁";
        nameColor = this.colors.secondary;
      } else {
        icon = this.getFileIcon(node.name);
        nameColor = this.colors.text;
      }

      if (isSelected) {
        prefix = chalk.hex(this.colors.primary)("▸");
        nameColor = this.colors.primary;
      } else {
        prefix = " ";
      }

      if (isModified) {
        nameColor = this.colors.warning;
      }

      const nameStr = truncateToWidth(node.name, innerWidth - indent.length - 4, "…");
      const modifiedMarker = isModified ? chalk.hex(this.colors.warning)(" ●") : "";

      const fullLine = `${prefix}${indent}${icon} ${chalk.hex(nameColor)(nameStr)}${modifiedMarker}`;
      lines.push(truncateToWidth(fullLine, width, "…"));
    }

    if (flat.length > this.scrollOffset + 20) {
      lines.push(truncateToWidth(chalk.hex(this.colors.textDim)(`  ... ${flat.length - this.scrollOffset - 20} more`), width, "…"));
    }

    // Show preview if a file is selected
    if (this.selectedPath && this.previewContent) {
      lines.push("");
      lines.push(truncateToWidth(chalk.hex(this.colors.textDim)(`  ${"─".repeat(Math.min(innerWidth, 30))}`), width, "…"));
      lines.push(truncateToWidth(chalk.bold.hex(this.colors.textBright)(`  ${basename(this.selectedPath)}`), width, "…"));

      const previewLines = this.previewContent.split("\n").slice(0, 10);
      for (const pl of previewLines) {
        const truncated = truncateToWidth(pl, innerWidth - 2, "…");
        lines.push(truncateToWidth(chalk.hex(this.colors.textDim)(`  ${truncated}`), width, "…"));
      }
      if (this.previewContent.split("\n").length > 10) {
        lines.push(truncateToWidth(chalk.hex(this.colors.textDim)(`  ... (preview)`), width, "…"));
      }
    }

    lines.push("");
    return lines;
  }

  private buildTree(dirPath: string): FileExplorerNode {
    const name = basename(dirPath) || dirPath;
    const node: FileExplorerNode = {
      name,
      path: dirPath,
      type: "directory",
      expanded: true,
      children: [],
    };

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        // Skip hidden files and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

        const fullPath = resolve(dirPath, entry.name);
        try {
          const stat = statSync(fullPath);
          if (entry.isDirectory()) {
            const child = this.buildTree(fullPath);
            node.children!.push(child);
          } else if (entry.isFile()) {
            node.children!.push({
              name: entry.name,
              path: fullPath,
              type: "file",
              size: stat.size,
            });
          }
        } catch {
          // Skip files we can't stat
        }
      }

      // Sort: directories first, then files, alphabetically
      node.children!.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      // Directory might not exist
    }

    return node;
  }

  private flattenTree(
    node: FileExplorerNode,
    depth: number,
  ): Array<FileExplorerNode & { depth: number }> {
    const result: Array<FileExplorerNode & { depth: number }> = [];

    if (depth > 0) {
      result.push({ ...node, depth });
    }

    if (node.type === "directory" && node.expanded && node.children) {
      for (const child of node.children) {
        result.push(...this.flattenTree(child, depth + 1));
      }
    }

    return result;
  }

  private findNode(node: FileExplorerNode, path: string): FileExplorerNode | null {
    if (node.path === path) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = this.findNode(child, path);
        if (found) return found;
      }
    }
    return null;
  }

  private getFileIcon(name: string): string {
    const ext = extname(name).toLowerCase();
    switch (ext) {
      case ".ts":
      case ".tsx":
        return "🟦";
      case ".js":
      case ".jsx":
        return "🟨";
      case ".json":
        return "📋";
      case ".md":
        return "📝";
      case ".css":
      case ".scss":
        return "🎨";
      case ".html":
        return "🌐";
      case ".py":
        return "🐍";
      case ".rs":
        return "🦀";
      case ".go":
        return "🔷";
      case ".toml":
      case ".yaml":
      case ".yml":
        return "⚙️";
      default:
        return "📄";
    }
  }
}
