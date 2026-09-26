#!/bin/sh
# Herdr may start this without Bun's bin directory on PATH.
bun="$(command -v bun || echo "${BUN_INSTALL:-$HOME/.bun}/bin/bun")"
exec "$bun" "$(dirname "$0")/../src/main.ts" welcome
