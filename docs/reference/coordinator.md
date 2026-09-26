# Coordinator launch, update, and reset

How Tandem selects projects, launches and replaces coordinators, retires old panes and leases, keeps
one coordinator per repository, and what `update`, `reset`, and `reset --hard` preserve or delete.

Code: src/main.ts, src/terminal/arguments.ts, src/terminal/launch.ts, src/terminal/hard-reset.ts,
src/config/environment.ts, src/coordinator/launch.ts, src/coordinator/ownership.ts,
src/coordinator/registry.ts, src/coordinator/record.ts, src/coordinator/lock.ts,
src/coordinator/exclusivity.ts, src/coordinator/resources.ts, src/coordinator/workspace.ts,
src/coordinator/restart.ts, src/coordinator/reset.ts, src/coordinator/source.ts,
src/coordinator/renest.ts. Tests: tests/coordinator/, tests/terminal/main.test.ts.

## Setting resolution

`resolveTandemEnvironment` in src/config/environment.ts:

| Setting | Precedence |
| --- | --- |
| Home | `--home` → `TANDEM_HOME` → remembered setup → `~/.tandem` |
| Session | `--session` → `TANDEM_SESSION` → `HERDR_SESSION` → `HERDR_SESSION_NAME` → remembered setup → `tandem` |
| Pool root | `--pool-root` → `TANDEM_POOL_ROOT` → `<home>/pool` |

Keep overrides consistent across reconnects so the same durable state and Herdr session are reused.
The low-level launch's `--repo` is the original project identity; launch derives the clean source
checkout itself. Its `--extension` and `--config` must be Tandem's checked-in files.

### Remembered setup

`$XDG_CONFIG_HOME/tandem/config.json` (default `~/.config/tandem/config.json`) holds
`{schemaVersion: 1, home, sessionId}` and nothing else.

- It must be a regular file (no symlink), the home absolute, the session free of control
  characters. Unknown versions, extra keys, and malformed values throw rather than silently
  selecting other state.
- Reads and launches never create or change it. It never moves or migrates a home's records.
- An explicit `--home` or `TANDEM_HOME` skips the remembered file entirely, session included, so a
  temporary home never inherits the remembered session.

## Project selection

