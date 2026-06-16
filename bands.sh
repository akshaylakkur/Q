#!/usr/bin/env bash
#
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  bands.sh — Build All aNd Sync
#
#  Builds all packages and the q-cli app, then syncs the artifacts to
#  ~/.Q/build/ so the installed `q` command picks up the latest changes.
#
#  Usage:
#    bash bands.sh              # build + sync from current directory
#    bash bands.sh /path/to/q   # build + sync from specified source root
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
err()     { printf "${RED}✗ %s${NC}\n" "$*"; }

# ── Resolve project root ────────────────────────────────────────────────────
SRC="${1:-$(pwd)}"
cd "$SRC"

if [ ! -f package.json ] || ! grep -q '"q-cli-monorepo"' package.json 2>/dev/null; then
  err "Could not find Q monorepo root in: $SRC"
  echo "  Run from the repo root or pass the path:  bash bands.sh /path/to/q"
  exit 1
fi

info "━━━ Building all packages ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
pnpm build:packages
ok "Packages built"

info "━━━ Building q-cli app ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
pnpm --filter q-cli build
ok "q-cli built"

info "━━━ Syncing to ~/.Q/build/ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
mkdir -p ~/.Q/build/apps/q-cli/dist
cp apps/q-cli/dist/main.mjs ~/.Q/build/apps/q-cli/dist/main.mjs
cp apps/q-cli/dist/typescript-*.mjs ~/.Q/build/apps/q-cli/dist/ 2>/dev/null || true

if [ -d packages/agent-core/dist/profiles ]; then
  mkdir -p ~/.Q/build/apps/q-cli/dist/profiles
  cp packages/agent-core/dist/profiles/*.yaml ~/.Q/build/apps/q-cli/dist/profiles/ 2>/dev/null || true
fi

ok "Synced build to ~/.Q/build/"

echo
info "━━━ Done ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  main.mjs:  $(wc -c < ~/.Q/build/apps/q-cli/dist/main.mjs | tr -d ' ') bytes"
echo "  profiles:  $(ls ~/.Q/build/apps/q-cli/dist/profiles/*.yaml 2>/dev/null | wc -l | tr -d ' ') yaml files"
