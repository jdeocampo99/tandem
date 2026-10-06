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

The UTF-8 wire sequence is `\u001b]777;notify;TITLE;BODY\u0007` (ESC, `]`, the payload, BEL).
Use these alert kinds and title prefixes; put the task's displayed title or summary in `BODY`:

| Kind | Title prefix |
| --- | --- |
| `needs-you` | `Tandem: Needs you` |
| `done` | `Tandem: Done` |
| `stuck` | `Tandem: Stuck` |

The backend renders title and body as single-line plain text: replace semicolons and C0/DEL
control characters (including ESC/BEL and newlines) with spaces before framing. The kind selects
the title prefix; it is not an extra OSC field. Backend creation, endpoint recording, delivery
and recovery of the helper pane belong to the terminal backend worker.

## Shared rendering foundation

`src/tern-view/file.ts` writes private files by exclusive temp-file creation and atomic rename.
There is one writer per destination. `nativeViewPath(home, kind, key)` returns
`<home>/views/<kind>-<key>.tandem-view.json`; keys contain only letters, digits, `_` and `-`.

```ts
{ version: 1, kind: "brief", revision: "opaque-view-revision", model: briefView }
```

The views-data publisher uses `kind = "panel"` with the root `NativeViews` bundle, and
`task`/`brief`/`pr` with direct domain models for detail files. Its revision is the canonical
model content hash. A board or usage block reading that root file still expects envelope kind
`panel` and extracts its model from the bundle; the native block id is separate from the file kind.

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

`host.luau` is the daemon entry point. It eagerly loads these four modules, so a missing or
invalid helper fails plugin readiness before a block opens. Each renderer module returns its
typed `BlockDef<State>`; register it with one line, with no shared dispatch table or view logic:

```lua
tern.block.define("panel", require("./panel"))
```

The renderer also adds a matching `[[blocks]]` entry with `id = "panel"` and its title to
`plugin.toml`. Its native block kind is `tandem.panel`. Register every declared block before
`host.luau` finishes. The foundation has no screen-specific registrations; wave 2 adds them.

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
Window and native view actions use the following CLI surface:

```text
tandem native board|prs|usage|new-request|open-task CONTEXT
tandem native open task|brief|pr ID CONTEXT
tandem native project 1..9|prev|next CONTEXT
tandem native brief-comment|brief-request-changes|brief-approve REQUEST_ID --input FILE CONTEXT
tandem native pr-comment TASK_ID --text TEXT CONTEXT
tandem native pr-comment TASK_ID --input FILE CONTEXT
tandem native review-submit TASK_ID --input FILE CONTEXT
tandem native restart TASK_ID CONTEXT
tandem native steer --task TASK_ID --text TEXT CONTEXT
CONTEXT = --pane ID --cwd PATH [--window KEY]
```

`--pane` and `--cwd` are required. Pane ids come from the current `WindowCx`, formatted as exact
decimal strings; cwd is that pane's absolute directory, passed as one argv element. The plugin
shows an error without spawning when either is unavailable. No context comes from
`TANDEM_NATIVE_CWD` or a guessed first pane. Task/brief ids contain letters, digits, `_` and `-`;
PR ids are decimal numbers. The native file route calls `native view-file PATH` with the same
context, for renderer registration.

The optional window key is an opaque Tern control-window key, never a pane, tab or session id.
It is included only when `TERN_WINDOW_KEY` is known; WindowCx has no documented key accessor.
The backend must prove that a supplied key owns the named pane. Without a key it derives the
unique owning window from that exact pane and refuses ambiguous targeting. The action worker
owns `native open`; renderer workers own board/PRs/usage/project. This layer owns the calling
convention and plugin only, without a shared native dispatcher.

### JSON action input

JSON actions pass `--input` and an absolute file path as separate argv elements. Renderers
finish writing one UTF-8 JSON object before spawning the CLI, with a new file for each action
in a private Tandem-owned directory supplied by the TypeScript view producer. The directory
uses `0700`; TypeScript-created input files use `0600`. Never put action input in the plugin
package, a repository, an environment variable, or an interpolated shell command. The file
stays unchanged until that invocation finishes; the caller owns cleanup after completion or
known spawn failure. The CLI reads the file without deleting it. An uncertain process outcome
does not authorize another invocation.

