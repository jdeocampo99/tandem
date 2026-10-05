# Tern live window probe

Run on 2026-10-06 against the user's signed-in Tern 0.4.5, in a separate session (`twprobe`) driven by
`tern --control` windows. The user's panes were untouched: pane ids matched before and after, and the
plugin list ended empty.

| # | Question | Verdict | Evidence |
| --- | --- | --- | --- |
| 1a | Status-line segment shows and is clickable | Works | `ctl tree .sl-plugin` shows `role=button`; clicks ran the command. The status bar is off by default. |
| 1b | Key bind fires a command | Works | `ctrl+alt+shift+k` toasted; `ctrl+alt+shift+t` opened the block. |
| 1c | Palette command | Works | Listed with its chord; running it opened the block. |
| 1d | Window toasts | Works | `cx:toast` info, success and error, with a second line. |
| 1e | macOS notification with sound | Doesn't work | No plugin API or CLI verb. OSC 9/777 give a Tern toast and inbox entry only; `ctl system` notifications stayed empty. |
| 2 | Inbox, pane alert, tab badge | Works, through pane escape sequences only | BEL gives a `bell` entry; OSC 9, OSC 777 `notify;title;body` and OSC 99 give a `waiting` entry, coalesced with a count. Tab dot and bell count appear. The inbox is per window. |
| 3a | Plugin block: polls JSON, clickable rows, keys | Works | Row click sent `select`, the Approve badge wrote `approvals.jsonl`, `j` then `a` approved the next row. |
| 3b | Update latency | Works | Mean 554 ms over 9 writes (198 to 949 ms): the 1 s poll plus about 10 ms. |
| 3c | Open from a command | Works | `cx:new_block("tandemwin.tasks", args, "beside")`. |
| 3d | Open from the CLI | Works with caveats | `tern split ... -- tandemwin.tasks` runs a shell command (exit 127). `tern open X.tandemtasks.json` works through `tern.route.open` and needs a window attached. |
| 3e | Survives window close and reopen | Works | With no window attached the block kept repainting; the reopened window showed new data. |
| 3f | Visible in a second window | Works | Same blocks in both windows. |
| 4 | Native UI from a plain Bun program (TSP) | Works, but not through pi-tui | `@oh-my-pi/pi-tui` has no TSP code. About 80 lines of raw TSP in `tsp-list.ts` drew a native list; clicks came back on stdin; repaint 158 to 499 ms. Frame ops are `add`, `del`, `set`. |
| 5 | Browser picture-in-picture | Works with caveats | `snapshot`, `act click` on Approve, and `eval` reading page state all worked. It opens as a 240x174 thumbnail; expanding it was not tested. |
| 6 | Built-in board block | Works | Markdown: `## Lane` headings, `- [ ]` cards, `#tag`, `@YYYY-MM-DD`, indented subtasks. Drags and edits rewrite the file in about 1.5 s; external edits reload in under 2 s. |
| 7 | Routes | Works | Cmd-click on an OSC 8 `tandem://task/102` link opened the block with the task id; a `*.tandemtasks.json` glob opened it through `route.open`. |
| 8 | Multiple windows | Works with caveats | `tern ls` without `--window` sees every daemon session. No way found to learn a window's key from outside Tern. |

## What this means for Tandem

- **Panel:** build it as a plugin block. Tandem writes one JSON file, the block polls it and repaints in
  about half a second. It lives in the daemon, so it survives closed windows and shows in every window.
- **Task page and brief:** keep them as HTML in a browser block; the page is fully drivable. Use a full
  browser block for reading, since picture-in-picture is a thumbnail.
- **Approvals:** a block can take an Approve click or key and hand it to the `tandem` CLI, which records it.
- **PR block:** same mechanism as the panel, with `cx:open(url)` on click.
- **Notifications and inbox:** Tandem prints OSC 777 or OSC 9 into a pane it owns to get an inbox entry,
  a tab badge and a toast. A macOS banner or sound needs Tandem's own notifier, outside Tern.
- **Board:** Tandem can write the Markdown, but the board is two-way, so a Tandem board block (view-only)
  fits better than the built-in one.
- **Native UI from TypeScript:** raw TSP works without pi-tui. A plugin block is still the better default
  because it survives window close and needs no running process.
- **Limits:** a plugin must be linked; window features need a window attached; the CLI opens a plugin
  block only through `tern open <file>` with a route; a linked plugin loads in the user's own windows.

## Rerun

Link `plugin/`, open a control window, and follow `scripts/`. `scripts/ctl-safe.sh` wraps `tern ctl`
with a timeout.
