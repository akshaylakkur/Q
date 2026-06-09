# Qode — From one-liners to cross-cutting changes — orchestrated in your terminal

**Qode** (the CLI is `q-cli`) is an experimental terminal-based coding agent that understands, modifies, and generates code across your project. It operates directly in your terminal with a rich TUI, connects to various LLM providers, and coordinates multi-file changes through an orchestration engine.

> ⚠️ **Status**: Early development (v0.1.0). Many features are stubs or incomplete. Expect rough edges.

---

## What It Does

At a high level, Qode is a conversational coding agent. You describe what you want done, and Qode works through it — reading files, writing code, running shell commands, and iterating until the task is complete or it needs guidance.

Unlike a simple chat interface, Qode has an **orchestrator** that tries to match how it works to the complexity of your request:

- A simple one-line fix → direct execution, no overhead
- A multi-file refactor → lightweight planning and coordinated edits
- A complex cross-cutting change → task decomposition with parallel sub-agents, convergence, and verification

The orchestrator classifies your intent, selects an execution mode, decomposes the work, and manages the lifecycle.

---

## Architecture

Qode is a pnpm monorepo with these packages:

| Package | Purpose |
|---------|---------|
| `apps/q-cli` | Main CLI app — orchestrator, TUI, memory system, MCP, plugins, verification |
| `packages/agent-core` | Core agent runtime — context management, turn loop, tool execution, sub-agents |
| `packages/qprovs` | LLM provider abstraction — Anthropic, OpenAI, Gemini, Ollama, Kimi, compatible APIs |
| `packages/qmain` | Execution environment — file ops, shell commands, git, web requests |
| `packages/node-sdk` | Programmatic Node.js SDK for Qode |
| `packages/oauth` | OAuth 2.0 flow support for MCP server auth |
| `packages/telemetry` | Optional crash reporting and usage telemetry |

### Key Components

**Agent Core** (`@q/agent-core`) — The runtime that manages conversation context, executes tool calls, handles permissions, and runs the turn loop. Each agent has a context memory, tool manager, permission system, and optional sub-agent hosting.

**LLM Providers** (`@q/qprovs`) — A unified interface across multiple providers. Supports Anthropic (Claude with extended thinking), OpenAI (GPT-4/4o), Google Gemini, Ollama (local models, no API key), Kimi, and any OpenAI-compatible API. Includes retry logic, request caching, and fallback chains.

**Qmain** (`@q/qmain`) — The execution environment providing connectors for file operations, shell commands, git integration, and web requests.

**Orchestrator** — The central state machine that classifies intent, decomposes tasks, dispatches work to sub-agents, converges results, runs verification, and self-corrects on failures.

**Memory System** — A four-tier architecture:
- **WorkingMemory** — Priority-tagged context with graduated compaction
- **EpisodicRecall** — Structured episode records for session summaries *(in progress)*
- **LTPM** — Long-term persistent storage for facts and decisions *(in progress)*
- **CodebaseGraph** — Live workspace topology and dependency graph *(in progress)*

---

## Capabilities

### What's Working

