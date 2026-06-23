#!/usr/bin/env bash
#
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  install.sh — Build Q and install the q-cli command globally
#
#  Usage:
#    bash install.sh                   # install from current directory
#    bash install.sh /path/to/source   # install from specified path
#
#  What it does:
#    1. Checks prerequisites (node ≥22.19.0, pnpm ≥10.33.0)
#    2. Installs dependencies and builds the full project
#    3. Creates ~/.Q/ with config templates and all required subdirectories
#    4. Installs the q-cli wrapper to ~/.Q/bin/
#    5. Adds ~/.Q/bin/ to your PATH via shell rc file
#    6. On first run of q-cli, guides you through LLM provider setup
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { printf "${CYAN}%s${NC}\n" "$*"; }
ok()      { printf "${GREEN}✓ %s${NC}\n" "$*"; }
warn()    { printf "${YELLOW}⚠ %s${NC}\n" "$*"; }
error()   { printf "${RED}✗ %s${NC}\n" "$*"; }
header()  { printf "\n${BOLD}%s${NC}\n" "$*"; }
step()    { printf "\n${BOLD}[%s]${NC} %s\n" "$1" "$2"; }

# ── Configuration ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${1:-$SCRIPT_DIR}"
Q_HOME="${HOME}/.Q"
BIN_DIR="${Q_HOME}/bin"
BUILD_DIR="${Q_HOME}/build"
Q_BIN="${BIN_DIR}/q-cli"

NODE_MIN="22.19.0"
PNPM_MIN="10.33.0"

