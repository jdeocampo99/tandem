#!/bin/sh
# Refuses key/type/click/... unless the window's focused pane id is in mine.txt (panes this probe created).
SOCK=${CTL_SOCK:-/tmp/tern-ui-probe/ctl.sock}
D=$(dirname "$0")
case "$1" in key|type|run|click|expect|block|split|paste|feed|swipe|scroll|drop|mouse|palette|tab|close|focus|rename|zoom)
  F=$(perl -e 'alarm 20; exec @ARGV' tern ctl --control "$SOCK" state | python3 -c "import json,sys;print(json.loads(sys.stdin.read())['focused']['id'])")
  grep -qx "$F" "$D/mine.txt" || { echo "REFUSED: focused pane $F is not mine" >&2; exit 9; } ;;
esac
exec perl -e 'alarm 20; exec @ARGV' tern ctl --control "$SOCK" "$@"
