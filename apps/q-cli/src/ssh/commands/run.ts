/**
 * `q-cli ssh run <host> <prompt>` — inject a prompt into a running remote
 * daemon session without launching the TUI.
 *
 * This is the manual-intervention path: the user can send a new prompt
 * (or a cancel command) to a running session from the command line.
 */

import { SshTransport } from "../transport.js";
import { RemoteSession } from "../remote-session.js";
import type { SshTarget } from "../types.js";
import type { RemoteSessionInfo } from "@qode-agent/protocol";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface RunOptions {
  session?: string;
  mode?: string;
  /** Send a cancel command instead of a prompt. */
  cancel?: boolean;
}

export async function sshRun(
  target: SshTarget,
  prompt: string,
  opts: RunOptions,
): Promise<void> {
  const sessionId = opts.session;
  if (!sessionId) {
    process.stderr.write("Error: --session <id> is required for run.\n");
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
  const remoteSession = new RemoteSession(info, transport);

  // Check if the daemon is running
  let status;
  try {
    status = await remoteSession.status();
  } catch (err) {
    process.stderr.write(`Failed to query remote status: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  if (!status.running) {
    process.stderr.write("The remote daemon is not running. Use `q-cli ssh connect` to start a new session.\n");
    process.exit(1);
  }

  if (opts.cancel) {
    await remoteSession.sendControl({ cmd: "cancel" });
    process.stdout.write("Cancel command sent.\n");
    return;
  }

  // Send the prompt
  const mode = opts.mode ?? "auto";
  await remoteSession.sendControl({ cmd: "prompt", text: prompt, mode });
  process.stdout.write(`Prompt sent to session ${sessionId} (mode: ${mode}).\n`);
  process.stdout.write("The remote daemon is processing it. Use `q-cli ssh resume` to stream the output.\n");
}