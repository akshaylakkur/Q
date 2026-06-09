import { execFile, spawn } from "node:child_process";
import { access, constants, mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { glob as fastGlob } from "fs/promises";
import path from "node:path";
import os from "node:os";
import type { Qmain, ExecOptions } from "./qmain.js";
import type { ExecResult, ProcessHandle } from "./types.js";

/**
 * LocalQmain — Executes operations on the local machine
 * using Node.js built-in APIs.
 */
export class LocalQmain implements Qmain {
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
  }

  async readText(filePath: string): Promise<string> {
    return readFile(filePath, "utf-8");
  }

  async writeText(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, content, "utf-8");
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    return readFile(filePath);
  }

  async writeBytes(filePath: string, data: Uint8Array): Promise<void> {
    await writeFile(filePath, data);
  }

  async readLines(filePath: string): Promise<string[]> {
    const content = await this.readText(filePath);
    return content.split(/\r?\n/);
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    await mkdir(dirPath, { recursive: options?.recursive ?? true });
  }

  async glob(pattern: string, options?: { cwd?: string }): Promise<string[]> {
    const results: string[] = [];
    for await (const entry of fastGlob(pattern, { cwd: options?.cwd ?? this.cwd })) {
      results.push(entry);
    }
    return results;
  }

  async iterDir(dirPath: string): Promise<string[]> {
    return readdir(dirPath);
  }

  async stat(targetPath: string): Promise<{ isFile: boolean; isDir: boolean; size: number; mtimeMs: number }> {
    const s = await stat(targetPath);
    return {
      isFile: s.isFile(),
      isDir: s.isDirectory(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  normpath(...segments: string[]): string {
    return path.resolve(...segments);
  }

  async getCwd(): Promise<string> {
    return this.cwd;
  }

  async getHome(): Promise<string> {
    return os.homedir();
  }

  async chdir(newDir: string): Promise<void> {
    await access(newDir, constants.R_OK | constants.X_OK);
    this.cwd = path.resolve(newDir);
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
      const child = execFile(
        "/bin/sh",
        ["-c", command],
        {
          cwd: options?.cwd ?? this.cwd,
          timeout: options?.timeout,
          env: options?.env ? { ...process.env, ...options.env } : process.env,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: error !== null && error.code !== undefined ? (typeof error.code === "number" ? error.code : 1) : 0,
          });
        },
      );
      child.on("error", () => {
        resolve({ stdout: "", stderr: "Failed to spawn process", exitCode: 1 });
      });
    });
  }

  async execWithEnv(command: string, env: Record<string, string>, options?: ExecOptions): Promise<ExecResult> {
    return this.exec(command, { ...options, env });
  }

  execBackground(command: string, options?: ExecOptions): ProcessHandle {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: options?.cwd ?? this.cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout?.on("data", (data: Buffer) => stdout.push(data.toString()));
    child.stderr?.on("data", (data: Buffer) => stderr.push(data.toString()));

    const processHandle: ProcessHandle = {
      pid: child.pid ?? 0,
      kill: (signal?: string) => {
        child.kill(signal as NodeJS.Signals);
      },
      wait: () =>
        new Promise<ExecResult>((resolve) => {
          child.on("close", (exitCode) => {
            resolve({
              stdout: stdout.join(""),
              stderr: stderr.join(""),
              exitCode: exitCode ?? 0,
            });
          });
        }),
    };

    return processHandle;
  }
}
