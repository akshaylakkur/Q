/**
 * Collab — Command handlers for Category 8 (Qollab Collaboration).
 *
 * Implements:
 *  /admit <userId>              — Admit a pending attendee (master only)
 *  /reject <userId> [reason]    — Reject a pending attendee (master only)
 *  /kick <userId>               — Remove an attendee (master only)
 *  /msg <text>                  — Send a chat message to all participants
 *  /whisper <userId> <text>     — Send a private message
 *  /snapshot-push               — Force-update the global snapshot (master only)
 *  /snapshot-pull               — Download the latest snapshot
 *  /snapshot-sync <prompt>      — Request agentic merge into master's snapshot
 *  /snapshot-approve <id>       — Accept a proposed snapshot (master only)
 *  /snapshot-reject <reason>    — Reject a proposed snapshot (master only)
 *  /snapshot-diff [<id>]        — Show diff between snapshots
 *  /collab-status               — Show full collaboration status
 *  /collab-rekey                — Generate a new session key (master only)
 */

import type { SlashCommandHost } from "./types.js";

// ─── /admit ──────────────────────────────────────────────────────────

export function handleAdmitCommand(host: SlashCommandHost, args: string): void {
  const userId = args.trim();
  if (!userId) {
    host.showError("Usage: /admit <userId>");
    return;
  }
  if (!host.collabAdmit) {
    host.showError("Collaboration is not active.");
    return;
  }
  host.collabAdmit(userId);
  host.showStatus(`Admit request sent for ${userId.slice(0, 8)}...`);
}

// ─── /reject ────────────────────────────────────────────────────────

export function handleRejectCommand(host: SlashCommandHost, args: string): void {
  const parts = args.trim().split(/\s+/);
  const userId = parts[0] ?? "";
  const reason = parts.slice(1).join(" ");
  if (!userId) {
    host.showError("Usage: /reject <userId> [reason]");
    return;
  }
  if (!host.collabReject) {
    host.showError("Collaboration is not active.");
    return;
  }
  host.collabReject(userId, reason || undefined);
  host.showStatus(`Reject request sent for ${userId.slice(0, 8)}...`);
}

// ─── /kick ──────────────────────────────────────────────────────────

export function handleKickCommand(host: SlashCommandHost, args: string): void {
  const userId = args.trim();
  if (!userId) {
    host.showError("Usage: /kick <userId>");
    return;
  }
  if (!host.collabKick) {
    host.showError("Collaboration is not active.");
    return;
  }
  host.collabKick(userId);
  host.showStatus(`Kick request sent for ${userId.slice(0, 8)}...`);
}

// ─── /msg ───────────────────────────────────────────────────────────

export function handleMsgCommand(host: SlashCommandHost, args: string): void {
  const text = args.trim();
  if (!text) {
    host.showError("Usage: /msg <text>");
    return;
  }
  if (!host.collabSendChat) {
    host.showError("Collaboration is not active. Use /msg only in a collab session.");
    return;
  }
  host.collabSendChat(text);
  host.showStatus(`[You] ${text}`);
}

// ─── /whisper ───────────────────────────────────────────────────────

export function handleWhisperCommand(host: SlashCommandHost, args: string): void {
  const parts = args.trim().split(/\s+/);
  const targetUserId = parts[0] ?? "";
  const text = parts.slice(1).join(" ");
  if (!targetUserId || !text) {
    host.showError("Usage: /whisper <userId> <text>");
    return;
  }
  if (!host.collabSendWhisper) {
    host.showError("Collaboration is not active.");
    return;
  }
  host.collabSendWhisper(targetUserId, text);
  host.showStatus(`[Whisper to ${targetUserId.slice(0, 8)}...] ${text}`);
}

// ─── /snapshot-push ─────────────────────────────────────────────────

export function handleSnapshotPushCommand(host: SlashCommandHost, _args: string): void {
  if (!host.collabSnapshotPush) {
    host.showError("Collaboration is not active or you are not the master.");
    return;
  }
  host.collabSnapshotPush();
  host.showStatus("Snapshot push requested...");
}

// ─── /snapshot-pull ────────────────────────────────────────────────

export function handleSnapshotPullCommand(host: SlashCommandHost, _args: string): void {
  if (!host.collabSnapshotPull) {
    host.showError("Collaboration is not active.");
    return;
  }
  host.collabSnapshotPull();
  host.showStatus("Snapshot pull requested...");
}

// ─── /snapshot-sync ────────────────────────────────────────────────

export function handleSnapshotSyncCommand(host: SlashCommandHost, args: string): void {
  const prompt = args.trim();
  if (!prompt) {
    host.showError("Usage: /snapshot-sync <prompt describing the changes>");
    return;
  }
  if (!host.collabSnapshotSync) {
    host.showError("Collaboration is not active.");
    return;
  }
  host.collabSnapshotSync(prompt);
  host.showStatus(`Snapshot sync request sent: "${prompt.slice(0, 80)}..."`);
}

// ─── /snapshot-approve ─────────────────────────────────────────────

export function handleSnapshotApproveCommand(host: SlashCommandHost, args: string): void {
  const snapshotId = args.trim();
  if (!snapshotId) {
    host.showError("Usage: /snapshot-approve <snapshotId>");
    return;
  }
  if (!host.collabSnapshotApprove) {
    host.showError("Collaboration is not active or you are not the master.");
    return;
  }
  host.collabSnapshotApprove(snapshotId);
  host.showStatus(`Snapshot ${snapshotId.slice(0, 8)}... approved.`);
}

// ─── /snapshot-reject ──────────────────────────────────────────────

export function handleSnapshotRejectCommand(host: SlashCommandHost, args: string): void {
  const reason = args.trim();
  if (!reason) {
    host.showError("Usage: /snapshot-reject <reason>");
    return;
  }
  if (!host.collabSnapshotReject) {
    host.showError("Collaboration is not active or you are not the master.");
    return;
  }
  host.collabSnapshotReject(reason);
  host.showStatus(`Snapshot rejected: ${reason}`);
}

// ─── /snapshot-diff ────────────────────────────────────────────────

export function handleSnapshotDiffCommand(host: SlashCommandHost, _args: string): void {
  if (!host.collabSnapshotPull) {
    host.showError("Collaboration is not active.");
    return;
  }
  host.showStatus("Snapshot diff — pull the latest snapshot to compare.");
  host.collabSnapshotPull?.();
}

// ─── /collab-status ────────────────────────────────────────────────

export function handleCollabStatusCommand(host: SlashCommandHost, _args: string): void {
  if (!host.collabShowStatus) {
    host.showError("Collaboration is not active.");
    return;
  }
  host.collabShowStatus();
}

// ─── /collab-key ──────────────────────────────────────────────────

export function handleCollabKeyCommand(host: SlashCommandHost, _args: string): void {
  if (!host.collabShowKey) {
    host.showError("Collaboration is not active.");
    return;
  }
  host.collabShowKey();
}

// ─── /collab-rekey ────────────────────────────────────────────────

export function handleCollabRekeyCommand(host: SlashCommandHost, _args: string): void {
  if (!host.collabAdmit) {
    host.showError("Collaboration is not active or you are not the master.");
    return;
  }
  host.showStatus("Session rekeying is not yet implemented in the TUI.");
}
