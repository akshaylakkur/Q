/**
 * `q-cli ssh` — Remote cloud execution command group.
 *
 * Subcommands:
 *   connect <host>   — Connect to a remote server, install q-remote, upload
 *                       project + creds, launch daemon, stream events.
 *   resume <host>     — Reconnect to a running remote daemon and stream
 *                       pending logs.
 *   sync <host>       — Bi-directional Git-like sync of code changes.
 *   run <host> <p>    — Inject a prompt into a running remote session.
 *   sessions          — List known remote sessions (local registry).
 *   status <host>     — Show the status of a remote daemon.
 */

import type { Command } from "commander";
import { sshConnect } from "../ssh/commands/connect.js";
import { sshResume } from "../ssh/commands/resume.js";
import { sshSync } from "../ssh/commands/sync.js";
import { sshRun } from "../ssh/commands/run.js";
import type { SshTarget } from "../ssh/types.js";

// ─── Target parsing ──────────────────────────────────────────────────────────

function parseTarget(host: string, opts: { user?: string; port?: string; key?: string }): SshTarget {
  const target: SshTarget = { host };
  if (opts.user) target.user = opts.user;
  if (opts.port) target.port = parseInt(opts.port, 10);
  if (opts.key) target.keyPath = opts.key;
  return target;
}

// ─── Registration ───────────────────────────────────────────────────────────

