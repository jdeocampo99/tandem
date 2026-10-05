#!/bin/sh
# Tern starts this in the linked plugin directory. Arguments stay arguments.
bun="$(command -v bun || echo "${BUN_INSTALL:-$HOME/.bun}/bin/bun")"
exec "$bun" "$(dirname "$0")/../src/main.ts" "$@"
