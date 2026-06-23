# @qode-agent/q-remote

Qode — Headless remote agent daemon for cloud execution. Installed on remote servers to enable QSSH (Qode SSH) remote execution sessions.

**Version:** 0.3.5

## Install

```bash
npm install -g @qode-agent/q-remote
```

Requires Node.js >= 22.19.0.

## Usage

```bash
# Start the headless daemon (nohup-safe)
q-remote daemon --workspace <dir> --session <id> --creds <path> --passphrase <p>

# One-shot: run a single prompt and exit
q-remote run --workspace <dir> --session <id> --creds <path> --passphrase <p> --prompt <text>

# Check daemon status
q-remote status --workspace <dir>

# Print version
q-remote version
```

## License

MIT
