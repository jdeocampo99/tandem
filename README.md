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
bare `tandem` to open or reconnect every valid saved project under the selected Tandem home in one
shared Herdr session:

```sh
tandem
```

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

Use the same `--home`, `--session`, and `--pool-root` values when reconnecting:

```sh
tandem --continue /absolute/path/to/repo
tandem configure /absolute/path/to/repo
```

`configure` remains a single-project catalogue-anchor flow: it asks for and saves all six global role
choices (Planning, Research, Coding, Review, Final checks, and Presentations) without launching a
coordinator. With no path, it keeps its current-Git or existing interactive one-project anchor
fallback; it never expands to all saved projects. `--headless` prepares coordinators without
attaching Herdr, and `--no-attach` also skips the GUI attachment. `--help` shows the terminal
command's complete options. Home, session, and pool defaults come from `TANDEM_HOME`,
`TANDEM_SESSION` (then Herdr's session variables), and `TANDEM_POOL_ROOT`.

Each project in a launch set gets its own coordinator conversation and dedicated clean Treehouse
source worktree pinned to that project's committed HEAD. Multiple projects share one Herdr session,
but coordinators and child-worker groups remain scoped to their original project identities. The
original checkout may be dirty and remains untouched; coordinator source reads and delegated
execution use the clean snapshot, while durable settings, task records, and delivery retain the
original project identity. When several projects are opened, Tandem attaches to the shared Herdr
session once every coordinator is ready.

Child agents run in real interactive OMP terminals, not JSON-log panes. Open their Herdr subtree
to watch the work or chat directly. Completed agents stay open for read-only follow-up; their
delegated result is recorded independently of terminal output. Further implementation goes through
the coordinator so validation and review keep exclusive access to the checkout. Validation runs
in a separate non-model pane. Explicit cleanup can close idle completed agents, but preserves
busy conversations, pending editor drafts, and terminals whose ownership cannot be proven.

An explicit `tandem PATH` opens or reconnects only that project after ownership checks. Add
`--continue` only when starting a stopped coordinator and resuming its saved conversation. An active
coordinator remains pinned to its existing clean source even if the original project's HEAD has
advanced; stop that coordinator and relaunch when you deliberately want a fresh source snapshot.

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
loop. If the worker asks a decision, the coordinator relays its `Question:` and optional
`Recommendation:`, then sends your answer. A receipt is not proof that implementation is finished.
Before initial approval, its confirmation includes the current revision and effective communication
deltas, so queued scope is visible without replaying superseded messages or full JSON.

## What approval means

Tandem first inspects your project without changing it. Saving settings, starting Tandem,
approving a coding plan, publishing a pull request, merging, and deleting unfinished work each
need your approval. Research can start before you approve code changes; coding waits for your
approved plan, followed by checks and a separate review. Tandem never merges automatically.

Delegated scouts use read-only repository tools and native `web_search`: they prefer official or primary sources, use `read` for known URLs, cite sources, and separate verified facts from recommendations. Queued or blocked delegation is actionable state, not a running or completed research effort; the coordinator must disclose it and never silently take over research without explicit user authorization. Recorded task counts and statuses come from saved durable task state, not receipts or process observations.
Asking how it works does not give it permission to inspect files or take action.

## References

- [Agent/operator reference](docs/agent-reference.md) — CLI, installation, policy, lifecycle,
  storage, worktrees, delivery, presentation, recovery, and operational contracts.
- [`tandem` usage skill](skills/tandem/SKILL.md)
- [`tandem-onboard` skill](skills/tandem-onboard/SKILL.md)
- [`tandem-status` skill](skills/tandem-status/SKILL.md)
