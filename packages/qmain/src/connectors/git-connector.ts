import type { Qmain } from "../qmain.js";

/**
 * Result from git status
 */
export interface GitStatus {
  current: string;
  tracking: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
  conflicts: string[];
}

/**
 * Status of a single file in git
 */
export interface GitFileStatus {
  path: string;
  index: string;
  workingDir: string;
}

/**
 * Options for git log
 */
export interface GitLogOptions {
  maxCount?: number;
  path?: string;
}

/**
 * A single git commit
 */
export interface GitCommit {
  hash: string;
  date: string;
  message: string;
  authorName: string;
  authorEmail: string;
}

/**
 * Blame information for a line
 */
export interface GitBlameLine {
  line: number;
  commitHash: string;
  author: string;
  date: string;
  content: string;
}

/**
 * Options for GitConnector
 */
export interface GitConnectorOptions {
  /** Base directory for git operations. Defaults to qmain.getCwd() */
  baseDir?: string;
  /** Custom git binary path. Defaults to 'git' */
  gitBinary?: string;
}

/**
 * GitConnector — Git operations built on top of a Qmain instance.
 *
 * Uses the git CLI via Qmain.exec() for all operations,
 * avoiding a direct dependency on the simple-git library.
 */
export class GitConnector {
  private qmain: Qmain;
  private baseDir: string | undefined;
  private gitBinary: string;

  constructor(qmain: Qmain, opts?: GitConnectorOptions) {
    this.qmain = qmain;
    this.baseDir = opts?.baseDir;
    this.gitBinary = opts?.gitBinary ?? "git";
  }

  /**
   * Get repository status.
   */
  async status(): Promise<GitStatus> {
    const raw = await this.gitExec("status --porcelain=v2 --branch");
    const lines = raw.stdout.split("\n");

    let current = "";
    let tracking = "";
    let ahead = 0;
    let behind = 0;
    const files: GitFileStatus[] = [];
    const conflicts: string[] = [];

    for (const line of lines) {
      if (!line) continue;

      if (line.startsWith("# branch.head ")) {
        current = line.slice("# branch.head ".length).trim();
      } else if (line.startsWith("# branch.upstream ")) {
        tracking = line.slice("# branch.upstream ".length).trim();
      } else if (line.startsWith("# branch.ab ")) {
        const parts = line.slice("# branch.ab ".length).trim().split(" ");
        // Format: +N -M (ahead +behind)
        if (parts[0] === "+0") ahead = 0;
        else if (parts[0]?.startsWith("+")) ahead = parseInt(parts[0].slice(1), 10) || 0;
        else if (parts[0]) ahead = parseInt(parts[0], 10) || 0;
        if (parts[1] === "-0") behind = 0;
        else if (parts[1]?.startsWith("-")) behind = parseInt(parts[1].slice(1), 10) || 0;
        else if (parts[1]) behind = parseInt(parts[1], 10) || 0;
      } else if (line.startsWith("#")) {
        continue;
      } else if (line.startsWith("?")) {
        // Untracked file in v2 format: "? <path>"
        const path = line.slice(2).trim();
        files.push({ path, index: "?", workingDir: "?" });
      } else if (line.startsWith("1 ")) {
        // Regular entry: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
        const path = this.extractV2Field(line, 8);
        const xy = this.parseV2Field(line, 1, 2);
        files.push({ path, index: xy[0] ?? " ", workingDir: xy[1] ?? " " });
        if (xy.includes("U")) {
          conflicts.push(path);
        }
      } else if (line.startsWith("2 ")) {
        // Rename/copy entry: "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X> <score> <orig_path> <new_path>"
        const path = this.extractV2Field(line, 10);
        const xy = this.parseV2Field(line, 1, 2);
        files.push({ path, index: xy[0] ?? " ", workingDir: xy[1] ?? " " });
      } else if (line.startsWith("u ")) {
        // Unmerged entry: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
        const path = this.extractV2Field(line, 10);
        files.push({ path, index: "U", workingDir: "U" });
        conflicts.push(path);
      }
    }

    return { current, tracking, files, ahead, behind, conflicts };
  }

  /**
   * Get diff for a specific file or the whole working tree.
   */
  async diff(path?: string): Promise<string> {
    if (path) {
      const result = await this.gitExec(`diff -- ${shellQuote(path)}`);
      return result.stdout;
    }
    const result = await this.gitExec("diff");
    return result.stdout;
  }

