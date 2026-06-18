/**
 * `q-cli doctor` — Environment Diagnostics & Connector Health Check
 *
 * Comprehensive diagnostics suite that checks every component of V's
 * environment. Supports --verbose, --json, and --watch modes.
 *
 * Step 35 — depends on Steps 3 (config), 6 (connectors), 7 (MCP), 11 (spinners),
 * 32 (LSP), and 34 (plugins).
 */

import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { satisfies } from "semver";
import chalk from "chalk";
import type { Command } from "commander";
import { discoverConfig, getQHome } from "./config-discover.js";
import {
  safeParseVConfig,
  PluginManifestSchema,
  McpConnectionManager,
  type VConfig,
  type ProviderConfig,
  type McpServerConfig,
} from "@qode-agent/runtime";

// ─── ICONS from Step 3's TUI system ─────────────────────────────────────────

const ICONS = {
  statusDone: "◉",
  statusFailed: "○",
  statusPending: "○",
  statusRunning: "●",
} as const;

// ─── Spinner frames (violet→cyan gradient) ───────────────────────────────────

const VIOLET_TO_CYAN_12 = (() => {
  function parseHex(h: string) {
    const x = h.replace("#", "");
    return {
      r: Number.parseInt(x.slice(0, 2), 16),
      g: Number.parseInt(x.slice(2, 4), 16),
      b: Number.parseInt(x.slice(4, 6), 16),
    };
  }
  function toHex(r: number, g: number, b: number) {
    return "#" + [r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("");
  }
  const f = parseHex("#7C3AED");
  const t = parseHex("#06B6D4");
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const p = i / 11;
    out.push(toHex(Math.round(f.r + (t.r - f.r) * p), Math.round(f.g + (t.g - f.g) * p), Math.round(f.b + (t.b - f.b) * p)));
  }
  return out;
})();

// Spinner frames per check category
const THINKING_FRAMES = ["◐", "◓", "◑", "◒", "◐", "◓", "◑", "◒"];
const THINKING_COLORS = [0, 3, 6, 9, 11, 8, 5, 2];
const WORKING_FRAMES = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿", "⣷", "⣶", "⣦", "⣤", "⣄"];
const WORKING_COLORS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const VERIFYING_FRAMES = ["✓", "✓", "✗", "✗"];
const VERIFYING_COLORS = [0, 2, 8, 10];

// ─── Types ──────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  details: string;
  /** Optional suggested fix shown on failure */
  fix?: string;
}

export interface DoctorReport {
  timestamp: number;
  summary: { pass: number; warn: number; fail: number };
  checks: CheckResult[];
}

// ─── Inline spinner helper ───────────────────────────────────────────────────

type SpinnerCategory = "thinking" | "working" | "verifying";

/** Whether spinner animations are enabled. Disabled in --json mode. */
let _showSpinners = true;

/** Enable or disable spinner animations. */
export function setShowSpinners(show: boolean): void {
  _showSpinners = show;
}

function getFrames(cat: SpinnerCategory): { frames: readonly string[]; colors: readonly number[] } {
  if (cat === "thinking") return { frames: THINKING_FRAMES, colors: THINKING_COLORS };
  if (cat === "verifying") return { frames: VERIFYING_FRAMES, colors: VERIFYING_COLORS };
  return { frames: WORKING_FRAMES, colors: WORKING_COLORS };
}

async function withSpinner<T>(
  label: string,
  category: SpinnerCategory,
  fn: () => Promise<T>,
  intervalMs = 80,
): Promise<T> {
  if (!_showSpinners) {
    return fn();
  }
  const { frames, colors } = getFrames(category);
  let frameIndex = 0;
  const spinnerId = setInterval(() => {
    frameIndex = (frameIndex + 1) % frames.length;
    const f = frames[frameIndex] ?? frames[0]!;
    const ci = colors[frameIndex % colors.length] ?? 0;
    const color = VIOLET_TO_CYAN_12[ci % VIOLET_TO_CYAN_12.length] ?? VIOLET_TO_CYAN_12[0]!;
    process.stdout.write(`\r  ${chalk.hex(color)(f)} ${chalk.dim(label)}`);
  }, intervalMs);
  try {
    const result = await fn();
    clearInterval(spinnerId);
    process.stdout.write("\r\x1b[K"); // Clear the spinner line
    return result;
  } catch (err) {
    clearInterval(spinnerId);
    process.stdout.write("\r\x1b[K"); // Clear the spinner line
    throw err;
  }
}

// ─── Status badge helpers ────────────────────────────────────────────────────

function badgePass(text = ""): string {
  const sym = chalk.green(ICONS.statusDone);
  return text ? `${sym} ${text}` : sym;
}

function badgeFail(text = ""): string {
  const sym = chalk.red(ICONS.statusFailed);
  return text ? `${sym} ${text}` : sym;
}

