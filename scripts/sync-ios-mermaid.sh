#!/usr/bin/env bash
# Re-vendor the mermaid runtime the iOS app bundles for ```mermaid answer
# blocks (apps/ios/Argus/Resources/mermaid.min.js) from the version the
# web app resolves, so both clients draw diagrams with the same release.
#
# The web app gets mermaid through pnpm; the iOS app can't, so its copy
# is a checked-in file. Run this after bumping mermaid in apps/web and
# commit the result — MermaidLockstepTests (ArgusKit) fails iOS CI when
# the vendored bundle's version stops matching pnpm-lock.yaml.
#
#   pnpm install && scripts/sync-ios-mermaid.sh
set -euo pipefail

cd "$(dirname "$0")/.."

dest="apps/ios/Argus/Resources"
bundle="$(cd apps/web && node -p "require.resolve('mermaid/dist/mermaid.min.js')")"
license="$(dirname "$bundle")/../LICENSE"

cp "$bundle" "$dest/mermaid.min.js"
cp "$license" "$dest/mermaid.LICENSE"

version="$(grep -o 'version:"[0-9][0-9.]*"' "$dest/mermaid.min.js" | head -n1 | cut -d'"' -f2)"
echo "vendored mermaid ${version:-unknown} → $dest/mermaid.min.js ($(wc -c < "$dest/mermaid.min.js") bytes)"
