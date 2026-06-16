import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";

import { exportSession, importSession, replaySession, buildReplayNotice } from "../records/export-import.js";
import type { ExportManifest } from "../records/export-import.js";
import { getSessionsBase, SessionStore } from "../records/session-store.js";
import { readFirstRecord } from "../records/wire.js";
import { createAgent, resolveProviderConfig } from "../agent/wiring.js";

/**
 * Session management — handles list, show, delete, export, import, replay.
 */

const SESSIONS_BASE = resolve(process.env.HOME ?? "/tmp", ".Q", "sessions");

export async function sessionCommand(
  action: string,
  options?: { id?: string; output?: string; includeMemory?: boolean },
): Promise<void> {
  switch (action) {
    case "list":
      await listSessions();
      break;
    case "show":
      if (!options?.id) {
        console.log(chalk.red("✗ Session ID required."));
        console.log(chalk.dim("  Usage: q-cli session show --id <session-id>"));
        return;
      }
      await showSession(options.id);
      break;
    case "delete":
      if (!options?.id) {
        console.log(chalk.red("✗ Session ID required."));
        console.log(chalk.dim("  Usage: q-cli session delete --id <session-id>"));
        return;
      }
      await deleteSession(options.id);
      break;
    case "export":
      if (!options?.id) {
        console.log(chalk.red("✗ Session ID required."));
        console.log(chalk.dim("  Usage: q-cli session export --id <session-id> [-o <output>]"));
        return;
      }
      await handleExport(options.id, options.output, options?.includeMemory);
      break;
    case "import":
      await handleImport(options?.output);
      break;
    case "replay": {
      if (!options?.id) {
        console.log(chalk.red("✗ Session ID required."));
        console.log(chalk.dim("  Usage: q-cli session replay --id <session-id>"));
        return;
      }
      await handleReplay(options.id);
      break;
    }
    default:
      console.log(chalk.red(`✗ Unknown session action: ${action}`));
      console.log(chalk.dim("  Available actions: list, show, delete, export, import, replay"));
  }
}

async function listSessions(): Promise<void> {
  console.log(chalk.bold("V Sessions"));
  console.log();

  const store = new SessionStore();
  const sessions = store.list();

  if (sessions.length === 0) {
    console.log(chalk.dim("  No sessions found."));
    return;
  }

  for (const s of sessions) {
    const date = new Date(s.createdAt).toLocaleDateString();
    const idShort = s.id.slice(0, 8);
    console.log(
      `  ${chalk.cyan(idShort)}  ${chalk.dim(date)}  ${s.name ?? "unnamed"}  ${chalk.dim(s.model ?? "")}`,
    );
  }
  console.log();
}

async function showSession(id: string): Promise<void> {
  console.log(chalk.bold(`V Session: ${id}`));
  const sessionDir = resolve(SESSIONS_BASE, id);

  if (!existsSync(sessionDir)) {
    console.log(chalk.red(`✗ Session not found: ${id}`));
    return;
  }

  const store = new SessionStore();
  const meta = store.get(id);

  console.log(chalk.dim("  ID: ") + chalk.white(id));
  if (meta?.createdAt) console.log(chalk.dim("  Created: ") + chalk.white(new Date(meta.createdAt).toLocaleString()));
  if (meta?.updatedAt) console.log(chalk.dim("  Updated: ") + chalk.white(new Date(meta.updatedAt).toLocaleString()));
  if (meta?.model) console.log(chalk.dim("  Model: ") + chalk.white(meta.model));
  if (meta?.workspaceDirectory) console.log(chalk.dim("  Workspace: ") + chalk.white(meta.workspaceDirectory));
  if (meta?.recordCount !== undefined) console.log(chalk.dim("  Records: ") + chalk.white(String(meta.recordCount)));
  if (meta?.blobCount !== undefined) console.log(chalk.dim("  Blobs: ") + chalk.white(String(meta.blobCount)));
  if (meta?.sizeBytes !== undefined) console.log(chalk.dim("  Size: ") + chalk.white(formatSize(meta.sizeBytes)));
  console.log(chalk.dim("  Path: ") + chalk.white(sessionDir));
  console.log();
}

