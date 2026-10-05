# Tern native view hosting

View models and action decisions belong to Tandem's TypeScript layer. Tern reads derived JSON
files and draws native elements; the CLI alone changes task state. `tern-plugin/window.luau`
contains window key bindings, palette entries and routes, without durable state or view logic.

## Hosting decision (Tern 0.4.5, 2026-10-06)

Choose **daemon-hosted Luau blocks**. Both candidates drew the current `panelView` model in one
isolated daemon and control window, with a temporary Tandem home and one-second polling. Nine
file updates were timed until the control tree showed the new summary in each pane:

| Observation | TypeScript process over TSP | Luau plugin block |
| --- | --- | --- |
| Repaint latency | mean 438 ms; range 280–610 ms | mean 709 ms; range 543–961 ms |
| Idle CPU | Bun view process sampled at 0.0% | No additional process; daemon sampled at 0.0–0.1% |
| Window CPU | Shared window sampled at 2.6% with both views visible | Same shared window |
| Daemon restart | Pane id restored, foreground became a shell; drawing process lost | Same block id restored; re-read and displayed a new file revision |
| Alerts | Own pty can print OSC directly | A separate owned helper pane prints OSC |
| Starting probe source | 75 lines of raw TSP, including frame ids and stdin events | 171 lines including polling, rows, keys and actions; built-in frame diffing |
| Testability | TypeScript unit tests; protocol and lifecycle still need native checks | TypeScript view tests plus actual Tern Luau helper checks |

Poll phase accounts for the latency difference; these nine samples are not a claim that one
host draws faster. Both were below one second. Window-close survival alone also does not choose
a winner: shell programs survive a closed window. The block's daemon-restart restoration and
shared host runtime avoid recovery of one renderer process per open view. The cost is maintaining
small drawing helpers in Luau. Keep policy, derivation, GitHub reads and mutation in TypeScript.
The unselected TSP experiment is not part of the implementation.

### Alert source

Use a dedicated **Tandem-owned alert helper pane in a background tab of each project's session**.
It prints `OSC 777;notify;<title>;<body>` for needs you, done and stuck. The isolated test produced
one inbox entry with the helper's exact pane id and a waiting badge on its tab. A plugin block
has no pty. Do not type an alert command into the coordinator or worker's interactive input and
do not write directly to a guessed tty. The backend proves and records the helper's endpoint,
uses exact-id guards, and restores it through ordinary resource recovery after a daemon restart.
Clicking the helper's inbox entry lands on its tab; the panel remains the project navigator.

## Shared rendering foundation

`src/tern-view/file.ts` writes private files by exclusive temp-file creation and atomic rename.
There is one writer per destination. `nativeViewPath(home, kind, key)` returns
`<home>/views/<kind>-<key>.tandem-view.json`; keys contain only letters, digits, `_` and `-`.

```ts
{ version: 1, kind: "brief", revision: "opaque-view-revision", model: briefView }
```

`revision` is an opaque presentation revision. Actions that approve or submit must also carry the
authority's request revision, content/agreement digests or reviewed HEAD from their view model.
This file never authorizes an action by itself.

Luau modules load with relative `require` inside the package:

| Module | API |
| --- | --- |
| `view-file` | `create(path, kind, parseModel)`, `refresh(state) -> changed`, `watch(state, cx, interval?) -> stop` |
| `text-field` | `create(text?, multiline?)`, `key(field, key) -> outcome`, `node(field, key, placeholder?)` |
| `diff-row` | `row(line, commentAction?, cards?)`, `card(key, author, markdown, actions?)` |
| `components` | `button(text, action, tone?)`, `text(text, tone?)`, `keyed(node, key)` |

The loader checks the envelope and runs the renderer's shape parser before replacing its model.
Reads are bounded to 8 MiB, regular files only, and refuse symlinks. Missing, malformed, wrong-kind
or unsupported-version files preserve the last good model and set `status = "unavailable"`.
Renderers show that status and disable revision-bound actions until `status = "ready"`. No action
may use an old model merely because it is still visible. Unchanged files do not trigger a repaint.
The first poll runs after `init`, because a new block is absent from the pane list during `init`.
Polling stops when its exact pane disappears, or when the returned stop function is called.

Text fields keep transient text, a cursor and a selection anchor in code-point positions. Their
nodes convert cursor and anchor to Tern's UTF-16 units, including supplementary Unicode characters.
Arrows, Home/End, Shift selection, Select all, Backspace/Delete, paste and replacement work locally.
Enter returns `submit`, Escape `cancel`, Tab `next`; Shift+Enter inserts a newline in multiline
fields. The host handles those outcomes and invokes CLI actions. Draft text is transient UI state.

Own diff rows keep the two gutters, plain monospace code and hover `+` in one shared parent.
Thread cards are children directly below their line, with a yellow connecting border. Keys must
identify the file, side and line stably; actions carry the same anchor in their CLI payload.
`tandem.css` supplies these primitives to native windows through the manifest's styles entry.

## Window integration

The linked package registers ⌘⇧B, ⌘⇧P, ⌘⇧U, ⌘1–9 and ⌘⇧[ / ⌘⇧], the five Tandem palette
entries, and task/brief/PR links. Arguments pass through an argv array and `tandem.sh`, with the
originating pane id and cwd; no user text is interpolated into a shell command.
The open route contract is `tandem native open task|brief|pr ID --pane ID --cwd PATH
[--window KEY]`. Pane ids come from the current `WindowCx`, formatted as exact decimal strings.
The window key is included only when `TERN_WINDOW_KEY` is known; WindowCx has no documented key
accessor. Without one, the backend must refuse ambiguous targeting instead of choosing a first
window. The subsequent action PR owns the native dispatcher.

`ensureTernPlugin` checks the catalog and asks before linking a missing package. A failed or
malformed catalog fails closed. The same consent adds explicit `settings.json` keybind overrides:
Tern's built-in preset otherwise wins over plugin defaults for the requested shortcuts. Existing
custom bindings, modifier aliases and sequences are preserved and reported. Changes keep other
preferences and refuse a file changed since reading. Project actions use Tern's generated
`plugin.tandem.bind.0` through `.10`; their registration order is part of this integration.
Numeric shortcuts bind both Tern's character (`cmd+1`) and physical (`cmd+digit_1`) spellings;
its preset defines both. Configure keys before opening the project window, or reopen a window
after adding the mappings so it reads the settings.
`reloadTernPlugin` refreshes an already installed package for
`tandem update`; it never silently installs one. Onboarding retains the separate consent for
Tern's global sidebar setting. Native renderer definitions and CLI action handlers build on this
foundation in the subsequent stacked PRs.
