/**
 * q-remote sync-server — handles the file-manifest and patch-apply side of
 * the bi-directional sync protocol.
 *
 * The remote computes a {@link FileManifest} (path + size + mtime + sha256)
 * for the workspace, respecting `.gitignore` and a `.q-remote-ignore` file.
 * The local side compares manifests and decides what to pull/push.
 */

import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve, relative, dirname, join } from "node:path";
import { createReadStream } from "node:fs";
import type { FileManifest, FileManifestEntry } from "@qode-agent/protocol";
import ignore from "ignore";

// ─── Constants ─────────────────────────────────────────────────────────────

const ALWAYS_IGNORE = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "dist-native/**",
  ".q/**",
  ".q-remote/**",
  "*.log",
  ".env",
  ".env.*",
  "!.env.example",
  ".DS_Store",
  "Thumbs.db",
  "__pycache__/**",
  "*.tsbuildinfo",
  "coverage/**",
  ".pnpm-store/**",
];

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
    const ig = ignore();
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

  private walk(root: string, relDir: string, ig: ignore.Ignore, entries: FileManifestEntry[]): void {
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