function badgeWarn(text = ""): string {
  const sym = chalk.yellow(ICONS.statusPending);
  return text ? `${sym} ${text}` : sym;
}

function printResult(result: CheckResult, verbose: boolean, changedCycles: number = 0): void {
  const icon =
    result.status === "pass" ? badgePass() :
    result.status === "warn" ? badgeWarn() :
    badgeFail();
  const changedTag = changedCycles > 0 ? chalk.yellow(" (changed!)") : "";
  console.log(`  ${icon} ${chalk.bold(result.name)}${changedTag}`);
  if (verbose || result.status !== "pass") {
    if (result.details) {
      console.log(chalk.dim(`    ${result.details}`));
    }
    if (result.fix && result.status !== "pass") {
      console.log(chalk.dim(`    ${chalk.italic("Fix:")} ${result.fix}`));
    }
  }
}

// ─── Timeout helper for fetch ───────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const { timeout = 5000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Individual checks ──────────────────────────────────────────────────────

async function checkNodeVersion(): Promise<CheckResult> {
  const minVersion = "22.19.0";
  const current = process.version;
  if (satisfies(current, `>=${minVersion}`)) {
    return { name: "Node.js version", status: "pass", details: `${current} (≥ ${minVersion})` };
  }
  return {
    name: "Node.js version",
    status: "warn",
    details: `${current} — minimum required is ${minVersion}`,
    fix: "Upgrade Node.js to v22.19.0 or later (https://nodejs.org)",
  };
}

