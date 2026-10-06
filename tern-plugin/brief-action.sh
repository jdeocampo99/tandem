#!/bin/sh
# The displayed JSON arrives on stdin. No user text becomes shell source.
set -eu
umask 077
input=$(mktemp /tmp/tandem-brief.XXXXXXXX)
trap 'rm -f "$input"' EXIT HUP INT TERM
cat > "$input"
chmod 400 "$input"
verb=$1
request=$2
pane=$3
cwd=$4
window=${5-}
action_home=${6-}
set -- native "$verb" "$request" --input "$input" --pane "$pane" --cwd "$cwd"
if [ -n "$action_home" ]; then set -- "$@" --home "$action_home"; fi
if [ -n "$window" ]; then set -- "$@" --window "$window"; fi
/bin/sh tandem.sh "$@"
