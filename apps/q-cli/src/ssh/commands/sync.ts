/**
 * `q-cli ssh sync <host>` — bi-directional Git-like sync.
 *
 * Syncs code changes between the local workspace and the remote workspace.
 * Uses the initial snapshot as the 3-way merge baseline.
 */

import { SshTransport } from "../transport.js";
import { biDirectionalSync, type SyncOptions } from "../sync.js";
import { StepProgress } from "../progress.js";
import type { SshTarget } from "../types.js";
import type { RemoteSessionInfo, SyncDirection, ConflictPolicy } from "@qode-agent/protocol";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

export interface SyncCommandOptions {
  session?: string;
  direction?: SyncDirection;
  policy?: ConflictPolicy;
  dryRun?: boolean;
  workDir?: string;
}

export async function sshSync(
  target: SshTarget,
  opts: SyncCommandOptions,
): Promise<void> {
  const sessionId = opts.session;
  if (!sessionId) {
    process.stderr.write("Error: --session <id> is required for sync.\n");
    process.exit(1);
  }

  // Load session info
  const sessionDir = resolve(homedir(), ".Q", "ssh-sessions", sessionId);
  const infoPath = resolve(sessionDir, "info.json");
  if (!existsSync(infoPath)) {
    process.stderr.write(`No saved session found for ID: ${sessionId}\n`);
    process.exit(1);
  }
  const info = JSON.parse(readFileSync(infoPath, "utf-8")) as RemoteSessionInfo;

  const transport = new SshTransport(target);
  const localWorkDir = opts.workDir ?? process.cwd();
  const baselineDir = resolve(sessionDir, "baseline");

  const steps = new StepProgress(3);
  steps.start("Establishing SSH connection");
  const conn = await transport.testConnection();
  if (!conn.ok) {
    steps.fail(`could not reach ${target.host}`);
    process.exit(1);
  }
  steps.done();

  steps.start("Computing file manifests");
  steps.done();

  steps.start("Syncing files");
  const syncOpts: SyncOptions = {
    direction: opts.direction ?? "both",
    conflictPolicy: opts.policy ?? "prompt",
    dryRun: opts.dryRun ?? false,
  };
  const report = await biDirectionalSync(transport, info.workspace, localWorkDir, baselineDir, syncOpts);
  steps.done();

  // Print the report
  process.stdout.write("\n");
  process.stdout.write("Sync Report\n");
  process.stdout.write("----------\n");
  process.stdout.write(`  Direction:     ${report.direction}\n`);
  process.stdout.write(`  Policy:        ${report.policy}\n`);
  process.stdout.write(`  Pulled:        ${report.pulled} file(s)\n`);
  process.stdout.write(`  Pushed:        ${report.pushed} file(s)\n`);
  process.stdout.write(`  Conflicts:     ${report.conflicts}\n`);
  process.stdout.write(`  Resolved:      ${report.conflictsResolved}\n`);
  if (report.dryRun) process.stdout.write(`  (dry-run — no changes applied)\n`);
  if (report.errors.length > 0) {
    process.stdout.write(`  Errors:\n`);
    for (const e of report.errors) {
      process.stdout.write(`    - ${e}\n`);
    }
  }
  process.stdout.write("\n");
}