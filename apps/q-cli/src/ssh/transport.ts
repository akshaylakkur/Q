/**
 * SSH transport — wraps ssh/scp execution with typed results, timeouts,
 * and live line-by-line stdout streaming.
 *
 * Used by the q-cli ssh subcommands (connect, resume, sync, run) to
 * communicate with the remote EC2 / custom server.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { ExecResult, SshTarget } from "./types.js";

// ─── SshTransport ──────────────────────────────────────────────────────────

export interface TransportOptions {
  /** SSH connect timeout in seconds (passed as -o ConnectTimeout). Default 10. */
  connectTimeoutS?: number;
  /** Print ssh commands to stderr before executing. Default false. */
  verbose?: boolean;
}

export class SshTransport {
  readonly target: SshTarget;
  readonly connectTimeoutS: number;
  readonly verbose: boolean;

  constructor(target: SshTarget, opts?: TransportOptions) {
    this.target = target;
    this.connectTimeoutS = opts?.connectTimeoutS ?? 10;
    this.verbose = opts?.verbose ?? false;
  }

  // ─── SSH target string ────────────────────────────────────────────────────

  /** Build the ssh target string: user@host (or just host). */
  get targetStr(): string {
    return this.target.user ? `${this.target.user}@${this.target.host}` : this.target.host;
  }

  /** Build the common ssh options array. */
  private sshOpts(): string[] {
    const opts = [
      "-o", `ConnectTimeout=${this.connectTimeoutS}`,
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
    ];
    if (this.target.port) {
      opts.push("-p", String(this.target.port));
    }
    if (this.target.keyPath) {
      opts.push("-i", this.target.keyPath);
    }
    return opts;
  }

  /** Build the scp port option (scp uses -P not -p). */
  private scpPortOpt(): string[] {
    return this.target.port ? ["-P", String(this.target.port)] : [];
  }
  private scpKeyOpt(): string[] {
    return this.target.keyPath ? ["-i", this.target.keyPath] : [];
  }

  // ─── exec ─────────────────────────────────────────────────────────────────

