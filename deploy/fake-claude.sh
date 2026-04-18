#!/usr/bin/env bash
# Stand-in for the real `claude` CLI used for smoke tests.
# Reads a prompt on stdin, emits stream-json events that look like the real
# CLI so the ClaudeCode adapter mapper can exercise its full path. The flow
# below intentionally exercises multiple tool calls and edits so the dashboard
# can demo its activity-pill, file-chip, and diff rendering.
#
# We *also* perform real disk writes between tool_use and tool_result emits.
# That lets the sidecar's snapshot-then-diff logic produce real unified diffs
# in the UI. Files are written *relative* to this script's CWD (== the
# sidecar's `workingDir`), so point the smoke sidecar at a sandbox dir.

set -e

SESSION_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) echo "fake-claude 0.0.1"; exit 0 ;;
    --resume)  SESSION_ID="$2"; shift 2 ;;
    --print|--verbose) shift ;;
    --output-format) shift 2 ;;
    --model) shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="sess-$(date +%s)-$$"
fi

PROMPT="$(cat || true)"

emit() { printf '%s\n' "$1"; sleep 0.18; }

# write_file <relpath> <content>
# Performs the on-disk side effect AFTER the matching tool_use has been
# emitted, so the sidecar's pre-snapshot captures the *old* state and the
# post-read sees the *new* one — yielding a real unified diff.
write_file() {
  local rel="$1" body="$2"
  mkdir -p "$(dirname "$rel")"
  printf '%s' "$body" > "$rel"
}

emit "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"$SESSION_ID\"}"
emit '{"type":"assistant","message":{"content":[{"type":"text","text":"On it. "}]}}'
emit '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me scan the project first."}]}}'

emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Glob","input":{"pattern":"app/api/auth/**/*.ts"}}]}}'
emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"(no matches)"}]}}'

emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"package.json"}}]}}'
emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"{ \"name\": \"demo\", \"dependencies\": { \"next\": \"15.0.0\" } }"}]}}'

emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"Write","input":{"file_path":"app/api/auth/route.ts","content":"// route handler\nexport async function GET() {\n  return new Response(\"ok\");\n}\n"}}]}}'
write_file "app/api/auth/route.ts" $'// route handler\nexport async function GET() {\n  return new Response("ok");\n}\n'
emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t3","content":"created app/api/auth/route.ts"}]}}'

emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t4","name":"Write","input":{"file_path":"app/api/auth/callback/route.ts","content":"// callback\nexport async function GET() { return new Response(\"cb\"); }\n"}}]}}'
write_file "app/api/auth/callback/route.ts" $'// callback\nexport async function GET() { return new Response("cb"); }\n'
emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t4","content":"created app/api/auth/callback/route.ts"}]}}'

# Seed middleware.ts the first time we run so the Edit below has something
# to modify (and produces a real before/after diff).
if [[ ! -f middleware.ts ]]; then
  write_file "middleware.ts" $'// middleware\nexport function middleware() {}\n'
fi
emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t5","name":"Edit","input":{"file_path":"middleware.ts","old_string":"// middleware","new_string":"// session middleware"}}]}}'
write_file "middleware.ts" $'// session middleware\nexport function middleware() {}\n'
emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t5","content":"applied edit to middleware.ts"}]}}'

emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t6","name":"Bash","input":{"command":"npx tsc --noEmit"}}]}}'
emit '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t6","content":"(no errors)"}]}}'

emit '{"type":"assistant","message":{"content":[{"type":"text","text":"I'\''ve set up the GitHub OAuth flow. Created the auth route handler, callback endpoint, and session middleware. Typecheck passes clean."}]}}'

emit '{"type":"result","result":"GitHub OAuth flow scaffolded.","is_error":false}'
