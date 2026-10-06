#!/bin/sh
# JSON travels on stdin. No user text is interpreted as shell source.
bun="$(command -v bun || echo "${BUN_INSTALL:-$HOME/.bun}/bin/bun")"
exec "$bun" "$(dirname "$0")/../src/terminal/native-input.ts" "$@"
