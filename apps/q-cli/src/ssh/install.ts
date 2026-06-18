/**
 * Remote install — ensures q-remote is installed on the remote server.
 *
 * Two install methods:
 *   1. **npm-based** (production): installs @qode-agent/q-remote from the
 *      npm registry via `npm install -g @qode-agent/q-remote@<version>`.
 *      This is the default and preferred method.
 *   2. **tarball-based** (development): uploads a local tarball and installs
 *      via `npm install -g <tarball>`. Used when testing local changes.
 *
 * Installation is idempotent: if `q-remote version` already matches the
 * target version, the install is skipped.
 */

import { SshTransport } from "./transport.js";
import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NpmInstallOptions {
  /** npm package version to install (e.g. "0.2.9"). Default reads from local package.json. */
  version?: string;
}

export interface TarballInstallOptions {
  /** Path to the local tarball file. */
  qRemoteTarballPath: string;
  /** Remote directory to upload the tarball to. Default ~/q-remote-install/ */
  remoteInstallDir?: string;
}

export type InstallMethod =
  | { type: "npm"; opts: NpmInstallOptions }
  | { type: "tarball"; opts: TarballInstallOptions };

export interface EnsureReadyOptions {
  /** Install method: "npm" (default) or "tarball". */
  method?: InstallMethod;
}

export interface EnsureReadyResult {
  installed: boolean;
  version: string;
  /** True if the install was skipped (already up-to-date). */
  skipped: boolean;
}

const REQUIRED_NODE_MAJOR = 22;
const REQUIRED_NODE_MINOR = 19;

// ─── ensureRemoteReady ──────────────────────────────────────────────────────

/**
 * Ensure the remote has Node >= 22.19 and q-remote installed.
 * Throws on fatal errors (Node missing, install failure).
 */
export async function ensureRemoteReady(
  t: SshTransport,
  opts?: EnsureReadyOptions,
): Promise<EnsureReadyResult> {
  const method = opts?.method ?? { type: "npm", opts: {} };

  // Step 1: Check Node version
  const nodeCheck = await t.exec("node --version", { timeoutMs: 10_000 });
  if (!nodeCheck.ok || !nodeCheck.stdout.trim()) {
    throw new Error(
      "Node.js is not installed on the remote server (or not on PATH). " +
        `QSSH requires Node >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}. ` +
        "Install Node.js on the remote before proceeding: https://nodejs.org/",
    );
  }
  const nodeVer = nodeCheck.stdout.trim();
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

  // Step 2: Determine target version
  const targetVersion = method.type === "npm"
    ? (method.opts.version ?? getLocalPackageVersion())
    : extractVersionFromTarballName(method.opts.qRemoteTarballPath);

  // Step 3: Check if q-remote is already installed and matches
  const existingVersion = await t.exec("q-remote version", { timeoutMs: 10_000 });
  if (existingVersion.ok) {
    const ver = existingVersion.stdout.trim();
    if (targetVersion && ver === targetVersion) {
      return { installed: false, version: ver, skipped: true };
    }
  }

  // Step 4: Install
  if (method.type === "npm") {
    await installFromNpm(t, targetVersion);
  } else {
    await installFromTarball(t, method.opts);
  }

  // Step 5: Verify
  const verify = await t.exec("q-remote version", { timeoutMs: 10_000 });
  if (!verify.ok) {
    throw new Error(
      "q-remote installed but 'q-remote version' failed. " +
        "Check that the npm global bin directory is on the remote PATH.",
    );
  }

  return { installed: true, version: verify.stdout.trim(), skipped: false };
}

// ─── Install Methods ────────────────────────────────────────────────────────

/**
 * Install q-remote from the npm registry.
 */
async function installFromNpm(
  t: SshTransport,
  version: string | null,
): Promise<void> {
  const pkgSpec = version
    ? `@qode-agent/q-remote@${version}`
    : "@qode-agent/q-remote";

  const installResult = await t.exec(
    `sudo npm install -g '${pkgSpec}' 2>&1`,
    { timeoutMs: 120_000 },
  );
  if (!installResult.ok) {
    throw new Error(
      `npm install -g ${pkgSpec} failed on remote:\n${installResult.stderr || installResult.stdout}`,
    );
  }
}

/**
 * Install q-remote from a local tarball (development/testing).
 */
async function installFromTarball(
  t: SshTransport,
  opts: TarballInstallOptions,
): Promise<void> {
  const remoteDir = opts.remoteInstallDir ?? "~/q-remote-install";

  if (!existsSync(opts.qRemoteTarballPath)) {
    throw new Error(`q-remote tarball not found: ${opts.qRemoteTarballPath}. Run 'pnpm build:remote' first.`);
  }

  // Resolve ~ to the remote home directory
  const remoteHome = await t.exec("echo ~", { timeoutMs: 5_000 });
  const resolvedDir = remoteDir.startsWith("~/")
    ? remoteHome.stdout.trim() + remoteDir.slice(1)
    : remoteDir;
  const remoteTarballPath = `${resolvedDir}/${basename(opts.qRemoteTarballPath)}`;

  await t.exec(`mkdir -p '${resolvedDir.replace(/'/g, "'\\''")}'`);
  await t.uploadFile(opts.qRemoteTarballPath, remoteTarballPath);

  const installResult = await t.exec(
    `sudo npm install -g '${remoteTarballPath}' 2>&1`,
    { timeoutMs: 120_000 },
  );
  if (!installResult.ok) {
    throw new Error(
      `npm install -g failed on remote:\n${installResult.stderr || installResult.stdout}`,
    );
  }

  // Cleanup the uploaded tarball (best-effort)
  await t.exec(`rm -f '${remoteTarballPath}'`).catch(() => {});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseNodeVersion(ver: string): { major: number; minor: number; patch: number } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(ver);
  if (!m) return null;
  return { major: parseInt(m[1]!, 10), minor: parseInt(m[2]!, 10), patch: parseInt(m[3]!, 10) };
}

function extractVersionFromTarballName(path: string): string | null {
  const m = /(?:qode-agent-)?q-remote-(\d+\.\d+\.\d+)\.tgz$/.exec(path);
  return m?.[1] ?? null;
}

/**
 * Read the local q-remote package.json to get the current version.
 * This is used as the default target version for npm-based installs.
 */
function getLocalPackageVersion(): string | null {
  try {
    const candidates = [
      resolve(process.cwd(), "packages/q-remote/package.json"),
      resolve(import.meta.dirname, "../../../packages/q-remote/package.json"),
      resolve(import.meta.dirname, "../../packages/q-remote/package.json"),
      "/Users/akshaylakkur/Projects/Agents/Q/packages/q-remote/package.json",
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        return pkg.version ?? null;
      }
    }
    return null;
  } catch {
    return null;
  }
}