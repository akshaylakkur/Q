#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  build-q-remote.sh — Build q-remote and pack a tarball for upload to
#  the remote EC2 / custom server during testing (before npm publish).
#
#  Strips workspace:* dependencies from package.json before packing since
#  all workspace packages are bundled into the dist files by tsdown.
#
#  Produces: dist-packs/qode-agent-q-remote-<version>.tgz
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/packages/q-remote"

echo "[q-remote] Building package..."
pnpm --filter @qode-agent/q-remote build

mkdir -p "$ROOT/dist-packs"

echo "[q-remote] Stripping workspace deps from package.json..."
# Backup original, strip workspace:* deps, pack, then restore
cp "$PKG_DIR/package.json" "$PKG_DIR/package.json.bak"
node -e "
const pkg = require('$PKG_DIR/package.json');
// Remove workspace:* deps — they're all bundled into dist/
const workspaceDeps = Object.keys(pkg.dependencies || {}).filter(
  k => pkg.dependencies[k] === 'workspace:*'
);
for (const k of workspaceDeps) delete pkg.dependencies[k];
// Also remove devDependencies — not needed at runtime
delete pkg.devDependencies;
require('fs').writeFileSync('$PKG_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "[q-remote] Packing tarball..."
(cd "$PKG_DIR" && npm pack --pack-destination "$ROOT/dist-packs")

# Restore original package.json
mv "$PKG_DIR/package.json.bak" "$PKG_DIR/package.json"

TARBALL=$(ls "$ROOT/dist-packs"/qode-agent-q-remote-*.tgz 2>/dev/null | head -1)
if [ -z "$TARBALL" ]; then
  echo "[q-remote] ERROR: tarball not found after pack"
  exit 1
fi

echo "[q-remote] Tarball ready: $TARBALL"
echo "[q-remote] Done."
