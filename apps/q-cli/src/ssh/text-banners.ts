/**
 * Text-based banners for the QSSH remote session header.
 *
 * Uses box-drawing characters only — no icons, no emoji, per project rules.
 */

import type { RemoteSessionInfo } from "@qode-agent/protocol";

/**
 * Render the remote session info as a box-drawn banner.
 */
export function renderSessionBanner(info: RemoteSessionInfo): string {
  const hostStr = info.user ? `${info.user}@${info.host}` : info.host;
  const lines: [string, string][] = [
    ["Host:", hostStr],
    ["Session:", info.sessionId],
    ["Mode:", info.mode],
    ["Node:", info.remoteNodeVersion],
    ["Arch:", info.remoteArch],
    ["Platform:", info.remotePlatform],
    ["Workspace:", info.workspace],
    ["Started:", info.startedAt],
    ["PID:", String(info.pid)],
  ];

  const labelWidth = Math.max(...lines.map(([k]) => k.length));
  const valWidth = Math.max(...lines.map(([, v]) => v.length));
  const innerWidth = Math.max("QSSH Remote Session".length + 4, labelWidth + valWidth + 4, 44);
  const borderTop = "+" + "-".repeat(innerWidth + 2) + "+";

  const result: string[] = [borderTop];
  result.push("| " + pad("QSSH Remote Session", innerWidth) + " |");
  result.push(borderTop);
  for (const [key, val] of lines) {
    const line = "  " + pad(key, labelWidth) + " " + val;
    result.push("| " + pad(line, innerWidth) + " |");
  }
  result.push(borderTop);
  return result.join("\n");
}

/**
 * Render a connection health status line (no icons).
 */
export function renderHealthLine(health: "live" | "degraded" | "lost", lastBeatAgeS?: number, retryInfo?: { attempt: number; max: number; nextInS: number }): string {
  switch (health) {
    case "live":
      return `Connection: live${lastBeatAgeS !== undefined ? ` (last beat ${lastBeatAgeS}s ago)` : ""}`;
    case "degraded":
      return `Connection: degraded${retryInfo ? ` — retry ${retryInfo.attempt}/${retryInfo.max} in ${retryInfo.nextInS}s` : ""}`;
    case "lost":
      return `Connection: lost${retryInfo ? ` — exhausted ${retryInfo.max} retries` : ""}. Press R to reconnect, Q to quit.`;
  }
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}