#!/usr/bin/env bash
# XcodeGen wrapper — use this instead of calling `xcodegen generate`
# directly. The spec includes `local.yml` (personal overrides: team id,
# push entitlement — see the header comment in project.yml), but
# XcodeGen has no optional-include support and hard-fails when the file
# is missing, so seed a no-op one first.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f local.yml ]; then
  printf '# Personal XcodeGen overrides (gitignored) — template in project.yml header.\n{}\n' > local.yml
fi

exec xcodegen generate "$@"
