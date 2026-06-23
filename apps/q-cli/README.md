# @qode-agent/cli

Qode — Autonomous Coding Agent CLI. The terminal-based AI coding agent for long-running tasks and massive codebase development.

**Version:** 0.3.5

## Install

```bash
npm install -g @qode-agent/cli
```

Requires Node.js >= 22.19.0.

## Usage

```bash
# Interactive mode (opens TUI)
q-cli

# Shorthand (if using qode-agent umbrella package)
q

# One-shot prompt
q-cli -p "Add error handling to src/routes/users.ts"

# SSH remote execution
q-cli ssh connect <host>

# Resume a remote session
q-cli ssh resume <host> --session <id>
```

## License

MIT
