# Native view data

The data contract for Tern screens. Start with [terminal.md](terminal.md) for the backend
and [tern-views.md](tern-views.md) for hosting and the shared Luau API. All models are computed by Tandem in
TypeScript. The terminal renderer reads the JSON and runs CLI actions. It never fetches
GitHub, provider limits, or the task store itself.

## Store and ownership

`<home>/board-snapshot.json` retains its version-1 shape and Herdr behavior.

`src/native/store.ts` owns `<home>/tern/<key>/`, one directory per project. `key` reuses
`repositoryKey(canonicalRepoPath)` from `src/config/repositories.ts`, the existing 24-character
lowercase key for saved project settings and coordinator session directories, so two checkouts
with the same basename have different directories. The directory holds:

- `views/index.json`, the small index every screen without a detail file watches
  (`viewIndexPath(home, canonicalRepoPath)`).
- `views/task-<encodedTaskId>.json`, `views/brief-<encodedRequestId>.json` and
  `views/pr-<encodedOwnerRepo>-<number>.json`, the detail files
  (`viewDetailPath(home, canonicalRepoPath, detailFile)`). Identifiers use `encodeURIComponent`,
  so each filename is one path segment; PR filenames include the repository.
- `state.json`: the store's `epoch` and `seq`, the alert cursors (`board/native-alerts.ts`), the
  visit record (`memory/native-visits.ts`) and `published`, what the last full publication showed.
  `published` is a cache: a value in an older shape reads as absent, and the next publication
  rebuilds it while keeping `epoch`, `seq`, alerts and visit.
- `open/<coordinatorKey>.<token>.{ticket,receipt}.json`, staged open tickets and their receipts
  (`terminal-backend/tern/host.ts`).

One lock per project (`state.lock`) serializes `views/` and `state.json` across coordinator and
CLI processes; `withProjectLock` is the only way to change `state.json`. Staged opens keep their
own per-coordinator lock in `open/`, because an open holds it while Tern applies the layout, and
publication must not wait for that. For the same reason a project visit decides under the lock, opens
catch-up outside it, and records the visit under it again.

The project's coordinator is the single writer of full publications, scheduled by the existing
`writeBoardSnapshot` service operation, only for a Tern backend. `NativeViewsPublisher`
(`board/native-read.ts`) runs task inspection, timelines and derived-file writes in a serial
background queue. Snapshot ticks enqueue the newest input without waiting for those reads; while a
publication runs, later ticks replace a single pending input. Shutdown drains the last queued
publication and cache reads.

`publishViews(home, project, build)` is the only writer of `views/`. Immediate brief projection
uses it too. It takes the project lock, then builds from fresh durable state, then validates every
model against its schema, and holds the lock through detail writes, index replacement and cleanup.
An older tick therefore finishes before a new brief detail can publish, and a later tick reads the
current revision even with an older board input. Cleanup cannot delete a detail published after the
snapshot it used. Brief opening waits for this writer.

Directories are private (0700); files are 0600. A file is rewritten only when its canonical model
JSON changed, so an unchanged file keeps its inode, modification time and `seq`. Each changed file
uses a unique temporary file and atomic rename. Details publish before the index; there is no
transaction across files. Actions still validate authoritative revision/head bindings. After a
successful index write, the same owner prunes its task/brief/PR detail files for entities no
longer present. Pending provider/GitHub refreshes retain live PRs' last detail until their
replacement is ready. Foreign project files, unrelated files, symlinks and temporary files are
preserved. On failure, the last good files remain readable and `native-views-publish-failed`
diagnostics record the failure. No view file is authority. GitHub and provider cache refreshes run
in a serial background queue, at most once per minute per PR/provider read, with command timeouts.
They never hold up the snapshot. Shutdown drains the queue.

