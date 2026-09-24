# Tandem

Tandem helps you get coding work done with AI. You describe what you want and approve the plan;
Tandem organizes the coding, testing, review, context management, and worktree management. It remembers what’s finished, what’s still in progress, and what needs your input, so you can return later without starting over.

Tandem runs locally on macOS, using [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi)
for AI conversations.

## Before you start

From the Tandem folder on macOS, run the commands below. They use the official
[Bun](https://bun.com/docs/installation), [Herdr](https://herdr.dev/docs/install/),
[Treehouse](https://github.com/kunchenguid/treehouse), and [OMP](https://github.com/can1357/oh-my-pi)
installers. These scripts execute locally; inspect the linked instructions before running them.

```sh
# Bun
curl -fsSL https://bun.com/install | bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# Herdr and Treehouse
curl -fsSL https://herdr.dev/install.sh | sh
curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh

# OMP
bun install -g @oh-my-pi/pi-coding-agent

# Install Tandem's dependencies from this checkout
bun install
# Link Tandem's terminal front door from this checkout
bun link
```

Confirm the installation:

```sh
tandem --help
```

The Bun global bin directory must be on `PATH` for `tandem` to work outside this checkout.

If `git` is missing, run `xcode-select --install` and wait for Apple's installer to finish
before continuing. Then follow the [global skill installation](docs/agent-reference.md#install-the-global-skills)
for the three Tandem skills.
Tandem uses your local tools and credentials; it is not a security sandbox.

## Use Tandem from the terminal

The installed `tandem` command is the primary front door. From any directory after `bun link`, run
bare `tandem` to open or reconnect all saved projects using your remembered setup:

```sh
tandem
```

A normal launch also starts a stopped Herdr session; saved coordinator pane records do not require
a reset. Coordinators resume their saved chats by default; add `--fresh` to start new ones. Task
state is retained either way.

`tandem --help` lists every command:

| Command | What it does |
| --- | --- |
| `tandem [PATH ...]` | Open or reconnect projects; resumes coordinator chats (`--fresh` starts new ones) |
| `tandem status [TASK_ID]` | What is running and what needs you; `--logs` shows prompt routing |
| `tandem update` | Load your latest local Tandem code into every coordinator, keeping chats and tasks |
| `tandem fix` | Find stale Tandem resources and offer the repair |
| `tandem reset` | Cancel all in-progress tasks and reopen fresh coordinators |
| `tandem reset --hard` | Delete all Tandem state and worktrees; the next run onboards from scratch |
| `tandem configure [PATH]` | Inspect or save repository settings |
| `tandem config [PATH]` | Open the project's settings file in `$VISUAL`/`$EDITOR` |

`--yes` skips the confirmation for `fix` and `reset`, `--json` prints machine-readable output for
`status` and `fix`, and `--home PATH` selects a different Tandem home. Old spellings (`restart`,
`--restart`, `--reset`, `--force`, `--continue`, `logs`, `reconcile-resources`,
`inspect`) exit with an error that names the replacement.

### Check status

```sh
tandem status
tandem status TASK_ID
tandem status --logs
```

`tandem status` prints the Tandem code commit, the open coordinators, and which tasks need you or
are still working. `tandem status TASK_ID` prints the full durable inspection for one task. Add
`--json` to either for machine-readable output. `tandem status --logs` prints the most recent
prompt-routing events and the resolved log path, even when no routing events exist. All three are
read-only.

### Update coordinators to the latest local code

```sh
tandem update
```

`update` replaces every saved project's coordinator with one running the latest local Tandem code
(the checkout the `tandem` binary runs from). Chats and tasks are kept; add `--fresh` to start new
chats. It can run from a separate terminal or from any Herdr pane except the coordinator pane it
would close.

Update verifies exact Tandem ownership, revalidates the pane cwd/process immediately before close,
confirms close acknowledgement and pane absence, then launches a replacement with the same
lease/session directory. Child panes, task IDs and generations, worktrees, conversation history,
pending questions/messages, and reports are preserved. Foreign, ambiguous, or missing ownership
refuses before any close. Update replaces only coordinators; it never cancels work.

To restart one managed worker without replacing the coordinator, use `/tandem restart TASK_ID`,
the tool request `{request:{action:"restart",taskId:"TASK_ID"}}`, or the advanced action CLI:

```sh
bun src/cli.ts restart TASK_ID
```

The acknowledged pause/stop/resume bridge preserves task identity, generation, worktree, worker
context, messages, reports, and questions. Cancelled or completed tasks and paused/blocked tasks
with an unanswered question are refused. A coordinator cannot restart itself.

### Fix stale resources

After a crash, a forced exit, a session change, or a failed launch, let Tandem find and clean what
it left behind instead of deleting anything by hand:

```sh
tandem fix
tandem fix --yes
```

It scans the coordinator records, Herdr panes, and Treehouse leases of every Tandem session under
the home, classifies each resource, prints what it would clean, and asks before changing anything.
`--yes` applies without asking.

Live coordinators are retained; a stopped owned coordinator has its pane closed, its exact lease
released, and its record removed; an orphaned clean coordinator lease is returned by its exact
lease identity; and terminal task resources are finished through the durable task cleanup owner.
Anything dirty, unmerged, unlanded, foreign, or ownership-uncertain is kept and reported with its
reason. Quarantine notes and unreadable record files are listed with their path and never deleted.
Reports, task history, provenance, and unmerged branches survive, applying is idempotent, and
`--json` prints a versioned report for automation. The exit code is non-zero only when the scan or
an apply actually failed, not because something was retained. A stuck task is recovered with
`restart`, not with this command.

### Reset

```sh
tandem reset
```

`reset` cancels every in-progress task across all saved projects, stops their owned worker,
validation, and presentation terminals, and reopens each coordinator with a fresh chat, even when
it is busy. It keeps onboarding, settings, task history, worktrees, uncommitted changes, and your
files. Completed retained task terminals are closed without erasing completed task history. It
takes no paths, asks to confirm (or pass `--yes`), and can run from a separate terminal or from any
Herdr pane except a coordinator pane. Reset does not bypass ownership checks or the clean-source
requirement for coordinator worktrees, and it is not task recovery.

Reset also closes a recorded coordinator pane that has returned to its shell, provided its native
identity and worktree still match. Herdr removes a workspace when its last pane closes, so closing
that owned pane is the default outcome. A workspace is retained (renamed to `Retained terminals`)
only when another pane still shares the coordinator workspace after the owned pane closes; that
extra pane is left open, and `tandem`/`tandem reset` print a notice naming it. Custom labels are
preserved untouched, and a pane that cannot prove it has exactly stopped is quarantined (left alone,
also with a printed notice) rather than closed. A normal relaunch retires a previous stopped
coordinator's pane the same way. Labels alone never authorize closing a workspace or pane.
Unrelated Herdr terminals are left untouched.
Replacing a coordinator also reuses or releases its exact previous worktree lease, so repeated
launches and updates do not accumulate coordinator worktrees. A previous checkout with uncommitted
or unmerged work is kept and reported, never released. If a launch fails after acquiring a new
lease, it rolls that lease and its new pane back; whatever it cannot prove safe to undo is recorded
under `<home>/coordinator-quarantine/` and named in the error instead of being guessed at.
Unknown, foreign, or otherwise unsafe ownership refuses before any pane is closed; if a coordinator
changes state or fails to close after earlier ones in the same run already closed, reset stops and
reports exactly which coordinators it already closed.

```sh
tandem reset --hard
```

`reset --hard` starts over. It stops everything the way `reset` does (best effort), then deletes the
Tandem home: `state.sqlite`, onboarded project records, `models.json`, the registry, and every pool
worktree, **including work that was never pushed or merged**. It also deletes the pool root when it
lives outside the home and the remembered setup file `~/.config/tandem/config.json` when it points
at that home, then runs `git worktree prune` in each onboarded repository. Your repositories are not
otherwise touched. It lists everything it will delete and asks first (or pass `--yes`), and it refuses
to delete `$HOME`, `/`, or any directory that contains an onboarded repository. The next `tandem`
onboards from scratch.

Bare `tandem` uses only saved project records under `<home>/repositories`; it does not scan arbitrary
disk repositories, auto-register projects, show a project picker, or request a path. Saved-project
selection takes precedence over the current working directory and needs no project-selection prompt,
including in a non-TTY or `--headless`/`--no-attach` launch.

To open only a subset of saved projects or explicitly add/open projects, pass one or more paths.
Explicit paths override the saved registry and open only the supplied canonical Git projects. Multiple
paths share one Herdr session while keeping one clean coordinator and child-worker group per project:

```sh
tandem /absolute/path/to/repo
tandem /absolute/path/to/first-repo /absolute/path/to/second-repo
```

If the saved registry is empty, bare `tandem` retains the first-run fallback: from a Git checkout it
onboards and opens the current Git project; outside Git, the existing interactive project-selection
fallback lets you enter or add a project path. The empty-registry fallback keeps its existing
interactive-terminal requirements.

Tandem reuses your remembered setup when reconnecting or configuring models:

```sh
tandem /absolute/path/to/repo
tandem configure /absolute/path/to/repo
tandem config /absolute/path/to/repo   # open the project's settings file in $EDITOR
```

`configure` remains a single-project catalogue-anchor flow: it asks for and saves all five global role
choices (Planning, Research, Coding, Review, and Presentations) without launching a
coordinator. With no path, it keeps its current-Git or existing interactive one-project anchor
fallback; it never expands to all saved projects. `--headless` prepares coordinators without
attaching Herdr, and `--no-attach` also skips the GUI attachment. `--help` shows the terminal
command's complete options. Ordinary use needs only a repository path. Advanced overrides remain
available through flags and `TANDEM_HOME`, `TANDEM_SESSION`, and `TANDEM_POOL_ROOT`; otherwise
Tandem reads the optional remembered setup in `~/.config/tandem/config.json` (or under
`XDG_CONFIG_HOME`). The pool is derived automatically from the selected home. See
[remembered setup](docs/agent-reference.md#remembered-setup) for configuration and precedence.

Each project in a launch set gets its own coordinator conversation and dedicated clean Treehouse
source worktree. Fresh launches and restarts fetch and capture `origin/main`; repositories without
an `origin` use their committed local `HEAD` explicitly. Multiple projects share one Herdr session,
but coordinators and child-worker groups remain scoped to their original project identities. The
original checkout may be dirty and remains untouched; source reads and delegated execution use
clean snapshots, while settings, task records, and delivery retain the original project identity.
When several projects are opened, Tandem attaches once every coordinator is ready.

One repository gets one coordinator across every session that shares a Tandem home, so switching
from `tandem` to a session such as `tandem-fresh` reconnects or reconciles instead of starting a
second coordinator. A coordinator another session still runs is never stopped or adopted: the
launch refuses and names the session holding it. Set `TANDEM_ALLOW_PARALLEL_COORDINATORS=1` when
you deliberately want parallel coordinators for one repository; it is off by default. See
[one coordinator per repository](docs/agent-reference.md#launching-the-coordinator).

Child agents run in real interactive OMP terminals, not JSON-log panes. Open their Herdr subtree
to watch the work or chat directly. Completed agents stay open for read-only follow-up; their
delegated result is recorded independently of terminal output. Further implementation goes through
the coordinator so validation and review keep exclusive access to the checkout. Validation runs
in a separate non-model pane. Explicit cleanup can close idle completed agents, but preserves
busy conversations, pending editor drafts, and terminals whose ownership cannot be proven.

New task workspaces use the task objective, a short identity suffix, and a role cue instead of an
opaque technical name. Presentation workspaces use the same convention. Existing/custom labels,
task IDs, and worktree names are not renamed.

Herdr's status bubbles show active agents and validation as working, questions and paused workers
as blocked, and completed turns as idle (which Herdr may display as done). An idle coordinator
also reflects its project's pending work and approval/blocking states. These are display hints,
not ownership or completion evidence; durable task records remain authoritative.

An explicit `tandem PATH` opens or reconnects only that project after ownership checks and resumes
its saved conversation unless you add `--fresh`. Before each
planning turn, a managed coordinator refreshes its owned, clean source checkout from `origin/main`.
New tasks capture that revision; existing tasks and workers keep their original pins and checkouts.
Fetch or source-safety failures block new task creation rather than silently using stale source.
Use `tandem update` to reload the extension and refresh source without resetting child work.

These fences do not make external effects transactional or guarantee availability; they
make uncertain ownership fail closed and keep the evidence for an explicit decision.

`tandem fix` does not accept project paths; `--home` must identify the Tandem home, not a
repository. See the [agent/operator reference](docs/agent-reference.md) for
the storage table and recovery contract.

## Use Tandem conversationally (optional)

Conversational skills are optional. In a fresh agent session, start with:

> How do I use Tandem?

Then ask for the action you want:

> Onboard `/path/to/repo`.
>
> What is the current state of my Tandem tasks?
>
> Launch Tandem for `/path/to/repo`.

Use `/skill:tandem`, `/skill:tandem-onboard`, or `/skill:tandem-status` when you want the
conversational flows. They do not replace the installed terminal command or start work merely
because Tandem is mentioned. Low-level `src/cli.ts` commands remain an advanced fallback for
exact automation and diagnostics.

Onboarding always covers all five role choices: **Planning** (`coordinator`), **Research** (`scout`),
**Coding** (`implementer`), **Review** (`reviewer`), and **Presentations** (`presentation`). For each
role, explicitly choose or accept the exact catalogue model `selector` and a supported thinking
level; recommendations never fill omitted roles, and a complete five-role recap appears before
saving. **Not now** pauses first-time onboarding before `configure-models`, project setup, or
launch, with no fallthrough to built-in defaults. Returning onboarding shows all five saved exact
selector/thinking pairs and offers **Keep all** (read-only, no new role answers; it may continue the
existing project-setting flow), **Change roles** (explicitly choose or keep each role, with
untouched roles preserved in the recap), or **Not now** (pause with choices unchanged, without setup
or launch). The existing `configure-models` approval is required to save changes. Approved choices
apply to future work across projects; a main-model change takes effect on the next Tandem launch,
not in an already-running conversation.

For an approved task, a clear follow-up direction can be sent with the coordinator's `steer`
action without a redundant generic approval prompt; `steer` queues it for the next safe boundary.
Ask for `messages` when you need a queued, received, or delivered receipt, not as a repeated polling
loop. Worker needs-decision questions wake the coordinator as the single user inbox. The coordinator
first checks the durable question id, recommendation, report path, approved scope, prior directions,
and unambiguous in-scope repository evidence. It may answer a safe, non-destructive question already
settled by that evidence through the questionId-bound `answer` action with a concise rationale; it
must bring genuine product choices, ambiguity, scope changes, credentials, destructive actions, and
publishing, merging, or deployment decisions to you. A receipt is not proof that implementation is
finished.

## Coordinator compaction

When a task finishes, nothing is waiting on you, and the coordinator is idle, Tandem compacts the
coordinator's conversation once it is over 128,000 tokens, so later turns stop resending old
history. Task state is re-added from durable records. Set `TANDEM_COORDINATOR_COMPACT_TOKENS` to
change the threshold, or `0` to leave compaction to OMP alone.

## Jev integration and prompt routing

TypeSafe Jev is an optional classifier for unmatched natural-language coordinator input. Set
`TYPESAFE_API_KEY` before launching Tandem to enable it; without a key, prompts use the normal
coordinator path. `TANDEM_JEV_TIMEOUT_MS` sets a bounded 100–10,000ms timeout (default 1,500ms).
The pinned provider model is Jev `1.13.0`.

Exact slash commands bypass classification. For other prompts, Jev returns five typed facts:
supported action, target, effect, scope, and composition. Code remains authoritative for task
identity, ownership, approvals, state, and execution. Only these read-only actions can terminate
directly: `list`, `presentations`, `show`, `messages`, and `inspect`. Task-specific
lookups require an explicit `task-...` identifier or UUID in the prompt. The direct path calls the
existing Tandem service and displays its bounded result.

Low confidence (below `0.80`), missing facts, mixed requests, unclear scope, state-changing or
sensitive effects, missing task identity, provider failure, timeout, and malformed output all
fall back to the normal coordinator. Jev never generates shell commands, authorizes an effect,
changes task state, or receives the full conversation transcript.

Routing events are append-only JSONL at `<home>/logs/tandem.jsonl`. They contain a short prompt
hash, route facts, confidence, bounded reason, and latency; raw prompts and API keys are not
recorded. See the [Jev integration overview](docs/jev-prd.md), [prompt-routing PRD](docs/jev-prompt-routing-prd.md),
[context reuse PRD](docs/jev-context-reuse-prd.md), and [evaluation plan](docs/jev-evaluation.md).

## What approval means

Tandem first inspects your project without changing it. Saving settings, starting Tandem,
approving a coding plan, publishing a pull request, merging, and deleting unfinished work each
need your approval. Research can start before you approve code changes; coding waits for your
approved plan, followed by checks and a separate review. Tandem never merges automatically.
Coordinator self-resolution is bounded workflow guidance, not deterministic enforcement; runtime
ownership, approval, and safety checks remain authoritative.

Delegated scouts use read-only repository tools and native `web_search`: they prefer official or primary sources, use `read` for known URLs, cite sources, and separate verified facts from recommendations. Queued or blocked delegation is actionable state, not a running or completed research effort; the coordinator must disclose it and never silently take over research without explicit user authorization. Recorded task counts and statuses come from saved durable task state, not receipts or process observations.
Asking how it works does not give it permission to inspect files or take action.

## References

- [Agent/operator reference](docs/agent-reference.md) — CLI, installation, policy, lifecycle,
  storage, worktrees, delivery, presentation, recovery, and operational contracts.
- [`tandem` usage skill](skills/tandem/SKILL.md)
- [`tandem-onboard` skill](skills/tandem-onboard/SKILL.md)
- [`tandem-status` skill](skills/tandem-status/SKILL.md)
