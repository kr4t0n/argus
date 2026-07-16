#!/usr/bin/env bash
# Capture REST-response fixtures from a LIVE Argus server for the Swift
# client's decoding tests (apps/ios/ArgusKit/Tests/ArgusKitTests/Fixtures).
#
# This is the iOS client's contract-confidence mechanism: instead of
# OpenAPI codegen, the hand-written Swift models are exercised in CI
# against real server responses captured here. Re-run whenever
# packages/shared-types DTOs change shape, then commit the diff.
#
#   SERVER_URL=http://localhost:4000 \
#   ARGUS_EMAIL=admin@argus.local ARGUS_PASSWORD=... \
#   scripts/capture-ios-fixtures.sh [--session <id>]
#
# Credentials fall back to ADMIN_EMAIL / ADMIN_PASSWORD from a repo-root
# .env if present. Fixtures are SANITIZED before writing:
#   - the login JWT is redacted,
#   - attachment ?t= tokens are redacted,
#   - long strings are truncated (fixtures test decoding, not content).
# Fixtures still contain real session/prompt text — pass --session to pick
# a non-sensitive session and REVIEW THE DIFF before committing (the repo
# is public).
set -euo pipefail

cd "$(dirname "$0")/.."

SERVER_URL="${SERVER_URL:-http://localhost:4000}"
SESSION_ID=""
if [[ "${1:-}" == "--session" ]]; then
  SESSION_ID="${2:?--session needs an id}"
fi

if [[ -z "${ARGUS_EMAIL:-}" || -z "${ARGUS_PASSWORD:-}" ]]; then
  if [[ -f .env ]]; then
    ARGUS_EMAIL="${ARGUS_EMAIL:-$(grep -E '^ADMIN_EMAIL=' .env | head -1 | cut -d= -f2-)}"
    ARGUS_PASSWORD="${ARGUS_PASSWORD:-$(grep -E '^ADMIN_PASSWORD=' .env | head -1 | cut -d= -f2-)}"
  fi
fi
if [[ -z "${ARGUS_EMAIL:-}" || -z "${ARGUS_PASSWORD:-}" ]]; then
  echo "error: set ARGUS_EMAIL / ARGUS_PASSWORD (or ADMIN_EMAIL / ADMIN_PASSWORD in .env)" >&2
  exit 1
fi

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

OUT_DIR="apps/ios/ArgusKit/Tests/ArgusKitTests/Fixtures"
mkdir -p "$OUT_DIR"

# Sanitizer: redact tokens, truncate long strings. `walk` needs jq >= 1.6.
SANITIZE='
  walk(
    if type == "string" then
      (if test("\\?t=") then sub("\\?t=.*$"; "?t=REDACTED") else . end)
      | (if length > 2000 then .[0:2000] + "…" else . end)
    else . end
  )
'

TOKEN=$(curl -sf -X POST "$SERVER_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ARGUS_EMAIL\",\"password\":\"$ARGUS_PASSWORD\"}" | jq -r .token)
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { echo "error: login failed" >&2; exit 1; }

fetch() { # fetch <path> <outfile>
  local path="$1" out="$2"
  if curl -sf "$SERVER_URL$path" -H "Authorization: Bearer $TOKEN" \
      | jq "$SANITIZE" > "$OUT_DIR/$out"; then
    echo "  ✓ $out  ($path)"
  else
    echo "  ✗ $out  ($path) — skipped" >&2
  fi
}

echo "capturing fixtures from $SERVER_URL → $OUT_DIR"

# login.json: re-login purely to capture the response SHAPE; token redacted.
curl -sf -X POST "$SERVER_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ARGUS_EMAIL\",\"password\":\"$ARGUS_PASSWORD\"}" \
  | jq '.token = "REDACTED"' > "$OUT_DIR/login.json"
echo "  ✓ login.json  (/auth/login, token redacted)"

fetch "/sessions" "sessions.json"
fetch "/agents" "agents.json"
fetch "/machines" "machines.json"
fetch "/projects" "projects.json"
fetch "/me/usage" "me-usage.json"
fetch "/me/quota" "me-quota.json"
fetch "/me/extensions" "me-extensions.json"

# Session detail: --session wins; otherwise the most recently updated
# session. Includes commands + chunks — the decode-critical fixture.
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID=$(curl -sf "$SERVER_URL/sessions" -H "Authorization: Bearer $TOKEN" \
    | jq -r 'sort_by(.updatedAt) | last | .id // empty')
fi
if [[ -n "$SESSION_ID" ]]; then
  fetch "/sessions/$SESSION_ID?tailCommands=5" "session-detail.json"
  AGENT_ID=$(jq -r '.session.agentId' "$OUT_DIR/session-detail.json")
  if [[ -n "$AGENT_ID" && "$AGENT_ID" != "null" ]]; then
    fetch "/agents/$AGENT_ID/models" "model-catalog.json"
    fetch "/agents/$AGENT_ID/git/log?limit=5" "git-log.json"
    fetch "/agents/$AGENT_ID/fs/list?depth=1" "fs-list.json"
  fi
else
  echo "  ! no sessions on this server — session-detail/model-catalog/git-log/fs-list not captured" >&2
fi

echo "done. Review the diff before committing — fixtures may embed real prompt text."
