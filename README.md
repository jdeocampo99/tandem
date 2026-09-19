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
a reset. Use `tandem --continue` to resume saved coordinator conversations. Task state is retained
with or without that flag.

To reload the coordinator extension without canceling or resetting work, use the non-destructive
restart from a separate normal terminal:

```sh
tandem --restart /absolute/path/to/repo
```

The frontdoor verifies exact Tandem ownership, revalidates the pane cwd/process immediately before
close, confirms close acknowledgement and pane absence, then launches a replacement with the same
lease/session directory and `--continue`. Child panes, task IDs and generations, worktrees,
conversation history, pending questions/messages, and reports are preserved. Foreign, ambiguous,
or missing ownership refuses before any close. This replaces only the coordinator; `--reset` and
`--reset --force` retain their destructive meanings.

To restart one managed worker without replacing the coordinator, use `/tandem restart TASK_ID`,
the tool request `{request:{action:"restart",taskId:"TASK_ID"}}`, or:

```sh
bun src/cli.ts restart TASK_ID
```

The acknowledged pause/stop/resume bridge preserves task identity, generation, worktree, worker
context, messages, reports, and questions. Cancelled or completed tasks and paused/blocked tasks
with an unanswered question are refused. A coordinator cannot restart itself.

To cleanly reopen only Tandem-owned coordinators, use the reset launch from a separate normal
terminal:

```sh
tandem --reset
```

With no paths, `--reset` selects every valid saved project; pass explicit paths to reset only that
subset. It preflights all selected roots, stops only idle coordinators that Tandem can prove it owns,
and then performs the normal launch so each selected coordinator is recreated and attached once.
Unrelated Herdr terminals are left untouched.
Reset also closes a recorded coordinator pane that has returned to its shell, provided its native
identity and worktree still match. Herdr removes a workspace when its last pane closes. Extra panes
remain open; Tandem changes only its generated old coordinator label to `Retained terminals`.
Custom labels are preserved. A normal relaunch without reset keeps the old shell and retires its
coordinator label instead. Labels alone never authorize closing a workspace or pane.
Busy, unknown, foreign, or otherwise unsafe work refuses before any pane is closed; if a coordinator
changes state or fails to close after earlier ones in the same run already closed, reset stops and
reports exactly which coordinators it already closed. Reset retains
settings, conversation history, task records, worktrees, and repository files; it is not task recovery,
a factory reset, or data wiping. Add `--continue` only when you want the reopened coordinators to
resume their saved conversations; without it they start fresh conversations. Never run `--reset` from
inside Herdr, because Tandem refuses that unsafe context.

For testing, or when you deliberately want to cancel active work and start fresh:

```sh
tandem --reset --force
# Or limit the reset to one project:
tandem --reset --force /absolute/path/to/repo
```

