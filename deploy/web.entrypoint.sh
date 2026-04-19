#!/bin/sh
# Render runtime config for the SPA from container env vars before
# nginx starts. The published image's `index.html` loads `/config.js`
# *before* the React bundle, so by the time `host.ts` runs the
# `window.__ARGUS_CONFIG__` global already reflects what we set here.
#
# Empty values are valid — they make `host.ts` fall through to its
# build-time `VITE_*` value (if any), then to its runtime hostname-
# derivation fallback (`<window.location.hostname>:4000`).
#
# We deliberately avoid `envsubst` so we don't need an extra package
# layer; a here-doc with shell parameter expansion is enough.
#
# Hooked into nginx:alpine's stock entrypoint via
# `/docker-entrypoint.d/40-argus-runtime-config.sh` — that directory's
# scripts are sourced before nginx execs, see:
# https://github.com/nginxinc/docker-nginx/blob/master/entrypoint/docker-entrypoint.sh

set -eu

WEB_ROOT="${ARGUS_WEB_ROOT:-/usr/share/nginx/html}"
TARGET="${WEB_ROOT}/config.js"

API_URL="${ARGUS_API_URL:-}"
# Default WS_URL to API_URL — they're the same host in 99% of
# deployments. Override only if your reverse proxy splits HTTP and WS.
WS_URL="${ARGUS_WS_URL:-$API_URL}"

cat > "$TARGET" <<EOF
window.__ARGUS_CONFIG__ = { apiUrl: "$API_URL", wsUrl: "$WS_URL" };
EOF

echo "argus: wrote $TARGET (apiUrl=\"$API_URL\" wsUrl=\"$WS_URL\")"
