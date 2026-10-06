# Inspecting and controlling work

What inspection, scheduler control, two-way task messages, and CLI consent must guarantee.

Code: src/tasks/control.ts, src/tasks/inspection.ts, src/tasks/communication-protocol.ts,
src/tasks/communication-persistence.ts, src/terminal/cli-application.ts, src/terminal/cli-commands.ts,
src/terminal/cli-arguments.ts, src/cli.ts

## Inspection

- `show` is bounded for model-facing output; `--full` (tool: `detail: "full"`) returns the larger
  structured record, including pinned policy, generation, review round, reviewed HEAD, evidence,
  blocker, notifications, and pull-request metadata.
- `tandem trace TASK_ID [--json]` prints the task's timeline and rollups; without a task it prints
  the rollups across every task in scope. See [timeline and trace](task-lifecycle.md#timeline-and-trace).
- Task counts and stage claims come from durable task state only, never from worker or process
  observations, receipts, or notifications.

## Scheduler ticks and watch

- A tick reconciles durable jobs and endpoints and may start queued work, validation, or review.
  Polling never creates a model turn; routine scheduler notices, including automatic review-fix
  handoffs, are UI/log activity, not model input.
- The advanced CLI's `watch` (repeated ticks) is not `tandem watch`, which shows PR watch
  ([pr-watch.md](pr-watch.md)).
- `watch` defaults to a 2,000 ms interval; `--iterations` must be a positive finite count, and
  without it watch runs until interrupted.
- Interrupting `watch`, `tick`, or `feedback` stops the CLI's own feedback listeners and timer, then
  drains the active reconciliation before exiting nonzero. It never cancels task workers (that is
  `pause`/`cancel`). Interactive `launch` leaves signal handling to OMP.

## Pause, resume, cancel

- Pause and resume are non-destructive. Cancel needs explicit consent and preserves reports and
  unmerged work.
- The extension's `cancel` with `discard` asks once to stop the task and delete its worktree. The
  flag is saved on the durable stop request and handed to the cleanup that follows the cancel, which
  discards the implementation worktree once its workers are proven stopped. A crash between settling
  the stop and that cleanup keeps the worktree. On an already-cancelled task it runs
  `cleanup --discard` directly.
- Recovery resumes only from a valid paused or blocked previous stage; it never guesses a missing
  endpoint or job.

## Steering a task

- `steer` forwards an in-scope user direction to an existing task. It never changes pinned policy
  or `scopeApproved`; a materially wider request goes through the normal interview and approval.
- Independent directions are separate `steer` calls, applied in order. `supersedes` marks earlier
  messages obsolete; history is never rewritten.
- Bounds: 1,000 characters per message, 6,000 characters of active message text, 12,000 characters
  for the serialized active payload with metadata. At a bound, supersede obsolete directions.
- If directions arrive before initial approval, the approval confirmation states how many
  effective, non-superseded directions the worker will also receive.
- PR watch steers a task itself when the task's pull request has merge conflicts: "Pull this
  branch from origin, merge `origin/<base>` into it, resolve the conflicts, and commit; Tandem
  pushes it. Never force-push."
  Only the coordinator whose project the task belongs to sends it, so the worker starts where it
  always does; any other Tandem leaves it for a later check ([pr-watch.md](pr-watch.md#conflicts)).

## Answering a worker question

- The coordinator is the single user inbox. Before answering it inspects the durable current
  question id, recommendation, report path, task identity, approval state, and in-scope
  evidence.
- It may answer only when explicit prior user direction, the approved scope, or unambiguous
  repository facts establish a safe non-destructive answer, and it sends a concise rationale bound
  to the exact current question id. Stale question ids are rejected.
- Product choices, ambiguous evidence, scope changes, credentials, and approval-bearing,
  destructive, publishing, merging, or deployment decisions stay with the user. The coordinator
  never infers consent.

## Message receipts

- Status meanings: **queued** = persisted for the child; **received** = the bridge observed it;
  **delivered** = it entered provider-bound context. None of these means the change was
  implemented; check the receipt instead of claiming code changed.
- `steer` and `answer` return a queued receipt; the child applies it at the next safe boundary.
- What a worker is doing goes in a separate, display-only file, `activity.json` beside its
  receipt (src/workers/worker-activity.ts), so the receipt's strict format never changes and an
  older coordinator can still read a newer worker's receipt. It holds the running tool, its target,
  when it started, and the latest to-do list (at most 50 items). Targets are at most 120
  characters: a path keeps its end, a URL only its host and path, and a command only its leading
  words up to the first flag, assignment, URL, `@`, or quote, so credentials are not stored. The
  worker rewrites it (temp file and rename) whenever the tool, target, or list changes; a failed
  write is traced and never stops the worker. Only the board reads it, leniently: a missing or
  broken file is no activity. Recovery and steering never read it, and nothing decides on it.
- Query `messages` when the user asks or before a dependent decision, never in a model-driven poll
  loop. Receipts, heartbeats, and passive progress need no follow-up model turn.
- Compact output shows only the latest entry (`steer`/`answer`) or the current question plus
  pending/latest entries (`messages`); full history stays in structured JSON.
- Communication is canonical in the task row in `state.sqlite`, published as a derived inbox at
  `<home>/communications/<safe-task-id>/inbox.json`. The service persists canonical state before
  the projection. Receipts are bound to task, job, generation, and operation. Pending directions
  survive restart unless the service rejects them for a terminal or safety state.
- The derived inbox is recoverable and may briefly lag canonical task state. Reconciliation repairs
  it and never accepts an older result or drops a pending direction.

## How directions reach workers

- A running primary worker receives directions at the next provider-context boundary without
  interrupting an active tool. A terminal response continues only if an unapplied direction remains.
  On Claude Code, which cannot rewrite context, directions arrive as new text after the next tool
  result, as the text a stopping turn continues with, or as a prompt while the worker is idle
  ([harness.md](harness.md#steering-a-claude-code-worker)).
- A task in validation, review, or `ready` instead stops through the ownership checks and
  invalidates old evidence in a new generation, without charging a repair round. When the task's
  PR is open, Tandem adds a line telling the agent to commit and push (see
  [delivery.md](delivery.md#follow-ups-on-an-open-pr)).
- Paused, infrastructure-blocked, merged, or cancelled tasks may retain or explicitly reject
  directions; a direction never bypasses approval, auto-resumes work, publishes, or merges.
- Workers load the control extension at launch; running workers are not hot-upgraded.

## Approval prompts

Every approval prompt is one short question plus at most one short line, naming the task by its
objective's first sentence. Never include a path, hash, branch, criteria list, or id. Prompt text
lives in `approvalPrompt` in src/session/actions.ts.

## CLI consent and output

- `--yes` is explicit automation consent. It is not an interactive prompt; the CLI checks it and
  proceeds or raises a consent error (`requireYes` in src/terminal/cli-commands.ts).
- Commands that need `--yes`: `configure-models`, `setup`, `onboard --write`, `approve`, `cancel`,
  `pr draft`, `pr publish`, `pr merge`/`merge`, and `cleanup --discard`. Safe cleanup does not.
- `steer`, `answer`, and `messages` are not approval-bearing and get no extra consent prompt. All
  approval, exact-HEAD, publish, merge, and destructive-cleanup safeguards still apply.
- Parsing never executes or mutates anything; approval checks run after it. `--supersedes` is a
  CLI-only convenience.
- Plain output is a summary; `--json` prints the raw value with no `.value` wrapper. `watch`
  polls every 2,000 ms by default.
- `--json` emits exactly one JSON result, errors included. Usage and consent failures exit `2`;
  other failures exit `1`.
- Extension-side consent (live TUI confirmation) is in
  [OMP extension](omp-extension.md#tool-and-command-contract).

## Native view actions

Every native click runs `tandem native act` once with one `ActionEnvelope` on stdin and prints
one `Outcome` (both in `src/native/contract.ts`). The view never edits durable state.
The envelope is `{v: 1, origin, action}`. `origin` is either a block's exact decimal `pane` with
the `ctx` it was launched with, echoed verbatim, or a window command's focused `pane`, absolute
`cwd` and optional opaque `window` key. The pane must be listed by exactly one recorded
coordinator session before the scoped service is created; context never grants ownership, and
the coordinator is proven separately. Unreadable records and sessions whose pane listing fails
are non-matches; when no readable, live candidate matches, the action is refused clearly.
Missing or malformed origins are refused before any pane is read.

The outcome's `status` is `done` (the click did what it asked), `kept` (part of it did not
happen and the originating view stays) or `refused` (Tandem refused it or it failed; nothing to
undo). An optional `notice: {code, text}` explains it. The closed codes are `failed`,
`view-kept`, `catch-up-unavailable`, `brief-warning`, `brief-left-open`, `review-posted`,
`review-unconfirmed` and `feedback-saved`; `rt.luau` maps each to one toast title. No action is
retried, and a `kept` outcome never invites a repeat.

`src/native/actions.ts` dispatches one handler per verb:

- `open {ref}` shows a view. `ref.kind` is `task {taskId}`, `brief {requestId}`,
  `pr {number, repo?}`, or one of `board`, `usage`, `prs`, `orchestrator`, `inbox`,
  `task-picker` and `new-request`. A task replaces the main area; a brief or PR opens a split.
  A PR number resolves one owning task first, then one cached PR in the selected project's index;
  ambiguous matches refuse. Taskless watched PRs open read-only. `prs` opens the first cached PR,
  `task-picker` the searchable task picker, Board and Usage full-window views, `orchestrator`
  returns to the conversation and `inbox` also marks alerts read. `new-request` focuses the
  coordinator and asks it to start conversational intake. Herdr opens briefs through the existing
  review workflow and refuses unsupported native task/PR views. The backend receives the origin
  and must honor its window and pane or refuse, rather than open in an unrelated window. Open
  warnings make the outcome `kept` with `view-kept`.
- `open-project` asks the coordinator to help open another project.
- `project {target}` switches to project 1–9, `prev`, `next` or `{repoPath}` from the published
  switcher; `visit {event}` records the window's `entry`, `away` and `visible` lifecycle.
- `brief-approve` and `brief-request-changes` use the revision-bound paths in
  [request-briefs.md](request-briefs.md#native-brief-feedback). They and opening a brief also
  require its canonical repository path to match the selected project; a request id never
  bypasses project scope.
- `pr-comment {taskId, text?, comments?, replies?, reviewHead?}` sends an in-scope fix request to
  the implementation task's worker through `steer`. Only a task with an open or draft Tandem PR
  accepts it. It never posts a GitHub comment, changes scope approval, publishes, or merges.
  `comments: [{file, line, text}]` keep their anchors in the worker message. Thread replies carry
  `replies: [{threadId, commentId, replyTo, body}]` and the displayed `reviewHead`; fresh
  thread/head checks preserve the exact context. Comments are joined into one direction under the
  existing steering bounds. For a ready task whose worker finished, steer uses evidence
  invalidation and the existing redirect/reconcile path to start a new implementation generation
  in the same retained worktree. A completed task with no such path is refused before a direction
  is saved. If recovery cannot start the fix, the outcome is `kept` and says the feedback was
  saved and why the worker did not start; it never reports silent delivery to a finished worker.
- `restart {taskId}` uses central recovery; `steer {taskId, text}` uses the existing message
  path. These actions do not implement a second recovery or messaging mechanism.
- `review-submit {taskId, reviewHead, reviewGeneration, submission}` parses `submission` as the
  same `ReviewSubmission` as the review page. `reviewHead` and `reviewGeneration` are copied from
  the displayed `PrPaneView.review.head` and `.generation` and passed separately to the existing
  submit service. It refuses a different latest round head/generation or an advanced
  re-review task generation before applying choices. A question follow-up retains the existing
  finished round and its binding. Before a new POST, a task-revision compare-and-swap (CAS)
  saves the exact choices/verdict in `pendingPost` as the exclusive claim; a losing caller never
  POSTs. Preflight, marker reads, the network POST and thread replies run outside the global
  store lock. A short receipt transaction matches the PR and exact reviewed head/generation,
  preserves concurrent task changes and newer rounds, and leaves an existing receipt intact.
  Any caller that finds the receipt saved sends the round's unclaimed replies under per-reply
  claims and reconciles the rest. Later submissions
  with a pending attempt only reconcile its marker, without changing choices or blindly posting.
  The click is confirmation; pinned-head refusal and
  duplicate-post prevention remain in that service. A posted review is `done` with
  `review-posted`; anything else is `kept` with `review-unconfirmed` and the service's message.
  Uncertain submissions explain that GitHub may or may not have received the review and ask the
  user to check the PR. The conversation's `review-post` action offers explicitly confirmed
  recovery to post saved choices again or record the review link the user checked; ordinary native
  submissions never choose either path. See [uncertain review recovery](pr-review.md#recovering-an-uncertain-post).
- `catchup-dismiss` and `catchup-open-needs` leave the catch-up view; `board-link {cardKey}` and
  `merged-link {url}` open only PR URLs the project published.
- The native action namespace does not expose publication or merge commands. Publishing, merging,
  deployment, and destructive operations retain their separate conversation approvals.

Native window lifecycle also sends `visit {event: entry|away|visible}` with the focused origin.
These presentation-only actions prove the exact recorded project session; helper entry focuses
the recorded coordinator and reads its alert cursor, and project entry applies the non-fatal
catch-up rule. See [native visibility and alert semantics](tern-views.md).