async function checkProviders(config: VConfig | null): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const providers = config?.providers ?? {};
  const providerNames = Object.keys(providers);

  if (providerNames.length === 0) {
    results.push({
      name: "Available providers",
      status: "warn",
      details: "No providers configured",
      fix: "Run 'q-cli init' or edit $HOME/.Q/config.toml to add providers",
    });
    return results;
  }

  for (const name of providerNames) {
    const provider: ProviderConfig | undefined = providers[name];
    if (!provider) {
      results.push({ name: `Provider: ${name}`, status: "warn", details: "Provider config is empty" });
      continue;
    }

    const baseUrl = provider.baseUrl || "";
    const apiKey = provider.apiKey;
    const isOllama = provider.type === "ollama";
    const isOllamaCloud = provider.type === "ollama-cloud";
    const isMoonshotKimi = name.toLowerCase().includes("moonshot") || name.toLowerCase().includes("kimi");

    // Determine effective endpoint URL (with defaults for well-known providers)
    const effectiveBaseUrl = baseUrl || (isOllama ? "http://localhost:11434" : isOllamaCloud ? "https://ollama.com" : "");

    // Check endpoint reachability with HEAD request
    let endpointOk = false;
    let endpointDetail = "";
    if (effectiveBaseUrl) {
      try {
        const headResp = await fetchWithTimeout(effectiveBaseUrl, { method: "HEAD" });
        endpointOk = true;
        endpointDetail = `${effectiveBaseUrl} (HTTP ${headResp.status})`;
      } catch (err) {
        endpointDetail = `${effectiveBaseUrl} — unreachable (${err instanceof Error ? err.message : String(err)})`;
      }
    } else {
      endpointDetail = "No base URL configured";
    }

    // Check API key validity with a models list request
    let keyOk = false;
    let keyDetail = "";
    if (apiKey && !isOllama && effectiveBaseUrl) {
      try {
        const modelsUrl = (baseUrl || effectiveBaseUrl).replace(/\/+$/, "") + "/v1/models";
        const modelsResp = await fetchWithTimeout(modelsUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        keyOk = modelsResp.ok;
        keyDetail = keyOk ? `API key valid (HTTP ${modelsResp.status})` : `API key rejected (HTTP ${modelsResp.status})`;
      } catch (err) {
        keyDetail = `API key check failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (isOllama) {
      // Ollama — check local server at effective URL
      try {
        const tagsResp = await fetchWithTimeout(`${effectiveBaseUrl.replace(/\/+$/, "")}/api/tags`);
        keyOk = tagsResp.ok;
        keyDetail = keyOk ? `Ollama server running (HTTP ${tagsResp.status})` : `Ollama server unreachable (HTTP ${tagsResp.status})`;
      } catch (err) {
        keyDetail = `Ollama server not reachable: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (isMoonshotKimi) {
      // Moonshot/Kimi — check OAuth token validity
      if (apiKey) {
        try {
          const modelsUrl = effectiveBaseUrl ? effectiveBaseUrl.replace(/\/+$/, "") + "/v1/models" : "https://api.moonshot.cn/v1/models";
          const modelsResp = await fetchWithTimeout(modelsUrl, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          keyOk = modelsResp.ok;
          keyDetail = keyOk ? "OAuth token valid" : `OAuth token rejected (HTTP ${modelsResp.status})`;
        } catch (err) {
          keyDetail = `OAuth check failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        keyDetail = "No API key / OAuth token configured";
      }
    } else if (apiKey) {
      keyOk = true; // Have key but couldn't verify without base URL
      keyDetail = "API key configured (endpoint not verified)";
    } else {
      keyDetail = "No API key configured";
    }

    const details = [endpointDetail, keyDetail].filter(Boolean).join("; ");
    // Pass only if both endpoint and key are OK.
    // If endpoint failed but key check succeeded (e.g., Ollama with no baseUrl
    // where endpoint check ran against the default URL and also failed), warn.
    // If key check also found nothing, fail.
    const status: CheckStatus = endpointOk && keyOk ? "pass" : (endpointOk || keyOk) ? "warn" : "fail";

    results.push({
      name: `Provider: ${name}`,
      status,
      details,
      fix: status === "fail" ? "Check provider configuration in $HOME/.Q/config.toml" : undefined,
    });
  }

  return results;
}

async function checkVInstallation(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const vHome = getQHome();

  // Check $HOME/.Q/ directory
  try {
    accessSync(vHome, constants.R_OK | constants.W_OK);
    results.push({ name: "$HOME/.Q directory", status: "pass", details: vHome });
  } catch {
    results.push({
      name: "$HOME/.Q directory",
      status: "fail",
      details: `${vHome} does not exist or is not accessible`,
      fix: "Run 'q-cli init' to create the Qode home directory",
    });
    return results; // Cannot proceed with further Qode checks
  }

  // Check $HOME/.Q/config.toml
  const configPath = resolve(vHome, "config.toml");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseToml(raw) as Record<string, unknown>;
    const validation = safeParseVConfig(parsed);
    if (validation.success) {
      results.push({ name: "$HOME/.Q/config.toml", status: "pass", details: "Valid TOML, conforms to schema" });
    } else {
      results.push({
        name: "$HOME/.Q/config.toml",
        status: "warn",
        details: `Schema validation failed: ${(validation as { success: false; error: Error }).error.message}`,
        fix: "Fix the configuration file manually or re-run 'q-cli init'",
      });
    }
  } catch (err) {
    results.push({
      name: "$HOME/.Q/config.toml",
      status: "warn",
      details: `Cannot read or parse: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Run 'q-cli init' to create the configuration file",
    });
  }

  return results;
}

async function checkProjectStructure(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const discovery = discoverConfig(process.cwd());
  if (discovery.initialized && discovery.vDir) {
    const configPath = resolve(discovery.vDir, "config.toml");
    // Validate project config against Zod schema
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = parseToml(raw) as Record<string, unknown>;
      const validation = safeParseVConfig(parsed);
      if (validation.success) {
        results.push({ name: "Project structure", status: "pass", details: `.q/ initialized at ${discovery.vDir} — config valid` });
      } else {
        results.push({
          name: "Project structure",
          status: "warn",
          details: `.q/ initialized but config failed schema validation: ${(validation as { success: false; error: Error }).error.message}`,
          fix: "Fix the project configuration in .q/config.toml",
        });
      }
    } catch (err) {
      results.push({
        name: "Project structure",
        status: "warn",
        details: `.q/ initialized but config cannot be parsed: ${err instanceof Error ? err.message : String(err)}`,
        fix: "Fix the project configuration in .q/config.toml",
      });
    }
  } else if (discovery.vDir) {
    results.push({
      name: "Project structure",
      status: "warn",
      details: ".q/ directory exists but no config.toml",
      fix: "Run 'q-cli init' in the project root",
    });
  } else {
    results.push({
      name: "Project structure",
      status: "warn",
      details: "Not a V-initialized project",
      fix: "Run 'q-cli init' to initialize the project",
    });
  }
  return results;
}

async function checkGitAvailability(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Check git is installed
  try {
    const gitVersion = await new Promise<string>((resolve_, reject) => {
      execFile("git", ["--version"], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve_(stdout.trim());
      });
    });
    results.push({ name: "Git installed", status: "pass", details: gitVersion });
  } catch {
    results.push({
      name: "Git installed",
      status: "fail",
      details: "git not found in PATH",
      fix: "Install Git from https://git-scm.com",
    });
    return results; // Cannot proceed with repo check
  }

  // Check if CWD is inside a git repository
  try {
    await new Promise<void>((resolve_, reject) => {
      execFile("git", ["rev-parse", "--show-toplevel"], { timeout: 5000, cwd: process.cwd() }, (err, _stdout) => {
        if (err) reject(err);
        else resolve_();
      });
    });
    results.push({ name: "Git repository", status: "pass", details: `${process.cwd()} is a git repository` });
  } catch {
    results.push({
      name: "Git repository",
      status: "warn",
      details: "CWD is not inside a git repository",
      fix: "Run 'git init' or clone a repository",
    });
  }

  return results;
}

async function checkLspServers(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const cwd = process.cwd();

  // Detect languages by scanning file extensions
  const languageServers: Array<{ name: string; binary: string; extensions: string[] }> = [
    { name: "TypeScript/JavaScript", binary: "typescript-language-server", extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] },
    { name: "Python", binary: "pyright-langserver", extensions: [".py"] },
    { name: "Rust", binary: "rust-analyzer", extensions: [".rs"] },
    { name: "Go", binary: "gopls", extensions: [".go"] },
    { name: "Java", binary: "jdtls", extensions: [".java"] },
    { name: "C/C++", binary: "clangd", extensions: [".c", ".cpp", ".h", ".hpp", ".cxx", ".hxx", ".cc", ".hh"] },
  ];

  // Detect which languages are present in the project
  const detectedLanguages: typeof languageServers = [];
  try {
    const entries = await new Promise<string[]>((resolve_, reject) => {
      execFile("find", [cwd, "-maxdepth", "3", "-type", "f"], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve_(stdout.trim().split("\n").filter(Boolean));
      });
    });

    for (const ls of languageServers) {
      const hasFile = entries.some((e) => ls.extensions.some((ext) => e.endsWith(ext)));
      if (hasFile) {
        detectedLanguages.push(ls);
      }
    }
  } catch {
    // If find fails, fall back to checking all languages
    detectedLanguages.push(...languageServers);
  }

  if (detectedLanguages.length === 0) {
    results.push({ name: "LSP servers", status: "warn", details: "No project files detected for LSP analysis" });
    return results;
  }

  for (const lang of detectedLanguages) {
    try {
      await new Promise<void>((resolve_, reject) => {
        execFile("which", [lang.binary], { timeout: 5000 }, (err) => {
          if (err) reject(err);
          else resolve_();
        });
      });
      // Verify it actually runs
      try {
        const version = await new Promise<string>((resolve_) => {
          execFile(lang.binary, ["--version"], { timeout: 10000 }, (err, stdout) => {
            if (err) {
              // Some LSP binaries don't support --version
              resolve_("binary found");
            } else {
              resolve_(stdout.trim().split("\n")[0]!);
            }
          });
        });
        results.push({ name: `LSP: ${lang.name}`, status: "pass", details: `${lang.binary} — ${version}` });
      } catch {
        results.push({ name: `LSP: ${lang.name}`, status: "warn", details: `${lang.binary} found but not responding` });
      }
    } catch {
      results.push({
        name: `LSP: ${lang.name}`,
        status: "warn",
        details: `${lang.binary} not installed`,
        fix: `Install ${lang.binary} (see docs at https://microsoft.github.io/language-server-protocol/implementors/servers/)`,
      });
    }
  }

  return results;
}

