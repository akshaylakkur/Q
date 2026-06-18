#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  link-aliases.sh — Create @q/ package aliases in node_modules
#
#  The source code imports from @q/agent-core, @q/qprovs, etc., but the
#  actual npm packages are scoped under @qode-agent/ for publishing.
#  This script creates symlinks so @q/* resolves to @qode-agent/*.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NM="$ROOT/node_modules"

mkdir -p "$NM/@q"

# Each entry: alias=target  (e.g. agent-core=agent-core means @q/agent-core → @qode-agent/agent-core)
LINKS="agent-core=agent-core qprovs=qprovs qmain=qmain telemetry=telemetry runtime=runtime protocol=protocol"

for entry in $LINKS; do
  alias="${entry%=*}"
  target="${entry#*=}"
  link="$NM/@q/$alias"
  dest="$NM/@qode-agent/$target"

  if [ -L "$link" ] && [ "$(readlink "$link")" = "$dest" ]; then
    echo "  ✓ $link already points to $dest"
    continue
  fi

  if [ -e "$link" ] || [ -L "$link" ]; then
    echo "  ! $link exists but is not our symlink — skipping"
    continue
  fi

  if [ ! -e "$dest" ]; then
    echo "  ✗ $dest does not exist — skipping $alias"
    continue
  fi

  ln -s "$dest" "$link"
  echo "  ✓ Created $link → $dest"
done

echo "Done."
