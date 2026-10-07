# Native views

Tern's native Tandem views: the store TypeScript writes, the contracts both languages share,
the one click transport, the staged open, polling and every view. Start with
[terminal.md](terminal.md) for the terminal port, the Tern mapping, the mutation guards, setup
and `tandem fix`.

TypeScript computes every model, reads GitHub and provider data and applies policy. Luau draws,
keeps transient drafts and sends clicks. The CLI alone changes task state. A renderer never
fetches GitHub, provider limits or the task store itself, and no view file authorizes an action.

Code: [src/native/](../../src/native/) (`contract.ts`, `store.ts`, `actions.ts`),
`src/terminal-backend/tern/host.ts` and `views.ts`, and [tern-plugin/](../../tern-plugin/).
Tests: `tests/native/` and the parity harness in `tests/evals/tern-parity/`.

## Hosting decision

Tandem uses **daemon-hosted Luau blocks** (Tern 0.4.5, 2026-10-06). Both candidates drew the
`panelView` model in one isolated daemon and control window, with a temporary Tandem home and
one-second polling. Nine file updates were timed until the control tree showed the new summary
in each pane:

| Observation | TypeScript process over TSP | Luau plugin block |
| --- | --- | --- |
| Repaint latency | mean 438 ms; range 280–610 ms | mean 709 ms; range 543–961 ms |
| Idle CPU | Bun view process sampled at 0.0% | No additional process; daemon sampled at 0.0–0.1% |
| Window CPU | Shared window sampled at 2.6% with both views visible | Same shared window |
| Daemon restart | Pane id restored, foreground became a shell; drawing process lost | Same block id restored; re-read and displayed a new file revision |
| Alerts | Own pty can print OSC directly | A separate owned helper pane prints OSC |
| Starting probe source | 75 lines of raw TSP, including frame ids and stdin events | 171 lines including polling, rows, keys and actions; built-in frame diffing |
| Testability | TypeScript unit tests; protocol and lifecycle still need native checks | TypeScript view tests plus actual Tern Luau helper checks |

Poll phase accounts for the latency difference. These nine samples do not show that one host
draws faster, and both were below one second. Window-close survival alone does not choose a
winner either, because shell programs survive a closed window. The block's daemon-restart
restoration and shared host runtime avoid recovering one renderer process per open view. The
cost is maintaining small drawing helpers in Luau. The unselected TSP experiment is not part of
the implementation.

## Contracts and their owners

Every shape that crosses the language boundary has one owner in `src/native/contract.ts`. Luau
reads the same fields by name. The plugin ships in lockstep with the repository
(`tern-plugin/tandem.sh` runs `../src/main.ts`), so no generator sits between them. Each contract
has a test that runs the real Luau beside the real TypeScript. `luau` is a required dev
dependency, so these tests never skip.

| Contract | Owner | How Luau gets it | Cross-boundary test |
| --- | --- | --- | --- |
| View file envelope and models | `ViewFile` and `VIEW_MODELS`; written only by `publishViews` in `store.ts` | `rt.watch` checks the envelope; screens read model fields by name | `tests/native/render.test.ts` (T1): every view the store writes draws through its real screen, and a model that cannot draw keeps the last good one. `tests/native/store.test.ts`: undrawable models are refused and `seq` is committed before a file carries it |
| Block arguments | `blockArgs` and `parseBlockArgs` | `rt.origin(args)` keeps `args[2]` opaque; screens watch `args[1]` and `args[3]` | `tests/native/actions.test.ts`: an echoed context that `blockArgs` did not write is refused. The parity harness sends every click through the real `tandem native act` |
| Action input and outcome | `ActionEnvelope`, `Outcome` and `NOTICE_CODES` | `rt.act` builds one table per verb and toasts by `notice.code` | `tests/native/actions.test.ts` (T2): every click in every rendered view sends an envelope the contract accepts |
| Block and link names | `VIEW_KINDS`, `LINK_KINDS` and `nativeLink` | `host.luau` registrations, `plugin.toml` blocks and the `window.luau` link pattern | `tests/native/routes.test.ts` (T3): manifest, registrations and `VIEW_KINDS` name the same views, and every `nativeLink` output routes to an accepted `open` |
| Open ticket and receipt | `Ticket` and `Receipt`; lifecycle in `host.ts` | `layout.luau` reads ticket fields by name and writes the receipt | `tests/native/layout.test.ts` (T4): `layout.luau` runs TypeScript-built tickets and `decide()` gives every receipt the table's answer. `tests/native/decide.test.ts` covers the state machine |

`tests/evals/tern-parity.test.ts` drives every view through the real screens, with
`tests/evals/tern-parity/host.luau` standing in for Tern. Its inventory is the parity contract
for what each view shows and does. `paint.ts` resolves the plugin stylesheets against Tern's
light and dark themes, and the inventory requires every string Tandem colors to read at 3:1 or
better in both. A hard-coded background brings its own text color, and any other plugin color
uses `light-dark()` so it holds in both appearances. Tern draws a slot's root node only through
its children, so a class on that root never styles the page.

## Store layout

`<home>/board-snapshot.json` keeps its version-1 shape and Herdr behavior.

`src/native/store.ts` owns `<home>/tern/<key>/`, one directory per project. `key` reuses
`repositoryKey(canonicalRepoPath)` from `src/config/repositories.ts`, the existing 24-character
lowercase key for saved project settings and coordinator session directories, so two checkouts
with the same basename have different directories. The directory holds:

- `views/index.json`, the index every screen without a detail file watches
  (`viewIndexPath(home, canonicalRepoPath)`).
- `views/task-<encodedTaskId>.json`, `views/brief-<encodedRequestId>.json`,
  `views/pr-<encodedOwnerRepo>-<number>.json` and `views/setup-<mode>.json`, the detail files
  (`viewDetailPath(home, canonicalRepoPath, detailFile)`). Identifiers use `encodeURIComponent`,
  so each filename is one path segment. PR filenames include the repository.
- `state.json`: the store's `epoch` and `seq`, the alert cursors (`board/native-alerts.ts`), the
  visit record (`memory/native-visits.ts`) and `published`, what the last full publication showed.
  `published` is a cache: a value in an older shape reads as absent, and the next publication
  rebuilds it while keeping `epoch`, `seq`, alerts and visit.
- `open/<coordinatorKey>.<token>.{ticket,receipt}.json`, staged open tickets and their receipts
  (`terminal-backend/tern/host.ts`).

One lock per project (`state.lock`) serializes `views/` and `state.json` across coordinator and
CLI processes. `withProjectLock` is the only way to change `state.json`. Staged opens keep their
own per-coordinator lock in `open/`, because an open holds it while Tern applies the layout, and
publication must not wait for that. For the same reason a project visit decides under the lock,
opens catch-up outside it, and records the visit under it again.

The project's coordinator is the single writer of full publications. The existing
`writeBoardSnapshot` service operation schedules them, and only when the active terminal has the
`views` capability. `NativeViewsPublisher` (`board/native-read.ts`) runs task inspection,
timelines and derived-file writes in a serial background queue. Snapshot ticks enqueue the
newest input without waiting for those reads. While a publication runs, later ticks replace a
single pending input. Shutdown drains the last queued publication and cache reads.

`publishViews(home, project, build)` is the only writer of `views/`. Immediate brief projection
uses it too. It takes the project lock, then builds from fresh durable state, then validates every
model against its schema, and holds the lock through detail writes, index replacement and cleanup.
An older tick therefore finishes before a new brief detail can publish, and a later tick reads the
current revision even with an older board input. Cleanup cannot delete a detail published after
the snapshot it used. Brief opening waits for this writer.