Every brief action carries the exact identity of the displayed draft:

```json
{
  "briefRevision": 3,
  "contentDigest": "displayed-content-digest",
  "agreementDigest": "displayed-agreement-digest"
}
```

`brief-approve` sends only those three fields. `brief-comment` and `brief-request-changes` may
also include `text` and `comments`, where each comment is
`{ "lineId": "TL;DR:0:0", "text": "Feedback" }`.
The renderer copies the stable string id from `briefView.lines[].id` and copies revision and
digests from its view model without recalculating them or refreshing them
behind the user's click. The CLI owns shape, revision, digest and approval validation. Unknown
fields and numeric `line` anchors are refused. Feedback resolves ids through `briefView` for the
exact preserved historical revision. Unknown ids, missing historical revisions, and mismatched
digests refuse the action before delivery. Feedback allows at most 100 comments and 64,000 bytes of encoded feedback.
The JSON object does not contain `requestId`: the command's positional `REQUEST_ID` names it.

For example, the caller passes this argv suffix, preserving paths with spaces as one argument:

```text
native brief-request-changes REQUEST_ID --input /absolute/private/action.json
  --pane ID --cwd /absolute/project/path [--window KEY]
```

`pr-comment` accepts either `--text TEXT` or `--input FILE`, never both. Its JSON object has
optional `text` and `comments: [{ "file": "src/file.ts", "line": 12, "text": "Feedback" }]`.
The path and positive one-based line are the displayed diff anchor. With `--text`, the complete
user text is one argv element, including spaces and newlines.

`review-submit` uses the existing `ReviewSubmission` object from `src/pr-review/page.ts`:
`tandemPrReview: 1`, `verdict: "comment" | "approve" | "request-changes"`, `summary`,
`drafts: [{ id, decision: "post" | "drop" | "undecided", body? }]`, and
`yours: [{ file, line, body }]`, plus required native fields `reviewHead` and `reviewGeneration`.
Copy those two fields from the displayed `PrPaneView.review.head` and `.generation`; generation
is a nonnegative safe integer, including zero. Keep the bindings frozen with the user's choices.
Missing/invalid bindings are refused. The service checks both against the latest authoritative
round and checks the re-review task generation inside submission serialization before applying choices or
posting, so stale pane choices cannot become a review of a newer round even when draft ids repeat.
Question follow-ups retain their finished review round and its binding. The HTML page's
`ReviewSubmission` shape stays unchanged. The CLI reuses the pinned-HEAD and no-double-post checks of
the review page; the renderer does not publish directly.

`restart` names the task and goes through central recovery. `steer` requires `--task TASK_ID` and
the user's direction as one `--text` argv value; positional task ids are refused. Both carry
the same explicit pane/cwd/window context.
The action worker owns these handlers alongside brief/PR mutations and `native open`;
renderers own collecting input, writing the action file, invoking the CLI and cleanup.

### Completion and installation

Exit 0 means the action completed or the user cancelled a picker. Refusal, missing context,
unavailable commands and effect failures exit nonzero with a useful diagnostic on stderr.
The plugin shows nonzero stderr in an error toast and also reports synchronous spawn failure.
Renderers may add `--json` to consume the CLI's structured result on stdout, including warnings;
that output does not authorize subsequent mutations. A handled link stays handled on failure;
the plugin never retries an action, including an operation whose outcome is uncertain.

