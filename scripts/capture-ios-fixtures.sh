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
  local path="$1" out="$2" tmp
  # Capture into a temp file and move it into place only on success: a
  # failed fetch used to leave an EMPTY fixture behind (the redirect ran
  # before curl failed), and several decoding tests are now enabled by
  # the file's mere existence — so an empty leftover would be a broken
  # fixture one `git add` away. This also keeps the previous good
  # capture when a route is transiently unavailable (offline machine).
  tmp=$(mktemp)
  if curl -sf "$SERVER_URL$path" -H "Authorization: Bearer $TOKEN" \
      | jq "$SANITIZE" > "$tmp"; then
    mv "$tmp" "$OUT_DIR/$out"
    echo "  ✓ $out  ($path)"
  else
    rm -f "$tmp"
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
fetch "/machines" "machines.json"
fetch "/projects" "projects.json"
fetch "/me/usage" "me-usage.json"
fetch "/me/quota" "me-quota.json"
fetch "/me/extensions" "me-extensions.json"
# ⌘K content search. Any two-letter word will do — the fixture tests the
# envelope, not the hits (an empty `hits` array decodes fine too).
fetch "/search/sessions?q=the&limit=5" "search-sessions.json"

# Session detail: --session wins; otherwise the most recently updated
# session. Includes commands + chunks — the decode-critical fixture.
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID=$(curl -sf "$SERVER_URL/sessions" -H "Authorization: Bearer $TOKEN" \
    | jq -r 'sort_by(.updatedAt) | last | .id // empty')
fi
if [[ -n "$SESSION_ID" ]]; then
  fetch "/sessions/$SESSION_ID?tailCommands=5" "session-detail.json"
  # The Agent entity is retired: fs/git are PROJECT-addressed and the
  # model catalog is keyed (machineId, cliType). Both come off the
  # session row — its projectId, and the project's machineId from the
  # /projects capture above. The sidecar answers fs/git live, so those
  # two are skipped (not failed) when the machine is offline.
  PROJECT_ID=$(jq -r '.session.projectId // empty' "$OUT_DIR/session-detail.json")
  CLI_TYPE=$(jq -r '.session.cliType // empty' "$OUT_DIR/session-detail.json")
  if [[ -n "$PROJECT_ID" ]]; then
    fetch "/projects/$PROJECT_ID/git/log?limit=5" "git-log.json"
    fetch "/projects/$PROJECT_ID/fs/list?depth=1" "fs-list.json"
    MACHINE_ID=""
    if [[ -f "$OUT_DIR/projects.json" ]]; then
      MACHINE_ID=$(jq -r --arg id "$PROJECT_ID" \
        '[.[] | select(.id == $id) | .machineId][0] // empty' "$OUT_DIR/projects.json")
    fi
    if [[ -n "$MACHINE_ID" && -n "$CLI_TYPE" ]]; then
      fetch "/machines/$MACHINE_ID/models?cliType=$CLI_TYPE" "model-catalog.json"
    else
      echo "  ! could not resolve the machine or cliType for project $PROJECT_ID — model-catalog not captured" >&2
    fi
  else
    echo "  ! session $SESSION_ID is workdir-less (no project) — git-log/fs-list/model-catalog not captured; pass --session <id> with a project-pinned session" >&2
  fi
else
  echo "  ! no sessions on this server — session-detail/model-catalog/git-log/fs-list not captured" >&2
fi

echo "done. Review the diff before committing — fixtures may embed real prompt text."
