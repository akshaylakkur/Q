/**
 * Heartbeat Bar Component — shows the connection health status as a single
 * text line (no icons, per project rules).
 *
 * Updates via a 1-second interval timer that refreshes the "last beat age".
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ColorPalette } from "../types.js";
import type { ConnectionHealth } from "@qode-agent/protocol";

export class HeartbeatBarComponent implements Component {
  private colors: ColorPalette;
  private health: ConnectionHealth = "live";
  private lastBeatAt = Date.now();
  private retryInfo: { attempt: number; max: number; nextInS: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onRenderRequest: (() => void) | null = null;

  constructor(colors: ColorPalette) {
    this.colors = colors;
  }

  invalidate(): void {}

  /**
   * Set the callback to request a re-render (wired to ui.requestRender).
   */
  setRenderRequester(fn: () => void): void {
    this.onRenderRequest = fn;
  }

  /**
   * Start the 1-second update timer.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.onRenderRequest?.();
    }, 1000);
  }

  /**
   * Stop the timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Update the health state.
   */
  setHealth(health: ConnectionHealth, retryInfo?: { attempt: number; max: number; nextInS: number }): void {
    this.health = health;
    if (health === "live") this.lastBeatAt = Date.now();
    if (retryInfo) this.retryInfo = retryInfo;
    this.onRenderRequest?.();
  }

  /**
   * Record a heartbeat receipt (resets the age counter).
   */
  noteBeat(): void {
    this.lastBeatAt = Date.now();
    if (this.health !== "live") {
      this.health = "live";
      this.retryInfo = null;
      this.onRenderRequest?.();
    }
  }

  render(width: number): string[] {
    const ageS = Math.floor((Date.now() - this.lastBeatAt) / 1000);
    let text: string;
    let color: string;

    switch (this.health) {
      case "live":
        text = `Connection: live (last beat ${ageS}s ago)`;
        color = this.colors.statusSuccess;
        break;
      case "degraded":
        text = this.retryInfo
          ? `Connection: degraded — retry ${this.retryInfo.attempt}/${this.retryInfo.max} in ${this.retryInfo.nextInS}s`
          : "Connection: degraded — retrying...";
        color = this.colors.statusWarning;
        break;
      case "lost":
        text = "Connection: lost. Press R to reconnect, Q to quit.";
        color = this.colors.statusError;
        break;
    }

    const styled = chalk.hex(color);
    return [truncateToWidth("  " + styled(text), width)];
  }
}