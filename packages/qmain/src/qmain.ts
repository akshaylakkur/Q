import type { ExecResult, ProcessHandle } from "./types.js";

/**
 * Qmain — Abstract execution environment interface.
 *
 * Provides file operations, process execution, and path
 * manipulation abstracted over local, SSH, Docker, etc.
 */
export interface Qmain {
  /** Read a text file from the filesystem */
  readText(path: string): Promise<string>;

  /** Write text content to a file */
  writeText(path: string, content: string): Promise<void>;

  /** Read raw bytes */
  readBytes(path: string): Promise<Uint8Array>;

  /** Write raw bytes */
  writeBytes(path: string, data: Uint8Array): Promise<void>;

  /** Read lines of a text file */
  readLines(path: string): Promise<string[]>;

  /** Create a directory (optional recursive) */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  /** Glob files matching a pattern */
  glob(pattern: string, options?: { cwd?: string }): Promise<string[]>;

  /** Iterate over directory entries */
  iterDir(path: string): Promise<string[]>;

  /** Get file/directory stats */
  stat(path: string): Promise<{ isFile: boolean; isDir: boolean; size: number; mtimeMs: number }>;

  /** Normalize a path */
  normpath(...segments: string[]): string;

  /** Get current working directory */
  getCwd(): Promise<string>;

  /** Get home directory */
  getHome(): Promise<string>;

  /** Change working directory */
  chdir(path: string): Promise<void>;

  /** Execute a command and wait for result */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Execute with custom environment variables */
  execWithEnv(command: string, env: Record<string, string>, options?: ExecOptions): Promise<ExecResult>;

  /** Execute a long-running command in the background */
  execBackground(command: string, options?: ExecOptions): ProcessHandle;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  stdin?: string;
  onStderr?: (data: string) => void;
}
