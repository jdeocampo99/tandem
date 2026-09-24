# OMP extension and automatic maintenance

What the coordinator's OMP extension, its scheduler and notifications, and worktree maintenance and
scout release must guarantee.

Code: src/extension.ts, src/extension/registration.ts, src/extension/actions.ts,
src/extension/notifications.ts, src/pool/maintenance.ts, src/pool/policy.ts,
src/service/scout-cleanup.ts, src/adapters/treehouse.ts, src/workers/workflow.ts

## Tool and command contract

- The extension registers one strict `tandem` tool, `{ "request": { "action": ... } }`, a zod
  union in src/extension/registration.ts. Unknown fields are rejected. That schema is the action
  list; keep it, `TandemAction`, and `parseTandemCommand` in src/extension/actions.ts in step.
- Tool text is a bounded summary; structured details stay in the tool result and durable reports.
- `/tandem` parses arguments with shell-style quoting only; nothing runs in a shell.
- The tool is registered with OMP `write` approval. `requiresHumanApproval` covers `setup`,
  `configure-models`, `approve`, `brief-approve`, `cancel` (with or without `discard`), `publish`,
  `publish-now`, `draft`, `merge`, and `cleanup` with `discard`. Each needs a live TUI confirmation; without an
  interactive TUI they fail closed.
- `configure-models` does not change existing task snapshots.

## Scheduler and notifications

- The scheduler starts at session start (2,000 ms default) and reconciles once immediately. It
  refreshes the durable digest before an agent turn, during OMP-native compaction, and after it.
- Routine notices, receipts, heartbeats, and passive progress go to `ctx.ui.notify` and the durable
  UI log, with no model turn.
- Judgment-needed notices are coordinator-kind notifications: current blocked tasks, completed
  scout reports, and PR-ready notices. The newest ones in a delivery batch coalesce into at most
  one model wake; routine backlog is excluded, and a delivered wake is never repeated.
- A judgment-needed scout notice carries that scout's post-research follow-up, rebuilt from the
  durable record on every delivery (see [task lifecycle](task-lifecycle.md)).
- A scout is completed research only when durable state records `completed` and its report.

## Compaction and the durable digest

- The durable digest is bounded to 8,000 characters and may omit older task detail; `state.sqlite`
  and durable reports stay authoritative. Action summaries are bounded separately; `show --full`
  keeps more structured detail.
- Early compaction (src/extension/compaction.ts) cuts the cost of resending a long history. On a
  reconcile where a non-scout task newly reached `completed`, `merged`, or `cancelled`, it calls
  `ctx.compact()` only when the coordinator is idle (no turn, no pending `ask`, no unacknowledged
  delivery), no listed task is `blocked`, `paused`, `awaiting-approval`, or `ready` or has an
  unacknowledged notification, and context usage is at least `TANDEM_COORDINATOR_COMPACT_TOKENS`
  (default 128,000; `0` leaves compaction to OMP). Running tasks do not hold it back, because the
  digest restores them.
- A finished scout never triggers it: its report usually opens the next conversation. Each finish
  is one chance; if context is under the threshold then, nothing compacts until another task
  finishes. OMP's `compaction.methodOrder` chooses the method.

## Worker timeout

- No configured timeout means no deadline for the delegated turn. A positive limit is enforced by
  the worker extension: it aborts the delegated turn and records failure after the active turn
  settles, leaving the terminal open for read-only follow-up. It never times out later human
  conversation.
- Validation-command timeouts and cancellation are enforced separately. Progress warnings are
  inspection events, never automatic kills.

## Inactivity warnings

- Progress is not death. After about 5 minutes without meaningful activity, or 60 seconds without
  a startup heartbeat, Tandem emits one inspection warning per inactivity episode, and resets the
  episode when progress resumes (src/workers/workflow.ts).
- Elapsed time alone never kills a worker. Real process exit or error follows the failed/blocked
  path.

## Worktree ownership

- Task worktrees live under the configured pool root, tied to source/base HEAD, lease holder,
  lease id, task branch (`tandem/<safe-task-name>`), and task generation.
- The coordinator's clean source worktree, pinned to the original committed HEAD, is a separate
  lease from every task worktree.
- Runtime passes every owned task worktree to pool maintenance as protected.

## Safe automatic maintenance

The scheduler maintains capacity when a queued task needs a worktree, with no user approval. A copy
is pruned only when all of these hold; anything else is retained with a warning:

