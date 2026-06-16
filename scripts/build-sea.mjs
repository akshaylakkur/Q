#!/usr/bin/env node
/**
 * build-sea.mjs — Build a Single Executable Application (SEA) binary.
 *
 * Usage:
 *   node scripts/build-sea.mjs
 *
 * Prerequisites:
 *   - Node.js >= 22.19.0 (with --experimental-sea-config support)
 *   - postject installed (npm install -g postject or in node_modules)
 *
 * Output:
 *   dist-native/qode          (macOS/Linux)
 *   dist-native/qode.exe      (Windows)
 */

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, arch } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist-native");
const SEA_CONFIG = join(DIST, "sea-config.json");
const SEA_BLOB = join(DIST, "sea-prep.blob");
const NODE_BINARY = process.execPath;

const TARGET = `${platform()}-${arch()}`;

console.log(`[sea] Building SEA binary for ${TARGET}`);
console.log(`[sea] Node.js: ${process.version} at ${NODE_BINARY}`);

mkdirSync(DIST, { recursive: true });

// Step 1: Build the app bundle (if not already built)
const mainEntry = join(ROOT, "apps/q-cli/dist/main.mjs");
if (!existsSync(mainEntry)) {
  console.log("[sea] Building app bundle...");
  execSync("pnpm --filter q-cli build", { cwd: ROOT, stdio: "inherit" });
} else {
  console.log("[sea] App bundle already exists, skipping build");
}

// Step 2: Create SEA config
const seaConfig = {
  main: mainEntry,
  output: SEA_BLOB,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};
writeFileSync(SEA_CONFIG, JSON.stringify(seaConfig, null, 2));
console.log("[sea] SEA config written");

// Step 3: Generate the SEA blob
console.log("[sea] Generating SEA blob...");
execSync(`node --experimental-sea-config "${SEA_CONFIG}"`, {
  cwd: ROOT,
  stdio: "inherit",
});

// Step 4: Copy Node.js binary as base
const outputName = platform() === "win32" ? "qode.exe" : "qode";
const outputPath = join(DIST, outputName);
console.log(`[sea] Copying Node.js binary to ${outputPath}...`);
copyFileSync(NODE_BINARY, outputPath);
chmodSync(outputPath, 0o755);

// Step 5: Inject the SEA blob using postject
console.log("[sea] Injecting SEA blob...");

// Try to find postject in various locations
const postjectPaths = [
  join(ROOT, "node_modules/.bin/postject"),
  join(ROOT, "node_modules/postject/dist/postject.mjs"),
];

let postjectBin = null;
for (const p of postjectPaths) {
  if (existsSync(p)) {
    postjectBin = p;
    break;
  }
}

// Try via npx as fallback
if (!postjectBin) {
  try {
    execSync("npx --yes postject --version", { stdio: "pipe", timeout: 15000 });
    postjectBin = "npx postject";
  } catch {
    console.error("[sea] postject not found. Install it: npm install -g postject");
    process.exit(1);
  }
}

const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df25e192";
const machoSegment = platform() === "darwin" ? "--macho-segment-name NODE_SEA" : "";

const injectCmd = postjectBin === "npx postject"
  ? `npx postject "${outputPath}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse ${sentinelFuse} ${machoSegment}`
  : `"${postjectBin}" "${outputPath}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse ${sentinelFuse} ${machoSegment}`;
console.log(`[sea] Running: ${injectCmd}`);
execSync(injectCmd, { cwd: ROOT, stdio: "inherit" });

// Step 6: Sign the binary (macOS)
if (platform() === "darwin") {
  try {
    execSync(`codesign --sign - "${outputPath}"`, { stdio: "inherit" });
    console.log("[sea] Binary signed (ad-hoc)");
  } catch {
    console.warn("[sea] Code signing failed (non-fatal)");
  }
}

// Step 7: Strip symbols (macOS/Linux)
if (platform() !== "win32") {
  try {
    execSync(`strip -S "${outputPath}" 2>/dev/null || true`, { stdio: "inherit" });
    console.log("[sea] Symbols stripped");
  } catch {
    console.warn("[sea] Symbol stripping failed (non-fatal)");
  }
}

const size = existsSync(outputPath) ? `${(statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB` : "unknown";
console.log(`[sea] Binary created: ${outputPath} (${size})`);
console.log(`[sea] Done!`);