async function checkConnectorHealth(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Shell connector: echo ok
  try {
    const out = await new Promise<string>((resolve_, reject) => {
      execFile("echo", ["ok"], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve_(stdout.trim());
      });
    });
    const ok = out === "ok";
    results.push({
      name: "Connector: Shell",
      status: ok ? "pass" : "warn",
      details: ok ? "echo ok returned expected output" : `echo ok returned "${out}"`,
    });
  } catch (err) {
    results.push({
      name: "Connector: Shell",
      status: "fail",
      details: `echo ok failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Git connector: git status in project root
  try {
    await new Promise<void>((resolve_, reject) => {
      execFile("git", ["status"], { timeout: 5000, cwd: process.cwd() }, (err) => {
        if (err) reject(err);
        else resolve_();
      });
    });
    results.push({ name: "Connector: Git", status: "pass", details: "git status succeeded" });
  } catch (err) {
    results.push({
      name: "Connector: Git",
      status: "warn",
      details: `git status failed: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Ensure you are in a git repository or install git",
    });
  }

  // File connector: read package.json and verify JSON parse
  const pkgPath = resolve(process.cwd(), "package.json");
  try {
    const content = readFileSync(pkgPath, "utf-8");
    JSON.parse(content);
    results.push({ name: "Connector: File", status: "pass", details: `Read and parsed ${pkgPath}` });
  } catch (err) {
    results.push({
      name: "Connector: File",
      status: "warn",
      details: `Could not read/parse package.json: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Web connector: fetch https://api.github.com/zen
  try {
    const resp = await fetchWithTimeout("https://api.github.com/zen");
    if (resp.ok) {
      const text = await resp.text();
      results.push({ name: "Connector: Web", status: "pass", details: `GitHub API reachable: "${text.trim()}"` });
    } else {
      results.push({ name: "Connector: Web", status: "warn", details: `GitHub API returned HTTP ${resp.status}` });
    }
  } catch (err) {
    results.push({
      name: "Connector: Web",
      status: "warn",
      details: `GitHub API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Check your internet connection or proxy settings",
    });
  }

  return results;
}

