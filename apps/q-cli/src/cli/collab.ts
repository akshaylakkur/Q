/**
 * `q-cli collab` — Qollab collaborative session commands.
 *
 * Subcommands:
 *   init    Start a new collaborative session as session master
 *   join    Join an existing session as an attendee
 *   list    List active sessions on the relay server
 *   status  Show current session state and connection details
 *
 * Both init and join launch the full TUI in collaboration mode.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { CollaborationManager, OrchestratorCore, PluginManager, SkillRegistry, McpConnectionManager, createAgent, resolveProviderConfig } from "@qode-agent/runtime";
import type { QollabServerEvent } from "@qode-agent/qollab";
import { QollabSessionServer, QollabSessionClient, QollabAdmission } from "@qode-agent/qollab";
import { startTui } from "../tui/index.js";
import { getCliVersion } from "../version.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const COLLAB_CONFIG_DIR = resolve(homedir(), ".Q", "collab");
const ACTIVE_SESSION_FILE = resolve(COLLAB_CONFIG_DIR, "active-session.json");

// ─── Qollab Config helpers ─────────────────────────────────────────────────

interface SavedSessionConfig {
  sessionId: string;
  role: "master" | "attendee";
  isServer: boolean;
  serverPort?: number;
  clientServerUrl?: string;
  sessionKey?: string;
  userId: string;
  displayName: string;
  createdAt: string;
  projectDir?: string;
}

function loadActiveSession(): SavedSessionConfig | null {
  try {
    if (!existsSync(ACTIVE_SESSION_FILE)) return null;
    const raw = readFileSync(ACTIVE_SESSION_FILE, "utf-8");
    return JSON.parse(raw) as SavedSessionConfig;
  } catch {
    return null;
  }
}

function saveActiveSession(config: SavedSessionConfig): void {
  if (!existsSync(COLLAB_CONFIG_DIR)) {
    mkdirSync(COLLAB_CONFIG_DIR, { recursive: true });
  }
  writeFileSync(ACTIVE_SESSION_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function clearActiveSession(): void {
  try {
    if (existsSync(ACTIVE_SESSION_FILE)) {
      unlinkSync(ACTIVE_SESSION_FILE);
    }
  } catch {
    // ignore
  }
}

// ─── Main collab command handler ──────────────────────────────────────────

export async function collabCommand(
  action: string,
  options?: { sessionKey?: string; port?: number; serverUrl?: string; displayName?: string },
): Promise<void> {
  switch (action) {
    case "init":
      await handleInit(options);
      break;
    case "join":
      if (!options?.sessionKey) {
        console.log(chalk.red("Session key required for join."));
        console.log(chalk.dim("  Usage: q-cli collab join <session-key>"));
        return;
      }
      await handleJoin(options.sessionKey, options);
      break;
    case "list":
      await handleList();
      break;
    case "status":
      await handleStatus();
      break;
    default:
      console.log(chalk.red(`Unknown collab action: ${action}`));
      console.log(chalk.dim("  Available actions: init, join, list, status"));
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function handleInit(
  options?: { port?: number; displayName?: string },
): Promise<void> {
  console.log(chalk.bold("\n  Qollab -- Start Collaborative Session"));
  console.log(chalk.dim("  " + "=".repeat(50)));
  console.log();

  const userId = randomUUID();
  const displayName = options?.displayName ?? "Session Master";
  const port = options?.port ?? 19876;

  // Start the local session server
  const admission = new QollabAdmission();
  const server = new QollabSessionServer({ port, host: "127.0.0.1", admission });
  await server.start();

  // Create admission record — this generates the session key internally
  const { sessionId, sessionKey } = admission.createSession(userId);

  console.log(chalk.green("  Session created successfully!"));
  console.log();
  console.log(chalk.bold("  Session Key:   ") + chalk.yellow(sessionKey));
  console.log(chalk.bold("  Server:        ") + chalk.white("ws://127.0.0.1:" + port));
  console.log(chalk.bold("  Display Name:  ") + chalk.white(displayName));
  console.log();
  console.log(chalk.dim("  In another terminal, run:"));
  console.log(chalk.bold("    q-cli collab join ") + chalk.yellow(sessionKey));
  console.log();
  console.log(chalk.dim("  Launching TUI in collaboration mode..."));
  console.log();

  // Save active session
  saveActiveSession({
    sessionId,
    role: "master",
    isServer: true,
    serverPort: port,
    sessionKey,
    userId,
    displayName,
    createdAt: new Date().toISOString(),
    projectDir: process.cwd(),
  });

  // Create the live session on the server directly (no WebSocket needed for master)
  server.createLiveSession(sessionId, userId, displayName);

  // Create a client for the master to send/receive events
  const client = new QollabSessionClient({
    serverUrl: `ws://127.0.0.1:${port}`,
    sessionKey,
    displayName,
    userId,
    onEvent: (_event: QollabServerEvent) => {
      // Events are handled by the TUI via handleCollabEvent
    },
    onDisconnect: () => {
      console.log(chalk.dim("\n  Disconnected from session."));
    },
    onError: (err) => {
      console.log(chalk.red(`\n  Connection error: ${err.message}`));
    },
  });

  // Connect the master client
  try {
    await client.connect();
  } catch (err) {
    console.log(chalk.red(`\n  Failed to connect: ${err}`));
    return;
  }

  // Launch the TUI in collaboration mode
  await launchCollabTui({
    sessionId,
    userId,
    displayName,
    role: "master",
    client,
    server,
    admission,
    projectDir: process.cwd(),
  });
}

// ─── Join ────────────────────────────────────────────────────────────────────

async function handleJoin(
  sessionKey: string,
  options?: { serverUrl?: string; displayName?: string },
): Promise<void> {
  console.log(chalk.bold("\n  Qollab -- Join Collaborative Session"));
  console.log(chalk.dim("  " + "=".repeat(50)));
  console.log();

  const userId = randomUUID();
  const displayName = options?.displayName ?? process.env.USER ?? "Attendee";
  const serverUrl = options?.serverUrl ?? "ws://127.0.0.1:19876";

  console.log(chalk.dim("  Connecting to ") + chalk.white(serverUrl) + chalk.dim("..."));
  console.log(chalk.dim("  Display name: ") + chalk.white(displayName));
  console.log();

  // Create the client
  const client = new QollabSessionClient({
    serverUrl,
    sessionKey,
    displayName,
    onEvent: (_event: QollabServerEvent) => {
      // Events are handled by the TUI via attachCollab
    },
    onDisconnect: () => {
      console.log(chalk.yellow("\n  Disconnected from session."));
    },
    onError: (err) => {
      console.log(chalk.red(`\n  Connection error: ${err.message}`));
    },
  });

  try {
    await client.connect();
    console.log(chalk.green("  Connected! Waiting for session master approval..."));
    console.log();

    // Save active session
    saveActiveSession({
      sessionId: "pending",
      role: "attendee",
      isServer: false,
      clientServerUrl: serverUrl,
      sessionKey,
      userId,
      displayName,
      createdAt: new Date().toISOString(),
    });

    // Launch the TUI in collaboration mode
    await launchCollabTui({
      sessionId: "pending",
      userId,
      displayName,
      role: "attendee",
      client,
      projectDir: process.cwd(),
    });
  } catch (err) {
    console.log(chalk.red("\n  Failed to join session: " + (err instanceof Error ? err.message : String(err))));
    clearActiveSession();
    process.exit(1);
  }
}

// ─── Launch TUI in Collaboration Mode ─────────────────────────────────────

interface CollabTuiOptions {
  sessionId: string;
  userId: string;
  displayName: string;
  role: "master" | "attendee";
  client: QollabSessionClient;
  server?: QollabSessionServer;
  admission?: QollabAdmission;
  projectDir: string;
}

async function launchCollabTui(options: CollabTuiOptions): Promise<void> {
  const workDir = options.projectDir;
  const providerCfg = resolveProviderConfig(workDir);

  if (!providerCfg) {
    console.log(chalk.yellow("  No provider configured. Collaboration will work for chat but agent features need a provider."));
  }

  const agent = providerCfg
    ? createAgent({ workDir, resolvedProvider: providerCfg, yolo: true, auto: false })
    : null;

  if (agent) {
    try {
      const pluginSkillRegistry = new SkillRegistry({ cwd: workDir });
      const pluginMcpManager = new McpConnectionManager();
      const pluginManager = new PluginManager(pluginSkillRegistry, pluginMcpManager, agent.tools, {}, workDir);
      pluginManager.activateAll().catch(() => {});
    } catch {
      // non-fatal
    }
  }

  const sessionId = options.sessionId;
  const orch = agent
    ? new OrchestratorCore({ convergenceTimeout: 60_000, taskTimeout: 300_000, workspaceRoot: workDir })
    : null;
  if (orch && agent) {
    orch.setAgent(agent);
    orch.setSessionId(sessionId);
    try {
      await orch.initMemorySystem(sessionId);
    } catch {
      // non-fatal
    }
  }

  const tui = await startTui({
    agent: agent ?? ({} as any),
    workDir,
    sessionId,
    model: providerCfg?.model ?? "unknown",
    version: getCliVersion(),
    permissionMode: "manual",
    planMode: false,
    yolo: false,
    auto: false,
    orchestrator: orch
      ? {
          setCurrentMode: (mode: string) => { orch.currentMode = mode as any; },
          getCurrentMode: () => orch.currentMode ?? "not set",
          resolveModusMaximusConfirmation: (response) => { orch.resolveModusMaximusConfirmation(response); },
          submitPrompt: async (prompt: string) => orch.submitPrompt(prompt),
          cancel: () => { orch.cancel(); },
        }
      : undefined,
    collabClient: options.client,
    collabServer: options.server,
    collabAdmission: options.admission,
    collabRole: options.role,
    collabDisplayName: options.displayName,
    collabUserId: options.userId,
  });

  // Wire the collab event handler
  options.client.setEventCallback((event: QollabServerEvent) => {
    // Forward to the TUI's collab event handler
    if (typeof (tui as any).handleCollabEvent === "function") {
      (tui as any).handleCollabEvent(event);
    }
  });

  tui.setOnExit(async () => {
    try { orch?.cancel(); } catch { /* ignore */ }
    options.client.disconnect();
    if (options.server) {
      await options.server.stop();
    }
    clearActiveSession();
  });

  await new Promise<void>(() => {});
}

