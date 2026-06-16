#!/usr/bin/env node
/**
 * install.js — Platform detection and binary installation for qode-agent.
 *
 * This script runs after `npm install qode-agent` (or `npm install -g qode-agent`).
 * It detects the user's platform, finds the correct optional dependency
 * package, and symlinks/copies the binary into place.
 *
 * The platform-specific packages (@qode-agent/darwin-arm64, @qode-agent/darwin-x64,
 * @qode-agent/win32-x64) are listed as optionalDependencies in the main qode-agent
 * package. npm will install the matching one automatically.
 */

const { platform, arch } = process;
const { existsSync, chmodSync, copyFileSync, mkdirSync, symlinkSync } = require("fs");
const { join } = require("path");

const PLATFORM_MAP = {
  "darwin-arm64": "@qode-agent/darwin-arm64",
  "darwin-x64": "@qode-agent/darwin-x64",
  "win32-x64": "@qode-agent/win32-x64",
};

const key = `${platform}-${arch}`;
const pkg = PLATFORM_MAP[key];

if (!pkg) {
  console.error(
    `[qode-agent] Unsupported platform: ${key}. ` +
    `Supported platforms: darwin-arm64, darwin-x64, win32-x64`
  );
  process.exit(1);
}

// The optional dependency should be installed alongside this package
// in node_modules. We look for it relative to the package root.
const pkgRoot = join(__dirname, "..");
const binaryDir = join(pkgRoot, "node_modules", pkg, "bin");
const binaryName = platform === "win32" ? "qode.exe" : "qode";
const binaryPath = join(binaryDir, binaryName);

if (!existsSync(binaryPath)) {
  // Also try the pnpm store / hoisted location
  const altBinaryDir = join(pkgRoot, "..", pkg, "bin");
  const altBinaryPath = join(altBinaryDir, binaryName);
  if (existsSync(altBinaryPath)) {
    // Found in hoisted location
    const targetDir = join(pkgRoot, "bin");
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, binaryName);
    if (platform === "win32") {
      copyFileSync(altBinaryPath, targetPath);
    } else {
      try {
        symlinkSync(altBinaryPath, targetPath);
      } catch {
        copyFileSync(altBinaryPath, targetPath);
      }
    }
    chmodSync(targetPath, 0o755);
    console.log(`[qode-agent] Installed binary for ${key}`);
    process.exit(0);
  }

  console.error(
    `[qode-agent] Binary not found for ${key}. ` +
    `This may happen if the optional dependency failed to install. ` +
    `Try: npm install ${pkg}`
  );
  process.exit(1);
}

// Create the bin directory and symlink/copy
const targetDir = join(pkgRoot, "bin");
mkdirSync(targetDir, { recursive: true });
const targetPath = join(targetDir, binaryName);

// On Windows, copy; on macOS/Linux, symlink
if (platform === "win32") {
  copyFileSync(binaryPath, targetPath);
} else {
  try {
    symlinkSync(binaryPath, targetPath);
  } catch {
    copyFileSync(binaryPath, targetPath);
  }
}

chmodSync(targetPath, 0o755);
console.log(`[qode-agent] Installed binary for ${key}`);
