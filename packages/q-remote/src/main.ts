#!/usr/bin/env node
/**
 * q-remote — Headless remote agent daemon for cloud execution.
 *
 * Commands:
 *   q-remote daemon --workspace <dir> --session <id> --creds <path> --passphrase <p>
 *     Starts the headless daemon. Reads control commands from
 *     <workspace>/.q-remote/control.jsonl (file-based, nohup-safe).
 *     Emits event NDJSON to stdout + <workspace>/.q-remote/events.log.
 *
 *   q-remote run --workspace <dir> --session <id> --creds <path> --passphrase <p> --prompt <text>
 *     One-shot: run a single prompt and exit.
 *
 *   q-remote status --workspace <dir>
 *     Prints JSON: { running, pid, sessionId, lastEventSeq, mode, state, uptimeMs }
 *
 *   q-remote sync-diff --workspace <dir>
 *     Emits the file manifest as NDJSON (one entry per line) for the local
 *     side to diff against.
 *
 *   q-remote sync-apply --workspace <dir> --patch <path>
 *     Applies a tarball patch received from the local side.
 *
 *   q-remote version
 *     Prints the version.
 *
 *   q-remote sessions --workspace <dir>
 *     Lists all known sessions.
 */

// `process` is a global in Node.js — no import needed.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeSync } from "node:fs";

import { RemoteDaemon } from "./daemon.js";
import { SyncServer } from "./sync-server.js";
import { SessionManager } from "./session-manager.js";
import { decryptCredentials } from "./credentials.js";
import { createHeadlessAgent } from "./agent-factory.js";
import { EventBridge } from "./event-bridge.js";
import { LogStore } from "./log-store.js";
import { serializeEnvelope } from "@qode-agent/protocol";

const VERSION = "0.1.0";

// ─── Arg parsing ──────────────────────────────────────────────────────────────

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node + script
  let command = "";
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

function out(line: string): void {
  writeSync(1, line.endsWith("\n") ? line : line + "\n");
}

