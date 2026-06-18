/**
 * Project snapshot — creates a streamlined, dependency-ignored tarball of the
 * local project filesystem for upload to the remote server.
 *
 * Respects .gitignore + a built-in always-ignore list (node_modules, .git,
 * dist, .q, .env, etc.). The snapshot is the initial workspace state;
 * subsequent syncs are differential (see sync.ts).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import ignore from "ignore";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { SshTransport } from "./transport.js";

// ─── Constants ────────────────────────────────────────────────────────────────

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
  ".vitest-results/**",
  ".tmp*",
];

// ─── createProjectSnapshot ──────────────────────────────────────────────────

/**
 * Create a tar.gz snapshot of the project at workDir, respecting ignores.
 * Returns the path to the local tarball.
 */
export function createProjectSnapshot(
  workDir: string,
  opts?: { extraIgnore?: string[] },
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const ig = ignore();
    ig.add(ALWAYS_IGNORE);
    if (opts?.extraIgnore) ig.add(opts.extraIgnore);

    // Load .gitignore if present
    const gitignorePath = resolve(workDir, ".gitignore");
    if (existsSync(gitignorePath)) {
      ig.add(readFileSync(gitignorePath, "utf-8"));
    }

    // Build the list of files to include by walking the directory
    const files: string[] = [];
    walkDir(workDir, "", ig, files);

    // Write the file list to a tmp file, then tar with -T
    const tmpName = `q-snapshot-${randomBytes(8).toString("hex")}`;
    const listPath = resolve(tmpdir(), `${tmpName}.list`);
    const tarballPath = resolve(tmpdir(), `${tmpName}.tar.gz`);
    writeFileSync(listPath, files.join("\n"), "utf-8");

    // Use tar with -T (files-from) and -C (directory) to create the tarball
    const tarArgs = ["czf", tarballPath, "-C", workDir, "-T", listPath];
    const child = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      try { unlinkSync(listPath); } catch { /* */ }
      if (code === 0) resolvePromise(tarballPath);
      else reject(new Error(`tar snapshot failed (exit ${code}): ${stderr}`));
    });
    child.on("error", reject);
  });
}

/**
 * Upload a project snapshot tarball to the remote workspace via tar|ssh pipe.
 */
export async function uploadProjectSnapshot(
  t: SshTransport,
  localTarball: string,
  remoteWorkspace: string,
): Promise<void> {
  // Resolve ~ to the remote home directory (scp doesn't expand ~ on the remote side)
  const remoteHome = await t.exec("echo ~", { timeoutMs: 5_000 });
  const resolvedWorkspace = remoteWorkspace.startsWith("~/")
    ? remoteHome.stdout.trim() + remoteWorkspace.slice(1)
    : remoteWorkspace;

  // Ensure remote workspace exists
  const mkdirResult = await t.exec(`mkdir -p '${resolvedWorkspace.replace(/'/g, "'\\''")}'`);
  if (!mkdirResult.ok) throw new Error(`Failed to create remote workspace: ${mkdirResult.stderr}`);

  // Extract the tarball on the remote via ssh pipe
  return new Promise((resolvePromise, reject) => {
    // We use scp for the tarball — simpler than piping
    t.uploadFile(localTarball, `${resolvedWorkspace}/.q-snapshot.tar.gz`)
      .then(() => t.exec(`cd '${resolvedWorkspace.replace(/'/g, "'\\''")}' && tar xzf .q-snapshot.tar.gz && rm -f .q-snapshot.tar.gz`))
      .then((result) => {
        if (result.ok) resolvePromise();
        else reject(new Error(`Remote snapshot extract failed: ${result.stderr}`));
      })
      .catch(reject);
  });
}

// ─── computeLocalManifest ────────────────────────────────────────────────────

/**
 * Compute a file manifest for the local workspace (used by sync).
 */
export function computeLocalManifest(
  workDir: string,
  opts?: { extraIgnore?: string[] },
): { path: string; size: number; mtimeMs: number; sha256: string }[] {
  const ig = ignore();
  ig.add(ALWAYS_IGNORE);
  if (opts?.extraIgnore) ig.add(opts.extraIgnore);

  const gitignorePath = resolve(workDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf-8"));
  }

  const files: { path: string; size: number; mtimeMs: number; sha256: string }[] = [];
  const paths: string[] = [];
  walkDir(workDir, "", ig, paths);
  for (const relPath of paths) {
    const absPath = resolve(workDir, relPath);
    try {
      const st = statSync(absPath);
      const sha = hashFile(absPath);
      files.push({ path: relPath, size: st.size, mtimeMs: st.mtimeMs, sha256: sha });
    } catch {
      // skip unreadable
    }
  }
  return files;
}

// ─── Internal ──────────────────────────────────────────────────────────────────

function walkDir(root: string, relDir: string, ig: ignore.Ignore, files: string[]): void {
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
      walkDir(root, relPath, ig, files);
    } else if (st.isFile()) {
      files.push(relPath);
    }
  }
}

function hashFile(absPath: string): string {
  try {
    const h = createHash("sha256");
    h.update(readFileSync(absPath));
    return h.digest("hex");
  } catch {
    return "";
  }
}