/**
 * @q/qmain — Core type definitions for the execution environment abstraction.
 *
 * Defines the result and process handle types used across all Qmain
 * implementations (local, SSH, Docker, etc.).
 */

/** Result from executing a command */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Handle for a background process */
export interface ProcessHandle {
  pid: number;
  kill: (signal?: string) => void;
  wait: () => Promise<ExecResult>;
}