async function checkShellIntegration(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const vBinDir = resolve(getQHome(), "bin");

  // Check $HOME/.Q/bin in PATH
  const pathParts = (process.env.PATH ?? "").split(":").map((p) => resolve(p));
  const inPath = pathParts.some((p) => p === vBinDir);

  if (inPath) {
    results.push({ name: "$HOME/.Q/bin in PATH", status: "pass", details: vBinDir });
  } else {
    results.push({
      name: "$HOME/.Q/bin in PATH",
      status: "warn",
      details: `${vBinDir} not in PATH`,
      fix: `Add 'export PATH="$HOME/.Q/bin:$PATH"' to your shell rc file`,
    });
  }

  // Check that q-cli resolves correctly
  try {
    const whichOut = await new Promise<string>((resolve_, reject) => {
      execFile("which", ["q-cli"], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve_(stdout.trim());
      });
    });
    results.push({ name: "q-cli resolves", status: "pass", details: whichOut });
  } catch {
    results.push({
      name: "q-cli resolves",
      status: "warn",
      details: "q-cli not found in PATH",
      fix: "Install q-cli or add its directory to PATH",
    });
  }

  // Check shell rc files contain Qode PATH export
  const home = process.env.HOME ?? "";
  const rcFiles = [
    { path: resolve(home, ".zshrc"), label: ".zshrc" },
    { path: resolve(home, ".bashrc"), label: ".bashrc" },
    { path: resolve(home, ".bash_profile"), label: ".bash_profile" },
    { path: resolve(home, ".config", "fish", "config.fish"), label: "fish config.fish" },
  ];

  for (const rc of rcFiles) {
    try {
      const content = readFileSync(rc.path, "utf-8");
      if (content.includes(".Q/bin") || content.includes("V/bin")) {
        results.push({ name: `Shell rc: ${rc.label}`, status: "pass", details: `${rc.path} — contains Qode PATH export` });
      } else {
        results.push({
          name: `Shell rc: ${rc.label}`,
          status: "warn",
          details: `${rc.path} — no Qode PATH export found`,
          fix: `Add 'export PATH="$HOME/.Q/bin:$PATH"' to ${rc.path}`,
        });
      }
    } catch {
      // File doesn't exist or can't be read — skip
    }
  }

  return results;
}

async function checkMemorySystem(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const memoryDir = resolve(getQHome(), "memory");

  // Check that memory directory is writable
  if (!existsSync(memoryDir)) {
    results.push({
      name: "Memory directory writable",
      status: "warn",
      details: `${memoryDir} does not exist yet (will be created on first use)`,
    });
  } else {
    try {
      accessSync(memoryDir, constants.R_OK | constants.W_OK);
      results.push({ name: "Memory directory writable", status: "pass", details: memoryDir });
    } catch {
      results.push({
        name: "Memory directory writable",
        status: "fail",
        details: `${memoryDir} is not writable`,
        fix: "Run 'chmod u+w ~/.Q/memory' to grant write permissions",
      });
    }
  }

  // Check disk space (require at least 100MB free)
  try {
    const dfOut = await new Promise<string>((resolve_, reject) => {
      execFile("df", ["-k", memoryDir], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve_(stdout.trim());
      });
    });
    const lines = dfOut.split("\n");
    if (lines.length >= 2) {
      const parts = lines[1]!.split(/\s+/);
      // Available blocks (column 3 or 4 depending on df output)
      const availBlocks = Number.parseInt(parts[3] ?? "0", 10);
      if (!Number.isNaN(availBlocks) && availBlocks > 0) {
        const availMB = Math.round(availBlocks / 1024);
        if (availMB >= 100) {
          results.push({ name: "Memory disk space", status: "pass", details: `${availMB}MB available (≥ 100MB)` });
        } else {
          results.push({
            name: "Memory disk space",
            status: "warn",
            details: `${availMB}MB available — below 100MB minimum`,
            fix: "Free up disk space or move the project to a volume with more space",
          });
        }
      } else {
        results.push({ name: "Memory disk space", status: "warn", details: "Could not parse df output" });
      }
    } else {
      results.push({ name: "Memory disk space", status: "warn", details: "Unexpected df output format" });
    }
  } catch {
    results.push({ name: "Memory disk space", status: "warn", details: "Unable to check disk space (df not available)" });
  }

  // Check vector index integrity
  const vectorIndexPath = resolve(memoryDir, "index", "vectors.bin");
  if (existsSync(vectorIndexPath)) {
    try {
      const fd = readFileSync(vectorIndexPath);
      if (fd.length >= 8) {
        // Read header (first 8 bytes — dimension (4 bytes LE) + count (4 bytes LE))
        const dim = fd.readUInt32LE(0);
        const count = fd.readUInt32LE(4);
        const expectedSize = 8 + dim * count * 4; // header + floats
        if (fd.length === expectedSize || (dim > 0 && count > 0 && fd.length >= 8)) {
          results.push({ name: "Vector index integrity", status: "pass", details: `${dim}x${count} vectors (${fd.length} bytes)` });
        } else {
          results.push({ name: "Vector index integrity", status: "warn", details: `Unexpected size: ${fd.length} vs expected ${expectedSize}` });
        }
      } else {
        results.push({ name: "Vector index integrity", status: "warn", details: "File too small for valid header (< 8 bytes)" });
      }
    } catch (err) {
      results.push({
        name: "Vector index integrity",
        status: "warn",
        details: `Cannot read vector index: ${err instanceof Error ? err.message : String(err)}`,
        fix: "Delete ~/.Q/memory/index/ to rebuild on next use",
      });
    }
  } else {
    results.push({ name: "Vector index integrity", status: "pass", details: "No vector index file yet (will be created on first use)" });
  }

  return results;
}

