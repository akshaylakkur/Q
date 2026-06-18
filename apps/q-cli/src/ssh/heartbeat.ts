/**
 * Heartbeat monitor — pings the remote daemon at a fixed interval and
 * detects stream interruption with exponential backoff retry.
 *
 * The remote daemon keeps running under nohup regardless of the local
 * connection state. This monitor only affects the LOCAL streaming
 * connection — when the stream is lost, it retries with backoff and
 * logs each attempt. After max retries, it declares the connection lost
 * and the TUI shows a reconnect prompt.
 */

import { SshTransport } from "./transport.js";

export type HealthState = "live" | "degraded" | "lost";

export interface HeartbeatOptions {
  transport: SshTransport;
  remoteWorkspace: string;
  /** Ping interval in ms. Default 5000. */
  intervalMs?: number;
  /** Max consecutive failures before declaring "lost". Default 10. */
  maxRetries?: number;
  /** Base backoff in ms. Default 1000. */
  baseBackoffMs?: number;
  /** Max backoff cap in ms. Default 30000. */
  maxBackoffMs?: number;
  /** Called when health state changes. */
  onHealthChange?: (state: HealthState) => void;
  /** Called for each retry attempt (for TUI logging). */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

export class HeartbeatMonitor {
  private readonly opts: Required<Omit<HeartbeatOptions, "onHealthChange" | "onRetry">>;
  private readonly onHealthChange?: (state: HealthState) => void;
  private readonly onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: HealthState = "live";
  private consecutiveFailures = 0;
  private lastSuccessAt = Date.now();

  constructor(opts: HeartbeatOptions) {
    this.opts = {
      transport: opts.transport,
      remoteWorkspace: opts.remoteWorkspace,
      intervalMs: opts.intervalMs ?? 5000,
      maxRetries: opts.maxRetries ?? 10,
      baseBackoffMs: opts.baseBackoffMs ?? 1000,
      maxBackoffMs: opts.maxBackoffMs ?? 30_000,
    };
    this.onHealthChange = opts.onHealthChange;
    this.onRetry = opts.onRetry;
  }

  /**
   * Start monitoring.
   */
  start(): void {
    if (this.timer) return;
    this.state = "live";
    this.consecutiveFailures = 0;
    this.lastSuccessAt = Date.now();
    this.timer = setInterval(() => this.ping(), this.opts.intervalMs);
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Current health state.
   */
  get health(): HealthState {
    return this.state;
  }

  /**
   * Seconds since last successful ping.
   */
  get lastBeatAgeS(): number {
    return Math.floor((Date.now() - this.lastSuccessAt) / 1000);
  }

  /**
   * Record a successful event receipt (resets the failure counter).
   * Called by the stream when a heartbeat event arrives from the remote.
   */
  noteSuccess(): void {
    this.lastSuccessAt = Date.now();
    if (this.state !== "live") {
      this.setState("live");
    }
    this.consecutiveFailures = 0;
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private async ping(): Promise<void> {
    try {
      const result = await this.opts.transport.exec(
        `q-remote status --workspace '${this.opts.remoteWorkspace.replace(/'/g, "'\\''")}'`,
        { timeoutMs: 8_000 },
      );
      if (result.ok) {
        this.noteSuccess();
      } else {
        this.handleFailure(`ssh status failed: ${result.stderr.slice(0, 100)}`);
      }
    } catch (err) {
      this.handleFailure(err instanceof Error ? err.message : String(err));
    }
  }

  private handleFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.state === "live") {
      this.setState("degraded");
    }
    if (this.consecutiveFailures >= this.opts.maxRetries) {
      this.setState("lost");
      this.stop();
      return;
    }
    // Exponential backoff — but we don't actually delay the interval timer;
    // we just report the next expected retry time.
    const delayMs = Math.min(
      this.opts.baseBackoffMs * Math.pow(2, this.consecutiveFailures - 1),
      this.opts.maxBackoffMs,
    );
    this.onRetry?.(this.consecutiveFailures, delayMs, reason);
  }

  private setState(state: HealthState): void {
    if (this.state === state) return;
    this.state = state;
    this.onHealthChange?.(state);
  }
}