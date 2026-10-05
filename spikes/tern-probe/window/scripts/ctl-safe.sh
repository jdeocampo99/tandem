#!/bin/sh
# Refuses key/type/run/click/etc unless the window's focused pane is one we created (ids in mine.txt).
SOCK=${CTL_SOCK:-/tmp/tern-window-test/ctl.sock}
D=$(dirname "$0")
case "$1" in key|type|run|click|expect|block|split|paste|feed) 
  F=$(perl -e 'alarm 20; exec @ARGV' tern ctl --control "$SOCK" state | python3 -c "import json,sys;print(json.loads(sys.stdin.read())['focused']['id'])")
  grep -qx "$F" "$D/mine.txt" || { echo "REFUSED: focused pane $F is not mine" >&2; exit 9; } ;;
esac
exec perl -e 'alarm 20; exec @ARGV' tern ctl --control "$SOCK" "$@"