  /**
   * Get staged diff.
   */
  async diffStaged(): Promise<string> {
    const result = await this.gitExec("diff --cached");
    return result.stdout;
  }

  /**
   * Get commit log.
   */
  async log(opts?: GitLogOptions): Promise<GitCommit[]> {
    const args = ["log", `--format=%H%n%aI%n%s%n%an%n%ae%x00`];
    if (opts?.maxCount) args.push(`--max-count=${opts.maxCount}`);
    if (opts?.path) args.push("--", opts.path);

    const result = await this.gitExec(args.join(" "));
    return this.parseLogOutput(result.stdout);
  }

  /**
   * Get blame information for a file.
   */
  async blame(path: string): Promise<GitBlameLine[]> {
    const result = await this.gitExec(`blame --line-porcelain -- ${shellQuote(path)}`);
    return this.parseBlameOutput(result.stdout);
  }

  /**
   * Get current branch name.
   */
  async branch(): Promise<string> {
    const result = await this.gitExec("branch --show-current");
    return result.stdout.trim();
  }

  /**
   * Stage files for commit.
   */
  async stage(files: string[]): Promise<void> {
    const fileList = files.map((f) => shellQuote(f)).join(" ");
    await this.gitExec(`add ${fileList}`);
  }

  /**
   * Commit staged changes.
   */
  async commit(message: string): Promise<void> {
    await this.gitExec(`commit -m ${shellQuote(message)}`);
  }

  /**
   * Stash changes with an optional name.
   */
  async stash(name?: string): Promise<void> {
    if (name) {
      await this.gitExec(`stash push -m ${shellQuote(name)}`);
    } else {
      await this.gitExec("stash push");
    }
  }

  /**
   * Pop the most recent stash.
   */
  async popStash(): Promise<void> {
    await this.gitExec("stash pop");
  }

  /**
   * Show the content of a specific ref.
   */
  async show(ref: string): Promise<string> {
    const result = await this.gitExec(`show ${shellQuote(ref)}`);
    return result.stdout;
  }

  /**
   * Get the root directory of the git repository.
   */
  async root(): Promise<string> {
    const result = await this.gitExec("rev-parse --show-toplevel");
    return result.stdout.trim();
  }

  /**
   * List files tracked by git matching a pattern.
   */
  async lsFiles(pattern?: string): Promise<string[]> {
    const args = pattern ? `ls-files -- ${shellQuote(pattern)}` : "ls-files";
    const result = await this.gitExec(args);
    return result.stdout.split("\n").filter((l) => l.length > 0);
  }

  /**
   * Manage git worktrees (add or remove).
   */
  async worktree(action: { add: { path: string; ref: string } } | { remove: { path: string } }): Promise<void> {
    if ("add" in action) {
      await this.gitExec(
        `worktree add ${shellQuote(action.add.path)} ${shellQuote(action.add.ref)}`,
      );
    } else if ("remove" in action) {
      await this.gitExec(`worktree remove ${shellQuote(action.remove.path)}`);
    }
  }

  /**
   * Check if the repository has uncommitted changes.
   */
  async isDirty(): Promise<boolean> {
    const result = await this.gitExec("status --porcelain");
    return result.stdout.trim().length > 0;
  }

  /**
   * Create a new branch and switch to it.
   */
  async createBranch(name: string): Promise<void> {
    await this.gitExec(`checkout -b ${shellQuote(name)}`);
  }

  /**
   * Execute a git command via Qmain.
   */
  private async gitExec(args: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const gitCmd = `${this.gitBinary} ${args}`;
    const result = await this.qmain.exec(gitCmd, this.baseDir ? { cwd: this.baseDir } : undefined);

    if (result.exitCode !== 0) {
      throw new Error(`Git command failed [${gitCmd}]: ${result.stderr || result.stdout || "(no output)"}`);
    }

    return result;
  }

