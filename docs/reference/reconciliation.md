# Block causes and resource reconciliation

How a blocked task records why it is blocked, and how `tandem fix` classifies and cleans stale
Tandem resources across every session in a home.

Code: src/contracts.ts, src/recovery/central.ts, src/coordinator/reconcile.ts,
src/terminal/fix-report.ts, src/service/superseded.ts, src/service/scout-cleanup.ts, src/main.ts

## Typed block causes

- A block may carry a `BlockCause` beside the free-text `blockReason`: a closed `kind`, its `group`,
  an internal `detail` (raw error text), and a plain-English `summary` (no IDs) that becomes the
  user-facing reason. `BLOCK_CAUSE_GROUP_BY_KIND` is the only kind-to-group mapping. Reuse an
  existing kind for new wording; add one only for a new shape of blocker.
- `reportBlock` records the cause and blocks; it never triggers recovery. Re-entry is decided the
  next time the task is reconsidered ([recovery.md](recovery.md#blocked-tasks-and-restart)).
- `blockCause` is optional; older records load without one, and some sites still pass free text
  only. `tandem status TASK_ID --json` includes it when present.

| Group | Meaning | Kinds |
| --- | --- | --- |
| `lost-resource` | Auto-recoverable; the work itself is not in question | `allocation-failed`, `resource-lost`, `persistence-failed`, `transition-failed`, `checkout-unverifiable` |
| `unusable-result` | The work left nothing to build on or trust | `no-clean-checkpoint`, `stale-review-state`, `review-lens-failed`, `worker-failed` |
| `user-decision` | Only a person can choose | `fix-rounds-exhausted`, `validation-config-refused`, `prerequisite-not-met`, `explicit-block` |
| `safety-stop` | Never automatic, whatever evidence appears later | `ownership-unprovable`, `runtime-metadata-missing`, `identity-mismatch`, `quarantined-unknown-outcome` |

## `tandem fix`

The supported alternative to deleting coordinator records, panes, leases, or lock files by hand.
It does not recover stuck tasks; [central recovery](recovery.md#central-recovery) does.

- **Scan (read-only):** every coordinator record in every session directory, whether Herdr still
  answers for each, the checkout behind each unanswered record, every pool's leases, terminal tasks
  with unsettled cleanup, existing quarantine notes, unreadable record files, and native view
  opens the terminal still retains.
- **Plan:** a pure function of the scan, so nothing is classified from a resource Tandem changed.

### Classification

- Live owned coordinator: it, its pane, its recorded panel pane (Tandem UI), and its lease are
  retained and named with the session.
- Stopped owned coordinator: workspace retired, its panel closed first, through the same
  proof-then-close owner a replacement launch uses, then its exact lease released and record
  removed.
- Orphaned coordinator lease (coordinator holder identity, no record names it): released by exact
  lease id, holder, and path when its checkout is clean.
- Dirty, unmerged, unlanded, foreign, or ownership-uncertain worktree: retained with the reason.
  Non-coordinator leases are released only through their durable task cleanup owner, never by path.
- Terminal implementation tasks and completed or safely cancelled scouts: finished through the
  durable task cleanup owner, keeping report, provenance, and history. An implementation worktree
  returns only when clean and its HEAD is already in main; otherwise `worktreeStays` gives the
  reason, unless it is freeable.
- Record Tandem cannot place (e.g. under a session directory it does not name): quarantined with a
  durable note, written once per lease; nothing closed or released.
- Worktree Treehouse reports a live process running inside: kept with "a running process is using
  this worktree", since returning it would end that process. Every release path refuses the same way.
- Unreadable record file: listed with path and reason, never deleted.
- Quarantine note: removed only when no record names its lease and Treehouse, re-read under the
  repository lock, no longer holds it. Kept when its lease cannot be read.
- Retained native view open (Tern, under `<home>/native-host/`): an open whose outcome was never
  proved, which pauses new native views for its coordinator. Listed with its view kind and why
  (no receipt, a failure after layout changes, or a done receipt without exact block proof).
  Applying abandons it only under that coordinator's open lock, while the record is unchanged,
  after the terminal proves the coordinator pane exactly present or exactly gone again. A
  detached or otherwise inconclusive answer keeps it. Abandoning removes only the ticket and its
  receipt; no pane is closed and nothing is reopened. An unreadable ticket is listed and kept. A
  receipt that arrives after its ticket was abandoned is removed by the next recovery. If the
  retained opens cannot be listed at all, the scan reports that as a `native-open` failure and
  still covers every other resource.

### Superseded worktrees (`freeable`)

- A clean worktree on its task branch is freeable when git proves every commit beyond main is
  carried elsewhere: each non-merge commit is an ancestor of, or patch-equivalent
  (`git rev-list --cherry-mark`) to, a commit in another task's branch, a draft/open/merged PR head
  recorded on any task, or main (primary checkout HEAD or `origin`'s default branch). A merge commit
  is carried when all its parents are.
- `containedIn` names the carrier, marked "(same changes, rebased)" when patch equivalence was
  needed, or `main`.
- Freeing needs its own approval: a separate prompt after the cleanup prompt, or non-interactively
  `--yes --free-superseded` (`--yes` alone never frees).
- Freeing re-proves checkout, HEAD, and containment under the state lock, then runs `treehouse
  return --force`, which detaches the worktree and keeps the branch ref and commits.

### Applying

- The dry run changes nothing, takes no lock, and never disturbs a live coordinator. Without
  `--yes` it asks before cleaning; non-interactive without `--yes` refuses.
- Coordinator and pool-lease items take the shared repository lock, then the session launch lock,
  so a concurrent launch cannot allocate underneath. Task cleanup uses its durable owner.
- A `clean` item is a prediction: applying re-reads the resource and its owner may still retain or
  quarantine it. A second apply cleans nothing.
- `--json` is `schemaVersion` 3 with `mode`, `home`, and `cleaned`, `retained`, `quarantined`,
  `failed`, `freeable` lists of entries (kind, id, repository, session, path, reason). Version 3
  added the `native-open` kind.
- The human view prints one line per thing; a task line includes its lease's worktree number, so a
  task-held lease is never listed separately.
- Exit is non-zero only when the scan or an apply failed, never for a deliberate retain.
