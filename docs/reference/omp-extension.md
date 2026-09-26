# OMP extension and automatic maintenance

What the coordinator's OMP extension, its scheduler and notifications, and worktree maintenance and
scout release must guarantee.

Code: src/extension.ts (OMP adapter), src/extension/registration.ts, src/extension/omp-host.ts,
src/session/coordinator.ts (scheduler, status, compaction), src/session/actions.ts,
src/session/tools.ts, src/session/tool-guard.ts, src/session/prompt-routing.ts,
src/session/notifications.ts, src/pool/maintenance.ts, src/pool/policy.ts,
src/service/scout-cleanup.ts, src/adapters/treehouse.ts, src/workers/workflow.ts, src/workers/worktree-lease.ts

## Tool and command contract

- The extension registers one strict `tandem` tool, `{ "request": { "action": ... } }`. Its schema,
  `tandemRequestSchema`, is harness-neutral plain zod in src/session/tools.ts; registration.ts turns
  it into OMP's JSON Schema parameters and parses tool calls with it directly. That schema is the
  action list; keep it, `TandemAction`, and `parseTandemCommand` in src/session/actions.ts in step.
  The schema itself rejects unknown fields. OMP's own tool-call validator repairs common LLM
  quirks first, including dropping unknown root fields before it ever reaches the schema, so a
  model call with a stray root field is still accepted; "unknown fields are rejected" is a property
  of the schema, not of every OMP tool call.
- Tool text is a bounded summary; structured details stay in the tool result and durable reports.
- A refusal the coordinator recovers from by asking the user carries its own next step, so the
  per-turn prompt does not: `create` and `review-pr` asking where a repository is, and `create`
  finding no saved validation commands for another repository.
- `/tandem` parses arguments with shell-style quoting only; nothing runs in a shell.
- The tool is registered with OMP `write` approval. `requiresHumanApproval` covers `setup`,
  `configure-models`, `approve`, `brief-approve`, `cancel` (with or without `discard`), `publish`,
  `publish-now`, `draft`, `merge`, and `cleanup` with `discard`. Each needs a live TUI confirmation; without an
  interactive TUI they fail closed.
- `configure-models` does not change existing task snapshots.
- User prompts route through `routeUserPrompt` (src/session/prompt-routing.ts) before the model
  sees them, for confirmations and other harness-neutral prompt handling; OMP's `input` event
  forwards there via `registerPromptRouting` in src/extension/registration.ts.
- The coordinator's own tool calls, not the `tandem` tool's, are guarded by `coordinatorToolRefusal`
  (src/session/tool-guard.ts), keyed on the call's harness-neutral `ToolCall.kind` (`"mcp"`,
  `"read"`, ...) rather than an OMP tool name. `registerCoordinatorToolGuard` in
  src/extension/registration.ts converts OMP's native `tool_call` event to that shape with
  `ompToolCall` (src/extension/omp-host.ts) and blocks the call when a reason comes back.
- src/extension/omp-host.ts is the shared OMP coordinator host: `ompSessionHost` (the `SessionHost`
  the harness-neutral core calls into), `ompToolCall`, `ompMcpToolPrefix`, and `ompApprovalDialog`.
  src/extension.ts and src/extension/registration.ts build the coordinator extension on it.

## Scheduler and notifications

- The scheduler starts at session start (2,000 ms default) and reconciles once immediately. It
  refreshes the durable digest before an agent turn, during OMP-native compaction, and after it.
- Routine notices, receipts, heartbeats, and passive progress go to `ctx.ui.notify` and the durable
  UI log, with no model turn. A delivered request's `receipt`-kind notice is shown with its receipt
  table, rendered by the extension at delivery; an unreadable receipt is named, never guessed.
- Judgment-needed notices are coordinator-kind notifications: current blocked tasks, completed
  scout reports, and PR-ready notices. The newest ones in a delivery batch coalesce into at most
  one model wake; routine backlog is excluded, and a delivered wake is never repeated.
