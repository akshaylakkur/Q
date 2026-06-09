import { createHash } from "node:crypto";
import type { Qmain } from "../qmain.js";

/**
 * Options for FileConnector.read()
 */
export interface ReadOptions {
  /** Encoding to use. 'utf-8' returns string, 'buffer' returns Uint8Array. Default 'utf-8' */
  encoding?: "utf-8" | "buffer";
}

/**
 * Options for FileConnector.write()
 */
export interface WriteOptions {
  /** Whether to append instead of overwrite. Default false */
  append?: boolean;
}

/**
 * Options for FileConnector.grep()
 */
export interface GrepOptions {
  /** Number of lines of context before each match. Default 0 */
  beforeContext?: number;
  /** Number of lines of context after each match. Default 0 */
  afterContext?: number;
  /** Number of context lines both before and after. Overrides before/after if set */
  context?: number;
  /** Case-insensitive search. Default false */
  ignoreCase?: boolean;
  /** Maximum number of matches. Default unlimited */
  maxMatches?: number;
  /** Use fixed string matching instead of regex pattern. Default false */
  fixed?: boolean;
}

/**
 * A single grep match result
 */
export interface GrepMatch {
  file: string;
  line: number;
  content: string;
  beforeContext?: string[];
  afterContext?: string[];
}

/**
 * A snapshot of file contents for rollback support
 */
export interface SnapshotHandle {
  /** The paths that were snapshotted */
  paths: string[];
  /** Rollback all files to their snapshot state */
  rollback: () => Promise<void>;
}

/**
 * FileConnector — Higher-level file operations built on top of a Kaos instance.
 *
 * Provides read, write, edit, glob, grep, stat, mkdir, copy, move, delete,
 * and snapshot/rollback operations.
 */
export class FileConnector {
  private qmain: Qmain;

  constructor(qmain: Qmain) {
    this.qmain = qmain;
  }

  /**
   * Read file contents.
   */
  async read(path: string, opts?: ReadOptions): Promise<string | Uint8Array> {
    if (opts?.encoding === "buffer") {
      return this.qmain.readBytes(path);
    }
    return this.qmain.readText(path);
  }

  /**
   * Write content to a file.
   */
  async write(path: string, content: string | Uint8Array, opts?: WriteOptions): Promise<void> {
    if (opts?.append) {
      const existing = await this.qmain.readBytes(path).catch(() => new Uint8Array(0));
      const newContent =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content;
      const combined = new Uint8Array(existing.length + newContent.length);
      combined.set(existing, 0);
      combined.set(newContent, existing.length);
      await this.qmain.writeBytes(path, combined);
    } else if (typeof content === "string") {
      await this.qmain.writeText(path, content);
    } else {
      await this.qmain.writeBytes(path, content);
    }
  }

  /**
   * Edit a file by replacing a string with another.
   */
  async edit(path: string, oldStr: string, newStr: string): Promise<void> {
    const content = await this.qmain.readText(path);
    const updated = content.replace(oldStr, newStr);
    if (content === updated) {
      throw new Error(`String not found in file: ${path}`);
    }
    await this.qmain.writeText(path, updated);
  }

  /**
   * Glob files matching a pattern.
   */
  async glob(pattern: string, opts?: { cwd?: string }): Promise<string[]> {
    return this.qmain.glob(pattern, opts);
  }

  /**
   * Search for patterns in files using grep.
   * Falls back to in-memory search if `grep` is not available.
   */
  async grep(pattern: string, files: string[], opts?: GrepOptions): Promise<GrepMatch[]> {
    const c = opts?.context ?? 0;
    const beforeC = opts?.beforeContext ?? c;
    const afterC = opts?.afterContext ?? c;

    return this.grepInMemory(pattern, files, beforeC, afterC, opts);
  }

  /**
   * Get file/directory stats.
   */
  async stat(path: string): Promise<{ isFile: boolean; isDir: boolean; size: number; mtimeMs: number }> {
    return this.qmain.stat(path);
  }

  /**
   * Create a directory, optionally recursively.
   */
  async mkdir(path: string, recursive?: boolean): Promise<void> {
    await this.qmain.mkdir(path, { recursive: recursive ?? true });
  }

  /**
   * Copy a file from source to destination.
   */
  async copy(src: string, dest: string): Promise<void> {
    const data = await this.qmain.readBytes(src);
    await this.qmain.writeBytes(dest, data);
  }

  /**
   * Move (rename) a file from source to destination.
   */
  async move(src: string, dest: string): Promise<void> {
    const data = await this.qmain.readBytes(src);
    await this.qmain.writeBytes(dest, data);
    await this.delete(src);
  }