  /**
   * Parse git log output.
   * Format: %H%n%aI%n%s%n%an%n%ae%x00  (null-separated records)
   */
  private parseLogOutput(output: string): GitCommit[] {
    const commits: GitCommit[] = [];
    const records = output.split("\0");

    for (const record of records) {
      if (!record.trim()) continue;

      // Split into max 5 parts so multi-line messages don't break field alignment.
      // We use %s (subject, single line) so split by \n gives exactly 5 parts.
      const parts = record.split("\n");
      // Filter to non-empty for the first 4 fields (hash, date, subject, author name)
      // Subject (%s) should never contain newlines, so this is safe.
      const nonEmpty = parts.filter((l) => l.length > 0);
      if (nonEmpty.length >= 5) {
        commits.push({
          hash: nonEmpty[0]!,
          date: nonEmpty[1]!,
          message: nonEmpty[2]!,
          authorName: nonEmpty[3]!,
          authorEmail: nonEmpty[4]!,
        });
      }
    }

    return commits;
  }

  /**
   * Parse git blame --line-porcelain output.
   *
   * Format for each block:
   *   <commit> <source-line> <result-line> <line-count>
   *   author <name>
   *   author-mail <mail>
   *   author-time <timestamp>
   *   author-tz <tz>
   *   committer <name>
   *   committer-mail <mail>
   *   committer-time <timestamp>
   *   committer-tz <tz>
   *   summary <line>
   *   filename <fname>
   *   \t<content>
   */
  private parseBlameOutput(output: string): GitBlameLine[] {
    const lines: GitBlameLine[] = [];
    const entries = output.split("\n");
    let currentCommit = "";
    let currentAuthor = "";
    let currentDate = "";
    let currentLine = 0;

    for (const entry of entries) {
      if (!entry) continue;

      // Header: <commit> <source-line> <result-line> <line-count>
      const headerMatch = entry.match(/^([a-f0-9]+)\s+(\d+)\s+(\d+)/);
      if (headerMatch) {
        currentCommit = headerMatch[1]!;
        // Use group 3 (result-line) — the line number in the current file
        currentLine = parseInt(headerMatch[3]!, 10);
        continue;
      }

      if (entry.startsWith("author ")) {
        currentAuthor = entry.slice("author ".length);
      } else if (entry.startsWith("author-time ")) {
        const ts = parseInt(entry.slice("author-time ".length), 10);
        currentDate = new Date(ts * 1000).toISOString();
      } else if (entry.startsWith("\t")) {
        // Content line
        lines.push({
          line: currentLine,
          commitHash: currentCommit,
          author: currentAuthor,
          date: currentDate,
          content: entry.slice(1),
        });
      }
    }

    return lines;
  }

  /**
   * Extract a field from a --porcelain=v2 line by field index (0-based).
   * Handles C-quoted paths (paths with spaces, tabs, etc.).
   */
  private extractV2Field(line: string, fieldIndex: number): string {
    const fields = this.splitV2Fields(line);
    return fields[fieldIndex] ?? "";
  }

  /**
   * Parse 2-character status field from a v2 line by character index.
   */
  private parseV2Field(line: string, index: number, length: number): string {
    const fields = this.splitV2Fields(line);
    const raw = fields[index] ?? "";
    return raw.slice(0, length);
  }

  /**
   * Split a --porcelain=v2 status line into fields, handling C-quoted strings.
   *
   * Git C-quoting wraps paths with spaces/special chars in double quotes
   * and escapes internal characters with backslash.
   */
  private splitV2Fields(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    let escapeNext = false;

    for (const char of line) {
      if (escapeNext) {
        current += char;
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }

      if (char === " " && !inQuotes) {
        if (current.length > 0) {
          fields.push(current);
          current = "";
        }
        continue;
      }

      current += char;
    }

    if (current.length > 0) {
      fields.push(current);
    }

    return fields;
  }
}

/**
 * POSIX-compatible shell quoting for use in sh -c strings.
 *
 * Wraps the argument in single quotes, handling embedded single quotes
 * by ending the quote, adding an escaped quote, and resuming.
 * This is safe against ALL shell injection — single-quoted strings
 * in sh/bash have no special characters whatsoever (no $, `, \, ! expansion).
 */
function shellQuote(arg: string): string {
  // Empty string needs special quoting
  if (arg.length === 0) return "''";

  // If the string contains only safe characters, return it unquoted
  if (/^[a-zA-Z0-9_./:@%^,+\-]+$/.test(arg)) {
    return arg;
  }

  // Single-quote the whole string, handling embedded single quotes
  // by ending the quote, adding \', and resuming:  It's O('"'"'ver)
  const quoted = arg.replace(/'/g, "'\\''");
  return `'${quoted}'`;
}
