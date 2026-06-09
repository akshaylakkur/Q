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