TypeScript never parses a view file to decide anything. Project switching (`published.projects`
and the summary's `writtenAt`, refused when more than 10 seconds old), board and catch-up links
(`published.boardLinks`, `published.merged`), Show PRs and opening a PR by number
(`published.pullRequests`), task and PR detail availability (`published.tasks`,
`published.pullRequests`), catch-up's first need (`published.needsYou`) and visit signatures
(`published.changeSignature`) read `state.json`, written in the same locked publication as the
views. Other projects' rows in the switcher come from their own `published.summary`.

The format never shipped to other users, so the earlier `native-views/`, `native-alerts/`,
`native-visits/` and `native-host/` directories are not migrated or read.

A missing index means no publication yet. A stale `writtenAt` is displayed as stale, as the panel
does. Read-only cached remote data may be older than the index: PRs have `readAt`, limits have
`fetchedAt`, and `warnings` records refreshing/failing sources. The in-memory remote cache starts
empty on a coordinator relaunch and fills in subsequent reconciliations. No empty or failing read
means zero usage or passing CI.

## View files

Every file in `views/` is one `ViewFile` (`src/native/contract.ts`):

```ts
{ v: 1, kind: "index" | "task" | "brief" | "pr", epoch: string, seq: number, model: Model }
```

The index has `kind:"index"` and `model:NativeViews`. Detail kinds are `task`, `brief`, `pr`,
with `model:TaskPageView`, `model:BriefView`, `model:PrPaneView` respectively. `VIEW_MODELS` in
the contract holds one zod schema per kind, covering what the screens draw; `publishViews` refuses
a model that fails it before writing anything. Luau JSON reads `null` as absent, so optional
fields accept either.

`epoch` is a random id written when the project's `state.json` is created. `seq` is project-wide:
each written file takes the next number, and `state.json` commits the numbers before any file
carries them, so a crash only skips numbers. `rt.watch(cx, path, kind)` reads the whole file once a
second and accepts it only when its `seq` is higher than the shown one; a different `epoch` is a
new store and resets that baseline. `rt.draw` renders each block inside a `pcall`: a model that
fails to draw is never shown, the watch keeps the last model that drew and reports `unavailable`,
and the screen shows its existing unavailable state until a newer file arrives. The brief screen
compares `seq` to notice a newer draft; `seq` never authorizes an action and is distinct from the
numeric brief revision at `file.model.revision` and the reviewed HEAD in a PR model.

The authoritative, readonly TypeScript model schema is `NativeViews` in
`src/board/native-views.ts`, with the domain schemas linked below. Every field here is JSON,
including timeline events and cost receipts. No Maps, Sets, undefined values, credential data,
provider raw payloads, validation stdout/stderr, or HTML are written. Optional fields are omitted.
All timestamps are ISO strings, milliseconds are numbers, costs are integer USD micro-dollars.
`"unavailable"` is a literal marker; it must never be rendered as zero.

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

### Index summaries and publication ownership

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
returned by `NativeViewsReader`; retained filenames identify live PRs awaiting a cached detail;
it is not a file schema. The writer uses each detail's `data` as the file envelope's `model`.
It refuses detail paths that escape the project directory or publication metadata belonging to
another project.

Each coordinator publishes only its own `model.summary`. At write time it reads the other root
bundles' version-1 `panel` envelopes and their `model.summary` fields, validating project identity, filename and heartbeat. The switcher is computed
from these published summaries, with no foreign task-store projection or coordinator record writes.
Only projects with a valid published native summary appear. A summary more than ten seconds old
shows offline, retains its last known counts and omits its stale focus session. Missing or malformed
foreign summaries never become invented zero counts; malformed summaries add a warning. Reading
and publishing this project's index never rewrites another project's bundle or details.

Only coordinators that host native views publish a session id. The controller passes the native
publisher a map from repository to session id built only from coordinator records whose stored
endpoint names the active terminal, and publishes only when that terminal has `views`; foreign
and untagged identifiers never enter a native model. A summary whose fields do not match the
strict schema is refused. Stale rows omit their session id. Task, brief, PR, board and
catch-up models emit no pane or workspace ids. Task/request/thread ids are their domain identities,
not terminal identifiers. Shared `WorkerPane`, `PanelCoordinator` and legacy panel navigation
changes belong to the terminal-setting parent; this slice does not alter their definitions.


### Panel and project switcher

Schemas: `src/board/panel.ts`, exports `NativePanelView`, `NativePanelRow`,
`NativeProjectRow`, `NativePanelTarget`. Pure builders: `nativePanelView`,
`nativeProjectSwitcher` (snapshot-based), `nativeSummaryProjects` (published-summary based).
The service uses the published-summary builder; existing `panelView` and text targets keep their behavior.

```ts
NativePanelView = {
  header: {
    title: string, project: string, projects: NativeProjectRow[],
    otherProjectsNeedYou: number, bellCount: number, fiveHour?: LimitMeter,
    fiveHourLabel: string // whole percent used; numeric meter retains provider precision
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

Draw title/state/stage/time on line one and `secondary` on line two. `detail` contains live
activity or the saved stop reason; to-dos stay on the task page. PR metadata supplies clickable
numbers. Active tasks with draft PRs stay in Running and are not duplicated as a Ready row.
Row keys retain the represented identity: `task:ID`, `brief:ID` or `pr:owner/repo#N`.
A failing watched PR keeps its PR key and target even when its linked task also needs attention.
Board cards reuse these keys; row actions use their task, brief or repository-qualified PR target.
All four section containers exist, including empty ones. Project switcher status includes offline
and counts, with shortcuts for the first nine projects; the renderer owns the footer's open-project
and previous/next controls. The bell count is this project's confirmed native alert deliveries
minus its user read cursor;
it includes brief and PR-watch alerts and is independent of coordinator acknowledgements.
See [bell/read semantics](tern-views.md#panel-bell-and-user-read-semantics).
The compact meter uses the lowest known remaining percentage among the account 5-hour limits.

### Task page

Schema: `src/tasks/page-view.ts`, `TaskPageView`; pure builder `taskPageView`.
Input: `TaskRecord`, matching task/generation `TaskInspection`, `StoredTimelineEvent[]`,
worker activity, the actual routed model when available, and `TaskCostView`.
This model is the `model` inside the task file envelope.

- `header`: `{id,title,stage,elapsed,returnLabel,model?,harness?,branch?}`.
- `rightNow`: `{text,since?,age?}` using the shared panel tool vocabulary.
- `stageTrack`: `{stage,label,state:"done"|"current"|"pending"|"skipped",round?:{used,max}}[]`.
  Implementation tracks Implement/Validate/Review/Fix/Ready; research/review tasks use their own
  stages. Skipped required stages are explicit; fix rounds come from the inspection budget.
- `tabs`: always Overview/Brief/Progress/Diff/PR/Cost, in that order; missing related data
  renders a read-only empty state. `requestId?` and
  `pullRequest?` link other models in the bundle.
- `overview`: `{summary,todos:TodoItem[],done,total,recent:StoredTimelineEvent[]}`. Recent is
  the last five events, newest first. To-dos appear only here.
- `progress`: `{events:StoredTimelineEvent[],unreadableEvents,checks:{name,passed,head,contract}[],
  findings:FindingLedgerEntry[]}`. Events keep sequence, times, fix rounds and detail references;
  findings keep severity, description, optional file/line, status and HEAD/generation evidence.
- `cost?`: `TaskCostView`, described below.
- `stuck?`: `{reason,actions:["restart","steer"]}` only for blocked tasks.
- `message`: `{placeholder,model?}`. Actions go through normal task controls and central recovery.

### Brief pane

Schema: `src/requests/native-view.ts`, `BriefView`; pure builder `briefView`.
This model is the `model` inside the brief file envelope.

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
longest common subsequence. Insertion does not mark shifted unchanged lines NEW. `changes` is
the larger of added/removed line counts, so deletions count too; first drafts have zero revision
changes. Comments must match request, revision, content digest and line id. Old comments never
reattach to a different revision. The approval payload identifies exactly the visible draft;
the action handler must still recheck the authoritative revision and both digests.
`file.model.approval` supplies the three identity fields of the `brief-approve` action sent
to `tandem native act`. Copy them untouched beside `requestId` from `file.model.requestId`. All
three values come from the same draft used to produce the visible lines, including its agreement
digest. The `brief-request-changes` action takes the same identity fields plus optional
`text` and `comments:[{lineId:string,text:string}]`. Copy `lineId` unchanged from the displayed
`lines[].id`; `number` is presentation only and never an action anchor. The CLI checks the
revision/digests and resolves ids through `briefView` for the exact preserved historical draft,
never the latest draft. Unknown ids, missing historical revisions and mismatched digests refuse
delivery. Numeric `line` anchors are refused. See [native brief feedback](request-briefs.md#native-brief-feedback).
The builder accepts comments and a browser URL. Native comments are delivered through the CLI
to the coordinator; local drafts remain transient in the renderer until sent.

### PR pane and diff/tour

Schema: `src/pr-review/native-view.ts`, `PrPaneView`. Input schema: `CachedPullRequest`.
This model is the `model` inside the PR file envelope.
Pure builder: `prPaneView`; effectful cache read: `src/pr-watch/native-cache.ts`.
Tour chapters/stops reuse `ChapterInput` and `TourStopInput` from `src/pr-review/page.ts`.
The existing HTML review page and native view share `parsePatch` in `src/pr-review/patch.ts`.

- `header`: `{repo,number,title,url,head,draft,next,taskId?,commits,additions,deletions,
  unresolved,firstThreadId?}`. `next` comes from the saved PR-watch note, with a draft fallback.
- `readAt`: timestamp of the last complete cached GitHub read.
- `tabs`: Description, optional Tour, Diff. Tour appears only with chapters.
- `checks`: `{name,state:"passed"|"running"|"failed"|"pending",startedAt?,completedAt?,
  logUrl?,duration?,startedAtMs?}[]`. TypeScript computes completed durations and a stable epoch
  millisecond timestamp from a running check's `startedAt`. There is no sampled publication clock
  or running age in the model. Renderers initialize Tern's `elapsed` node from that start timestamp;
  Tern ticks the element without Lua timer renders or detail-file updates. A clock-only publication
  leaves running and completed CI detail bytes, inode and modification time unchanged.
- `description`: `{markdown,blocks:string[],conversation:PrComment[]}` for top-level comments/reviews.
  Markdown blocks retain fenced-code blank lines; each block becomes one native Markdown node.
- `tour`: `{title,why,stops:(TourStopInput & {rowIds:string[]})[]}[]`. `rowIds` selects the
  existing diff rows touched by the stop's new-side inclusive range.
- `files`: `{path,additions,deletions,commentCount,rows:{id,row:DiffRow,threads:PrThread[],drafts:DraftComment[]}[]}[]`.
  `DiffRow` is `{kind:"add",text,new}`, `{kind:"del",text,old}`, `{kind:"ctx",text,old,new}`,
  or `{kind:"hunk",oldStart,oldCount,newStart,newCount,label}`.
- `PrThread`: `{id,file,line?,side:"LEFT"|"RIGHT",resolved,outdated,comments:PrComment[]}`.
  `PrComment`: `{id,databaseId?,author,at,body,url?}`. A thread includes its replies in order.
- `unanchoredThreads`: outdated/non-hunk/deleted-file threads, still readable.
- `commentDestination`: `"worker"` for Tandem's PRs, `"review"` for pr-review tasks, `"read-only"` for taskless watched PRs.
  Taskless views include a plain `readOnlyReason` and omit worker/comment/review actions.
- `review?`: `{taskId,generation,head,currentHead,posted,verdict?,intent,summary,
  drafts:DraftComment[],concerns:ReviewConcern[],notes:string[]}`. Drafts also attach to their
  new-side diff row and retain their ids/severity for posting choices. The reviewed diff and
  posting identity stay pinned to the recorded round; checks/threads from another head are not
  attached to it. Posting rules remain in pr-review.md and the action handler.

Reply editors retain `{threadId,commentId,replyTo}` from the selected thread's root comment;
`commentId` is the exact GitHub node identity and `replyTo` its REST `databaseId`. Two threads on
the same line remain distinct. Outdated and unanchored threads offer Reply too. Native review
submission keeps `replies:[{threadId,commentId,replyTo,body}]` separate from `yours` root comments.
Worker feedback accepts the same replies plus `reviewHead`; TypeScript checks the live thread and
preserves its root, file and optional line in the worker direction. Taskless cached PRs open through
`open pr owner/repo#N` or a published detail path, without creating a task. PR palette and switcher
navigation use this repository-qualified identity.

GitHub reads are cached inside Tandem, with paginated review threads and replies. The cache checks
HEAD before/after the diff, refusing a moving PR rather than mixing anchors. Failed reads retain
the last successful in-process cache and add a warning. Views never make network calls.

### Board

Schema: `src/board/native.ts`, `NativeBoardView`; builder `nativeBoardView`.
`{viewOnly:true,returnLabel,lanes:{title,count,cards:NativeBoardCard[]}[]}`.
Lane titles, in order: Working, Needs you, In review, Ready to merge.
A card extends `NativePanelRow` with `{harness?,harnessGlyph?,branch?,costMicros?,costLabel?,unpricedSamples,stuck}`.
The TypeScript builder supplies the harness glyph and cost label, retaining unknown pricing.
A blocked review stays in In review with a stuck flag. Fixing findings stays in Working.
No drag, mutation or merge action is supplied by this model.

### Usage

Schemas: `src/runtime/usage-view.ts`, `UsageView`, `LimitMeter`, `TaskCostView`.
Builders: `usageView`, `taskUsageView`. Effects: `src/harness/omp/usage-limits.ts` reads
`omp usage --json`, validates with pi-ai's usage schema, and uses its fraction normalization.
Only that adapter imports pi-ai. Raw payloads, metadata, keys and tokens never leave it.

- `limits`: `{provider,account,window:"five-hour"|"weekly",label,
  remainingPercent:number|"unavailable",resetsAt?,fetchedAt,resetInMs:number|"unavailable"}[]`.
  Group meters by provider/account; show limits before cost. Percentages are clamped to 0–100.
  Email-shaped account identities become stable `provider-<12 hex digest>` labels. Friendly
  non-email account labels stay readable; metadata emails never reach the native files.
- `today`, `week`: `{costMicros,unpricedSamples,agentMs,tasksDone}`.
- `byModel`: `{provider,model,today:UsageTotals,week:UsageTotals}[]`.
- `byStage`: `{stage:RequestWorkKind,todayMs,weekMs}[]`.
- `malformedEvents`: unreadable usage-row count.
- `display?`: `UsageDisplay` from `src/runtime/usage-display.ts`, supplied by `usageView`.
  It groups account meters (5-hour before weekly), formats reset countdowns and totals, and
  supplies model/stage labels and proportional model-cost widths for the native renderer.
  Meter `fetched` labels retain each provider sample's original `fetchedAt`; `updated` labels the
  root snapshot's `writtenAt`. `NativeViewsReader` supplies root `warnings` as `limitWarnings`,
  shown beside the account meters before cost totals. A failed refresh retains old quota/reset
  data and shows the failure/staleness warning with its fetch time. Timestamps are formatted in
  TypeScript as UTC labels; Luau draws them without computing freshness policy.
  Unknown limits and unpriced usage remain explicit. Raw totals stay available for other views.
- `TaskCostView`: `{taskId,recorded,charges:AdditionalCharges,tokens:TokenTotals,
  quota:IncludedQuota,timing:ReceiptTiming,breakdown:RequestUsageBreakdown}` from usage-receipt.ts.
  Unrecorded task cost has `recorded:false`; no task intake is invented.

Today starts at local midnight; this week starts at local Monday midnight. Pure builders receive
explicit start timestamps. Ledger events are deduplicated by event key, including shared request
scopes; settled operations credited to both scout/task and request scopes are counted once by
their durable operation identity. Agent time sums settled work durations (parallel workers count independently), clipped at
the window boundary; provider samples do not duplicate time. Done counts use the first saved
delivery/completion timeline event, never a later record's update time. Price provenance remains
in task receipts and unpriced samples are counted alongside the known cost floor.

### Catch-up

Schema: `src/memory/native-view.ts`, `NativeCatchUpView`, built from `catchUpView` workstream
models plus saved project records. `{project,merged:RecentPullRequest[],needsYou:BoardRow[],
blocked:{key,name,reason}[],whereWeLeftOff:{workstream,text}[],workstreams:CatchUpView[],
actions:["open-needs-you","dismiss"]}`. Project merges include tasks without a workstream.

The host calls `shouldAutoShowCatchUp({now,lastVisibleAt?,previousSignature?,currentSignature})`.
It returns true only at **1+ hour** since last visibility, with a known baseline/signature and a
different meaningful signature. Invalid dates, repaint/timer changes and unchanged work stay quiet.
The host stores private locked presentation records under `<home>/native-visits`, updates last
visibility on departure and foreground heartbeats, and runs the rule on every project entry,
including inbox activation. A catch-up failure shows a warning, preserves successful project
navigation and leaves the visit unacknowledged; see the [single entry rule](terminal.md#board-usage-and-catch-up).
Initial publication fills a missing baseline only. Dismiss and
Open what needs me acknowledge after confirmed navigation. See [visibility semantics and API
limits](tern-views.md#board-usage-and-catch-up-actions).
