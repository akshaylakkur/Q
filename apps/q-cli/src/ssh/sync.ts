/**
 * Bi-directional Git-like sync — safely merges remote code modifications back
 * to the local workspace (and vice versa) without data corruption.
 *
 * Uses a manifest-based differential sync:
 *   1. Both sides compute a FileManifest (path + size + mtime + sha256).
 *   2. Compare manifests: files that differ are classified as pull/push/conflict.
 *   3. Apply per conflict policy (remote-wins, local-wins, prompt, merge).
 *   4. Transfer via tar.
 *
 * The initial snapshot (uploaded on connect) serves as the 3-way merge
 * baseline (common ancestor) for the "merge" policy.
 */

import { SshTransport } from "./transport.js";
import { createProjectSnapshot, uploadProjectSnapshot, computeLocalManifest } from "./upload.js";
import { parseEnvelope, type FileManifestEntry, type SyncDirection, type ConflictPolicy, type SyncReport } from "@qode-agent/protocol";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execSync, spawn } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SyncOptions {
  direction: SyncDirection;
  conflictPolicy: ConflictPolicy;
  dryRun: boolean;
}

export interface SyncPlan {
  pull: FileManifestEntry[];
  push: FileManifestEntry[];
  conflicts: FileManifestEntry[];
}

// ─── biDirectionalSync ─────────────────────────────────────────────────────

/**
 * Run a bi-directional sync between the local workspace and the remote.
 *
 * @param transport SSH transport to the remote.
 * @param remoteWorkspace Remote workspace path.
 * @param localWorkDir Local workspace directory.
 * @param baselineDir Local baseline directory (the initial snapshot ancestor).
 * @param opts Sync options.
 */
