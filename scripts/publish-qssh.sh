#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  publish-qssh.sh — Prepare and publish the QSSH npm release.
#
#  This script builds everything and stages the publish commands.
#  It does NOT actually publish — it prints the exact commands for you
#  to run manually.
#
#  Publish order (dependency chain):
#    1. @qode-agent/protocol  (NEW)     — shared wire protocol types
#    2. @qode-agent/runtime   (NEW)     — extracted runtime core
#    3. @qode-agent/cli       (0.1.0→0.2.0) — CLI with QSSH + runtime + protocol deps
#    4. @qode-agent/q-remote  (NEW)     — headless remote daemon
#    5. qode-agent            (0.1.3→0.2.0) — umbrella package
#
#  Publish chain at npm install time:
#    npm install -g qode-agent
#      → qode-agent@0.2.0
#        → @qode-agent/cli@0.2.0
#          → @qode-agent/runtime@0.1.0
#            → @qode-agent/agent-core@0.1.0  (already published)
#            → @qode-agent/qprovs@0.1.0       (already published)
#            → @qode-agent/qmain@0.1.0        (already published)
#            → @qode-agent/telemetry@0.1.0    (already published)
#            → @qode-agent/oauth@0.1.0        (already published)
#          → @qode-agent/protocol@0.1.0
#          → @qode-agent/agent-core@0.1.0
#          → @qode-agent/qprovs@0.1.0
#          → @qode-agent/qmain@0.1.0
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  QSSH npm Release v0.2.0 — Build & Publish Prep"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Build everything ──────────────────────────────────────────────
echo "[1/5] Building all packages..."
pnpm build:all
echo "  ✓ Build complete"
echo ""

# ── Step 2: Verify dist files exist ───────────────────────────────────────
echo "[2/5] Verifying dist files..."
for pkg in packages/protocol packages/runtime apps/q-cli packages/q-remote; do
  if [ -d "$pkg/dist" ] && [ "$(ls -A "$pkg/dist" 2>/dev/null)" ]; then
    echo "  ✓ $pkg/dist/ has files"
  else
    echo "  ✗ $pkg/dist/ is empty or missing — build failed"
    exit 1
  fi
done
echo ""

# ── Step 3: Strip workspace:* deps for publish ────────────────────────────
echo "[3/5] Stripping workspace:* deps from package.json files..."
echo ""

# @qode-agent/protocol — no workspace deps, no changes needed
echo "  ✓ @qode-agent/protocol — no workspace deps"

# @qode-agent/runtime — its workspace:* deps (agent-core, qprovs, qmain,
#   telemetry, oauth) are all already published at 0.1.0
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('packages/runtime/package.json', 'utf-8'));
const deps = pkg.dependencies || {};
for (const [k, v] of Object.entries(deps)) {
  if (v === 'workspace:*') deps[k] = '0.1.0';
}
fs.writeFileSync('packages/runtime/package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('  ✓ @qode-agent/runtime — workspace:* replaced with 0.1.0');
"

# @qode-agent/cli@0.2.0 — runtime and protocol are NEW (0.1.0),
#   agent-core, qprovs, qmain are already published (0.1.0)
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('apps/q-cli/package.json', 'utf-8'));
const deps = pkg.dependencies || {};
for (const [k, v] of Object.entries(deps)) {
  if (v === 'workspace:*') deps[k] = '0.1.0';
}
fs.writeFileSync('apps/q-cli/package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('  ✓ @qode-agent/cli — workspace:* replaced with 0.1.0');
"

# @qode-agent/q-remote — all workspace deps are either already published
#   or being published as 0.1.0 in this release
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('packages/q-remote/package.json', 'utf-8'));
const deps = pkg.dependencies || {};
for (const [k, v] of Object.entries(deps)) {
  if (v === 'workspace:*') deps[k] = '0.1.0';
}
fs.writeFileSync('packages/q-remote/package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('  ✓ @qode-agent/q-remote — workspace:* replaced with 0.1.0');
"

echo ""

# ── Step 4: Print publish commands ───────────────────────────────────────
echo "[4/5] Publish commands (run these manually in order):"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PUBLISH COMMANDS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cat <<PUBLISH

  # ── 1. Publish @qode-agent/protocol (FIRST TIME) ──
  cd $ROOT/packages/protocol
  npm publish --access public

  # ── 2. Publish @qode-agent/runtime (FIRST TIME) ──
  #     Depends on: agent-core@0.1.0, qprovs@0.1.0, qmain@0.1.0,
  #                 telemetry@0.1.0, oauth@0.1.0
  cd $ROOT/packages/runtime
  npm publish --access public

  # ── 3. Publish @qode-agent/cli (UPDATE 0.2.0) ──
  #     Depends on: runtime@0.1.0, protocol@0.1.0,
  #                 agent-core@0.1.0, qprovs@0.1.0, qmain@0.1.0
  cd $ROOT/apps/q-cli
  npm publish --access public

  # ── 4. Publish @qode-agent/q-remote (FIRST TIME) ──
  #     Depends on: runtime@0.1.0, protocol@0.1.0,
  #                 agent-core@0.1.0, qprovs@0.1.0, qmain@0.1.0
  cd $ROOT/packages/q-remote
  npm publish --access public

  # ── 5. Publish qode-agent umbrella (UPDATE 0.2.0) ──
  #     Depends on: @qode-agent/cli@0.2.0
  cd $ROOT/npm/qode
  npm publish --access public

PUBLISH

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 5: Restore workspace:* deps ──────────────────────────────────────
echo "[5/5] Restoring workspace:* deps..."
git checkout -- packages/runtime/package.json apps/q-cli/package.json packages/q-remote/package.json
echo "  ✓ package.json files restored to workspace:*"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  All set. After publishing, tag and push:"
echo ""
echo "    git tag v0.2.0"
echo "    git push origin main --tags"
echo ""
echo "  Verify with: npm view qode-agent"
echo "  Then install: npm install -g qode-agent"
echo "  And run: q --version"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"