async function deleteSession(id: string): Promise<void> {
  console.log(chalk.bold(`V Delete Session: ${id}`));
  const store = new SessionStore();
  await store.delete(id);
  console.log(chalk.green(`  ✓ Session deleted: ${id}`));
}

async function handleExport(
  id: string,
  outputPath?: string,
  includeMemory?: boolean,
): Promise<void> {
  const path = outputPath ?? `${id}.zip`;
  console.log(chalk.bold(`V Export Session: ${id}`));
  await exportSession(id, path, { includeMemory });
}

async function handleImport(outputPath?: string): Promise<void> {
  if (!outputPath) {
    console.log(chalk.red("✗ Zip file path required."));
    console.log(chalk.dim("  Usage: q-cli session import <zip-path>"));
    return;
  }
  console.log(chalk.bold(`V Import Session from: ${outputPath}`));
  await importSession(outputPath);
  console.log();
}

async function handleReplay(sessionId: string): Promise<void> {
  const sessionDir = resolve(SESSIONS_BASE, sessionId);
  if (!existsSync(sessionDir)) {
    console.log(chalk.red(`✗ Session not found: ${sessionId}`));
    return;
  }

  console.log(chalk.bold(`V Replay Session: ${sessionId}`));
  console.log(chalk.dim("  Reconstructing agent state from wire file…"));

  // Read the manifest info from the first wire record
  const wirePath = resolve(sessionDir, "wire.jsonl");
  let manifest: ExportManifest | undefined;
  if (existsSync(wirePath)) {
    try {
      const firstRecord = await readFirstRecord(wirePath);
      if (firstRecord && firstRecord.type === "metadata") {
        manifest = {
          version: 1,
          wireVersion: 1,
          exportedAt: firstRecord.createdAt ?? "",
          sessionId,
          recordCount: 0,
          blobCount: 0,
          modelName: firstRecord.model,
          agentProfile: "auto",
          executionMode: "auto",
          cwd: "",
          files: [],
          blobs: [],
        };
      }
    } catch {
      // best-effort
    }
  }

  // Create an agent for replay
  const workDir = manifest?.cwd ?? process.cwd();
  const providerCfg = resolveProviderConfig(workDir);

  if (!providerCfg) {
    console.log(chalk.yellow("⚠ No provider configured. Session context will be replayed without an active model."));
  }

  const agent = createAgent({
    workDir,
    resolvedProvider: providerCfg ?? undefined,
  });

  if (!agent) {
    console.log(chalk.yellow("⚠ Could not create agent. Replaying records in dry-run mode."));
  }

  // Replay the session
  try {
    if (agent) {
      await replaySession(sessionId, agent, manifest);
    }
  } catch (err) {
    console.error(chalk.red("✗ Replay failed:"), err);
    return;
  }

  console.log(chalk.green(`✓ Session ${sessionId} replayed successfully.`));
  console.log(chalk.dim("  Use 'q-cli --session <id>' to continue the session in interactive mode."));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Register the `q-cli session` command with Commander.
 */
export function registerSessionCommand(prog: import("commander").Command): void {
  prog
    .command("session")
    .description("Session management (list | show | delete | export | import | replay)")
    .argument("<action>", "Session action: list, show, delete, export, import, replay")
    .option("-i, --id <id>", "Session ID")
    .option("-o, --output <path>", "Output path (for export/import)")
    .option("--include-memory", "Include LTPM memory files in export")
    .action(async (action: string, opts: { id?: string; output?: string; includeMemory?: boolean }) => {
      await sessionCommand(action, opts).catch((err) => {
        console.error(chalk.red("Session command error:"), err);
      });
    });
}