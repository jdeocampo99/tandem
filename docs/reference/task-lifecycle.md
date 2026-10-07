# Task lifecycle

Task stages, approvals, fix rounds, post-research continuation, child terminals, and Herdr status.

Code: src/tasks/lifecycle.ts, src/tasks/required-stages.ts, src/tasks/quick.ts, src/tasks/findings.ts, src/tasks/timeline.ts, src/tasks/timeline-store.ts,
src/tasks/trace.ts, src/tasks/research-continuation.ts,
src/tasks/research-continuation-classifier.ts, src/session/research-follow-up.ts,
src/service/source.ts, src/terminal-backend/herdr/, src/session/worker.ts, src/session/worker-steering.ts,
src/harness/omp/terminal-extension.ts

## Creation and source pinning

- A clean-bound coordinator accepts the original repo path or its clean source checkout (distinct
  worktrees of the same Git common directory; anything else is rejected) and records the original
  canonical identity.
- Creation captures policy and source revision atomically; workers start at that commit even if
  `origin/main` moves. Refresh never repins existing tasks, leases, or checkouts. Fetch or
  source-safety failures block new creation only. A lease without worker history must pass the same
  captured-HEAD check on retry; an allocation failure never permits launch from the rejected checkout.
- A scout is created `queued` and scope-approved. An implementation is created `awaiting-approval`
  with `scopeApproved: false`; only an explicit `approve` approves it. If scout delegation is
  blocked, the coordinator discloses the blocker; direct research needs explicit user authorization.

