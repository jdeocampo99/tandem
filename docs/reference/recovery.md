# Recovery and durable state

Where Tandem keeps durable state, how uncertain operations fail closed, and how central recovery
stops, saves, and re-enters a stuck task.

Code: src/recovery/central.ts, src/recovery/central-review.ts, src/runtime/database.ts,
src/runtime/persistence.ts, src/runtime/schema.ts, src/workers/workflow.ts,
src/workers/terminal-extension.ts, src/service/controller.ts, src/tasks/control.ts,
src/config/environment.ts

## Durable home

The home is `--home`, else `TANDEM_HOME`, else the remembered setup, else `~/.tandem`. An explicit
home is a separate namespace and never changes the remembered setup.

| Path under home | Contents |
| --- | --- |
| `state.sqlite` | The only canonical store: tasks, policy snapshots, lifecycle/evidence/review/delivery metadata, reservations, endpoint identities, jobs, operations, stop requests, presentations. |
| `.state.lock` | Darwin `O_EXLOCK` fence guarding state ownership and external-effect decisions. |
| `models.json` | Global five-role model preferences, replaced atomically (`0600`). |
| `repositories/<key>/settings.toml` | Central repository settings (legacy `config.json`); `<key>` = first 24 hex of SHA-256 of the realpath. |
| `coordinator-registry/`, `coordinator-scripts/` | Coordinator records, per-repository locks, `0700` launch scripts; see [coordinator.md](coordinator.md). |
| `communications/<task>/inbox.json` | Derived message projection of the task row. |
| `jobs/<task-id>/` | Job inputs, private results, reports, `job.json.terminal.json` heartbeat, `.command` pause/close requests, `job.json.trace.jsonl`, recovery snapshots. |
| `sessions/<task-id>/` | One OMP conversation per implementation or scout task; every job uses `--session-dir` and `--continue`, so fixes and relaunches resume it. Reviewers, validation, and presentations get none. |
| `presentations/<id>/`, `pool/` | Presentation state and feedback; default Treehouse pool root. |

- Canonical writes are short SQLite transactions under `.state.lock`. Sidecar JSON is evidence,
  projection, or job input, never a second authority. Never hand-edit either while Tandem runs.
- `onboard`, `models`, and `doctor` create nothing. Approved setup creates only the missing central
  file, exclusively (`0700` dirs, `0600` files). Existing, malformed, mismatched, or symlinked policy
  state is reported, never overwritten.
- A validated central `repoPath` may resolve a project name; it never authorizes a home crawl,
  basename guess, clone, or checkout creation.

## Durable operations and quarantine

- Before any reservation or external effect, the runtime commits an operation with role, generation,
  `inputHead`, policy and instruction identity, job and result paths, operation ID, claim owner, and
  fencing revision.
- A worker launch is at-most-once. A claim must match all of those plus stop state; the first
  committed claim wins and duplicate or stale claims are refused. A missing process or result never
  justifies a retry.
- Reconciliation continues only on positive evidence: an endpoint matching exact workspace label,
  root pane, and cwd, or a result matching task, generation, job, and input HEAD. Restart with the
  same home, repository, pool root, and session.
- Anything missing, conflicting, or ambiguous quarantines the operation, keeping its reservation,
  capacity, and resources. Quarantine is not failure cleanup. Never clear records, invent jobs or
  receipts, replace a task, or change policy or checkpoints to get past it.
- A quarantine clears only on proof that nothing Tandem owns for the task still runs, never on time
  or by asking again. The stop ladder, a resume or restart (refused unless every owned pane is proven
  stopped), and a redirecting steer (stops owned panes first) settle the operation `failed` in the
  same write that releases the reservation. Cancellation and terminal cleanup release without
  settling, and never relaunch. `prior-outcome-uncertain` remains only for older state.
- External effects are still not transactional; failures preserve reports and the worktree.

## Worker liveness

These rules decide when a worker is dead, which feeds central recovery
(`src/workers/terminal-extension.ts`).

- A submitted worker idle with nothing queued for 30 s is settled even if OMP ended the turn with
  `willContinue`, which OMP does while a backgrounded command (a dev server) still runs.
- A turn with no tool start or finish for 5 minutes is stalled. The first stall stops the turn and
  reminds the worker; the second in the same job fails it as `worker stalled`, which central
  recovery restarts.

## Central recovery

`src/recovery/central.ts` returns a stuck task to its loop from its current stage in three moves.

