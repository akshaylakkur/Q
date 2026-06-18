# Qode (q-cli)

Node SDK v0.1.0

MIT

Qode is a terminal-based autonomous coding agent for long-running tasks and massive codebase development. It operates directly in your terminal with a rich TUI, connects to multiple LLM providers, and orchestrates multi-file changes through an intelligent pipeline that scales from one-line fixes to cross-cutting transformations spanning hundreds of files.

The Node SDK is a thin client that reuses the same Qode CLI configuration, tools, skills, and MCP servers. It streams responses in real time, surfaces approvals and tool calls, and lets you orchestrate sessions programmatically.

---

## Overview

Qode provides an autonomous agent runtime, enabling you to:

- **Build custom applications** — Integrate Qode into your own tools and workflows
- **Automate complex tasks** — Script multi-turn conversations across long-running sessions
- **Run massive codebase operations** — Use Modus Maximus for cross-cutting changes


### Core capabilities

- **Two execution modes**: AUTO (single-agent turn loop with classifier-driven behavior) and MODUS MAXIMUS (4-phase pipeline: plan generation, user confirmation, sequential sub-agent execution through specialist profiles, and final summary)
- **Intent classification**: Heuristic analysis of every prompt for scope, depth, file references, action verbs, parallelism needs, and verification requirements
- **Dynamic escalation**: Runtime mode escalation via DynamicReclassifier when the current execution strategy is insufficient
- **Modus Maximus**: 15-50 dependency-aware plan steps, user confirmation (Looks Good / Needs Revision / Redo), sequential sub-agent execution with heuristic profile resolution, and final summary (Aims to generate 50k-80k lines of code for a fresh project in one shot through our specialized architecture)
- **Specialist agent profiles**: Editius (surgical code editing via StrReplace), Rewritius (full-file rewrites and refactoring), Searchius (codebase analysis), Auto (task-adaptive); switchable via `/agent`
- **Four-tier memory**: WorkingMemory with priority-tagged compaction, EpisodicRecall with TF-IDF scoring, LTPM (disk-backed persistence with retention policies), SemanticRecall (vector-based ANN search via HNSW index), CodebaseGraph (language-aware model for TS, JS, Python, Rust, Go, Java)
- **Verification pipeline**: 7 gates (syntax, lint, typecheck, unit tests, integration tests, architecture, full suite) with per-language auto-detection and SHA-256 caching
- **Self-correction**: Automated fix-and-reverify loop with architecture escalation
- **Multiple LLM providers**: Anthropic, OpenAI, Google Gemini, Ollama (local, no API key), Kimi, OpenAI-compatible
- **Plugin system**: Manifest-based discovery with lifecycle hooks
- **Skill system**: Reusable prompt templates and inline scripts
- **MCP client**: stdio and HTTP/SSE transport
- **Session persistence**: JSONL wire format, blob store, migration system
- **Non-interactive mode**: `--prompt` for CI/CD, `--output-format json`
- **Onboarding wizard**: First-run setup for provider and model

---

## Available Packages

| Package | Description | Status |
|---------|-------------|--------|
| `apps/q-cli` | Main CLI — orchestrator, TUI, memory, MCP, plugins, verification | Available |
| `packages/agent-core` | Core agent runtime — context, turn loop, tools, sub-agents, profiles | Available |
| `packages/qprovs` | LLM provider abstraction | Available |
| `packages/qmain` | Execution environment — file ops, shell, git, web | Available |
| `packages/node-sdk` | Programmatic Node.js SDK | Available |
| `packages/oauth` | OAuth 2.0 for MCP server auth | Available |
| `packages/telemetry` | Optional crash reporting and telemetry | Available |

---

## Quick Start

### Installation

```bash
npm install -g qode-agent
```

Requires Node.js >= 22.19.0 and pnpm >= 10.33.0. The installer builds the project, creates `~/.Q/`, and installs the `q-cli` wrapper.

### Usage

```bash
# Interactive mode (opens TUI)
q-cli

# Shorthand
q

# One-shot prompt for CI/CD
q-cli -p "Add error handling to src/routes/users.ts"

# Use Modus Maximus for complex tasks
q-cli
q> /mode modus-maximus
q> Refactor the authentication system to use OAuth 2.0

# Resume a previous session
q-cli -S <session-id>

# Non-interactive with JSON output
q-cli -p "Fix the type errors" --output-format json
```

### CLI Options

```
-S, --session <id>       Resume a session
-C, --continue           Continue last session
-y, --yolo               Auto-approve all actions
-m, --model <name>       Override LLM model
-p, --prompt <text>      Non-interactive mode
--plan                   Plan mode on startup
--auto                   Auto permission mode
--setup                  Re-run setup wizard
--output-format <fmt>    text | json | stream-json
--skills-dir <dir>       Additional skill directories
--cwd <path>             Working directory
--tui / --no-tui         Force/enable TUI
```

### Commands

```
init          Initialize a Qode project
session       Manage sessions (list, show, delete, export, import)
config        View and edit configuration
doctor        Diagnose and fix configuration issues
migrate       Migrate data between versions
update        Check for and install updates
completions   Generate shell completion scripts
daemon        Start/stop the Qode daemon
connect       Connect to a remote instance
profile       Manage agent profiles
plugin        Manage plugins
```