- ✅ **Rich TUI** — Streaming agent output with markdown rendering, styled tool call artifacts, file explorer, multi-line input editor with history
- ✅ **Slash commands**: `/help`, `/status`, `/session`, `/clear`, `/exit`, `/version`
- ✅ **Multiple LLM providers** — Anthropic, OpenAI, Google Gemini, Ollama, Kimi, OpenAI-compatible
- ✅ **Onboarding wizard** — First-run setup guiding through provider configuration
- ✅ **Config system** — Hierarchical config (built-in defaults → `~/.Q/config.toml` → `.q/config.toml` → env vars)
- ✅ **Tool execution** — File read/write, shell commands, git operations, web requests
- ✅ **Permission modes** — Manual (ask), auto (approve safe ops), yolo (approve everything)
- ✅ **Agent profiles** — Configurable system prompts and tool sets
- ✅ **Session persistence** — JSONL wire format, blob store, session store
- ✅ **MCP client** — stdio and HTTP/SSE transport for Model Context Protocol servers
- ✅ **Plugin system** — Manifest-based discovery, lifecycle hooks, custom tool registration
- ✅ **Skill system** — Reusable prompt templates and inline scripts, auto-scanned from directories
- ✅ **Built-in skills**: Project initialization, MCP configuration
- ✅ **Intent classifier** — Heuristic analysis of prompts for scope, depth, and execution mode selection
- ✅ **Execution modes** — DIRECT, LIGHTWEIGHT_PLAN, PARALLEL_DISPATCH, ORCHESTRATED_CAMPAIGN, CAMPAIGN_CONTINUOUS
- ✅ **Task decomposition** — DAG-based sub-task graphs with wave-based dispatch
- ✅ **Convergence engine** — Diff collection, conflict detection (LINE/MODULE/API), and resolution
- ✅ **Sub-agent pool** — Parallel sub-agent execution with state tracking and lifecycle management
- ✅ **Verification pipeline** — 7-gate validation (syntax, lint, typecheck, unit tests, integration tests, architecture, full suite)
- ✅ **Self-correction cycle** — Automated fix → re-verify loop with escalation
- ✅ **Dynamic reclassifier** — Runtime mode escalation based on execution metrics
- ✅ **Codebase graph** — Live workspace topology with file tree, module graph, dependency rules
- ✅ **Memory coordinator** — Unified API across memory tiers
- ✅ **Non-interactive mode** — `--prompt` for CI/CD, `--output-format json` for structured output
- ✅ **Doctor command** — Diagnose configuration issues
- ✅ **Shell completions** — Bash/Zsh/Fish completion script generation
- ✅ **CLI options**: session resume (`-S`), continue last (`-C`), model override (`-m`), plan mode (`--plan`), custom working directory (`--cwd`), TUI toggle (`--tui`/`--no-tui`)

### In Progress / Stubs

- 🔄 **Extended slash commands** — Only 6 core commands implemented. The registry defines 40+ commands across 7 categories (agent, memory, tools, debug, files, display, mode) — most are stubs
- 🔄 **Episodic memory** — Episode builder and compaction protocol handler exist, full recall store in progress
- 🔄 **LTPM** — Persistent disk-backed store scaffolded, full consolidation and retention pending
- 🔄 **Semantic recall** — Vector index for semantic search over memory (uses Xenova Transformers)
- 🔄 **CI/CD integration** — CI mode detection exists, full pipeline integration is a stub
- 🔄 **Daemon mode** — Background daemon with keep-alive is a stub
- 🔄 **Collaboration** — Multi-user session sharing is planned
- 🔄 **`connect` command** — Remote Qode instance connection is a stub
- 🔄 **`profile` command** — Profile management CLI is a stub
- 🔄 **`plugin` command** — Plugin management CLI is a stub
- 🔄 **Turn loop streaming** — Agent-core turn loop has TODO stubs for event emission
- 🔄 **MCP OAuth** — Auth tool, provider, and callback server are scaffolded
- 🔄 **Help panel** — Interactive help dashboard component exists, full integration pending
- 🔄 **Status dashboard** — Rich status dashboard component exists, full integration pending
- 🔄 **Diff preview** — Inline diff rendering component exists
- 🔄 **Thinking section** — Model reasoning display with collapse/inspect controls

---

## Getting Started

### Prerequisites

- **Node.js** >= 22.19.0
- **pnpm** >= 10.33.0

### Installation

```bash
# Clone and install
git clone <repo-url>
cd Q
bash install.sh
```

The installer checks prerequisites, builds the project, creates `~/.Q/` with config templates, installs the `q-cli` wrapper to `~/.Q/bin/`, and adds it to your PATH.

### Quick Start

```bash
# Interactive mode (opens TUI)
q-cli

# One-shot prompt (non-interactive)
q-cli -p "Add error handling to src/routes/users.ts"

# Use a specific model
q-cli -m claude-sonnet-4-20250514

# Resume a previous session
q-cli -S <session-id>

# Auto-approve all actions
q-cli -y
```

### Configuration

Configuration is loaded from these sources (in order of increasing priority):

1. **Built-in defaults** — Compiled into the binary
2. **Global config** — `~/.Q/config.toml`
3. **Project config** — `.q/config.toml` (discovered by walking up from cwd)
4. **Environment variables** — `Q_PROVIDER`, `Q_MODEL`, `Q_API_KEY`, `Q_BASE_URL`

On first run, the interactive onboarding wizard will guide you through setting up a provider.

### CLI Reference

