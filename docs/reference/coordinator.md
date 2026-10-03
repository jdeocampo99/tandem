# Coordinator launch, update, and reset

How Tandem selects projects, launches and replaces coordinators, retires old panes and leases, keeps
one coordinator per repository, and what `update`, `reset`, and `reset --hard` preserve or delete.

Code: src/main.ts, src/terminal/arguments.ts, src/terminal/launch.ts, src/terminal/hard-reset.ts,
src/config/environment.ts, src/coordinator/launch.ts, src/coordinator/ownership.ts,
src/coordinator/registry.ts, src/coordinator/record.ts, src/coordinator/lock.ts,
src/coordinator/exclusivity.ts, src/coordinator/resources.ts, src/coordinator/workspace.ts,
src/coordinator/restart.ts, src/coordinator/reset.ts, src/coordinator/source.ts,
src/coordinator/renest.ts, src/harness/contract.ts (the launch port), src/harness/resolve.ts,
src/harness/omp/launch.ts, src/harness/claude-code/launch.ts.
Tests: tests/coordinator/, tests/harness/omp/launch.test.ts, tests/harness/claude-code/launch.test.ts,
tests/evals/harness-scenarios.test.ts, tests/terminal/main.test.ts.

## Setting resolution

`resolveTandemEnvironment` in src/config/environment.ts:

| Setting | Precedence |
| --- | --- |
| Home | `--home` → `TANDEM_HOME` → remembered setup → `~/.tandem` |
| Session | `--session` → `TANDEM_SESSION` → `HERDR_SESSION` → `HERDR_SESSION_NAME` → remembered setup → `tandem` |
| Pool root | `--pool-root` → `TANDEM_POOL_ROOT` → `<home>/pool` |