Directories are private (0700) and files are 0600. A file is rewritten only when its canonical
model JSON changed, so an unchanged file keeps its inode, modification time and `seq`. Each
changed file uses a unique temporary file and an atomic rename. Details publish before the index.
There is no transaction across files, so actions still validate authoritative revision and HEAD
bindings. After a successful index write, the same owner prunes its task, brief and PR detail
files for entities no longer present. Pending provider and GitHub refreshes keep a live PR's last
detail until its replacement is ready. Foreign project files, unrelated files, symlinks and
temporary files are preserved. On failure, the last good files stay readable and
`native-views-publish-failed` diagnostics record the failure. GitHub and provider cache refreshes
run in a serial background queue, at most once per minute per PR or provider read, with command
timeouts. They never hold up the snapshot. Shutdown drains the queue.

TypeScript never parses a view file to decide anything. These decisions read `state.json`,
written in the same locked publication as the views:

- Project switching reads `published.projects` and the summary's `writtenAt`, refused when more
  than 10 seconds old.
- Board and catch-up links read `published.boardLinks` and `published.merged`.
- Show PRs and opening a PR by number read `published.pullRequests`.
- Task and PR detail availability read `published.tasks` and `published.pullRequests`.
- Catch-up's first need reads `published.needsYou`, and visit signatures read
  `published.changeSignature`.

Other projects' rows in the switcher come from their own `published.summary`.

The format never shipped to other users, so the earlier `native-views/`, `native-alerts/`,
`native-visits/` and `native-host/` directories are not migrated or read.

A missing index means no publication yet. A stale `writtenAt` is shown as stale, as the panel
does. Read-only cached remote data may be older than the index: PRs have `readAt`, limits have
`fetchedAt`, and `warnings` records refreshing or failing sources. The in-memory remote cache
starts empty on a coordinator relaunch and fills in later reconciliations. An empty or failing
read never means zero usage or passing CI.

## View files and polling

Every file in `views/` is one `ViewFile` (`src/native/contract.ts`):

```ts
{ v: 1, kind: "index" | "task" | "brief" | "pr" | "setup", epoch: string, seq: number, model: Model }
```

The index has `kind:"index"` and `model:NativeViews`. Detail kinds are `task`, `brief`, `pr` and
`setup`, with `model:TaskPageView`, `model:BriefView`, `model:PrPaneView` and `model:SetupView`.
`VIEW_MODELS` holds one zod
schema per kind, covering what the screens draw. `publishViews` refuses a model that fails it
before writing anything. Luau JSON reads `null` as absent, so optional fields accept either. A
board, usage or catch-up block watching the index reads its part of the bundle. The native block
id is separate from the file kind.

`epoch` is a random id written when the project's `state.json` is created. `seq` is project-wide.
Each written file takes the next number, and `state.json` commits the numbers before any file
carries them, so a crash only skips numbers. `seq` only orders files. It is distinct from the
numeric brief revision at `file.model.revision` and the reviewed HEAD in a PR model. Actions that
approve or submit carry those authority bindings from their view model, never `seq`.

`rt.watch(cx, path, kind)` reads the file once at `init`, then once a second. It accepts a file
only when the envelope checks, its `kind` matches and its `seq` is higher than the shown one. A
different `epoch` is a new store and resets that baseline. Reads are bounded to 8 MiB. Missing,
malformed, wrong-kind or older files keep the last good model and set `status = "unavailable"`.
Unchanged files trigger no repaint. Polling starts in a timer, because a new block is absent from
the pane list during `init`. It stops when the block's exact pane disappears or on `rt.unwatch`.

Screens have no shape parsers: the writer validated the model. `host.luau` draws every block
through `rt.draw`, which renders inside a `pcall`. A model that fails to draw is never shown. Its
watch goes back to the last model that drew and sets `status = "unavailable"` until a newer file
arrives. Renderers show that status and disable revision-bound actions until `status = "ready"`.
No action may use an old model only because it is still visible. The brief screen compares `seq`
to notice a newer draft.

## Plugin package and drawing API

`tern-plugin/plugin.toml` names `host.luau` as the daemon entry point and `window.luau` as the
window entry point. `host.luau` LOAD only registers lazy block callbacks. It does not require
renderers or helpers, read view files or change layout, because Tern disables hooks that exceed
50 ms, including initial plugin load. Each renderer module returns its typed `BlockDef<State>`
and is registered with one line:

```lua
tern.block.define("panel", lazy(function() return require("./panel") end))
```

The renderer also adds a matching `[[blocks]]` entry with `id = "panel"` and its title to
`plugin.toml`. Its native block kind is `tandem.panel`. The renderer and its helpers load on the
first block initialization, so module failures surface when that block opens. Later panes reuse
the cached definition.

`window.luau` registers the palette commands, the project commands, the `tandem://` link route,
the open-ticket route and the focus lifecycle. It requires neither `rt.luau` nor `layout.luau`
at load. A matching open route consumes the ticket and loads `layout.luau` in a fresh timer.

Luau modules load with relative `require` inside the package:

| Module | API |
| --- | --- |
| `rt` | `watch(cx, path, kind) -> Watch`, `unwatch(cx, watch)`, `draw(view, state, cx)`, `origin(args)`, `act(cx, origin, action, done?, labels?)` |
| `text-field` | `create(text?, multiline?)`, `key(field, key) -> outcome`, `node(field, key, placeholder?)` |
| `diff-row` | `row(line, commentAction?, cards?)`, `card(key, author, markdown, actions?)` |
| `components` | `button(text, action, tone?)`, `text(text, tone?)`, `keyed(node, key)` |

Text fields keep transient text, a cursor and a selection anchor in code-point positions. Their
nodes convert cursor and anchor to Tern's UTF-16 units, including supplementary Unicode
characters. Arrows, Home and End, Shift selection, Select all, Backspace and Delete, paste and
replacement work locally. Enter returns `submit`, Escape `cancel` and Tab `next`. Shift+Enter
inserts a newline in multiline fields. The host handles those outcomes and sends actions. Draft
text is transient UI state.

Own diff rows keep the two gutters, plain monospace code and hover `+` in one shared parent.
Thread cards are children directly below their line, with a yellow connecting border. Keys
identify the file, side and line stably, and actions carry the same anchor. `tandem.css` supplies
these primitives to native windows through the manifest's `styles` entry.

## Block arguments

Every block receives three strings, `blockArgs(viewPath, ctx) = [viewPath, ctxJson, indexPath]`,
built only by `src/native/contract.ts`. Listings are matched only through `parseBlockArgs`.
`ctx` holds the coordinator pane, cwd, home, index path and optional window key. Luau never reads
it. Every action echoes it back verbatim as the envelope origin's `ctx`, with the renderer's
**own** `cx.pane` as `pane`, and `tandem native act` parses it with `parseBlockContext`, which
refuses any text `blockArgs` would not write. Screens that also watch the project index read
`args[3]`, `indexPath`, which equals the context's `index`, so Luau never derives a path from
another. Root inputs come from `viewIndexPath` and detail inputs from `viewDetailPath`.

## Click transport

Every click, key and window command reaches Tandem through one transport, `rt.act` in
`tern-plugin/rt.luau`. It writes one `ActionEnvelope` to the stdin of
`/bin/sh tandem.sh native act` and reads one `Outcome` from stdout:

```text
{ v: 1, origin: { pane, ctx } | { pane, cwd, window? }, action: { verb, ... } }
→ { status: "done" | "kept" | "refused", notice?: { code, text } }
```

A block's origin is its exact pane id and the `ctx` it was launched with. A window command's
origin is the focused pane, captured at the gesture, with its absolute cwd and `TERN_WINDOW_KEY`
when known. Without an absolute cwd the command toasts and sends nothing. No user text is
interpolated into a shell command, and no input file is written.

