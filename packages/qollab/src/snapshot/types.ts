/**
 * Snapshot-specific types for the Qollab snapshot system.
 */

import type { SnapshotFileEntry, SnapshotManifest, MergeReport } from "../types.js";

// ── Snapshot creation options ─────────────────────────────────

export interface SnapshotCreateOptions {
  sessionId: string;
  createdBy: string;
  parentSnapshotId?: string;
  commitMessage?: string;
  files: SnapshotFileEntry[];
}

// ── Snapshot diff result ──────────────────────────────────────

export interface SnapshotDiffResult {
  added: string[];
  modified: Array<{ path: string; oldSha: string; newSha: string }>;
  deleted: string[];
  totalChanges: number;
}

// ── File entry with content hash ──────────────────────────────

export interface HashedFileEntry {
  path: string;
  content: Buffer | string;
  sha256: string;
  size: number;
}

// ── Snapshot scan options ─────────────────────────────────────

export interface SnapshotScanOptions {
  ignorePatterns: string[];
  maxFileSizeBytes: number;
  maxTotalFiles: number;
}

// ── Merge workspace state ─────────────────────────────────────

export interface MergeWorkspace {
  workspaceDir: string;
  originalSnapshot: { snapshotId: string; fileEntries: SnapshotFileEntry[] };
  agentPid?: number;
  startedAt: string;
  report?: MergeReport;
}
