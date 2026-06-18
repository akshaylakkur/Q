/**
 * `q-cli ssh connect <host>` — the full connect flow.
 *
 * Orchestrates: validate SSH → check Node → build+upload q-remote →
 * collect+encrypt creds → upload creds → upload project snapshot →
 * launch remote daemon (nohup) → transition to remote-streaming TUI.
 *
 * Each step shows text-based progress (no icons, per project rules).
 */

import { SshTransport } from "../transport.js";
import { ensureRemoteReady } from "../install.js";
import { collectLocalCredentials, encryptCredentials, generatePassphrase, generateSessionId } from "../credentials.js";
import { createProjectSnapshot, uploadProjectSnapshot } from "../upload.js";
import { ensureQRemoteTarball } from "../pack.js";
import { RemoteSession } from "../remote-session.js";
import { StepProgress } from "../progress.js";
import type { SshTarget } from "../types.js";
import type { RemoteSessionInfo } from "@qode-agent/protocol";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { writeSync } from "node:fs";

// ─── sshConnect ───────────────────────────────────────────────────────────────

export interface ConnectOptions {
  workDir: string;
  mode?: string;
  yolo?: boolean;
  session?: string;
  /** Force rebuild the q-remote tarball. */
  forceRebuild?: boolean;
}

export async function sshConnect(
  target: SshTarget,
  opts: ConnectOptions,
): Promise<void> {
  const steps = new StepProgress(8);
  const transport = new SshTransport(target, { verbose: false });

  // ── Step 1: Validate SSH connection ──────────────────────────────────────
  steps.start("Establishing SSH connection");
  const conn = await transport.testConnection();
  if (!conn.ok) {
    steps.fail(`could not reach ${target.host}`);
    process.stderr.write(`\nFailed to establish SSH connection to ${target.host}.\n`);
    process.stderr.write("Check that the host is reachable and your SSH key is configured.\n");
    process.exit(1);
  }
  steps.done();

  // ── Step 2: Check remote Node + install q-remote ──────────────────────────
  steps.start("Building q-remote package");
  const tarballPath = ensureQRemoteTarball({ force: opts.forceRebuild });
  steps.done();

  steps.start("Installing remote agent");
  let remoteReady;
  try {
    remoteReady = await ensureRemoteReady(transport, { qRemoteTarballPath: tarballPath });
  } catch (err) {
    steps.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  steps.done(remoteReady.skipped ? "(already installed)" : `v${remoteReady.version}`);

  // ── Step 3: Collect + encrypt credentials ────────────────────────────────
  steps.start("Securing credentials");
  let creds;
  try {
    creds = collectLocalCredentials(opts.workDir);
  } catch (err) {
    steps.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const passphrase = generatePassphrase();
  const credsBlob = encryptCredentials(creds, passphrase);
  steps.done();

  // ── Step 4: Upload credentials + passphrase ──────────────────────────────
  steps.start("Uploading credentials");
  const sessionId = opts.session ?? generateSessionId();
  // Resolve remote home directory (scp doesn't expand ~)
  const remoteHomeResult = await transport.exec("echo ~", { timeoutMs: 5_000 });
  const remoteHome = remoteHomeResult.ok ? remoteHomeResult.stdout.trim() : "/home/ubuntu";
  const remoteWorkspace = `${remoteHome}/q-workspace/${sessionId}`;
  const remoteCredsPath = `/tmp/q-cred-${sessionId}.enc`;
  // Upload the encrypted creds file
  // We need to write the blob locally first, then scp it
  const tmpCredsLocal = resolve(homedir(), ".Q", "tmp", `q-cred-${sessionId}.enc`);
  mkdirSync(resolve(homedir(), ".Q", "tmp"), { recursive: true });
  writeFileSync(tmpCredsLocal, credsBlob);
  try {
    await transport.uploadFile(tmpCredsLocal, remoteCredsPath);
    // Set permissions on remote
    await transport.exec(`chmod 600 '${remoteCredsPath}'`);
    // Upload the passphrase to a separate tmp file the daemon will read + delete
    const remotePassphrasePath = await transport.writeRemoteTmpFile(passphrase, ".pass");
    steps.done();
    // Use --passphrase-file to avoid shell escaping issues with the passphrase
    await launchDaemonAndAttach(transport, target, opts, sessionId, remoteWorkspace, remoteCredsPath, remotePassphrasePath, conn, steps);
  } catch (err) {
    steps.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    try { require("node:fs").unlinkSync(tmpCredsLocal); } catch { /* */ }
  }
}

// ─── launchDaemonAndAttach ──────────────────────────────────────────────────

async function launchDaemonAndAttach(
  transport: SshTransport,
  target: SshTarget,
  opts: ConnectOptions,
  sessionId: string,
  remoteWorkspace: string,
  remoteCredsPath: string,
  remotePassphrasePath: string,
  conn: { ok: boolean; info: { nodeVersion?: string; arch: string; platform: string } },
  steps: StepProgress,
): Promise<void> {
  // ── Step 5: Create + upload project snapshot ─────────────────────────────
  steps.start("Creating project snapshot");
  let tarballPath: string;
  try {
    tarballPath = await createProjectSnapshot(opts.workDir);
  } catch (err) {
    steps.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  steps.done();

  steps.start("Uploading project snapshot");
  try {
    // Create the remote workspace
    await transport.exec(`mkdir -p '${remoteWorkspace}'`);
    await uploadProjectSnapshot(transport, tarballPath, remoteWorkspace);
    // Cleanup local tarball
    try { require("node:fs").unlinkSync(tarballPath); } catch { /* */ }
  } catch (err) {
    steps.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  steps.done();

  // ── Step 6: Launch remote daemon (nohup) ────────────────────────────────
  steps.start("Starting remote agent");
  const remoteCredsAbs = remoteCredsPath; // already absolute (/tmp/...)
  const mode = opts.mode ?? "auto";
  const permissionMode = opts.yolo ? "yolo" : "auto";
  const daemonCmd = `nohup q-remote daemon --workspace '${remoteWorkspace}' --session '${sessionId}' --creds '${remoteCredsAbs}' --passphrase-file '${remotePassphrasePath}' --mode '${mode}' --permission '${permissionMode}' > /tmp/q-daemon-${sessionId}.log 2>&1 & echo $!`;
  const launchResult = await transport.exec(daemonCmd, { timeoutMs: 15_000 });
  if (!launchResult.ok) {
    steps.fail(`daemon launch failed: ${launchResult.stderr}`);
    process.exit(1);
  }
  const pid = parseInt(launchResult.stdout.trim(), 10);
  // Wait for the daemon to be ready (poll status)
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const statusResult = await transport.exec(`q-remote status --workspace '${remoteWorkspace}'`, { timeoutMs: 5_000 });
    if (statusResult.ok) {
      try {
        const status = JSON.parse(statusResult.stdout);
        if (status.running) { ready = true; break; }
      } catch { /* */ }
    }
  }
  if (!ready) {
    steps.fail("daemon did not become ready");
    process.exit(1);
  }
  steps.done(`pid ${pid}`);

  // ── Step 7: Transition to remote-streaming TUI ──────────────────────────
  steps.start("Launching remote TUI");
  steps.done();

  // Build the RemoteSessionInfo
  const info: RemoteSessionInfo = {
    host: target.host,
    user: target.user,
    port: target.port,
    sessionId,
    workspace: remoteWorkspace,
    remoteNodeVersion: conn.info.nodeVersion ?? "unknown",
    remoteArch: conn.info.arch,
    remotePlatform: conn.info.platform,
    startedAt: new Date().toISOString(),
    pid,
    mode,
  };

  // Save session info locally for resume
  const sessionDir = resolve(homedir(), ".Q", "ssh-sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(resolve(sessionDir, "info.json"), JSON.stringify(info, null, 2), "utf-8");

  // Create the remote session wrapper
  const remoteSession = new RemoteSession(info, transport);

  // Create a headless agent that acts as a proxy to the remote
  const { createAgent, resolveProviderConfig } = await import("@qode-agent/runtime");
  const providerCfg = resolveProviderConfig(opts.workDir);
  if (!providerCfg) {
    process.stderr.write("No provider configured locally. The remote daemon has its own credentials.\n");
    process.stderr.write("Launching TUI in remote mode anyway.\n");
  }
  const agent = providerCfg ? createAgent({ workDir: opts.workDir, resolvedProvider: providerCfg, yolo: opts.yolo }) : null;
  if (!agent) {
    process.stderr.write("Warning: could not create local agent proxy. Remote mode will still work.\n");
  }

  // Launch the TUI in remote mode
  const { startTui } = await import("../../tui/index.js");
  const tui = await startTui({
    agent: agent!,
    workDir: opts.workDir,
    sessionId,
    model: providerCfg?.model ?? "remote",
    version: "0.1.0",
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