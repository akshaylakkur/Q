/**
 * SSH module shared types.
 */

import type { ConnectionHealth } from "@qode-agent/protocol";

export interface SshTarget {
  host: string;
  user?: string;
  port?: number;
  /** Path to an SSH private key. */
  keyPath?: string;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type { ConnectionHealth };