import { access } from "node:fs/promises";
import { sep, delimiter } from "node:path";
import { platform } from "node:os";
import type { Qmain, ExecOptions } from "../qmain.js";
import type { ExecResult } from "../types.js";

/**
 * Options for ShellConnector
 */
export interface ShellConnectorOptions {
  /** Default working directory */
  cwd?: string;
}

/**
 * Extended ProcessHandle with async iteration over stdout/stderr.
 */
export interface ShellProcessHandle {
  pid: number;
  kill: (signal?: string) => void;
  wait: () => Promise<ExecResult>;
  /** Async iterable for stdout stream */
  stdout: AsyncIterable<string>;
  /** Async iterable for stderr stream */
  stderr: AsyncIterable<string>;
  /** Callback for streaming output */
  onOutput: (callback: (data: { channel: "stdout" | "stderr"; data: string }) => void) => void;
}

/**
 * ShellConnector — Process execution built on top of Qmain.
 *
 * Provides exec, execBackground, which, and pty (with optional node-pty).
 */
export class ShellConnector {
  private qmain: Qmain;
  private cwd: string | undefined;

  constructor(qmain: Qmain, opts?: ShellConnectorOptions) {
    this.qmain = qmain;
    this.cwd = opts?.cwd;
  }

  /**
   * Update the default working directory.
   */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /**
   * Execute a command and wait for the result.
   */
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.qmain.exec(command, { ...opts, cwd: opts?.cwd ?? this.cwd });
  }

  /**
   * Execute a command in the background.
   * Returns a ShellProcessHandle with pid, kill(), wait(), and async iterables.
   *
   * Note: The async iterables and onOutput callback all resolve after the
   * process completes, as the underlying Qmain interface doesn't provide
   * per-chunk streaming.
   */
  execBackground(command: string, opts?: ExecOptions): ShellProcessHandle {
    const handle = this.qmain.execBackground(command, { ...opts, cwd: opts?.cwd ?? this.cwd });

    // Cache the wait promise so all consumers share one result
    const waitPromise = handle.wait();

    const processHandle: ShellProcessHandle = {
      pid: handle.pid,
      kill: (signal?: string) => handle.kill(signal),
      wait: () => waitPromise,
      stdout: {
        [Symbol.asyncIterator](): AsyncIterator<string> {
          let resolved = false;
          let data: string[] = [];
          const pending: Array<(value: IteratorResult<string>) => void> = [];

          waitPromise.then((result) => {
            resolved = true;
            data = result.stdout ? [result.stdout] : [];
            for (const resolve of pending.splice(0)) {
              if (data.length > 0) {
                resolve({ value: data.shift()!, done: false });
              } else {
                resolve({ value: undefined as unknown as string, done: true });
              }
            }
          });

          return {
            next() {
              if (resolved) {
                if (data.length > 0) {
                  return Promise.resolve({ value: data.shift()!, done: false });
                }
                return Promise.resolve({ value: undefined as unknown as string, done: true });
              }
              return new Promise((resolve) => {
                pending.push(resolve);
              });
            },
          };
        },
      },
      stderr: {
        [Symbol.asyncIterator](): AsyncIterator<string> {
          let resolved = false;
          let data: string[] = [];
          const pending: Array<(value: IteratorResult<string>) => void> = [];

          waitPromise.then((result) => {
            resolved = true;
            data = result.stderr ? [result.stderr] : [];
            for (const resolve of pending.splice(0)) {
              if (data.length > 0) {
                resolve({ value: data.shift()!, done: false });
              } else {
                resolve({ value: undefined as unknown as string, done: true });
              }
            }
          });

          return {
            next() {
              if (resolved) {
                if (data.length > 0) {
                  return Promise.resolve({ value: data.shift()!, done: false });
                }
                return Promise.resolve({ value: undefined as unknown as string, done: true });
              }
              return new Promise((resolve) => {
                pending.push(resolve);
              });
            },
          };
        },
      },
      onOutput: (callback) => {
        waitPromise.then((result) => {
          if (result.stdout) {
            callback({ channel: "stdout", data: result.stdout });
          }
          if (result.stderr) {
            callback({ channel: "stderr", data: result.stderr });
          }
        });
      },
    };

    return processHandle;
  }

  /**
   * Find a binary on the system PATH.
   * Returns the full path to the binary, or null if not found.
   *
   * Supports both Unix (:) and Windows (;) PATH separators.
   */
  async which(binary: string): Promise<string | null> {
    // First try the `which` command (Unix) or `where` (Windows)
    const whichCmd = platform() === "win32" ? "where" : "which";
    try {
      const result = await this.qmain.exec(`${whichCmd} "${binary.replace(/"/g, '\\"')}" 2>/dev/null`);
      if (result.exitCode === 0) {
        const path = result.stdout.trim().split("\n")[0]?.trim();
        if (path) return path;
      }
    } catch {
      // Fall through
    }

    // Manual PATH traversal as fallback
    const pathEnv = process.env.PATH ?? "";
    const pathSep = delimiter; // ":" on Unix, ";" on Windows
    const dirSep = sep; // "/" on Unix, "\" on Windows
    const pathDirs = pathEnv.split(pathSep).filter((p) => p.length > 0);

    for (const dir of pathDirs) {
      const fullPath = `${dir}${dirSep}${binary}`;
      try {
        await access(fullPath, 0o111);
        return fullPath;
      } catch {
        continue;
      }
    }

    // On Windows, also try with common extensions
    if (platform() === "win32") {
      for (const ext of [".exe", ".bat", ".cmd", ".com"]) {
        for (const dir of pathDirs) {
          const fullPath = `${dir}${dirSep}${binary}${ext}`;
          try {
            await access(fullPath, 0o111);
            return fullPath;
          } catch {
            continue;
          }
        }
      }
    }

    return null;
  }

  /**
   * Run a command in a pseudo-terminal for interactive tools.
   *
   * Uses node-pty if available. Falls back to exec with simplified output.
   */
  async pty(
    command: string,
    onOutput: (data: string) => void,
  ): Promise<{ exitCode: number }> {
    // Try to use node-pty
    const nodePtyModule = await tryImportNodePty();
    if (nodePtyModule) {
      try {
        return await this.runPtyWithNodePty(command, onOutput, nodePtyModule);
      } catch {
        // Fall through to basic exec
      }
    }

    // Fallback: use exec with streaming via execBackground
    return this.runPtyFallback(command, onOutput);
  }

  /**
   * Run command with node-pty for full PTY support.
   */
  private async runPtyWithNodePty(
    command: string,
    onOutput: (data: string) => void,
    nodePty: NodePtyModule,
  ): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      const shell = process.env.SHELL || "/bin/sh";
      const ptyProcess = nodePty.spawn(shell, ["-c", command], {
        name: "xterm-256color",
        cols: 80,
        rows: 30,
        cwd: this.cwd ?? process.cwd(),
        env: process.env as Record<string, string>,
      });

      ptyProcess.onData((data: string) => {
        onOutput(data);
      });

      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        resolve({ exitCode });
      });

      ptyProcess.on("error", (err: Error) => {
        reject(err);
      });
    });
  }

  /**
   * Fallback for PTY when node-pty is not available.
   */
  private async runPtyFallback(
    command: string,
    onOutput: (data: string) => void,
  ): Promise<{ exitCode: number }> {
    const handle = this.execBackground(command);
    handle.onOutput(({ channel, data }) => {
      onOutput(`[${channel}] ${data}`);
    });
    const result = await handle.wait();
    return { exitCode: result.exitCode };
  }
}

/**
 * Minimal interface for node-pty to avoid needing type declarations.
 */
interface NodePtyModule {
  spawn: (
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ) => {
    onData: (callback: (data: string) => void) => void;
    onExit: (callback: (status: { exitCode: number }) => void) => void;
    on: (event: string, callback: (err: Error) => void) => void;
  };
}

/**
 * Try to dynamically import node-pty (optional dependency).
 */
async function tryImportNodePty(): Promise<NodePtyModule | null> {
  try {
    // Dynamic import via Function constructor to bypass TypeScript module resolution
    // node-pty is an optional dependency that may not be installed
    const imp = new Function("mod", "return import(mod)") as (mod: string) => Promise<unknown>;
    const mod = await imp("node-pty");
    return mod as unknown as NodePtyModule;
  } catch {
    return null;
  }
}
