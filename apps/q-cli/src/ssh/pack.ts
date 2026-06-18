/**
 * Build + pack the q-remote tarball for upload to the remote server.
 *
 * Since q-remote is not published to npm, the local q-cli must build it,
 * pack a tarball via `npm pack`, and upload it. This module handles the
 * "is the tarball stale?" check + build + pack flow.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

// Walk up from the script dir to find the monorepo root (look for packages/q-remote)
function findMonorepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "packages/q-remote/package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Check Q_CLI_HOME env var (set by the q-cli wrapper script)
  const cliHome = process.env.Q_CLI_HOME;
  if (cliHome && existsSync(resolve(cliHome, "packages/q-remote/package.json"))) return cliHome;
  // Check the known project path
  const knownProject = "/Users/akshaylakkur/Projects/Agents/Q";
  if (existsSync(resolve(knownProject, "packages/q-remote/package.json"))) return knownProject;
  // Fallback: assume we're in apps/q-cli/dist (3 levels up from dist)
  return resolve(start, "../../..");
}
const ROOT = findMonorepoRoot(import.meta.dirname);
const DIST_PACKS = resolve(ROOT, "dist-packs");
const QREMOTE_SRC = resolve(ROOT, "packages/q-remote/src");

// ─── ensureQRemoteTarball ─────────────────────────────────────────────────

export interface EnsureTarballOptions {
  /** Force rebuild even if tarball exists and is fresh. */
  force?: boolean;
}

/**
 * Ensure the q-remote tarball exists in dist-packs/ and is up-to-date.
 * Returns the path to the tarball.
 */
export function ensureQRemoteTarball(opts?: EnsureTarballOptions): string {
  mkdirSync(DIST_PACKS, { recursive: true });

  // Find existing tarball
  const existing = findTarball();
  if (existing && !opts?.force) {
    const tarballMtime = statSync(existing).mtimeMs;
    if (isSourceNewerThan(QREMOTE_SRC, tarballMtime)) {
      // Stale — rebuild
      buildAndPack();
      return findTarball()!;
    }
    return existing;
  }

  buildAndPack();
  return findTarball()!;
}

// ─── Internal ────────────────────────────────────────────────────────────────

function findTarball(): string | null {
  if (!existsSync(DIST_PACKS)) return null;
  for (const name of readdirSync(DIST_PACKS)) {
    if (/^(q-remote|qode-agent-q-remote)-\d+\.\d+\.\d+\.tgz$/.test(name)) {
      return join(DIST_PACKS, name);
    }
  }
  return null;
}

function isSourceNewerThan(dir: string, thresholdMs: number): boolean {
  if (!existsSync(dir)) return false;
  function walk(d: string): boolean {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (walk(p)) return true;
      } else if (st.mtimeMs > thresholdMs) {
        return true;
      }
    }
    return false;
  }
  return walk(dir);
}

function buildAndPack(): void {
  const pkgDir = resolve(ROOT, "packages/q-remote");
  const pkgJsonPath = resolve(pkgDir, "package.json");

  // Build the q-remote package
  execSync("pnpm --filter @qode-agent/q-remote build", {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 120_000,
  });

  // Strip workspace:* deps before packing (they're all bundled into dist/)
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  const origDeps = { ...(pkg.dependencies || {}) };
  for (const [k, v] of Object.entries(pkg.dependencies || {})) {
    if (v === "workspace:*") delete pkg.dependencies[k];
  }
  delete pkg.devDependencies;
  const origContent = readFileSync(pkgJsonPath, "utf-8");
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

  // Pack it into dist-packs/
  execSync("npm pack --pack-destination ../../dist-packs", {
    cwd: pkgDir,
    stdio: "inherit",
    timeout: 60_000,
  });

  // Restore original package.json
  writeFileSync(pkgJsonPath, origContent);
}