```
Usage: q-cli [options] [command]

Options:
  -S, --session <id>       Resume a specific session
  -C, --continue           Continue the last session
  -y, --yolo               Auto-approve all actions
  -m, --model <name>       Override the LLM model
  -p, --prompt <text>      Non-interactive prompt mode
  --plan                   Enter plan mode on startup
  --auto                   Auto permission mode
  --setup                  Re-run the initial setup wizard
  --output-format <fmt>    Output format (text|json|stream-json)
  --skills-dir <dir>       Additional skill directories (repeatable)
  --cwd <path>             Set the working directory
  --tui / --no-tui         Force/enable TUI mode

Commands:
  init          Initialize a Qode project
  session       Manage sessions (list, show, delete, export, import)
  config        View and edit configuration
  doctor        Diagnose and fix configuration issues
  migrate       Migrate data between Qode versions
  update        Check for and install updates
  completions   Generate shell completion scripts
  daemon        Start/stop the Qode daemon
  connect       Connect to a remote Qode instance
  profile       Manage agent profiles
  plugin        Manage plugins (list, install, remove, update)
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `Q_PROVIDER` | LLM provider (`anthropic`, `openai`, `ollama`, etc.) |
| `Q_MODEL` | Model name (e.g. `claude-sonnet-4-20250514`) |
| `Q_API_KEY` | API key for the provider |
| `Q_BASE_URL` | Custom base URL for the provider API |
| `Q_THINKING` | Thinking level (`none`, `low`, `medium`, `high`) |

---

## Execution Modes

The orchestrator classifies each request and selects an execution mode:

| Mode | Level | When It's Used |
|------|-------|----------------|
| **DIRECT** | 0 | Simple single-file changes — no planning overhead |
| **LIGHTWEIGHT_PLAN** | 1 | Multi-file changes with light coordination |
| **PARALLEL_DISPATCH** | 2 | Module-level deep work — parallel sub-agents with wave convergence |
| **ORCHESTRATED_CAMPAIGN** | 3 | Cross-cutting changes — full pipeline with verification |
| **CAMPAIGN_CONTINUOUS** | 4 | Codebase-wide generation — continuous monitoring |

Modes 0–1 apply the **Invisibility Principle** (no pool/convergence events). Modes 2–4 progressively add orchestration infrastructure.

The **DynamicReclassifier** monitors execution metrics at runtime and can escalate to a higher mode if the current one is struggling.

---

## Verification Pipeline

After executing changes, the verification pipeline runs a configurable set of gates:

| Gate | Scope | Min Mode |
|------|-------|----------|
| Syntax Check | Modified files | 0 |
| Lint Check | Modified files | 1 |
| Type Check | Modified files + dependents | 2 |
| Unit Tests | Affected modules | 2 |
| Integration Tests | Cross-module tests | 3 |
| Architecture Check | Module boundaries | 3 |
| Full Test Suite | Entire project | 4 |

Each gate auto-detects the appropriate tool for the language:
- **TypeScript/JS**: `tsc`, `eslint`, `vitest`, `jest`, Babel parser
- **Python**: `py_compile`, `ruff`, `pytest`, `pyright`
- **Rust**: `cargo check`, `clippy`, `cargo test`
- **Go**: `go vet`, `go build`, `go test`, `golangci-lint`

Failed gates trigger the self-correction cycle, which attempts automated fixes and re-verification.

---

## Permission Modes

| Mode | Behavior |
|------|----------|
| **manual** (default) | Prompt before every tool execution |
| **auto** | Auto-approve safe operations, ask for risky ones |
| **yolo** | Auto-approve all actions — use with caution |

---

## Plugins & Skills

**Plugins** extend Qode with custom functionality through manifest-based discovery. They can register lifecycle hooks (`beforeInit`, `afterInit`, `beforeAgentTurn`, `afterAgentTurn`, `beforeToolUse`, `afterToolUse`, `beforeShutdown`), add custom tools, contribute skills, and manage MCP servers.

**Skills** are reusable prompt templates or inline scripts discovered from project, user, and extra directories. They can be prompt-based (model-generated responses), inline (JavaScript/TypeScript executed on invocation), or flow-based (multi-step workflows).

---

## Development

```bash
# Install dependencies
pnpm install

# Build all packages and CLI
pnpm build

# Development mode (hot-reload)
pnpm dev

# Run tests
pnpm test

# Type-check
pnpm typecheck

# Lint
pnpm lint
```

---

## License

MIT