The terminal port's `openView` returns `{ opened: boolean, warnings: readonly string[],
fallback?: "brief-review" }`. The action handler carries warnings in its result and fails
when no view opened. The `brief-review` fallback tells the action handler to use the existing
request-brief review workflow and verify that its pane opened. Callers do not create a second
view or retry an open merely because warnings or a fallback are present.

`ensureTernPlugin` checks the catalog and links a missing package after ready Tern is selected.
Choosing ready Tern is consent to link its native view package. A failed or malformed catalog fails closed. One onboarding question asks before hiding Tern's sidebar and adding
global shortcuts. These preferences affect every Tern window. Window commands register no default
chords, so declining leaves Tern's keys unchanged while keeping the five specified commands in the palette.
Project commands set `available = false`: Tern 0.4.5 hides these rows but still dispatches their
consented keybind actions, verified in an isolated control window.
Panel renderers always provide their header buttons, independent of shortcut consent.

Only absent explicit keybinds inherited from the built-in Tern preset are eligible for replacement.
Every explicit non-Tandem binding is treated conservatively as custom, including modifier aliases,
physical digit aliases and sequences. The native `SettingsCx.describe("keymap")` schema and an
isolated `tmux` window confirm enum presets `tern`, `ghostty`, `kitty`, `cmux`, and `tmux`, with
`tern` as default. Alternate presets are preserved as a whole and reported by preset name, without
mislabeling their inherited keys as custom. Skipped explicit shortcuts are listed
with names such as "Command+Shift+B". Project actions use stable named commands
`plugin.tandem.project-1` through `project-9`, `project-prev` and `project-next`.
Numeric shortcuts bind both Tern's character (`cmd+1`) and physical (`cmd+digit_1`) spellings;
its preset defines both. Configure keys before opening the project window, or reopen a window
after adding the mappings so it reads the settings.
`configureTernPluginSettings({ path?, configDirectory?, approved?, confirm? })` returns
`{ configured, skipped, notice?: true, preset?: string }`. The private `settings.json.tandem.json` version-1 record stores the
decision, exact added key/action pairs, original keybind-table presence, and sidebar's original
presence/value plus installed value. A decline is remembered and leaves settings byte-identical.
An approval records changes before applying them, allowing restoration after an interrupted write.
A failed settings write removes its unchanged record only when the writer positively reports
`PreferenceWriteNotCommittedError` before attempting atomic rename/link. Unclassified failures,
commit-attempt failures and post-commit cleanup failures retain the record for guarded restoration,
even if formatting or unrelated preferences changed after the commit. Byte differences never prove
non-commit. An existing approved record reports
`configured: true` only while its recorded settings are actually present; an interrupted write
cannot claim application on the next launch. User edits are still never reapplied.
Both files are regular, non-symlink files written atomically with mode 0600, and stale writes are
refused. Existing records do not reapply removed bindings or reprompt on each launch.
`notice` is returned only for a newly saved decision: custom-key and decline notices print once.
The decline notice explains how to reconsider: switch to Herdr, then select Tern again in setup.

`restoreTernPluginSettings({ path?, configDirectory? })` returns `{ restored, preserved }`.
It removes only recorded keys still equal to their installed action and restores the sidebar only
while its value remains Tandem's installed value. Later user edits and unrelated preferences remain.
After successful restoration it removes the record. An absent record performs no writes.
`reloadTernPlugin` refreshes an already installed package for `tandem update`; it never installs one.

`setup.sh` invokes `src/terminal-backend/setup.ts`, which reads the saved home terminal choice
and runs the existing Herdr setup or the Tern installer. The terminal front door also offers
Tern installation after project preparation saves the terminal choice and before opening a
project window. Chat and Lavish setup use the shared coordinator host's confirmation port: after saving a Tern
choice, `configureTerminal` awaits the injected installer outside task-store serialization before
setup opens projects. A declined global-settings prompt retains the plugin and prints how to reach
its palette commands and panel buttons.
Both composition helpers read `readHomeSettingsSync(home).terminal`. An explicit Herdr choice
attempts to restore recorded Tern preferences without daemon calls; an unset choice performs no effects.
Restoration is best-effort: invalid settings or failed cleanup warn once per config path in the
current process, preserve the record, and never block a Herdr launch or update.
`installTerminalPlugin(home, dependencies, readiness?: TerminalAvailability)` returns
`Promise<boolean>` for package readiness. A supplied readiness result avoids another probe;
otherwise it checks availability before linking or asking about global settings. Missing,
signed-out and unknown readiness refuse installation without plugin or setting effects.
`reloadTerminalPlugin(home, dependencies)` returns `Promise<boolean>` for whether a package reloaded.
The two-argument callers remain valid. Update reloads after successful coordinator updates without a
prompt. On switching to Herdr, the shared configure callback restores preferences after saving the
choice, preserving the existing Herdr integration path. A failed Tern choice saves Herdr and skips
plugin consent. The Tern package stays linked for later use.