Force reset cancels selected active tasks, stops their owned worker, validation, and presentation
terminals, and reopens their coordinators even when busy. Completed retained task terminals are closed
without erasing completed task history. Files, worktrees, and uncommitted changes are preserved.
Without paths it still selects **all saved projects**. Force does not bypass ownership checks or
the clean-source requirement for coordinator worktrees, and must also run outside Herdr.

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
tandem --continue /absolute/path/to/repo
tandem configure /absolute/path/to/repo
```

`configure` remains a single-project catalogue-anchor flow: it asks for and saves all six global role
choices (Planning, Research, Coding, Review, Final checks, and Presentations) without launching a
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

An explicit `tandem PATH` opens or reconnects only that project after ownership checks. Add
`--continue` when starting a stopped coordinator and resuming its saved conversation. Before each
planning turn, a managed coordinator refreshes its owned, clean source checkout from `origin/main`.
New tasks capture that revision; existing tasks and workers keep their original pins and checkouts.
Fetch or source-safety failures block new task creation rather than silently using stale source.
Use `--restart` to reload the extension and refresh source without resetting child work.

### Migrate legacy state (offline only)

Current Tandem state is authoritative in `<home>/state.sqlite` (the remembered home, or
`~/.tandem` without a remembered setup or explicit override). Older homes may instead contain `<home>/runtime.json` and
`<home>/tasks/*.json`; normal SQLite startup refuses to use that legacy state until it
has been explicitly migrated. Do not run this procedure while any Tandem coordinator,
worker, validation job, presentation, or legacy writer may still be active.

Use the exact home that the coordinator uses:

```sh
# Read-only plan; do not add --yes.
tandem migrate-state --home /absolute/path/to/tandem-home --json

# Apply only after the plan is ready and all liveness/ownership checks are clear.
tandem migrate-state --home /absolute/path/to/tandem-home --yes --json

# A completed migration can be inspected without changing state.
tandem migrate-state --home /absolute/path/to/tandem-home --json
```

The plan is read-only by default. It hashes and reports the legacy sources, checks for
live or ambiguous native ownership, and reports incomplete reservation intents that will
be quarantined rather than guessed or resumed. A live coordinator, active job, unresolved
endpoint launch, or ambiguous ownership blocks the plan/apply path; stop the relevant
Tandem/Herdr activity and plan again. Do not bypass a blocked plan.

Malformed or unknown legacy fields, symlinked/non-regular sources, changed source hashes,
an invalid migration manifest, or non-empty task/runtime tables in `state.sqlite` also fail
closed.
Preserve the source bytes and resolve the diagnostic; do not delete records to force a
migration.

Applying the plan is an offline, resumable cutover. It imports tasks and runtime state into
`state.sqlite` while preserving task IDs, generations, fix-round and policy state,
checkpoints, and operation history. It archives any present legacy source under
`<home>/.tandem-migration/archive/` (`runtime.json` and `tasks/`), writes
`<home>/.tandem-migration/manifest.json`, and installs old-writer fences at the former
`runtime.json` and `tasks` paths plus `<home>/.tandem-migration/fence.json`. Keep the
archive and fences. If an apply is interrupted, rerun the same `--yes` command; do not
edit the archive or manifest and do not start normal Tandem use until the migration is
complete.

Migration is not task recovery: it does not resume a worker, clear a reservation, release
capacity, reset a saved checkpoint, change task policy, or unblock a maxed fix policy.
After migration is complete, normal reconciliation may recover only from positive native
identity or durable result evidence. An unknown external-effect outcome is quarantined
and retains its reservation/capacity and resources. A worker launch claim is at-most-once:
duplicate or stale operation claims are refused. Never clear a reservation, invent a job
or result, replace a task, or change policy to bypass unknown ownership; ask the
coordinator to surface the durable blocker instead.

These fences do not make external effects transactional or guarantee availability; they
make uncertain ownership fail closed and keep the evidence for an explicit decision.

The migration command does not accept project paths; `--home` must identify the Tandem
home, not a repository. See the [agent/operator reference](docs/agent-reference.md) for
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

Onboarding always covers all six role choices: **Planning** (`coordinator`), **Research** (`scout`),
**Coding** (`implementer`), **Review** (`reviewer`), **Final checks** (`verifier`), and
**Presentations** (`presentation`). For each role, explicitly choose or accept the exact catalogue
model `selector` and a supported thinking level; recommendations never fill omitted roles, and a
complete six-role recap appears before saving. **Not now** pauses first-time onboarding before
`configure-models`, project setup, or launch, with no fallthrough to built-in defaults. Returning
onboarding shows all six saved exact selector/thinking pairs and offers **Keep all** (read-only, no
new role answers; it may continue the existing project-setting flow), **Change roles** (explicitly
choose or keep each role, with untouched roles preserved in the recap), or **Not now** (pause with
choices unchanged, without setup or launch). The existing `configure-models` approval is required
to save changes. Approved choices apply to future work across projects; a main-model change takes
effect on the next Tandem launch, not in an already-running conversation.

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

## Optional Jev shadow recommendations

TypeSafe Jev integration is off by default and recommendation-only. To opt in for a Tandem
coordinator, set `TANDEM_JEV_MODE=shadow` and `TYPESAFE_API_KEY` before launching Tandem; a key
alone does not enable it. The pinned endpoint/model is Jev `1.13.0`. An optional
`TANDEM_JEV_TIMEOUT_MS` sets a bounded 1–10,000ms timeout (default 2,000ms).

Candidate alternatives are configured in the selected home's `<home>/jev.json`, not the repository:

```json
{
  "schemaVersion": 1,
  "routingCandidates": {
    "implementer": [
      {
        "id": "coding-fast",
        "model": "openai-codex/gpt-5.6-luna",
        "thinking": "high",
        "description": "Configured coding alternative for shadow comparison."
      }
    ]
  }
}
```

Tandem validates candidates against the existing OMP catalogue, evaluates at most once per
prepared job, and records a local `jev-recommendation-<job-id>.json` beside that job. Records contain only
bounded status, model choice/confidence, ranked supplemental-context IDs/source references, usage,
and latency—not keys, raw requests, or full excerpts. Routine notifications point the main
conversation to the evidence. Mandatory instructions, scope, questions, answers, safety, and
review findings are never optionalized. Jev advice never changes dispatch, prompts, context,
approval, or task transitions; it provides no proven savings or automatic switching.
Shadow checks run for model-backed scout, implementer, reviewer, verifier, and presentation jobs;
validation is a non-model runner job. The presentation workflow invokes the same recorder before
each durable presentation launch.
Only bounded task state and eligible saved scout/surface evidence is shared when opted in.
Provider failures, malformed configuration, missing keys, and unavailable catalogue data retain
normal dispatch. Set these variables in the environment that starts the Herdr server.
Already-running Herdr/OMP processes do not acquire newly exported variables; a coordinator-only
restart does not update the server's environment. Enable Jev when starting a fresh server session.

See the [Jev integration overview](docs/jev-prd.md) for current status. Focused documents cover the
[shadow contract](docs/jev-shadow.md), [context reuse](docs/jev-context-reuse-prd.md),
[coordinator prompt routing](docs/jev-prompt-routing-prd.md), and the
[evaluation plan](docs/jev-evaluation.md).

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