### Slash Commands

```
/help             Interactive help dashboard
/status           Session status dashboard
/session          Show/manage session info
/clear            Clear transcript
/exit             Gracefully exit
/version          Show version info
/mode <name>      Switch mode (auto, modus-maximus)
/agent <name>     Switch profile (auto, editius, rewritius, searchius)
/qmd              Generate Q.md with project conventions
```

### Environment Variables

```
Q_PROVIDER    LLM provider (anthropic, openai, ollama, etc.)
Q_MODEL       Model name (e.g. claude-sonnet-4-20250514)
Q_API_KEY     API key for the provider
Q_BASE_URL    Custom base URL
Q_THINKING    Thinking level (none, low, medium, high)
```

### Configuration

Loaded in ascending priority: built-in defaults → `~/.Q/config.toml` → `.q/config.toml` (walked up from cwd) → environment variables. First run launches interactive onboarding wizard.

---

## Remote Execution (QSSH)

QSSH lets you shift heavy, long-running workflows (like Modus Maximus) from your local machine to a remote EC2 or custom server. The remote server runs a headless `q-remote` daemon under `nohup`, so tasks continue uninterrupted even during a network disconnect. Your local terminal streams events from the remote in real time.

### Prerequisites

- **Remote server**: Linux with Node.js >= 22.19.0 installed and SSH access configured
- **Local**: `ssh` and `scp` available on PATH, and an SSH key with access to the remote
- **LLM credentials**: A cloud-accessible provider (local Ollama instances are rejected — the remote cannot reach your localhost)

### Quick Start

```bash
# Connect to a remote server, upload your project, and start streaming
q-cli ssh connect ec2-1-2-3-4.compute.amazonaws.com --user ubuntu --key ~/.ssh/id_ed25519

# With Modus Maximus mode for large workflows
q-cli ssh connect my-server --mode modus_maximus --yolo
```

The connect flow:
1. Validates SSH connectivity and checks remote Node version
2. Builds and uploads the `q-remote` package (not yet on npm — packed locally and installed via `npm install -g`)
3. Collects and encrypts your LLM credentials (AES-256-GCM) and uploads them
4. Uploads a streamlined, dependency-ignored snapshot of your project
5. Launches the remote daemon under `nohup` (survives disconnect)
6. Transitions your terminal to a remote-streaming TUI

### Subcommands

```bash
# Reconnect to a running remote daemon and stream pending logs
q-cli ssh resume <host> --session <id>

# Bi-directional Git-like sync of code changes
q-cli ssh sync <host> --session <id> --direction both --policy prompt

# Dry-run sync (show what would change without applying)
q-cli ssh sync <host> --session <id> --dry-run

# Inject a prompt into a running remote session
q-cli ssh run <host> "fix the failing tests" --session <id> --mode auto

# Cancel the current remote task
q-cli ssh run <host> --cancel --session <id>

# List known remote sessions
q-cli ssh sessions

# Show remote daemon status
q-cli ssh connect <host>  # (status is queried during connect)
```

### Security Model

- **Encrypted credentials**: LLM API keys are encrypted with AES-256-GCM using a per-session passphrase. The passphrase is transmitted out-of-band via a separate SSH exec and is never written to disk in plaintext. The encrypted credential file is deleted on the remote after the daemon reads it.
- **Ollama exclusion**: Local Ollama instances (provider `ollama` with a `localhost`/`127.0.0.1` base URL) are explicitly rejected — the remote server cannot reach your local Ollama. Configure a cloud-accessible Ollama URL or use a different provider.
- **No credentials on disk**: The remote daemon decrypts credentials in memory and unlinks the encrypted file immediately.

### Sync

The bi-directional sync uses a manifest-based differential approach (not a Git clone — the remote workspace need not be a Git repo). Both sides compute a file manifest (path, size, mtime, sha256), compare them, and apply changes per the configured conflict policy:

- `remote-wins`: remote version overwrites local
- `local-wins`: local version overwrites remote
- `prompt`: interactive resolution in the TUI
- `merge`: 3-way merge using the initial snapshot as the common ancestor

### Heartbeat and Reconnect

The local client monitors connection health with automated heartbeat checks. On interruption, it retries with exponential backoff and logs each attempt. The remote daemon keeps running under `nohup` regardless of the local connection state — you can reconnect with `q-cli ssh resume` at any time.

### File-Change Auditing

Every file the remote agent creates, modifies, or deletes is logged to a strict audit trail and streamed to your local TUI. The audit log shows the action (create/modify/delete), the file path, and the size change.

### Text-Based Visuals

All progress indicators, loading animations, and instance metadata use text augmentation and ASCII box-drawing characters only — no icons or emoji, per the project conventions.

### Troubleshooting

- **Node version mismatch**: The remote requires Node >= 22.19.0. The connect flow checks this and errors with instructions if it is missing or too old.
- **Firewall**: Ensure port 22 (SSH) is open between your machine and the remote.
- **q-remote not found**: The connect flow builds and uploads q-remote automatically. If `q-remote --version` fails on the remote, check that the npm global bin directory is on the remote PATH.
- **nohup survival**: The daemon uses a file-based control channel (`control.jsonl`), not stdin, so it survives `nohup ... &` without an open stdin.

---

## License

MIT
