/**
 * QollabSnapshotStore — Manages snapshot creation, storage, and retrieval.
 *
 * On `q-cli collab init`, the master's project files are scanned (respecting
 * .gitignore and .qignore patterns) and uploaded as the initial snapshot.
 * Snapshots are stored as tarballs with a manifest JSON sidecar.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  createReadStream,
  createWriteStream,
  unlinkSync,
} from "node:fs";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { basename } from "node:path";
import type {
  SnapshotFileEntry,
  SnapshotManifest,
  QollabSnapshot,
} from "../types.js";
import type { SnapshotCreateOptions, HashedFileEntry, SnapshotScanOptions } from "./types.js";

// ─── Default ignore patterns ────────────────────────────────────────────────

const DEFAULT_IGNORE_PATTERNS = [
  "node_modules/**",
  ".git/**",
  ".Q/**",
  ".q-remote/**",
  "dist/**",
  ".next/**",
  "build/**",
  "*.log",
  ".DS_Store",
  "**/.DS_Store",
];

// ─── QollabSnapshotStore ────────────────────────────────────────────────────

export class QollabSnapshotStore {
  private readonly snapshotsDir: string;
  private readonly ignorePatterns: string[];

  constructor(dataDir: string, ignorePatterns?: string[]) {
    this.snapshotsDir = resolve(dataDir, "snapshots");
    this.ignorePatterns = ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;

    if (!existsSync(this.snapshotsDir)) {
      mkdirSync(this.snapshotsDir, { recursive: true });
    }
  }

  /**
   * Create a snapshot from a directory (e.g., the master's project).
   * Scans files, creates a tarball, and returns the snapshot metadata.
   */
  async createFromDirectory(
    projectDir: string,
    options: SnapshotCreateOptions,
    scanOptions?: Partial<SnapshotScanOptions>,
  ): Promise<QollabSnapshot> {
    const snapshotId = randomUUID();
    const files = await this.scanDirectory(projectDir, scanOptions);

    // Create tarball
    const tarPath = resolve(this.snapshotsDir, `${snapshotId}.tar.gz`);
    await this.createTarball(projectDir, files, tarPath);

    // Build manifest
    const changedFiles: string[] = [];
    if (options.parentSnapshotId) {
      const parent = await this.loadSnapshotManifest(options.parentSnapshotId);
      if (parent) {
        for (const file of files) {
          const parentFile = parent.fileEntries.find((f) => f.path === file.path);
          if (!parentFile || parentFile.sha256 !== file.sha256) {
            changedFiles.push(file.path);
          }
        }
      }
    }

    const manifest: SnapshotManifest = {
      totalFiles: files.length,
      totalSizeBytes: files.reduce((acc, f) => acc + (f.size ?? 0), 0),
      changedFiles,
      commitMessage: options.commitMessage,
    };

    // Store
    const storedDir = resolve(this.snapshotsDir, snapshotId);
    if (!existsSync(storedDir)) {
      mkdirSync(storedDir, { recursive: true });
    }
    writeFileSync(join(storedDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(storedDir, "files.json"), JSON.stringify(files, null, 2));

    return {
      snapshotId,
      sessionId: options.sessionId,
      createdAt: new Date().toISOString(),
      createdBy: options.createdBy,
      fileEntries: files,
      parentSnapshotId: options.parentSnapshotId,
      manifest,
    };
  }

  /**
   * Load a snapshot's file entries from its stored files.json.
   */
  loadSnapshotManifest(snapshotId: string): QollabSnapshot | null {
    const dir = resolve(this.snapshotsDir, snapshotId);
    if (!existsSync(dir)) return null;

    const manifestPath = join(dir, "manifest.json");
    const filesPath = join(dir, "files.json");
    if (!existsSync(manifestPath) || !existsSync(filesPath)) return null;

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as SnapshotManifest;
      const files = JSON.parse(readFileSync(filesPath, "utf-8")) as SnapshotFileEntry[];
      return {
        snapshotId,
        sessionId: "",
        createdAt: "",
        createdBy: "",
        fileEntries: files,
        manifest,
      };
    } catch {
      return null;
    }
  }

  /**
   * Load snapshot files from tarball for operations.
   */
  getSnapshotDir(snapshotId: string): string {
    return resolve(this.snapshotsDir, snapshotId);
  }

  /**
   * Get the path to a snapshot's stored directory.
   */
  getSnapshotTarballPath(snapshotId: string): string {
    return resolve(this.snapshotsDir, `${snapshotId}.tar.gz`);
  }

