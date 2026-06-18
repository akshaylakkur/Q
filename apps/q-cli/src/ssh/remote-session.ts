/**
 * RemoteSession — manages the live connection to a running remote daemon.
 *
 * Provides:
 *   - streamEvents: tail -f the remote events.log via SSH, parse NDJSON,
 *     and invoke a callback for each envelope.
 *   - sendControl: append a control command to the remote control.jsonl
 *     file (file-based, nohup-safe).
 *   - status: query the remote daemon status.
 *   - shutdown: send a shutdown command.
 *   - replay: stream historical events from a given seq (for resume).
 */

import { SshTransport } from "./transport.js";
import type {
  NdjsonEnvelope,
  ControlCommand,
  RemoteStatus,
  RemoteSessionInfo,
} from "@qode-agent/protocol";
import { parseEnvelope } from "@qode-agent/protocol";

// ─── RemoteSession ───────────────────────────────────────────────────────────

export class RemoteSession {
  readonly info: RemoteSessionInfo;
  readonly transport: SshTransport;
  private lastSeenSeq = 0;
  private abortController: AbortController | null = null;

  constructor(info: RemoteSessionInfo, transport: SshTransport) {
    this.info = info;
    this.transport = transport;
  }

  /**
   * The events log path on the remote.
   */
  get eventsLogPath(): string {
    return `${this.info.workspace}/.q-remote/events.log`;
  }

  /**
   * The control file path on the remote.
   */
  get controlFilePath(): string {
    return `${this.info.workspace}/.q-remote/control.jsonl`;
  }

  /**
   * Stream events from the remote events.log, starting from `fromSeq`.
   * Uses `tail -n +<line> -f` for replay + live follow.
   *
   * Returns when the stream ends (SSH disconnect) or the abort signal fires.
   */
  async streamEvents(
    onEvent: (env: NdjsonEnvelope) => void,
    opts?: { fromSeq?: number; onStderr?: (line: string) => void },
  ): Promise<void> {
    const fromSeq = opts?.fromSeq ?? this.lastSeenSeq + 1;
    // tail -n +N reads from line N onwards; we use seq-based filtering client-side
    // For simplicity, tail the whole file + follow. The client filters by seq.
    const cmd = `tail -n +1 -f '${this.eventsLogPath.replace(/'/g, "'\\''")}'`;
    this.abortController = new AbortController();

    await this.transport.execStream(
      cmd,
      (line: string) => {
        const env = parseEnvelope(line);
        if (!env) return;
        if (env.seq < fromSeq) return; // skip already-seen events
        this.lastSeenSeq = Math.max(this.lastSeenSeq, env.seq);
        onEvent(env);
      },
      {
        onStderr: opts?.onStderr,
        signal: this.abortController.signal,
      },
    );
  }

  /**
   * Stop the current event stream (if any).
   */
  stopStream(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  /**
   * Send a control command to the remote daemon by appending to control.jsonl.
   */
  async sendControl(cmd: ControlCommand): Promise<void> {
    const json = JSON.stringify(cmd).replace(/'/g, "'\\''");
    const escaped = json.replace(/'/g, "'\\''");
    const cmd2 = `echo '${escaped}' >> '${this.controlFilePath.replace(/'/g, "'\\''")}'`;
    const result = await this.transport.exec(cmd2);
    if (!result.ok) {
      throw new Error(`Failed to send control command: ${result.stderr}`);
    }
  }

  /**
   * Query the remote daemon status via `q-remote status`.
   */
  async status(): Promise<RemoteStatus> {
    const result = await this.transport.exec(
      `q-remote status --workspace '${this.info.workspace.replace(/'/g, "'\\''")}'`,
      { timeoutMs: 10_000 },
    );
    if (!result.ok) {
      throw new Error(`Status query failed: ${result.stderr}`);
    }
    try {
      return JSON.parse(result.stdout) as RemoteStatus;
    } catch {
      throw new Error(`Status parse failed: ${result.stdout}`);
    }
  }

  /**
   * Send a shutdown command to the remote daemon.
   */
  async shutdown(): Promise<void> {
    await this.sendControl({ cmd: "shutdown" });
  }

  /**
   * Get the last seen event seq (for resume tracking).
   */
  get lastSeq(): number {
    return this.lastSeenSeq;
  }

  /**
   * Set the last seen seq (used when resuming after reading persisted state).
   */
  set lastSeq(seq: number) {
    this.lastSeenSeq = seq;
  }
}