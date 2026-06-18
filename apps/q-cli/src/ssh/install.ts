/**
 * Remote install — uploads the q-remote tarball to the remote server and
 * installs it globally via `npm install -g`.
 *
 * The tarball is produced by `npm pack` (see pack.ts / scripts/build-q-remote.sh).
 * Installation is idempotent: if `q-remote version` already matches, skip.
 */

import { SshTransport } from "./transport.js";
import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";

// ─── ensureRemoteReady ──────────────────────────────────────────────────────

export interface EnsureReadyOptions {
  qRemoteTarballPath: string;
  /** Remote directory to upload the tarball to. Default ~/q-remote-install/ */
  remoteInstallDir?: string;
}

export interface EnsureReadyResult {
  installed: boolean;
  version: string;
  /** True if the install was skipped (already up-to-date). */
  skipped: boolean;
}

const REQUIRED_NODE_MAJOR = 22;
const REQUIRED_NODE_MINOR = 19;

/**
 * Ensure the remote has Node >= 22.19 and q-remote installed.
 * Throws on fatal errors (Node missing, install failure).
 */
export async function ensureRemoteReady(
  t: SshTransport,
  opts: EnsureReadyOptions,
): Promise<EnsureReadyResult> {
  const remoteDir = opts.remoteInstallDir ?? "~/q-remote-install";

  // Step 1: Check Node version
  const nodeCheck = await t.exec("node --version", { timeoutMs: 10_000 });
  if (!nodeCheck.ok || !nodeCheck.stdout.trim()) {
    throw new Error(
      "Node.js is not installed on the remote server (or not on PATH). " +
        `QSSH requires Node >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}. ` +
        "Install Node.js on the remote before proceeding: https://nodejs.org/",
    );
  }
  const nodeVer = nodeCheck.stdout.trim(); // e.g. "v22.19.0"
  const parsed = parseNodeVersion(nodeVer);
  if (!parsed) {
    throw new Error(`Could not parse remote Node version: ${nodeVer}`);
  }
  if (parsed.major < REQUIRED_NODE_MAJOR || (parsed.major === REQUIRED_NODE_MAJOR && parsed.minor < REQUIRED_NODE_MINOR)) {
    throw new Error(
      `Remote Node version ${nodeVer} is too old. QSSH requires Node >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}. ` +
        "Upgrade Node on the remote before proceeding.",
    );
  }

  // Step 2: Check if q-remote is already installed and matches
  const existingVersion = await t.exec("q-remote version", { timeoutMs: 10_000 });
  if (existingVersion.ok) {
    const ver = existingVersion.stdout.trim();
    // Read the tarball version from the filename or package.json
    const tarballVersion = extractVersionFromTarballName(opts.qRemoteTarballPath);
    if (tarballVersion && ver === tarballVersion) {
      return { installed: false, version: ver, skipped: true };
    }
  }

  // Step 3: Upload the tarball
  if (!existsSync(opts.qRemoteTarballPath)) {
    throw new Error(`q-remote tarball not found: ${opts.qRemoteTarballPath}. Run 'pnpm build:remote' first.`);
  }
  // Resolve ~ to the remote home directory (scp doesn't expand ~ on the remote side)
  const remoteHome = await t.exec("echo ~", { timeoutMs: 5_000 });
  const resolvedDir = remoteDir.startsWith("~/") ? remoteHome.stdout.trim() + remoteDir.slice(1) : remoteDir;
  const remoteTarballPath = `${resolvedDir}/${basename(opts.qRemoteTarballPath)}`;
  await t.exec(`mkdir -p '${resolvedDir.replace(/'/g, "'\\''")}'`);
  await t.uploadFile(opts.qRemoteTarballPath, remoteTarballPath);

  // Step 4: Install globally (use sudo if needed for /usr/lib/node_modules)
  const installResult = await t.exec(
    `sudo npm install -g '${remoteTarballPath}' 2>&1`,
    { timeoutMs: 120_000 },
  );
  if (!installResult.ok) {
    throw new Error(
      `npm install -g failed on remote:\n${installResult.stderr || installResult.stdout}`,
    );
  }

  // Step 5: Verify
  const verify = await t.exec("q-remote version", { timeoutMs: 10_000 });
  if (!verify.ok) {
    throw new Error(
      "q-remote installed but 'q-remote version' failed. " +
        "Check that the npm global bin directory is on the remote PATH.",
    );
  }

  // Step 6: Cleanup the uploaded tarball (best-effort)
  await t.exec(`rm -f '${remoteTarballPath}'`).catch(() => {});

  return { installed: true, version: verify.stdout.trim(), skipped: false };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseNodeVersion(ver: string): { major: number; minor: number; patch: number } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(ver);
  if (!m) return null;
  return { major: parseInt(m[1]!, 10), minor: parseInt(m[2]!, 10), patch: parseInt(m[3]!, 10) };
}

function extractVersionFromTarballName(path: string): string | null {
  // qode-agent-q-remote-0.1.0.tgz (scoped) or q-remote-0.1.0.tgz (unscoped)
  const m = /(?:qode-agent-)?q-remote-(\d+\.\d+\.\d+)\.tgz$/.exec(path);
  return m?.[1] ?? null;
}