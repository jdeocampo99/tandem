# Tern native UI probe for annotation views

Run on 2026-10-06 on the user's signed-in Tern 0.4.5, in a separate session (`uiprobe`) in a `--control` window.
One plugin block (`plugin/host.luau`, tabs input/diff/diff2/rows/md/layer/motion/link) drove every test.
Shots are in `shots/` (real paths of the runs: /tmp/tern-ui-probe/target/shots/tern/live/).

| # | Question | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | `input` and `editor`: focus, type, value, Enter, Esc, key leak | Works with caveats | `cx:frame({{"focus","main.ed"}})` moved the ring and caret; `ctl type` text arrived as one key event per character; value is held in our state (Tern never edits text); Enter submitted (`submitted=[abcj]`), Esc cancelled (`cancelled=1`), Shift+Enter inserted a newline, Tab switched fields. Click on an unfocused field sends `{ev:"focus", id:"main.ed"}`. Every key goes to the block's `key` handler, so we write the editing ourselves (cursor, backspace, arrows, selection). A typed "j" did not hit the list handler (`jcount=0`) because we route by mode. Shot: shots/q1c.png |
| 2 | Native `diff`: click on a line, nodes between lines, gutter API | Works with caveats | Looks right (unified, word emphasis, fold rows, highlight; shots/q2a.png). A click gives only `{act, id="main.0.diff"}`: the same event for an add line and a del line, no line, hunk or coordinates. No gutter or marker API, and no way to insert nodes inside one diff node. Workaround that worked: one `diff` node per line (`hunks={{oldStart,newStart,lines={l}}}`) with its own click action, and a `card` with an `input` inserted between nodes (shots/q2b.png). Cost: each line is its own rounded box, and word-level pairing is lost across lines. |
| 3 | Own rows: line numbers, add/del color, "+" button, thread card, hover, 300 lines | Works | `el` rows with CSS from `tern.css` (`.tp-row:hover`, `.tp-row:hover .tp-plus`). The "+" is hidden until hover. Click on "+" sent `cmt=N`, and a thread card appeared under that line. Hover is pure CSS, no re-render. 300 rows, 3274 nodes: view build 29 to 44 ms in Lua; click to card visible 70 to 116 ms measured through ctl; 10 wheel scrolls gave 57 frames, cpu p50 1.2 ms, p95 4.0 ms, 0 frames over 8 ms. Syntax highlighting is not free here: row code is plain text (the `code` kind highlights but has no per-line click). Shot: shots/q3a.png |
| 4 | Margin rail with cards aligned to lines; card hover highlights its line | Works with caveats | A right cell (`.tp-rail`) in each row put the card on the line's row (shots/q3a.png), and hovering the card lit the whole row including the "+" with no re-render (shots/q4a.png). Caveat: the card makes its row taller, so the document shifts instead of leaving a quiet margin; absolute positioning is possible in our own CSS but untested. There are no pointer enter/leave events at all (only click, dblclick, menu), so hover links must be CSS and the two things must share a parent. |
| 5 | `md` PR body, click a paragraph | Works with caveats | Headings, lists, inline code, link, fenced code with highlight all render (shots/q5a.png). A click on an `md` node returns only the node id (`main.1`), whatever block was clicked. Splitting the source into one `md` node per top-level block gave per-block clicks (`act=para value=2`). |
| 6 | Overlay over another pane | Works with caveats | The block's `layer` with an `overlay` (centered, md size, title, buttons) works and Esc closes it through our key handler (shots/q6a.png). It covers only its own block, not the neighbouring pane. A floating panel over another pane works through `tern pip BLOCK --over OTHER --corner br` (shots/q6b.png), which is a CLI call, not a block API, and it is a small corner window. |
| 7 | Spinner and elapsed animate without re-render | Works | With 3 spinners and 3 elapsed timers the block's view count stayed at 13 and the timers advanced (17.1s to 19.1s). Daemon cpu 0.0%. The window process went from 0.4 to 0.8% idle to about 10 to 13% while they were visible, so the cost is in rendering, not our code. |
| 8 | Clickable PR link via `cx:open` | Works with caveats | `cx:open("https://github.com/jdeocampo99/tandem/pull/281")` from a click opened a browser block (setting `link_target = "Tern"`), not the system browser. It opened in the user's own window (the first window), split beside their pane 4294967321, not in my control window. I closed that block with `tern close`; their pane still reports 108 cols (it was 164), which should return when their window next resizes. `ctl system` recorded no shell call. Node `href` plus the `open` action and a `ui.link` span (cmd-click) were not clicked, to avoid a second tab. |
| 9 | Hide Tern's sidebar | Works | `ctl tabs autohide on` hid the sidebar to an edge strip (shots/q9a.png) and wrote `"tabs_autohide": true` to settings.json (global, persists). `tabs vertical` wrote `"tabs": "Vertical"`. There is also a `toggle_sidebar` command ("Show/hide sidebar") and a layout setting (`rail|float|tiles|studio`); those were not tested. The sidebar showed with `tabs: Horizontal` in the rail layout. I restored both values; settings.json is byte-identical to the saved copy. The setting applies to every window, including the user's live one. |

## What this means for the brief and PR annotation views

Build the PR diff with our own rows, not the native `diff` element. The native diff looks best but cannot tell us
which line was clicked and cannot hold a comment card, and those two things are the whole point of annotation.
Own rows (a div per line with a line-number cell, a code cell, a "+" cell that shows on hover, and a rail cell for
the thread) gave clickable lines, a card on the same row, hover highlighting for free in CSS, and scrolled 300
lines without dropped frames. What we give up is syntax color and the neat word-level emphasis, unless we split
the diff into one native `diff` node per line, which restores the color and numbers but looks like a stack of
small boxes. A reasonable path: own rows first, and try the per-line native nodes as a styling upgrade if the box
look can be flattened with CSS.

The comment box works. An `input` or `editor` is a drawing that we feed; we write the key handling ourselves (about
40 lines covered Enter, Esc, Shift+Enter, Tab, backspace and typing). Selection, undo and arrow movement would
also be ours. Plan a small shared text-field helper.

The brief and the PR body can use `md`, split into one node per block so each paragraph is clickable. The approval
card over the coordinator can be a block `layer` if the brief lives in a block; to float over another pane use
`tern pip`.

Main risks:
- No pointer enter/leave events: hover links between distant nodes (a rail card lighting its line) must share a
  parent and use CSS.
- Keys are all ours inside blocks; there is no native text editing, selection or undo for plugin blocks.
- `cx:open` and CLI layout/settings commands act on the user's first window and global settings, so a probe or
  Tandem can change the user's workspace. Tandem must target links deliberately and never flip settings silently.
- Own rows are not syntax highlighted and nodes grow with file size (about 11 per row); very large diffs need
  paging or per-file collapse.
- A linked plugin loads in the user's own windows too (its palette command appears there).

## Rerun

Link `plugin/`, run `tern --control SOCK --dir DIR` after creating your session, `scripts/ctl-safe.sh` wraps
`tern ctl` and refuses input unless the focused pane id is in `scripts/mine.txt`.