// ─── List ───────────────────────────────────────────────────────────────────

async function handleList(): Promise<void> {
  console.log(chalk.bold("\n  Qollab -- Active Sessions"));
  console.log(chalk.dim("  " + "=".repeat(50)));
  console.log();

  const active = loadActiveSession();
  if (active) {
    console.log(chalk.cyan("  Active local session:"));
    console.log(chalk.dim("    Role:       ") + chalk.white(active.role));
    console.log(chalk.dim("    Session:    ") + chalk.white(active.sessionId.slice(0, 12) + "..."));
    if (active.isServer) {
      console.log(chalk.dim("    Port:       ") + chalk.white(String(active.serverPort)));
    }
    console.log(chalk.dim("    Display:    ") + chalk.white(active.displayName));
    console.log(chalk.dim("    Created:    ") + chalk.white(active.createdAt));
    console.log();
  } else {
    console.log(chalk.dim("  No active session found."));
    console.log(chalk.dim("  Start one with: q-cli collab init"));
    console.log();
  }
}

// ─── Status ─────────────────────────────────────────────────────────────────

async function handleStatus(): Promise<void> {
  console.log(chalk.bold("\n  Qollab -- Session Status"));
  console.log(chalk.dim("  " + "=".repeat(50)));
  console.log();

  const active = loadActiveSession();
  if (!active) {
    console.log(chalk.yellow("  No active session."));
    console.log(chalk.dim("  Start one with: q-cli collab init"));
    console.log();
    return;
  }

  console.log(chalk.bold("  Session:      ") + chalk.cyan(active.sessionId));
  console.log(chalk.bold("  Role:         ") + chalk.white(active.role === "master" ? "Session Master" : "Attendee"));
  console.log(chalk.bold("  Display Name: ") + chalk.white(active.displayName));
  console.log(chalk.bold("  Created:      ") + chalk.dim(active.createdAt));

  if (active.isServer) {
    console.log(chalk.bold("  Server Port:  ") + chalk.white(String(active.serverPort)));
    console.log(chalk.bold("  Session Key:  ") + chalk.yellow(active.sessionKey ?? "(hidden)"));
  } else {
    console.log(chalk.bold("  Server URL:   ") + chalk.white(active.clientServerUrl ?? "unknown"));
  }

  console.log(chalk.bold("  Project:      ") + chalk.dim(active.projectDir ?? "not set"));
  console.log();
}

