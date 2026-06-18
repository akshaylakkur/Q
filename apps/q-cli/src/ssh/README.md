# QSSH — Remote Cloud Execution System

QSSH (Q over SSH) is a system for running heavy AI agent workloads on a remote
server (EC2, bare metal, or any Linux machine) while maintaining a local TUI
experience. It streams events from the remote daemon back to the local client
in real time, supports bi-directional file sync, and handles credential
security, session resume, and crash recovery.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Protocol: NDJSON Envelopes](#protocol-ndjson-envelopes)
3. [Control Channel: File-Based Commands](#control-channel-file-based-commands)
4. [Initialization Flow](#initialization-flow)
5. [Credential Security](#credential-security)
6. [Project Snapshot & Upload](#project-snapshot--upload)
7. [Bi-Directional Sync](#bi-directional-sync)
8. [Event Streaming & Heartbeat](#event-streaming--heartbeat)
9. [Session Resume](#session-resume)
10. [CLI Commands Reference](#cli-commands-reference)
11. [Build & Pack](#build--pack)
12. [Testing](#testing)

---

## Architecture Overview

```
+-------------------+          SSH          +-------------------+
|   Local Client    |  <================>  |   Remote Server   |
|   (q-cli)         |                       |   (q-remote)      |
|                   |   scp uploads         |                   |
|  +-------------+  |   tar|ssh pipes       |  +--------------+ |
|  | SshTransport|  |                       |  | RemoteDaemon | |
|  | (ssh/scp)   |  |   NDJSON events       |  | (nohup)      | |
|  +------+------+  |   (tail -f stdout)    |  +------+-------+ |
|         |         |                       |         |         |
|  +------v------+  |   control.jsonl       |  +------v-------+ |
|  | RemoteSess. |  |   (file append)       |  | EventBridge  | |
|  +------+------+  |                       |  +------+-------+ |
|         |         |                       |         |         |
|  +------v------+  |                       |  +------v-------+ |
|  | TUI (Ink)   |  |                       |  | LogStore     | |
|  +-------------+  |                       |  | (events.log) | |
|                   |                       |  +--------------+ |
+-------------------+                       +-------------------+
```

### Components

| Component | Location | Role |
|-----------|----------|------|
| **SshTransport** | `apps/q-cli/src/ssh/transport.ts` | Wraps `ssh`/`scp`/`tar|ssh` with typed results, timeouts, and line-by-line streaming |
| **RemoteSession** | `apps/q-cli/src/ssh/remote-session.ts` | Manages the live connection: event streaming, control commands, status queries |
| **HeartbeatMonitor** | `apps/q-cli/src/ssh/heartbeat.ts` | Pings the remote daemon at intervals, detects disconnection with exponential backoff |
| **EventAdapter** | `apps/q-cli/src/ssh/event-adapter.ts` | Converts NDJSON envelopes into TUI-friendly events |
| **Sync** | `apps/q-cli/src/ssh/sync.ts` | Manifest-based bi-directional differential sync with 3-way merge |
| **Credentials** | `apps/q-cli/src/ssh/credentials.ts` | Collects, encrypts, and uploads provider credentials |
| **Install** | `apps/q-cli/src/ssh/install.ts` | Checks remote Node version, uploads and installs q-remote tarball |
| **Upload** | `apps/q-cli/src/ssh/upload.ts` | Creates and uploads the initial project snapshot |
| **Pack** | `apps/q-cli/src/ssh/pack.ts` | Builds and packs the q-remote tarball for upload |
| **RemoteDaemon** | `packages/q-remote/src/daemon.ts` | Headless daemon running on the remote under nohup |
| **EventBridge** | `packages/q-remote/src/event-bridge.ts` | Converts agent/orchestrator events to NDJSON, writes to stdout + events.log |
| **LogStore** | `packages/q-remote/src/log-store.ts` | Append-only NDJSON event log for crash recovery and resume |
| **SessionManager** | `packages/q-remote/src/session-manager.ts` | Tracks per-session state on the remote |
| **SyncServer** | `packages/q-remote/src/sync-server.ts` | Computes file manifests and applies patches on the remote |
| **AgentFactory** | `packages/q-remote/src/agent-factory.ts` | Creates a headless Agent wired to the EventBridge |
| **Protocol** | `packages/protocol/src/envelope.ts` | Canonical wire types shared between local and remote |

---

## Protocol: NDJSON Envelopes

All events from the remote daemon to the local client are transmitted as
**Newline-Delimited JSON (NDJSON)** — one JSON object per line, terminated
by `\n`. Each line is an `NdjsonEnvelope`:

```typescript
interface NdjsonEnvelope {
  seq: number;          // Monotonically increasing, 1-based
  ts: string;           // ISO-8601 timestamp
  kind: EnvelopeKind;   // "agent" | "orchestrator" | "system" | "sync" | "audit"
  type: string;         // Event type within the channel
  [key: string]: unknown; // Arbitrary payload fields
}
```

### Event Kinds

| Kind | Description | Example Types |
|------|-------------|---------------|
| `agent` | Agent RPC events (tool calls, responses) | `tool.call`, `tool.result`, `thinking`, `message` |
| `orchestrator` | Orchestrator lifecycle events | `prompt.complete`, `prompt.error`, `plan.step` |
| `system` | Daemon lifecycle and metadata | `remote.metadata`, `heartbeat`, `shutdown`, `ready`, `warning`, `cancelled`, `mode.changed`, `prompt.received` |
| `audit` | File system audit trail | `file.create`, `file.modify`, `file.delete`, `file.rename` |
| `sync` | Sync progress updates | `sync.progress` |

### System Event Types

**MetadataEvent** — emitted once on daemon start:
```json
{
  "seq": 1,
  "ts": "2025-01-15T10:30:00.000Z",
  "kind": "system",
  "type": "remote.metadata",
  "host": "ec2-xxx.compute.amazonaws.com",
  "user": "ubuntu",
  "sessionId": "a1b2c3d4e5f6a7b8c9d0e1f2",
  "workspace": "/home/ubuntu/q-workspace/a1b2c3d4e5f6a7b8c9d0e1f2",
  "nodeVersion": "v22.19.0",
  "arch": "x64",
  "platform": "linux",
  "pid": 12345,
  "startedAt": "2025-01-15T10:30:00.000Z",
  "mode": "auto"
}
```

**HeartbeatEvent** — emitted every 5 seconds:
```json
{
  "seq": 42,
  "ts": "2025-01-15T10:30:05.000Z",
  "kind": "system",
  "type": "heartbeat",
  "alive": true,
  "uptimeMs": 5000,
  "pid": 12345
}
```

**ShutdownEvent** — emitted on daemon exit:
```json
{
  "seq": 999,
  "ts": "2025-01-15T11:00:00.000Z",
  "kind": "system",
  "type": "shutdown",
  "reason": "graceful",
  "message": "Shutdown requested by client"
}
```

### Parsing & Serialization

The protocol package provides helpers:

```typescript
import { parseEnvelope, serializeEnvelope, isHeartbeat, isMetadata, isFileAudit, isSyncProgress } from "@qode-agent/protocol";

// Parse a single NDJSON line
const env = parseEnvelope(line);
if (env && isHeartbeat(env)) {
  console.log(`Uptime: ${env.uptimeMs}ms`);
}

// Serialize an envelope to a JSON string
const json = serializeEnvelope(env);
```

---

## Control Channel: File-Based Commands

The remote daemon runs under `nohup` and has no stdin. Instead, the local
client sends commands by appending JSON lines to a **control file** at
`<workspace>/.q-remote/control.jsonl`. The daemon polls this file every
200ms for new lines.

### Control Commands

```typescript
type ControlCmdName = "prompt" | "cancel" | "status" | "heartbeat" | "shutdown" | "sync-diff" | "sync-apply" | "set-mode";

interface ControlCommand {
  cmd: ControlCmdName;
  [key: string]: unknown;
}
```

**Send a prompt:**
```json
{"cmd":"prompt","text":"Refactor the auth module","mode":"auto"}
```

**Cancel the current task:**
```json
{"cmd":"cancel"}
```

**Query daemon status:**
```json
{"cmd":"status"}
```

**Change execution mode:**
```json
{"cmd":"set-mode","mode":"modus_maximus"}
```

**Shutdown the daemon:**
```json
{"cmd":"shutdown"}
```

### How the local client sends a control command

The `RemoteSession.sendControl()` method appends a JSON line to the remote
control file via SSH:

```typescript
// In remote-session.ts
async sendControl(cmd: ControlCommand): Promise<void> {
  const escaped = JSON.stringify(cmd).replace(/'/g, "'\\''");
  const cmd2 = `echo '${escaped}' >> '${this.controlFilePath.replace(/'/g, "'\\''")}'`;
  const result = await this.transport.exec(cmd2);
  if (!result.ok) {
    throw new Error(`Failed to send control command: ${result.stderr}`);
  }
}
```

This produces an SSH command like:

```bash
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new user@host "echo '{\"cmd\":\"prompt\",\"text\":\"Refactor the auth module\",\"mode\":\"auto\"}' >> /home/user/q-workspace/session-id/.q-remote/control.jsonl"
```

### How the daemon polls the control file

The `RemoteDaemon.pollControlFile()` method reads new content from the
control file since the last read offset:

```typescript
private pollControlFile(): void {
  if (!existsSync(this.controlPath)) return;
  const st = statSync(this.controlPath);
  if (st.size <= this.controlReadOffset) return;

  const fd = openSync(this.controlPath, "r");
  const len = st.size - this.controlReadOffset;
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, this.controlReadOffset);
  closeSync(fd);
  this.controlReadOffset = st.size;

  const lines = buf.toString("utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const cmd = JSON.parse(trimmed) as ControlCommand;
      this.handleControl(cmd);
    } catch { /* skip malformed */ }
  }
}
```

---

## Initialization Flow

The full connect flow (`q-cli ssh connect <host>`) proceeds through 8 steps:

### Step 1: Validate SSH Connection

```bash
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    user@host "node --version 2>/dev/null; echo '|'; uname -m 2>/dev/null || echo unknown; echo '|'; uname -s 2>/dev/null || echo unknown"
```

The `SshTransport.testConnection()` method runs this combined command to
gather the remote Node version, architecture, and platform in a single SSH
round-trip.

### Step 2: Build & Upload q-remote

The local client builds the q-remote package and packs it into a tarball:

```bash
# Build the q-remote package
pnpm --filter @qode-agent/q-remote build

# Strip workspace:* deps and pack
cd packages/q-remote
npm pack --pack-destination ../../dist-packs
```

The tarball is uploaded via scp:

```bash
scp -P 22 -i /path/to/key dist-packs/qode-agent-q-remote-0.1.0.tgz user@host:~/q-remote-install/
```

Then installed globally on the remote:

```bash
ssh user@host "sudo npm install -g ~/q-remote-install/qode-agent-q-remote-0.1.0.tgz"
```

The `ensureRemoteReady()` function checks:
1. Node.js is installed and >= v22.19
2. If q-remote is already installed at the matching version, skip
3. Otherwise upload and install

### Step 3: Collect & Encrypt Credentials

The local client collects provider configuration from environment variables
or config files, then encrypts it:

```typescript
const creds = collectLocalCredentials(workDir);
// creds = { provider: "openai", model: "gpt-4", apiKey: "sk-...", baseUrl: "..." }

const passphrase = generatePassphrase();
// passphrase = "a-random-32-byte-base64url-string"

const credsBlob = encryptCredentials(creds, passphrase);
// Binary blob: QCRE1(5) | salt(16) | iv(12) | ciphertext(N) | tag(16)
```

**Local Ollama instances are rejected** — if the provider is `ollama` and the
base URL points to `localhost`, `127.0.0.1`, or `0.0.0.0`, an error is thrown
because the cloud cannot reach them.

### Step 4: Upload Credentials

The encrypted blob is written to a local temp file, uploaded via scp, and
the passphrase is written to a separate remote temp file (which the daemon
reads and deletes on startup):

```bash
# Upload encrypted credentials
scp -P 22 /tmp/q-cred-session-id.enc user@host:/tmp/q-cred-session-id.enc
ssh user@host "chmod 600 /tmp/q-cred-session-id.enc"

# Write passphrase to a remote tmp file (out-of-band)
ssh user@host "echo 'base64encodedpassphrase' | base64 -d > /tmp/q-xxxx.pass && chmod 600 /tmp/q-xxxx.pass"
```

The passphrase is **never written to local disk in plaintext** — it exists
only in memory on the local side and in the remote tmp file (which is deleted
after the daemon reads it).

### Step 5: Create Project Snapshot

The local workspace is packed into a tarball, respecting `.gitignore` and a
built-in always-ignore list:

```bash
# Create a file list respecting ignores
tar czf /tmp/q-snapshot-xxxx.tar.gz -C /path/to/project -T /tmp/q-snapshot-xxxx.list
```

Always-ignored patterns:
```
node_modules/**, .git/**, dist/**, dist-native/**, .q/**, .q-remote/**,
*.log, .env, .env.*, .DS_Store, Thumbs.db, __pycache__/**, *.tsbuildinfo,
coverage/**, .pnpm-store/**, .vitest-results/**, .tmp*
```

### Step 6: Upload Project Snapshot

The snapshot tarball is uploaded via scp and extracted on the remote:

```bash
# Upload
scp -P 22 /tmp/q-snapshot-xxxx.tar.gz user@host:~/q-workspace/session-id/.q-snapshot.tar.gz

# Extract
ssh user@host "cd ~/q-workspace/session-id && tar xzf .q-snapshot.tar.gz && rm -f .q-snapshot.tar.gz"
```

### Step 7: Launch Remote Daemon

The daemon is launched under `nohup` so it survives SSH disconnection:

```bash
nohup q-remote daemon \
  --workspace '/home/user/q-workspace/session-id' \
  --session 'session-id' \
  --creds '/tmp/q-cred-session-id.enc' \
  --passphrase-file '/tmp/q-xxxx.pass' \
  --mode 'auto' \
  --permission 'yolo' \
  > /tmp/q-daemon-session-id.log 2>&1 &
echo $!
```

The daemon then:
1. Creates `<workspace>/.q-remote/` directory
2. Opens the LogStore (events.log)
3. Writes its PID to `daemon.pid`
4. Decrypts credentials (reads passphrase from file, then deletes it)
5. Deletes the encrypted creds file
6. Creates the headless Agent + OrchestratorCore
7. Emits the `remote.metadata` event
8. Starts the heartbeat timer (5s interval)
9. Starts the control file poller (200ms interval)
10. Emits a `ready` system event

The local client polls `q-remote status` until the daemon reports `running:
true`:

```bash
q-remote status --workspace '/home/user/q-workspace/session-id'
# Returns: {"running":true,"pid":12345,"sessionId":"...","lastEventSeq":5,"mode":"auto","state":"idle","uptimeMs":1500}
```

### Step 8: Launch Remote-Streaming TUI

The local client creates a `RemoteSession` wrapper and launches the TUI in
remote mode. The TUI attaches to the remote session and starts streaming
events via `tail -f`:

```bash
tail -n +1 -f '/home/user/q-workspace/session-id/.q-remote/events.log'
```

---

## Credential Security

Credentials are encrypted with **AES-256-GCM** (authenticated encryption)
using a key derived from a per-session passphrase via **scrypt** (memory-hard
KDF).

### Encryption Format

```
MAGIC(5) | salt(16) | iv(12) | ciphertext(N) | tag(16)
```

| Field | Size | Description |
|-------|------|-------------|
| MAGIC | 5 bytes | ASCII `QCRE1` — format identifier |
| salt | 16 bytes | Random scrypt salt |
| iv | 12 bytes | AES-GCM initialization vector |
| ciphertext | N bytes | Encrypted JSON payload |
| tag | 16 bytes | GCM authentication tag |

### Key Derivation

```typescript
const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
```

### Security Properties

- **Per-session passphrase**: A new random 32-byte (base64url) passphrase is
  generated for every session.
- **Out-of-band transmission**: The passphrase is written to a remote tmp file
  via a separate SSH exec, never to local disk.
- **Self-deleting**: The daemon reads the passphrase file on startup and
  immediately deletes it. The encrypted creds file is also deleted after
  decryption.
- **Tamper detection**: GCM authentication tag ensures the ciphertext hasn't
  been modified. Wrong passphrase or tampered data throws an error.
- **Local Ollama rejection**: The `validatePayload()` function rejects
  credentials for local Ollama instances before they ever leave the local
  machine.

### Encryption (local side)

```typescript
import { encryptCredentials, generatePassphrase } from "../ssh/credentials.js";

const passphrase = generatePassphrase();
const blob = encryptCredentials(
  { provider: "openai", model: "gpt-4", apiKey: "sk-..." },
  passphrase,
);
// blob is a Buffer ready for upload
```

### Decryption (remote side)

```typescript
import { decryptCredentials } from "./credentials.js";

const blob = readFileSync("/tmp/q-cred-session-id.enc");
const creds = decryptCredentials(blob, passphrase);
// creds = { provider: "openai", model: "gpt-4", apiKey: "sk-...", baseUrl: "..." }
```

---

## Project Snapshot & Upload

The `upload.ts` module handles creating the initial workspace snapshot and
computing file manifests for differential sync.

### Creating a Snapshot

```typescript
import { createProjectSnapshot } from "../ssh/upload.js";

const tarballPath = await createProjectSnapshot("/path/to/project");
// Returns: "/tmp/q-snapshot-a1b2c3d4.tar.gz"
```

The function:
1. Loads `.gitignore` if present
2. Applies the built-in always-ignore list
3. Walks the directory tree collecting matching files
4. Writes the file list to a temp file
5. Runs `tar czf` with `-T` (files-from) to create the tarball

### Uploading a Snapshot

```typescript
import { uploadProjectSnapshot } from "../ssh/upload.js";

await uploadProjectSnapshot(transport, tarballPath, "~/q-workspace/session-id");
```

This:
1. Resolves `~` to the remote home directory
2. Creates the remote workspace directory
3. Uploads the tarball via scp
4. Extracts it on the remote
5. Deletes the tarball from the remote

### Computing a Local Manifest

```typescript
import { computeLocalManifest } from "../ssh/upload.js";

const manifest = computeLocalManifest("/path/to/project");
// Returns: [{ path: "src/index.ts", size: 1234, mtimeMs: 1705310000000, sha256: "abc..." }, ...]
```

Each entry contains the file's relative path, size, modification time, and
SHA-256 hash. This is used by the sync system to detect changes.

---

## Bi-Directional Sync

The sync system (`sync.ts`) provides Git-like bi-directional file
synchronization between the local workspace and the remote workspace.

### Sync Flow

1. **Compute local manifest** — SHA-256 hash every file in the local workspace
2. **Fetch remote manifest** — Run `q-remote sync-diff` on the remote to get
   its file manifest as NDJSON
3. **Compute sync plan** — Compare manifests to classify files as pull/push/conflict
4. **Apply changes** — Transfer files via tarballs, resolve conflicts per policy

### Computing the Sync Plan

```typescript
import { computeSyncPlan } from "../ssh/sync.js";

const plan = computeSyncPlan(localManifest, remoteManifest);
// plan = {
//   pull: [files that exist on remote but not locally, or differ],
//   push: [files that exist locally but not on remote, or differ],
//   conflicts: [files that differ on both sides]
// }
```

### Conflict Policies

| Policy | Behavior |
|--------|----------|
| `remote-wins` | Remote version overwrites local |
| `local-wins` | Local version overwrites remote |
| `merge` | 3-way merge using the initial snapshot as baseline |
| `prompt` | Ask the user (falls back to remote-wins in headless mode) |

### Push: Uploading Local Changes

Changed local files are packed into a tarball and uploaded:

```bash
# Create patch tarball
tar czf /tmp/q-patch-xxxx.tar.gz -C /path/to/project -T /tmp/q-patch-xxxx.list

# Upload via scp
scp -P 22 /tmp/q-patch-xxxx.tar.gz user@host:~/q-workspace/session-id/.q-remote/incoming-patch.tar.gz

# Apply on remote
ssh user@host "q-remote sync-apply --workspace '~/q-workspace/session-id' --patch '~/q-workspace/session-id/.q-remote/incoming-patch.tar.gz'"
```

The remote `SyncServer.applyPatch()` extracts the tarball into the workspace:

```bash
tar xzf "incoming-patch.tar.gz" -C "/home/user/q-workspace/session-id"
```

### Pull: Downloading Remote Changes

Changed remote files are packed into a tarball and downloaded:

```bash
# Create remote patch tarball
ssh user@host "cd ~/q-workspace/session-id && tar czf .q-remote/outgoing-patch.tar.gz -T .q-remote/outgoing-patch.list"

# Download via scp
scp -P 22 user@host:~/q-workspace/session-id/.q-remote/outgoing-patch.tar.gz /tmp/q-pull-xxxx.tar.gz

# Extract locally
tar xzf /tmp/q-pull-xxxx.tar.gz -C /path/to/project
```

### 3-Way Merge

When the conflict policy is `merge`, the system attempts a 3-way merge using
the initial project snapshot as the common ancestor (baseline):

```typescript
function merge3(baseline: string, local: string, remote: string): string {
  if (local === remote) return local;       // No conflict
  if (local === baseline) return remote;    // Only remote changed
  if (remote === baseline) return local;    // Only local changed
  return remote; // Conservative: prefer remote (agent's work is primary)
}
```

The baseline is stored locally at `~/.Q/ssh-sessions/<session-id>/baseline/`.

### Sync Report

After a sync, a report is returned:

```typescript
interface SyncReport {
  direction: SyncDirection;     // "pull" | "push" | "both"
  policy: ConflictPolicy;       // "remote-wins" | "local-wins" | "prompt" | "merge"
  pulled: number;               // Files downloaded
  pushed: number;               // Files uploaded
  conflicts: number;            // Files with conflicts
  conflictsResolved: number;    // Conflicts resolved automatically
  errors: string[];             // Any errors encountered
  dryRun: boolean;              // True if no changes were applied
}
```

---

## Event Streaming & Heartbeat

### Live Event Streaming

The local client streams events from the remote daemon by running `tail -f`
on the remote events.log via SSH:

```bash
tail -n +1 -f '/home/user/q-workspace/session-id/.q-remote/events.log'
```

The `RemoteSession.streamEvents()` method uses `SshTransport.execStream()`
which spawns an SSH process and calls a callback for each line of stdout:

```typescript
await remoteSession.streamEvents((env) => {
  // env is a parsed NdjsonEnvelope
  if (env.kind === "agent") {
    tui.handleAgentEvent(adaptRemoteEvent(env));
  }
});
```

### Event Adapter

The `EventAdapter` converts NDJSON envelopes into TUI-friendly events:

```typescript
import { adaptRemoteEvent } from "../ssh/event-adapter.js";

adaptRemoteEvent(env, {
  onAgentEvent: (event) => tui.handleAgentEvent(event),
  onMetadata: (info) => tui.showSessionBanner(info),
  onHeartbeat: (event) => heartbeatMonitor.noteSuccess(),
  onFileAudit: (event) => tui.logFileChange(event),
  onShutdown: () => tui.showDisconnected(),
});
```

### Heartbeat Monitor

The `HeartbeatMonitor` pings the remote daemon every 5 seconds and tracks
connection health:

```typescript
const monitor = new HeartbeatMonitor({
  transport,
  remoteWorkspace: "~/q-workspace/session-id",
  intervalMs: 5000,
  maxRetries: 10,
  baseBackoffMs: 1000,
  maxBackoffMs: 30000,
  onHealthChange: (state) => {
    // "live" | "degraded" | "lost"
    tui.updateConnectionStatus(state);
  },
  onRetry: (attempt, delayMs, reason) => {
    tui.logRetry(attempt, delayMs, reason);
  },
});

monitor.start();
```

Health states:
- **live** — Last ping succeeded
- **degraded** — Some pings failed, retrying with exponential backoff
- **lost** — Max retries exhausted, connection considered dead

The monitor also exposes `noteSuccess()` which is called when a heartbeat
event arrives from the stream (not just the ping), providing a more accurate
liveness signal.

### LogStore (Remote)

The remote `LogStore` persists every event to `<workspace>/.q-remote/events.log`
as NDJSON. This provides:

- **Crash recovery**: Events survive daemon restarts
- **Resume replay**: The local client can request events from a given seq
- **Audit trail**: Full history of all agent actions

```typescript
const logStore = new LogStore("/home/user/q-workspace/session-id/.q-remote/events.log");
logStore.open();  // Scans existing file to initialize highSeq
logStore.append(env);  // Writes one NDJSON line
const events = logStore.read(fromSeq);  // Reads all events with seq >= fromSeq
logStore.close();
```

---

## Session Resume

The `q-cli ssh resume` command reconnects to a running remote daemon and
launches the full TUI, just like `ssh connect` but without re-uploading
everything.

### Flow

1. **Load saved session info** from `~/.Q/ssh-sessions/<session-id>/info.json`
2. **Test SSH connection** to the remote host
3. **Query remote daemon status** via `q-remote status`
4. **If running**: Launch the TUI with the remote session attached
5. **If not running**: Offer to stream the static event log (historical replay)

### Session Info File

When a session is created, the local client saves session metadata:

```json
{
  "host": "ec2-xxx.compute.amazonaws.com",
  "user": "ubuntu",
  "port": 22,
  "sessionId": "a1b2c3d4e5f6a7b8c9d0e1f2",
  "workspace": "/home/ubuntu/q-workspace/a1b2c3d4e5f6a7b8c9d0e1f2",
  "remoteNodeVersion": "v22.19.0",
  "remoteArch": "x64",
  "remotePlatform": "linux",
  "startedAt": "2025-01-15T10:30:00.000Z",
  "pid": 12345,
  "mode": "auto"
}
```

### Resume with Event Replay

When resuming, the local client starts streaming from the last seen sequence
number. The `RemoteSession` tracks `lastSeenSeq` and passes it to
`streamEvents()`:

```typescript
// Start streaming from the last known seq
await remoteSession.streamEvents(
  (env) => handler(env),
  { fromSeq: remoteSession.lastSeq + 1 },
);
```

The `tail -f` command reads from line 1, but the client filters out events
with `seq < fromSeq`:

```typescript
if (env.seq < fromSeq) return; // skip already-seen events
this.lastSeenSeq = Math.max(this.lastSeenSeq, env.seq);
onEvent(env);
```

---

## CLI Commands Reference

### `q-cli ssh connect <host>`

Connect to a remote server and start a cloud agent session.

```bash
# Basic usage (uses current SSH user and default key)
q-cli ssh connect ec2-xxx.compute.amazonaws.com

# With explicit user, port, and key
q-cli ssh connect ec2-xxx.compute.amazonaws.com \
  --user ubuntu \
  --port 2222 \
  --key ~/.ssh/my-key.pem

# With execution mode
q-cli ssh connect ec2-xxx.compute.amazonaws.com \
  --mode modus_maximus

# Auto-approve all actions (yolo mode)
q-cli ssh connect ec2-xxx.compute.amazonaws.com --yolo

# Specify a session ID (auto-generated if omitted)
q-cli ssh connect ec2-xxx.compute.amazonaws.com \
  --session my-custom-session-id

# Force rebuild the q-remote tarball
q-cli ssh connect ec2-xxx.compute.amazonaws.com --force-rebuild
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--user <user>` | SSH user | Current OS user |
| `--port <port>` | SSH port | 22 |
| `--key <path>` | SSH private key path | Default key from `~/.ssh/` |
| `--mode <mode>` | Execution mode: `auto` or `modus_maximus` | `auto` |
| `--yolo` | Auto-approve all actions on the remote | false |
| `--session <id>` | Session ID | Auto-generated (32 hex chars) |
| `--force-rebuild` | Force rebuild the q-remote tarball | false |

### `q-cli ssh resume <host>`

Reconnect to a running remote daemon and launch the full TUI.

```bash
# Resume a specific session
q-cli ssh resume ec2-xxx.compute.amazonaws.com \
  --session a1b2c3d4e5f6a7b8c9d0e1f2

# With custom SSH options
q-cli ssh resume ec2-xxx.compute.amazonaws.com \
  --user ubuntu \
  --port 2222 \
  --key ~/.ssh/my-key.pem \
  --session a1b2c3d4e5f6a7b8c9d0e1f2

# With yolo mode
q-cli ssh resume ec2-xxx.compute.amazonaws.com \
  --session a1b2c3d4e5f6a7b8c9d0e1f2 \
  --yolo
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--user <user>` | SSH user | Current OS user |
| `--port <port>` | SSH port | 22 |
| `--key <path>` | SSH private key path | Default key |
| `--session <id>` | Session ID to resume | **Required** |
| `--yolo` | Auto-approve all actions | false |

### `q-cli ssh sync <host>`

Bi-directional sync of code changes between local and remote.

```bash
# Full bi-directional sync (pull + push)
q-cli ssh sync ec2-xxx.compute.amazonaws.com \
  --session a1b2c3d4e5f6a7b8c9d0e1f2

# Pull only (download remote changes)
q-cli ssh sync ec2-xxx.compute.amazonaws.com \
  --session a1b2c3d4e5f6a7b8c9d0e1f2 \
  --direction pull

# Push only (upload local changes)
q-cli ssh sync ec2-xxx.compute.amazonaws.com \
  --session a1b2c3d4e5f6a7b8c9d0e1f2 \
  --direction push

# With conflict policy
q-cli ssh sync ec2-xxx.compute.amazonaws.com \
  --session a1b2c3d4e5f6a7b8c9d0e1f2 \
  --policy remote-wins

# Dry run (show what would change without applying)
q-cli ssh sync ec2-xxx.compute.amazonaws.com \
  --session a1b2c3d4e5f6a7b8c9d0e1f2 \
  --dry-run
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--user <user>` | SSH user | Current OS user |
| `--port <port>` | SSH port | 22 |
| `--key <path>` | SSH private key path | Default key |
| `--session <id>` | Session ID | **Required** |
| `--direction <d>` | Sync direction: `both`, `pull`, or `push` | `both` |
| `--policy <p>` | Conflict policy: `remote-wins`, `local-wins`, `prompt`, or `merge` | `prompt` |
| `--dry-run` | Show what would change without applying | false |

### `q-cli ssh run <host> <prompt>`

Inject a prompt into a running remote session without launching the TUI.

```bash
# Send a prompt
q-cli ssh run ec2-xxx.compute.amazonaws.com "Refactor the auth module" \
  --session a1b2c3d4e5f6a7b8c9d0e1f2

# Send a prompt with a specific mode
q-cli ssh run ec2-xxx.compute.amazonaws.com "Write comprehensive tests" \
  --session a1b2c3d4e5f6a7b8c9d0e1f2 \
  --mode modus_maximus

# Cancel the current task
q-cli ssh run ec2-xxx.compute.amazonaws.com "" \
  --session a1b2c3d4e5f6a7b8c9d0e1f2 \
  --cancel
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--user <user>` | SSH user | Current OS user |
| `--port <port>` | SSH port | 22 |
| `--key <path>` | SSH private key path | Default key |
| `--session <id>` | Session ID | **Required** |
| `--mode <m>` | Execution mode: `auto` or `modus_maximus` | `auto` |
| `--cancel` | Send a cancel command instead of a prompt | false |

### `q-cli ssh sessions`

List known remote sessions and their current status.

```bash
# List all sessions
q-cli ssh sessions

# List only active (running) sessions
q-cli ssh sessions --active
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--active` | Show only running sessions | false |

**Output example:**
```
  All Remote Sessions:

  Session ID     Host                 Mode   Status     Started
  ----------------------------------------------------------------
  a1b2c3d4...    ubuntu@ec2-xxx...    auto   running    1/15/2025, 10:30:00 AM
  e5f6a7b8...    ubuntu@ec2-yyy...    auto   stopped    1/14/2025, 3:15:00 PM

  To reconnect to a running session:
    q-cli ssh resume <host> --session <session-id>
```

### `q-cli ssh delete-session <session-id>`

Delete a saved session from the local registry.

```bash
# Delete with confirmation prompt
q-cli ssh delete-session a1b2c3d4e5f6a7b8c9d0e1f2

# Delete without confirmation
q-cli ssh delete-session a1b2c3d4e5f6a7b8c9d0e1f2 --force

# Shut down the remote daemon first, then delete
q-cli ssh delete-session a1b2c3d4e5f6a7b8c9d0e1f2 --shutdown

# Shut down and force delete
q-cli ssh delete-session a1b2c3d4e5f6a7b8c9d0e1f2 --shutdown --force
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--shutdown` | Send shutdown to remote daemon before deleting | false |
| `--force` | Delete without confirmation | false |

---

## Build & Pack

### Building q-remote

The q-remote package must be built and packed into a tarball before it can be
uploaded to the remote server. This is done automatically during `ssh connect`,
but can also be done manually:

```bash
# Using the build script
./scripts/build-q-remote.sh

# Or manually
pnpm --filter @qode-agent/q-remote build
cd packages/q-remote
npm pack --pack-destination ../../dist-packs
cd ../..
```

The build script:
1. Runs `pnpm --filter @qode-agent/q-remote build` to compile TypeScript
2. Strips `workspace:*` dependencies from `package.json` (they're bundled into
   the dist files by tsdown)
3. Runs `npm pack` to create the tarball in `dist-packs/`
4. Restores the original `package.json`

The resulting tarball is at:
```
dist-packs/qode-agent-q-remote-<version>.tgz
```

### Building the full project

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Build just the q-remote package
pnpm --filter @qode-agent/q-remote build

# Build just the q-cli
pnpm --filter q-cli build
```

### Syncing to ~/.Q

After building, sync the build artifacts:

```bash
pnpm build
# This builds everything and syncs to ~/.Q/build/
```

---

## Testing

### Local Integration Test

The `scripts/test-qssh-local.sh` script runs a full integration test of the
QSSH system using a local "remote" (no SSH needed):

```bash
./scripts/test-qssh-local.sh
```

This test:
1. Builds q-remote if needed
2. Tests `q-remote version`
3. Tests `q-remote sync-diff` (file manifest generation)
4. Tests `q-remote status` (no daemon running)
5. Tests credential encryption round-trip
6. Tests the full daemon lifecycle: launch, verify events, shutdown

### Unit Tests

```bash
# Run all tests
pnpm test

# Run specific test files
pnpm --filter @qode-agent/q-remote test
pnpm --filter @qode-agent/protocol test

# Run with vitest directly
npx vitest run packages/q-remote/src/__tests__/
npx vitest run apps/q-cli/src/ssh/__tests__/
```

### Manual End-to-End Test

```bash
# 1. Build everything
pnpm build

# 2. Connect to a remote server
q-cli ssh connect ec2-xxx.compute.amazonaws.com --yolo

# 3. In another terminal, check session status
q-cli ssh sessions

# 4. Send a prompt via CLI
q-cli ssh run ec2-xxx.compute.amazonaws.com "List the files in the workspace" \
  --session <session-id>

# 5. Sync changes back
q-cli ssh sync ec2-xxx.compute.amazonaws.com \
  --session <session-id> \
  --direction pull

# 6. Resume a disconnected session
q-cli ssh resume ec2-xxx.compute.amazonaws.com \
  --session <session-id>
```

---

## SshTransport Reference

The `SshTransport` class wraps SSH and SCP execution with typed results.

### Methods

| Method | Description | Underlying Command |
|--------|-------------|-------------------|
| `exec(cmd)` | Run a command and return full output | `ssh <opts> user@host "<cmd>"` |
| `execStream(cmd, onLine)` | Run a command, stream stdout line-by-line | `ssh <opts> user@host "<cmd>"` |
| `uploadFile(local, remote)` | Upload a single file | `scp <opts> <local> user@host:<remote>` |
| `uploadDir(local, remote)` | Upload a directory via tar pipe | `tar czf - -C <local> . \| ssh <opts> user@host "tar xzf - -C <remote>"` |
| `downloadFile(remote, local)` | Download a single file | `scp <opts> user@host:<remote> <local>` |
| `testConnection()` | Test SSH and gather remote info | `ssh <opts> user@host "node --version; echo '\|'; uname -m; echo '\|'; uname -s"` |
| `writeRemoteTmpFile(content)` | Write a secure tmp file on remote | `echo '<base64>' \| base64 -d > /tmp/q-xxxx.tmp && chmod 600` |
| `deleteRemoteFile(path)` | Delete a remote file | `ssh <opts> user@host "rm -f <path>"` |

### SSH Options

All SSH commands use these options:

```
-o ConnectTimeout=<seconds>   (default: 10)
-o StrictHostKeyChecking=accept-new
-o ServerAliveInterval=15
-o ServerAliveCountMax=3
-p <port>                     (if specified)
-i <keyPath>                  (if specified)
```

### Example: exec

```typescript
const transport = new SshTransport(
  { host: "ec2-xxx.com", user: "ubuntu", port: 2222, keyPath: "~/.ssh/key.pem" },
  { connectTimeoutS: 15, verbose: true },
);

const result = await transport.exec("ls -la", { timeoutMs: 10_000 });
// result = { ok: true, exitCode: 0, stdout: "...", stderr: "" }
```

### Example: execStream

```typescript
await transport.execStream(
  "tail -f /path/to/events.log",
  (line) => console.log("Event:", line),
  {
    onStderr: (line) => console.error("SSH err:", line),
    signal: abortController.signal,
  },
);
```

### Example: uploadDir (tar pipe)

```typescript
await transport.uploadDir(
  "/local/project",
  "~/remote-workspace",
  { exclude: ["node_modules", ".git"] },
);
// Equivalent to:
//   ssh user@host "mkdir -p ~/remote-workspace"
//   tar czf - -C /local/project --exclude node_modules --exclude .git . | ssh user@host "tar xzf - -C ~/remote-workspace"
```

---

## File Layout

```
apps/q-cli/src/ssh/
  types.ts              — Shared types (SshTarget, ExecResult)
  transport.ts          — SshTransport (ssh/scp/tar|ssh wrapper)
  credentials.ts        — Credential encryption, collection, passphrase generation
  install.ts            — Remote Node check + q-remote installation
  upload.ts             — Project snapshot creation + upload, local manifest computation
  pack.ts               — q-remote tarball build + pack
  remote-session.ts     — RemoteSession (event streaming, control, status, shutdown)
  sync.ts               — Bi-directional sync (manifest diff, tarball transfer, 3-way merge)
  heartbeat.ts          — HeartbeatMonitor (ping, backoff, health state)
  event-adapter.ts      — NDJSON envelope to TUI event conversion
  progress.ts           — Text-based progress bars and step counters
  text-banners.ts       — Box-drawn session banners and health lines
  commands/
    connect.ts          — Full connect flow (8 steps)
    resume.ts           — Resume flow (reconnect to running daemon)
    run.ts              — Inject prompt or cancel command
    sync.ts             — Sync command handler

packages/q-remote/src/
  main.ts               — CLI entry point (daemon, run, status, sync-diff, sync-apply, sessions)
  daemon.ts             — RemoteDaemon (lifecycle, control polling, command handling)
  event-bridge.ts       — EventBridge (seq counter, NDJSON output, log persistence)
  log-store.ts          — LogStore (append-only NDJSON event log)
  session-manager.ts    — SessionManager (per-session state tracking)
  sync-server.ts        — SyncServer (file manifest computation, patch application)
  credentials.ts        — Credential decryption + validation (mirrors local encrypt)
  agent-factory.ts      — Headless Agent creation wired to EventBridge

packages/protocol/src/
  envelope.ts           — Canonical types (NdjsonEnvelope, ControlCommand, RemoteStatus, etc.)
  index.ts              — Re-exports
```

---

## Security Considerations

1. **Credentials in transit**: Encrypted with AES-256-GCM before upload.
   The passphrase is transmitted via a separate SSH channel and never
   persisted to local disk.

2. **Credentials at rest**: The encrypted blob is stored in `/tmp/` on the
   remote with `chmod 600`. Both the blob and the passphrase file are
   deleted by the daemon after decryption.

3. **Local Ollama rejection**: The system explicitly rejects credentials
   pointing to localhost Ollama instances — they cannot be reached from
   the cloud.

4. **SSH key security**: The user's SSH key is used only for the initial
   connection. No credentials are embedded in the daemon's command line
   (the passphrase is read from a file).

5. **File-based control**: The control channel uses a file rather than
   stdin, making it safe for nohup'd processes. The control file is
   append-only and the daemon tracks its read offset.

6. **Event log persistence**: Events are written to the log file BEFORE
   being streamed to stdout, ensuring crash survival.