# ── Version comparison (semver-aware) ───────────────────────────────────────
version_ge() {
  [ "$(printf '%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

# ── Cleanup handler ─────────────────────────────────────────────────────────
cleanup() {
  local ec=$?
  if [ $ec -ne 0 ] && [ $ec -ne 130 ]; then
    echo ""
    error "Installation failed (exit code $ec). See errors above."
    echo ""
  fi
  trap - EXIT INT TERM
}
trap cleanup EXIT INT TERM

# ── Header ──────────────────────────────────────────────────────────────────
clear
cat << 'ART'
    ____
  / __  |
 | |  | |
| |  |_ |
| |   __|
 \ \_/ /
  \___/

    Q — v0.3.5
ART
header "Q — Autonomous Coding Agent  v0.3.5"
echo ""
info "Project root: ${PROJECT_DIR}"
info "Install target: ${Q_HOME}"
echo ""

# ── 1. Check prerequisites ──────────────────────────────────────────────────
step "1/6" "Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Install Node.js ≥${NODE_MIN} first."
  info "  Recommended: nvm install ${NODE_MIN}"
  info "  Or download from: https://nodejs.org/"
  exit 1
fi

NODE_VER="$(node -v | sed 's/^v//')"
if ! version_ge "$NODE_VER" "$NODE_MIN"; then
  error "Node.js ${NODE_VER} is too old. Need ≥${NODE_MIN}."
  info "  Upgrade with: nvm install ${NODE_MIN}"
  exit 1
fi
ok "Node.js ${NODE_VER}"

# pnpm
if ! command -v pnpm &>/dev/null; then
  warn "pnpm not found — installing via corepack..."
  if command -v corepack &>/dev/null; then
    corepack enable
    corepack prepare pnpm@10.33.0 --activate
  else
    warn "corepack not available. Installing pnpm via npm..."
    npm install -g pnpm@10.33.0
  fi
  if ! command -v pnpm &>/dev/null; then
    error "Could not install pnpm. Install it manually: npm install -g pnpm@${PNPM_MIN}"
    exit 1
  fi
fi

PNPM_VER="$(pnpm -v)"
if ! version_ge "$PNPM_VER" "$PNPM_MIN"; then
  warn "pnpm ${PNPM_VER} is old. Upgrading..."
  npm install -g "pnpm@${PNPM_MIN}"
  PNPM_VER="$(pnpm -v)"
fi
ok "pnpm ${PNPM_VER}"

# Git (needed for pnpm workspace)
if ! command -v git &>/dev/null; then
  warn "git not found — some operations may fail."
fi

# ── 2. Build the project ────────────────────────────────────────────────────
step "2/6" "Installing dependencies and building..."

cd "$PROJECT_DIR"

if [ ! -f "pnpm-workspace.yaml" ]; then
  error "No pnpm-workspace.yaml found in ${PROJECT_DIR}."
  info "  Is this the correct project directory?"
  exit 1
fi

info "  Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installed"

info "  Building packages..."
pnpm build:packages
ok "Packages built"

info "  Building CLI..."
pnpm build
ok "CLI built"

# Verify the binary exists
if [ ! -f "${PROJECT_DIR}/apps/q-cli/dist/main.mjs" ]; then
  error "Build did not produce dist/main.mjs. Check for build errors above."
  exit 1
fi
ok "Binary verified at apps/q-cli/dist/main.mjs"

# ── 3. Create ~/.Q/ directory structure ────────────────────────────────────
step "3/6" "Setting up ~/.Q/ directory structure..."

mkdir -p "${Q_HOME}"

# ~/.Q/build/ holds a lightweight reference to the built project.
# Since tsdown leaves npm packages as bare ESM imports, we symlink the
# project's node_modules so they resolve at runtime. The bundle and
# YAML profiles are copied so the profile loader walk-up finds them.
info "  Setting up build reference in ${BUILD_DIR}..."
rm -rf "${BUILD_DIR}" 2>/dev/null
mkdir -p "${BUILD_DIR}"

# ── Bundle & profiles ──────────────────────────────────────────────────
mkdir -p "${BUILD_DIR}/apps/q-cli/dist"
cp -R "${PROJECT_DIR}/apps/q-cli/dist/" "${BUILD_DIR}/apps/q-cli/dist/"

# Agent core YAML profiles — the profile loader walks up from
# import.meta.url looking for a profiles/ dir with auto.yaml.
# Place them alongside dist/ so the walk-up finds them at i=0.
if [ -d "${PROJECT_DIR}/packages/agent-core/dist/profiles" ]; then
  mkdir -p "${BUILD_DIR}/apps/q-cli/dist/profiles"
  cp "${PROJECT_DIR}/packages/agent-core/dist/profiles/"*.yaml "${BUILD_DIR}/apps/q-cli/dist/profiles/"
fi

# ── node_modules (symlink) ─────────────────────────────────────────────
# The bundled main.mjs imports packages like commander, chalk, zod as
# bare ESM specifiers. Node resolves these by walking up from the script
# looking for node_modules/. We provide it via a symlink.
ln -sfn "${PROJECT_DIR}/node_modules" "${BUILD_DIR}/node_modules"
ok "Build reference ready at ${BUILD_DIR}"

# Create required subdirectories
info "  Creating runtime directories..."
mkdir -p "${Q_HOME}/bin"
mkdir -p "${Q_HOME}/memory/episodes"
mkdir -p "${Q_HOME}/memory/decisions"
mkdir -p "${Q_HOME}/memory/facts"
mkdir -p "${Q_HOME}/memory/index"
mkdir -p "${Q_HOME}/memory/archive/facts"
mkdir -p "${Q_HOME}/memory/archive/decisions"
mkdir -p "${Q_HOME}/memory/cold/episodes"
mkdir -p "${Q_HOME}/sessions"
mkdir -p "${Q_HOME}/plugins"
mkdir -p "${Q_HOME}/credentials/mcp"
mkdir -p "${Q_HOME}/skills"

# Create sessions index if not present
if [ ! -f "${Q_HOME}/sessions/index.json" ]; then
  echo "{}" > "${Q_HOME}/sessions/index.json"
fi

ok "Runtime directories created"

# ── 4. Copy default config templates ────────────────────────────────────────
step "4/6" "Setting up default configuration..."

# User-global config template (only if none exists)
if [ ! -f "${Q_HOME}/config.toml" ]; then
  cat > "${Q_HOME}/config.toml" << 'TOML'
# Q — User-Global Configuration
# ==================================
# This file is stored in ~/.Q/config.toml and applies to all projects.
# Project-level .q/config.toml overrides these settings.

[providers]
  # Add your LLM provider configuration here.
  # Run 'q-cli' for the interactive setup wizard, or uncomment and edit:
  #
  # [providers.anthropic]
  # type = "anthropic"
  # apiKey = "sk-ant-..."
  # defaultModel = "claude-sonnet-4-20250514"

[models]
  # [models.default]
  # provider = "anthropic"
  # name = "claude-sonnet-4-20250514"
  # maxContextSize = 200000
  # maxOutputSize = 8192

[orchestrator]
  # maxParallelAgents = 8
  # defaultMode = "auto"
  # convergenceTimeout = 60000
  # taskTimeout = 300000

[memory]
  # episodicRecallMaxCount = 500
  # ltpmEnabled = true
  # compactionTriggerRatio = 0.75

[display]
  # animations = true
  # linkPreview = true
  # imagePreview = true

[telemetry]
  # enabled = false

[thinking]
  # mode = "auto"
  # effort = 50
TOML
  chmod 600 "${Q_HOME}/config.toml"
  ok "Default config.toml created"
else
  info "  config.toml already exists — keeping yours"
fi

# User-global MCP config
if [ ! -f "${Q_HOME}/mcp.json" ]; then
  echo '{"mcpServers":{}}' > "${Q_HOME}/mcp.json"
  ok "Default mcp.json created"
else
  info "  mcp.json already exists — keeping yours"
fi

ok "Configuration templates ready"

# ── 5. Install q-cli wrapper ────────────────────────────────────────────────
step "5/6" "Installing q-cli command..."

cat > "${Q_BIN}" << 'WRAPPER'
#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  q-cli — Q Autonomous Coding Agent
#
#  Automatically scopes to the current working directory.
#  Run from any directory to start an agent session in that context.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$(cd "${SCRIPT_DIR}/../build" && pwd)"
MAIN_BINARY="${BUILD_DIR}/apps/q-cli/dist/main.mjs"

# Add the build dir node_modules to NODE_PATH so never-bundled deps resolve
export NODE_PATH="${BUILD_DIR}/node_modules:${NODE_PATH:-}"

# Environment hints for the agent
export Q_CLI_HOME="${BUILD_DIR}"

exec node "${MAIN_BINARY}" "$@"
WRAPPER

chmod +x "${Q_BIN}"
ok "q-cli installed to ${Q_BIN}"

# Also create a shorter 'q' alias command
Q_SHORTCUT="${BIN_DIR}/q"
ln -sfn "q-cli" "${Q_SHORTCUT}"
ok "'q' shorthand installed to ${Q_SHORTCUT}"

# Convenience symlink under project root for dev work
ln -sfn "${Q_BIN}" "${PROJECT_DIR}/q-cli" 2>/dev/null || true

# ── 6. Add ~/.Q/bin/ to PATH ──────────────────────────────────────────────
step "6/6" "Adding q-cli to your PATH..."

# Detect shell and write the appropriate rc file
RC_FILE=""
RC_LINE="export PATH=\"\${HOME}/.Q/bin:\${PATH}\""
MARKER="# Added by Q (q-cli) install"

# macOS default shell is zsh; Linux default varies
if [ -n "${ZSH_VERSION:-}" ]; then
  # The running shell is zsh
  if [ -f "${HOME}/.zshenv" ]; then
    RC_FILE="${HOME}/.zshenv"
  else
    RC_FILE="${HOME}/.zshrc"
  fi
elif [ -n "${BASH_VERSION:-}" ] && [[ "$(uname)" != "Darwin" ]]; then
  # Linux with bash
  if [ -f "${HOME}/.bashrc" ]; then
    RC_FILE="${HOME}/.bashrc"
  elif [ -f "${HOME}/.bash_profile" ]; then
    RC_FILE="${HOME}/.bash_profile"
  else
    RC_FILE="${HOME}/.profile"
  fi
else
  # Fallback: check what files exist
  for rc in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.profile"; do
    if [ -f "$rc" ]; then
      RC_FILE="$rc"
      break
    fi
  done
  [ -z "${RC_FILE}" ] && RC_FILE="${HOME}/.profile"
fi

# Check if the line is already in the rc file
if grep -qF "${RC_LINE}" "${RC_FILE}" 2>/dev/null; then
  info "  PATH entry already present in ${RC_FILE/$HOME/~}"
else
  {
    echo ""
    echo "${MARKER}"
    echo "${RC_LINE}"
  } >> "${RC_FILE}"
  ok "Added ~/.Q/bin to PATH in ${RC_FILE/$HOME/~}"
fi

# Also try to source it for the current session
export PATH="${HOME}/.Q/bin:${PATH}"
ok "q-cli is now available in this session"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
header "  ✓ Installation complete!"
echo ""
ok "  q-cli installed at:  ${Q_BIN}"
ok "  q shorthand at:      ${Q_SHORTCUT}"

if [ "${RC_FILE}" != "" ]; then
  ok "  Added to PATH in:       ${RC_FILE/$HOME/~}"
fi

echo ""
info "  ┌─────────────────────────────────────────────────────────────────┐"
info "  │  Next steps:                                                    │"
info "  │                                                                 │"
info "  │  1. Open a new terminal (or run 'source ${RC_FILE/$HOME/~}')         │"
info "  │  2. Run 'q-cli' (or just 'q') from any project directory         │"
info "  │  3. The setup wizard will guide you through:                    │"
info "  │     - Choosing an LLM provider (Anthropic, OpenAI, etc.)        │"
info "  │     - Entering your API key                                     │"
info "  │     - Selecting a model                                         │"
info "  │  4. After setup, q-cli scopes to whichever directory you run    │"
info "  │     it from — it's your autonomous coding agent in that context.│"
info "  │                                                                 │"
info "  │  Quick start:                                                   │"
info "  │    $ cd ~/my-project                                            │"
info "  │    $ q                                                          │"
info "  │    q> /help                                                     │"
info "  │                                                                 │"
info "  │  Scoping to a different directory:                              │"
info "  │    $ q --cwd /some/other/project                                │"
info "  │                                                                 │"
info "  │  Environment variables (skip wizard):                           │"
info "  │    export Q_PROVIDER=anthropic                                  │"
info "  │    export Q_MODEL=claude-sonnet-4-20250514                      │"
info "  │    export Q_API_KEY=sk-ant-...                                  │"
info "  └─────────────────────────────────────────────────────────────────┘"
echo ""

# Verify q-cli works
if command -v q-cli &>/dev/null; then
  ok "q-cli is ready to use. Try:  q --help"
else
  warn "Run 'source ${RC_FILE/$HOME/~}' or open a new terminal, then try: q --help"
fi

# Verify the binary actually runs
if "${Q_BIN}" --version &>/dev/null; then
  ok "Binary executes correctly"
else
  warn "Binary installed but couldn't execute — check ${Q_BIN}"
fi

echo ""