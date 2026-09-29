#!/usr/bin/env bash
# Re-vendor the xterm.js runtime the Android app bundles for its terminal
# pane (apps/android/app/src/main/assets/xterm/) from the version the web
# app resolves, so both clients run the same terminal emulator release.
#
# The web app gets @xterm/xterm through pnpm; the Android app loads it
# from a WebView asset, so its copy is a checked-in file. Run this after
# bumping @xterm/* in apps/web and commit the result — XtermLockstepTest
# (:app unit test) fails Android CI when the VERSION stamp written here
# stops matching pnpm-lock.yaml. (The minified bundle carries no version
# literal, unlike mermaid, so the stamp is the pin.)
#
#   pnpm install && scripts/sync-android-xterm.sh
set -euo pipefail

cd "$(dirname "$0")/.."

dest="apps/android/app/src/main/assets/xterm"
xterm_dir="$(readlink -f apps/web/node_modules/@xterm/xterm)"
fit_dir="$(readlink -f apps/web/node_modules/@xterm/addon-fit)"

mkdir -p "$dest"
cp "$xterm_dir/lib/xterm.js" "$dest/xterm.js"
cp "$xterm_dir/css/xterm.css" "$dest/xterm.css"
cp "$xterm_dir/LICENSE" "$dest/xterm.LICENSE"
cp "$fit_dir/lib/addon-fit.js" "$dest/addon-fit.js"

version="$(node -p "JSON.parse(require('fs').readFileSync('$xterm_dir/package.json','utf8')).version")"
fit_version="$(node -p "JSON.parse(require('fs').readFileSync('$fit_dir/package.json','utf8')).version")"
printf '%s\n' "$version" > "$dest/VERSION"
echo "vendored @xterm/xterm $version + addon-fit $fit_version → $dest ($(wc -c < "$dest/xterm.js") bytes)"