- it is an explicitly managed path, a distinct child worktree (not the primary repository), and
  its physical identity stays inside the managed root;
- Treehouse metadata unambiguously says available, Git-backed, unleased, with no process metadata;
- Git proves no dirty, untracked, or ignored content, no unmerged paths, and a HEAD that is an
  ancestor of the current primary HEAD;
- it is not an active or protected task path.

Housekeeping keeps the policy-derived idle set and removes only extra proven-disposable copies.
Explicit discard is the only path that bypasses the Git safety proof.

## Terminal cleanup

- For `cancelled`, `completed`, or `merged` tasks, cleanup closes stopped owned endpoints and tries
  a lease-checked Treehouse return in the same scheduler pass that settled the task.
- Live interactive child terminals and their checkouts are kept for inspection and follow-up.
- Explicit cleanup may cooperatively close an idle completed or paused child, and refuses busy
  conversations, queued input, editor drafts, and unproven ownership.
- Worktree return requires stopped processes, exact lease metadata, the expected task branch, a
  clean unmerged-free checkout, and task HEAD ancestry. If proof fails, the worktree is kept.

## Releasing settled scout resources

- A scout's lease is returned only when its checkout is proven to be the untouched pinned source
  commit on its own lease branch. Any difference, an untracked file included, is someone's work:
  retain it and report why. An unreadable checkout, or one on a branch the lease does not name, is
  quarantined with every resource kept.
- Blocked, paused, and decision-waiting scouts keep pane and worktree as evidence. Completed scouts
  with a durable report and safely cancelled scouts are released.
- Interactive OMP stays open after a scout reports, so cleanup asks an idle completed worker to
  close (close request, then ctrl+d) before closing its pane; a busy worker defers to a later tick.
- Cleanup never touches scout output. The report, source checkpoint, consumed job, notifications,
  and history stay in the Tandem home, so later tasks can cite a released scout via
  `researchTaskIds`.

## Scout worktree adoption

- A completed scout with disposition `ask-intent` or `implementation-interview` closes its pane but
  keeps its clean worktree (`retained`, no time limit) for the implementation that follows.
- The implementation adopts the worktree of the first scout in its `researchTaskIds` only if that
  scout is settled, holds no pane or reservation, and is still clean on its lease branch at its
  source commit. Otherwise it leases a fresh worktree and leaves the scout alone.
- The adapter re-proves that state, switches the worktree to the implementation branch at the
  implementation's pinned source commit (fast-forwarding past older research), and deletes the
  merged scout branch.
- The runtime moves the lease from scout to implementation in one write, so scout cleanup can never
  return it.
- Treehouse cannot relabel a lease, so the adopted lease keeps the scout's holder; the
  implementation's ownership check accepts exactly its own holder or that scout's.

## Cleanup notes

Each attempt writes a durable `cleanup` note (status + reason) on the task record:

| Status | Meaning |
| --- | --- |
| `released` | Pane closed and exact lease returned. |
| `retained` | A resource was deliberately kept, e.g. a changed scout checkout. |
| `pending` | Transient failure; the next tick or reconciliation retries, also after restart. |
| `quarantined` | Ownership unproven; resources kept, no automatic retry. |

A missing note loads unchanged; a present but malformed note fails the read as state corruption
(src/tasks/store-codec.ts).

## Disk-pressure admission

- Minimum free space defaults to 2 GiB (src/pool/policy.ts). Below it, maintenance removes retained
  warm idle copies one at a time, rechecking capacity after each.
- If free space is unknown or still too low, the task stays queued, its reservation is released,
  and a durable blocker/notification says to verify capacity or free disk. The next pass retries.
- Admission is governed by `maxWorkers` and the disk threshold; there is no fixed worktree count.

## Discard

`cleanup --discard` needs `--yes` (CLI) or live TUI confirmation (extension), then uses Treehouse's
force return. The extension's `cancel` with `discard` covers the same deletion in its one confirmation.
Discard also closes the task's own panes when their worker ignores the close request or keeps the
foreground; pane ownership is still verified first. Any cleanup closes the panes of the task's
finished or failed presentations, whose artifacts stay on disk; a running presentation is left alone. Never use it to resolve an ambiguous, dirty, ignored, or unmerged worktree unless the
human explicitly accepts losing that work.
