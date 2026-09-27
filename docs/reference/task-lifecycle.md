# Task lifecycle

Task stages, approvals, fix rounds, post-research continuation, child terminals, and Herdr status.

Code: src/tasks/lifecycle.ts, src/tasks/required-stages.ts, src/tasks/findings.ts, src/tasks/timeline.ts, src/tasks/timeline-store.ts,
src/tasks/trace.ts, src/tasks/research-continuation.ts,
src/tasks/research-continuation-classifier.ts, src/session/research-follow-up.ts,
src/service/source.ts, src/adapters/herdr.ts, src/adapters/herdr-status.ts,
src/session/worker.ts, src/session/worker-steering.ts, src/workers/terminal-extension.ts

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

- The CLI's `create --input` file has exactly `repoPath`, `kind`, `objective`,
  `acceptanceCriteria`, and `surfaces`.
- Ordinary worker briefs fail closed above 64 KiB of UTF-8 (`MAX_ORDINARY_BRIEF_BYTES` in
  src/instructions.ts) with an error asking to shorten them; they are never silently truncated.
  A draw brief keeps its own 32,000-character bound.

## Stages

| Stage | Meaning |
| --- | --- |
| `awaiting-approval` | Implementation scope not yet approved. |
| `queued` | Approved, waiting for capacity. Not proof of a running worker or finished research. |
| `scouting` / `implementing` | A worker is active in its owned workspace. |
| `validating` | One named validation contract runs at that exact HEAD: iteration checks between fix rounds, or the full final manifest once otherwise ready. |
| `reviewing` | Checks passed or were skipped ([Review and validation](review-and-validation.md)); fresh reviewers record lenses. |
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
| Steering a task whose PR is open (not a draft) | ✗ | ✗ |

- Recorded at creation (from the brief the task runs under), again on every `steer` with a new
  direction (from the brief and the PR's state at that moment), and again on the governed tasks
  when a brief is approved.
- `implementation-complete` goes to `validating` when validation is required (or straight to
  `reviewing` when passing pinned checks at that HEAD still hold). With nothing required it goes
  straight to `ready`, recording `reviewSkippedHead` at that HEAD.
- With review not required, the review stage records the review level (so the PR names any safety
  floors the diff tripped) and applies `skip-review` instead of launching a reviewer.
- Tandem always pushes, once the required stages pass: a draft through its refresh, a published PR
  by pushing the ready HEAD to the task branch without forcing (see
  [delivery.md](delivery.md#follow-ups-on-an-open-pr)). Agents commit; they don't push.
- Records saved before required stages existed derive them from their own PR state when read; on
  its next tick the service records them on active tasks, including the brief's `skipReview`.
- [Publish now](delivery.md#publish-now-user-skips-review) is not a required-stages choice: it is a
  user action that cuts a running task short.

## Fix rounds

- Completion and fix cycles bind to the current generation and HEAD. A fix cycle increments the
  generation, retires the old review round, returns to `implementing`, and keeps only passing checks
  at the reported commit's exact HEAD.
- Budget is pinned `maxFixRounds` (default 2) plus `fixRoundGrants`, stored beside the pinned policy,
  which never changes.
- `Keep fixing "<task>"?` is asked before a round when the budget is spent, or the latest review
  repeats a blocker unchanged (same lens and id, file, and description ignoring case and spacing;
  if HEAD did not move, every remaining blocker counts). The task blocks with `fix-rounds-exhausted`
  and a durable question listing open blockers. Only exact `yes` or `no` is accepted:
  - `yes` records a `user` grant and resumes in the same worktree: a full `maxFixRounds` if the
    budget was spent, or no extra round if asked early (it only settles that generation's repeat).
  - `no` clears the question; the task stays blocked. Never create a new task to bypass the limit.
- A round ending on an already-reviewed HEAD records a one-round `no-commit` grant instead of
  spending budget; the next review of that HEAD asks `Keep fixing?`, so it cannot loop.
- Ready and exhaustion are distinct coordinator notifications; neither claims delivery. Ready fires
  only once the final manifest is satisfied and names lenses, review level, accepted HEAD, any
  P2/P3 known issues, and that ready is not publish/merge/deploy approval. Exhaustion names rounds
  used and asks `Keep fixing?`.

## Timeline and trace

- Every task change appends events to the `task_events` table in `state.sqlite`, in the same
  transaction as the change, so an event exists exactly when its change committed. Rows are never
  updated or deleted.
- The task store derives events by comparing the record before and after each write
  (`timelineEventsForChange`): `created`, `stage-changed`, `blocked` (with the block kind) and
  `unblocked`, `fix-round`, `finding-raised` and `finding-settled`, `question-asked` and
  `question-answered`, and `steered`. Central recovery adds `restarted` in the write that spends the
  restart.
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
- The implementer brief lists the steps and asks the worker to load them verbatim into OMP's `todo`
  tool. Every fix round uses the `fix-round` playbook, whose first step carries the fix-round rule
  to fix every P0 and P1 finding and leave P2 and P3 as known issues. Older tasks without a playbook get one only in fix rounds.
- The worker extension remembers the list from the latest `todo` result. An `implemented` report is
  rejected while any step is not completed or abandoned (missing counts as open); the rejection
  names the steps. A dropped step's reason goes in the report.
- The to-do list is the worker's scratch state and a submit-time gate only. It is never task state.

## Interactive child terminals

- Workers run interactive OMP with inherited terminal I/O (no `-p`, no `--mode json`).
- The only result path is the `submit_report` tool, which writes the private result file. A settled
  `agent_end` without it is conversation, so human messages never become or overwrite the result;
  it still fails the job on provider error, abort, model substitution, or requested timeout.
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

- Workspace label: `└ <role cue> <objective> · <short identity>` (cue `research`, `implement`, or
  `task` for other roles), normalized, at most 96 UTF-16 units, never splitting graphemes. It is
  persisted before creation and reused by recovery, never recomputed. Existing labels are never
  renamed. A label is never ownership proof.
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
