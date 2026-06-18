/**
 * `q-cli ssh resume <host>` — reconnect to a running remote daemon and
 * launch the full TUI, just like `ssh connect`.
 *
 * Flow:
 *   1. Load the saved session info (from ~/.Q/ssh-sessions/<id>/info.json).
 *   2. Test SSH connection.
 *   3. Query remote daemon status.
 *   4. If running: launch the TUI with the remote session attached.
 *   5. If not running: offer to restart or stream the static log.
 */

import { SshTransport } from "../transport.js";
import { RemoteSession } from "../remote-session.js";
import { StepProgress } from "../progress.js";
import { renderSessionBanner } from "../text-banners.js";
import type { SshTarget } from "../types.js";
import type { RemoteSessionInfo } from "@qode-agent/protocol";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { writeSync } from "node:fs";
import { getCliVersion } from "../../version.js";

export interface ResumeOptions {
  session?: string;
  yolo?: boolean;
}

export async function sshResume(
  target: SshTarget,
  opts: ResumeOptions,
): Promise<void> {
  // Find the session info
  const sessionId = opts.session;
  if (!sessionId) {
    process.stderr.write("Error: --session <id> is required for resume.\n");
    process.stderr.write("List known sessions with: q-cli ssh sessions\n");
    process.exit(1);
  }

  const sessionDir = resolve(homedir(), ".Q", "ssh-sessions", sessionId);
  const infoPath = resolve(sessionDir, "info.json");
  if (!existsSync(infoPath)) {
    process.stderr.write(`No saved session found for ID: ${sessionId}\n`);
    process.stderr.write(`Look in ~/.Q/ssh-sessions/ for known session IDs.\n`);
    process.exit(1);
  }

  const info = JSON.parse(readFileSync(infoPath, "utf-8")) as RemoteSessionInfo;
  const transport = new SshTransport(target);

  // Test connection
  const steps = new StepProgress(3);
  steps.start("Establishing SSH connection");
  const conn = await transport.testConnection();
  if (!conn.ok) {
    steps.fail(`could not reach ${target.host}`);
    process.exit(1);
  }
  steps.done();

  // Check daemon status
  steps.start("Checking remote daemon");
  const remoteSession = new RemoteSession(info, transport);
  let status;
  try {
    status = await remoteSession.status();
  } catch (err) {
    steps.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  steps.done(status.running ? "running" : "not running");

  if (!status.running) {
    process.stderr.write("\nThe remote daemon is not running.\n");
    process.stderr.write("It may have completed or crashed. You can:\n");
    process.stderr.write("  - Reconnect with `q-cli ssh connect` to start a new session\n");
    process.stderr.write("  - Stream the static log (events from before it stopped)\n\n");
    // Offer to stream the static log
    steps.start("Streaming static event log");
    try {
      await remoteSession.streamEvents((env) => {
        writeSync(1, JSON.stringify(env) + "\n");
      });
    } catch {
      // stream ends when tail -f hits EOF on a non-running process
    }
    steps.done();
    return;
  }

  // Print the banner to stderr so it shows before the TUI takes over
  process.stderr.write("\n" + renderSessionBanner(info) + "\n\n");

  // ── Launch the TUI in remote mode (same as connect) ────────────────────
  steps.start("Launching remote TUI");
  steps.done();

  // Create a headless agent that acts as a proxy to the remote
  const { createAgent, resolveProviderConfig } = await import("@qode-agent/runtime");
  const workDir = process.cwd();
  const providerCfg = resolveProviderConfig(workDir);
  if (!providerCfg) {
    process.stderr.write("No provider configured locally. The remote daemon has its own credentials.\n");
    process.stderr.write("Launching TUI in remote mode anyway.\n");
  }
  const agent = providerCfg ? createAgent({ workDir, resolvedProvider: providerCfg, yolo: opts.yolo }) : null;
  if (!agent) {
    process.stderr.write("Warning: could not create local agent proxy. Remote mode will still work.\n");
  }

  // Launch the TUI
  const { startTui } = await import("../../tui/index.js");
  const tui = await startTui({
    agent: agent!,
    workDir,
    sessionId,
    model: providerCfg?.model ?? "remote",
    version: getCliVersion(),
    permissionMode: opts.yolo ? "yolo" : "auto",
    planMode: false,
    yolo: opts.yolo ?? false,
    auto: !opts.yolo,
  });

  // Attach the remote session to the TUI
  tui.attachRemote(
    {
      sendControl: (cmd: unknown) => remoteSession.sendControl(cmd as any),
      stopStream: () => remoteSession.stopStream(),
      shutdown: () => remoteSession.shutdown(),
    },
    info,
    async (handler) => {
      await remoteSession.streamEvents((env) => {
        handler(env);
      });
    },
  );

  // Wait for the TUI to exit
  await new Promise<void>((resolve) => {
    tui.setOnExit(() => resolve());
  });
}