function err(line: string): void {
  writeSync(2, line.endsWith("\n") ? line : line + "\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  switch (command) {
    case "version":
      out(VERSION);
      return;

    case "daemon":
      await runDaemon(flags);
      return;

    case "run":
      await runOneShot(flags);
      return;

    case "status":
      await runStatus(flags);
      return;

    case "sync-diff":
      await runSyncDiff(flags);
      return;

    case "sync-apply":
      await runSyncApply(flags);
      return;

    case "sessions":
      await runSessions(flags);
      return;

    default:
      err(`Unknown command: "${command || "(none)"}"`);
      err("");
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  out(`q-remote ${VERSION} — Headless remote agent daemon`);
  out("");
  out("Usage: q-remote <command> [options]");
  out("");
  out("Commands:");
  out("  daemon       Start the headless daemon (nohup-safe)");
  out("  run          One-shot: run a single prompt and exit");
  out("  status       Print daemon status as JSON");
  out("  sync-diff    Emit file manifest as NDJSON");
  out("  sync-apply   Apply a tarball patch");
  out("  sessions     List all known sessions");
  out("  version      Print version");
  out("");
  out("Options:");
  out("  --workspace <dir>    Workspace directory (required for most commands)");
  out("  --session <id>       Session ID");
  out("  --creds <path>       Path to encrypted credentials file (.qcred.enc)");
  out("  --passphrase <p>     Decryption passphrase");
  out("  --prompt <text>      Prompt text (for run command)");
  out("  --mode <m>           Execution mode (auto|modus_maximus)");
  out("  --patch <path>       Path to patch tarball (for sync-apply)");
}

// ─── Commands ──────────────────────────────────────────────────────────────

async function runDaemon(flags: Record<string, string>): Promise<void> {
  const workspace = flags.workspace;
  const sessionId = flags.session;
  const credsPath = flags.creds;
  let passphrase = flags.passphrase;
  const passphraseFile = flags["passphrase-file"];
  const mode = flags.mode ?? "auto";
  const permissionMode = (flags.permission ?? "yolo") as "manual" | "yolo" | "auto";

  // Read passphrase from file if --passphrase-file is given (avoids shell escaping issues)
  if (passphraseFile) {
    try {
      passphrase = readFileSync(passphraseFile, "utf-8").trim();
      // Delete the file after reading (security)
      try { unlinkSync(passphraseFile); } catch { /* best effort */ }
    } catch (err) {
      err(`Failed to read passphrase file: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  if (!workspace || !sessionId || !credsPath || !passphrase) {
    err("Missing required flags: --workspace, --session, --creds, --passphrase (or --passphrase-file)");
    process.exit(1);
  }
  if (!existsSync(workspace)) {
    err(`Workspace does not exist: ${workspace}`);
    process.exit(1);
  }
  if (!existsSync(credsPath)) {
    err(`Credentials file does not exist: ${credsPath}`);
    process.exit(1);
  }

  const daemon = new RemoteDaemon({
    workspace: resolve(workspace),
    sessionId,
    credsPath: resolve(credsPath),
    passphrase,
    mode,
    permissionMode,
  });

  await daemon.start();

  // Keep the process alive — the daemon polls the control file.
  // The process exits only on shutdown command or signal.
  // Prevent the event loop from draining (stdin EOF under nohup).
  setInterval(() => { /* keep alive */ }, 60_000);
}

async function runOneShot(flags: Record<string, string>): Promise<void> {
  const workspace = flags.workspace;
  const sessionId = flags.session ?? `oneshot-${Date.now()}`;
  const credsPath = flags.creds;
  const passphrase = flags.passphrase;
  const prompt = flags.prompt;
  const mode = flags.mode ?? "auto";

  if (!workspace || !credsPath || !passphrase || !prompt) {
    err("Missing required flags: --workspace, --creds, --passphrase, --prompt");
    process.exit(1);
  }

  // Set up minimal infrastructure for one-shot mode
  const { mkdirSync } = await import("node:fs");
  const qremoteDir = resolve(workspace, ".q-remote");
  mkdirSync(qremoteDir, { recursive: true });
  const eventsLogPath = resolve(qremoteDir, "events.log");
  const logStore = new LogStore(eventsLogPath);
  logStore.open();
  const eventBridge = new EventBridge({ logStore });

  const creds = decryptCredentials(readFileSync(credsPath), passphrase);
  try { (await import("node:fs")).unlinkSync(credsPath); } catch { /* */ }

  const { OrchestratorCore } = await import("@qode-agent/runtime");
  const agent = createHeadlessAgent({
    workspace: resolve(workspace),
    credentials: creds,
    eventBridge,
    permissionMode: "yolo",
    sessionId,
  });
  const orch = new OrchestratorCore({
    convergenceTimeout: 60_000,
    taskTimeout: 300_000,
    workspaceRoot: resolve(workspace),
  });
  orch.setAgent(agent);
  orch.setSessionId(sessionId);
  orch.onEvent((e) => eventBridge.emitOrchestratorEvent(e));

  try {
    await orch.initMemorySystem(sessionId);
  } catch { /* non-fatal */ }

  orch.currentMode = mode as any;
  const result = await orch.submitPrompt(prompt);
  eventBridge.emit("orchestrator", "prompt.complete", {
    success: result.success,
    mode: result.mode,
    durationMs: result.durationMs,
  });
  logStore.close();
  process.exit(result.success ? 0 : 1);
}

async function runStatus(flags: Record<string, string>): Promise<void> {
  const workspace = flags.workspace;
  if (!workspace) {
    err("Missing --workspace");
    process.exit(1);
  }
  const qremoteDir = resolve(workspace, ".q-remote");
  const pidPath = resolve(qremoteDir, "daemon.pid");
  const eventsLogPath = resolve(qremoteDir, "events.log");

  let running = false;
  let pid = 0;
  let lastEventSeq = 0;

  if (existsSync(pidPath)) {
    pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    // Check if process is alive
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }

  if (existsSync(eventsLogPath)) {
    const logStore = new LogStore(eventsLogPath);
    logStore.open();
    lastEventSeq = logStore.lastSeq();
    logStore.close();
  }

  const status = {
    running,
    pid,
    sessionId: "", // unknown from status alone
    lastEventSeq,
    mode: "unknown",
    state: "unknown",
    uptimeMs: 0,
  };
  out(JSON.stringify(status, null, 2));
}

async function runSyncDiff(flags: Record<string, string>): Promise<void> {
  const workspace = flags.workspace;
  if (!workspace) {
    err("Missing --workspace");
    process.exit(1);
  }
  const sync = new SyncServer(resolve(workspace));
  const manifest = await sync.computeManifest();
  // Emit each entry as NDJSON
  for (const entry of manifest.entries) {
    out(serializeEnvelope({
      seq: 0,
      ts: new Date().toISOString(),
      kind: "sync",
      type: "manifest.entry",
      ...entry,
    }));
  }
  out(serializeEnvelope({
    seq: 0,
    ts: new Date().toISOString(),
    kind: "sync",
    type: "manifest.complete",
    count: manifest.entries.length,
    generatedAt: manifest.generatedAt,
  }));
}

async function runSyncApply(flags: Record<string, string>): Promise<void> {
  const workspace = flags.workspace;
  const patchPath = flags.patch;
  if (!workspace || !patchPath) {
    err("Missing --workspace and --patch");
    process.exit(1);
  }
  const sync = new SyncServer(resolve(workspace));
  const result = await sync.applyPatch(resolve(patchPath));
  out(JSON.stringify(result, null, 2));
  process.exit(result.errors.length > 0 ? 1 : 0);
}

async function runSessions(flags: Record<string, string>): Promise<void> {
  const workspace = flags.workspace;
  if (!workspace) {
    err("Missing --workspace");
    process.exit(1);
  }
  const sm = new SessionManager(resolve(workspace));
  const sessions = sm.listSessions();
  out(JSON.stringify(sessions, null, 2));
}

// ─── Entry ─────────────────────────────────────────────────────────────────

main().catch((err) => {
  err(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});