- Explicit `PATH ...` overrides the registry and opens only those canonical Git roots.
- With no paths, `tandem`, `update`, and `reset` open the valid saved projects under
  `<home>/repositories` plus the Tandem checkout (see [The Tandem coordinator](#the-tandem-coordinator)),
  last so an existing user still lands on their first project. With no saved projects that is the
  Tandem checkout alone, wherever `tandem` runs. No disk crawling, auto-registration, picker, or
  path prompt, including in non-TTY, `--headless`, and `--no-attach` launches.
- `configure` and `config` are single-project and never expand to all saved projects: the cwd's Git
  project, or the interactive project-selection fallback outside Git (which needs a TTY). `config`
  refuses a project without saved settings.
- All projects share one Herdr session, but each gets its own coordinator workspace, clean source
  worktree, and child-worker group. Coordinators scope durable task operations to their original
  project identity, so one cannot claim another project's work.
- The terminal attaches once after every coordinator is ready, and releases its setup readline
  first so Herdr is the only terminal input owner.

Old spellings (`restart`, `--restart`, `--reset`, `--force`, `--continue`, `logs`,
`reconcile-resources`, `inspect`) exit with an error naming the replacement (`RENAMED` in
src/terminal/arguments.ts) instead of being read as a project path.

## The Tandem coordinator

The coordinator of the Tandem checkout the `tandem` command runs from (`TANDEM_CHECKOUT`,
src/coordinator/tandem-checkout.ts). It is where a new user starts and where anyone changes Tandem.

- It launches like any project, from a clean worktree of the Tandem checkout, but without saved
  project settings: `prepareProjects` never asks **Save settings** for it. Model choices are still
  asked in the terminal the first time, because a coordinator needs a model to start.
- `isTandemCheckout` compares canonical paths. When it holds, the coordinator's context adds
  `TANDEM_COORDINATOR_INSTRUCTIONS` (src/instructions.ts): onboard repositories the user names
  (`onboard`, `models`, `configure-models`, `setup`, then `open-project`), try settings before code
  when the user wants Tandem changed, and route code changes through ordinary tasks in this project.
- `open-project` (approval required) runs the front door for one saved project, `tandem PATH
  --no-attach` in the same home and session (src/coordinator/open-project.ts), with the calling
  pane's `TANDEM_REPO`, `TANDEM_SOURCE_REPO`, `TANDEM_PARENT_WORKSPACE`, `HERDR_PANE_ID`, and
  `HERDR_WORKSPACE_ID` removed so the launch claims nothing of this coordinator. It refuses a
  project without saved settings or saved model choices, before running anything.
- At each session start, while no saved project other than the Tandem checkout exists, it opens
  the welcome popup: `herdr plugin pane open --plugin tandem.ui --entrypoint welcome` with
  `TANDEM_WELCOME_PANE` set to its own pane. The popup runs `tandem welcome`
  (src/terminal/welcome.ts): Enter sends "Help me onboard my repos" to that pane (`herdr agent
  prompt`, or `pane send-text` and Enter when Herdr sees no agent there); Esc or q closes it. When
  the popup cannot open (plugin not linked, Herdr too old, no Tandem pane), the same text is
  delivered in the chat without a model turn.
- The plugin lives in `herdr-plugin/`; `setup.sh` links it (see [status.md](status.md)).

## Source worktree and identity

- Fresh launch and update fetch `origin/main` and start OMP in a distinct clean Treehouse source
  worktree pinned to it. Without `origin`, launch uses the original repository's committed local
  `HEAD`. A configured remote whose fetch fails never falls back to stale source.
- The original checkout may be dirty and is never touched. Settings, task records, and delivery use
  the original identity (`TANDEM_REPO`); the owned clean checkout is `TANDEM_SOURCE_REPO`.
- Before each planning turn the coordinator refreshes only its proven-owned clean checkout. A
  durable refresh intent recovers an interrupted switch only for the same lease at its recorded old
  or new HEAD. Dirty, foreign, or unexpectedly moved checkouts fail closed.
- Existing task records are never migrated on relaunch; they stay attached to their original
  project identity and pinned source until an explicit recovery decision.

## Launch readiness

- Launch succeeds only after Herdr reports a running server and native pane inspection verifies
  the expected OMP command and clean cwd. A successful `pane run` alone is not readiness.
- A private bootstrap script keeps the initial terminal command short.
- Child-workspace creation and ordering share the central store lock so concurrent dispatch keeps
  each child group beneath its own coordinator.

## Launch script and stopped coordinators

- The coordinator pane runs a script under `<home>/coordinator-scripts/`. When the coordinator
  exits (Ctrl-C, crash), the script stays and offers to restart: Enter relaunches in the same pane
  with `--continue`, keeping record, lease, and pane; Ctrl-C drops to the pane's shell.
- `--continue` is not part of coordinator identity. The script waiting at its offer counts as a
  stopped coordinator shell, so update and reset may close that pane.
- An exited coordinator (Ctrl-C, crash, closed pane) is stopped. If its recorded pane now runs
  something else (a shell, a hand-started `omp`), Tandem scans all processes for the coordinator's
  own `--session-dir`:
  - none running: launch opens a fresh pane with `--continue`, leaves the old pane and its process
    untouched, and keeps the old lease under a quarantine note;
  - still running elsewhere, or the record predates `--session-dir`: refuse and name the one step
    to take.
  Reset still refuses to close such a pane, because it is no longer Tandem's.
- A pre-registry coordinator without a clean lease record is never adopted or duplicated; launch
  refuses and tells the user to stop it and relaunch (`legacyCoordinatorGuidance` in ownership.ts).

## Retiring a coordinator workspace

Applies when launch replaces a stopped coordinator and during reset.

- Herdr removes a workspace when its last pane closes. Retirement closes the coordinator's own
  pane only once exact ownership and a stopped process are proven.
- If other panes share the workspace, it is renamed `Retained terminals · <repo>` instead. Those
  extra panes are never closed just for sharing the workspace; they are reported with the outcome.
- A workspace with a user-set custom label is left entirely untouched, pane included.
- Ownership that cannot be proven exactly and as stopped (cwd or process no longer matches the
  record) is quarantined: not closed, not renamed, reported, and listed again by `tandem fix`.
- There is no explicit-retention option.
- Retirement runs before the replacement workspace is created or the record is overwritten. If it
  fails, launch rejects, the old record and terminals stay, and the next launch retries.
- Launch and reset print a notice only for retained or quarantined outcomes.
- Workspace labels alone never prove ownership or authorize closing a terminal.

## Coordinator lease replacement

Replacement is transactional so repeated launches converge on one coordinator lease
(`decideCoordinatorReplacement` / `applyCoordinatorReplacement` in resources.ts).

After pane retirement reports `closed` or `already-clear`, launch reads the previous checkout and
decides from that evidence alone:

| Previous checkout | Action |
| --- | --- |
| Clean, pinned to the commit the replacement wants | Reuse the lease |
| Clean, different commit needed | Release that exact lease, drop its record |
| Uncommitted changes or unmerged paths | Retain |
| Unexplained: unreadable, wrong branch, HEAD neither the lease base nor a recorded refresh target, or its pane was quarantined | Quarantine |

- A release names the exact lease id, holder, and path; never match by label, pool position, or
  path guess. Task worktrees are never inspected or returned here.
- The replacement lease is allocated only after this cleanup.
- If a later startup step fails, the launch rolls back only its own resources: it retires the pane
  it created through the same ownership-proving path, then releases the lease it acquired.
- Anything it cannot prove safe to undo (unidentified process in the pane, a changed checkout, a
  Treehouse refusal) becomes a durable note under `<home>/coordinator-quarantine/` naming lease,
  pane, and reason, and the launch error names that note.
- A lease the previous record still points at is never rolled back; the record stays its owner.
- A previous lease that cannot be released becomes a quarantine note rather than blocking launch.
  No coordinator lease is left untracked, and the user is never locked out of their coordinator.

## One coordinator per repository

By default one canonical repository has one active coordinator across all sessions sharing a home.

- Launch and update take a repository lock at
  `<home>/coordinator-registry/repository-<digest>.lock`, keyed by canonical path so two spellings
  (symlink, different path text) share one lock.
- Lock order, which prevents deadlock: repository lock, then the launching session's launch lock,
  then the launch lock of any other session being reconciled. Reset and source refresh hold only a
  session lock and never take the repository lock.
- Under the lock, launch reads every session directory under `<home>/coordinator-registry/`.
  Discovery is read-only: records are matched on their own canonical repository path, not file
  name, and nothing is moved or rewritten. Each record carries its session of origin.

What launch does with each record found:

- **Own session:** the normal reconnect and replacement path above.
- **Live coordinator in another session:** refuse, naming that session and pane. Never stop, adopt,
  or force-close it, and never start a second coordinator beside it.
- **Stopped or orphaned coordinator in another session:** run the same retire, decide, and apply
  path under that session's launch lock. A retained or quarantined record stays as the durable
  owner of what Tandem refused to discard, is reported on every launch, and never blocks the new
  coordinator. Launch prints one notice per coordinator it settled for another session.
- **Misplaced record** (stored under a session directory it does not belong to) or **unreadable
  record** for this repository: refuse. A misplaced record also gets a quarantine note with stage
  `exclusivity` naming its lease and pane; an unreadable file names the file instead. A refusal
  releases and closes nothing.

Every refusal names `TANDEM_ALLOW_PARALLEL_COORDINATORS`. Setting it to `1` or `true` skips only
the cross-session claim; both locks are still taken so launches stay serialized. It is off by
default.

## Re-nesting task workspaces

A replacement coordinator workspace lands at the end of the Herdr sidebar, so launch and `tandem
fix` re-nest (renest.ts):

- Each live task workspace moves directly after its repository's live coordinator, oldest first.
- A workspace qualifies only when exactly one repository's durable task endpoints name it in this
  session, it is not a coordinator workspace, and it appears once in `herdr workspace list`.
- `workspace.move`'s `insert_index` is a gap in the list as it was before the move.
- Display-only: never creates, closes, or renames. No moves when already nested. An unreadable
  session or failed move becomes a one-line warning and never blocks launch or fix.
- It reads task records under the state lock and waits up to 30 seconds for it, because a restarted
  coordinator runs its first scheduler pass under that lock when the restart re-nests.
- The front door re-nests after every launch and again before attaching to Herdr (attaching blocks
  until the person leaves Herdr), and prints every warning, including each restart's, one per line.
- `fix` applies it without asking; `--json` reports it as `renest` (`planned`, `moved`,
  `warnings`, `leftovers`).
- A workspace carrying Tandem's `└ ` task label that no coordinator, task, or presentation record
  names (and no in-flight worker launch claims) is listed as a leftover and kept: a label is never
  ownership proof, so Tandem does not close it.

## Self-pane guard

`update` and `reset` refuse to run inside any recorded coordinator pane of the session
(`assertNotInCoordinatorPane` in src/main.ts), since they would close it. Any other pane or a
separate terminal is fine.

## `tandem update`

Replaces every saved project's coordinator with one running the current local Tandem code. It is
not cancellation or recovery.

- Runs the low-level launch with `--restart` per project (restart.ts), prefetching fresh source
  before closing the old coordinator.
- Verifies exact recorded ownership, revalidates pane cwd and process immediately before close,
  confirms the close acknowledgement and that the pane is gone, then launches with the same lease
  and session directory and `--continue` (omitted with `--fresh`).
- Preserves child panes, task IDs, generations, worktrees, leases, conversation history, pending
  questions and messages, and reports.
- Foreign, ambiguous, or missing ownership refuses before any close.
- No restart path lets a coordinator restart itself. Per-task worker restart is a separate action;
  see [control](control.md).

## `tandem reset`

Cancels all in-progress work across every saved project and reopens every coordinator with a fresh
chat, busy ones included. Takes no paths; confirms unless `--yes`. Owned by reset.ts.

Ordering and locks:

- Runs after confirmation and after setup readline is released, before any normal launch or
  attachment.
- Takes one shared coordination lock and the central task-store lock. Presentation feedback locks
  are acquired before the task-store lock and the selected set is rechecked afterward, so a
  presentation cannot complete while being cancelled.

Preflight (refusals happen here, before any pane closes or coordinator launches):

- Validates all selected roots and checks task and presentation endpoints, including retained
  terminals, against durable job identities and native process state.
- Unknown, foreign-session, legacy, malformed, or unsafe ownership, ambiguous pending launches, or
  an unsafe coordinator source refuse with no effects.
- A recorded coordinator pane that returned to its shell is eligible only when native pane
  identity, shell process identity, and foreground worktree all still match the record.

Effects:

1. Persist cancellation intent for active tasks.
2. Close interactive workers without waiting for idle prompts. Interrupt validation through its
   runner first so detached commands are terminated and reaped.
3. Persist stopped jobs and released reservations. Active tasks become cancelled; selected
   presentations become failed. Completed history and tasks awaiting approval are kept.
4. Close exact owned coordinator panes, rechecking native ownership before each close and verifying
   the pane disappeared. Then resume normal launch with fresh chats.

Failure: if a coordinator changes state or a close fails after others in the batch already closed,
reset stops closing, errors naming what closed and what stopped it, and does not force-close, retry,
or roll back. The report lists already-cancelled tasks and stopped panes; a retry never resurrects
interrupted work.

Reset never stops a server, clears the registry, recovers task work, or discards onboarding,
settings, task history, worktrees, uncommitted task work, or repository files. Reset is not
recovery; see [Central recovery](recovery.md#central-recovery).

## `tandem reset --hard`

Owned by src/terminal/hard-reset.ts.

- Lists what it will delete and confirms unless `--yes`.
- Refuses before deleting anything if a target is a filesystem root, `$HOME`, an ancestor of
  `$HOME`, or contains an onboarded repository (`assertRemovable`).
- Stops coordinators and task work like `reset`, best-effort.
- Deletes the Tandem home (`state.sqlite`, `repositories/`, `models.json`, the registry, and every
  pool worktree, including unpushed or unmerged work), the pool root when outside the home, and
  the remembered setup file only when it names that home.
- Runs `git worktree prune` in each onboarded repository so deleted worktrees are unregistered.
- Unreadable project records do not stop it. The next `tandem` onboards from scratch.