export function registerSshCommand(prog: Command): void {
  const ssh = prog
    .command("ssh")
    .description("Remote cloud execution — run heavy workflows on an EC2 or custom server");

  // connect
  ssh
    .command("connect <host>")
    .description("Connect to a remote server and start a cloud agent session")
    .option("--user <user>", "SSH user (default: current user)")
    .option("--port <port>", "SSH port (default: 22)")
    .option("--key <path>", "SSH private key path")
    .option("--mode <mode>", "Execution mode (auto|modus_maximus)", "auto")
    .option("--yolo", "Auto-approve all actions on the remote (default for cloud)")
    .option("--session <id>", "Session ID (auto-generated if omitted)")
    .option("--tarball", "Use local tarball instead of npm registry (for development)")
    .option("--force-rebuild", "Force rebuild the q-remote tarball (only with --tarball)")
    .option("--version <version>", "npm package version to install (e.g. 0.2.9)")
    .action(async (host: string, opts: {
      user?: string; port?: string; key?: string;
      mode?: string; yolo?: boolean; session?: string;
      tarball?: boolean; forceRebuild?: boolean; version?: string;
    }) => {
      await sshConnect(parseTarget(host, opts), {
        workDir: process.cwd(),
        mode: opts.mode,
        yolo: opts.yolo,
        session: opts.session,
        tarball: opts.tarball,
        forceRebuild: opts.forceRebuild,
        version: opts.version,
      }).catch((err) => {
        console.error(`SSH connect error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    });

  // resume
  ssh
    .command("resume <host>")
    .description("Reconnect to a running remote daemon and launch the full TUI")
    .option("--user <user>", "SSH user")
    .option("--port <port>", "SSH port")
    .option("--key <path>", "SSH private key path")
    .option("--session <id>", "Session ID to resume (required)")
    .option("--yolo", "Auto-approve all actions on the remote")
    .action(async (host: string, opts: {
      user?: string; port?: string; key?: string; session?: string; yolo?: boolean;
    }) => {
      await sshResume(parseTarget(host, opts), { session: opts.session, yolo: opts.yolo }).catch((err) => {
        console.error(`SSH resume error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    });

  // sync
  ssh
    .command("sync <host>")
    .description("Bi-directional sync of code changes between local and remote")
    .option("--user <user>", "SSH user")
    .option("--port <port>", "SSH port")
    .option("--key <path>", "SSH private key path")
    .option("--session <id>", "Session ID (required)")
    .option("--direction <d>", "Sync direction: both, pull, or push", "both")
    .option("--policy <p>", "Conflict policy: remote-wins, local-wins, prompt, or merge", "prompt")
    .option("--dry-run", "Show what would change without applying")
    .action(async (host: string, opts: {
      user?: string; port?: string; key?: string; session?: string;
      direction?: string; policy?: string; dryRun?: boolean;
    }) => {
      await sshSync(parseTarget(host, opts), {
        session: opts.session,
        direction: opts.direction as "both" | "pull" | "push" | undefined,
        policy: opts.policy as "remote-wins" | "local-wins" | "prompt" | "merge" | undefined,
        dryRun: opts.dryRun,
      }).catch((err) => {
        console.error(`SSH sync error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    });

  // run
  ssh
    .command("run <host> <prompt>")
    .description("Inject a prompt into a running remote session")
    .option("--user <user>", "SSH user")
    .option("--port <port>", "SSH port")
    .option("--key <path>", "SSH private key path")
    .option("--session <id>", "Session ID (required)")
    .option("--mode <m>", "Execution mode (auto|modus_maximus)", "auto")
    .option("--cancel", "Send a cancel command instead of a prompt")
    .action(async (host: string, prompt: string, opts: {
      user?: string; port?: string; key?: string; session?: string;
      mode?: string; cancel?: boolean;
    }) => {
      await sshRun(parseTarget(host, opts), prompt, {
        session: opts.session,
        mode: opts.mode,
        cancel: opts.cancel,
      }).catch((err) => {
        console.error(`SSH run error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    });

  // sessions
  ssh
    .command("sessions")
    .description("List known remote sessions and their current status")
    .option("--active", "Show only active (running) sessions")
    .action(async (opts: { active?: boolean }) => {
      const { readdirSync, readFileSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const { homedir } = await import("node:os");
      const { SshTransport } = await import("../ssh/transport.js");
      const { RemoteSession } = await import("../ssh/remote-session.js");
      const base = resolve(homedir(), ".Q", "ssh-sessions");
      if (!existsSync(base)) {
        console.log("No remote sessions found.");
        return;
      }
      const dirs = readdirSync(base);
      if (dirs.length === 0) {
        console.log("No remote sessions found.");
        return;
      }

      const sessions: Array<{
        id: string;
        host: string;
        user: string;
        mode: string;
        startedAt: string;
        status: "running" | "stopped" | "unknown";
        pid?: number;
      }> = [];

      for (const dir of dirs) {
        const infoPath = resolve(base, dir, "info.json");
        if (!existsSync(infoPath)) continue;
        try {
          const info = JSON.parse(readFileSync(infoPath, "utf-8"));
          const session: typeof sessions[number] = {
            id: info.sessionId,
            host: info.host,
            user: info.user ?? "",
            mode: info.mode,
            startedAt: info.startedAt,
            status: "unknown",
            pid: info.pid,
          };

          // Try to check if the daemon is still running
          try {
            const transport = new SshTransport({ host: info.host, user: info.user, port: info.port });
            const remoteSession = new RemoteSession(info, transport);
            const status = await remoteSession.status();
            session.status = status.running ? "running" : "stopped";
          } catch {
            session.status = "unknown";
          }

          sessions.push(session);
        } catch { /* skip malformed entries */ }
      }

      if (sessions.length === 0) {
        console.log("No remote sessions found.");
        return;
      }

      // Filter to active only if --active flag is set
      const filtered = opts.active ? sessions.filter((s) => s.status === "running") : sessions;

      if (filtered.length === 0) {
        if (opts.active) {
          console.log("No active (running) remote sessions found.");
        } else {
          console.log("No remote sessions found.");
        }
        return;
      }

      // Print header
      const statusLabel = opts.active ? "Active" : "All";
      console.log(`\n  ${statusLabel} Remote Sessions:\n`);

      // Column widths
      const idWidth = Math.max(10, ...filtered.map((s) => s.id.length));
      const hostWidth = Math.max(6, ...filtered.map((s) => `${s.user}@${s.host}`.length));
      const modeWidth = Math.max(6, ...filtered.map((s) => s.mode.length));
      const statusWidth = 9;

      const header = [
        "  Session ID".padEnd(idWidth + 2),
        "Host".padEnd(hostWidth + 2),
        "Mode".padEnd(modeWidth + 2),
        "Status".padEnd(statusWidth + 2),
        "Started",
      ].join("");

      const sep = "  " + "-".repeat(idWidth + hostWidth + modeWidth + statusWidth + 20);

      console.log(header);
      console.log(sep);

      for (const s of filtered) {
        const hostStr = `${s.user}@${s.host}`;
        const statusStr = s.status === "running"
          ? "running"
          : s.status === "stopped"
            ? "stopped"
            : "unreachable";
        const started = s.startedAt ? new Date(s.startedAt).toLocaleString() : "unknown";
        console.log(
          "  " +
          s.id.padEnd(idWidth + 2) +
          hostStr.padEnd(hostWidth + 2) +
          s.mode.padEnd(modeWidth + 2) +
          statusStr.padEnd(statusWidth + 2) +
          started,
        );
      }

      console.log("");

      // Show resume hint for running sessions
      const running = filtered.filter((s) => s.status === "running");
      if (running.length > 0) {
        console.log("  To reconnect to a running session:");
        console.log(`    q-cli ssh resume <host> --session <session-id>\n`);
      }
    });

  // delete-session
  ssh
    .command("delete-session <session-id>")
    .description("Delete a saved session from the local registry. Optionally shut down the remote daemon first.")
    .option("--shutdown", "Send a shutdown command to the remote daemon before deleting")
    .option("--force", "Delete without confirmation")
    .action(async (sessionId: string, opts: { shutdown?: boolean; force?: boolean }) => {
      const { existsSync, readFileSync, unlinkSync, rmSync, readdirSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const { homedir } = await import("node:os");
      const sessionDir = resolve(homedir(), ".Q", "ssh-sessions", sessionId);
      const infoPath = resolve(sessionDir, "info.json");

      if (!existsSync(infoPath)) {
        console.error(`No session found with ID: ${sessionId}`);
        console.error(`Run \`q-cli ssh sessions\` to see known sessions.`);
        process.exit(1);
      }

      // Load info for display
      const info = JSON.parse(readFileSync(infoPath, "utf-8"));
      const hostStr = info.user ? `${info.user}@${info.host}` : info.host;

      // Confirm unless --force
      if (!opts.force) {
        console.log(`\n  Session: ${sessionId}`);
        console.log(`  Host:    ${hostStr}`);
        console.log(`  Mode:    ${info.mode}`);
        console.log(`  Started: ${info.startedAt ? new Date(info.startedAt).toLocaleString() : "unknown"}`);
        console.log(`\n  Delete this session from the local registry?`);
        console.log(`  (use --force to skip this prompt)\n`);

        // Simple stdin confirmation
        const { stdin } = await import("node:process");
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question("  Type 'yes' to confirm: ", resolve);
        });
        rl.close();

        if (answer.trim().toLowerCase() !== "yes") {
          console.log("  Aborted.");
          return;
        }
      }

      // Optionally shut down the remote daemon first
      if (opts.shutdown) {
        console.log(`  Sending shutdown to remote daemon on ${hostStr}...`);
        try {
          const { SshTransport } = await import("../ssh/transport.js");
          const { RemoteSession } = await import("../ssh/remote-session.js");
          const transport = new SshTransport({ host: info.host, user: info.user, port: info.port });
          const remoteSession = new RemoteSession(info, transport);
          const status = await remoteSession.status();
          if (status.running) {
            await remoteSession.shutdown();
            console.log("  Shutdown command sent.");
          } else {
            console.log("  Remote daemon is not running, skipping shutdown.");
          }
        } catch (err) {
          console.error(`  Could not reach remote: ${err instanceof Error ? err.message : String(err)}`);
          console.log("  Proceeding with local deletion anyway.");
        }
      }

      // Delete the session directory
      try {
        rmSync(sessionDir, { recursive: true, force: true });
        console.log(`  Session ${sessionId} deleted.`);
      } catch (err) {
        console.error(`  Failed to delete session: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}