1. **Stop.** Prove everything Tandem owns for the task is dead. A durable failed or aborted result is
   proof alone. Otherwise, in order: control-file pause, pane interrupt, signal to the recorded pid
   (only once proven to be the pane's foreground process), proof of exit, close the proven-stopped
   pane. A pane not proven owned or stopped is never touched; recovery asks instead.
2. **Save.** Keep the worktree. Write its `git diff` and untracked file list to
   `jobs/<task>/<generation>/recovery-restart-<n>/` (best-effort; never blocks).
3. **Re-enter.** Each stage owns one action in a typed table, so adding a stage needs no change to
   stop/save/proof.

### Stage re-entry table

| Stage | Re-entry |
| --- | --- |
| `implementing` | Relaunch: new durable operation, fresh pane only if none is owned, normal launch path |
| `scouting` | Same relaunch as `implementing` |
| `validating` | Rerun validation at the exact reviewed HEAD as a new job, within the validation budget |
| `reviewing` | Clear the dead review job/pane at the reviewed HEAD; the launch path starts the current merged lens (not the dead job's possibly legacy lens); recorded reviews are kept |
| `awaiting-fixes` | The `implementing` relaunch: `beginFixes` moves to `implementing` and spends the review round before touching a pane |

- `WorkerWorkflow.relaunchWorker` never mutates the dead job or result. It admits a new operation
  through the normal reservation gate, and the prompt tells the worker to check `git status`/`git
  diff` for partial edits.
- A relaunched fixer keeps the same `fixContextPath`; crash restarts never spend a review round.
- `reviewing` re-entry covers only a lens whose job was quarantined (pane or result proven gone) and
  is unrecorded for the reviewed HEAD; real findings, stale instructions, and malformed results still
  block. The stale operation settles `failed` once the pane is proven gone. A moved, dirty, or
  unmerged worktree asks.
- `implementing` re-entry first adopts a finished commit: worktree clean, not unmerged, on the task
  branch, `HEAD` strictly ahead of `worktree.baseHead` and not yet reviewed. It applies the normal
  `implementation-complete` event (sets `reviewHead`, advances to `validating`) without approval,
  since validation and review still gate it.

### Reservation refusals

When the gate admits nothing, `reserveTask` returns a `ReservationRefusal`; its one-sentence
`summary` becomes the block summary and coordinator notice, with specifics in `detail`.

| Refusal | Plain reason |
| --- | --- |
| `slot-held` | Another worker still holds this task's slot. |
| `job-running` | A worker is still running for this task. |
| `worker-limit` | The worker limit (N) is reached. |
| `routing-question` | The routing question's own one-line reason. |
| `stop-requested` | A stop was requested for this task. |
| `stage` | The task is at a stage where that role can't start. |
| `fix-rounds` | The worker has no fix rounds left. |

- The first five (`WAITING_REFUSALS`) clear only when a fact changes, so they do not block: the task
  keeps its stage, the coordinator gets one notice (skipped if already latest), no restart or retry
  is spent, and the next scheduler pass retries.
- `stage`, `fix-rounds`, and post-admission failures (no terminal, working copy gone, task moved on)
  block with their reason.

### Restart budget

- `MAX_AUTOMATIC_RESTARTS_PER_GENERATION` is 2; a new generation resets it. Beyond that, Tandem asks.
- A job that died within 15 s of launch (`IMMEDIATE_FAILURE_WINDOW_MS`) in the same failure class as
  the previous restart (`classifyRestartFailure`, e.g. provider unavailable) asks instead.
- Each automatic restart posts one plain-English notice: what happened, edits kept, restart N of 2.
- Recovery questions use the standard short question shape and question-id-bound answer API.
  Central recovery handles the answer and never bumps `task.communication.revision`, so it never
  reads as a worker instruction.

### Validation retries

- A validation job that dies for an infrastructure reason (pane gone, or `validation-worker` exits
  without a durable result; see `reconcileMissingEndpoint`, `reconcileJob`) settles failed without
  blocking, leaving the task at `validating` with no job or reservation for the next tick.
- `MAX_VALIDATION_RETRIES` is 3, shared by automatic retries and answered "retry" questions. A real
  validation result, pass or fail, never reaches this path.
- Exhaustion or an unprovable pane asks retry/stop under `VALIDATION_RETRY_QUESTION_ID_PREFIX`, so
  answers never reach the worker restart handler.

### Blocked tasks and `restart`

- `CentralRecoveryWorkflow.recoverBlockedTask` is the single entry for re-entering a `blocked` task.
  Eligible only when `previousStage` is one of the five stages above and the block is recoverable: a
  `lost-resource` cause; an `unusable-result` cause of kind `worker-failed`, `stale-review-state`,
  or `no-clean-checkpoint` (never `review-lens-failed`); or, with no typed cause, text matching
  `isLegacyWorkerDeathBlockText`. See [block causes](reconciliation.md#typed-block-causes).
- `user-decision` or `safety-stop` causes, an unanswered non-recovery question, or a pending stop
  make a task ineligible, and an ineligible task is never mutated.
- An eligible task gets the `resume` event, then its stage's `recoverStuckWorker`, spending the same
  budgets and stop ladder as an unblocked task.
- Both the scheduler tick (`ServiceController.reconcileTask`) and `TaskControlWorkflow.restartTask`
  call it. `restartTask` resumes a paused or blocked task after proving owned panes stopped, then
  runs the stage's reconcile; in `implementing`/`scouting` with no live writer that relaunches in
  the same task and worktree.
- A person's restart approves causes recovery would not re-enter alone, such as
  `quarantined-unknown-outcome`; the stop ladder and reservation gate still decide safety.
