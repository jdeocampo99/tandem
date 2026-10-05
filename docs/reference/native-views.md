# Native view data

The data contract for Tern screens 1–8 from #282. All models are computed by Tandem in
TypeScript. The terminal renderer reads the JSON and runs CLI actions. It never fetches
GitHub, provider limits, or the task store itself.

## Files and ownership

`<home>/board-snapshot.json` retains its version-1 shape and Herdr behavior.

`<home>/native-views/<key>.json` is the native bundle, where `key` is the full lowercase
SHA-256 hex digest of the original project's exact `repoPath` string (UTF-8).
Use `nativeViewsPath(home, repoPath)` from `src/board/snapshot.ts` to locate it. Two checkouts
with the same basename have different files. The project's coordinator is the single writer,
through the existing `writeBoardSnapshot` service operation, only for a Tern backend.

The directory is private (0700); the file is 0600. A unique temporary file and atomic rename
publish the whole bundle together. On failure, the prior bundle stays readable; the existing
coordinator snapshot error reporting handles the failed projection. No native file is authority.
The normal coordinator reconciliation updates it. GitHub and provider cache refreshes run in a
serial background queue, at most once per minute per PR/provider read, with command timeouts.
They never hold up the snapshot. Shutdown drains the queue.

A missing bundle means no snapshot yet. An unknown `version` must be refused. A stale
`writtenAt` should be displayed as stale, as the panel does. Read-only cached remote data may
be older than the bundle: PRs have `readAt`, limits have `fetchedAt`, and `warnings` records
refreshing/failing sources. The in-memory remote cache starts empty on a coordinator relaunch
and fills in subsequent reconciliations. No empty or failing read means zero usage or passing CI.

## JSON schema (version 1)