`src/native/actions.ts` reads the envelope (at most 1 MiB) and proves the origin: exactly one
recorded coordinator session must list the pane. It then dispatches its verb table to the
existing services and prints the outcome. The verbs are `open`, `open-project`, `project`,
`visit`, `restart`, `steer`, `brief-approve`, `brief-request-changes`, `pr-comment`,
`review-submit`, `catchup-dismiss`, `catchup-open-needs`, `board-link`, `merged-link` and
`setup-save`. `open` takes a `ref` naming a task, brief, PR, `board`, `usage`, `prs`,
`orchestrator`, `inbox`, `task-picker`, `new-request` or `{kind:"setup", mode:"setup"|"settings"}`
with an optional `section` (`models`, `repositories` or `bug-reports`).

`done` means the click did what it asked. `kept` means part of it did not happen, typically a
view that could not be closed or proved, and the originating view stays. `refused` means Tandem
refused the click or it failed. The notice says why, and the user may try again.

`rt.act` holds one action per origin at a time and toasts by `notice.code`. Each code has one
title and level in `rt.luau`. `failed` and unknown codes take the asking screen's title. A
request-changes on a revised brief is `kept` with "Brief left open", never "completed".

`tandem native act` exits 0 whenever it printed an outcome, including a refusal. It exits nonzero
without an outcome when its arguments are malformed, when the envelope exceeds 1 MiB, or when
reading stdin fails. `rt.act` turns a nonzero exit, an unreadable outcome or a synchronous spawn
failure into the screen's error toast. The outcome never authorizes a later mutation.

### Action fields

Action input travels only inside the envelope on stdin. It never goes into the plugin package, a
repository, an environment variable, a file or an interpolated shell command.

Every brief action carries the exact identity of the displayed draft:

```json
{
  "briefRevision": 3,
  "contentDigest": "displayed-content-digest",
  "agreementDigest": "displayed-agreement-digest"
}
```

`brief-approve` sends only those three fields and `requestId`. `brief-request-changes` also
carries `comments` (possibly empty) and may include `text`. Each comment is
`{ "lineId": "TL;DR:0:0", "text": "Feedback" }`.
The renderer copies the stable string id from `briefView.lines[].id` and copies revision and
digests from its view model without recalculating them or refreshing them behind the user's
click. The CLI owns shape, revision, digest and approval validation. Unknown fields and numeric
`line` anchors are refused. Feedback resolves ids through `briefView` for the exact preserved
historical revision. Unknown ids, missing historical revisions and mismatched digests refuse the
action before delivery. Feedback allows at most 100 comments and 64,000 bytes of encoded
feedback.

`pr-comment` names `taskId` and carries optional `text`, `comments: [{ "file": "src/file.ts",
"line": 12, "text": "Feedback" }]` and thread `replies` with the displayed `reviewHead`. The path
and positive one-based line are the displayed diff anchor.