  /**
   * Execute a command on the remote host and return the full output.
   */
  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return new Promise((resolvePromise) => {
      const args = [...this.sshOpts(), this.targetStr, cmd];
      if (this.verbose) process.stderr.write(`[ssh] ssh ${args.join(" ")}\n`);
      const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timeout = opts?.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeout) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeout);
      }

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolvePromise({
          ok: !timedOut && code === 0,
          exitCode: code ?? -1,
          stdout,
          stderr,
        });
      });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolvePromise({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: stderr + `\n${err.message}`,
        });
      });
    });
  }

  // ─── execStream ──────────────────────────────────────────────────────────

  /**
   * Execute a command and stream stdout line-by-line to a callback.
   * Used for live event streaming (tail -f of the remote events.log).
   */
  async execStream(
    cmd: string,
    onLine: (line: string) => void,
    opts?: { onStderr?: (line: string) => void; signal?: AbortSignal },
  ): Promise<ExecResult> {
    return new Promise((resolvePromise) => {
      const args = [...this.sshOpts(), this.targetStr, cmd];
      if (this.verbose) process.stderr.write(`[ssh] ssh ${args.join(" ")}\n`);
      const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let stdoutBuf = "";
      let stderrBuf = "";

      child.stdout?.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stdout += chunk;
        stdoutBuf += chunk;
        let idx;
        while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          onLine(line);
        }
      });

      child.stderr?.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        stderrBuf += chunk;
        let idx;
        while ((idx = stderrBuf.indexOf("\n")) >= 0) {
          const line = stderrBuf.slice(0, idx);
          stderrBuf = stderrBuf.slice(idx + 1);
          opts?.onStderr?.(line);
        }
      });

      const abortSignal = opts?.signal;
      if (abortSignal) {
        if (abortSignal.aborted) {
          child.kill("SIGTERM");
        } else {
          abortSignal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
        }
      }

      child.on("close", (code) => {
        // Flush remaining buffered lines
        if (stdoutBuf.trim()) onLine(stdoutBuf);
        resolvePromise({ ok: code === 0, exitCode: code ?? -1, stdout, stderr });
      });
      child.on("error", (err) => {
        resolvePromise({ ok: false, exitCode: -1, stdout, stderr: stderr + `\n${err.message}` });
      });
    });
  }

  // ─── uploadFile (scp) ──────────────────────────────────────────────────────

  /**
   * Upload a single file via scp.
   */
  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const args = [...this.scpPortOpt(), ...this.scpKeyOpt(), localPath, `${this.targetStr}:${remotePath}`];
      if (this.verbose) process.stderr.write(`[scp] scp ${args.join(" ")}\n`);
      const child = spawn("scp", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("close", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`scp failed (exit ${code}): ${stderr}`));
      });
      child.on("error", reject);
    });
  }

  /**
   * Upload a directory via tar piped over ssh.
   * Creates the remote directory first, then streams the tarball.
   */
  async uploadDir(localDir: string, remoteDir: string, opts?: { exclude?: string[] }): Promise<void> {
    const excludeArgs = (opts?.exclude ?? []).flatMap((p) => ["--exclude", p]);
    return new Promise((resolvePromise, reject) => {
      // Step 1: ensure remote dir exists
      const mkdirCmd = `mkdir -p '${remoteDir.replace(/'/g, "'\\''")}'`;
      const sshArgs = [...this.sshOpts(), this.targetStr, mkdirCmd];
      if (this.verbose) process.stderr.write(`[ssh] ssh ${sshArgs.join(" ")}\n`);
      const mkdirChild = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
      mkdirChild.on("close", (mkdirCode) => {
        if (mkdirCode !== 0) {
          reject(new Error(`Failed to create remote dir: ${remoteDir}`));
          return;
        }
        // Step 2: tar | ssh 'tar x'
        const tarArgs = ["czf", "-", "-C", localDir, ...excludeArgs, "."];
        const remoteExtract = `tar xzf - -C '${remoteDir.replace(/'/g, "'\\''")}'`;
        const sshExtractArgs = [...this.sshOpts(), this.targetStr, remoteExtract];
        if (this.verbose) process.stderr.write(`[tar|ssh] tar ${tarArgs.join(" ")} | ssh ${sshExtractArgs.join(" ")}\n`);
        const tarChild = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"] });
        const sshChild = spawn("ssh", sshExtractArgs, { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        sshChild.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
        tarChild.stdout?.pipe(sshChild.stdin);
        sshChild.on("close", (code) => {
          if (code === 0) resolvePromise();
          else reject(new Error(`Remote tar extract failed (exit ${code}): ${stderr}`));
        });
        sshChild.on("error", reject);
        tarChild.on("error", reject);
      });
      mkdirChild.on("error", reject);
    });
  }

  // ─── downloadFile (scp) ────────────────────────────────────────────────────

  /**
   * Download a single file from the remote via scp.
   */
  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const args = [...this.scpPortOpt(), ...this.scpKeyOpt(), `${this.targetStr}:${remotePath}`, localPath];
      if (this.verbose) process.stderr.write(`[scp] scp ${args.join(" ")}\n`);
      const child = spawn("scp", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("close", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`scp download failed (exit ${code}): ${stderr}`));
      });
      child.on("error", reject);
    });
  }

  // ─── testConnection ───────────────────────────────────────────────────────

  /**
   * Test SSH connectivity and gather remote environment info.
   */
  async testConnection(): Promise<{ ok: boolean; info: { nodeVersion?: string; arch: string; platform: string } }> {
    // Run a combined command that prints: node_version|arch|platform
    const cmd = "node --version 2>/dev/null; echo '|'; uname -m 2>/dev/null || echo unknown; echo '|'; uname -s 2>/dev/null || echo unknown";
    const result = await this.exec(cmd, { timeoutMs: 15_000 });
    if (!result.ok) {
      return { ok: false, info: { arch: "unknown", platform: "unknown" } };
    }
    const parts = result.stdout.split("|").map((s) => s.trim());
    const nodeVersion = parts[0] || undefined;
    const arch = parts[1] || "unknown";
    const platform = parts[2] || "unknown";
    return { ok: true, info: { nodeVersion, arch, platform } };
  }

  /**
   * Write a passphrase to a remote tmp file with chmod 600, returning the path.
   * The file is meant to be read + deleted by the daemon on startup.
   */
  async writeRemoteTmpFile(content: string, suffix: string = ".tmp"): Promise<string> {
    const tmpName = `q-${randomBytes(8).toString("hex")}${suffix}`;
    const remotePath = `/tmp/${tmpName}`;
    // Use a heredoc-safe approach: base64-encode and decode on the remote
    const b64 = Buffer.from(content, "utf-8").toString("base64");
    const cmd = `echo '${b64}' | base64 -d > '${remotePath}' && chmod 600 '${remotePath}' && echo '${remotePath}'`;
    const result = await this.exec(cmd);
    if (!result.ok) throw new Error(`Failed to write remote tmp file: ${result.stderr}`);
    return result.stdout.trim();
  }

  /**
   * Delete a remote file (best-effort).
   */
  async deleteRemoteFile(path: string): Promise<void> {
    await this.exec(`rm -f '${path.replace(/'/g, "'\\''")}'`).catch(() => {});
  }
}