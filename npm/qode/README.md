# Qode (qode-agent)

CLI v0.3.1

MIT

Qode is a terminal-based autonomous coding agent for long-running tasks and massive codebase development. It operates directly in your terminal with a rich TUI, connects to multiple LLM providers, and orchestrates multi-file changes through an intelligent pipeline that scales from one-line fixes to cross-cutting transformations spanning hundreds of files.

The Node SDK is a thin client that reuses the same Qode CLI configuration, tools, skills, and MCP servers. It streams responses in real time, surfaces approvals and tool calls, and lets you orchestrate sessions programmatically.

---

## Overview

Qode provides an autonomous agent runtime, enabling you to:

- **Build custom applications** — Integrate Qode into your own tools and workflows
- **Automate complex tasks** — Script multi-turn conversations across long-running sessions
- **Run massive codebase operations** — Use Modus Maximus for cross-cutting changes
- **Extend capabilities** — Register custom plugins, skills, and MCP servers
- **Handle approvals** — Programmatically respond to permission requests

### Core capabilities

- **Two execution modes**: AUTO (single-agent turn loop with classifier-driven behavior) and MODUS MAXIMUS (4-phase pipeline: plan generation, user confirmation, sequential sub-agent execution through specialist profiles, and final summary)
- **Intent classification**: Heuristic analysis of every prompt for scope, depth, file references, action verbs, parallelism needs, and verification requirements
- **Dynamic escalation**: Runtime mode escalation via DynamicReclassifier when the current execution strategy is insufficient
- **Modus Maximus**: 15-50 dependency-aware plan steps, user confirmation (Looks Good / Needs Revision / Redo), sequential sub-agent execution with heuristic profile resolution, and final summary
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

## Quick Start

### Install

```bash
npm install -g qode-agent
```

Requires Node.js >= 22.19.0. On first run, the interactive wizard guides you through LLM provider setup (or set `Q_PROVIDER`, `Q_MODEL`, `Q_API_KEY` env vars).

### Use

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

## License

MIT
