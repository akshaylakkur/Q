/**
 * Session export / import / replay — Zip with manifest, progress indicator,
 * memory inclusion, blob integrity checks, and full agent state replay.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  createWriteStream,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { open as yauzlOpen } from "yauzl";
import type { Entry } from "yauzl";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import chalk from "chalk";

import { getSessionsBase, SessionStore } from "./session-store.js";
import type { SessionMeta, SessionRecord } from "./types.js";
import { CURRENT_WIRE_VERSION } from "./types.js";
import { iterateRecords } from "./wire.js";

// ---------------------------------------------------------------------------
// ByteCounter — Transform stream that counts bytes written
// ---------------------------------------------------------------------------

/**
 * A simple Transform stream that counts every byte passing through it.
 * Exposes `bytesWritten` for progress reporting.
 */
class ByteCounter extends Transform {
  private _bytesWritten = 0;

  constructor() {
    super({ objectMode: false });
  }

  get bytesWritten(): number {
    return this._bytesWritten;
  }

  _transform(
    chunk: Buffer | string,
    _encoding: string,
    callback: (err?: Error | null, data?: Buffer) => void,
  ): void {
    if (typeof chunk === "string") {
      this._bytesWritten += Buffer.byteLength(chunk);
    } else {
      this._bytesWritten += chunk.length;
    }
    this.push(chunk);
    callback();
  }
}

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

export interface ExportManifest {
  version: number;
  wireVersion: number;
  exportedAt: string;
  sessionId: string;
  recordCount: number;
  blobCount: number;
  modelName?: string;
  agentProfile?: string;
  executionMode?: string;
  cwd?: string;
  memoryIndexVersion?: number;
  toolVersions?: Record<string, string>;
  session?: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    workspaceDirectory?: string;
    model?: string;
    protocolVersion: number;
  };
  files: string[];
  blobs: Array<{ sha256: string; mime: string }>;
}

export interface ExportOptions {
  includeMemory?: boolean;
  outputPath?: string;
}

// ---------------------------------------------------------------------------
// Archiver — Dynamic ESM import for archiver v8
// ---------------------------------------------------------------------------

async function createZipArchive(options: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import("archiver");
  const ZipArchive = mod.ZipArchive;
  return new ZipArchive(options);
}

// ---------------------------------------------------------------------------
// Progress display helpers
// ---------------------------------------------------------------------------

const PROGRESS_INTERVAL_MS = 500;

/** Format bytes as human-readable size string (e.g., "12.4 MB"). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Show an in-place progress line using CURSOR.save / CURSOR.restore. */
function showProgressLine(current: number, total: number): void {
  const c = formatSize(current);
  const t = formatSize(total);
  // \x1b[s = save cursor, \x1b[u = restore cursor, \x1b[2K = erase line
  process.stderr.write(`\x1b[s\x1b[2KExporting: ${c} / ${t}\x1b[u`);
}

/** Show final success line. */
function showExportSuccess(outputPath: string): void {
  process.stderr.write(`\x1b[2K${chalk.green("✓ Exported to")} ${outputPath}\n`);
}

/** Show import success line. */
function showImportSuccess(sessionId: string): void {
  console.log(chalk.green(`✓ Imported as session ${sessionId}`));
}

// ---------------------------------------------------------------------------
// SessionRecord → AgentRecord conversion for replay
// ---------------------------------------------------------------------------

/**
 * Convert a q-cli SessionRecord to an agent-core AgentRecord for replay.
 * This bridges the two wire format representations so that the agent's
 * restoreAgentRecord() dispatch can reconstruct full session state.
 */