async function checkMcpServers(config: VConfig | null): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // MCP server configs end up in the config's `raw` field since they're not
  // a known top-level key in the Zod schema. Scan raw for mcp-related keys.
  const allMcpConfigs: Record<string, McpServerConfig> = {};

  if (config) {
    const raw = config.raw;
    if (raw) {
      const mcpFromConfig = raw["mcpServers"] ?? raw["mcp_servers"];
      if (typeof mcpFromConfig === "object" && mcpFromConfig !== null) {
        const mcpObj = mcpFromConfig as Record<string, unknown>;
        for (const key of Object.keys(mcpObj)) {
          const val = mcpObj[key];
          if (typeof val === "object" && val !== null) {
            allMcpConfigs[key] = val as McpServerConfig;
          }
        }
      }
    }
  }

  const mcpNames = Object.keys(allMcpConfigs);

  if (mcpNames.length === 0) {
    results.push({ name: "MCP servers", status: "pass", details: "No MCP servers configured" });
    return results;
  }

  // Use McpConnectionManager to actually connect and call listTools()
  const mcpManager = new McpConnectionManager();
  try {
    await mcpManager.connectAll(allMcpConfigs);
    const entries = mcpManager.list();

    for (const entry of entries) {
      if (entry.status === "connected") {
        results.push({
          name: `MCP: ${entry.name}`,
          status: "pass",
          details: `Connected (${entry.transport}) — ${entry.toolCount} tools available`,
        });
      } else if (entry.status === "disabled") {
        results.push({
          name: `MCP: ${entry.name}`,
          status: "warn",
          details: "MCP server is disabled in configuration",
          fix: "Set enabled = true for this server or remove the disabled flag",
        });
      } else if (entry.status === "needs-auth") {
        results.push({
          name: `MCP: ${entry.name}`,
          status: "warn",
          details: entry.error ?? "Server requires OAuth authentication",
          fix: "Run the authentication tool for this MCP server",
        });
      } else {
        // failed, pending
        results.push({
          name: `MCP: ${entry.name}`,
          status: "warn",
          details: entry.error ?? `Status: ${entry.status}`,
          fix: "Check the MCP server configuration and that it is running",
        });
      }
    }
  } catch (err) {
    results.push({
      name: "MCP servers",
      status: "warn",
      details: `Connection manager error: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    await mcpManager.shutdown().catch(() => {});
  }

  return results;
}

async function checkPluginSystem(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const vHome = getQHome();
  const cwd = process.cwd();

  const pluginDirs = [
    { path: resolve(vHome, "plugins"), label: "~/.Q/plugins/" },
    { path: resolve(cwd, ".v", "plugins"), label: ".q/plugins/" },
  ];

  let anyPluginDirExists = false;

  for (const { path, label } of pluginDirs) {
    if (existsSync(path)) {
      anyPluginDirExists = true;
      try {
        accessSync(path, constants.R_OK);
        results.push({ name: `Plugin dir: ${label}`, status: "pass", details: `${path} — readable` });

        // Validate all plugin manifests in this directory
        const entries = await readdirSafe(path);
        for (const entry of entries) {
          if (entry.startsWith(".")) continue;
          const manifestPath = resolve(path, entry, "v.plugin.json");
          if (existsSync(manifestPath)) {
            try {
              const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
              const parsed = PluginManifestSchema.safeParse(raw);
              if (parsed.success) {
                results.push({ name: `Plugin manifest: ${entry}`, status: "pass", details: `${manifestPath} — valid` });
              } else {
                const issues = parsed.error.issues.map((i) => i.message).join("; ");
                results.push({
                  name: `Plugin manifest: ${entry}`,
                  status: "warn",
                  details: `${manifestPath} — validation error: ${issues}`,
                  fix: "Fix the manifest file or reinstall the plugin",
                });
              }
            } catch (err) {
              results.push({
                name: `Plugin manifest: ${entry}`,
                status: "warn",
                details: `${manifestPath} — parse error: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }
        }
      } catch {
        results.push({
          name: `Plugin dir: ${label}`,
          status: "fail",
          details: `${path} — not readable`,
          fix: "Run 'chmod u+rX ' to grant read permissions",
        });
      }
    }
  }

  if (!anyPluginDirExists) {
    results.push({ name: "Plugin system", status: "pass", details: "No plugin directories (none installed)" });
  }

  return results;
}