`review-submit` carries the existing `ReviewSubmission` object from `src/pr-review/page.ts` as
its `submission`. That object holds `tandemPrReview: 1`,
`verdict: "comment" | "approve" | "request-changes"`, `summary`,
`drafts: [{ id, decision: "post" | "drop" | "undecided", body? }]` and
`yours: [{ file, line, body }]`. Beside it go the required `reviewHead` and `reviewGeneration`.
Both are copied from the displayed `PrPaneView.review.head` and `.generation`. Generation is a nonnegative
safe integer, including zero. Missing or invalid bindings are refused. The service checks both
against the latest authoritative round and checks the re-review task generation before applying
choices. A revision-checked `pendingPost` claim binds those choices before posting, and a lost
CAS never sends a POST. Network calls run outside the global store lock. A short receipt
transaction updates only the exact reviewed head and generation, preserving concurrent changes
and newer rounds. See the [posting contract](pr-review.md#show-edit-post). Stale pane choices
cannot become a review of a newer round even when draft ids repeat. The CLI reuses the
pinned-HEAD and no-double-post checks of the review page, and the renderer does not publish
directly.

`restart` names the task and goes through central recovery. `steer` names the task and carries
the user's direction as `text`. Renderers only collect input and call `rt.act`.

## No retries

Nothing in the native path retries an action or an open. An uncertain outcome never authorizes
another invocation:

- `rt.act` sends each click once. A handled link stays handled on failure.
- `tandem native act` turns every failure into one outcome.
- `layout.luau` never retries a failed stage.
- `host.ts` never redispatches a ticket. A new click is a new ticket.
- A browser open is never re-invoked, whatever its outcome.

A view that may exist stays where it is, and its ticket keeps new opens for that coordinator
paused until evidence or `tandem fix` settles it.

## Staged opens

`src/terminal-backend/tern/host.ts` owns every staged open. It writes a private ticket
`<home>/tern/<projectKey>/open/<coordinatorKey>.<token>.ticket.json` and runs `tern open` on it
through `mutate`. `window.luau`'s open route hands the ticket to `tern-plugin/layout.luau`. That
module writes exactly one `<coordinatorKey>.<token>.receipt.json`. The receipt is `done` with the
exact pane, tab and session, or `failed` with its stage, the number of layout effects it applied
and a reason. Tern
0.5.0 reports handled layout routes as "cannot open in a file block", even after opening them, so
only the receipt and a scoped listing decide. An exit-0 block list is corroboration. No title
proves ownership.

### Ticket lifecycle

A ticket is first written without `expiresAt`. That ticket is only claimed. The read-only exact
coordinator check runs next, so a failed or malformed read drops only its own claimed ticket.
Immediately before the first effect (focus), the host rewrites the ticket with `expiresAt` ten
seconds ahead. The click then waits up to five seconds for a whole receipt. The pure
`decide(ticket, receipt, listing, now)` gives every ticket one answer:

| Ticket | Answer |
| --- | --- |
| Claimed, nothing dispatched | Drop it |
| Dispatched, no whole receipt, not expired | Wait. The click reports an unknown outcome after five seconds |
| Receipt `done`, exactly one matching block | Settle as opened |
| Receipt `done`, no matching block and the receipt's pane gone | Settle as closed by the user. The click says "The Tandem view closed before Tandem confirmed it. Open it again." |
| Receipt `done`, anything else (duplicates, detached blocks, another pane or tab, a replaced or closed origin still present) | Quarantine |
| Receipt `failed` with zero effects | Settle as not opened. The click says "The Tandem view did not open and nothing changed. Open it again." |
| Receipt `failed` with effects, or no receipt after expiry | Quarantine |

`tern.fs` has no rename, so a receipt that does not parse whole counts as no receipt. Settling
removes the receipt, then the ticket, so an interrupted settle is decided again. The click, the
coordinator's view publication tick (`views.recover`) and `tandem fix` all decide retained
tickets, so a late receipt settles without another click. The tick skips a coordinator whose open
is in progress instead of waiting for its lock, so a click never stalls publication. Recovery
also removes a receipt whose ticket `tandem fix` already abandoned.

The host holds one lock per coordinator key for the whole open. Inside it, the host decides the
coordinator's retained tickets first. Any ticket still waiting or quarantined refuses the open.
Browser opens run under the same lock and refusal but write no ticket. Nothing can later prove
or disprove a browser opening, so the click either confirms the new block or reports once that
Tern did not confirm it. No browser outcome pauses later opens.

Return to the orchestrator stays a safe exit. When a retained ticket refuses the open, the return
only focuses the exact recorded coordinator, keeps every view and ticket, and shows the warning
that new native views stay paused. `tandem fix` lists every retained ticket with its reason and,
with `--yes`, abandons one only after proving its coordinator exactly present or exactly gone. See
[quarantine and `tandem fix`](terminal.md#quarantine-and-tandem-fix).

### Layout stages

`layout.luau` interprets one ticket. `route.open` consumes it immediately, and every read and
layout step after that runs in its own 1 ms one-shot timer with the fresh `WindowCx` of that
callback. Each stage checks the ticket's `expiresAt`, then rechecks the exact coordinator and
origin panes, then applies one effect. Focus and block creation share one callback, so navigation
between stages cannot change the destination. `appliedEffects` counts every create, move, resize,
float, dock, close and command that ran. Focus alone is not counted.

Every exit writes the receipt exactly once: `{status:"done", paneId, tabId, sessionId}` or
`{status:"failed", stage, appliedEffects, reason}`. That includes an error inside a timer
callback and a window that closed between stages. A failure also shows the toast "Tandem view did
not open" with its reason.

Tern's raw `close` returns nothing and retires the pane after the callback returns. Every close
therefore polls the exact pane id in later stages, 50 ms apart for at most one second, and
continues only once the pane is absent. A pane that stays fails the open after its effects.

Panel sizing measures the live divider after placement. A one-cell move calibrates the current
usable layout, then a separate stage targets 45 cells (about 360 pixels at the default font).
Horizontal ancestor ratios translate nested dividers into actual pane width when other views are
already beside the conversation. Daemon and pre-split column counts are ignored, including those
of hidden project tabs. The host checks the result within one cell before writing its receipt.
An unavailable, changed or clamped divider fails the open with its applied effects, so the ticket
and panes stay quarantined.

Back rereads the previous task in the same callback before closing a task picker or docking the
coordinator. A disappeared task, a changed kind or tab, or a newly floating task refuses the
effect and keeps the originating view and its ticket.

### Placements

These are the block kinds and their placements. `VIEW_KINDS` also lists `prs`, which has no
block: Show PRs opens the project's first cached `tandem.pr` instead.

| Block | Input | Placement |
| --- | --- | --- |
| `tandem.panel` | Root index | Left of the coordinator, about 360 pixels |
| `tandem.task` | Task detail | Conversation area, keeping its live coordinator |
| `tandem.task-picker` | Root index | Disposable split beside the conversation |
| `tandem.brief` | Brief detail | Beside the conversation |
| `tandem.pr` | PR detail | Beside the conversation |
| `tandem.board`, `tandem.usage`, `tandem.catchup` | Root index | Own full-window tab |
| `tandem.welcome` | Root index (static welcome) | Beside the conversation |
| `tandem.setup` | Setup detail, `setup-setup.json` | Beside the conversation |
| `tandem.setup` (settings) | Setup detail, `setup-settings.json` | Own full-window tab |

Task, brief and PR `views.open` calls keep their durable identifiers. Board, usage, PRs and
catch-up use `view:{kind:"board"|"usage"|"prs"|"catchup"}` with the same coordinator, home, cwd
and origin context.

Panels, splits and the root Board, Usage, Catch-up and PR list views reuse exactly one block
launched with the same program and block arguments in the intended tab placement. Duplicate
matches refuse. A window-scoped lookup also reads the daemon-wide listing before concluding
absence, and a block launched for another window key refuses reuse. Detached blocks, or matching
blocks outside the owning session or window, refuse an open. They never authorize a duplicate.
Reused root views focus the existing pane without another layout opening. Native brief opens
derive the stable detail filename and reuse exactly one matching split across revisions, without
running a pager. Repeating an open creates no duplicate.

Task replacement and return also require the listing to show the replaced task pane and any
closed full-window origin absent, with no detached ambiguity, before a `done` receipt settles.

### Window scope

The optional window key is an opaque Tern control-window key, never a pane, tab or session id.
It is included only when `TERN_WINDOW_KEY` is known, because `WindowCx` has no documented key
accessor. A supplied key is scoped independently and must contain the exact coordinator and
origin panes. Without a key, exactly one attached window is required, and the origin is proved in
that scope. Several windows are refused rather than choosing one by ordering. Luau's layout API
uses numbers, so ids outside JavaScript's safe integer range are refused before an open.

### Closing and returning

`views.close({coordinator,cwd,home,origin,view:{kind:"brief",requestId}})` retires only the
exact originating native brief split. The caller checks the durable revision and completes
approval or feedback first. Close errors become warnings on a successful action, never retries.
The close goes through `mutate`, which proves the block's program, all launch arguments, scoped
session and idle state. After the final process read, immediately before closing, it rechecks
exact identity and full arguments. It then checks the close acknowledgement and absence. Missing blocks
count as closed. Unknown outcomes are quarantined against the brief pane. Automatic request
projection uses the existing `reviewPane` receipt fields for the native split. A manual native
action does not register a Markdown projection. The shared `projectRequestBriefPane` and
`closeRequestBriefPane` entry points select this native path when the terminal has `views`,
including the coordinator's `reviewRequestBrief` action after feedback.

Panel close records a durable quarantine against the panel pane in `mutate` when verification
fails, so no later process closes it again. It refuses detached placement before the effect. A
unique recorded coordinator must bind the panel's session, tab, worktree cwd and block arguments.
The conversation itself cannot be closed as a panel. The full program and argument proof runs
again after the idle process read, immediately before the close. Changed or foreign programs or
arguments refuse without closing anything. The recorded binding stays usable when retirement has
already closed the coordinator pane.

The host launches renderer blocks and task replacements with `keep_open=false`. With
`keep_open=true`, `cx:exit(0)` leaves the exited pane, which can still report `live=true`.
Neither `live` nor `exited` proves closure. Only the exact pane id's absence from a scoped
`tern ls` does. For a split's local × control, `cx:exit(0)` removes that exact block on Tern 0.5.0
with this setting. `BlockCx` has no other close API, and renderers do not use the window-level
layout close. Task pages use the Orchestrator return instead, which restores the hidden
conversation before removing its replacement block.

The task page, the task picker, Board and Usage return to the conversation through `open` with
`ref:{kind:"orchestrator"}`. When the coordinator is floated, the host proves its
exact task block by program, coordinator and index launch arguments before docking the
coordinator and closing that task. Returning from Board, Usage or Catch-up also closes only its
exact idle originating block. The backend proves all launch arguments before the return and the
exact pane's absence afterward. Brief and PR panes stay open on return. `open` with kind `board`
toggles back when its exact originating block is this project's board, through the same return.
Other origins open the board normally. Renderers never parse Tern program metadata or guess pane
ownership.

## Views

The package registers Panel, Welcome, Task, Task picker, Brief, PR, Board, Usage, Catch-up and
Setup.
The authoritative, readonly TypeScript model schema is `NativeViews` in
`src/board/native-views.ts`, with the domain schemas linked below. Every field is JSON, including
timeline events and cost receipts. No Maps, Sets, undefined values, credential data, provider raw
payloads, validation stdout or stderr, or HTML are written. Optional fields are omitted. All
timestamps are ISO strings, milliseconds are numbers and costs are integer USD micro-dollars.
`"unavailable"` is a literal marker and is never rendered as zero.

```ts
{
  version: 1,
  project: string,                // original repoPath, not the pinned coordinator worktree
  writtenAt: string,
  summary: NativeProjectSummary,  // this project's own counts and coordinator session only
  changeSignature: string,        // SHA-256 of meaningful saved changes, excluding timers
  panel: NativePanelView,
  projects: NativeProjectRow[],
  tasks: Record<taskId, NativeTaskIndex>,
  briefs: Record<requestId, NativeBriefIndex>,
  pullRequests: Record<"owner/repo#N", NativePrIndex>,
  board: NativeBoardView,
  usage: UsageView,
  catchup: NativeCatchUpView,
  warnings: string[]
}
```

### Index summaries

Schemas: `src/board/native-views.ts`, `NativeProjectSummary`, `NativeTaskIndex`,
`NativeBriefIndex`, `NativePrIndex`, `NativeDetail`, `NativeViewsPublication`.

```ts
NativeProjectSummary = {
  repoPath:string, name:string, writtenAt:string,
  running:number, needsYou:number, ready:number, done:number, sessionId?:string
}
NativeTaskIndex = NativeTaskSummary & {detailFile:string}
NativeBriefIndex = {
  requestId:string, title:string, revision:number, changes:number,
  approvalState:"unapproved"|"current"|"superseded", abandoned:boolean,
  commentCount:number, detailFile:string
}
NativePrIndex = {header:PrPaneView["header"], readAt:string, detailFile:string}
// In-process publication metadata, never the file envelope:
NativeDetail =
  {version:1, project:string, kind:"task", data:TaskPageView} |
  {version:1, project:string, kind:"brief", data:BriefView} |
  {version:1, project:string, kind:"pr", data:PrPaneView}
```

`NativeTaskSummary` contains `{taskId,title,stage,createdAt,updatedAt,previousStage?,model?,
harness?,branch?,costMicros?,unpricedSamples,pullRequest?}`. No timeline, findings, brief lines,
conversation, patch or tour is embedded in these index entries. `NativeViewsPublication` is the
in-process `{bundle:NativeViews,details:{file,view:NativeDetail}[],retainedDetailFiles?:string[]}`
returned by `NativeViewsReader`. Retained filenames identify live PRs awaiting a cached detail.
It is not a file schema. The writer uses each detail's `data` as the file envelope's `model`. It
refuses detail paths that escape the project directory or publication metadata belonging to
another project.

Each coordinator publishes only its own `model.summary`. At write time it reads the other
projects' `state.json` `published.summary` through `readProjectSummaries`, checking that each
names its own project and directory key. The switcher is computed from these published
summaries, with no foreign task-store projection or coordinator record writes. Only projects
with a valid published summary appear. A summary more than ten seconds old shows offline, keeps
its last known counts and omits its stale focus session. Missing or malformed foreign summaries
never become invented zero counts. Malformed summaries add a warning. Reading and publishing this
project's index never rewrites another project's files.

Only coordinators that host native views publish a session id. The controller passes the native
publisher a map from repository to session id built only from coordinator records whose stored
endpoint names the active terminal, and publishes only when that terminal has `views`. Foreign
and untagged identifiers never enter a native model. A summary whose fields do not match the
strict schema is refused. Stale rows omit their session id. Task, brief, PR, board and catch-up
models emit no pane or workspace ids. Task, request and thread ids are their domain identities,
not terminal identifiers.

### Panel and project switcher

The panel header shows `tandem ▾`, the count of other projects that need you, the 5-hour meter
and label, the bell count, and PRs, Board and Settings (⚙) buttons. The panel always shows the PRs,
Board, Settings and usage buttons, whatever the user decided about shortcuts. Rows open their
task, brief or PR target through `open`. The Settings button opens `ref:{kind:"setup",
mode:"settings"}`. The bell opens Tern's inbox through `open` with `ref:{kind:"inbox"}` and
marks alerts read.

The project dropdown targets each online row by `project` with `target:{repoPath}`, including
rows after nine and after order changes. The CLI resolves the unique published identity, checks
freshness and offline status, re-proves the destination coordinator, and focuses it with an
exact-block session switch. Numeric targets 1–9 are the keyboard shortcut slots, and `prev` and
`next` wrap the list. "+ Open another project…" sends `open-project`, which asks the verified
coordinator to open one.

Schemas: `src/board/panel.ts`, exports `NativePanelView`, `NativePanelRow`,
`NativeProjectRow`, `NativePanelTarget`. Pure builders: `nativePanelView`,
`nativeProjectSwitcher` (snapshot-based), `nativeSummaryProjects` (published-summary based).
The service uses the published-summary builder. The existing `panelView` and text targets keep
their behavior.

```ts
NativePanelView = {
  header: {
    title: string, project: string, projects: NativeProjectRow[],
    otherProjectsNeedYou: number, bellCount: number, fiveHour?: LimitMeter,
    fiveHourLabel: string // whole percent used; numeric meter keeps provider precision
  },
  sections: { title: "Needs you" | "Running" | "Ready" | "Recently done",
              count: number, rows: NativePanelRow[] }[],
  footer?: string
}
NativeProjectRow = {
  repoPath: string, name: string, current: boolean, offline: boolean,
  running: number, needsYou: number, status: string,
  shortcut?: string, sessionId?: string
}
NativePanelRow = {
  key: string, title: string, state: "yellow" | "red" | "blue" | "magenta" | "green",
  stage: string, time?: string, model?: string, detail: string, secondary: string,
  target: {kind:"task",taskId:string} | {kind:"brief",requestId:string} |
          {kind:"pr",repo:string,number:number} | {kind:"none"},
  pullRequest?: {repo:string,number:number,url:string,draft:boolean}
}
```

Draw title, state, stage and time on line one and `secondary` on line two. `detail` contains live
activity or the saved stop reason. To-dos stay on the task page. PR metadata supplies clickable
numbers. Active tasks with draft PRs stay in Running and are not duplicated as a Ready row. Row
keys keep the represented identity: `task:ID`, `brief:ID` or `pr:owner/repo#N`. A failing watched
PR keeps its PR key and target even when its linked task also needs attention. Board cards reuse
these keys, and row actions use their task, brief or repository-qualified PR target. All four
section containers exist, including empty ones. Project switcher status includes offline and
counts, with shortcuts for the first nine projects. The renderer owns the footer's open-project
and previous and next controls. The compact meter uses the lowest known remaining percentage
among the account 5-hour limits.

### Panel bell and read cursor

The bell is the originating project's confirmed Tandem alert deliveries since its user read
cursor, kept beside the transition cursor in the project's `state.json` `alerts`. Only successful
`notify` calls increment `delivered`: needs-you (including brief revisions and PR-watch rows),
done (a new draft PR) and stuck. Initial historical baselines, coordinator delivery backlogs,
coordinator acknowledgements, failed or uncertain notification calls, and unrelated Tern or OMP
notifications do not count. Claimed unknown deliveries are never retried.

Opening the inbox through this project's panel bell, or activating its owned inbox helper and
focusing its coordinator, marks the deliveries captured before navigation as read. The lock
merges that cursor with later deliveries, so arrivals during navigation stay unread. This clears
the bell without dismissing tasks or changing coordinator acknowledgements. Tern's own grouped
inbox count can differ: it keeps grouped history and unrelated alerts and has no plugin read or
clear event. Clearing an entry only through Tern's built-in inbox control therefore does not
clear Tandem's bell. Cursor state survives coordinator restarts. Corrupt cursors refuse
publication rather than inventing a zero.

### Transition alerts

The native publisher consumes durable task timeline events for questions, approval waits and
blocked transitions. It observes new draft PR identities for `done`, and new brief or failing-PR
Needs you rows. Model-routing questions use their stable routing-decision row identity, including
queued admission waits and questions raised during an active task stage. Their claimed
identities survive temporary row absence, wording changes and coordinator relaunch. Timeline
admission waits do not emit a duplicate alert. The per-project delivery cursor in `state.json`
`alerts` is saved under the project lock before the OSC is sent. Repeated ticks, relaunches and
unknown delivery outcomes never resend a claimed transition. The first snapshot establishes a
baseline without replaying historical alerts. These cursors are presentation state, not task
authority. The helper pane that prints the alert is described in
[terminal.md](terminal.md#tern-mapping).

### Task page

`open` with `ref:{kind:"task",taskId}` opens the task in the coordinator's same recorded tab. The
live conversation is floated and hidden, keeping its endpoint and process. Opening another task
proves the previous task block's coordinator and index launch arguments, replaces only that
block, and keeps the floated coordinator in its recorded tab. Unrelated pictures in picture
refuse task replacement. Orchestrator docks the coordinator and closes only the exact task block.
It never closes or restarts the agent. The sidebar panel stays available.

`task.luau` draws the task detail as `tandem.task` and also watches the root index, `args[3]`.
Brief and PR detail references are project-relative filenames that resolve beside the shown task
detail file.

- The header shows the task's model, elapsed time, branch, current activity and stage track,
  including skipped validation and review stages and the fix-round budget.
- All six tabs stay visible. Overview has the objective, worker to-dos and five recent events.
  Brief shows saved lines and opens the separate pane for approval and comments. Progress shows
  the timeline, validation evidence and findings. Diff and PR embed the shared PR controls,
  guarded by matching task, index and detail data and the displayed HEAD. Missing related data
  has an empty state. Cost shows the recorded receipt, with unknown samples labeled unavailable.
- Blocked tasks offer Restart through central recovery and Steer into the worker-message editor.
  Send uses `steer`. A refused send keeps the unsent message and shows the notice, with no retry.
  A successful send clears the editor.
- Malformed detail files keep the last readable page and disable its actions until a valid file
  returns. Orchestrator return stays available.

Schema: `src/tasks/page-view.ts`, `TaskPageView`, pure builder `taskPageView`. Input: `TaskRecord`,
matching task and generation `TaskInspection`, `StoredTimelineEvent[]`, worker activity, the
actual routed model when available, and `TaskCostView`. This model is the `model` inside the task
file envelope.

- `header`: `{id,title,stage,elapsed,returnLabel,model?,harness?,branch?}`.
- `rightNow`: `{text,since?,age?}` using the shared panel tool vocabulary.
- `stageTrack`: `{stage,label,state:"done"|"current"|"pending"|"skipped",round?:{used,max}}[]`.
  Implementation tracks Implement, Validate, Review, Fix and Ready. Research and review tasks use
  their own stages. Skipped required stages are explicit, and fix rounds come from the inspection
  budget.
- `tabs`: always Overview, Brief, Progress, Diff, PR and Cost, in that order. Missing related data
  renders a read-only empty state. `requestId?` and `pullRequest?` link other models in the bundle.
- `overview`: `{summary,todos:TodoItem[],done,total,recent:StoredTimelineEvent[]}`. Recent is the
  last five events, newest first. To-dos appear only here.
- `progress`: `{events:StoredTimelineEvent[],unreadableEvents,checks:{name,passed,head,contract}[],
  findings:FindingLedgerEntry[]}`. Events keep sequence, times, fix rounds and detail references.
  Findings keep severity, description, optional file and line, status and HEAD and generation
  evidence.
- `cost?`: `TaskCostView`, described under [usage](#usage).
- `stuck?`: `{reason,actions:["restart","steer"]}` only for blocked tasks.
- `message`: `{placeholder,model?}`. Actions go through normal task controls and central recovery.

### Task picker

**Tandem: Open task…** in the palette sends `open` with `ref:{kind:"task-picker"}`. The CLI proves
the running coordinator, then opens `tandem.task-picker` against the root index in a disposable
split. Search matches title, id or stage without case sensitivity, and results sort by title.
Arrows select, and Enter or a click opens the task. Success closes only the picker. Cancel or
Escape uses the guarded return to close only that picker. It focuses the existing task page when
the coordinator is already floated, and the conversation otherwise.

### Reply links

OMP and Claude Code coordinator adapters append a compact OSC 8 reference row after an assistant
reply mentions a known project task, brief or PR. Task references need an explicit task id. PR
references need an explicit PR number, a native route or a saved PR URL with one owning task.
Titles, bare counts, issue numbers, duplicate identities and foreign records do not resolve. Only
an unambiguous inherited Tern pane context enables the row, and OMP also needs interactive TUI
mode. Herdr output and model reply text stay unchanged. `nativeLink` writes
`tandem://task/ID`, `tandem://brief/ID` and `tandem://pr/NUMBER`. `window.luau`'s link route turns
each into an `open` from the focused pane and cwd, and the CLI rechecks project and ownership at
click time.

### Brief pane

The brief pane and its loading, feedback and retirement behavior are described in
[request-briefs.md](request-briefs.md#native-brief-pane). When the terminal has no `views`, a
brief opens in its request review pane instead.

Schema: `src/requests/native-view.ts`, `BriefView`, pure builder `briefView`. This model is the
`model` inside the brief file envelope.

```ts
{
  requestId:string, title:string, revision:number, changes:number,
  approval:{briefRevision:number,contentDigest:string,agreementDigest:string},
  approvalState:"unapproved"|"current"|"superseded", abandoned:boolean,
  lines:{id:string,number:number,section:string,kind:"heading"|"text"|"item",
         text:string,isNew:boolean,comments:BriefComment[]}[],
  commentCount:number, browserUrl?:string
}
BriefComment = {id,requestId,briefRevision,contentDigest,lineId,body,author,at}
```

The current draft is compared with its immediately preceding revision using a section-aware
longest common subsequence. Insertion does not mark shifted unchanged lines NEW. `changes` is the
larger of the added and removed line counts, so deletions count too. First drafts have zero
revision changes. Comments must match request, revision, content digest and line id. Old comments
never reattach to a different revision. The approval payload identifies exactly the visible
draft, and the action handler still rechecks the authoritative revision and both digests.
`file.model.approval` supplies the three identity fields of `brief-approve`. Copy them untouched
beside `requestId` from `file.model.requestId`. All three values come from the same draft that
produced the visible lines, including its agreement digest. `brief-request-changes` takes the
same identity fields plus optional `text` and `comments:[{lineId:string,text:string}]`. Copy
`lineId` unchanged from the displayed `lines[].id`. `number` is presentation only and never an
action anchor. See [native brief feedback](request-briefs.md#native-brief-feedback). The builder
accepts comments and a browser URL. Native comments are delivered through the CLI to the
coordinator, and local drafts stay transient in the renderer until sent.

### PR pane, diff and tour

`open` with a PR `ref` opens the PR pane. Cached watched PRs without a task open read-only by
`repo` and `number`, without creating a task. Show PRs (`open` with `ref:{kind:"prs"}`) opens the
project's first published PR.

`tern-plugin/pr-model.luau` exports the PR model types.
`taskDetailPath(taskPath, taskId, index)` resolves exactly one `header.taskId` association
supplied by TypeScript to its sibling PR file. Missing or ambiguous associations and unsafe
relative filenames return `nil`. PR numbers alone are not associations.
`forTask(cx, taskPath, taskId, index)` returns an `rt.watch` of that file, or `nil` when there is
no safe association. The task page shows the PR only while the loaded model names the same task.
Use `taskDetailPath` before reusing an existing watch, or `rt.unwatch` it when the path changes.
Pass the task model's `header.id` and the ready index model.

`tern-plugin/pr-content.luau` exports `create`, `view`, `event`, `key` and `ready`.
`view(state, model, ready, prefix?, strip?)` returns `{main,dock}`. Mount `dock` for the review
summary, explicit verdict and Post controls. Set `prefix` to the actual embedded content root
(default `main.content`). The shared diff uses it for comment focus and thread reveal. The
optional strip is drawn inside the PR header. `pr-diff.luau` exports `create`, `view`, `rows`,
`jump`, `event` and `key`. Both modules use `pr-model.luau` wire types. For the task's Diff tab set
the content state's `tab="Diff"`, and for its PR tab set `tab="Description"`. Pass readiness from
both the task or index view and the PR detail view to `view` and `event`. Keep the same content
state while navigating to preserve local drafts.

The shared `Invoke` takes an action table and a completion that receives the `Outcome`, or nil
when none arrived. For `review-submit`, callers invoke the completion after every settled outcome,
including a refusal, a busy origin or a spawn failure. Content clears `posting` on completion,
keeps drafts unless the outcome is `done`, and marks `submitted` only then. The
`review-unconfirmed` notice shows the service message verbatim. It keeps the distinct guidance for
a definite refusal and an uncertain post, including the confirmation needed to recover an
uncertain post. The standalone PR block calls `cx:exit(0)` only after that confirmed posted
outcome, as it does for its close control. Embedded content records success locally, and its task
host owns navigation. Draft decisions and new review comments stay local until Post.

Include `pr.css` with the foundation stylesheet. The pane uses Tern's native surface scrolling
for wheel and keyboard input, and the review dock stays visible while the content scrolls. PR
line numbers use a muted text color rather than element opacity, which avoids a compositing
target per visible gutter in Tern 0.5.0. Running CI uses the stable `checks[].startedAtMs` epoch
timestamp derived by TypeScript from `startedAt`. Content state anchors wall time once to
`tern.now()` and supplies the current age only when drawing an `elapsed` node. Tern then ticks
the text itself. No Lua timer is scheduled for CI.

Schema: `src/pr-review/native-view.ts`, `PrPaneView`. Input schema: `CachedPullRequest`. This
model is the `model` inside the PR file envelope. Pure builder: `prPaneView`. Effectful cache
read: `src/pr-watch/native-cache.ts`. Tour chapters and stops reuse `ChapterInput` and
`TourStopInput` from `src/pr-review/page.ts`. The HTML review page and the native view share
`parsePatch` in `src/pr-review/patch.ts`.

- `header`: `{repo,number,title,url,head,draft,next,taskId?,commits,additions,deletions,
  unresolved,firstThreadId?}`. `next` comes from the saved PR-watch note, with a draft fallback.
- `readAt`: timestamp of the last complete cached GitHub read.
- `tabs`: Description, optional Tour, Diff. Tour appears only with chapters.
- `checks`: `{name,state:"passed"|"running"|"failed"|"pending",startedAt?,completedAt?,
  logUrl?,duration?,startedAtMs?}[]`. TypeScript computes completed durations and a stable epoch
  millisecond timestamp from a running check's `startedAt`. There is no sampled publication clock
  or running age in the model. A clock-only publication leaves running and completed CI detail
  bytes, inode and modification time unchanged.
- `description`: `{markdown,blocks:string[],conversation:PrComment[]}` for top-level comments and
  reviews. Markdown blocks keep fenced-code blank lines, and each block becomes one native
  Markdown node.
- `tour`: `{title,why,stops:(TourStopInput & {rowIds:string[]})[]}[]`. `rowIds` selects the
  existing diff rows touched by the stop's new-side inclusive range.
- `files`: `{path,additions,deletions,commentCount,rows:{id,row:DiffRow,threads:PrThread[],drafts:DraftComment[]}[]}[]`.
  `DiffRow` is `{kind:"add",text,new}`, `{kind:"del",text,old}`, `{kind:"ctx",text,old,new}`,
  or `{kind:"hunk",oldStart,oldCount,newStart,newCount,label}`.
- `PrThread`: `{id,file,line?,side:"LEFT"|"RIGHT",resolved,outdated,comments:PrComment[]}`.
  `PrComment`: `{id,databaseId?,author,at,body,url?}`. A thread includes its replies in order.
- `unanchoredThreads`: outdated, non-hunk and deleted-file threads, still readable.
- `commentDestination`: `"worker"` for Tandem's PRs, `"review"` for pr-review tasks and
  `"read-only"` for taskless watched PRs. Taskless views include a plain `readOnlyReason` and omit
  worker, comment and review actions.
- `review?`: `{taskId,generation,head,currentHead,posted,verdict?,intent,summary,
  drafts:DraftComment[],concerns:ReviewConcern[],notes:string[]}`. Drafts also attach to their
  new-side diff row and keep their ids and severity for posting choices. The reviewed diff and
  posting identity stay pinned to the recorded round. Checks and threads from another head are
  not attached to it. Posting rules stay in pr-review.md and the action handler.

Reply editors keep `{threadId,commentId,replyTo}` from the selected thread's root comment.
`commentId` is the exact GitHub node identity and `replyTo` its REST `databaseId`. Two threads on
the same line stay distinct. Outdated and unanchored threads offer Reply too. Native review
submission keeps `replies:[{threadId,commentId,replyTo,body}]` separate from `yours` root
comments. Worker feedback accepts the same replies plus `reviewHead`. TypeScript checks the live
thread and keeps its root, file and optional line in the worker direction. PR palette and
switcher navigation use the repository-qualified identity.

GitHub reads are cached inside Tandem, with paginated review threads and replies. The cache
checks HEAD before and after the diff, refusing a moving PR rather than mixing anchors. Failed
reads keep the last successful in-process cache and add a warning. Views never make network
calls.

### Board

`open` with `ref:{kind:"board"}` opens a full-window tab with four view-only lanes: Working, Needs
you, In review and Ready to merge. Cards show harness, title, branch, reason, age, model, cost,
linked PR and any stuck flag. There is no drag, task creation or merge control. Unknown branches,
models and prices stay explicit. A PR click sends `board-link` with the card key. The CLI resolves
it only against `published.boardLinks` of the originating project and opens Tern's browser
through `mutate` with the exact coordinator as owner. The URL must be HTTPS, and the new browser
block must be confirmed in that coordinator's recorded session. Board toggles back from its exact
originating Board block.

Schema: `src/board/native.ts`, `NativeBoardView`, builder `nativeBoardView`.
`{viewOnly:true,returnLabel,lanes:{title,count,cards:NativeBoardCard[]}[]}`. Lane titles, in
order: Working, Needs you, In review, Ready to merge. A card extends `NativePanelRow` with
`{harness?,harnessGlyph?,branch?,costMicros?,costLabel?,unpricedSamples,stuck}`. The TypeScript
builder supplies the harness glyph and cost label and keeps unknown pricing. A blocked review
stays in In review with a stuck flag. Fixing findings stays in Working. The model supplies no
drag, mutation or merge action.

### Usage

`open` with `ref:{kind:"usage"}` opens a full-window tab. Provider and account limits come first,
with 5-hour and weekly meters, reset labels, original fetch timestamps and refresh warnings. Then
come today's cost, agent time and finished-task count, weekly spend, model-cost charts for today
and this week, and stage times. TypeScript supplies labels and chart widths. Unknown limits,
unpriced usage and unreadable ledger rows never become invented zero totals. Quota labels use
whole percentages, and the numeric meters keep provider precision.

Schemas: `src/runtime/usage-view.ts`, `UsageView`, `LimitMeter`, `TaskCostView`. Builders:
`usageView`, `taskUsageView`. Effects: `src/harness/omp/usage-limits.ts` reads
`omp usage --json`, validates it with pi-ai's usage schema and uses its fraction normalization.
Only that adapter imports pi-ai. Raw payloads, metadata, keys and tokens never leave it.

- `limits`: `{provider,account,window:"five-hour"|"weekly",label,
  remainingPercent:number|"unavailable",resetsAt?,fetchedAt,resetInMs:number|"unavailable"}[]`.
  Group meters by provider and account, and show limits before cost. Percentages are clamped to
  0–100. Email-shaped account identities become stable `provider-<12 hex digest>` labels. Friendly
  non-email account labels stay readable. Metadata emails never reach the native files.
- `today`, `week`: `{costMicros,unpricedSamples,agentMs,tasksDone}`.
- `byModel`: `{provider,model,today:UsageTotals,week:UsageTotals}[]`.
- `byStage`: `{stage:RequestWorkKind,todayMs,weekMs}[]`.
- `malformedEvents`: unreadable usage-row count.
- `display?`: `UsageDisplay` from `src/runtime/usage-display.ts`, supplied by `usageView`. It
  groups account meters (5-hour before weekly), formats reset countdowns and totals, and supplies
  model and stage labels and proportional model-cost widths for the renderer. Meter `fetched`
  labels keep each provider sample's original `fetchedAt`, and `updated` labels the root
  snapshot's `writtenAt`. `NativeViewsReader` supplies root `warnings` as `limitWarnings`, shown
  beside the account meters before cost totals. A failed refresh keeps old quota and reset data
  and shows the failure or staleness warning with its fetch time. Timestamps are formatted in
  TypeScript as UTC labels. Luau draws them without computing freshness policy. Unknown limits
  and unpriced usage stay explicit. Raw totals stay available for other views.
- `TaskCostView`: `{taskId,recorded,charges:AdditionalCharges,tokens:TokenTotals,
  quota:IncludedQuota,timing:ReceiptTiming,breakdown:RequestUsageBreakdown}` from
  usage-receipt.ts. Unrecorded task cost has `recorded:false`, and no task intake is invented.

Today starts at local midnight, and this week starts at local Monday midnight. Pure builders
receive explicit start timestamps. Ledger events are deduplicated by event key, including shared
request scopes. Settled operations credited to both scout or task and request scopes are counted
once by their durable operation identity. Agent time sums settled work durations, clipped at the
window boundary, and parallel workers count independently. Provider samples do not duplicate
time. Done counts use the first saved delivery or completion timeline event, never a later
record's update time. Price provenance stays in task receipts, and unpriced samples are counted
beside the known cost floor.

Escape or Orchestrator returns from Board and Usage through the guarded return, restoring the
conversation and retiring only that idle view. Screens call `cx:exit(0)` only for a `done`
outcome. A `refused` or `kept` outcome keeps the originating pane. Last readable data stays
visible on a file error, with a warning. Data-bound links and actions need a ready view, while
returning stays available.

### Catch-up

Catch-up opens on project entry, including inbox activation, after **1+ hour** since last
visibility, only with a known prior signature and a meaningful change. First visits, unchanged
work and timer-only repaints stay quiet. The full-window card lists merged PRs, Needs you,
blocked work and saved workstream notes. Dismiss or Escape sends `catchup-dismiss` and returns to
the conversation. Open what needs me sends `catchup-open-needs`, which returns, then opens the
first saved brief, task or inbox destination. Dismiss and Open what needs me acknowledge the
current signature only after confirmed navigation. A merged PR click sends `merged-link`,
resolved only against `published.merged`.

`tryShowCatchUp` in `src/memory/native-visits.ts` wraps the guarded `maybeShowCatchUp` trigger
with the single non-fatal boundary shared by every entry path. Visible front-door launches and
reconnects, `coordinator/open-project.ts`, dropdown and shortcut switches, and window focus
entries (including inbox helper activation) invoke it. Background launches defer to visible
entry. A catch-up failure never fails launch, reconnect, open-project, project switching or inbox
entry. It shows a warning and leaves the failed visit unacknowledged. Launch and reconnect carry
`catchUpWarning` separately from `panelFailure`, and the front door prints it. Open-project
returns warnings to the conversation. Native entry and switch warnings come back as a `done`
outcome with the `catch-up-unavailable` notice and appear as Tern toasts. Launch, ownership and
focus failures stay outside this boundary and keep their usual errors. No catch-up failure
selects another window or retries an opening. An explicit catch-up opens without the automatic
rule.

`visit` with `event` `entry`, `away` or `visible` is the window's focus lifecycle, carrying the
exact originating pane, cwd and window. `window.luau` queues focus departures and entries in FIFO
order and sends a `visible` heartbeat every minute for the currently selected pane. Each
continuation sends at most one queued job, and drops a job whose pane has closed since it was
queued, such as a task page left by `← Orchestrator`. The CLI proves the running coordinator and the
originating pane in its recorded Tern session before writing presentation state. TypeScript skips
heartbeats unless the saved last-visible time advances by at least one minute, including across
windows. Focus and away transitions can update sooner. Duplicate values skip the atomic write,
and timestamps never move backwards. Only the visit record changes. Lifecycle heartbeats do not
rewrite task authority or view files. These calls never start a task or change policy.
Non-project focus callbacks quietly refuse.

The project's locked `state.json` `visit` record keeps `lastOpenedAt` for entry history and uses
`lastVisibleAt` and the signature for the one-hour gate. Visible heartbeats and departure capture
the current signature, so continuous work for hours followed by an immediate switch back stays
quiet. Visibility means the selected project in a Tern window, not time since launch or keyboard
inactivity. Away time starts when you select a different Tern project or close its last visible
Tern window. Tern 0.5 exposes pane focus, not macOS application activation, so a selected window
counts as visible while another application is active. Another window's heartbeats keep that
project visible. A closed window stops heartbeats, and its last persisted sample is the baseline.
A pulse within a minute of a transition is skipped, so the next persisted sample can lag by
almost two minutes. Old records with no last-visible baseline stay quiet on first entry. Panel
polling never changes visits. The first publication fills a missing signature only.

Schema: `src/memory/native-view.ts`, `NativeCatchUpView`, built from `catchUpView` workstream
models plus saved project records. `{project,merged:RecentPullRequest[],needsYou:BoardRow[],
blocked:{key,name,reason}[],whereWeLeftOff:{workstream,text}[],workstreams:CatchUpView[],
actions:["open-needs-you","dismiss"]}`. Project merges include tasks without a workstream.

`shouldAutoShowCatchUp({now,lastVisibleAt?,previousSignature?,currentSignature})` returns true
only at **1+ hour** since last visibility, with a known baseline and signature and a different
meaningful signature. Invalid dates, repaint and timer changes, and unchanged work stay quiet.

### Setup and settings

`tandem.setup` draws `SetupView` (`src/onboarding/setup-view.ts`), the one pure model of every
choice setup offers, as the detail files `setup-setup.json` and `setup-settings.json`
(`setupFile(mode)`). A full publication never prunes them. `open` with
`ref:{kind:"setup", mode}` computes the view (`service.setupView`), publishes it under the project
lock with `publishViews(home, project, async () => ({ setup }))`, then opens the block. Setup opens
in the `split` placement beside the conversation. Settings opens as a `window` tab, so `isWindowView`
in `src/native/contract.ts` tells the two apart from the detail file: `retire-views.ts` and the
return-origin proof in `host.ts` use it instead of a per-kind table. Settings refuses to open on
the Tandem checkout's coordinator while onboarding is unfinished.
The optional `section` on the ref travels in the published model, not the block args, so the
block's identity and tab reuse do not change: an open Settings tab jumps to the section once per
newer file and keeps its draft. "Tandem: Change models" and "Tandem: Add or edit repositories" send
`models` and `repositories`.

The Tandem coordinator opens the setup block at session start, in the slot where the welcome view
opened, while `remainingOnboardingSteps` is not empty and the terminal has native views
(`terminal.openSetup`; Herdr returns `false` and the chat checklist runs). The chat then says the
setup is beside it, and the coordinator's context says to answer questions, not to ask them. Once
setup is finished the welcome view behaves as before.

The block keeps only a transient draft: model and thinking per role, the chosen repositories with
editable validation and setup command lists, and the bug-report choice. Start (setup) and Save
changes (settings) are disabled while any role has no model, setup has no repository, or a chosen
repository has no non-blank validation command; the bottom bar names the repository. They send
`setup-save` with `answer`, the `SetupAnswer` that `parseSetupAnswer` checks at the CLI boundary
(`mode` is part of it). `SetupWorkflow.apply` revalidates it, saves models, the bug-report choice,
code folders and repositories in order, updates the commands of repositories already set up in
place (`saveRepositoryCommands`) and opens a chat for each new repository (setup mode opens every
chat). Then the model is published again and the coordinator gets one fixed message: "Setup saved.
Chats for <repos> are open in the sidebar." in setup mode, "Settings saved. New tasks will use
them." in settings mode. A partly failed save is `kept` with notice code `setup-incomplete` and the
failed steps. The coordinator then receives those steps instead.

Settings is reached from the palette ("Tandem: Settings", "Tandem: Change models", "Tandem: Add or
edit repositories"), `cmd+shift+,` (`plugin.tandem.settings`) and the panel header.

## Window callbacks

Tern gives window callbacks a 50 ms budget and disables a hook that exceeds it. Doing a whole
layout in `route.open` could disable interception and expose later tickets as ordinary file
blocks. Window contexts never survive their callbacks. These rules follow:

- `window.luau` loads `rt.luau` and `layout.luau` in one-shot timers, never at load or in a hook.
- `rt.act` from a window command launches the process in a fresh timer and handles its result in
  another, each with its own `WindowCx`.
- `layout.luau` runs each stage in its own timer with the fresh context of that callback.
- Commands capture the originating pane and cwd at the gesture.
- A module or launch failure settles the job without retrying an action.