- A [quick task](#quick-tasks) is the one implementation that starts approved: the user's own
  Start click is its approval.
- The CLI's `create --input` file has exactly `repoPath`, `kind`, `objective`,
  `acceptanceCriteria`, and `surfaces`.
- Ordinary worker briefs fail closed above 64 KiB of UTF-8 (`MAX_ORDINARY_BRIEF_BYTES` in
  src/instructions.ts) with an error asking to shorten them; they are never silently truncated.
  A draw brief keeps its own 32,000-character bound.

## Quick tasks

A fast lane for a clear, small change, with no interview and no brief. **No model ever decides
that a request is quick. Only the user does, through the quick task composer.**
Code: src/tasks/quick.ts (pure decisions), `startQuickTask` in src/service/controller.ts and
src/service/quick-start.ts (the one start path).

- **Entry point.** The palette's "Tandem: Quick task…" opens the native composer
  ([native-views.md](native-views.md#quick-task-composer)); its Start sends `quick-start` through
  the click transport, whose origin proof names the project. The coordinator's `tandem` tool has
  no action that reaches it, so a model cannot start or approve a quick task. There is
  deliberately no CLI entry: a worker's shell cannot be told apart from the user's (an environment
  marker such as `TANDEM_WORKER_JOB_PATH` can simply be unset), so a command would let a model
  start a task recorded as user-approved scope.
- **Checks, without a model.** `checkQuickText` trims the text and refuses fewer than 15
  characters or 3 words with "Describe the change in a sentence or two.", and more than 4,000
  characters with "Too long for a quick task. Start a request instead." The composer mirrors both
  limits (`minChars`, `minWords`, `maxChars` in its model) to keep Start disabled.
- **Approval provenance.** The task records `quick: {kind: "quick-task", text, textDigest,
  approvedAt}`: the typed text verbatim, its sha256, and when. The store refuses a record whose digest does not match its text, and only implementation tasks may
  carry it. The approval is task-level rather than a request brief: a brief needs a model-written
  summary, joins plain-language checks, and waits in Needs you for its own approval, none of which
  a quick task has. The timeline records `quick-approved` (with `textDigest`) in the
  creating write.
- **Task.** `objective` is the text, `title` its first line cut to 60 characters, no acceptance
  criteria, surfaces `*` (every pinned validation command applies) and no request: a quick task
  never joins the project's open request. It is created through the ordinary `create` path and
  approved through the ordinary `approve` path, so source checks, dispatch, [required
  stages](#required-stages), validation, review, the draft PR and the user's approval before
  publishing are unchanged. The playbook classifier still picks its playbook. If the approval
  fails (for example the source checkpoint changed since creation), the start cancels the task it
  created through the ordinary `cancel` path and its error names that task, so a retried Start
  never leaves a duplicate waiting for an approval no one is asked for; if that cancel also fails,
  the error names the stranded task and both causes.
- **The coordinator** gets one fixed chat message: `Quick task started` / `<task id> · <title>` /
  `Scope approved <HH:MM>`. If it cannot be told, the task still runs and the outcome says so.
- **One scope question.** The implementer's brief says the objective is the user's approved words
  and that, before changing any file, it may stop once when the request clearly exceeds a small
  change (many files across areas, or an open design decision). It submits `needs-decision` with
  `scopeExceeded: {files, areas, decision?, plan}` and no question text; Tandem renders the
  question (`quickScopeLines`):
  `<task id> · Scope exceeds quick task` / `Affects <N> files across <areas>.` /
  `Open decision: <decision>.` (only when given) / `No changes made.` / `Proposed: <plan>.`
  The report is rejected unless the worker can prove it changed nothing: a clean worktree whose
  HEAD still equals the job's `baseHead` (the task worktree's starting commit). Uncommitted
  changes, a commit, or an unreadable status, HEAD or base all refuse it, telling the worker it
  may only ask before changing or committing anything. The job carries `quickScope:
  "may-ask" | "spent"`; once asked, `quick.scopeQuestionId` is recorded and a second
  `scopeExceeded` is refused at the worker and, if one arrives anyway, stored as an ordinary
  question. The task blocks with the question, so it is a Needs you question that notifies, not a
  silent block.
- **Answers.** Only `Proceed`, `Convert to request` or `Cancel` (labels or `proceed`, `convert`,
  `cancel`) are accepted, through the ordinary `answer` path or the chat's answer links:
  - Proceed records `quick.scopeExtendedAt` (timeline `quick-scope-extended`), answers the worker
    with a fixed instruction to go ahead and not ask again, and resumes it. The review brief,
    task page and PR body show the stretched scope.
  - Convert to request cancels the task through the ordinary cancel path, then clears the
    question and gives the coordinator a notification with the user's words and the worker's
    findings. The coordinator then runs the usual research, interview and brief.
  - Cancel cancels the task through the ordinary cancel path, then clears the question.
  - Either one is refused when the cancel cannot prove the worker stopped (the task stays
    blocked): the question stays open, nothing reaches the coordinator, and the answer may be
    given again once the pane is stopped.
- **Crash safety.** The choice is recorded first, as `quick.scopeAnswer {choice, at}` (with
  `scopeExtendedAt` in the same write for Proceed), and only then do its effects run. Each effect
  is guarded by the open question: Proceed answers the worker only while the question is open, and
  Convert and Cancel close it in one write that, for Convert, also adds the coordinator handoff. So
  each tick finishes a recorded answer a crash left part-way exactly once (`quickScopeNextStep`
  decides the missing step). A tick never retries a cancel that already failed to prove the worker
  stopped; answering again does. Once one answer is recorded, a different answer is refused.
- **Nothing else reopens the work.** While the scope question is unanswered (`quick.scopeQuestionId`
  set, no `scopeExtendedAt`, task not cancelled; `quickScopeAwaitingAnswer`), the `resume`
  transition refuses with `approval-required` and a message naming the three answers, so
  `tandem resume`, `restart` and every other path through it cannot dispatch the implementer.
  Proceed records `scopeExtendedAt` before it resumes. An implementer brief written for an asked
  but unanswered question tells the worker to change nothing; only Proceed tells it to go ahead.

## Stages

| Stage | Meaning |
| --- | --- |
| `awaiting-approval` | Implementation scope not yet approved. |
| `queued` | Approved, waiting for capacity. Not proof of a running worker or finished research. |
| `scouting` / `implementing` | A worker is active in its owned workspace. |
| `validating` | Every configured check runs at that exact HEAD, after the first round and after every fix round. |
| `reviewing` | Every check passed at this HEAD, or none is required ([Review and validation](review-and-validation.md)); fresh reviewers record lenses. |
| `awaiting-fixes` | Validation or review failed; a bounded fix round may start. |
| `ready` | The task's [required stages](#required-stages) passed at the current HEAD (the final manifest and all required lenses, when both are required), or the user chose [publish now](delivery.md) at that HEAD. |
| `paused` | Stopped with a resumable previous stage. |
| `blocked` | Cannot safely proceed; durable reason, surfaced as an actionable blocker. |
| `cancelled` / `completed` / `merged` | Terminal. A scout is research-complete only when `completed` with its report; `merged` only after verified delivery: the `merge` action at the reviewed HEAD, or PR watch seeing the task's own pull request merged on GitHub. |

## Required stages

An implementation task records `requiredStages` (`{ validation, review }`): which stages run after
implementation. `decideRequiredStages` in src/tasks/required-stages.ts is the only place that
decides them; the lifecycle and the review stage read the record and never re-derive it.

| Situation | validation | review |
| --- | --- | --- |
| Normal new task | ✓ | ✓ |
| Brief approved with `skipReview` | ✓ | ✗ |
| Project chose [no checks](policy.md#no-checks) (with or without `skipReview`, PR open or not) | ✗ | ✓ |
| Steering a task whose PR is open (not a draft) | ✗ | ✗ |

- Recorded at creation (from the brief the task runs under and its pinned policy), again on every
  `steer` with a new direction (from the brief and the PR's state at that moment), and again on
  the governed tasks when a brief is approved.
- No checks always keeps review, so a task with no checks never reaches `ready` ungated, including
  a follow-up on its published PR, which may have no CI of its own. Its task
  page shows the skipped validation step as "Unvalidated", not as passed.
- `implementation-complete` goes to `validating` when validation is required (or straight to
  `reviewing` when every check already passed at that HEAD). With nothing required it goes
  straight to `ready`, recording `reviewSkippedHead` at that HEAD.
- With review not required, the review stage records the review level and applies `skip-review`
  instead of launching a reviewer.
- Tandem always pushes, once the required stages pass: a draft through its refresh, a published PR
  by pushing the ready HEAD to the task branch without forcing (see
  [delivery.md](delivery.md#follow-ups-on-an-open-pr)). Agents commit; they don't push.
- Records saved before required stages existed derive them from their own PR state and pinned
  policy when read; on
  its next tick the service records them on active tasks, including the brief's `skipReview`.
- [Publish now](delivery.md#publish-now-user-skips-review) is not a required-stages choice: it is a
  user action that cuts a running task short.

## Fix rounds

- Completion and fix cycles bind to the current generation and HEAD. A fix cycle increments the
  generation, retires the old review round, returns to `implementing`, and keeps only passing checks
  at the reported commit's exact HEAD.
- Budget is pinned `maxFixRounds` (default 2) plus `fixRoundGrants`, stored beside the pinned policy,
  which never changes. Only review findings spend it: a round started by failed validation records a
  one-round `failed-checks` grant, so failed checks never exhaust the budget.
- `Keep fixing "<task>"?` is asked before a round when the budget is spent, the latest review
  repeats a blocker unchanged (same lens and id, file, and description ignoring case and spacing;
  if HEAD did not move, every remaining blocker counts), or a check fails again after the round
  whose `iterationScope` targeted it. The task blocks with `fix-rounds-exhausted`
  and a durable question listing open blockers. Only exact `yes` or `no` is accepted:
  - `yes` records a `user` grant and resumes in the same worktree: a full `maxFixRounds` if the
    budget was spent, or no extra round if asked early (it only settles that generation's repeat).
  - `no` clears the question; the task stays blocked. Never create a new task to bypass the limit.
- A task extends its budget at most once, so it runs at most twice `maxFixRounds` review rounds
  (plus `no-commit` and `failed-checks` rounds). Once a `yes` has added rounds and those are spent,
  Tandem asks nothing more, repeat or not: the task blocks with `fix-rounds-exhausted`, a summary that it used all its fix rounds, and
  the open blockers in the detail, so the user can take it over, publish it as-is
  ([publish now](delivery.md#publish-now-user-skips-review)), or cancel it.
- A round ending on an already-reviewed HEAD records a one-round `no-commit` grant instead of
  spending budget; the next review of that HEAD asks `Keep fixing?`, so it cannot loop.
- Ready and exhaustion are distinct coordinator notifications; neither claims delivery. Ready fires
  only once the final manifest is satisfied and names lenses, review level, accepted HEAD, any
  P2/P3 known issues, and that ready is not publish/merge/deploy approval. Exhaustion names rounds
  used and asks `Keep fixing?`, or, after the one extension, says the rounds are all used.

## Timeline and trace

- Every task change appends events to the `task_events` table in `state.sqlite`, in the same
  transaction as the change, so an event exists exactly when its change committed. Rows are never
  updated or deleted.
- The task store derives events by comparing the record before and after each write
  (`timelineEventsForChange`): `created`, `stage-changed`, `blocked` (with the block kind) and
  `unblocked`, `fix-round`, `finding-raised` and `finding-settled`, `question-asked` and
  `question-answered`, `steered`, and for [quick tasks](#quick-tasks) `quick-approved` (in the
  creating write) and `quick-scope-extended` (when the user answers Proceed). Central recovery adds
  `restarted` in the write that spends the restart.
- `admission-waiting` records why a queued task was not admitted, with a closed `reason`
  (`ADMISSION_WAIT_REASONS`): `worktree-disk-space` (pool free space below the minimum for a new
  worktree), `worktree-capacity-unknown` (free space could not be checked, or pool maintenance
  failed), or `routing-question` (a model routing question is waiting). It comes from the caller's
  note (`admissionWait`), written in the same transaction as the runtime record's `poolAdmissionKey`
  or `routingPause`, and only while the task is `queued`. `admissionWaitToRecord` appends it only
  when the reason differs from the latest one the runtime record noted (`latestAdmissionWait`: a
  standing routing question, else the pool key), so scheduler passes do not repeat it. The pool's
  notice or the routing explanation is its cause. The wait's end is the stage change out of
  `queued`; there is no worker limit, so no other reason exists. A stored `admission-waiting` event
  with an unknown reason is counted as unreadable.
- An event holds its type, task, time, a one-line cause (at most 200 characters), and references:
  the transcript file and entry id the worker submitted from, the commit, the report path, and the
  job. It never copies message, finding, transcript, or report text.
- The cause comes from the caller when it knows one (a pause reason, "The user restarted it.",
  automatic recovery), else from the record (a block's summary).
- `tandem trace` computes rollups when read; there are no metrics tables. First-pass review: the
  first time a task left `reviewing`, whether it went to `ready`/`completed` (pass) or
  `awaiting-fixes` (fail). Fix rounds: `fix-round` events. Time blocked: `blocked` to `unblocked`,
  an open block counting to now. Cost: the task's own samples in its request's usage ledger, or in
  its task-scoped ledger when no request governs it (see usage-and-routing.md); a task with no
  recorded work has none.

## Research continuation

Each scout carries a durable `researchContinuation`: routing for the coordinator's follow-up turn,
never permission. It does not set `scopeApproved` or create tasks. It is refused on non-scouts.

| Field | Rule |
| --- | --- |
| `schemaVersion` | Always `1`; anything else is refused, not repaired. |
| `disposition` | `report-only`, `ask-intent`, or `implementation-interview`. |
| `selectedBy` | `explicit`, `deterministic`, `jev`, or `fallback`. |
| `classifierVersion` | Required for `jev`, optional for `deterministic`, refused otherwise. |
| `fallbackReason` | Required for `fallback`, refused otherwise. |

- A scout record without the field loads as `ask-intent` / `deterministic`. Unknown fields,
  selectors, dispositions, or malformed provenance fail closed as state corruption.
- Summaries and the durable digest print disposition and provenance, so it survives compaction.
- The completed-scout notification is the only wake. Its text is derived from the persisted record
  after proving the report is readable, so it is identical after compaction, restart, or
  replacement. An open `needs-decision` question is answered first (`answer-question`); a non-scout,
  failed, blocked, cancelled, incomplete, stale-generation, or unreadable-report record gets
  `disclose-blocker`. Otherwise the disposition picks the reply shape (see
  src/session/research-follow-up.ts); no path widens scope.
- After the user answers, an implementation task citing the scout in `researchTaskIds` is created
  `awaiting-approval`, passes repository and report-provenance handoff validation, and launches only
  after explicit approval. Research on an older commit still hands off, recording the scout's HEAD.
- While a completed `ask-intent` or `implementation-interview` scout keeps its agent, the
  coordinator's `research-follow-up` action puts one question to that agent over the mockup turn
  channel (src/service/research-follow-up.ts). The agent may write only the answer file in its
  job's `follow-up-<id>/` folder. The action waits up to two minutes, then returns the answer path.
  A report-only, closed, or busy agent is refused with a one-line reason; start new research then.

## Classifying the disposition

Runs only when no explicit disposition was supplied, before the record is written. It is separate
from the prompt router.

1. A deterministic cue table decides first, no provider call. Imperative information-only wording
   gives `report-only`; imperative fix/implement/patch wording gives `implementation-interview`;
   both cues or an empty objective give `ask-intent`, so report-only is never upgraded. Descriptive
   or hypothetical wording stays unresolved.
2. Unresolved wording goes to Jev as one closed-set choice. Its input is only the sanitized,
   single-line, bounded objective and task kind: never repo, report, credentials, or transcript.
   Model and schema version are recorded in `classifierVersion`.
3. No `TYPESAFE_API_KEY`, timeout, outage, malformed answer, or low confidence falls back to
   `implementation-interview` with `selectedBy: "fallback"` and the real `fallbackReason`. Research
   never waits past `TANDEM_JEV_TIMEOUT_MS`. Jev never creates tasks, approves scope, or relaxes policy.

## Playbooks

Code: src/playbooks/ (`catalog.ts` steps, `selection.ts` choice, `classify.ts` the Jev call,
`progress.ts` the submit gate, `brief.ts` the brief section).

- An implementation task pins a playbook at creation: `bug-fix`, `feature`, `refactor`, `perf`, or
  `general`. The coordinator passes `playbook` when the user chose one; otherwise Jev classifies the
  brief's goal (or the objective). A pick below 0.80 confidence, `other`, any Jev failure, or no
  `TYPESAFE_API_KEY` pins `general`. Jev picks the playbook and nothing else. The task summary shows
  it as `Type:`.
- The implementer brief numbers the steps and asks the worker to load each line verbatim, number
  included, as one item in its to-do tool (OMP's `todo`, Claude Code's `TaskCreate` subject), and
  to give its own items no leading number. Every fix round uses the `fix-round` playbook, whose first step carries the fix-round rule
  to fix each P0 and P1 finding, or decline it in the report if it has no realistic failure or is
  out of scope, and leave P2 and P3 as known issues. Older tasks without a playbook get one only in fix rounds.
- The worker extension remembers the list from the latest `todo` result. An item stands for a step
  when it starts with that step's number (`2.`, `2)`, `Step 2:`), whatever its wording, since Claude
  Code workers paraphrase subjects; an unnumbered item stands for the step whose text it matches,
  ignoring case, spacing and punctuation. An `implemented` report is rejected while any step has no
  completed or abandoned item (missing counts as open); the rejection quotes each open step as the
  numbered item text to use. A dropped step's reason goes in the report.
- The to-do list is the worker's scratch state and a submit-time gate only. It is never task state.

## Interactive child terminals

- Workers run interactive OMP with inherited terminal I/O (no `-p`, no `--mode json`).
- The only result path is the `submit_report` tool, which writes the private result file. A settled
  `agent_end` without it is conversation, so human messages never become or overwrite the result;
  it still fails the job on provider error, abort, model substitution, or requested timeout.
- A settled report-less `agent_end` of a run the person at the pane did not start (OMP `input`
  from `interactive`) is a missing report, not conversation: the first gets one `report-reminder`
  asking for `submit_report`; a second in the same job fails it as `worker ended its turn without
  calling submit_report, again after a reminder`, which central recovery restarts or asks about.
- The scheduler may consume a result while OMP stays open after checking job identity, generation,
  native PID, physical checkout, and a fresh terminal heartbeat. Terminal output is display only.
- After completion or pause, follow-up turns are read-only (mutating tools blocked), except a
  completed scout's mockup turn, which may write only inside its presentation's artifact directory
  (see [delivery.md](delivery.md#presentations-and-lavish)). Reviewer conversations stay open after
  consumption.
- A writer job reuses a pane only when the prior turn finished or paused and the session is idle with
  no queued messages or draft. Cooperative close freezes input, requests exit, and verifies process
  exit. Busy, foreign, stale, or unproven terminals are retained, never interrupted.

## Herdr labels and status

- Workspace label: `└ <title>`, the two-to-four-word title the coordinator gives at `create`
  (older tasks without one use the objective), normalized, at most 32 UTF-16 units, never
  splitting graphemes. Labels need not be unique: recovery picks the one same-labelled workspace
  whose root pane sits in the launch's worktree and stays ambiguous otherwise. It is persisted
  before creation and reused by recovery, never recomputed. Existing labels are never renamed. A
  label is never ownership proof.
- States: active turns `working`; question dialogs, paused workers, and failed or needs-decision
  results `blocked`; completed turns `idle`. An idle coordinator aggregates its original project's
  tasks: approval, pause, and blockers outrank queued/running work; ready and terminal tasks do not
  count. A coordinator tick that fails reports `blocked`, except one that only timed out waiting for
  the state lock: that leaves the status as it was for the next tick to retry. Validation reports
  `working` while running and releases authority on exit.
- Reporting runs only in an exact Herdr pane context, serialized and deduplicated; failed reports
  retry on the next update; shutdown releases authority even if durable shutdown fails. Each
  reporter uses a fresh source identity because Herdr keeps sequence watermarks after release.
- Reporting failures never authorize or interrupt work. Status, labels, and terminal output are never
  completion or ownership evidence.