  /**
   * Extract a snapshot to a target directory.
   */
  async extractSnapshot(snapshotId: string, targetDir: string): Promise<void> {
    const tarPath = this.getSnapshotTarballPath(snapshotId);
    if (!existsSync(tarPath)) {
      throw new Error(`Snapshot tarball not found: ${snapshotId}`);
    }

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Use Node.js built-in zlib + tar-like extraction.
    // Since we stored as gzipped JSON lines-style, we need to actually
    // reconstruct from the files.json manifest for simplicity.
    const snapshot = this.loadSnapshotManifest(snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot manifest not found: ${snapshotId}`);
    }

    for (const entry of snapshot.fileEntries) {
      const filePath = resolve(targetDir, entry.path);
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      let content: string;
      if (entry.encoding === "base64") {
        content = Buffer.from(entry.content, "base64").toString("utf-8");
      } else {
        content = entry.content;
      }

      writeFileSync(filePath, content, "utf-8");
    }
  }

  /**
   * Scan a directory for files to include in a snapshot.
   */
  private async scanDirectory(
    dir: string,
    scanOptions?: Partial<SnapshotScanOptions>,
  ): Promise<SnapshotFileEntry[]> {
    const maxFileSize = scanOptions?.maxFileSizeBytes ?? 10 * 1024 * 1024; // 10 MB default
    const maxTotalFiles = scanOptions?.maxTotalFiles ?? 10000;
    const ignorePatterns = scanOptions?.ignorePatterns ?? this.ignorePatterns;

    const entries: SnapshotFileEntry[] = [];
    const rootDir = resolve(dir);

    const walkDir = (currentDir: string) => {
      let files: string[];
      try {
        files = readdirSync(currentDir);
      } catch {
        return; // Permission denied, skip
      }

      for (const file of files) {
        const filePath = join(currentDir, file);
        const relPath = relative(rootDir, filePath);

        // Check ignore patterns
        if (this.isIgnored(relPath, ignorePatterns)) continue;

        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(filePath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          walkDir(filePath);
        } else if (stat.isFile()) {
          if (stat.size > maxFileSize) continue; // Skip too-large files
          if (entries.length >= maxTotalFiles) return;

          const content = readFileSync(filePath);
          const sha256 = createHash("sha256").update(content).digest("hex");

          entries.push({
            path: relPath,
            content: content.toString("base64"),
            sha256,
            size: stat.size,
            encoding: "base64",
          });
        }
      }
    };

    walkDir(rootDir);
    return entries;
  }

  /**
   * Create a tarball from scanned file entries.
   * We use a simple tar-like format: gzipped concatenation of JSON lines
   * with file entries. This is simpler than true tar and avoids extra deps.
   */
  private async createTarball(
    baseDir: string,
    files: SnapshotFileEntry[],
    outputPath: string,
  ): Promise<void> {
    const output = createWriteStream(outputPath);
    const gzip = createGzip();

    for (const file of files) {
      const filePath = resolve(baseDir, file.path);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath);
        // Write a JSON manifest line per file
        const header = JSON.stringify({
          path: file.path,
          size: content.length,
          sha256: file.sha256,
        });
        await new Promise<void>((resolvePromise, reject) => {
          gzip.write(header + "\n", (err) => {
            if (err) reject(err);
            else resolvePromise();
          });
        });
      }
    }

    gzip.end();
    await pipeline(gzip, output);
  }

  /**
   * Check if a path matches any ignore pattern.
   * Simple glob matching — supports **, *, and ?.
   */
  private isIgnored(path: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (this.matchGlob(path, pattern)) return true;
    }
    return false;
  }

  /**
   * Simple glob pattern matching.
   */
  private matchGlob(path: string, pattern: string): boolean {
    // Normalize path separators
    const normalizedPath = path.replace(/\\/g, "/");
    const normalizedPattern = pattern.replace(/\\/g, "/");

    // Convert glob pattern to regex
    const regexStr = normalizedPattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "___DOUBLESTAR___")
      .replace(/\*/g, "[^/]*")
      .replace(/___DOUBLESTAR___/g, ".*")
      .replace(/\?/g, ".");

    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(normalizedPath);
  }

  /**
   * Delete a snapshot and its artifacts.
   */
  deleteSnapshot(snapshotId: string): void {
    const dir = resolve(this.snapshotsDir, snapshotId);
    if (existsSync(dir)) {
      // Recursive delete
      const deleteDir = (d: string) => {
        for (const entry of readdirSync(d)) {
          const p = join(d, entry);
          if (statSync(p).isDirectory()) {
            deleteDir(p);
          } else {
            unlinkSync(p);
          }
        }
      };
      deleteDir(dir);
    }

    const tarPath = this.getSnapshotTarballPath(snapshotId);
    if (existsSync(tarPath)) {
      unlinkSync(tarPath);
    }
  }
}

// ─── Helper: dirname for path ─────────────────────────────────────────

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  const idx2 = p.lastIndexOf("\\");
  const last = Math.max(idx, idx2);
  return last >= 0 ? p.slice(0, last) : ".";
}
