/**
 * QollabRemoteFileSystem — Read-only filesystem connector for snapshot access.
 *
 * When an attendee pulls a snapshot, it is extracted to ~/.Q/collab/snapshots/<sessionId>/.
 * This directory is READ-ONLY — only read operations (Read, Glob, Grep) are permitted.
 * All write operations (Write, StrReplace, Bash) return errors.
 *
 * The agent can reference files via @snapshot: prefix to read from the snapshot
 * instead of the local filesystem.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";

// ─── SnapshotFileConnector ──────────────────────────────────────────────────

export class SnapshotFileConnector {
  private readonly snapshotDir: string;

  constructor(snapshotDir: string) {
    this.snapshotDir = snapshotDir;
  }

  /**
   * Get the base directory of the snapshot.
   */
  getBaseDir(): string {
    return this.snapshotDir;
  }

  /**
   * Check if a path is within the snapshot directory (prevents path traversal).
   */
  private isPathSafe(relativePath: string): boolean {
    const resolved = resolve(this.snapshotDir, relativePath);
    return resolved.startsWith(this.snapshotDir);
  }

  // ─── Read Operations ─────────────────────────────────────────────────

  /**
   * Read a file from the snapshot. READ-ONLY.
   */
  async read(path: string): Promise<string> {
    const safePath = resolve(this.snapshotDir, path);
    if (!safePath.startsWith(this.snapshotDir)) {
      throw new Error(`Path traversal detected: ${path}`);
    }
    if (!existsSync(safePath)) {
      throw new Error(`File not found in snapshot: ${path}`);
    }
    const stat = statSync(safePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${path}`);
    }
    return readFileSync(safePath, "utf-8");
  }

  /**
   * Glob for files within the snapshot directory. READ-ONLY.
   */
  async glob(pattern: string): Promise<string[]> {
    // Simple glob implementation for within the snapshot
    const files: string[] = [];
    const walkDir = (currentDir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(currentDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = resolve(currentDir, entry);
        const relPath = relative(this.snapshotDir, fullPath);
        try {
          const st = statSync(fullPath);
          if (st.isDirectory()) {
            walkDir(fullPath);
          } else if (st.isFile()) {
            if (this.matchGlob(relPath, pattern)) {
              files.push(relPath);
            }
          }
        } catch {
          // Skip
        }
      }
    };

    if (existsSync(this.snapshotDir)) {
      walkDir(this.snapshotDir);
    }
    return files;
  }

  /**
   * Grep for patterns within snapshot files. READ-ONLY.
   */
  async grep(
    pattern: string,
    _files: string[],
    opts?: {
      ignoreCase?: boolean;
      maxMatches?: number;
      context?: number;
    },
  ): Promise<Array<{ file: string; line: number; content: string; beforeContext?: string[]; afterContext?: string[] }>> {
    const results: Array<{ file: string; line: number; content: string; beforeContext?: string[]; afterContext?: string[] }> = [];
    const regex = opts?.ignoreCase ? new RegExp(pattern, "gi") : new RegExp(pattern, "g");
    const maxMatches = opts?.maxMatches ?? 100;
    const contextLines = opts?.context ?? 0;

    const searchFile = (filePath: string) => {
      const fullPath = resolve(this.snapshotDir, filePath);
      if (!fullPath.startsWith(this.snapshotDir)) return;
      if (!existsSync(fullPath)) return;

      try {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxMatches) return;
          const line = lines[i]!;
          if (regex.test(line)) {
            const beforeCtx =
              contextLines > 0
                ? lines.slice(Math.max(0, i - contextLines), i)
                : undefined;
            const afterCtx =
              contextLines > 0
                ? lines.slice(i + 1, i + 1 + contextLines)
                : undefined;
            results.push({
              file: filePath,
              line: i + 1,
              content: line,
              beforeContext: beforeCtx?.map((l) => l ?? ""),
              afterContext: afterCtx?.map((l) => l ?? ""),
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    };

    // Search all files in the snapshot if no specific files given
    const filesToSearch = _files.length > 0 ? _files : await this.glob("**/*");
    for (const file of filesToSearch) {
      if (results.length >= maxMatches) break;
      searchFile(file);
    }

    return results;
  }

  /**
   * Check if a file exists in the snapshot.
   */
  exists(path: string): boolean {
    const fullPath = resolve(this.snapshotDir, path);
    if (!fullPath.startsWith(this.snapshotDir)) return false;
    return existsSync(fullPath);
  }

  /**
   * Get file stat from the snapshot.
   */
  stat(path: string): { isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number } | null {
    const fullPath = resolve(this.snapshotDir, path);
    if (!fullPath.startsWith(this.snapshotDir)) return null;
    try {
      const st = statSync(fullPath);
      return {
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  // ─── Simple glob matching ───────────────────────────────────────────

  private matchGlob(path: string, pattern: string): boolean {
    const normalizedPath = path.replace(/\\/g, "/");
    const normalizedPattern = pattern.replace(/\\/g, "/");

    const regexStr = normalizedPattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "___DOUBLESTAR___")
      .replace(/\*/g, "[^/]*")
      .replace(/___DOUBLESTAR___/g, ".*")
      .replace(/\?/g, ".");

    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(normalizedPath);
  }

  // ─── Blocked Write Operations ───────────────────────────────────────

  /**
   * Write is blocked on snapshot files.
   */
  async write(_path: string, _content: string): Promise<void> {
    throw new Error(
      "Cannot write to snapshot files. The snapshot is read-only. " +
        "Use /snapshot-sync to request changes to the master's snapshot.",
    );
  }

  /**
   * StrReplace is blocked on snapshot files.
   */
  async strReplace(_path: string, _old: string, _new: string): Promise<void> {
    throw new Error(
      "Cannot modify snapshot files. The snapshot is read-only. " +
        "Use /snapshot-sync to request changes to the master's snapshot.",
    );
  }
}

// ─── @snapshot: prefix resolver ─────────────────────────────────────────────

/**
 * Resolve a @snapshot: prefixed path to an actual snapshot file path.
 * If the path doesn't have the prefix, it's returned as-is (local filesystem path).
 */
export function resolveSnapshotPath(
  path: string,
  snapshotDir: string,
): { snapshotPath: string; isSnapshotRef: boolean } {
  if (path.startsWith("@snapshot:")) {
    const relPath = path.slice("@snapshot:".length);
    const fullPath = resolve(snapshotDir, relPath);
    return {
      snapshotPath: fullPath,
      isSnapshotRef: true,
    };
  }
  return {
    snapshotPath: path,
    isSnapshotRef: false,
  };
}
