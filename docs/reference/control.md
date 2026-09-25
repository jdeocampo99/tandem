# Inspecting and controlling work

What inspection, scheduler control, two-way task messages, and CLI consent must guarantee.

Code: src/tasks/control.ts, src/tasks/inspection.ts, src/tasks/communication-protocol.ts,
src/tasks/communication-persistence.ts, src/terminal/cli-application.ts,
src/terminal/cli-arguments.ts, src/cli.ts

## Inspection

- `show` is bounded for model-facing output; `--full` (tool: `detail: "full"`) returns the larger
  structured record, including pinned policy, generation, review round, reviewed HEAD, evidence,
  blocker, notifications, and pull-request metadata.
- Task counts and stage claims come from durable task state only, never from worker or process
  observations, receipts, or notifications.

## Scheduler ticks and watch

- A tick reconciles durable jobs and endpoints and may start queued work, validation, or review.
  Polling never creates a model turn; routine scheduler notices, including automatic review-fix
  handoffs, are UI/log activity, not model input.
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
lives in `approvalPrompt` in src/extension/actions.ts.

## CLI consent and output

- `--yes` is explicit automation consent. It is not an interactive prompt; the CLI checks it and
  proceeds or raises a consent error (`requireYes` in src/terminal/cli-application.ts).
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