function sessionRecordToAgentRecord(
  sr: SessionRecord,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const base = { time: Date.parse(sr.timestamp) || Date.now() };

  switch (sr.type) {
    case "metadata":
      return { ...base, type: "metadata", protocol_version: String(sr.protocolVersion ?? 1), created_at: Date.parse(sr.createdAt) || Date.now() };

    case "turn.prompt":
      return {
        ...base,
        type: "turn.prompt",
        input: [sr.prompt],
        origin: { kind: "user" },
      };

    case "turn.steer":
      return { ...base, type: "turn.steer", input: [sr.steer], origin: { kind: "user" } };

    case "turn.cancel":
      return { ...base, type: "turn.cancel" };

    case "config.update":
      return { ...base, type: "config.update", [sr.key]: sr.value };

    case "permission.set_mode":
      return { ...base, type: "permission.set_mode", mode: sr.mode };

    case "permission.record_approval_result":
      return { ...base, type: "permission.record_approval_result" };

    case "plan_mode.enter":
      return { ...base, type: "plan_mode.enter", id: randomUUID() };

    case "plan_mode.cancel":
      return { ...base, type: "plan_mode.cancel" };

    case "plan_mode.exit":
      return { ...base, type: "plan_mode.exit", id: randomUUID() };

    case "context.append_message":
      return {
        ...base,
        type: "context.append_message",
        message: {
          role: sr.role ?? "user",
          content: sr.content ?? "",
        },
      };

    case "context.mark_last_user_prompt_blocked":
      return { ...base, type: "context.append_message", message: { role: "user", content: "(blocked: " + (sr.reason ?? "unknown") + ")" } };

    case "context.append_loop_event":
      return {
        ...base,
        type: "context.append_loop_event",
        event: { type: "tool.result", result: { output: sr.data ?? "", isError: false }, toolCallId: "replay" },
      };

    case "context.clear":
      return { ...base, type: "context.clear" };

    case "context.apply_compaction":
      return {
        ...base,
        type: "context.apply_compaction",
        summary: "",
        compactedCount: sr.prunedMessageCount ?? 1,
        tokensAfter: 0,
      };

    case "tools.register_user_tool":
      return {
        ...base,
        type: "tools.register_user_tool",
        name: sr.toolName,
        description: "",
        parameters: (sr.toolSpec as Record<string, unknown>) ?? {},
      };

    case "tools.unregister_user_tool":
      return { ...base, type: "tools.unregister_user_tool", name: sr.toolName };

    case "tools.set_active_tools":
      return { ...base, type: "tools.set_active_tools", names: sr.toolNames ?? [] };

    case "tools.update_store":
      return { ...base, type: "tools.update_store", key: sr.key ?? "", value: sr.value };

    case "background.stop":
      return { ...base, type: "background.stop", taskId: sr.backgroundTaskId ?? "" };

    case "usage.record": {
      // SessionRecord stores individual token type counts; AgentRecord expects
      // a TokenUsage object. We bundle into a single TokenUsage per model/provider.
      return {
        ...base,
        type: "usage.record",
        model: sr.model ?? "unknown",
        usage: {
          promptTokens: sr.tokenType === "prompt" ? sr.count : 0,
          completionTokens: sr.tokenType === "completion" ? sr.count : 0,
        },
      };
    }

    case "correction.attempt":
      return { ...base, type: "metadata" }; // skip — no corresponding AgentRecord type

    default:
      // For full_compaction.* and any unknown types, skip as metadata
      return { ...base, type: "metadata" };
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export a session to a zip archive at the given output path.
 *
 * Steps:
 * 1. Read session metadata from SessionStore
 * 2. Collect blob info and count records
 * 3. Snapshot tool versions for reproducibility
 * 4. Build manifest.json with all metadata fields
 * 5. Create zip: wire.jsonl + blobs/ + manifest.json + optional memory/
 * 6. Show a progress indicator during large exports (> 1 MB)
 * 7. Write zip to outputPath using Node.js streams
 */
export async function exportSession(
  sessionId: string,
  outputPath: string,
  options?: ExportOptions,
): Promise<void> {
  const sessionDir = resolve(getSessionsBase(), sessionId);
  if (!existsSync(sessionDir)) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const store = new SessionStore();
  const meta = store.get(sessionId);
  if (!meta) {
    throw new Error(`Session metadata not found: ${sessionId}`);
  }

  const wirePath = join(sessionDir, "wire.jsonl");
  const blobsDir = join(sessionDir, "blobs");

  // Collect blob info
  const blobEntries: ExportManifest["blobs"] = [];
  if (existsSync(blobsDir)) {
    const files = readdirSync(blobsDir);
    for (const file of files) {
      blobEntries.push({ sha256: file, mime: "application/octet-stream" });
    }
  }

  // Read wire content for record count and size estimation
  let wireContent: string | undefined;
  let recordCount = 0;
  if (existsSync(wirePath)) {
    wireContent = readFileSync(wirePath, "utf-8");
    recordCount = wireContent.split("\n").filter((l) => l.trim().length > 0).length;
  }

  // Snapshot tool versions for reproducibility
  const toolVersions: Record<string, string> = {};
  try {
    const { execSync } = await import("node:child_process");
    for (const tool of ["node", "npm", "git"]) {
      try {
        const out = execSync(`${tool} --version`, { encoding: "utf-8", timeout: 3000 });
        toolVersions[tool] = out.toString().trim();
      } catch {
        // tool not available
      }
    }
  } catch {
    // execSync not available
  }

  // Determine agentProfile and executionMode from session metadata
  // (stored in the wire file's first record)
  let agentProfile = "auto";
  let executionMode = "auto";
  let modelName = meta.model ?? "";
  if (wireContent) {
    const firstLine = wireContent.split("\n")[0];
    if (firstLine) {
      try {
        const firstRec = JSON.parse(firstLine);
        if (firstRec.type === "metadata") {
          if (firstRec.model) modelName = firstRec.model;
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Optionally read memory index version from LTPM
  let memoryIndexVersion: number | undefined;
  if (options?.includeMemory) {
    try {
      const memoryIndexPath = resolve(
        process.env.HOME ?? "/tmp",
        ".Q",
        "memory",
        "episodes",
        "recall-index.json",
      );
      if (existsSync(memoryIndexPath)) {
        const idx = JSON.parse(readFileSync(memoryIndexPath, "utf-8"));
        memoryIndexVersion = idx.version ?? undefined;
      }
    } catch {
      // LTPM index not available
    }
  }

  // Build manifest
  const manifest: ExportManifest = {
    version: 1,
    wireVersion: CURRENT_WIRE_VERSION,
    exportedAt: new Date().toISOString(),
    sessionId,
    recordCount,
    blobCount: blobEntries.length,
    modelName: modelName || undefined,
    agentProfile,
    executionMode,
    cwd: meta.workspaceDirectory,
    memoryIndexVersion,
    toolVersions: Object.keys(toolVersions).length > 0 ? toolVersions : undefined,
    session: {
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      workspaceDirectory: meta.workspaceDirectory,
      model: meta.model,
      protocolVersion: meta.protocolVersion,
    },
    files: ["wire.jsonl", "manifest.json"],
    blobs: blobEntries,
  };

  // Estimate total size for progress indicator
  let estimatedTotal = 0;
  if (wireContent) estimatedTotal += Buffer.byteLength(wireContent, "utf-8");
  if (existsSync(blobsDir)) {
    try {
      const files = readdirSync(blobsDir);
      for (const f of files) {
        const st = statSync(join(blobsDir, f));
        estimatedTotal += st.size;
      }
    } catch {
      // ignore
    }
  }
  // Add ~10 KB for manifest and zip overhead
  estimatedTotal += 10_240;
  const showProgress = estimatedTotal > 1024 * 1024;

  // Create zip archive with highest compression
  const archive = await createZipArchive({ zlib: { level: 9 } });
  const output = createWriteStream(outputPath);

  // Add the byte counter into the pipe chain
  const byteCounter = new ByteCounter();
  const archivePromise = pipeline(archive, byteCounter, output);

  // Add files to archive
  if (existsSync(wirePath)) {
    archive.file(wirePath, { name: "wire.jsonl" });
  }
  if (existsSync(blobsDir)) {
    archive.directory(blobsDir, "blobs");
  }
  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

  // Optionally include LTPM memory files for this session
  if (options?.includeMemory) {
    // Episodes: $HOME/.Q/memory/episodes/<sessionId>-*.json
    const episodesDir = resolve(process.env.HOME ?? "/tmp", ".Q", "memory", "episodes");
    if (existsSync(episodesDir)) {
      const episodeFiles = readdirSync(episodesDir).filter(
        (f) => f.startsWith(`${sessionId}-`) && f.endsWith(".json"),
      );
      for (const ef of episodeFiles) {
        archive.file(join(episodesDir, ef), { name: `memory/episodes/${ef}` });
      }
      // Also include the recall index
      const recallIndex = join(episodesDir, "recall-index.json");
      if (existsSync(recallIndex)) {
        archive.file(recallIndex, { name: "memory/episodes/recall-index.json" });
      }
    }

    // Decisions: $HOME/.Q/memory/decisions/<uuid>.json (filtered by sessionId)
    const decisionsDir = resolve(process.env.HOME ?? "/tmp", ".Q", "memory", "decisions");
    if (existsSync(decisionsDir)) {
      const decisionFiles = readdirSync(decisionsDir).filter((f) => f.endsWith(".json"));
      for (const df of decisionFiles) {
        try {
          const content = readFileSync(join(decisionsDir, df), "utf-8");
          const parsed = JSON.parse(content);
          if (parsed.sessionId === sessionId) {
            archive.file(join(decisionsDir, df), { name: `memory/decisions/${df}` });
          }
        } catch {
          // skip unreadable decision files
        }
      }
    }
  }

  // Progress indicator: update every 500ms during large exports
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  if (showProgress) {
    progressTimer = setInterval(() => {
      showProgressLine(byteCounter.bytesWritten, estimatedTotal);
    }, PROGRESS_INTERVAL_MS);
  }

  // Finalize the archive
  archive.finalize();
  await archivePromise;

  // Clean up progress timer and show final message
  if (progressTimer) {
    clearInterval(progressTimer);
  }
  showExportSuccess(outputPath);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Import a session from a zip archive.
 *
 * Steps:
 * 1. Read and validate the zip — read manifest.json first
 * 2. Verify wireVersion <= CURRENT_WIRE_VERSION (reject with clear error if newer)
 * 3. Run migration if wireVersion < CURRENT_WIRE_VERSION
 * 4. Verify blob integrity by computing SHA-256 hashes
 * 5. Extract to $HOME/.Q/sessions/<importedSessionId>/ (new UUID if conflict)
 * 6. Register the session in the session index
 * 7. Return the session metadata
 */
export async function importSession(archivePath: string): Promise<SessionMeta> {
  if (!existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }

  // Read zip entries into memory
  const entries: Map<string, Buffer> = new Map();

  await new Promise<void>((resolvePromise, reject) => {
    yauzlOpen(archivePath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("Failed to open zip"));
        return;
      }

      zipfile.readEntry();
      zipfile.on("entry", (entry: Entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        const chunks: Buffer[] = [];
        zipfile.openReadStream(entry, (err2, readStream) => {
          if (err2 || !readStream) {
            reject(err2 ?? new Error("Failed to open read stream"));
            return;
          }

          readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
          readStream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          readStream.on("error", reject);
        });
      });

      zipfile.on("end", () => resolvePromise());
      zipfile.on("error", reject);
    });
  });

  // Validate manifest
  const manifestRaw = entries.get("manifest.json");
  if (!manifestRaw) {
    throw new Error("Archive is missing manifest.json");
  }
  const manifest = JSON.parse(manifestRaw.toString("utf-8")) as ExportManifest;

  if (manifest.version !== 1) {
    throw new Error(`Unsupported manifest version: ${manifest.version}`);
  }

  // Wire version validation: reject if newer than current version
  const wireVersion = manifest.wireVersion ?? manifest.version;
  if (wireVersion > CURRENT_WIRE_VERSION) {
    throw new Error(
      `Export was created by a newer version of Qode (wire v${wireVersion}). ` +
      `Current wire format: v${CURRENT_WIRE_VERSION}. Please update Qode and try again.`,
    );
  }

  // Validate wire.jsonl exists
  const wireRaw = entries.get("wire.jsonl");
  if (!wireRaw) {
    throw new Error("Archive is missing wire.jsonl");
  }

  // Verify blob integrity: compute SHA-256 of each blob and compare
  const blobErrors: string[] = [];
  for (const blob of manifest.blobs) {
    const blobData = entries.get(`blobs/${blob.sha256}`);
    if (!blobData) continue;

    const computedHash = createHash("sha256").update(blobData).digest("hex");
    if (computedHash !== blob.sha256) {
      blobErrors.push(`Blob ${blob.sha256}: SHA256 mismatch (computed ${computedHash})`);
    }
  }
  if (blobErrors.length > 0) {
    throw new Error(`Blob integrity check failed:\n${blobErrors.join("\n")}`);
  }

  // Check for session ID conflicts; generate a new UUID if needed
  let sessionId = manifest.sessionId ?? randomUUID();
  let sessionDir = resolve(getSessionsBase(), sessionId);
  if (existsSync(sessionDir)) {
    const originalId = sessionId;
    sessionId = randomUUID();
    sessionDir = resolve(getSessionsBase(), sessionId);
    console.warn(`Session ${originalId} already exists. Importing as ${sessionId}.`);
  }

  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "wire.jsonl"), wireRaw);

  // Run schema migration if the wire version is older than current
  const { migrateWireFile } = await import("./migration.js");
  const migrationResult = await migrateWireFile(join(sessionDir, "wire.jsonl"), wireVersion);
  if (migrationResult.didMigrate) {
    console.warn(`Wire format migrated: v${wireVersion} → v${migrationResult.targetVersion}`);
  }

  // Extract blob files
  const blobsDir = join(sessionDir, "blobs");
  for (const blob of manifest.blobs) {
    const blobData = entries.get(`blobs/${blob.sha256}`);
    if (!blobData) continue;
    if (!existsSync(blobsDir)) {
      mkdirSync(blobsDir, { recursive: true });
    }
    writeFileSync(join(blobsDir, blob.sha256), blobData);
  }

  const now = new Date().toISOString();
  const sessionMeta: SessionMeta = {
    id: sessionId,
    name: manifest.session?.name ?? `Imported: ${manifest.sessionId ?? sessionId}`,
    createdAt: manifest.session?.createdAt ?? manifest.exportedAt ?? now,
    updatedAt: now,
    workspaceDirectory: manifest.cwd,
    model: manifest.modelName,
    protocolVersion: CURRENT_WIRE_VERSION,
    recordCount: wireRaw.toString().split("\n").filter((l) => l.trim().length > 0).length,
    blobCount: manifest.blobs.length,
    sizeBytes: wireRaw.byteLength + manifest.blobs.reduce((acc, b) => {
      const d = entries.get(`blobs/${b.sha256}`);
      return acc + (d?.byteLength ?? 0);
    }, 0),
  };

  const store = new SessionStore();
  await store.register(sessionId, sessionMeta);

  showImportSuccess(sessionId);
  return sessionMeta;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Replay a session into an agent — reads the wire file line by line,
 * dispatches each record to the agent via agent.replayRecord(), and
 * reconstructs the full session state for continuation.
 *
 * After replay, the agent's context memory contains the full conversation
 * history and the caller can continue from where the session left off.
 *
 * @param sessionId - The session to replay
 * @param agent - An Agent instance with replayRecord()
 * @param manifest - Optional manifest metadata for display
 * @returns The session ID that was replayed
 */
export async function replaySession(
  sessionId: string,
  agent: { replayRecord(record: unknown): void },
  manifest?: ExportManifest,
): Promise<string> {
  const sessionDir = resolve(getSessionsBase(), sessionId);

  if (!existsSync(sessionDir)) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const wirePath = join(sessionDir, "wire.jsonl");
  if (!existsSync(wirePath)) {
    throw new Error(`Wire file not found for session: ${sessionId}`);
  }

  // Stream through wire.jsonl and dispatch each record
  for await (const record of iterateRecords(wirePath)) {
    const agentRecord = sessionRecordToAgentRecord(record);
    if (agentRecord.type !== "metadata") {
      agent.replayRecord(agentRecord);
    }
  }

  // Model mismatch warning
  if (manifest?.modelName) {
    try {
      // Attempt to detect the current model from config or env
      const currentModel = process.env.Q_MODEL ?? undefined;
      if (currentModel && manifest.modelName !== currentModel) {
        console.warn(
          chalk.yellow(
            `◈ Warning: session was recorded with ${manifest.modelName} but current model is ${currentModel}. Answers may differ.`,
          ),
        );
      }
    } catch {
      // Color detection is best-effort
    }
  }

  return sessionId;
}

/**
 * Build a startup notice string for an imported/replayed session
 * that will be shown in the TUI transcript on startup.
 */
export function buildReplayNotice(
  sessionId: string,
  manifest?: ExportManifest,
): string {
  const exportDate = manifest?.exportedAt
    ? new Date(manifest.exportedAt).toLocaleDateString()
    : "unknown date";
  return `Replaying imported session ${sessionId.slice(0, 8)}… (exported ${exportDate})`;
}