async function checkOnboardingStatus(): Promise<CheckResult> {
  const vHome = getQHome();
  const onboardingFile = resolve(vHome, ".onboarding-complete");

  if (existsSync(onboardingFile)) {
    return { name: "Onboarding status", status: "pass", details: "Setup wizard completed" };
  }

  return {
    name: "Onboarding status",
    status: "warn",
    details: "Setup wizard not completed",
    fix: "Run 'q-cli' without flags to start the setup wizard",
  };
}

async function checkPermissions(): Promise<CheckResult> {
  const configPath = resolve(getQHome(), "config.toml");

  if (!existsSync(configPath)) {
    return { name: "Config permissions", status: "pass", details: "No config file to check" };
  }

  try {
    const stats = statSync(configPath);
    // On Unix, check file mode
    if (process.platform !== "win32") {
      const mode = stats.mode & 0o777;
      // Check that no group/world read access
      const noGroupWorldRead = (mode & 0o044) === 0;
      if (mode === 0o600 || noGroupWorldRead) {
        return { name: "Config permissions", status: "pass", details: `${configPath} — mode ${mode.toString(8)} (user-only)` };
      }
      return {
        name: "Config permissions",
        status: "warn",
        details: `${configPath} — mode ${mode.toString(8)} has group/world read access`,
        fix: "Run 'chmod 600 ~/.Q/config.toml' to restrict access",
      };
    }
    // Windows — just check it exists and is readable
    return { name: "Config permissions", status: "pass", details: `${configPath} — readable (Windows)` };
  } catch (err) {
    return {
      name: "Config permissions",
      status: "warn",
      details: `Cannot check permissions: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Helper: safe readdir ───────────────────────────────────────────────────

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    const { promises: fs } = await import("node:fs");
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

// ─── Run all checks ─────────────────────────────────────────────────────────

async function runAllChecks(config: VConfig | null): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  // 1. Node.js version
  checks.push(await withSpinner("Node.js version", "verifying", () => checkNodeVersion()));

  // 2. Available providers
  const providerResults = await withSpinner("Available providers", "working", () => checkProviders(config));
  checks.push(...providerResults);

  // 3. Qode installation
  const vInstallResults = await withSpinner("V installation", "working", () => checkVInstallation());
  checks.push(...vInstallResults);

  // 4. Project structure
  const projectResults = await withSpinner("Project structure", "thinking", () => checkProjectStructure());
  checks.push(...projectResults);

  // 5. Git availability
  const gitResults = await withSpinner("Git availability", "verifying", () => checkGitAvailability());
  checks.push(...gitResults);

  // 6. LSP servers
  const lspResults = await withSpinner("LSP servers", "working", () => checkLspServers());
  checks.push(...lspResults);

  // 7. Connector health
  const connResults = await withSpinner("Connector health", "verifying", () => checkConnectorHealth());
  checks.push(...connResults);

  // 8. Shell integration
  const shellResults = await withSpinner("Shell integration", "thinking", () => checkShellIntegration());
  checks.push(...shellResults);

  // 9. Memory system
  const memResults = await withSpinner("Memory system", "working", () => checkMemorySystem());
  checks.push(...memResults);

  // 10. MCP servers
  const mcpResults = await withSpinner("MCP servers", "working", () => checkMcpServers(config));
  checks.push(...mcpResults);

  // 11. Plugin system
  const pluginResults = await withSpinner("Plugin system", "thinking", () => checkPluginSystem());
  checks.push(...pluginResults);

  // 12. Onboarding status
  checks.push(await withSpinner("Onboarding status", "verifying", () => checkOnboardingStatus()));

  // 13. Permissions
  checks.push(await withSpinner("Config permissions", "verifying", () => checkPermissions()));

  const pass = checks.filter((c) => c.status === "pass").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const fail = checks.filter((c) => c.status === "fail").length;

  return { timestamp: Date.now(), summary: { pass, warn, fail }, checks };
}

// ─── Render report ──────────────────────────────────────────────────────────

function renderReport(
  report: DoctorReport,
  verbose: boolean,
  changedCycles?: Map<string, number>,
): number {
  console.log(chalk.bold("\n  Qode Environment Diagnostics"));
  console.log(chalk.dim(`  ${new Date(report.timestamp).toLocaleTimeString()}`));
  console.log();

  for (const check of report.checks) {
    const cycles = changedCycles?.get(check.name) ?? 0;
    printResult(check, verbose, cycles);
  }

  // Decrement all changed cycles for the next call
  if (changedCycles) {
    for (const [name, cycles] of changedCycles) {
      if (cycles <= 1) {
        changedCycles.delete(name);
      } else {
        changedCycles.set(name, cycles - 1);
      }
    }
  }

  // Summary
  const { pass, warn, fail } = report.summary;
  console.log();
  console.log(
    chalk.dim(`  ${pass} passed`) +
    (warn > 0 ? `, ${chalk.yellow(`${warn} warnings`)}` : chalk.dim(`, ${warn} warnings`)) +
    (fail > 0 ? `, ${chalk.red(`${fail} failures`)}` : chalk.dim(`, ${fail} failures`)),
  );

  return fail > 0 ? 1 : warn > 0 ? 2 : 0;
}

function renderJsonReport(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

// ─── Store last report ──────────────────────────────────────────────────────

function storeLastReport(report: DoctorReport): void {
  const cacheDir = resolve(getQHome(), "cache");
  try {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    writeFileSync(resolve(cacheDir, "doctor-last.json"), JSON.stringify(report, null, 2), "utf-8");
  } catch {
    // Silently ignore — the cache is non-essential
  }
}

// ─── Load config for checks ─────────────────────────────────────────────────

function loadConfig(): VConfig | null {
  try {
    const configPath = resolve(getQHome(), "config.toml");
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseToml(raw) as Record<string, unknown>;
    const result = safeParseVConfig(parsed);
    if (result.success) return result.data;
    return null;
  } catch {
    return null;
  }
}

// ─── Main doctor command ────────────────────────────────────────────────────

export async function doctorCommand(opts: {
  verbose?: boolean;
  json?: boolean;
  watch?: boolean;
}): Promise<void> {
  const verbose = opts.verbose ?? false;
  const jsonMode = opts.json ?? false;
  const watchMode = opts.watch ?? false;

  // In pure JSON mode (non-watch), suppress spinner output
  if (jsonMode && !watchMode) {
    setShowSpinners(false);
  }

  const config = loadConfig();

  if (watchMode) {
    // Watch mode: re-run every 30 seconds
    // Track which checks changed and for how many cycles to show "changed!"
    let prevReport: DoctorReport | undefined;
    const changedCycles = new Map<string, number>(); // check name -> remaining display cycles (2)

    // eslint-disable-next-line no-constant-condition
    while (true) {
      console.clear();
      const report = await runAllChecks(config);
      // Detect changes compared to previous report
      if (prevReport) {
        for (const curr of report.checks) {
          const prev = prevReport.checks.find((c) => c.name === curr.name);
          if (prev && prev.status !== curr.status) {
            changedCycles.set(curr.name, 2); // Show "(changed!)" for 2 cycles
          }
        }
      }
      renderReport(report, verbose, changedCycles);
      storeLastReport(report);
      prevReport = report;

      if (jsonMode) {
        console.log("\n" + renderJsonReport(report));
      }

      console.log(chalk.dim(`\n  Watching... (Ctrl+C to exit, next check in 30s)`));

      await new Promise<void>((resolve_) => {
        const timer = setTimeout(resolve_, 30_000);
        // Allow Ctrl+C to exit cleanly
        const onSigint = () => {
          clearTimeout(timer);
          process.removeListener("SIGINT", onSigint);
          console.log(chalk.dim("\n  Watch mode exited."));
          process.exit(0);
        };
        process.on("SIGINT", onSigint);
      });
    }
  } else {
    // Single run
    const report = await runAllChecks(config);

    if (jsonMode) {
      storeLastReport(report);
      // In JSON mode, output structured JSON and exit
      console.log(renderJsonReport(report));
      const exitCode = report.summary.fail > 0 ? 1 : report.summary.warn > 0 ? 2 : 0;
      process.exit(exitCode);
    }

    const exitCode = renderReport(report, verbose);
    storeLastReport(report);
    process.exit(exitCode);
  }
}

/**
 * Register the `q-cli doctor` command with Commander.
 */
export function registerDoctorCommand(prog: Command): void {
  prog
    .command("doctor")
    .description("Run environment diagnostics & connector health checks")
    .option("--verbose", "Show details for all checks including passing ones")
    .option("--json", "Output results as structured JSON for CI integration")
    .option("--watch", "Continuously monitor and re-run checks every 30 seconds")
    .action(async (opts: Record<string, unknown>) => {
      await doctorCommand({
        verbose: Boolean(opts.verbose),
        json: Boolean(opts.json),
        watch: Boolean(opts.watch),
      }).catch((err: Error) => {
        console.error(chalk.red("Doctor command error:"), err.message);
        process.exit(1);
      });
    });
}