- One thread at a time: an interactive user message that reaches the model (not one a prompt
  route handled) opens a thread, and answering the model's `ask` keeps it open. While a thread is
  open, judgment-needed notices stay pending with no model turn; each time something new starts
  waiting, `ctx.ui.notify` shows how many are waiting. The model ends the thread with the
  `thread-done` action when the work with the user is finished, or it ends after 30 minutes with no
  user message (`THREAD_IDLE_MS`). The next reconcile delivers what waited as one wake whose hidden
  part tells the model to list it and offer one item, starting none. With no thread open, notices
  wake the model at once. Thread state is in memory only: the notices stay pending in durable state,
  so a restarted coordinator delivers them with no thread open.
- A judgment-needed scout notice carries that scout's post-research follow-up, rebuilt from the
  durable record on every delivery (see [task lifecycle](task-lifecycle.md)). When the follow-up
  asks for a summary and the report is at most 16,000 characters, its full text rides along in the
  hidden identifiers message, so the coordinator answers without a separate `read` call. The
  session entry's `details` keep the identifiers only, not the report.
- A scout is completed research only when durable state records `completed` and its report.
- PR watch notices (a watched pull request turned red or merged) go to `ctx.ui.notify` and the UI
  log with no model turn; the first coordinator to take one clears it (see [pr-watch.md](pr-watch.md#notifications)).
- When a new "Needs you" row of the coordinator's project appears, the reconcile opens
  `tandem status --watch` beside the coordinator's pane (see
  [status.md](status.md#when-the-coordinator-opens-it)).

## Compaction and the durable digest

- The durable digest is bounded to 8,000 characters and may omit older task detail; `state.sqlite`
  and durable reports stay authoritative. It carries no commit hashes, and finished tasks with
  nothing unread, no blocker, and no open question collapse to one line of ids and objectives. Action summaries are bounded separately; `show --full`
  keeps more structured detail.
- Early compaction (src/session/compaction.ts, driven by src/session/coordinator.ts) cuts the cost of resending a long history. On a
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
  with a durable report and safely cancelled scouts are released, except as described under
  scout worktree adoption.
- Interactive OMP stays open after a scout reports, so cleanup asks an idle completed worker to
  close (close request, then ctrl+d) before closing its pane; a busy worker defers to a later tick.
- Cleanup never touches scout output. The report, source checkpoint, consumed job, notifications,
  and history stay in the Tandem home, so later tasks can cite a released scout via
  `researchTaskIds`.

## Scout worktree adoption

- A completed scout with disposition `ask-intent` or `implementation-interview` keeps both its pane
  and its clean worktree (`retained`, no time limit), so the user's mockup requests and Lavish
  comments reach the agent that did the research, and the implementation that follows can adopt the
  worktree. Cancelling the scout releases both.
- When an implementation starts, Tandem first closes the pane of the first scout in its
  `researchTaskIds` if that scout is completed and idle (close request, then ctrl+d), since
  building has started (`closeFinishedScoutPanes`, src/service/scout-cleanup.ts).
- The implementation adopts that scout's worktree only if the scout is settled, holds no pane or
  reservation, and is still clean on its lease branch at its source commit. Otherwise it leases a
  fresh worktree and leaves the scout alone.
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

- Minimum free space defaults to 2 GiB (src/pool/policy.ts). Each repository keeps up to 3 idle
  copies warm for the next task; other idle copies are removed. Below the minimum, maintenance also
  removes the warm copies one at a time, rechecking capacity after each.
- If free space is unknown or still too low, the task stays queued, its reservation is released,
  and a durable blocker/notification says to verify capacity or free disk. The next pass retries.
  The task's timeline records an `admission-waiting` event when the reason is new or changes (see
  task-lifecycle.md), so `tandem trace` and `tandem report` can say what the queue waited for.
- Admission is governed by the disk threshold alone; there is no worker limit or fixed worktree count.

## Discard

`cleanup --discard` needs `--yes` (CLI) or live TUI confirmation (extension), then uses Treehouse's
force return. The extension's `cancel` with `discard` covers the same deletion in its one confirmation.
The extension's `cleanup` takes `taskIds`, so one confirmation covers a batch; each task is cleaned
in turn and one that fails is reported without stopping the rest.
Discard also closes the task's own panes when their worker ignores the close request or keeps the
foreground; pane ownership is still verified first. Any cleanup closes the panes that
the retired presentation worker left behind, whose artifacts stay on disk. Never use it to resolve an ambiguous, dirty, ignored, or unmerged worktree unless the
human explicitly accepts losing that work.
