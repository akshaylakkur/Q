/**
 * QollabSnapshotDiffer — Computes differences between two snapshots.
 *
 * Compares snapshots file-by-file using SHA-256 hashes and produces
 * a list of added, modified, and deleted files.
 * Optionally computes unified diffs for modified files.
 */

import { createHash } from "node:crypto";
import type { SnapshotFileEntry } from "../types.js";
import type { SnapshotDiffResult } from "./types.js";

// ─── QollabSnapshotDiffer ──────────────────────────────────────────────────

export class QollabSnapshotDiffer {
  /**
   * Compute the diff between two snapshots' file entries.
   * The base snapshot is the "before" state, and the target snapshot
   * is the "after" state.
   */
  computeDiff(
    baseFiles: SnapshotFileEntry[],
    targetFiles: SnapshotFileEntry[],
  ): SnapshotDiffResult {
    const baseMap = new Map(baseFiles.map((f) => [f.path, f]));
    const targetMap = new Map(targetFiles.map((f) => [f.path, f]));

    const added: string[] = [];
    const modified: Array<{ path: string; oldSha: string; newSha: string }> = [];
    const deleted: string[] = [];

    // Find added and modified files
    for (const [path, target] of targetMap) {
      const base = baseMap.get(path);
      if (!base) {
        // File exists in target but not in base -> added
        added.push(path);
      } else if (base.sha256 !== target.sha256) {
        // File exists in both but content differs -> modified
        modified.push({
          path,
          oldSha: base.sha256,
          newSha: target.sha256,
        });
      }
      // else: identical, skip
    }

    // Find deleted files
    for (const [path] of baseMap) {
      if (!targetMap.has(path)) {
        deleted.push(path);
      }
    }

    return {
      added,
      modified,
      deleted,
      totalChanges: added.length + modified.length + deleted.length,
    };
  }

  /**
   * Compute a human-readable summary of the diff.
   */
  summarizeDiff(diff: SnapshotDiffResult): string {
    const parts: string[] = [];
    if (diff.added.length > 0) {
      parts.push(`${diff.added.length} added`);
    }
    if (diff.modified.length > 0) {
      parts.push(`${diff.modified.length} modified`);
    }
    if (diff.deleted.length > 0) {
      parts.push(`${diff.deleted.length} deleted`);
    }
    if (parts.length === 0) {
      return "No changes.";
    }
    return parts.join(", ") + ` (${diff.totalChanges} total changes)`;
  }

  /**
   * Generate a line-by-line list of changes suitable for display.
   */
  formatDiffLines(diff: SnapshotDiffResult): string[] {
    const lines: string[] = [];

    for (const path of diff.added) {
      lines.push(`[A] ${path}`);
    }
    for (const mod of diff.modified) {
      lines.push(`[M] ${mod.path}`);
    }
    for (const path of diff.deleted) {
      lines.push(`[D] ${path}`);
    }

    return lines;
  }

  /**
   * Compute a unified diff between two versions of the same file content.
   * Returns the diff as a string (basic line-based diff).
   */
  computeFileDiff(oldContent: string, newContent: string, filePath: string): string {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");

    // Simple LCS-based diff
    const diffLines: string[] = [];
    diffLines.push(`--- a/${filePath}`);
    diffLines.push(`+++ b/${filePath}`);

    // Use a simple line-by-line comparison
    let i = 0;
    let j = 0;
    let chunkStart = 0;
    const hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> = [];
    let currentHunk: string[] = [];
    let inHunk = false;

    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        if (inHunk) {
          currentHunk.push(` ${oldLines[i]}`);
          if (currentHunk.length > 10) {
            // Flush hunk
            hunks.push({
              oldStart: chunkStart + 1,
              newStart: chunkStart + 1,
              lines: currentHunk,
            });
            currentHunk = [];
            inHunk = false;
          }
        }
        i++;
        j++;
        chunkStart++;
      } else {
        if (!inHunk) {
          inHunk = true;
          currentHunk = [];
        }
        if (i < oldLines.length) {
          currentHunk.push(`-${oldLines[i]}`);
          i++;
        }
        if (j < newLines.length) {
          currentHunk.push(`+${newLines[j]}`);
          j++;
        }
      }
    }

    // Flush last hunk
    if (currentHunk.length > 0) {
      hunks.push({
        oldStart: Math.max(1, chunkStart - currentHunk.filter((l) => l.startsWith("-")).length + 1),
        newStart: Math.max(1, chunkStart - currentHunk.filter((l) => l.startsWith("+")).length + 1),
        lines: currentHunk,
      });
    }

    // Format hunks
    for (const hunk of hunks) {
      diffLines.push(
        `@@ -${hunk.oldStart},${hunk.lines.filter((l) => l.startsWith("-") || l.startsWith(" ")).length} +${hunk.newStart},${hunk.lines.filter((l) => l.startsWith("+") || l.startsWith(" ")).length} @@`,
      );
      diffLines.push(...hunk.lines);
    }

    return diffLines.join("\n");
  }
}
