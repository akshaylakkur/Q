#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  publish-qssh.sh — Prepare and publish the QSSH npm release.
#
#  This script builds everything and stages the publish commands.
#  It does NOT actually publish — it prints the exact commands for you
#  to run manually.
#
#  Publish order (dependency chain):
#    1. @qode-agent/protocol  — shared wire protocol types (no deps)
#    2. @qode-agent/qprovs    — LLM provider abstraction (no @qode-agent deps)
#    3. @qode-agent/qmain     — main process interface (no @qode-agent deps)
#    4. @qode-agent/telemetry — telemetry (no @qode-agent deps)
#    5. @qode-agent/oauth     — OAuth 2.0 support (no @qode-agent deps)
#    6. @qode-agent/agent-core — core agent engine (depends on qprovs, qmain, telemetry)
#    7. @qode-agent/runtime   — app-level runtime (depends on agent-core, qprovs, qmain, telemetry, oauth)
#    8. @qode-agent/cli       — CLI (depends on runtime, protocol, agent-core, qprovs, qmain)
#    9. @qode-agent/q-remote  — headless remote daemon (depends on runtime, agent-core, qprovs, qmain, protocol)
#   10. qode-agent            — umbrella package (depends on @qode-agent/cli)
#
#  IMPORTANT: All packages must be published with the SAME version number.
#  The current version is read from packages/q-remote/package.json.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Read the current version from q-remote (all packages should match)
VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('packages/q-remote/package.json','utf-8')).version)")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  QSSH npm Release v${VERSION} — Build & Publish Prep"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Build everything ──────────────────────────────────────────────
echo "[1/4] Building all packages..."
pnpm build:all
echo "  ✓ Build complete"
echo ""

# ── Step 2: Verify dist files exist ───────────────────────────────────────
echo "[2/4] Verifying dist files..."
for pkg in packages/protocol packages/qprovs packages/qmain packages/telemetry packages/oauth packages/agent-core packages/runtime apps/q-cli packages/q-remote; do
  if [ -d "$pkg/dist" ] && [ "$(ls -A "$pkg/dist" 2>/dev/null)" ]; then
    echo "  ✓ $pkg/dist/ has files"
  else
    echo "  ✗ $pkg/dist/ is empty or missing — build failed"
    exit 1
  fi
done
echo ""

# ── Step 3: Verify all versions match ─────────────────────────────────────
echo "[3/4] Verifying all package versions match ${VERSION}..."
MISMATCH=0
for pkg in packages/protocol packages/qprovs packages/qmain packages/telemetry packages/oauth packages/agent-core packages/runtime apps/q-cli packages/q-remote packages/node-sdk npm/qode; do
  PKG_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$pkg/package.json','utf-8')).version)")
  if [ "$PKG_VER" != "$VERSION" ]; then
    echo "  ✗ $pkg version $PKG_VER does not match $VERSION"
    MISMATCH=1
  fi
done
if [ "$MISMATCH" -eq 1 ]; then
  echo ""
  echo "  Version mismatch detected. Fix before publishing."
  exit 1
fi
echo "  ✓ All packages at v${VERSION}"
echo ""

# ── Step 4: Print publish commands ───────────────────────────────────────
echo "[4/4] Publish commands (run these manually in order):"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PUBLISH COMMANDS (v${VERSION})"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cat <<PUBLISH

  # ── 1. Publish @qode-agent/protocol (no deps) ──
  cd $ROOT/packages/protocol
  npm publish --access public

  # ── 2. Publish @qode-agent/qprovs (no @qode-agent deps) ──
  cd $ROOT/packages/qprovs
  npm publish --access public

  # ── 3. Publish @qode-agent/qmain (no @qode-agent deps) ──
  cd $ROOT/packages/qmain
  npm publish --access public

  # ── 4. Publish @qode-agent/telemetry (no @qode-agent deps) ──
  cd $ROOT/packages/telemetry
  npm publish --access public

  # ── 5. Publish @qode-agent/oauth (no @qode-agent deps) ──
  cd $ROOT/packages/oauth
  npm publish --access public

  # ── 6. Publish @qode-agent/agent-core ──
  #     Depends on: qprovs@${VERSION}, qmain@${VERSION}, telemetry@${VERSION}
  cd $ROOT/packages/agent-core
  npm publish --access public

  # ── 7. Publish @qode-agent/runtime ──
  #     Depends on: agent-core@${VERSION}, qprovs@${VERSION}, qmain@${VERSION},
  #                 telemetry@${VERSION}, oauth@${VERSION}
  cd $ROOT/packages/runtime
  npm publish --access public

  # ── 8. Publish @qode-agent/cli ──
  #     Depends on: runtime@${VERSION}, protocol@${VERSION},
  #                 agent-core@${VERSION}, qprovs@${VERSION}, qmain@${VERSION}
  cd $ROOT/apps/q-cli
  npm publish --access public

  # ── 9. Publish @qode-agent/q-remote ──
  #     Depends on: runtime@${VERSION}, agent-core@${VERSION},
  #                 qprovs@${VERSION}, qmain@${VERSION}, protocol@${VERSION}
  cd $ROOT/packages/q-remote
  npm publish --access public

  # ── 10. Publish qode-agent umbrella ──
  #      Depends on: @qode-agent/cli@${VERSION}
  cd $ROOT/npm/qode
  npm publish --access public

PUBLISH

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  After publishing, tag and push:"
echo ""
echo "    git tag v${VERSION}"
echo "    git push origin main --tags"
echo ""
echo "  Verify with: npm view qode-agent"
echo "  Then install: npm install -g qode-agent"
echo "  And run: q --version"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"