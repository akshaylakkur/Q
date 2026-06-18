/**
 * q-remote sync-server — handles the file-manifest and patch-apply side of
 * the bi-directional sync protocol.
 *
 * The remote computes a {@link FileManifest} (path + size + mtime + sha256)
 * for the workspace, respecting `.gitignore` and a `.q-remote-ignore` file.
 * The local side compares manifests and decides what to pull/push.
 *
 * ── NOTE ─────────────────────────────────────────────────────────────────
 * We use a simple inline ignore-matcher instead of the `ignore` npm package
 * because the CJS/ESM interop breaks when bundled by tsdown/rolldown.
 * The implementation is minimal but sufficient for our use case.
 */

import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve, relative, dirname, join } from "node:path";
import { createReadStream } from "node:fs";
import type { FileManifest, FileManifestEntry } from "@qode-agent/protocol";

// ─── Constants ─────────────────────────────────────────────────────────────

const ALWAYS_IGNORE = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "dist-native/**",
  ".q/**",
  ".q-remote/**",
  ".npm/**",
  ".pnpm-store/**",
  ".cache/**",
  ".local/**",
  ".config/**",
  "*.log",
  ".env",
  ".env.*",
  "!.env.example",
  ".DS_Store",
  "Thumbs.db",
  "__pycache__/**",
  "*.tsbuildinfo",
  "coverage/**",
  "*.pyc",
  "*.pyo",
  "snap/**",
  "go/**",
  ".cargo/**",
  "rustup/**",
  ".rustup/**",
];

// ─── Simple Ignore Matcher ─────────────────────────────────────────────────

/**
 * A minimal gitignore-style pattern matcher.
 * Supports: *, **, ?, [chars], ! negation, # comments, leading /
 * Does NOT support: [a-z] ranges, {a,b} alternation
 */
class IgnoreMatcher {
  private rules: Array<{ pattern: string; negate: boolean; regex: RegExp }> = [];