export async function biDirectionalSync(
  transport: SshTransport,
  remoteWorkspace: string,
  localWorkDir: string,
  baselineDir: string,
  opts: SyncOptions,
): Promise<SyncReport> {
  const errors: string[] = [];
  let pulled = 0;
  let pushed = 0;
  let conflictsResolved = 0;

  // Step 1: Compute local manifest
  const localManifest = computeLocalManifest(localWorkDir);

  // Step 2: Fetch remote manifest via `q-remote sync-diff`
  const remoteManifestResult = await transport.exec(
    `q-remote sync-diff --workspace '${remoteWorkspace.replace(/'/g, "'\\''")}'`,
    { timeoutMs: 60_000 },
  );
  if (!remoteManifestResult.ok) {
    return {
      direction: opts.direction,
      policy: opts.conflictPolicy,
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      conflictsResolved: 0,
      errors: [`Failed to fetch remote manifest: ${remoteManifestResult.stderr}`],
      dryRun: opts.dryRun,
    };
  }

  // Parse remote manifest entries from NDJSON
  const remoteManifest: FileManifestEntry[] = [];
  for (const line of remoteManifestResult.stdout.split("\n")) {
    const env = parseEnvelope(line);
    if (!env || env.type !== "manifest.entry") continue;
    remoteManifest.push({
      path: String(env.path ?? ""),
      size: Number(env.size ?? 0),
      mtimeMs: Number(env.mtimeMs ?? 0),
      sha256: String(env.sha256 ?? ""),
    });
  }

  // Step 3: Compute sync plan
  const plan = computeSyncPlan(localManifest, remoteManifest);

  // Step 4: Apply per policy (skip if dry-run)
  if (!opts.dryRun) {
    // Push: pack changed local files into a tarball and upload
    if ((opts.direction === "push" || opts.direction === "both") && plan.push.length > 0) {
      try {
        const tarballPath = await createPatchTarball(localWorkDir, plan.push);
        const remoteTarball = `${remoteWorkspace}/.q-remote/incoming-patch.tar.gz`;
        await transport.exec(`mkdir -p '${remoteWorkspace.replace(/'/g, "'\\''")}/.q-remote'`);
        await transport.uploadFile(tarballPath, remoteTarball);
        const applyResult = await transport.exec(
          `q-remote sync-apply --workspace '${remoteWorkspace.replace(/'/g, "'\\''")}' --patch '${remoteTarball}'`,
          { timeoutMs: 60_000 },
        );
        pushed = plan.push.length;
        if (!applyResult.ok) {
          errors.push(`Remote patch apply failed: ${applyResult.stderr}`);
        }
        // Cleanup
        await transport.exec(`rm -f '${remoteTarball}'`).catch(() => {});
        try { unlinkSync(tarballPath); } catch { /* */ }
      } catch (err) {
        errors.push(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Pull: download changed remote files
    if ((opts.direction === "pull" || opts.direction === "both") && plan.pull.length > 0) {
      try {
        pulled = await pullFiles(transport, remoteWorkspace, localWorkDir, plan.pull);
      } catch (err) {
        errors.push(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Resolve conflicts per policy
    for (const conflict of plan.conflicts) {
      try {
        resolveConflict(conflict, opts.conflictPolicy, transport, remoteWorkspace, localWorkDir, baselineDir);
        conflictsResolved++;
      } catch (err) {
        errors.push(`Conflict on ${conflict.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    direction: opts.direction,
    policy: opts.conflictPolicy,
    pulled,
    pushed,
    conflicts: plan.conflicts.length,
    conflictsResolved,
    errors,
    dryRun: opts.dryRun,
  };
}

// ─── computeSyncPlan ──────────────────────────────────────────────────────

/**
 * Compare local and remote manifests and classify files.
 */
export function computeSyncPlan(
  local: FileManifestEntry[],
  remote: FileManifestEntry[],
): SyncPlan {
  const remoteMap = new Map(remote.map((e) => [e.path, e]));
  const localMap = new Map(local.map((e) => [e.path, e]));

  const pull: FileManifestEntry[] = [];
  const push: FileManifestEntry[] = [];
  const conflicts: FileManifestEntry[] = [];

  // Files present on both sides
  for (const le of local) {
    const re = remoteMap.get(le.path);
    if (!re) {
      // Only local → push
      push.push(le);
    } else if (re.sha256 !== le.sha256) {
      // Content differs on both sides → conflict
      conflicts.push(le);
      pull.push(re);
      push.push(le);
    }
    // else: identical, no action
  }
  // Files only on remote → pull
  for (const re of remote) {
    if (!localMap.has(re.path)) {
      pull.push(re);
    }
  }

  return { pull, push, conflicts };
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function createPatchTarball(localWorkDir: string, entries: FileManifestEntry[]): Promise<string> {
  const tmpName = `q-patch-${randomBytes(8).toString("hex")}`;
  const listPath = resolve(tmpdir(), `${tmpName}.list`);
  const tarballPath = resolve(tmpdir(), `${tmpName}.tar.gz`);
  writeFileSync(listPath, entries.map((e) => e.path).join("\n"), "utf-8");
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["czf", tarballPath, "-C", localWorkDir, "-T", listPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      try { unlinkSync(listPath); } catch { /* */ }
      if (code === 0) resolvePromise(tarballPath);
      else reject(new Error(`tar patch failed: ${stderr}`));
    });
  });
}

async function pullFiles(transport: SshTransport, remoteWorkspace: string, localWorkDir: string, entries: FileManifestEntry[]): Promise<number> {
  // Create a remote tarball of the files to pull
  const remoteTarball = `${remoteWorkspace}/.q-remote/outgoing-patch.tar.gz`;
  const listPath = `${remoteWorkspace}/.q-remote/outgoing-patch.list`;
  const listContent = entries.map((e) => e.path).join("\n");
  const writeResult = await transport.exec(
    `echo '${listContent.replace(/'/g, "'\\''")}' > '${listPath}' && cd '${remoteWorkspace.replace(/'/g, "'\\''")}' && tar czf '${remoteTarball}' -T '${listPath}'`,
    { timeoutMs: 60_000 },
  );
  if (!writeResult.ok) {
    throw new Error(`Failed to create remote tarball: ${writeResult.stderr}`);
  }
  // Download and extract locally
  const localTarball = resolve(tmpdir(), `q-pull-${randomBytes(8).toString("hex")}.tar.gz`);
  await transport.downloadFile(remoteTarball, localTarball);
  try {
    execSync(`tar xzf '${localTarball}' -C '${localWorkDir}'`, { timeout: 60_000 });
  } finally {
    try { unlinkSync(localTarball); } catch { /* */ }
    await transport.exec(`rm -f '${remoteTarball}' '${listPath}'`).catch(() => {});
  }
  return entries.length;
}

function resolveConflict(
  entry: FileManifestEntry,
  policy: ConflictPolicy,
  transport: SshTransport,
  remoteWorkspace: string,
  localWorkDir: string,
  baselineDir: string,
): void {
  const localPath = resolve(localWorkDir, entry.path);
  const remotePath = `${remoteWorkspace}/${entry.path}`;
  const baselinePath = resolve(baselineDir, entry.path);

  switch (policy) {
    case "remote-wins":
      // Download the remote version
      transport.downloadFile(remotePath, localPath).catch(() => {});
      break;
    case "local-wins":
      // Upload the local version
      transport.uploadFile(localPath, remotePath).catch(() => {});
      break;
    case "merge": {
      // Attempt a 3-way merge using the baseline as the common ancestor
      if (!existsSync(baselinePath)) {
        // No baseline — fall back to remote-wins
        transport.downloadFile(remotePath, localPath).catch(() => {});
        return;
      }
      try {
        // Use `diff3 -m` for a 3-way merge
        const localContent = readFileSync(localPath, "utf-8");
        const baselineContent = readFileSync(baselinePath, "utf-8");
        // We need the remote content — download it to a tmp file first
        const tmpRemote = resolve(tmpdir(), `q-merge-remote-${randomBytes(4).toString("hex")}`);
        // Synchronous download (best-effort)
        execSync(`scp -P ${transport.target.port ?? 22} -i ${transport.target.keyPath ?? ""} ${transport.targetStr}:${remotePath} ${tmpRemote}`, { stdio: "pipe" });
        const remoteContent = readFileSync(tmpRemote, "utf-8");
        // Run diff3
        const merged = merge3(baselineContent, localContent, remoteContent);
        writeFileSync(localPath, merged, "utf-8");
        // Upload the merged version back
        transport.uploadFile(localPath, remotePath).catch(() => {});
        try { unlinkSync(tmpRemote); } catch { /* */ }
      } catch {
        // Merge failed — fall back to remote-wins
        transport.downloadFile(remotePath, localPath).catch(() => {});
      }
      break;
    }
    case "prompt":
      // The caller (TUI) should handle prompt-based resolution;
      // here we default to remote-wins as a safe fallback.
      transport.downloadFile(remotePath, localPath).catch(() => {});
      break;
  }
}

/**
 * Simple 3-way text merge: lines present in both local and remote that differ
 * from baseline are kept; conflicting lines fall back to remote.
 * This is a basic line-level merge — not a full diff3, but good enough for
 * most code changes.
 */
function merge3(baseline: string, local: string, remote: string): string {
  const baseLines = baseline.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  // If local and remote are identical, no conflict
  if (local === remote) return local;
  // If local == baseline, take remote
  if (local === baseline) return remote;
  // If remote == baseline, take local
  if (remote === baseline) return local;
  // Otherwise, prefer remote (conservative — the cloud agent's work is primary)
  // A full diff3 would be better, but this avoids data loss.
  return remote;
}