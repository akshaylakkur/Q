/**
 * Collaboration — Qollab collaborative session manager.
 *
 * Provides the glue between the Qollab packages and the Qode runtime.
 * Manages session lifecycle, configuration, and integration points
 * for the TUI and agent subsystems.
 */

import type { QollabSession, QollabAttendee, QollabSessionMetadata, QollabPermissions, QollabConfig, QollabServerEvent, QollabClientEvent, MergeReport } from "@qode-agent/qollab";
import {
  QollabSessionServer,
  QollabSessionClient,
  QollabAdmission,
  QollabSnapshotStore,
  QollabSnapshotDiffer,
  QollabAgenticMerge,
  SnapshotFileConnector,
  generateSessionKey,
  hashSessionKey,
  assignColor,
  DEFAULT_COLOR_PALETTE,
} from "@qode-agent/qollab";

// ─── Default config ─────────────────────────────────────────────────────────

export const DEFAULT_COLLAB_CONFIG: QollabConfig = {
  enabled: false,
  serverUrl: "wss://collab.qode.sh",
  defaultCollabType: "pair",
  maxAttendees: 8,
  snapshotSyncRateLimit: 1,
  encryption: "AES-256-GCM",
  chat: {
    historyLimit: 10000,
    colorPalette: ["#22D3EE", "#A78BFA", "#FBBF24", "#4ADE80", "#FB7185", "#38BDF8"],
  },
};

// ─── CollaborationManager ──────────────────────────────────────────────────

export class CollaborationManager {
  private config: QollabConfig;
  private server: QollabSessionServer | null = null;
  private client: QollabSessionClient | null = null;
  private activeSession: QollabSession | null = null;
  private admission: QollabAdmission | null = null;
  private snapshotStore: QollabSnapshotStore | null = null;
  private snapshotDiffer: QollabSnapshotDiffer | null = null;
  private mergeEngine: QollabAgenticMerge | null = null;
  private currentUserId: string | null = null;

  constructor(config?: Partial<QollabConfig>) {
    this.config = { ...DEFAULT_COLLAB_CONFIG, ...config };
  }

  // ─── Configuration ────────────────────────────────────────────────────

  getConfig(): QollabConfig {
    return this.config;
  }

  updateConfig(updates: Partial<QollabConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  // ─── Session Lifecycle ───────────────────────────────────────────────

  hasActiveSession(): boolean {
    return this.activeSession !== null;
  }

  getActiveSession(): QollabSession | null {
    return this.activeSession;
  }

  setActiveSession(session: QollabSession): void {
    this.activeSession = session;
  }

  clearActiveSession(): void {
    this.activeSession = null;
    this.client?.disconnect();
    this.client = null;
    this.admission = null;
    this.currentUserId = null;
  }

  setCurrentUserId(userId: string): void {
    this.currentUserId = userId;
  }

  getCurrentUserId(): string | null {
    return this.currentUserId;
  }

  // ─── Session Key ─────────────────────────────────────────────────────

  generateSessionKey(): string {
    return generateSessionKey();
  }

  hashSessionKey(key: string): string {
    return hashSessionKey(key);
  }

  assignColor(userId: string): string {
    return assignColor(userId, this.config.chat.colorPalette);
  }

  getSnapshotDiffer(): QollabSnapshotDiffer | null {
    return this.snapshotDiffer;
  }

  getMergeEngine(): QollabAgenticMerge | null {
    return this.mergeEngine;
  }

  // ─── Server ──────────────────────────────────────────────────────────

  startServer(port?: number): QollabSessionServer {
    this.server = new QollabSessionServer({
      port: port ?? 19876,
      host: "127.0.0.1",
      dataDir: this.getDataDir(),
    });
    this.admission = new QollabAdmission(this.config.chat.colorPalette);
    this.snapshotStore = new QollabSnapshotStore(this.getDataDir());
    this.snapshotDiffer = new QollabSnapshotDiffer();
    this.mergeEngine = new QollabAgenticMerge();
    return this.server;
  }

  getServer(): QollabSessionServer | null {
    return this.server;
  }

  async stopServer(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
  }

  getAdmission(): QollabAdmission | null {
    return this.admission;
  }

  getSnapshotStore(): QollabSnapshotStore | null {
    return this.snapshotStore;
  }

  // ─── Client ──────────────────────────────────────────────────────────

  createClient(options: {
    serverUrl: string;
    sessionKey: string;
    displayName: string;
    onEvent: (event: any) => void;
    onDisconnect?: () => void;
    onError?: (err: Error) => void;
  }): QollabSessionClient {
    this.client = new QollabSessionClient(options);
    return this.client;
  }

  getClient(): QollabSessionClient | null {
    return this.client;
  }

  // ─── Snapshot Management ────────────────────────────────────────────

  async createSnapshot(
    projectDir: string,
    sessionId: string,
    createdBy: string,
    commitMessage?: string,
  ) {
    if (!this.snapshotStore) {
      throw new Error("Snapshot store not initialized. Start the session server first.");
    }
    return this.snapshotStore.createFromDirectory(projectDir, {
      sessionId,
      createdBy,
      commitMessage,
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private getDataDir(): string {
    return `${process.env.HOME ?? "/tmp"}/.Q/collab/data`;
  }
}

// Re-exports
export type {
  QollabSession,
  QollabAttendee,
  QollabSessionMetadata,
  QollabPermissions,
  QollabConfig as QollabConfig,
  QollabServerEvent,
  QollabClientEvent,
  MergeReport,
};
export { SnapshotFileConnector, QollabSessionServer, QollabSessionClient, QollabSnapshotDiffer, QollabAgenticMerge } from "@qode-agent/qollab";