The authoritative, readonly TypeScript schema is `NativeViews` in
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
  changeSignature: string,        // SHA-256 of meaningful saved changes, excluding timers
  panel: NativePanelView,
  projects: NativeProjectRow[],
  tasks: Record<taskId, TaskPageView>,
  briefs: Record<requestId, BriefView>,
  pullRequests: Record<"owner/repo#N", PrPaneView>,
  board: NativeBoardView,
  usage: UsageView,
  catchup: NativeCatchUpView,
  warnings: string[]
}
```

### Panel and project switcher

Schemas: `src/board/panel.ts`, exports `NativePanelView`, `NativePanelRow`,
`NativeProjectRow`, `NativePanelTarget`. Pure builders: `nativePanelView`,
`nativeProjectSwitcher`. Existing `panelView` and text targets keep their behavior.

```ts
NativePanelView = {
  header: {
    title: string, project: string, projects: NativeProjectRow[],
    otherProjectsNeedYou: number, bellCount: number, fiveHour?: LimitMeter
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
All four section containers exist, including empty ones. Project switcher status includes offline
and counts, with shortcuts for the first nine projects; the renderer owns the footer's open-project
and previous/next controls. The bell count is Tandem's saved unacknowledged task notifications;
the Tern inbox renderer can provide its own live count to `nativePanelView`.
The compact meter uses the lowest known remaining percentage among the account 5-hour limits.

### Task page

Schema: `src/tasks/page-view.ts`, `TaskPageView`; pure builder `taskPageView`.
Input: `TaskRecord`, matching task/generation `TaskInspection`, `StoredTimelineEvent[]`,
worker activity, the actual routed model when available, and `TaskCostView`.

- `header`: `{id,title,stage,elapsed,returnLabel,model?,harness?,branch?}`.
- `rightNow`: `{text,since?,age?}` using the shared panel tool vocabulary.
- `stageTrack`: `{stage,label,state:"done"|"current"|"pending"|"skipped",round?:{used,max}}[]`.
  Implementation tracks Implement/Validate/Review/Fix/Ready; research/review tasks use their own
  stages. Skipped required stages are explicit; fix rounds come from the inspection budget.
- `tabs`: available labels from Overview/Brief/Progress/Diff/PR/Cost. `requestId?` and
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

```ts
{
  requestId:string, title:string, revision:number, changes:number,
  approval:{requestId:string,briefRevision:number,contentDigest:string,agreementDigest:string},
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
The builder accepts comments and a browser URL; their collection and CLI actions belong to the
annotation/action integration, which can supply them when opening the pane.

### PR pane and diff/tour

Schema: `src/pr-review/native-view.ts`, `PrPaneView`. Input schema: `CachedPullRequest`.
Pure builder: `prPaneView`; effectful cache read: `src/pr-watch/native-cache.ts`.
Tour chapters/stops reuse `ChapterInput` and `TourStopInput` from `src/pr-review/page.ts`.
The existing HTML review page and native view share `parsePatch` in `src/pr-review/patch.ts`.

- `header`: `{repo,number,title,url,head,draft,next,taskId?,commits,additions,deletions,
  unresolved,firstThreadId?}`. `next` comes from the saved PR-watch note, with a draft fallback.
- `readAt`: timestamp of the last complete cached GitHub read.
- `tabs`: Description, optional Tour, Diff. Tour appears only with chapters.
- `checks`: `{name,state:"passed"|"running"|"failed"|"pending",startedAt?,completedAt?,
  logUrl?,elapsedMs?}[]`. Running timers use the start timestamp; finished timers stop at completion.
- `description`: `{markdown,conversation:PrComment[]}` for top-level comments/reviews.
- `tour`: `{title,why,stops:(TourStopInput & {rowIds:string[]})[]}[]`. `rowIds` selects the
  existing diff rows touched by the stop's new-side inclusive range.
- `files`: `{path,additions,deletions,commentCount,rows:{id,row:DiffRow,threads:PrThread[],drafts:DraftComment[]}[]}[]`.
  `DiffRow` is `{kind:"add",text,new}`, `{kind:"del",text,old}`, `{kind:"ctx",text,old,new}`,
  or `{kind:"hunk",oldStart,oldCount,newStart,newCount,label}`.
- `PrThread`: `{id,file,line?,side:"LEFT"|"RIGHT",resolved,outdated,comments:PrComment[]}`.
  `PrComment`: `{id,author,at,body,url?}`. A thread includes its replies in order.
- `unanchoredThreads`: outdated/non-hunk/deleted-file threads, still readable.
- `commentDestination`: `"worker"` for Tandem's PRs, `"review"` for pr-review tasks.
- `review?`: `{taskId,generation,head,currentHead,posted,verdict?,intent,summary,
  drafts:DraftComment[],concerns:ReviewConcern[],notes:string[]}`. Drafts also attach to their
  new-side diff row and retain their ids/severity for posting choices. The reviewed diff and
  posting identity stay pinned to the recorded round; checks/threads from another head are not
  attached to it. Posting rules remain in pr-review.md and the action handler.

GitHub reads are cached inside Tandem, with paginated review threads and replies. The cache checks
HEAD before/after the diff, refusing a moving PR rather than mixing anchors. Failed reads retain
the last successful in-process cache and add a warning. Views never make network calls.

### Board

Schema: `src/board/native.ts`, `NativeBoardView`; builder `nativeBoardView`.
`{viewOnly:true,returnLabel,lanes:{title,count,cards:NativeBoardCard[]}[]}`.
Lane titles, in order: Working, Needs you, In review, Ready to merge.
A card extends `NativePanelRow` with `{harness?,branch?,costMicros?,unpricedSamples,stuck}`.
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
- `today`, `week`: `{costMicros,unpricedSamples,agentMs,tasksDone}`.
- `byModel`: `{provider,model,today:UsageTotals,week:UsageTotals}[]`.
- `byStage`: `{stage:RequestWorkKind,todayMs,weekMs}[]`.
- `malformedEvents`: unreadable usage-row count.
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

The host calls `shouldAutoShowCatchUp({now,lastOpenedAt?,previousSignature?,currentSignature})`.
It returns true only at **1+ hour** away, with a known previous visit/signature and a different
meaningful signature. Unknown visits, invalid dates, repaint/timer changes and unchanged work
never auto-show. The host owns visit/dismiss tracking and invokes this pure rule on project open;
this data slice does not write visit state or display the card itself.
