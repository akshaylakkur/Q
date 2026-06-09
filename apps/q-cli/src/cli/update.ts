import chalk from "chalk";
import type { Command } from "commander";
import { existsSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { getQHome } from "./config-discover.js";

const REPO_URL = "https://github.com/akshaylakkur/Q.git";
const Q_HOME = getQHome();
const BUILD_DIR = resolve(Q_HOME, "build");
const BIN_DIR = resolve(Q_HOME, "bin");
const UPDATE_DIR = resolve(Q_HOME, "update");

/**
 * `q-cli update` — Pull the latest source from GitHub, build, and install.
 *
 * 1. Clones (or pulls) the repository into ~/.Q/update/
 * 2. Installs dependencies and builds the full project
 * 3. Copies the freshly built artifacts to ~/.Q/build/
 * 4. Verifies the binary works
 */
export async function updateCommand(): Promise<void> {
  console.log(chalk.bold("Qode — Self Update"));
  console.log();

  // ── Prerequisites ──────────────────────────────────────────────────
  const prereqs = checkPrerequisites();
  if (!prereqs.ok) {
    console.log(chalk.red(`  ✗ ${prereqs.error}`));
    process.exit(1);
  }
  console.log(chalk.dim(`  Node: ${prereqs.nodeVersion}`));
  console.log(chalk.dim(`  pnpm: ${prereqs.pnpmVersion}`));
  console.log(chalk.dim(`  Git: ${prereqs.gitVersion}`));
  console.log();

  // ── 1. Fetch source from GitHub ───────────────────────────────────
  console.log(chalk.cyan("  [1/4] Fetching source from GitHub..."));
  const sourceDir = await fetchSource();
  if (!sourceDir) {
    console.log(chalk.red("  ✗ Failed to fetch source from GitHub."));
    process.exit(1);
  }
  console.log(chalk.green(`  ✓ Source fetched to ${sourceDir}`));
  console.log();

  // ── 2. Install dependencies ────────────────────────────────────────
  console.log(chalk.cyan("  [2/4] Installing dependencies..."));
  try {
    execSync("pnpm install --frozen-lockfile", {
      cwd: sourceDir,
      stdio: "inherit",
      timeout: 120_000,
    });
  } catch {
    // Fall back to regular install if frozen-lockfile fails
    console.log(chalk.yellow("  ⚠ Frozen lockfile failed, trying regular install..."));
    try {
      execSync("pnpm install", {
        cwd: sourceDir,
        stdio: "inherit",
        timeout: 120_000,
      });
    } catch (err) {
      console.log(chalk.red(`  ✗ Failed to install dependencies.`));
      process.exit(1);
    }
  }
  console.log(chalk.green("  ✓ Dependencies installed"));
  console.log();

  // ── 3. Build ───────────────────────────────────────────────────────
  console.log(chalk.cyan("  [3/4] Building packages and CLI..."));
  try {
    execSync("pnpm build:packages", {
      cwd: sourceDir,
      stdio: "inherit",
      timeout: 180_000,
    });
    console.log(chalk.dim("    Packages built"));
  } catch (err) {
    console.log(chalk.red(`  ✗ Failed to build packages.`));
    process.exit(1);
  }

  try {
    execSync("pnpm build", {
      cwd: sourceDir,
      stdio: "inherit",
      timeout: 180_000,
    });
    console.log(chalk.dim("    CLI built"));
  } catch (err) {
    console.log(chalk.red(`  ✗ Failed to build CLI.`));
    process.exit(1);
  }

  const builtBinary = resolve(sourceDir, "apps/q-cli/dist/main.mjs");
  if (!existsSync(builtBinary)) {
    console.log(chalk.red(`  ✗ Build did not produce ${builtBinary}`));
    process.exit(1);
  }
  console.log(chalk.green("  ✓ Build successful"));
  console.log();

  // ── 4. Install to ~/.Q/build/ ──────────────────────────────────────
  console.log(chalk.cyan("  [4/4] Installing to ~/.Q/..."));

  // Remove old build and create fresh
  if (existsSync(BUILD_DIR)) {
    rmSync(BUILD_DIR, { recursive: true, force: true });
  }
  mkdirSync(BUILD_DIR, { recursive: true });

  // Copy dist
  const distDir = resolve(sourceDir, "apps/q-cli/dist");
  if (existsSync(distDir)) {
    const targetDist = resolve(BUILD_DIR, "apps/q-cli/dist");
    mkdirSync(targetDist, { recursive: true });
    cpSync(distDir, targetDist, { recursive: true, force: true });
  }

  // Copy agent-core YAML profiles (for profile loader walk-up)
  const profilesSource = resolve(sourceDir, "packages/agent-core/dist/profiles");
  if (existsSync(profilesSource)) {
    const targetProfiles = resolve(BUILD_DIR, "apps/q-cli/dist/profiles");
    mkdirSync(targetProfiles, { recursive: true });
    cpSync(profilesSource, targetProfiles, { recursive: true, force: true });
  }

  // Symlink node_modules
  const projectNodeModules = resolve(sourceDir, "node_modules");
  if (existsSync(projectNodeModules)) {
    const targetLink = resolve(BUILD_DIR, "node_modules");
    if (existsSync(targetLink)) {
      rmSync(targetLink, { recursive: true, force: true });
    }
    // Use junction/symlink based on platform
    try {
      if (process.platform === "win32") {
        execSync(`mklink /J "${targetLink}" "${projectNodeModules}"`, { stdio: "ignore" });
      } else {
        execSync(`ln -sfn "${projectNodeModules}" "${targetLink}"`, { stdio: "ignore" });
      }
    } catch {
      // Fallback: copy instead of symlink
      console.log(chalk.yellow("  ⚠ Could not create symlink, copying node_modules..."));
      cpSync(projectNodeModules, targetLink, { recursive: true, force: true });
    }
  }

  // Ensure the q-cli wrapper script exists
  const wrapperPath = resolve(BIN_DIR, "q-cli");
  if (!existsSync(wrapperPath)) {
    // Recreate the wrapper
    const wrapperContent = [
      '#!/usr/bin/env bash',
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'BUILD_DIR="$(cd "${SCRIPT_DIR}/../build" && pwd)"',
      'MAIN_BINARY="${BUILD_DIR}/apps/q-cli/dist/main.mjs"',
      'export NODE_PATH="${BUILD_DIR}/node_modules:${NODE_PATH:-}"',
      'export Q_CLI_HOME="${BUILD_DIR}"',
      'exec node "${MAIN_BINARY}" "$@"',
      '',
    ].join("\n");
    mkdirSync(BIN_DIR, { recursive: true });
    writeFileSync(wrapperPath, wrapperContent, "utf-8");
    try {
      execSync(`chmod +x "${wrapperPath}"`, { stdio: "ignore" });
    } catch {
      // non-fatal
    }

    // Also create 'q' shorthand
    const shortcutPath = resolve(BIN_DIR, "q");
    if (!existsSync(shortcutPath)) {
      try {
        execSync(`ln -sfn "q-cli" "${shortcutPath}"`, { stdio: "ignore" });
      } catch {
        // non-fatal
      }
    }
  }

  console.log(chalk.green("  ✓ Installed to ~/.Q/"));
  console.log();

  // ── Cleanup update directory ───────────────────────────────────────
  try {
    rmSync(UPDATE_DIR, { recursive: true, force: true });
  } catch {
    // non-fatal
  }

  // ── Verify ─────────────────────────────────────────────────────────
  console.log(chalk.cyan("  Verifying installation..."));
  try {
    const versionOut = execSync(`node "${builtBinary}" --version`, {
      cwd: sourceDir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    console.log(chalk.green(`  ✓ Binary executes correctly (${versionOut})`));
  } catch {
    console.log(chalk.yellow("  ⚠ Could not verify binary execution"));
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log();
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(chalk.bold.green("  ✓ Update complete!"));
  console.log();
  console.log(chalk.dim(`  Built from: ${REPO_URL}`));
  console.log(chalk.dim(`  Installed to: ${BUILD_DIR}`));
  console.log();
  console.log(chalk.cyan("  Run 'q-cli --version' to see the new version."));
  console.log();
}

/**
 * Check prerequisites: Node.js, pnpm, git.
 */
function checkPrerequisites(): {
  ok: boolean;
  error?: string;
  nodeVersion?: string;
  pnpmVersion?: string;
  gitVersion?: string;
} {
  try {
    const nodeVer = execSync("node --version", { encoding: "utf-8", timeout: 5_000 }).trim();
    const pnpmVer = execSync("pnpm --version", { encoding: "utf-8", timeout: 5_000 }).trim();
    let gitVer = "not found";
    try {
      gitVer = execSync("git --version", { encoding: "utf-8", timeout: 5_000 }).trim();
    } catch {
      // git is optional but recommended
    }
    return { ok: true, nodeVersion: nodeVer, pnpmVersion: pnpmVer, gitVersion: gitVer };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Prerequisite check failed: ${msg}` };
  }
}

/**
 * Fetch the source repository into ~/.Q/update/.
 * If the directory already exists, git pull; otherwise git clone.
 */
async function fetchSource(): Promise<string | null> {
  // Ensure parent directory exists
  mkdirSync(UPDATE_DIR, { recursive: true });

  const repoDir = resolve(UPDATE_DIR, "Q");

  try {
    if (existsSync(repoDir)) {
      // Already cloned — pull latest
      console.log(chalk.dim(`    Repository exists at ${repoDir}, pulling latest...`));
      execSync("git pull --rebase", {
        cwd: repoDir,
        stdio: "inherit",
        timeout: 60_000,
      });
    } else {
      // Fresh clone
      console.log(chalk.dim(`    Cloning from ${REPO_URL}...`));
      execSync(`git clone "${REPO_URL}" "${repoDir}"`, {
        cwd: UPDATE_DIR,
        stdio: "inherit",
        timeout: 120_000,
      });
    }
    return repoDir;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`    Git operation failed: ${msg}`));
    return null;
  }
}

/**
 * Register the `q-cli update` command with Commander.
 */
export function registerUpdateCommand(prog: Command): void {
  prog
    .command("update")
    .description("Self-update: pull latest source from GitHub, build, and install")
    .action(async () => {
      await updateCommand().catch((err: Error) => {
        console.error(chalk.red("Update command error:"), err.message);
        process.exit(1);
      });
    });
}