  add(patterns: string | string[]): void {
    const list = Array.isArray(patterns) ? patterns : patterns.split("\n");
    for (const line of list) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      let pattern = trimmed;
      let negate = false;

      // Negation
      if (pattern.startsWith("!")) {
        negate = true;
        pattern = pattern.slice(1);
      }

      // Track whether the pattern was anchored to root (leading /)
      // In gitignore: only a leading / anchors to root.
      // Patterns without leading / match at any depth in the tree.
      const anchoredToRoot = pattern.startsWith("/");
      if (anchoredToRoot) {
        pattern = pattern.slice(1);
      }

      // Convert glob pattern to regex
      const regex = this.globToRegex(pattern, anchoredToRoot);
      this.rules.push({ pattern: trimmed, negate, regex });
    }
  }

  ignores(path: string): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.regex.test(path)) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  }

  private globToRegex(pattern: string, anchoredToRoot: boolean): RegExp {
    // In gitignore:
    //   - Patterns with a leading / are anchored to the repo root
    //   - Patterns WITHOUT a leading / match at ANY depth in the tree
    //   - node_modules/** should match foo/bar/node_modules/baz too
    // So if not anchoredToRoot, we prefix with (^|.*/) to match anywhere

    let regexStr = anchoredToRoot ? "^" : "(^|.*/)";
    let i = 0;

    while (i < pattern.length) {
      const ch = pattern[i];

      if (ch === "*" && i + 1 < pattern.length && pattern[i + 1] === "*") {
        // ** matches everything including path separators
        if (i + 2 < pattern.length && pattern[i + 2] === "/") {
          // **/ at start or after / means match any depth
          regexStr += "(?:.+/)?";
          i += 3;
        } else if (i > 0 && pattern[i - 1] === "/") {
          // /** at end means match everything inside
          regexStr += ".+";
          i += 2;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else if (ch === "*") {
        // * matches anything except /
        regexStr += "[^/]*";
        i++;
      } else if (ch === "?") {
        regexStr += "[^/]";
        i++;
      } else if (ch === ".") {
        regexStr += "\\.";
        i++;
      } else if (ch === "[") {
        // Character class - simplified, just match the bracket literally
        const end = pattern.indexOf("]", i + 1);
        if (end === -1) {
          regexStr += "\\[";
          i++;
        } else {
          regexStr += pattern.slice(i, end + 1);
          i = end + 1;
        }
      } else {
        // Escape special regex chars
        if ("+(){}^$|\\".includes(ch)) {
          regexStr += "\\";
        }
        regexStr += ch;
        i++;
      }
    }

    regexStr += "$";
    return new RegExp(regexStr);
  }
}

// ─── SyncServer ─────────────────────────────────────────────────────────────

export class SyncServer {
  readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  /**
   * Compute the file manifest for the workspace.
   * Respects .gitignore + .q-remote-ignore + built-in always-ignore list.
   */
  async computeManifest(): Promise<FileManifest> {
    const ig = new IgnoreMatcher();
    ig.add(ALWAYS_IGNORE);

    // Load .gitignore if present
    const gitignorePath = resolve(this.workspace, ".gitignore");
    if (existsSync(gitignorePath)) {
      ig.add(readFileSync(gitignorePath, "utf-8"));
    }

    // Load .q-remote-ignore if present (additional exclusions)
    const remoteIgnorePath = resolve(this.workspace, ".q-remote-ignore");
    if (existsSync(remoteIgnorePath)) {
      ig.add(readFileSync(remoteIgnorePath, "utf-8"));
    }

    const entries: FileManifestEntry[] = [];
    this.walk(this.workspace, "", ig, entries);
    return {
      workspace: this.workspace,
      entries,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Apply a tarball patch received from the local side.
   * The patch is a .tar.gz whose contents are relative paths to overwrite.
   * Files in the tarball that match existing files will be replaced.
   */
  async applyPatch(tarballPath: string): Promise<{ applied: number; errors: string[] }> {
    const errors: string[] = [];
    let applied = 0;
    try {
      // We use the system `tar` to extract — it handles all edge cases.
      const { execSync } = await import("node:child_process");
      execSync(`tar xzf "${tarballPath}" -C "${this.workspace}"`, {
        stdio: "pipe",
        timeout: 60_000,
      });
      // Count files in the tarball to report how many were applied
      const list = execSync(`tar tzf "${tarballPath}"`, { encoding: "utf-8" });
      applied = list.split("\n").filter((l) => l.trim() && !l.trim().endsWith("/")).length;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    return { applied, errors };
  }

  /**
   * Compute a diff between the local manifest and the provided remote manifest.
   * Returns files that differ (changed content or mtime), plus files only on
   * one side.
   */
  computeDiff(localManifest: FileManifest, remoteManifest: FileManifest): {
    pull: FileManifestEntry[]; // files that exist on remote but differ locally
    push: FileManifestEntry[]; // files that exist locally but differ remotely
    onlyLocal: FileManifestEntry[];
    onlyRemote: FileManifestEntry[];
  } {
    const remoteMap = new Map(remoteManifest.entries.map((e) => [e.path, e]));
    const localMap = new Map(localManifest.entries.map((e) => [e.path, e]));

    const pull: FileManifestEntry[] = [];
    const push: FileManifestEntry[] = [];
    const onlyLocal: FileManifestEntry[] = [];
    const onlyRemote: FileManifestEntry[] = [];

    for (const le of localManifest.entries) {
      const re = remoteMap.get(le.path);
      if (!re) {
        onlyLocal.push(le);
        push.push(le);
      } else if (re.sha256 !== le.sha256) {
        // Content differs — needs resolution
        push.push(le);
        pull.push(re);
      }
      // else: identical, no action
    }
    for (const re of remoteManifest.entries) {
      if (!localMap.has(re.path)) {
        onlyRemote.push(re);
        pull.push(re);
      }
    }

    return { pull, push, onlyLocal, onlyRemote };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private walk(root: string, relDir: string, ig: IgnoreMatcher, entries: FileManifestEntry[]): void {
    const absDir = resolve(root, relDir);
    let items: string[];
    try {
      items = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of items) {
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (ig.ignores(relPath)) continue;
      const absPath = join(absDir, name);
      let st;
      try {
        st = statSync(absPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        this.walk(root, relPath, ig, entries);
      } else if (st.isFile()) {
        const sha = this.hashFile(absPath);
        entries.push({
          path: relPath,
          size: st.size,
          mtimeMs: st.mtimeMs,
          sha256: sha,
        });
      }
      // Skip symlinks, sockets, etc.
    }
  }

  private hashFile(absPath: string): string {
    try {
      const h = createHash("sha256");
      const stream = createReadStream(absPath);
      // Synchronous hash for simplicity (files are typically small)
      const buf = readFileSync(absPath);
      h.update(buf);
      return h.digest("hex");
    } catch {
      return "";
    }
  }
}