// ─── Command Registration ──────────────────────────────────────────────────

export function registerCollabCommand(prog: Command): void {
  const collab = prog
    .command("collab")
    .description("Qollab collaborative session management");

  collab
    .command("init")
    .description("Start a new collaborative session as session master")
    .option("-p, --port <port>", "Server port (default: 19876)")
    .option("-n, --display-name <name>", "Your display name in the session")
    .action(async (opts: { port?: string; displayName?: string }) => {
      await collabCommand("init", {
        port: opts.port ? parseInt(opts.port, 10) : undefined,
        displayName: opts.displayName,
      }).catch((err) => {
        console.error(chalk.red("Collab init error:"), err);
      });
    });

  collab
    .command("join")
    .description("Join an existing collaborative session")
    .argument("<session-key>", "The session key to join")
    .option("-u, --server-url <url>", "Server URL (default: ws://127.0.0.1:19876)")
    .option("-n, --display-name <name>", "Your display name")
    .action(async (sessionKey: string, opts: { serverUrl?: string; displayName?: string }) => {
      await collabCommand("join", {
        sessionKey,
        serverUrl: opts.serverUrl,
        displayName: opts.displayName,
      }).catch((err) => {
        console.error(chalk.red("Collab join error:"), err);
      });
    });

  collab
    .command("list")
    .description("List active collaborative sessions")
    .action(async () => {
      await collabCommand("list").catch((err) => {
        console.error(chalk.red("Collab list error:"), err);
      });
    });

  collab
    .command("status")
    .description("Show current collaboration session status")
    .action(async () => {
      await collabCommand("status").catch((err) => {
        console.error(chalk.red("Collab status error:"), err);
      });
    });
}
