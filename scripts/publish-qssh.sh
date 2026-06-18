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
#    3. @qode-agent/cli       (UPDATE)  — CLI with QSSH + runtime deps
#    4. @qode-agent/q-remote  (NEW)     — headless remote daemon
#    5. qode-agent            (UPDATE)  — umbrella package
#
#  Platform binaries (darwin-arm64, darwin-x64, win32-x64) unchanged.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  QSSH npm Release — Build & Publish Prep"
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

# For packages that are published to npm, we need to replace workspace:*
# with actual version numbers. The dist files bundle everything, but
# npm needs valid semver ranges in the published package.json.

# @qode-agent/protocol — no workspace deps, no changes needed
echo "  ✓ @qode-agent/protocol — no workspace deps"

# @qode-agent/runtime — replace workspace:* with published versions
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

# @qode-agent/cli — replace workspace:* with published versions
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

# @qode-agent/q-remote — replace workspace:* with published versions
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

echo "  # 1. Publish @qode-agent/protocol (NEW)"
echo "  cd $ROOT/packages/protocol"
echo "  npm publish --access public"
echo ""

echo "  # 2. Publish @qode-agent/runtime (NEW)"
echo "  cd $ROOT/packages/runtime"
echo "  npm publish --access public"
echo ""

echo "  # 3. Publish @qode-agent/cli (UPDATE)"
echo "  cd $ROOT/apps/q-cli"
echo "  npm publish --access public"
echo ""

echo "  # 4. Publish @qode-agent/q-remote (NEW)"
echo "  cd $ROOT/packages/q-remote"
echo "  npm publish --access public"
echo ""

echo "  # 5. Publish qode-agent umbrella (UPDATE)"
echo "  cd $ROOT/npm/qode"
echo "  npm publish --access public"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 5: Restore workspace:* deps ──────────────────────────────────────
echo "[5/5] Restoring workspace:* deps..."
git checkout -- packages/runtime/package.json apps/q-cli/package.json packages/q-remote/package.json
echo "  ✓ package.json files restored"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  All set. Run the publish commands above in order."
echo "  After publishing, tag the release:"
echo ""
echo "    git tag v0.2.0"
echo "    git push --tags"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