Keep overrides consistent across reconnects so the same durable state and Herdr session are reused.
The low-level launch's `--repo` is the original project identity; launch derives the clean source
checkout itself. Its `--extension` and `--config` must be Tandem's checked-in files
(src/harness/omp/extension.ts and src/harness/omp/worker-config.yml); a Claude Code coordinator
loads neither, so naming one for it is refused. Launch checks every file and directory its harness
loads before starting anything (see [harness.md](harness.md#the-launch-port)).

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
- Tandem starts the shared Herdr server in the Tandem home, never in a pool worktree, because
  returning a worktree ends every process still running inside it.
- The terminal attaches once after every coordinator is ready, and releases its setup readline
  first so Herdr is the only terminal input owner.

Old spellings (`restart`, `--restart`, `--reset`, `--force`, `--continue`, `logs`,
`reconcile-resources`, `inspect`) exit with an error naming the replacement (`RENAMED` in
src/terminal/arguments.ts) instead of being read as a project path.

## The Tandem coordinator

The coordinator of the Tandem checkout the `tandem` command runs from (`TANDEM_CHECKOUT`,
src/coordinator/tandem-checkout.ts). It is where a new user starts and where anyone changes Tandem.

- It launches like any project, from a clean worktree of the Tandem checkout, but the terminal asks
  nothing for it: `prepareProjects` asks neither **Save settings** nor model choices when it is in
  the launch set. While no model choices are saved, the CLI `launch` leaves out `--model` and
  `--thinking` for it (and only for it), so OMP runs its own default model; saved choices apply
  from its next launch. Projects opened by path still ask in the terminal.
- `isTandemCheckout` compares canonical paths. When it holds, the coordinator's context adds the
  short `TANDEM_COORDINATOR_INSTRUCTIONS` (src/instructions.ts: follow the setup step it is given;
  try settings before code when the user wants Tandem changed, and route code changes through
  ordinary tasks in this project).
- Setup is presented as four stages (src/onboarding/checklist.ts and the Lavish page): **Models**,
  **Repos**, **Self-improvement**, and **Review**. The Repos stage includes choosing code folders,
  selecting checkouts, and confirming validation and install commands. The page never asks the user
  to choose MCP servers or worker skills; each coordinator and child worker uses the skills and MCP
  servers OMP loads for its own checkout and user configuration. The Lavish Review Save is the user's
  one consent to apply that complete answer; chat actions keep their own approval. Discovery and
  checks change nothing.
- Where setup stands is worked out from saved state (`onboardingFacts` in the service): saved model
  choices, saved code folders, saved projects other than the Tandem checkout, and a written
  `selfImprovement`. Leaving halfway resumes at the first missing stage.
- Fixed wording wherever a step allows, delivered by code without a model turn
  (src/session/onboarding-guide.ts): at each session start while setup is unfinished, the missing
  tools (`checkTools`: Herdr, the welcome plugin, OMP, Git, a signed-in `gh`, each with the command
  that fixes it) and `ONBOARDING_DONE_TEXT` once, after the action that finishes setup. Steps move
  on after actions (a reconcile without a tick), never on the timer.
- The model reads only the current step's guidance (`onboardingContext`) while setup is
  unfinished, and nothing about setup once it is done.
- The setup page comes first when `lavish-axi` is installed (`setupPage` in the facts:
  `unavailable` without Lavish, `ready`, `open`, or `done` once this session's page was answered,
  closed, or failed to open; src/onboarding/setup-page.ts). While it is `ready`, the guidance tells
  the model to call `setup-page` (no approval) when the user wants to set up, with the chat steps as
  the fallback; while it is `ready` or `open`, the plain-choice questions are not asked in the chat.
  `unavailable` and `done` leave setup to the chat steps above.
- `setup-page` builds one self-contained page from a pure view model (`buildSetupView` in
  `src/onboarding/setup-view.ts`; `renderSetupHtml` with `setup-page.html`), writes it to
  `<home>/setup/tandem-setup.html`, and opens it with `lavish-axi PATH --reopen` (the user asked for
  it). Its four stages are Models, Repos, Self-improvement, and Review: models and thinking levels
  come from the full OMP catalogue; Repos shows checkouts crawled from `projectRoots`, each with
  discovered checks and install command; Self-improvement chooses `off`, `fix`, or `report`; Review
  recaps the answer and the providers Tandem may spend on. There is no MCP-server or worker-skill
  selection. OMP's own configuration scopes what the coordinator and child workers can load.
- In Repos, the local name filter narrows discovered checkouts. **Choose another folder…** requests
  the macOS folder picker, while the typed folder path is the fallback. Both scans are read-only,
  reject broad roots, and preserve the unsaved draft. A selected checkout can also be added by its
  exact path when discovery did not find it. Search results arrive through the open Lavish page:
  keep it open, and do not assume the result is immediate. Back/Next remain available while the
  request is in flight; when the rewritten page arrives it returns to Repos with the pre-request
  draft restored, even if the user had navigated elsewhere in the meantime.
- `setup-page` sends the final JSON answer directly through Lavish's `queuePrompt` /
  `sendQueuedPrompts` path. Code receives it from the Lavish poll listener, checks it against the
  current machine, stores a one-use answer id, and on the tagged Review Save applies it directly
  without another model turn. The backend re-checks the answer before saving, then applies models
  and only their selected providers (`configureModels`), `selfImprovement`, and code folders: if
  none were saved, searched folders that hold a repository plus the parent of any selected repo
  pasted from elsewhere; explicitly searched folders are appended to any existing saved roots,
  never overwritten. The answer file carries those pending roots so a coordinator restart does not
  lose them. Then each repository's `setup` with its validation and install commands is followed by
  `open-project`. A failed step is reported and undoes nothing; a repository whose settings failed
  is not opened. A stale or replaced answer id is refused. The coordinator posts a fixed success or
  error status without a model turn. The page has no completion acknowledgement: after submission it
  reports saving/request status and directs the user to chat. Plain comments from Lavish are relayed
  to the coordinator and its reply is returned to the Conversation panel; a folder search is
  answered in Lavish without a model turn.
- `find-repo` takes a name or a path; one match not yet set up also returns what `onboard` would
  (the proposal and how its pull requests merge), saving a call. A path (starting with `/`, `~`, or
  `.`) resolves to its Git root; a name matches a checkout under the code folders by folder name,
  GitHub repository name, or `owner/repo`, ignoring case (`findCheckoutsByName` in
  `src/repos/locate.ts`). Each match says whether it is already set up; several matches are a
  question for the user.
- `open-project` (approval required) runs the front door for one saved project, `tandem PATH
  --no-attach` in the same home and explicit target session (src/coordinator/open-project.ts), with
  the calling pane's `TANDEM_REPO`, `TANDEM_SOURCE_REPO`, `TANDEM_PARENT_WORKSPACE`, `HERDR_ENV`,
  `HERDR_SESSION`, `HERDR_SESSION_NAME`, `HERDR_WORKSPACE_ID`, and `HERDR_PANE_ID` removed so the
  launch claims nothing of this coordinator or inherits a dangling Herdr identity. It passes
  `--session` explicitly for the target session. It accepts any saved canonical project after
  checking its settings and model choices; ordinary task creation, model lookup, and `onboard`
  remain bound to the coordinator's source context. Afterwards it focuses the project's coordinator
  workspace from its record; a failed focus is reported, not an error.
- At each session start, while no saved project other than the Tandem checkout exists, it opens
  the welcome popup: `herdr plugin pane open --plugin tandem.ui --entrypoint welcome` with
  `TANDEM_WELCOME_PANE` set to its own pane. The popup runs `tandem welcome`
  (src/terminal/welcome.ts): Enter sends "Onboard me to Tandem" to that pane (`herdr agent
  prompt`, or `pane send-text` and Enter when Herdr sees no agent there); Esc or q closes it. When
  the popup cannot open (plugin not linked, Herdr too old, no Tandem pane), the same text, plus
  what to type to start, is delivered in the chat without a model turn.
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

- Launch succeeds only after Herdr reports a running server, the harness's ready wait passes, and
  native pane inspection verifies the expected coordinator command and clean cwd. A successful
  `pane run` alone is not readiness.
- OMP's ready wait passes at once. A Claude Code coordinator is ready when its sidecar answers on
  the conversation's socket; after 30 s without an answer its processes are stopped, the new pane
  and lease are rolled back, and the error names the trust question and mods switched off as the
  usual causes ([harness.md](harness.md#the-claude-code-coordinator)). In the caller's own pane the
  wait runs beside the coordinator and stops it the same way.
- A private bootstrap script keeps the initial terminal command short.
- Child-workspace creation and ordering share the central store lock so concurrent dispatch keeps
  each child group beneath its own coordinator.

## Launch script and stopped coordinators

- The coordinator pane runs a script under `<home>/coordinator-scripts/`. When the coordinator
  exits (Ctrl-C, crash), the script stays and offers to restart: Enter relaunches in the same pane
  with `--continue` (OMP) or `--resume <id>` of the same conversation (Claude Code), keeping record,
  lease, and pane; Ctrl-C drops to the pane's shell.
- `--continue` is not part of coordinator identity, and Claude Code's `--session-id <id>` and
  `--resume <id>` are the same coordinator. The script waiting at its offer counts as a stopped
  coordinator shell, so update and reset may close that pane.
- An exited coordinator (Ctrl-C, crash, closed pane) is stopped. If its recorded pane now runs
  something else (a shell, a hand-started `omp`), Tandem scans all processes for the coordinator's
  own `--session-dir` (OMP) or conversation id (Claude Code):
  - none running: launch opens a fresh pane with `--continue`, leaves the old pane and its process
    untouched, and keeps the old lease under a quarantine note;
  - still running elsewhere, or the record predates `--session-dir`: refuse and name the one step
    to take.
  Reset still refuses to close such a pane, because it is no longer Tandem's.
- A pre-registry coordinator without a clean lease record is never adopted or duplicated; launch
  refuses and tells the user to stop it and relaunch (`legacyCoordinatorGuidance` in ownership.ts).
  An unrecorded `claude` loading Tandem's adapter plugin can't be tied to a repository, so launch
  refuses beside it too.
- Each record names the coordinator's `harness` (see [harness.md](harness.md)); a record saved
  before that field is OMP. Only a new coordinator takes its harness from its model
  (`harnessOf`), and launch refuses it before checking files or starting anything when Tandem
  cannot run that harness. A running coordinator keeps its recorded harness, so `tandem`
  reconnects to it even after `models.json` names a model in another harness. `--restart` and
  `tandem update` check the replacement's harness before closing the running coordinator.
  Reconnect, restart, reset, and `tandem fix` match processes with the recorded harness, and a
  record whose `command[0]` is not that harness's executable, or whose harness is unknown, is
  unreadable.
- Commands and processes are matched through the launch port (`Harness` in
  src/harness/contract.ts, resolved by `harnessFor(name, "coordinator")`). Recorded ownership compares the live argv with the recorded command,
  so a coordinator launched before the OMP code moved under src/harness/omp/ still matches its
  record, which names the old src/extension.ts. The unrecorded check accepts both extension paths.
  Its pane's "press Enter to start it again" offer reruns the recorded command with the old path,
  which no longer exists, so run `tandem update` once after upgrading to relaunch it.

## Retiring a coordinator workspace

Applies when launch replaces a stopped coordinator and during reset.

- Herdr removes a workspace when its last pane closes. Retirement closes the coordinator's own
  pane only once exact ownership and a stopped process are proven.
- If other panes share the workspace, it is renamed `◇ <repo> (old)` instead. Those
  extra panes are never closed just for sharing the workspace; they are reported with the outcome.
- A workspace with a user-set custom label is left entirely untouched, pane included.
- A coordinator workspace is labelled `◆ <repo>`; one still labelled `Tandem coordinator · <repo>`
  from before retires the same way.
- A shell Herdr just restored is still starting (prompt, fastfetch), so launch retries retirement
  for about five seconds before treating the pane as busy. Without that wait, every Herdr restart
  left the old coordinator workspace open next to its replacement.
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

Replaces every saved project's coordinator with one running the current committed Tandem source. It
does not run uncommitted changes from the original checkout; this command is not cancellation or
recovery.

- Runs the low-level launch with `--restart` per project (restart.ts), prefetching fresh source
  before closing the old coordinator.
- Verifies exact recorded ownership, revalidates pane cwd and process immediately before close,
  confirms the close acknowledgement and that the pane is gone, then launches with the same lease
  and session directory and `--continue` (OMP) or `--resume` of the recorded conversation (Claude
  Code), both omitted with `--fresh`.
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