  /**
   * Delete a file or directory.
   */
  async delete(path: string): Promise<void> {
    // Use exec for recursive rm since Kaos doesn't have rm
    const st = await this.qmain.stat(path);
    if (st.isDir) {
      await this.qmain.exec(`rm -rf ${shellQuote(path)}`);
    } else {
      await this.qmain.exec(`rm -f ${shellQuote(path)}`);
    }
  }

  /**
   * Create a snapshot of files for rollback support.
   * Stores content hashes and raw content before modifications.
   */
  async snapshot(paths: string[]): Promise<SnapshotHandle> {
    const entries: Map<string, { hash: string; content: string | Uint8Array; isText: boolean }> = new Map();

    for (const filePath of paths) {
      try {
        const isText = await this.isTextFile(filePath);
        let content: string | Uint8Array;
        if (isText) {
          content = await this.qmain.readText(filePath);
        } else {
          content = await this.qmain.readBytes(filePath);
        }
        const hash = createHash("sha256")
          .update(typeof content === "string" ? content : Buffer.from(content))
          .digest("hex");
        entries.set(filePath, { hash, content, isText });
      } catch {
        // File doesn't exist yet — that's fine, snapshot will record it as absent
        entries.set(filePath, { hash: "", content: "", isText: true });
      }
    }

    const snapshotPaths = [...entries.keys()];

    return {
      paths: snapshotPaths,
      rollback: async () => {
        for (const filePath of snapshotPaths) {
          const entry = entries.get(filePath);
          if (!entry) continue;
          if (entry.hash === "") {
            // File didn't exist at snapshot time — delete it
            try {
              await this.delete(filePath);
            } catch {
              // Ignore deletion errors during rollback
            }
          } else if (entry.isText) {
            await this.qmain.writeText(filePath, entry.content as string);
          } else {
            await this.qmain.writeBytes(filePath, entry.content as Uint8Array);
          }
        }
      },
    };
  }

  /**
   * Check if a file is likely a text file by reading its first bytes.
   */
  private async isTextFile(path: string): Promise<boolean> {
    try {
      const ext = path.split(".").pop()?.toLowerCase();
      if (ext && ["png", "jpg", "jpeg", "gif", "ico", "bin", "exe", "dll", "so", "dylib", "zip", "gz", "tar", "pdf"].includes(ext)) {
        return false;
      }
      const content = await this.qmain.readBytes(path);
      // Check for null bytes — likely binary
      for (let i = 0; i < Math.min(content.length, 1024); i++) {
        if (content[i] === 0) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * In-memory grep fallback when no grep binary is available.
   */
  private async grepInMemory(
    pattern: string,
    files: string[],
    beforeContext: number,
    afterContext: number,
    opts?: GrepOptions,
  ): Promise<GrepMatch[]> {
    const matches: GrepMatch[] = [];
    const flags = opts?.ignoreCase ? "i" : "";
    const regex = opts?.fixed
      ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
      : new RegExp(pattern, flags);

    for (const file of files) {
      try {
        const content = await this.qmain.readText(file);
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          if (opts?.maxMatches && matches.length >= opts.maxMatches) {
            return matches;
          }

          const lineContent = lines[i];
          if (lineContent !== undefined && regex.test(lineContent)) {
            const beforeLines: string[] = [];
            const afterLines: string[] = [];

            for (let b = Math.max(0, i - beforeContext); b < i; b++) {
              const bl = lines[b];
              if (bl !== undefined) beforeLines.push(bl);
            }
            for (let a = i + 1; a <= Math.min(lines.length - 1, i + afterContext); a++) {
              const al = lines[a];
              if (al !== undefined) afterLines.push(al);
            }

            const matchContent = lines[i];
            if (matchContent === undefined) continue;

            matches.push({
              file,
              line: i + 1,
              content: matchContent,
              beforeContext: beforeLines.length > 0 ? beforeLines : undefined,
              afterContext: afterLines.length > 0 ? afterLines : undefined,
            });
          }
        }
      } catch {
        // Skip files that can't be read
        continue;
      }
    }

    return matches;
  }
}

/**
 * POSIX-compatible shell quoting for use in sh -c strings.
 * Wraps the argument in single quotes, handling embedded single quotes.
 */
function shellQuote(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[a-zA-Z0-9_./:@%^,+\-]+$/.test(arg)) {
    return arg;
  }
  const quoted = arg.replace(/'/g, "'\\''");
  return `'${quoted}'`;
}
