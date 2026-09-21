# Tandem agent/operator reference

The [root README](../README.md) is the human-facing product overview and conversational start
path. This reference keeps detailed installation, CLI, policy, lifecycle, worker, storage,
delivery, presentation, recovery, and operational contracts.

Tandem is a local, OMP-first coordinator for durable repository work. The main OMP conversation
is authoritative; Tandem records tasks, policy snapshots, worker jobs, review evidence, reports,
worktree leases, notifications, bounded two-way task communication, and delivery state so a restart does not require reconstructing
workflow from chat.

## Operating model

Tandem separates research, implementation, validation, review, presentation, and delivery:

1. **Research is automatic when delegated.** A scout can start after task creation without implementation approval. Queued or blocked delegation is not active or completed research; blockers are surfaced as actionable coordinator notifications, and direct research takeover requires explicit user authorization.
2. **Implementation is approved scope.** The coordinator interviews for ambiguity and risk, records the concrete scope, and waits for explicit approval before dispatching an implementer.
3. **Validation is runner-owned.** Configured argv commands run against the exact task HEAD and produce durable evidence. A worker must not claim a command ran when the runner did not record it.
4. **Review is independent.** The implementer is stopped while a fresh read-only reviewer examines the same task worktree. Review results are tied to an exact HEAD and generation.
5. **Delivery is gated.** Publishing and merging are explicit approval-bearing actions. Tandem never merges automatically.
6. **Presentation uses a separate artifact directory.** A presentation worker writes HTML outside the repository. The controller, not the worker, opens Lavish and owns the supervised continuous feedback listener.

Prompts are workflow guidance, not a security boundary or deterministic policy engine. Runtime checks, Herdr/Treehouse ownership, filesystem checks, and Git/GitHub preconditions guard workflow mutations. Tool allowlists do not provide an operating-system or filesystem sandbox; coordinator self-resolution guidance cannot replace those runtime safeguards.

### Worker capabilities

| Role | Workspace and tools | Responsibility |
| --- | --- | --- |
| Coordinator | OMP conversation; `read`, `grep`, `glob`, `ask`, `tandem` | Owns user communication, policy, lifecycle, approvals, and routing. It does not edit repository code or run shell commands. |
| Scout | Isolated Treehouse worktree and child Herdr workspace; `read`, `grep`, `glob`, `web_search` | Read-only repository and web research. Use native `web_search` for discovery, prefer official or primary sources, use `read` for known URLs, cite sources, and separate verified facts from recommendations. If a capability is missing or a tool fails, report the exact failure rather than inventing findings; the scout does not write a report file or run project-wide gates. |
| Implementer | Assigned task worktree and child Herdr workspace; `read`, `grep`, `glob`, `edit`, `write`, `bash` | Implements only approved scope and reports a commit checkpoint. It does not merge, deploy, perform destructive cleanup, or claim validation results. |
| Reviewer | Fresh read-only pane in the task worktree; `read`, `grep`, `glob` | Reviews one lens at a time and returns evidence-bound `ReviewResult` data. It does not edit or write a report file. |
| Verifier | Fresh read-only context; `read`, `grep`, `glob` | Independently verifies the exact reviewed HEAD and reports only runner-produced validation evidence. |
| Presentation | Private artifact directory; `read`, `grep`, `glob`, `write`, `edit` | Must write only the supplied artifact path and leave the repository unchanged. Bash is not exposed; the controller owns Lavish and approval-bearing actions. |

The default policy allows three concurrent workers and three fix rounds. These are policy limits, not an arbitrary six-worktree cap.

## Requirements and authentication

Tandem runs on macOS with Bun. The durable task store uses Darwin's native `O_EXLOCK` file-lock support, so Linux and Windows are not supported by the repository-lock implementation.

Install Bun locally using your normal approved macOS package manager or installer. Then install this checkout's dependencies locally:

```sh
cd /path/to/tandem
bun --version
bun install
bun link
tandem --help
```

Keep Bun's global bin directory on `PATH` when invoking `tandem` outside this checkout.

The core workflow expects these executables to be installed and available on `PATH`:

- `tandem`, linked with `bun link`, for the terminal front door;
- `bun` for Tandem and worker processes;
- `omp` for the coordinator and child OMP workers;
- `herdr` for the named coordinator and child workspaces;
- `treehouse` for isolated worktrees and pool maintenance;
- `git` for checkpoints, safety proofs, and delivery.

The optional delivery and presentation paths additionally require:

- `gh`, already authenticated with access to the target GitHub repository, for pull-request publish and merge;
- `lavish-axi`, installed and usable in the local environment, for presentation guidance and browser-backed presentation.

Tandem does not provide a login flow or copy credentials into another store. OMP uses the existing local OMP/provider configuration; Herdr and Treehouse use their existing local sessions; GitHub operations reuse the existing `gh` authentication and Git remote. Verify those tools with their normal local commands before requesting an approval-bearing action. Worker processes inherit the local environment; do not treat a private artifact directory or tool allowlist as credential isolation.

## Quick start

The linked `tandem` command is the primary front door. From any directory after `bun link`, a bare
`tandem` opens or reconnects every valid saved project under `<home>/repositories` before consulting
the current working directory, all in one shared Herdr session:

```sh
tandem
tandem --continue
```
To replace owned coordinators without canceling tasks, use the restart command from a separate normal
terminal:

```sh
tandem restart [PATH ...]
```

It preserves task IDs, generations, worktrees, reports, messages, and coordinator conversations.
`tandem --restart [PATH ...]` remains accepted for compatibility. Never invoke restart from inside
Herdr.

To view recent prompt-routing events without locating the durable home:

```sh
tandem logs
tandem logs --json
```

Add `--home PATH` when inspecting a specific Tandem home. The command is read-only.


To deliberately cleanly reopen only Tandem-owned coordinators, run the reset launch from a separate
normal terminal:

```sh
tandem --reset
```

With no paths this selects every valid saved project; explicit paths select only that subset. Reset
preflights every selected root and stops only idle coordinators with exact Tandem ownership proof.
Recorded coordinator panes that returned to their verified terminal shell are also closed.
Busy, unknown, foreign, or unsafe work refuses before any pane is closed. It preserves settings,
conversation history, task records, worktrees, and repository files; it is not task recovery, a
factory reset, or data wiping. Add `--continue` only to resume saved conversations after reopening;
otherwise launches start fresh conversations. `--headless` and `--no-attach` remain supported.
Never invoke reset from inside Herdr; use a separate normal terminal.

For deliberate interruption during testing, use `tandem --reset --force [PATH ...]`. It cancels
selected active tasks, stops their owned worker, validation, and presentation terminals, and
reopens busy coordinators. No paths still means every saved project. Files, worktrees, uncommitted
changes, and task history remain intact; ownership and coordinator source-safety checks still apply.

When saved project records exist, this registry-first path uses only that registry; it does not crawl
arbitrary disk repositories, auto-register projects, or show a project picker or path prompt. It
works the same in a non-TTY and with `--headless` or `--no-attach`.

To open only a subset of saved projects or explicitly add/open projects, pass one or more paths.
Explicit paths override the saved registry and open only the supplied canonical Git projects. Multiple
paths still use one shared Herdr session while keeping one clean coordinator and child-worker group
per project:

```sh
tandem /absolute/path/to/repo
tandem /absolute/path/to/first-repo /absolute/path/to/second-repo
```

If the saved registry is empty, bare `tandem` retains the first-run fallback: from a Git checkout it
onboards and opens the current Git project; outside Git, the existing interactive project-selection
fallback remains available for entering or adding a project path. The empty-registry fallback keeps
its existing interactive-terminal requirements.

To choose all six global role models without launching a coordinator:

```sh
tandem configure /absolute/path/to/repo
```

`configure` remains a single-project catalogue-anchor flow. With no path, it keeps its current-Git or
existing interactive one-project anchor fallback; it never expands to all saved projects.

Use `--home`, `--session`, and `--pool-root` consistently when reconnecting. `--headless` prepares
coordinators without attaching Herdr; `--no-attach` also skips attachment. `--help` prints the
terminal command's complete options.

Each project in a launch set receives a coordinator conversation and dedicated clean Treehouse
source worktree pinned to its original committed HEAD. The original checkout may be dirty and
remains untouched; source reads and delegated execution use the clean snapshot, while durable
settings, task records, and delivery retain the original project identity.

Conversational skills are optional. In a fresh agent session, ask:

> How do I use Tandem?

> Onboard `/path/to/repo`.

> What is the current state of my Tandem tasks?

Use `/skill:tandem`, `/skill:tandem-onboard`, or `/skill:tandem-status` when you want those
conversational flows. Low-level `src/cli.ts` commands remain an advanced fallback for exact
automation and diagnostics; they are not the primary installation path.

### Install the global skills

Run this from the Tandem checkout root. It installs all three skills as absolute symlinks,
leaves a matching existing link intact, and refuses to overwrite any other destination:

```sh
TANDEM_ROOT="$(pwd -P)" bun -e '
import { lstat, mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.TANDEM_ROOT;
const home = process.env.HOME;
if (!root || !home) throw new Error("TANDEM_ROOT and HOME are required");
const roots = [join(home, ".agents/skills")];
if (process.env.INSTALL_CLAUDE === "1") roots.push(join(home, ".claude/skills"));
const names = ["tandem", "tandem-onboard", "tandem-status"];

for (const dir of roots) {
  await mkdir(dir, { recursive: true });
  for (const name of names) {
    const source = join(root, "skills", name);
    const destination = join(dir, name);
    const sourceReal = await realpath(source);
    const existing = await lstat(destination).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      const matches = existing.isSymbolicLink() &&
        await realpath(destination).then((path) => path === sourceReal, () => false);
      if (!matches) throw new Error(`refusing to replace ${destination}`);
      continue;
    }
    await symlink(source, destination, "dir");
  }
}
'
```

The command above installs optional conversational skills for OMP/agents. Set `INSTALL_CLAUDE=1`
before the command to install the same links under `.claude/skills` as well. If the checkout moves,
the old links do not match; remove only links you own, then rerun the command. The linked
`tandem` executable remains the primary terminal front door.

### Advanced low-level CLI fallback

Use the low-level `src/cli.ts` entry point only for exact action commands, JSON automation, or
diagnostics. Normal project selection, multi-project launch, model configuration, and reconnect
use the installed `tandem` command:

```sh
# Show the advanced action CLI help without starting a coordinator.
bun src/cli.ts --help

# Inspect the target repository and propose validation surfaces.
bun src/cli.ts onboard --repo /absolute/path/to/repository

# Inspect the local prerequisites without mutating the repository.
bun src/cli.ts doctor --repo /absolute/path/to/repository

# Launch one coordinator directly in a named Herdr session.
bun src/cli.ts launch --repo /absolute/path/to/repository --session tandem
```

The package development script invokes the same low-level entry point:

```sh
bun run start -- --help
bun run start -- launch --repo /absolute/path/to/repository
```

With no action, the low-level CLI defaults to `launch`. It uses the same remembered setup as the
normal terminal command and agent integration. Explicit overrides must remain consistent when
reconnecting or restarting so durable state and the named Herdr context are reused.

`--restart` is the non-destructive coordinator replacement surface. From a separate normal
terminal, `tandem --restart PATH` verifies exact recorded coordinator ownership, revalidates the
pane cwd/process immediately before close, confirms close acknowledgement and pane absence, then
launches a replacement with the same lease/session directory and `--continue`. Child panes, task
IDs and generations, worktrees, conversation history, pending questions/messages, and reports
remain intact. Foreign, ambiguous, or missing ownership refuses before any close. This frontdoor
surface replaces the coordinator only; it is not task cancellation or recovery, and
`--reset`/`--reset --force` retain their destructive meanings.

To restart one managed worker without replacing the coordinator, use `/tandem restart TASK_ID`,
tool request `{request:{action:"restart",taskId:"TASK_ID"}}`, or
`bun src/cli.ts restart TASK_ID`. The acknowledged pause/stop/resume bridge preserves task identity,
generation, worktree, worker context, messages, reports, and questions. It refuses cancelled or
completed tasks and paused/blocked tasks with an unanswered question. No restart action lets a
coordinator restart itself.

## Launching the coordinator

The installed `tandem` command uses the following terminal options and environment precedence:

| Setting | Terminal resolution |
| --- | --- |
| Durable home | `--home` → `TANDEM_HOME` → remembered setup → `~/.tandem` |
| Shared Herdr/OMP session | `--session` → `TANDEM_SESSION` → `HERDR_SESSION` → `HERDR_SESSION_NAME` → remembered setup → `tandem` |
| Treehouse pool root | `--pool-root` → `TANDEM_POOL_ROOT` → `<home>/pool` |
| Project selection | Explicit positional `PATH ...` overrides the registry and opens only supplied canonical roots; with no paths, valid saved projects under `<home>/repositories` are used before cwd; if none are saved, current-Git onboarding or the outside-Git interactive fallback remains |
| Conversation reconnect | Bare `tandem` opens or reconnects all saved projects; explicit `tandem PATH` opens or reconnects only that project; add `--continue` only when starting stopped coordinators and resuming saved conversations |
| Herdr attachment | `--headless` or `--no-attach`; both prepare without attaching the Herdr terminal client |
| Coordinator reset | `--reset`; preflight and reopen only selected idle Tandem-owned coordinators; launch-only and rejected inside Herdr |
| Coordinator restart | `--restart`; replace only the owned coordinator while preserving tasks, generations, conversations, questions/messages, reports, worktrees, leases, and child panes |
| Forced cancellation | `--reset --force`; cancel selected active work, stop owned terminals, and reopen coordinators while preserving files/worktrees |
| Parallel coordinators | `TANDEM_ALLOW_PARALLEL_COORDINATORS=1` (or `true`); off by default, and the only way to run more than one coordinator for one repository in a shared home |

### Remembered setup

The optional user preference `$XDG_CONFIG_HOME/tandem/config.json` (default
`~/.config/tandem/config.json`) selects a home and session together:

```json
{
  "schemaVersion": 1,
  "home": "/absolute/path/to/tandem-home",
  "sessionId": "tandem"
}
```

The file must be a regular file with exactly these fields; the home must be absolute. Unknown
versions, malformed settings, and symlinks fail visibly rather than silently selecting old state.
Keep the file private. Reads and normal launches never create or change this preference; changing
the default is a separate, explicit user configuration action. It does not move, migrate, delete,
or modify either home's existing records.

An explicit `--home` or `TANDEM_HOME` selects a separate setup and bypasses the remembered pair,
including its session. Other flags and environment values keep the precedence above; the pool
still defaults to `<selected-home>/pool`. Thus temporary homes never silently inherit the remembered
session or replace the default. Without a preference, existing built-in behavior is unchanged.

### Project selection

Explicit `PATH` values share the selected Herdr session, but each project receives its own
coordinator workspace, clean source worktree, and child-worker group. When no paths are given and
saved records exist, the launch set is those valid registry projects; when the registry is empty,
selection follows the current-Git or outside-Git fallback above. Coordinators scope durable task
operations to their original project identities, so one coordinator cannot claim another project's
work. The saved-project path does not use arbitrary disk discovery or a project picker, including
in non-TTY/headless launches.

The terminal command attaches once after all selected coordinators are ready; `--headless` and
`--no-attach` leave the shared session prepared without that attachment.
The terminal front door releases its setup readline before this attachment, so Herdr is the sole
terminal input owner while the interactive session is running.

`--reset` runs after onboarding and after setup readline is released, before any normal coordinator
launch or Herdr attachment. With no paths it applies to every saved project in the launch set; an
explicit path list narrows the set. The reset operation uses one shared coordination lock and a
central task-store lock, validates all selected roots before closing anything, rechecks native
ownership and strictly idle status for running coordinators before each exact pane close, and
verifies pane disappearance. Recorded coordinator shells are eligible only when native pane identity,
terminal-shell process identity, and foreground worktree still match the record.
Busy stages, live jobs or reservations, pending endpoint actions, presentations, or live worker
endpoints cause a fail-closed refusal with no coordinator launch; unknown, foreign, legacy,
malformed, or unsafe ownership also refuses. Those refusals happen during the preflight, before any
pane closes. If a selected coordinator instead changes state or a native close fails after earlier
coordinators in the same batch have already closed, reset stops closing further panes and raises an
error naming the coordinators already closed and the failure that stopped it; it does not force-close
the affected pane, retry, or roll back the earlier closes. It does not stop a server, clear a registry,
mutate tasks, recover task work, or wipe settings, history, worktrees, or files.
Herdr removes a workspace when its last pane closes. Retiring a superseded or stopped coordinator's
workspace closes its own owned pane by default once exact ownership and a stopped process are
proven, which removes the workspace when it was the last pane. A workspace is retained instead
(renamed to `Retained terminals · <repo>`) only when another pane still shares the coordinator
workspace and keeps it alive after the owned pane closes; extra panes are never closed merely
because they share the coordinator workspace, and they are reported alongside the retained outcome.
A workspace someone gave a custom label is left entirely untouched, pane included. Ownership that
cannot be proven exactly and as stopped, such as a pane whose foreground directory or process no
longer matches the record, is quarantined: neither closed nor renamed, and reported so it can be
inspected, and listed again by `tandem reconcile-resources`. There is no explicit-retention option
yet; nothing asks a user whether to keep a coordinator's workspace. A normal launch without reset also retires the old generated label this
same way when replacing a stopped coordinator. Launch and reset print a notice for a retained or
quarantined outcome (silent otherwise); force reset's quarantine outcomes still surface through the
same reset notice path. Retirement happens before the replacement workspace is created or the
record is overwritten; if it fails, the launch rejects, the old record and terminals stay, and the
next launch retries it. Workspace labels alone
never prove ownership or authorize terminal deletion.
Run it from a separate normal terminal, and add `--continue` only when the fresh launch should
resume the saved coordinator conversation.

Coordinator replacement is transactional, so repeated launches and restarts converge on one
coordinator worktree lease instead of accumulating them. Once the previous pane retirement above
reports `closed` or `already-clear`, launch reads the previous coordinator checkout and decides
from that evidence alone: reuse the existing lease when it is clean and already pinned to the
commit the replacement wants, release that exact lease and drop its record when the replacement
needs a different commit, retain it when the checkout has uncommitted changes or unmerged paths,
and quarantine it when the state cannot be explained (an unreadable checkout, a branch other than
the recorded lease branch, a HEAD that is neither the recorded lease base nor a recorded refresh
target, or a pane that was itself quarantined). A release always names the exact lease id, holder,
and path; a lease is never matched by label, pool position, or path guess, and task worktrees are
never inspected or returned by this path. Only after that cleanup does launch allocate the
replacement.

If a later startup step fails after a new lease was acquired, that launch rolls its own resources
back: it retires the replacement pane it created through the same ownership-proving path, then
releases the lease it acquired. Anything it cannot prove safe to undo (a pane still running an
unidentified process, a checkout that changed, a return Treehouse refused) becomes a durable
quarantine note under `<home>/coordinator-quarantine/`, naming the lease, the pane, and the
reason. The launch error then names that note. A lease the previous record still points at is
never rolled back, because the record remains its durable owner. A previous lease that cannot be
released becomes a quarantine note too rather than blocking the launch, so no coordinator lease is
ever left untracked and the user is never locked out of their coordinator. Launch prints a notice
for a retained or quarantined worktree outcome and stays silent when nothing accumulated.

### One coordinator per repository

By default one canonical repository has one active coordinator across every Tandem session that
shares a home, so sessions such as `tandem` and `tandem-fresh` cannot each start their own. Launch
and restart take a repository-scoped coordination lock at
`<home>/coordinator-registry/repository-<digest>.lock`, keyed by the canonical repository path, so
two spellings of one repository (a symlinked checkout, a differently written path) share one lock.

Lock ordering, which is what keeps two launches from deadlocking: the repository lock is acquired
first, then the launching session's own launch lock, then the launch lock of any other session whose
records are being reconciled. Callers that hold only a session lock, namely coordinator reset and
coordinator source refresh, never acquire the repository lock, so no cycle exists.

Holding that lock, a launch reconciles the repository across every session directory under
`<home>/coordinator-registry/`. Discovery is read-time and non-destructive: records earlier builds
wrote under per-session directories are still found, matched on their own canonical repository path
rather than on their file name, and nothing is moved or rewritten to a new layout. Each record
carries the session of origin, so no session's record is mistaken for another's.

What the launch does with what it finds:

- Its own session's record follows the ordinary reconnect and replacement path above.
- A coordinator another session still runs refuses the launch, naming that session and its pane. A
  live coordinator is never stopped, adopted, or force-closed by a launch, and no second coordinator
  is started beside it. Reconnect in that session, or stop it there and launch again.
- A stopped or orphaned coordinator from another session runs through exactly the retire, decide,
  and apply path above, under that session's own launch lock: its pane is retired only with proven
  stopped ownership, its exact lease is released and its record removed, or the lease is retained or
  quarantined when the checkout is dirty, unmerged, or unexplained. A retained or quarantined record
  stays as the durable owner of what Tandem refused to discard and is reported again on the next
  launch; it never blocks the new coordinator.
- A record stored under a session directory it does not belong to, or a record for this repository
  that cannot be read, refuses the launch rather than duplicating a coordinator. A misplaced record
  also gets a durable quarantine note under `<home>/coordinator-quarantine/` with stage
  `exclusivity`, naming its lease and pane; an unreadable file names no lease identity, so the
  refusal names the file to inspect instead. Nothing is released or closed by a refusal.

Every refusal names `TANDEM_ALLOW_PARALLEL_COORDINATORS`. Setting it to `1` or `true` is the
explicit opt-in for parallel coordinators on one repository; it is off by default, it still takes
both locks so launches stay serialized, and it skips only the cross-session claim. Task worktrees
are never inspected, returned, or renamed by this path, and a workspace label still never proves
ownership. Launch prints one notice per stopped coordinator it settled for another session.

`--reset --force` is the explicit interruption mode; `--force` alone and `configure --force` are
invalid. It preflights selected task and presentation endpoints, including retained terminals,
against durable job identities and native process state. Unknown ownership, foreign-session work,
ambiguous pending launches, or an unsafe coordinator source still refuse before effects.
Presentation feedback locks are acquired before the task-store lock and the selected set is
rechecked afterward, so presentation completion cannot race cancellation.

Before closing panes, force reset persists cancellation intent for active tasks. Interactive workers
are closed without requiring idle prompts; validation is interrupted through its runner first so
detached validation commands are terminated and reaped. Stopped jobs and released reservations are
persisted, affected active tasks become cancelled, and selected presentations are marked failed.
Completed task history and tasks still awaiting approval are retained. Exact owned coordinator
panes are then closed and normal launch resumes. A failure reports already-cancelled tasks and
stopped panes/coordinators; retrying does not resurrect interrupted work. Neither mode discards
repository files, uncommitted task work, worktrees, settings, or conversation history.

For each project, fresh launch and non-destructive restart fetch and capture `origin/main`, acquire
a distinct clean Treehouse source worktree, and start OMP there. Without `origin`, launch explicitly
uses the original repository's committed local `HEAD`; a configured remote's fetch failure never
falls back to stale source. The original checkout may be dirty and remains untouched. Settings,
task records, and delivery retain the original identity as `TANDEM_REPO`; the owned source checkout
is `TANDEM_SOURCE_REPO`, which users normally do not set themselves.

An explicit `tandem PATH` opens or reconnects only that project after ownership checks. `--continue`
resumes a stopped coordinator's saved conversation; `--restart` reloads the extension, prefetches
fresh source before closing the old coordinator, and preserves child work and conversation history.
Before each planning turn, the coordinator refreshes only its proven-owned clean checkout. A durable
refresh intent recovers an interrupted switch only for the same lease at its recorded old or new
HEAD. Dirty, foreign, or unexpectedly moved source checkouts fail closed.

An old pre-registry coordinator without a clean lease record is never adopted or duplicated. Stop
that coordinator manually, confirm its Herdr pane/process has exited, and relaunch `tandem` once.
Relaunch does not automatically migrate existing task records; durable tasks remain attached to
their original project identity and pinned source state until an explicit recovery decision.

Launch succeeds only after Herdr reports a running server and native pane inspection verifies
the expected OMP command and clean working directory. A private central bootstrap script keeps
the initial terminal command short; a successful `pane run` response alone is not readiness.
Child-workspace creation and ordering share the central store lock so concurrent project dispatch
keeps each child group beneath its own coordinator.

`doctor` is available through the advanced low-level CLI to check the checked-in extension and
config files, central repository policy, pinned OMP model, and named Herdr status without writing
repository or task state.

## Repository onboarding and central policy

### Inspect first, write once

Per-repository policy is Tandem-owned local state. Resolve the home independently from the
target repository: `--home` takes precedence over `TANDEM_HOME`, then the remembered setup,
then `~/.tandem`. A configured home is valid only when its central destination remains outside the
target repository. Onboarding reads only `package.json` and the central policy record for
read-only package discovery; it does not execute scripts or inspect CI. Repository guidance and
relative `instructionFiles` are loaded later for task policy resolution and remain target-rooted;
onboarding never writes application files.

For a canonical Git root, Tandem stores the record at:

```text
<home>/repositories/<key>/config.json
```

`<key>` is the first 24 hexadecimal characters of the SHA-256 digest of the canonical realpath
of the repository root. This makes symlink aliases share a record while same-basename
repositories at different roots remain separate. The `repoPath` in the record is that same
canonical absolute root and can be used as an already-known project-index entry; it is not a
reason to crawl a home directory, guess a basename, clone, or create a checkout.

`onboard` and `doctor` are read-only and do not create the central directory or file. `onboard`
returns `configPath`, `existingConfig`, and exact proposal data in its structured result. Capture its
JSON result and project `identity`, `modelSettings`, `configPath`, `validationCommands`, and
`unresolved` before presenting or acting; retain full details without dumping truncated payloads,
repeating discovery, or hiding CLI failures. Keep technical fields internally; expose them only on
request or when needed to resolve project ambiguity. For the project-setting step, after any required
first-time model choice, ask:

> Save Tandem settings for `<project>`? These settings are saved on this computer, outside the project. They do not change the app or start work.
>
> Choose **Save settings** or **Not now**.

The native terminal presents these as selectable options, with **Save settings** highlighted.
Enter accepts the highlighted choice; selecting **Not now** or pressing Ctrl+C pauses setup without
creating the project record. Previously saved model preferences are retained.

Keep default worker/fix limits, script identifiers, hash paths, raw commands, and JSON in structured
details; share them only on request or when the user must choose meaningful custom settings. If valid
settings already exist, say they will be kept rather than overwritten. A read-only proposal is not a
completed setup.

```sh
# Read-only proposal; keep exact paths and data in the structured result.
bun src/cli.ts onboard \
  --repo /absolute/path/to/repository \
  --home /absolute/path/to/tandem-home \
  --json

# Readiness checks; this does not create policy state.
bun src/cli.ts doctor \
  --repo /absolute/path/to/repository \
  --home /absolute/path/to/tandem-home \
  --json
```

After the user chooses **Save settings**, either write flow creates only a missing central record:

```sh
bun src/cli.ts setup --repo /absolute/path/to/repository \
  --home /absolute/path/to/tandem-home --yes --json
# Equivalent explicit write form:
bun src/cli.ts onboard --repo /absolute/path/to/repository \
  --home /absolute/path/to/tandem-home --write --yes --json
```

The write is exclusive and refuses an existing, malformed, or mismatched record. Symlinks below
the resolved home in the policy namespace are rejected. New directories use `0700`; new configs use `0600`.
Targets do not need to check Tandem policy into Git. An old child-root `.tandem.json` is legacy
state and is ignored; it is neither imported nor deleted automatically.

Validation discovery is deterministic:

- A non-empty `ci:local` script wins and proposes only `bun run ci:local`.
- Otherwise, non-empty `check`, `typecheck`, `lint`, and `test` scripts are proposed in that
  order as `bun run <script>`.
- `check` and `typecheck` use the `typecheck` surface, `lint` uses `lint`, and `test` uses
  `test`; `ci:local` has no fixed surface tag. Proposed commands default to a 600,000 ms
  (10-minute) timeout, configurable per command through `timeoutMs`. Existing saved command
  timeouts and task policy snapshots remain unchanged.
- Missing or invalid `package.json`, missing scripts, no discovered scripts, or the absence of
  `ci:local` is reported in `unresolved`; unresolved discovery is not a passing check.

### Global model preferences

Global model preferences are Tandem-home state, not project files. The record is:
`<home>/models.json`.

The record has exactly `schemaVersion: 1` and a `models` map with exactly the six roles
`coordinator`, `scout`, `implementer`, `reviewer`, `verifier`, and `presentation`. Each role value is
`{ model: exact provider/model, thinking: supported ThinkingLevel }`; no other fields are allowed.
`ModelSettings` is `{ configPath: string, configured: boolean, models?: RepoPolicy['models'] }`;
`configured: true` always has `models`, while `false` has none.

`models --repo PATH --home HOME --json` is read-only and returns `ModelOptionsResult` with
`modelSettings` and `availableModels`; the service obtains the catalogue from `omp models --json`.
Catalogue records retain `selector`, `id`, `provider`, and `thinking`, plus optional `name`,
`reasoning`, `contextWindow`, and `cost: { input: number, output: number }`. Use the actual catalogue
and one lookup per operation; do not parse private model configuration or invent names. Cost metadata
is descriptive and does not guarantee account pricing or latency.

The native terminal onboarding and `tandem configure` use searchable model pickers populated from
that catalogue. Type to filter by model name or selector, use arrow keys to navigate, and press Enter
to choose. Each model is followed by a menu containing only its supported thinking levels. Available
saved choices or role suggestions are highlighted, but every role still requires confirmation.
Each role prompt explains its responsibilities and the kind of model recommended for it; for example,
Research recommends a cheap, fast model for read-only investigation. Thinking levels control reasoning
effort: higher levels can take longer and cost more. The role's usual thinking level is labeled
**Recommended** only when supported by the selected model; a saved level is labeled separately.
The complete six-role recap has a separate **Save** / **Not now** menu, defaulting to **Not now**.
Ctrl+C cancels without saving partial choices; saved preferences remain unchanged.

On every onboarding, make model selection explicit for all six role identities and their human
labels: **Planning** (`coordinator`), **Research** (`scout`), **Coding** (`implementer`), **Review**
(`reviewer`), **Final checks** (`verifier`), and **Presentations** (`presentation`). If
`modelSettings.configured` is false, run `models` once and use only its catalogue. For each role,
show the suggested exact catalogue `selector` and the thinking levels that selector supports, then
collect an explicit selector and supported thinking level. Offer **Not now** as an explicit pause:
it stops onboarding before `configure-models`, `setup`, or `launch` and never falls through to
built-in defaults. One response may answer all six roles; never infer omitted roles, combine roles,
or treat recommendation approval as consent.

When saved choices exist, show all six current exact catalogue selectors and thinking levels on every
onboarding and offer **Keep all**, **Change roles**, or **Not now**. **Keep all** reuses the displayed
choices, requires no new role answers, and is read-only; it may continue the existing project-setting
approval flow without calling `configure-models`. **Not now** pauses onboarding, leaves choices
unchanged, and does not run `configure-models`, `setup`, or `launch` or fall through to built-in
defaults. **Change roles** reruns `models` and requires an explicit choice or explicit keep-current
answer for each role. Preserve untouched roles and show the complete six-role recap before any save.
Recommendations are suggestions only; empty or failed discovery remains visible and never falls back.
Explain that approved choices apply to future work across projects and do not start work. After
explicit approval of the complete recap (never **Not now**), run `configure-models` once, then
continue with normal project setup and separately requested launch. No implicit configure occurs
during read-only commands.

`configure-models` accepts a temporary JSON object mapping all six roles directly to
`{ "model": "...", "thinking": "..." }`, not the storage envelope, and accepts no model-controlled
approval field. Stage it outside the target project and remove it after the command. `--yes` is
required before service or mutation; without consent, refuse without writing. Before any write, strict
parsing and one catalogue lookup reject missing or ambiguous selectors and unsupported thinking for
every role. Example:

```sh
bun src/cli.ts models --repo /absolute/path/to/project \
  --home /absolute/path/to/tandem-home --json
bun src/cli.ts configure-models --repo /absolute/path/to/project \
  --home /absolute/path/to/tandem-home \
  --input /path/to/selection-file-outside-project.json --yes --json
```

Absent reads create nothing. Malformed or symlinked `models.json`, or a home inside the target
project, fails closed. Approved writes atomically replace `<home>/models.json` with mode `0600`;
private new directories use `0700`, and no application or project files are written.

Model resolution precedence is **built-in defaults < saved global role choices < explicitly injected
`globalPolicy` < per-project policy overrides**. `resolveRepoPolicy` and `onboardRepo` apply the same
order. Built-in defaults remain available to direct APIs without saved preferences; onboarding must
offer first-time explicit six-role selection before setup or launch. Choosing **Not now** stops that
onboarding before setup/launch and never falls through to built-in defaults. For configured homes, each
onboarding displays all six saved choices before any reuse; **Keep all** is the explicit, read-only
reuse path. Changing choices affects future resolutions and new tasks only, and never rewrites
existing task policy snapshots.
Changing the main conversation model takes effect on the next Tandem launch; it never hot-swaps an
already-running OMP conversation.

### TypeSafe Jev prompt routing

Jev is an optional classifier for unmatched natural-language coordinator prompts. Set
`TYPESAFE_API_KEY` before launching Tandem to enable classification; without a key, the normal
coordinator path remains unchanged. The pinned model is Jev `1.13.0` at
`https://api.typesafe.ai/v1/systemone`. `TANDEM_JEV_TIMEOUT_MS` accepts 100–10,000ms and defaults
to 1,500ms.

Exact slash commands bypass Jev. Other prompts receive one bounded request containing only the
prompt, an explicit task identifier when present, and the supported lookup list. Jev returns
typed action, target, effect, scope, and composition facts. Tandem code validates identity,
ownership, state, approvals, and policy before any action.

Only `list`, `presentations`, `show`, `messages`, `inspect`, and `recovery-plan` may dispatch
directly. The first two are repository lookups; task-specific lookups require an explicit
`task-...` identifier or UUID. The direct path is read-only and uses the existing service.
Low confidence (<0.80), incomplete or malformed output, mixed or unclear requests, state-changing
or sensitive effects, provider errors, and missing task identifiers use normal coordinator
handling. Jev cannot generate shell commands, authorize actions, mutate state, or select an
arbitrary model.

Append-only route diagnostics are written to `<home>/logs/tandem.jsonl` with a short prompt hash,
route facts, confidence, reason, and latency. When a Jev request was attempted, the event also
carries a bounded usage record: provider, pinned model, input/output tokens (or an explicit
`unavailable` marker, never zero), request duration, timeout status, route reason, and a pricing
snapshot or `unavailable`, all schema-versioned for `src/runtime/usage.ts`. Raw prompts, API keys,
and full provider payloads are excluded; a route event joins to an evaluation result through the
shared prompt hash alone. Cost figures are informational only and never authorize or block work.
Existing readers of this log remain compatible with events recorded before usage existed. See the
[prompt-routing PRD](jev-prompt-routing-prd.md), [integration overview](jev-prd.md), and
[evaluation plan](jev-evaluation.md).

### Central config envelope

The envelope has exactly these outer fields and no others:

```json
{
  "schemaVersion": 1,
  "repoPath": "/absolute/canonical/repository",
  "policy": {
    "version": 1,
    "validationCommands": [
      {
        "name": "package:ci:local",
        "argv": ["bun", "run", "ci:local"],
        "surfaces": [],
        "timeoutMs": 600000
      }
    ]
  }
}
```

The path and command list above are illustrative placeholders. The writer must substitute the observed
canonical `repoPath` and literal command objects returned by `onboard`. Default setup writes a `policy`
object with exactly `version: 1` and the `validationCommands` array returned by discovery; it does not
add inherited defaults to the file. Every read validates the outer fields, `schemaVersion`, matching
canonical `repoPath`, and the inner policy.

`policy` is the existing strict repository-policy override object. Its optional top-level keys
are:

| Key | Type and behavior |
| --- | --- |
| `version` | Must be `1` when present. |
| `models` | Partial map of `coordinator`, `scout`, `implementer`, `reviewer`, `verifier`, and `presentation` to `{ "model": "provider/model", "thinking": "..." }`; selectors are exact `provider/model` strings. |
| `instructions` | Appendable arrays for `implementation`, `validation`, and `review`; each entry is non-empty text. |
| `instructionFiles` | Appendable arrays for the same channels; every path uses relative POSIX syntax and remains physically inside the target repository. |
| `validationCommands` | Appendable `{ "name", "argv", "surfaces", "timeoutMs" }` objects; `argv` is non-empty, `surfaces` is a string array, `timeoutMs` is positive, and names do not conflict with inherited commands. |
| `maxWorkers` | Positive integer concurrency limit. |
| `maxFixRounds` | Positive integer review-fix limit. |
| `reviewLevels` | Optional `{ "reducedRouting", "deepScrutiny", "jevAssistance", "sourceTransmission" }`; the two booleans and `sourceTransmission` default to `false` and `jevAssistance` defaults to `"off"` (the only other value is `"shadow"`). See [Risk-based review levels](#risk-based-review-levels); `reducedRouting` and any move past `shadow` require the documented evaluation first. |

Custom approved policies use the same envelope and preserve every unrelated valid key and value.
`instructionFiles` and all root guidance reads remain relative to the target repository; the
central home is never used as a guidance root. Built-in role pins and limits remain unchanged
unless separately requested, and are not part of the onboarding interview.

Existing valid central configuration is inspected and preserved; setup is not a repair or
replacement flow. A missing validation command is a readiness gap. Invalid JSON, unknown outer
fields, an unsupported schema version, a mismatched `repoPath`, an invalid inner policy, or a
symlink in the policy namespace is blocked while the raw state remains untouched.

The CLI setup path has no custom-command override. For a custom manager command, CI correction,
or policy correction, obtain exact approval scoped to the target project and requested fields; keep
the full envelope in the structured result/reference and expose it only on request. Re-read the
central file immediately before writing: compare an existing file with the inspected snapshot (stale
snapshot guard), and use an exclusive-create/no-clobber primitive for a missing file. Refuse the edit
if the path or its pre-existing parent/file symlinks could escape the selected home, or if the writer
cannot provide these guards. Re-run read-only `onboard` afterward. Do not add a new CLI flag.

### Instruction sources and provenance

Policy resolution builds a pinned guidance snapshot for each channel in this order:

1. inherited and repository inline entries, with provenance such as `policy.instructions.implementation[0]`;
2. the repository root `AGENTS.md`, if present;
3. the repository root `CLAUDE.md`, if present;
4. configured `instructionFiles` for that channel, in declaration order.

Identical text is de-duplicated while preserving the first source. The resolved entries retain
both channel and source, and the task stores the resolved policy snapshot at creation time;
changing a guidance file later does not silently rewrite an existing task's instructions. For a
clean-bound coordinator, the original `TANDEM_REPO` remains the central policy and task identity,
while `TANDEM_SOURCE_REPO` supplies the committed checkout for package, root guidance, and
repository-relative `instructionFiles` reads. The original checkout is identity-only for that
coordinator and its dirty guidance is never silently read. The default reader rejects absolute paths,
Windows separators, traversal, missing configured files, and symlinks that resolve outside the selected
guidance checkout. Root guidance files are optional; configured instruction files are required.

The three channels are `implementation`, `validation`, and `review`. Implementation and review
briefs include the relevant pinned entries with their source labels. The task snapshot retains
the validation channel, while actual validation decisions are determined by the pinned command
specifications and runner evidence.

## Task lifecycle

Create a task with an explicit objective, acceptance criteria, and surface list:

```sh
bun src/cli.ts create \
  --repo /absolute/path/to/repository \
  --kind scout \
  --objective "Map the authentication boundary and identify affected callers" \
  --acceptance "Report entry points" \
  --acceptance "Identify risks and open questions" \
  --surface "backend"
```

`--kind` accepts `scout` or `implementation`; it defaults to `implementation`. `--acceptance` and `--surface` may be repeated. The JSON alternative is mutually exclusive with positional arguments and field flags:

```sh
bun src/cli.ts create --input '{"repoPath":"/absolute/path/to/repository","kind":"scout","objective":"Map the authentication boundary","acceptanceCriteria":["Report entry points"],"surfaces":["backend"]}'
```
For a clean-bound coordinator, task creation accepts either the original repository path or its
configured clean source checkout and normalizes the record to the original canonical identity.
The two checkouts must be distinct worktrees of the same Git common directory; unrelated paths are
rejected. Prefer the original `TANDEM_REPO` path in task requests so task records, policy, and
delivery remain visibly attached to the project the user selected.

Task creation captures policy and the ready source revision atomically. Workers start at that exact
commit even if `origin/main` advances afterward. Existing tasks, leases, and worker checkouts are not
repinned by a coordinator refresh. Fetch or source-safety failures block new creation, not existing
pinned work. A saved lease without worker history must pass the same captured-HEAD check on retry;
an allocation failure never grants permission to launch from the rejected checkout.

A scout is created in `queued` and scope-approved. This records requested work but does not prove that a worker has started or that research is complete. If delegation is blocked, the coordinator discloses the durable blocker as actionable state; direct research requires explicit user authorization. An implementation is created in `awaiting-approval` with `scopeApproved: false`; creation does not approve it. Approve the recorded scope explicitly before dispatch:

```sh
bun src/cli.ts approve TASK_ID --yes
```

The durable stages are:

| Stage | Meaning |
| --- | --- |
| `awaiting-approval` | Implementation scope exists but has not been approved. |
| `queued` | Approved work is waiting for scheduler capacity; it is not proof of an active worker or completed research. |
| `scouting` / `implementing` | A worker is active in its owned workspace. |
| `validating` | The runner is executing one named validation contract at that exact HEAD: targeted iteration checks between fix rounds, or the complete final acceptance manifest once the candidate is otherwise ready. |
| `reviewing` | The contract's checks passed; fresh reviewers are recording the required lenses. |
| `awaiting-fixes` | Validation or review found a failure; a bounded fix round may be started. |
| `ready` | The complete final acceptance manifest and all required review lenses pass for the delivered code and policy at the current HEAD. |
| `paused` | Work is stopped with a resumable previous stage. |
| `blocked` | Work cannot safely proceed; a reason is durable, requires coordinator judgment, and is surfaced as an actionable blocker. |
| `cancelled` / `completed` / `merged` | Terminal states. A scout is research-complete only in durable `completed` state with its report; implementation reaches `merged` only after verified delivery. |

For implementation, each completion and fix cycle is bound to the current generation and HEAD. A fix cycle increments the generation, clears stale review/validation evidence, and returns to `implementing`. The default `maxFixRounds` is three; once exhausted, the task remains unresolved rather than looping indefinitely.

Reaching `ready` and exhausting the bounded fix-round loop are both surfaced promptly as distinct
coordinator notifications through the existing notification path, so neither needs a follow-up
prompt. The ready message is emitted only at true readiness, after the final acceptance manifest is
satisfied, and it names the required lenses, the review level, the accepted HEAD, and that ready is
not publication, merge, or deploy approval. Exhaustion blocks the task with a reason that names the
spent and configured rounds, states that the task is not ready and not accepted, lists the
evidence-backed blockers that remain, and names the explicit decision available. Neither message
claims delivery.

### Request briefs and approval revisions

A substantial request gets one durable request brief: a stable `req-`prefixed identity, a monotonic
draft revision, and the approval bound to it. The record lives in the `request_briefs` table of the
authoritative `<home>/state.sqlite` and is written under the same compare-and-swap discipline as a
task record. A request id can never collide with a task id, so related tasks refer to one approved
request through their own `requestId` field instead of becoming a second identity owner.

A brief holds the goal, scope, constraints, non-goals, acceptance criteria, recommended approach,
key decisions, unresolved questions, and research links. The first seven carry the agreement; the
unresolved questions and research links are annotations. Every edit creates a new draft revision and
pushes the previous one into the preserved history, so revisions only ever move forward.

```sh
# through the coordinator's tandem tool
{"request":{"action":"brief-draft","repoPath":"/absolute/path","content":{...},"reviewPane":true}}
{"request":{"action":"brief-approve","requestId":"req-...","briefRevision":3,"contentDigest":"..."}}
```

Approval is an explicit main-conversation decision, human-confirmed at runtime like every other
approval-bearing action. It records the exact request id, draft revision, content digest, and
agreement digest, and it is refused when any of the three names something other than the current
draft. An approval taken for one revision therefore cannot approve a later revision or a different
request.

An agreement change makes the recorded approval non-current: dispatch under that request is refused,
and the work already running under it is paused through the existing ownership-safe pause control
until the brief is reapproved. Annotation-only edits still advance the draft revision but leave the
approval current, so progress notes never force reapproval. An approved brief records an agreement
and nothing more: task scope approval, publication, merge, deploy, and destructive actions each
remain separate explicit approvals.

With `reviewPane: true` the coordinator renders the current draft as read-only Markdown under
`<home>/request-briefs/<requestId>.md` and shows it in one temporary Herdr pane it owns. The pane has
no editing path; the user edits by replying in the main conversation. A tiny fix keeps the same
approval contract with a compact in-chat brief and no pane at all.

Every pane operation proves exact ownership first, through the same native session snapshot,
endpoint identity, stopped-pane, and close-verification checks the coordinator's own pane uses. The
durable record keeps the outcome:

| Pane status | Meaning |
| --- | --- |
| `open` | The owned pane is showing the recorded draft revision. |
| `closed` | Approval retired the owned pane, or it was already gone; the next projection reopens one. |
| `retained` | A transient refusal such as a busy pane. Nothing was closed; retry later. |
| `quarantined` | Ownership could not be proven, or a pane operation failed. Nothing is closed or renamed until a human resolves it. |

A missing, moved, foreign, ambiguous, busy, or failed pane never closes an unrelated pane and never
loses the brief: the durable record, its approved revision, its history, and every task referring to
it stay readable from SQLite, and the rendered Markdown is rewritten regardless. A pane receipt on
its own never changes a task stage or task scope approval.

### Post-research continuation disposition

Every scout record carries a durable `researchContinuation` describing what its completed report
should lead to. It is routing metadata for the coordinator's follow-up turn rather than permission:
it does not set `scopeApproved`, create an implementation task, or replace explicit scope approval.
Only scout records may carry one; a continuation on an implementation record is refused.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always `1`; any other value is refused rather than repaired. |
| `disposition` | `report-only`, `ask-intent`, or `implementation-interview`. |
| `selectedBy` | `explicit` (supplied with the task request), `deterministic` (rule table), or `jev`. |
| `classifierVersion` | Required for `jev`, optional for `deterministic`, refused for `explicit`. |

Task creation accepts an explicitly supplied disposition; a scout created without one is classified
before the record is written. Scout records written before the field
existed load with that same conservative default, so restart, compaction, legacy JSON migration,
and bounded recovery all keep one disposition per task. Unsupported dispositions, unsupported
selectors, unknown fields, and malformed provenance fail closed as state corruption instead of
being downgraded to a default.

Durable state outranks the recorded disposition when a completed scout wakes the coordinator. An
open `needs-decision` question is answered first; a failed, blocked, cancelled, incomplete,
stale-generation, or missing-report scout discloses its blocker instead of entering the generic
follow-up. Task summaries and the durable digest print the disposition and its provenance, so the
choice survives context compaction without an ephemeral model-memory flag.

#### Following up after a scout reports

The existing completed-scout coordinator notification remains the only wake mechanism. The
notification text carries the follow-up decided from the persisted record, with the delivery path
first proving the recorded report is still readable, so the same durable record produces the same
wake text after compaction, restart, or coordinator replacement:

| Follow-up | Coordinator behavior |
| --- | --- |
| `report-only` | Summarize the report and stop; propose no implementation work. |
| `ask-intent` | Summarize the report, then ask only whether the user wants implementation work. |
| `implementation-interview` | Summarize the report with its evidence, propose one initial direction, then ask focused questions about desired behavior, acceptance criteria, affected surfaces, non-goals, risks and compatibility, and approval, with a default for each. |
| `answer-question` | An open `needs-decision` question outranks the disposition and is resolved first. |
| `disclose-blocker` | A non-scout, blocked, cancelled, incomplete, stale-generation, or unreadable-report record has its exact blocker disclosed. |

The interview stays inside the report and the user's request and never widens scope on its own.
Only after the user answers may the coordinator create an implementation task citing that scout in
`researchTaskIds`. That task is created `awaiting-approval` with `scopeApproved` false, still passes
repository and source-checkpoint handoff validation, and does not launch until the concrete scope is
explicitly approved. User answers travel through the existing steer/answer communication APIs.

#### Classifying the disposition

A narrow continuation classifier, separate from the read-only prompt router, chooses the
disposition for a scout created without an explicit one:

1. A pure deterministic cue table decides first and makes no provider call. Explicit
   information-only wording records `report-only`; explicit investigate-then-fix, implement, or
   prepare-a-patch wording records `implementation-interview`; wording carrying both cues records
   `ask-intent`, so an explicit report-only request can never be upgraded. Only imperative requests
   count: descriptive or hypothetical wording such as "how retries are implemented" or "whether we
   should implement the queue" stays unresolved for step 2.
2. Only wording the rules leave unresolved, such as an unqualified "research this ticket", reaches
   Jev, as one typed closed-set choice over the three dispositions. The request state contains only
   the sanitized, single-line, length-bounded objective and the task kind: never the repository, a
   scout report, credentials, or transcript. The model and the question/schema version are pinned
   and recorded together in `classifierVersion`.
3. A missing `TYPESAFE_API_KEY`, a timeout, a provider outage, a malformed answer, or a confidence
   below the classifier threshold records the conservative `ask-intent` with `deterministic`
   provenance. Research is never blocked or delayed past the bounded `TANDEM_JEV_TIMEOUT_MS`
   request timeout, and Jev never creates tasks, approves scope, selects implementation details, or
   relaxes any safety policy.

### Review and validation

Review is independent and sequential. Tandem stops or pauses the implementer, opens one fresh read-only reviewer pane in the same task worktree, and records one current result per lens:

- `behavior` — observable semantics, ordering, mutation timing, errors, and boundaries;
- `design` — function-review principles, honest dependencies, empathic signatures, abstraction levels, comments, and declaration order;
- `coverage` — changed behavior, affected callers, relevant tests/reports, and acceptance criteria;
- `verification` — fresh inspection of the exact HEAD and generation using runner evidence.

All four lenses are required. A failed lens sends the task to `awaiting-fixes`; passing all four sends it to `ready`. Reviewers remain read-only and do not invent command output.

Validation commands are argv-only and execute in declaration order. A command belongs to the manifest when its `surfaces` is empty, contains `*`, or intersects the task surfaces; a task surface of `*` matches every command. The runner stops after the first non-zero, timeout, or cancellation result. Every evidence record includes the command name, argv, exit code, captured stdout/stderr, exact HEAD, the contract it ran under, the check origin, and the policy digest it was pinned to. No configured command or no matching command is a validation configuration failure, not a pass.

### Iteration and final acceptance contracts

Validation runs under one of two named contracts. `src/tasks/acceptance.ts` owns both decisions; the runner and the task lifecycle only execute and record them.

The **iteration contract** covers targeted reproduction between authorized fix rounds. When a fix round is admitted, Tandem records a durable `iterationScope` on the task naming the checks that reported the failure, the surfaces those checks cover, the findings the round must resolve, and the code and policy identity the scope was derived under. The next validation run then executes only those checks and records evidence stamped `contract: "iteration"`. A contained fix reaches review without rerunning the whole suite, and a targeted pass is useful progress that never satisfies acceptance.

The **final acceptance contract** is the complete command and criterion manifest pinned to the delivered code, the pinned policy digest, and the current HEAD. It lists every required check, the four review lenses, and the recorded acceptance criteria. It runs in full only when the candidate is otherwise ready, meaning every required lens already passes at that HEAD and generation. Review completion with all lenses passing sends the task back to `validating` for that final run instead of straight to `ready`; `ready` is reached only once every manifest item passed under the same code and policy identity. Delivery repeats the check and refuses a branch whose manifest is incomplete, failed, or stale.

Targeted checks are refused for the complete manifest when the scope was recorded under a different policy identity (`stale-identity`), when a reviewer rejected a candidate whose checks all passed (`disputed-result`), when the scope names a check the manifest does not configure (`unknown-impact`), or when the scope already covers every configured check (`broad-impact`). The escalation reason is durable on the validation job and visible through `tandem inspect`.

Any relevant change invalidates prior evidence. A fix round increments the generation and clears validation evidence; `invalidate-evidence` additionally clears the recorded scope and the reviews. Evidence carrying a policy digest other than the one the run reported is refused rather than recorded, and final evidence recorded at another HEAD or policy digest reads as stale, never as a pass. After a candidate fails the complete manifest it returns to the authorized fix phase, runs targeted checks between fix rounds, and re-enters the complete manifest from the beginning once it is ready again.

Validation evidence written before contracts existed loads unchanged and is marked legacy. Legacy records stay readable as durable history, including on completed and cancelled tasks, and satisfy neither contract, so a candidate carrying them must run the complete final manifest again before it can be delivered. A record naming only part of its contract identity, or marked legacy while also claiming an origin or policy digest, is a corrupt shape and fails closed. A validation job persisted without its contract identity is refused for the same reason and the task is blocked with that cause, rather than being consumed as if it were pinned.

Local runner checks and GitHub checks stay distinct. Runner evidence is stamped `origin: "local"` and satisfies only local manifest requirements; remote required checks remain the GitHub-observed `RemoteCheck` rollup asserted at merge. A local pass cannot be relabeled as a remote check, and `tandem inspect` reports the iteration/final and local/remote split alongside the passing count.

Child workers do not run project-wide tests, builds, formatters, linters, or other gates. The parent validation worker runs the configured commands and records evidence after implementation work is handed back. Textual scout and implementer results must start with exactly one role-appropriate `Outcome: completed|needs-decision|failed` (scouts) or `Outcome: implemented|needs-decision|failed` (implementers) line. Reviewer, verifier, and presentation workers may use `Outcome: needs-decision` for a genuine blocker; otherwise reviewer/verifier success remains the strict `ReviewResult` JSON contract and presentation success remains its `Artifact: <absolute path>` contract. Any `needs-decision` result emits exactly one bounded single-line `Question: ...` and optional bounded single-line `Recommendation: ...` (each no more than 1,000 characters); durable task communication assigns the current question id and preserves report/artifact evidence. Questions wake the coordinator, not the user directly.

### Incremental review briefs and finding status

Each bounded review round writes one deterministic review brief next to the immutable diff in the
reviewer's job directory, at `review-brief.md`. `src/tasks/review-brief.ts` builds it as a pure
function of durable task state plus injected git observations, so the same task, HEAD, and worktree
always produce the same brief. It is reused context, not a second memory, handoff, or provider
system: every field comes from the records the task already keeps.

The brief carries the approved scope, the acceptance criteria, the five applicable principles as
mandatory blocking requirements, and explicit non-goals; the exact source, policy, instruction, and
configuration identities (HEAD, branch, base, generation, review round, policy digest, review-channel
instruction provenance, `maxFixRounds`, `maxWorkers`, and the configured command names); references
to the cumulative range from the worktree base and the range since the last reviewed HEAD, each as a
patch path plus its changed-file list; the files at HEAD that reference a changed file; source links
pinned to HEAD; the current final-acceptance status and iteration scope; the recorded checks; and the
prior finding status with the change that supports it. Reviewers keep full source access and an
independent context. The brief says so explicitly: an implementer assertion, summary, report, or
claimed fix is never proof, and every claim is confirmed against the source, the diff, or
runner-produced evidence.

Findings keep a stable identity across rounds on the durable `findingLedger`, which `record-review`
is the only writer of. An identity is `lens:id`, and the reviewer is instructed to reuse the exact id
the brief lists when it reports the same issue again. Each entry carries `unresolved`, `addressed`,
`regressed`, or `disputed`, together with the round that raised it and the round and HEAD that set
its current status. A review of the same lens at a later generation that stops reporting an identity
settles it as `addressed`; only a later review that reports it again reopens it as `regressed`, so a
settled finding is never reopened without new evidence. Two reviews of one identity that record
contradicting verdicts mark it `disputed`. Blockers and suggestions are split by the rule a review
already enforces: a confirmed P0, P1, or P2, or a plausible P0 or P1, blocks, and everything else is
an optional suggestion. A violation of a mandatory design rule or applicable principle blocks through
the same rule.

The brief also states how wide this round must be. Impact is `contained`, `expanded`, or `unknown`,
and it reuses the existing `EscalationReason` vocabulary rather than adding a parallel one. A fix that
reaches files outside the surface the round was authorized to touch reports `broad-impact`; a fix
whose surface cannot be bounded, a truncated incremental patch, or a missing prior reviewed HEAD
reports `unknown-impact`; and an escalated validation contract carries its own reason through. Any
assessment other than `contained` tells the reviewer to read the cumulative diff and the affected
callers in full.

The brief is bounded by named limits in `REVIEW_BRIEF_LIMITS`, covering the findings, changed files,
affected callers, source links, advisory leads, evidence entries, per-field text, the patch byte
budget, and the rendered brief itself. Suggestions, settled findings, long descriptions, and the bulky
file lists are compacted first; blocker identities and their status are never elided, and an elision
is stated with a pointer to the complete durable record. The brief input also carries an optional,
typed slot for advisory review leads. Those render with their provenance under an untrusted heading
and can never become blockers, drop mandatory context, or authorize acceptance; Tandem produces none
of them today.

When the configured fix-round budget is spent, the durable block reason names the blockers that
remain and the decision that is available: stop for a human decision, or revise and re-approve the
task scope. No round is retried automatically, nothing auto-passes, and no unresolved blocker is
downgraded to a suggestion. The final review still runs against the delivered code at the current
HEAD and the brief never replaces the final acceptance contract.

Records written before the finding ledger existed load unchanged with no ledger, so no prior status
is claimed without evidence. A ledger entry naming an unknown status, or missing the observation that
supports its status, is a corrupt shape and fails closed.

### Risk-based review levels

Every review round classifies the change it is about to review. `src/tasks/review-levels.ts` does it
as a pure function of the observed diff and the affected context: the changed paths, the content
observed for each of them, the files at HEAD that reference a changed file, and the round's impact
assessment. A line count, a task title, and a file extension are never sufficient on their own. A
path categorizes a file only when it names an enumerated sensitive location such as `package.json`,
a `migrations/` directory, or `.github/`; every other category comes from the diff content.

The level is `light`, `standard`, or `deep`, and it is recorded on the task with the reason that
produced it and the safety floors that fired. `tandem show` prints all three.

Four fixed safety floors force a minimum level whatever else the diff shows:

| Floor | Fires on | Minimum level |
| --- | --- | --- |
| `permissions-security` | authentication, authorization, credential, or cryptographic content | `deep` |
| `data-integrity` | migrations, schema or serialization changes, durable-record content | `deep` |
| `shared-contracts-concurrency` | changed exported declarations, locking, ordering, or interleaving | `deep` |
| `dependency-build-infra` | manifests, lockfiles, build configuration, deployment definitions | `standard` |

Uncertainty classifies conservatively. Unknown impact classifies `deep`. A diff whose content could
not be observed, a truncated patch, a binary file, and a round with no observed changed file classify
`standard`. A change that reached outside the surface its round was authorized to touch classifies
`standard`. `light` requires all of: contained impact, every changed file observed, no floor fired,
every file categorized as contained implementation, tests, or documentation, and the changed-file and
affected-caller counts within `LIGHT_CLASSIFICATION_LIMITS`. Reclassification only ever raises: a
later round that observes a wider or more sensitive change raises the recorded level and says so, and
a later round that observes a narrower change keeps the recorded level. Classification never touches
the task's pinned policy or model choices.

Records written before review levels existed load with no recorded level and read as the conservative
`standard` default, and their pinned policy loads with every review-level opt-in off, which is the
review behavior they were pinned under. A recorded level naming an unknown level or safety floor, or
missing its reason, is a corrupt shape and fails closed.

#### What a level changes, and what must happen first

**With the default policy, classification records the level and its reason and changes nothing else.
Every task reviews exactly as it did before levels existed: the behavior, design, coverage, and
verification lenses all run, in that order, at every round.** The `reviewLevels` policy section
controls the rest, and every field defaults to off:

```json
{ "policy": { "reviewLevels": {
  "reducedRouting": false,
  "deepScrutiny": false,
  "jevAssistance": "off",
  "sourceTransmission": false
} } }
```

- `reducedRouting` lets a `light` iteration round review one focused lens instead of four. It applies
  only between authorized fix rounds and only before the final acceptance manifest has run at that
  HEAD; once the manifest is recorded, the complete lens set is required again. **Do not enable it
  until the documented end-to-end evaluation in issue #20 has been run and published.** See
  "Evidence required before enabling reduced routing" below.
- `deepScrutiny` adds the fired floors to a `deep` round's brief as mandatory scrutiny a reviewer must
  dispose of explicitly. It adds work; it never removes any.
- `jevAssistance` is `off` or `shadow`. Shadow records a helper's depth recommendation beside the
  deterministic level for later comparison and never uses it.
- `sourceTransmission` is the separate, explicit opt-in for sending changed source to an external
  provider. It is distinct from having a `TYPESAFE_API_KEY` present.

Issue #17's final acceptance contract is unchanged at every level. The final manifest always requires
all four lenses and every configured required check for the delivered code at the current HEAD, so no
level can make a candidate acceptable on less evidence.

#### Shadow helper assistance

`src/tasks/review-assistance.ts` asks the existing Jev transport in `src/adapters/typesafe.ts` two
bounded questions, batched into one call: recommend a depth, and flag a small set of focus areas tied
to the applicable principles (a hidden effect, a weakened test, an authorization change). There is no
second provider path, memory, or handoff system.

The helper is called only when `jevAssistance` is `shadow`, `sourceTransmission` is true, and a
credential is configured. With any of those absent the injected evaluator is never invoked and zero
source bytes leave the process.

Flags enter the review brief through its existing advisory-lead slot, each with its provenance: the
diff it was attributed to, the applicable principle, the exact question, the request identity
(separate code, context, question, schema, policy, and model digests), and the result identity. They
render under an untrusted heading. A lead never becomes a finding or a blocker, never excuses dropping
an applicable dimension, and never authorizes acceptance.

A recommendation can only raise a level. `raiseReviewLevel` takes the greater of the deterministic
level and the recommendation, so a confident `light` answer on a security-floor change leaves the
level at `deep`. In shadow mode the recommendation is recorded and the deterministic level is used
unchanged. Provider failure, timeout, a malformed or adversarial answer, a confidence below the
provisional bound, and missing or stale context all yield no recommendation and no lead, and none of
them blocks or downgrades the baseline flow.

Every threshold in `REVIEW_ASSISTANCE_LIMITS` is a provisional placeholder, not a calibrated value.
The transmission bounds are hard limits enforced regardless.

#### Privacy boundary

Sending changed source to an external provider is new beyond prompt-only routing, so it is opt-in and
screened. Screening refuses a file whose path looks secret-bearing (`.env`, `secrets/`,
`credentials/`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, `.netrc`, `.aws/`, `.ssh/`) and a file whose
observed content matches an obvious secret pattern (a PEM private key header, an AWS access key id, a
GitHub or OpenAI or Slack token shape, a bearer token, or a key-value assignment of a long opaque
secret). What survives screening is bounded by `maxTransmittedFiles`, `maxTransmittedLinesPerFile`,
and `maxTransmittedBytes`. A refusal or a provider failure appends a bounded diagnostic to
`<home>/logs/tandem.jsonl` carrying counts, byte totals, and a request-identity prefix, and no source
content.

Answers are cached in memory on an exact match of every identity at once: code, context, question,
schema, policy, and model. Any difference is a fresh request.

#### Evidence required before enabling reduced routing or helper assistance

`evals/review-levels/` holds a deterministic, credential-free comparison that runs under `bun test`.
It covers low-risk, high-risk, Tagalog-language, and adversarial synthetic changes, and reports missed
serious issues, false-safe routing, escalation, and rework, plus latency and cost fields that stay
`unavailable` when nothing reported them. False-safe routing is a safety failure counted and reported
on its own; it is never averaged into an agreement or accuracy rate.

Before anyone sets `reducedRouting` or moves `jevAssistance` past `shadow`, the following must exist
and be published:

1. The end-to-end benchmark from issue #20, over equivalent snapshots, measuring the whole path to a
   verified result rather than classifier latency alone.
2. Zero false-safe routing across the high-risk, Tagalog, and adversarial fixtures for the proposed
   configuration, with the safety count reported separately from any agreement rate.
3. A confidence and threshold sweep showing the proposed bounds were chosen from data rather than
   assumed, since every bound shipped here is provisional.
4. A recorded comparison of missed serious issues, escalation, rework, and cost against the
   deterministic baseline, with the deterministic path retained if it is not clearly worse.

No speed or quality claim is made for any of this work. The reported CI durations that motivated the
tracking issue are user observations, not a measured baseline.

### Interactive child terminals

Scouts, implementers, reviewers, verifiers, and presentation workers launch interactive OMP with
inherited terminal input and output. They do not use `-p` or `--mode json`. Open the child's Herdr
subtree to inspect its conversation or send a message directly.

The worker extension writes the existing private result file from the final native `agent_end`
event. Continuing events are not completion, and later human conversation never overwrites that
delegated result. Terminal output is display only; large reports do not pass through a captured
JSONL stream. The scheduler can consume a result while OMP remains open, after checking the
job identity, generation, native PID, physical checkout, and fresh terminal heartbeat.

After completion or pause, follow-up model turns are read-only: read, grep, glob, and web search
remain eligible where the role allows them, while mutating tools are blocked. Request additional
implementation through the coordinator. Validation runs in its own non-model pane, and completed
reviewer and presentation conversations remain open rather than being closed on result consumption.

A later writer job may reuse its pane only after the previous delegated turn has finished or
paused and the interactive session is idle with no queued messages or editor draft. Cooperative
close freezes new input, requests native terminal exit, and verifies process exit before reuse.
Busy, foreign, stale, or otherwise unproven terminals are retained instead of interrupted.

### Herdr workspace labels and status

New task workspaces are named `└ <task objective> · <short identity> · <role>`. Presentation
workspaces use their bound task's objective and a `presentation` role cue. Labels normalize
control characters, whitespace, and Unicode, and stay within 96 UTF-16 code units without splitting
graphemes. The exact label is persisted before native creation and reused for launch recovery;
recovery never recomputes a label from a changed objective. Technical task names, worktree names,
branches, existing labels, and custom labels are unchanged. A label is never ownership proof.

The coordinator and interactive worker extensions publish Herdr's native agent lifecycle states:
active/continuing turns are `working`; open question dialogs and paused workers are `blocked`;
completed turns are `idle`, which Herdr may render as `done`. Failed or needs-decision worker
results remain blocked. Read-only follow-up turns return to their settled state afterward.
When the coordinator itself is idle, its bubble reflects tasks belonging to the physical original
project: pending approval, pause, and blockers take precedence over active queued/running work.
Ready and terminal tasks do not keep that aggregate working. Validation publishes working while
commands execute and releases its status authority on exit; its pane is closed on result consumption.

Reporting is disabled outside an exact Herdr pane context. Reports are serialized and deduplicated,
failed reports remain eligible for the next lifecycle/heartbeat update, and shutdown releases
authority even if durable shutdown fails. Each reporter instance uses a fresh source identity because
Herdr retains sequence watermarks after release. Reporting failures never authorize or interrupt
durable work. Status, display labels, and terminal output are not job-completion or ownership evidence.
Restart an existing coordinator to load the updated extension; existing workspaces are not renamed.

## Inspecting and controlling work

```sh
bun src/cli.ts list
bun src/cli.ts status
bun src/cli.ts show TASK_ID
bun src/cli.ts show TASK_ID --full
```

The summary is bounded for model-facing output; `--full` requests the larger structured view. A full task record includes the task identity and revision, repository, kind, objective, acceptance criteria and surfaces, stage, approval state, pinned policy, worktree and endpoint identities, generation and review round, reviewed HEAD, validation evidence, review results, report path, blocker, notifications, and pull-request metadata when present.

Coordinator task counts and stage claims come from durable task state; do not infer them from worker or process observations, receipts, or notifications.

Advance the scheduler explicitly or watch it:

```sh
bun src/cli.ts tick
bun src/cli.ts watch --iterations 30 --interval-ms 2000
```

The default watch interval is 2,000 ms. `--iterations` is a positive finite count; without it, watch continues until interrupted. A scheduler tick reconciles durable jobs/endpoints and may start queued work, validation, or review. Polling itself does not create a model turn. Routine scheduler notices, including automatic review-fix handoffs, are UI/log activity rather than model input.

Interrupting `watch`, `tick`, or `feedback` stops the CLI's owned feedback listeners and watch timer, then drains the active reconciliation before exiting nonzero. It does not cancel task workers; use `pause` or `cancel` for that. Interactive `launch` leaves signal handling to OMP.

Control owned work without deleting its evidence:

```sh
bun src/cli.ts pause TASK_ID --reason "Need a product decision"
bun src/cli.ts resume TASK_ID
bun src/cli.ts cancel TASK_ID --reason "No longer needed" --yes
```

Pause and resume are non-destructive. Cancel requires explicit CLI consent and preserves reports and unmerged work. Recovery can resume only from a valid paused or blocked previous stage; it does not guess a missing endpoint or job.

### Two-way task communication

The coordinator can forward a concise user delta to an existing task without changing its
approved scope:

```sh
bun src/cli.ts steer --task TASK_ID --text "Use the existing parser; preserve the public API" \
  --supersedes MESSAGE_ID
bun src/cli.ts messages --task TASK_ID
```

Independent directions may be sent as separate `steer` calls in order. Repeat `--supersedes` only
to mark earlier messages obsolete; never silently rewrite history. These
information-only actions do not need `--yes` when they stay inside approved scope. A materially
wider request still follows the normal interview and approval workflow, and steering never changes
the pinned policy or `scopeApproved` state.

When a worker reports a current needs-decision question, the coordinator is the single user inbox. It first inspects the durable current question id, recommendation, report path or artifact path, task/presentation identity, approval state, and relevant in-scope evidence. It may answer through the existing questionId-bound answer action only when explicit prior user direction, the approved scope, or unambiguous repository facts establish a safe non-destructive answer; it must send a concise rationale with the exact current question id. For presentation questions, include the presentation's task identity and current question id in the same answer request; the controller routes it to the presentation runtime. Genuine product choices, ambiguous evidence, scope changes, credentials, and approval-bearing, destructive, publishing, merging, or deployment decisions remain with the user; the coordinator never infers consent:

```sh
bun src/cli.ts answer --task TASK_ID --question QUESTION_ID \
  --text "The approved scope already requires preserving the existing API; proceed with that option."
```

`messages` returns structured communication metadata and per-message status. In compact output,
**queued** means persisted for the child, **received** means the bridge observed it, and
**delivered** means the message entered provider-bound context. Steer and answer return a queued
receipt; the child applies it at the next safe boundary. Do not poll `messages` in a model-driven
loop: query it when the user asks or before a dependent decision. Mechanical/UI receipts, heartbeats,
and passive progress do not require a follow-up model turn. Neither queued nor received proves
delivery; delivered is not implementation completion. Check the receipt when needed instead of
claiming that code changed. Each message is bounded to 1,000 characters, active message text to
6,000 characters, and the serialized active payload including metadata to 12,000 characters.
Supersede obsolete directions when a bound is reached; full task reports remain the evidence source.

Compact `steer` and `answer` output reports only the latest recorded entry; compact `messages`
output prioritizes the current question and pending/latest entries. Older history remains available
in structured JSON/details.

If directions arrive before initial approval, the `approve` confirmation includes the current
communication revision and every effective, non-superseded communication delta (including answers
that carry implementation direction). It omits superseded messages and the full communication JSON,
so the approval boundary stays clear without hiding what the worker will receive.

The derived inbox is recoverable and may briefly lag canonical task state. Reconciliation repairs
the projection; it never accepts an older result or drops a pending direction. Paused,
infrastructure-blocked, merged, or cancelled tasks keep their documented lifecycle semantics:
directions may be retained or explicitly rejected, but they do not bypass approval, resume work
automatically, publish, or merge.

Running primary workers receive directions at the next provider-context boundary without interrupting
an active tool. A terminal response continues only if an unapplied direction remains. Work already
in validation, review, or ready state instead stops through the ownership checks and invalidates old
evidence in a new generation, without charging a repair round. Restart the coordinator to load these
commands; already-running workers are not hot-upgraded with the new control extension.

### CLI consent and output

`--yes` is explicit automation consent for approval-bearing CLI commands. It is not an interactive prompt and does not suppress hidden UI. The CLI itself checks the flag and either proceeds or returns a consent error:

- `configure-models --yes` writes approved global model choices;
- `setup --yes` writes a missing central repository policy record;
- `onboard --write --yes` writes a missing central repository policy record;
- `approve TASK --yes` approves implementation scope;
- `cancel TASK --yes` cancels owned work;
- `draft ... --yes` publishes or updates an unfinished draft pull request;
- `publish ... --yes` publishes a reviewed pull request;
- `merge ... --yes` merges a reviewed pull request;
- `cleanup TASK --discard --yes` permits destructive discard.

Safe cleanup does not require `--yes`. In the OMP extension, configure-models, setup, approve, cancel,
draft, publish, merge, and discard cleanup require a live TUI confirmation; without an interactive UI those
actions fail closed. The extension's tool is registered with OMP's write approval and uses the same
runtime checks.

`steer`, `answer`, and `messages` are not approval-bearing actions, so no second generic consent
prompt is added for a clear in-scope user direction. Their receipts only describe communication
state; all existing approval, exact-HEAD, publish, merge, and destructive cleanup safeguards remain
in force.

`--json` emits one JSON result, including errors. Usage and consent failures use exit code `2`; other command failures use exit code `1`.

## OMP extension

The checked-in extension registers a strict `tandem` tool. Its parameter is exactly:

```json
{
  "request": {
    "action": "list"
  }
}
```

Unknown fields are rejected. Tool text is a bounded action summary; structured details remain in the tool result and durable reports. Use `show` with `detail: "full"` when the coordinator needs more state.

Supported actions are:

| Action | Required fields | Effect |
| --- | --- | --- |
| `models` | `repoPath` | Read global model settings and the actual OMP catalogue; never writes. |
| `configure-models` | `repoPath`, `models` (complete six-role map) | Save approved global role choices for future work; requires confirmation and does not mutate existing task snapshots. |
| `onboard` | `repoPath` | Read policy and propose validation; never writes. |
| `setup` | `repoPath` | Write a missing policy after TUI confirmation. |
| `create` | `repoPath`, `kind`, `objective`, `acceptanceCriteria`, `surfaces` | Create a scout or implementation task. |
| `list` | none | List durable tasks. |
| `show` | `taskId`, optional `detail: "summary" \| "full"` | Inspect one task. |
| `steer` | `taskId`, `text`, optional `supersedes` list | Queue an in-scope direction, preserve approval, and invalidate outdated review evidence when needed. |
| `answer` | `taskId`, `questionId`, `text` | Answer the current needs-decision question; stale question IDs are rejected. |
| `messages` | `taskId` | Inspect communication revision, message receipts, current question, and worker activity. |
| `approve` | `taskId` | Approve an implementation scope after confirmation. |
| `tick` | none | Run one scheduler pass. |
| `pause` / `resume` | `taskId`; pause may include `reason` | Stop or resume owned work. |
| `cancel` | `taskId`; may include `reason` | Cancel after confirmation and preserve evidence. |
| `present` | `taskId`, `objective`, `artifacts` | Route a useful visual brief to the presentation worker. |
| `presentations` | none | List presentation records. |
| `feedback` | `presentationId` | Perform one cancellable feedback poll. |
| `describe` | `taskId`, `summary` | Render a reviewed PR description without publishing. |
| `publish` | `taskId`, `repository`, `title`, `base`, `summary` | Publish after confirmation and exact-HEAD checks. |
| `merge` | `taskId`, `method` (`merge`, `squash`, or `rebase`) | Merge after confirmation and remote CI/HEAD checks. |
| `cleanup` | `taskId`, optional `discard` | Safely release resources, or discard only after confirmation. |

The extension also registers `/tandem`. Arguments use shell-style quoting for parsing only; the command is not executed by a shell. These forms are exact:

```text
/tandem list|status
/tandem models [REPO]
/tandem onboard REPO
/tandem setup REPO
/tandem create REPO scout|implementation OBJECTIVE ACCEPTANCE_COMMA_LIST SURFACES_COMMA_LIST
/tandem steer TASK TEXT
/tandem answer TASK QUESTION_ID TEXT
/tandem messages TASK
/tandem show TASK [--full]
/tandem approve TASK
/tandem tick
/tandem pause TASK [reason...]
/tandem resume TASK
/tandem cancel TASK [reason...]
/tandem present TASK OBJECTIVE ARTIFACT[,ARTIFACT...]
/tandem presentations
/tandem feedback PRESENTATION
/tandem describe TASK JSON_SUMMARY
/tandem publish TASK OWNER/REPO TITLE BASE JSON_SUMMARY
/tandem merge TASK merge|squash|rebase
/tandem cleanup TASK [--discard]
```

The extension scheduler starts at session start with a 2,000 ms default interval and reconciles once immediately. It refreshes the durable digest before an agent turn, during OMP-native compaction, and after compaction. Routine notices, receipts, heartbeats, and passive progress are shown with `ctx.ui.notify` and appended to the durable UI log without a model turn. The newest actionable notices in one delivery batch are coalesced into at most one follow-up/model wake; routine backlog is excluded from that wake. Current blocked tasks, completed scout reports, and PR-ready coordinator notices are the judgment-needed cases. A judgment-needed notice on a scout also carries that scout's [post-research follow-up](#following-up-after-a-scout-reports), rebuilt from the durable record on every delivery. Progress is not death: after roughly five minutes without meaningful activity, or about 60 seconds without a startup heartbeat, Tandem emits one actionable inspection warning per inactivity episode and resets the episode when progress resumes; it does not kill a worker merely because time elapsed. Actual process exit or error still follows the existing failed/blocked path.

A scout is completed research only when durable state records its `completed` stage and report; queued or blocked scout work is not completion.

Treehouse worktrees are acquired under the configured pool root and tied to the source/base HEAD, lease holder, lease ID, task branch, and task generation. A launched coordinator first owns a distinct clean source worktree pinned to the original committed HEAD; that source lease is separate from each task worktree. Branches use the `tandem/<safe-task-name>` form. Runtime passes every owned task worktree as protected to pool maintenance.

### Safe automatic maintenance

Normal users do not need to tune a pool cap or approve routine safe cleanup. The scheduler maintains capacity when a queued task needs a worktree:

- only explicitly managed paths inside the physical managed root are candidates;
- Treehouse metadata must unambiguously say the copy is available, Git-backed, unleased, and has no process metadata;
- the path must be a distinct child worktree, not the primary repository, and physical identity must remain inside the managed root;
- Git safety must prove no dirty or untracked content, no ignored content, no unmerged paths, and a clean worktree HEAD that is an ancestor of the current primary HEAD;
- active or otherwise protected task paths are never pruned;
- ambiguous metadata, missing physical identity, failed safety checks, ignored files, dirty files, unmerged paths, and non-ancestor work are retained with warnings.

Automatic terminal cleanup closes stopped owned endpoints and attempts a lease-checked Treehouse return for `cancelled`, `completed`, or `merged` tasks. It runs in the same scheduler pass that settled the task, so a completed scout does not hold its pane and worktree until a later coordinator turn. Live interactive child terminals and their checkouts are retained for inspection and follow-up. Explicit cleanup can cooperatively close an idle completed or paused child, but refuses busy conversations, queued input, editor drafts, and unproven ownership. Worktree return still requires stopped processes, exact lease metadata, the expected task branch, a clean/unmerged-free checkout, and task HEAD ancestry. If proof fails, Tandem retains the worktree instead of deleting it.

### Releasing settled scout resources

A scout only reads, so its lease is returned only after its checkout is proven to be the untouched
pinned source commit on its own lease branch. Any difference at all, an untracked file included, is
somebody's work: the worktree is retained and the reason is reported. A checkout that cannot be
read, or that sits on a branch the lease does not name, is quarantined with every resource kept.
Blocked, paused, and decision-waiting scouts keep their pane and worktree, because those are the
evidence a coordinator needs to answer them; completed scouts with a durable report and safely
cancelled scouts are released.

Cleanup never touches what a scout produced. The report, the source checkpoint, the consumed scout
job, and the task's notifications and history all live in the Tandem home, so a later
implementation task can still cite a released scout through `researchTaskIds`.

Each attempt leaves a durable `cleanup` note on the task record with a status and a reason:

| Status | Meaning |
| --- | --- |
| `released` | The pane was closed and the exact lease returned. |
| `retained` | Cleanup deliberately kept a resource, for example a changed or dirty scout checkout. |
| `pending` | A transient failure; the next scheduler tick or reconciliation retries it, including after a coordinator restart. |
| `quarantined` | Ownership could not be proven; resources are kept and nothing is retried automatically. |

Records written before cleanup notes existed simply omit the field and load unchanged; a present
but malformed note fails the read as state corruption rather than being coerced into a status.

Pool housekeeping keeps the policy-derived idle set and removes only additional proven-disposable copies. This is safe pool maintenance, not an automatic destructive discard of user work. Explicit discard is the only path that bypasses the Git safety proof.

### Disk-pressure admission

The default minimum free-space threshold is 2 GiB (`2 * 1024 * 1024 * 1024` bytes). When free space is below the threshold, maintenance may remove retained warm idle copies one at a time and recheck capacity. If free space is unknown or remains insufficient, the queued task stays queued, its reservation is released, and a durable blocker/notification explains that capacity must be verified or disk space freed. The next scheduler pass can retry. There is no fixed six-worktree limit; `maxWorkers` and the disk threshold govern admission.

Safe cleanup does not require user approval. `--discard` is different: it requires `--yes` in the CLI or a live TUI confirmation in the extension, then uses Treehouse's force return. Do not use discard to resolve an ambiguous, dirty, ignored, or unmerged worktree unless the human explicitly accepts losing that work.

## Pull-request delivery

### Early draft visibility

An unfinished draft PR can be published before final acceptance so review progress is visible while
work is still running. It requires its own explicit publishing approval; scope approval is never
publication approval, and the draft itself never becomes an approval for anything else:

```sh
bun src/cli.ts pr draft TASK_ID OWNER/REPO "Draft title" main --yes
```

Draft eligibility is separate from delivery acceptance. A draft needs an implementation task with
approved scope, a durable worktree lease, and a stage of `implementing`, `validating`, `reviewing`,
`awaiting-fixes`, `ready`, `paused`, or `blocked`. It does not need a reviewed HEAD, successful
validation evidence, or passing review lenses, and it never satisfies any of them. Unmerged paths in
the task worktree refuse the draft; uncommitted changes do not, and the body discloses that the
draft shows committed work only.

The draft is marked unfinished by GitHub's draft state and by a banner that says it is visibility
only, not a claim that the work is ready, mergeable, deployable, or accepted. Its body reports the
task's recorded review level with the classifier's own reason and any safety floors, followed by
what the pinned policy still requires at final acceptance whatever the level is. It then reports
current activity for the durable stage, blockers (durable block reason, bounded-loop exhaustion, an
unanswered question, failed validation evidence, and recorded review findings), the remaining
checks, and the unchanged final-acceptance contract. A task with no recorded level reads as the
conservative `standard` default. Showing a level never changes the gates below it.

Remaining checks are read from the final acceptance manifest owner, so the draft shows exactly what
the final gate will require: each manifest requirement with no evidence, with only stale evidence
from another commit or policy, or with a failing result, plus each review lens still pending, plus
the runner-owned required GitHub checks. A surface set that matches no pinned validation command is
reported as the configuration failure the final gate refuses, never as a pass.

The draft refreshes when durable task state changes: the scheduler recomputes the body from the task
record and updates the existing PR in place. The refresh never creates a pull request, never changes
draft state, never asks for a new approval, and never blocks durable work when the remote is
unavailable. The branch advances by pushing the exact task HEAD without forcing; a refused push
leaves the published commit alone and the body discloses the lag.

Each durable state is attempted at most once, so an unavailable remote cannot turn into a per-tick
retry loop; the next durable change retries. A failed refresh is not silent: it appends a bounded
`draft-refresh-failed` event to the durable diagnostics log with the task id, the pull request
number, which step failed (`digest`, `remote-refresh`, or `record`), and the error class name. No
message text, command output, or payload is recorded. A task that advanced while the refresh was in
flight is recorded the same way, under the `record` step.

Task-to-PR identity is idempotent. Publication observes the task branch before and after the push
and reuses any pull request it finds, so a retry or restart updates rather than duplicates. An
uncertain `gh pr create` outcome is reconciled by re-observing once: an observed pull request is
adopted, and otherwise the failure is raised so the operation is quarantined. Nothing is retried
blindly, no second pull request is created, and no reservation is cleared to make a retry look safe.
`tandem delivery-preflight` treats the task's own draft on the same repository and base as the pull
request that final publication updates, not as a duplicate; any other recorded or observed pull
request is still refused.

### Final delivery

A task must be `ready` before delivery. Describe the PR without publishing it:

```sh
bun src/cli.ts pr describe TASK_ID \
  '{"tldr":["Short result"],"what":["The observable change"],"why":["The user-facing reason"]}'
```

The summary object has only `tldr`, `what`, and `why` arrays. Each array must contain non-empty single-line entries; `tldr` has at most three entries and entries may not inject Markdown headings. Tandem adds a `# Validation` section from recorded runner evidence.

Publish only after reviewing the generated description and the approval details:

```sh
bun src/cli.ts pr publish TASK_ID OWNER/REPO "Title" main \
  '{"tldr":["Short result"],"what":["The observable change"],"why":["The user-facing reason"]}' \
  --yes
```

The publish path verifies the task is ready, the worktree is clean, the branch and repository identity match the task, validation evidence is non-empty and successful, all four current review lenses exist, and the current worktree HEAD is exactly the reviewed HEAD. It pushes that exact reviewed SHA to the task branch. Existing pull requests are re-observed and must match the same repository, base, branch, and SHA; closed or merged duplicates are refused.

Merge is a separate explicit action:

```sh
bun src/cli.ts pr merge TASK_ID squash --yes
# or: bun src/cli.ts merge TASK_ID --method squash --yes
```

The CLI defaults to `squash` only when no method is supplied; specify the method explicitly for clarity. Before invoking `gh pr merge`, Tandem re-observes the PR and requires the same task/repository/base/branch, an open non-draft state, a non-empty set of required CI checks, and every required check passing. It rechecks the local reviewed HEAD, invokes GitHub CLI with the exact reviewed SHA as `--match-head-commit`, and re-observes the result. The task becomes `merged` only when the remote PR reports `merged` with the same SHA. Tandem never merges automatically.

## Presentations and Lavish

Use presentation only when a useful visual artifact will improve understanding:

```sh
bun src/cli.ts present TASK_ID "Show the approved workflow" \
  --artifact /absolute/path/to/reference.png
bun src/cli.ts presentations
bun src/cli.ts feedback PRESENTATION_ID
```

The controller creates a fresh private artifact directory outside the source repository, reads installed `lavish-axi --help`, selects matching playbooks, and requests fallback design guidance when the subject project has no detected design direction and the objective has no explicit one. The presentation worker receives a bounded brief and writes complete HTML only to the supplied artifact path. It must return exactly one `Artifact: <absolute path>` line and cannot open or poll Lavish.

The controller verifies the artifact before opening it with Lavish. Each open presentation gets one supervised continuous native feedback listener with no client timeout; the listener is tracked, serialized with completion and notification persistence, and aborted and awaited during shutdown. The public `feedback` action remains a bounded, cancellable check and can explicitly check a browser-disconnected presentation. Automatic listening resumes after that check returns an open, non-disconnected observation. Ready/opened and ordinary ended observations are persisted as routine UI bookkeeping; each feedback event is stored as full private evidence under the presentation directory and delivered through the owning task's bounded notification path, while poll failures and `browser_disconnected` decisions are also persisted and delivered there. A `browser_disconnected` observation leaves an otherwise-open presentation recoverable without automatic reopen, while `user-ended` is never reopened and its final feedback is drained once. Presentation feedback is an observation, never an approval for implementation or delivery.

## Recovery, durable state, and compaction

The durable home comes from the remembered setup, falling back to `~/.tandem`; `--home PATH` or
`TANDEM_HOME` explicitly selects another local namespace. Global model preferences, repository policy records, and all other paths below
are Tandem-owned state, not files in target repositories:

| Path | Contents |
| --- | --- |
| `<home>/models.json` | Strict global model preference envelope for all six roles; approved updates atomically replace it with mode `0600`. |
| `<home>/repositories/<key>/config.json` | Private central policy envelope for the canonical repository root; `<key>` is the first 24 hex characters of its SHA-256 realpath digest. |
| `<home>/coordinator-registry/<session-digest>/<repo-digest>.json` | Private coordinator ownership record: original project identity, clean source lease, native endpoint, and expected OMP command. Live ownership is rechecked before reconnect. Launch discovers these across every session directory, so one repository keeps one active coordinator. |
| `<home>/coordinator-registry/repository-<digest>.lock` | Native `O_EXLOCK` coordination lock for one canonical repository, shared by every session in this home and acquired before the per-session launch lock. |
| `<home>/coordinator-scripts/*.sh` | Atomically written `0700` launch scripts containing the coordinator command and scoped environment overrides; kept outside project checkouts. |
| `<home>/state.sqlite` | Canonical SQLite source of truth for task records, policy snapshots, lifecycle/evidence/review/delivery metadata, cleanup notes, runtime reservations, endpoint identities, durable jobs and operations, stop requests, presentations, and migration metadata. |
| `<home>/communications/<safe-task-id>/inbox.json` | Derived bounded task-message projection; canonical communication remains in the task row in `state.sqlite`. |
| `<home>/tasks/*.json` (legacy input only) | Pre-migration task snapshots. A successful migration archives the original bytes under `<home>/.tandem-migration/archive/tasks/` and replaces `<home>/tasks` with an old-writer fence file. |
| `<home>/runtime.json` (legacy input only) | Pre-migration runtime snapshot. A successful migration archives the original bytes under `<home>/.tandem-migration/archive/runtime.json` and replaces `<home>/runtime.json` with an old-writer fence directory. |
| `<home>/jobs/<task-id>/...` | Worker/validation job inputs, private result files, persisted reports, `job.json.terminal.json` lifecycle/heartbeat state, and short-lived `job.json.terminal.json.command` pause/close requests. |
| `<home>/sessions/<task-id>/` | Implementer OMP session directories when continuation is needed. Scouts do not receive a session directory. |
| `<home>/presentations/<presentation-id>/` | Private presentation job, result, artifact, interactive terminal state/control, and `feedback/<event-id>.json` evidence files. |
| `<home>/pool/` | Default Treehouse pool root unless overridden. |

### Legacy JSON migration (offline only)

`state.sqlite` is the only canonical task/runtime store. `<home>/runtime.json` and
`<home>/tasks/*.json` are legacy migration inputs, not a second authority. A home that
contains legacy JSON is refused by normal SQLite startup until migration completes.
Migration is an explicit offline cutover; do not use it while any Tandem coordinator,
worker, validation job, presentation, or legacy writer may be running.

Use the same home that the coordinator uses (`--home PATH`, then `TANDEM_HOME`, then the
remembered setup, otherwise `~/.tandem`) and follow this sequence:

1. Stop all Tandem/Herdr activity for that home. Resolve every live or ambiguous
   coordinator, active worker or validation job, and unresolved endpoint launch before
   continuing. Do not treat a missing process observation as proof when native ownership
   is ambiguous; incomplete reservation intents are reported for quarantine instead.
2. Run the read-only plan. Omitting `--yes` is important:

   ```sh
   tandem migrate-state --home /absolute/path/to/tandem-home --json
   ```

   The plan hashes regular legacy source files, reports source/task counts and
   diagnostics, and lists incomplete reservation intents that will be quarantined
   without guessing or resuming them. `blocked` means stop and resolve the reported
   liveness/ownership condition; never bypass it.

3. When the plan is `ready`, apply it with the same home:

   ```sh
   tandem migrate-state --home /absolute/path/to/tandem-home --yes --json
   ```

   The apply path rechecks native authority after acquiring the home fence lock and
   refuses if ownership changed. It validates source hashes, archives any present legacy
   source at `<home>/.tandem-migration/archive/runtime.json` and
   `<home>/.tandem-migration/archive/tasks/`, imports them into `state.sqlite`, writes
   `<home>/.tandem-migration/manifest.json`, and installs
   `<home>/.tandem-migration/fence.json`. The former `<home>/runtime.json` becomes a
   read-only fence directory; the former `<home>/tasks` becomes a read-only fence file.
   The archive and manifest preserve source identity for replay.
4. If apply is interrupted, rerun the exact same `--yes` command. The manifest/archive
   phases make the import resumable and idempotent; do not edit, delete, or recreate
   legacy sources, the archive, or the fences. Re-run the plan command and proceed with
   normal launch only when it reports `complete`.

Planning and apply fail closed on malformed or unknown legacy fields, symlinked or
non-regular sources, changed source hashes, an invalid migration manifest, a non-empty
SQLite task/runtime store, or any unproven native ownership. Do not repair around a
diagnostic by deleting records or replacing a source; preserve the bytes and rerun the
read-only plan after the prerequisite is resolved.

Import preserves task IDs, generations, fix-round and policy state, saved checkpoints,
evidence, and operation history. Incomplete legacy reservation intents remain recorded
and are quarantined by reconciliation; migration never invents an operation or resumes
an uncertain launch. Migration is not recovery and does not resume tasks, clear
reservations, release retained capacity/resources, reset a checkpoint, change policy, or
unblock a maxed fix-round policy.

After cutover, recovery accepts only positive native identity or durable result evidence.
An unknown external-effect outcome is quarantined and keeps its reservation, capacity,
and resources. A worker launch is at-most-once: a duplicate claim or a stale
task/generation/operation/fencing identity is refused. Never clear a reservation,
invent a job or result, replace a task, or change policy to bypass unknown ownership.

### Durable operation and recovery contract

Before a reservation or any external resource/effect, the runtime records a durable
operation containing the role, task generation, input checkpoint (`inputHead`), policy
and instruction identity, job and result paths, operation ID, claim owner, and fencing
revision. The home-native fence lock (`<home>/.state.lock`) protects state ownership and
external-effect decisions; each SQLite transition is short and commits the
operation/reservation/effect intent before the corresponding external action. A later
execution claim must match the operation, task, generation, job, input checkpoint, claim
owner, fencing revision, paths, and active stop state. The first committed worker claim
wins; duplicate or stale claims are refused, so an uncertain launch is never retried
merely because a process or result is missing.

On restart, positive native endpoint identity or a task/generation/HEAD-matching durable
result may allow reconciliation to continue. Missing, conflicting, or ambiguous
identity/result evidence quarantines the operation and retains its reservation and
resources for inspection. Quarantine is not failure cleanup and does not release
capacity. Only an explicit, evidence-backed transition may consume a result or release
resources; recovery must not clear records, manufacture receipts, replace a task, or
change saved policy/checkpoints.

These controls do not make external effects transactional or guarantee availability; they
make uncertain ownership fail closed and preserve evidence for an explicit decision.

The central record's validated `repoPath` may be reused as an already-known project index when
resolving a requested name. It does not authorize a home crawl, a first-basename guess, cloning,
or checkout creation. Configured homes are namespace boundaries: the same repository root has a
different record under a different home.

`onboard`, `models`, and `doctor` do not create central directories or records. An approved default
setup creates only the missing central file, exclusively; `configure-models` writes only after explicit
approval and atomically replaces the global model envelope. Existing, malformed, mismatched, or
symlinked policy state is retained and reported rather than overwritten. New central directories use
`0700` and policy files use exclusive creation with `0600`. Canonical task/runtime writes go
through short SQLite transactions under the Darwin native home fence lock
(`<home>/.state.lock`); sidecar JSON is evidence, projection, or job input rather than a
second authority. Do not hand-edit `state.sqlite` or durable sidecars while Tandem is running.

On restart, use the same home, repository, pool root, and named session. The scheduler reconciles
durable operation and endpoint-launch intent, Herdr identities, jobs, result files, reservations,
and stop requests. It identifies a recoverable endpoint only by exact workspace label/root-pane/cwd
identity and accepts worker output only when task, generation, job, and input HEAD identities match.
Positive native identity or matching durable result evidence may continue recovery; missing,
conflicting, or ambiguous evidence quarantines the operation and retains its reservation/resources
rather than guessing. A failure preserves reports and worktree state.

### First-class bounded recovery actions

The advanced CLI exposes the durable recovery workflow without editing SQLite or inspecting
model output:

```sh
tandem inspect TASK_ID --json
tandem recovery-plan TASK_ID --json
tandem reconcile TASK_ID --yes --json
tandem review-existing TASK_ID --head REVIEWED_HEAD --yes --json
tandem validation-retry TASK_ID --yes --json
tandem evidence-repair TASK_ID --yes --json
tandem delivery-preflight TASK_ID OWNER/REPOSITORY BASE --json
```

`inspect` reports stage, generation, review round, separate recovery budgets, exact reviewed and
current HEADs, clean/unmerged state, canonical repository identity, branch, preserved worktree and
lease, endpoint ownership/liveness, durable jobs and result files, reports/provenance, reservations,
operations, pull-request metadata, and recommended actions. `recovery-plan` is a read-only dry run;
it reports checkpoint safety, stale resources, the selected bounded operation, remaining budgets, and
refusal reasons.

`reconcile` requires `--yes` and is idempotent. It clears only proven missing/stopped owned panes,
quarantines jobs whose pane disappeared, and releases a reservation only after operation and jobs
are terminal. It never releases a reservation or closes a foreign/unknown pane, never reuses a
worktree for a new task, and always reports the worktree as preserved. Repeated reconciliation is a
no-op after the proven state is recorded.

`review-existing` requires the exact durable reviewed HEAD, a canonical repository identity, and a
clean unmerged worktree. It records `review_existing_head` provenance, runs validation, and launches
all required read-only review lenses without an implementer or code-fix budget. An empty diff is
explicitly a full-implementation review subject, not proof that no implementation exists.
`validation-retry` is runner-owned, worker-free, bounded separately from code-fix rounds, and
classifies infrastructure, validation-configuration, and task-code failures. `evidence-repair`
reconstructs only reports/provenance proven by durable task/generation/HEAD-matching records; stale
reports are refused.

### Reconciling Tandem resources across sessions

`tandem reconcile-resources [--home PATH] [--yes] [--discard] [--json]` is the front door's
home-wide cleanup surface, and the supported alternative to deleting coordinator records, panes,
or lock files by hand. It is distinct from the advanced CLI's per-task `tandem reconcile TASK_ID`,
which repairs one task's durable runtime.

It runs in two stages. The scan reads every coordinator record across every session directory under
the home, asks Herdr whether each recorded coordinator still answers, reads the checkout behind a
record no live coordinator answers for, lists each Treehouse pool's leases, lists terminal task
resources whose cleanup never settled, and lists the durable quarantine notes and unreadable record
files already present. The scan issues read-only commands only. The plan is then a pure function of
those observations, so nothing is classified from a resource Tandem changed on the way.

Classification:

- a live owned coordinator, and its pane and lease, are retained and named with their session;
- a stopped owned coordinator is cleaned: its workspace is retired through the same proof-then-close
  owner a replacement launch uses, then its exact lease is released and its record removed;
- an orphaned coordinator lease, held under the coordinator lease-holder identity with no record
  naming it, is released by exact lease id, holder, and path when its checkout is clean;
- a dirty, unmerged, unlanded, foreign, or ownership-uncertain worktree is retained and reported
  with the reason; non-coordinator leases are released only through their durable task cleanup
  owner, never by pool path;
- terminal implementation tasks and completed or safely cancelled scout resources are finished
  through the durable task cleanup owner, which keeps the report, provenance, and task history;
- `--yes --discard` is the explicit destructive path for cancelled or blocked implementation
  tasks. It stops and closes their owned endpoints, revalidates exact Treehouse lease identity,
  and force-returns only those task leases; it does not discard scouts, live tasks, or changed
  ownership;
- a record Tandem cannot place or prove, such as one stored under a session directory it does not
  name, is quarantined with a durable note and nothing is closed or released;
- existing quarantine notes and unreadable record files are listed with their path and reason, and
  are never deleted.

Without `--yes` the command changes nothing and reports what it would clean. `--discard` is valid
only with `--yes`. Applying coordinator and pool-lease items takes the shared repository lock for
each repository first, then that session's launch lock, so a concurrent launch cannot allocate
underneath them; task cleanup runs through its durable state-and-lease owner. A dry run takes no
lock and never disturbs a live coordinator. A `clean` plan item is a prediction: applying re-reads
the resource and hands it back to its owner, which may still retain or quarantine it. Applying
twice plans nothing to clean the second time, and a quarantine note is written once per lease rather
than on every run. `--json` prints a versioned report (`schemaVersion`, `mode`, `home`, `cleaned`,
`retained`, `quarantined`, `failed`) whose entries carry the resource kind, id, repository, session,
path, and reason. The exit code is non-zero only when the scan or an apply failed, never because a
resource was deliberately retained.

`delivery-preflight` must pass before approved publication. It checks the exact reviewed HEAD,
clean/unmerged state, generated database types, formatting, lint/pre-push checks, diff whitespace,
branch and remote identity, and duplicate pull-request metadata. Publication never bypasses a
failed preflight or publishes an unreviewed changed HEAD; merge and deploy remain human-approved.

Task communication is canonical in the task row in `state.sqlite` and published as a small
derived inbox under `<home>/communications/<safe-task-id>/inbox.json`. The service persists
canonical state before publishing the projection and reconciles a stale or missing inbox after a
crash. Worker receipts are identity-bound to task, job, generation, and operation; an applied
receipt means provider-bound context, not implementation completion. Pending directions survive
restart unless the service explicitly rejects them for a terminal resource or safety state.

OMP-native compaction and the durable store work together:

- before an agent turn, the extension appends coordinator instructions, tool guidance, and a digest of authoritative durable tasks;
- during `session.compacting`, it refreshes that context and preserves `tandemDigest`;
- after `session_compact`, it reconciles the scheduler and appends a fresh `tandem-digest` entry.

The aggregate durable digest is bounded to 8,000 characters and may omit older task detail;
`state.sqlite` and durable reports/evidence remain authoritative. Model-facing action summaries
are bounded separately, while `show --full` retains more structured detail.

An undefined worker timeout means no default deadline for the delegated turn. An explicit positive
worker limit is enforced by the interactive extension: it aborts the delegated turn and records
failure after the active turn settles, while leaving the terminal available for read-only follow-up.
The limit ends with the delegated result and does not time out later human conversation.
Validation-command timeouts and cancellation remain enforced. Passive progress warnings are
inspection events, not automatic kills.

Ordinary non-presentation worker briefs fail closed above 64 KiB (65,536 bytes) of UTF-8. The error identifies the limit and asks for the objective, acceptance criteria, instructions, or artifact references to be shortened; Tandem does not silently truncate an ordinary brief. Presentation keeps its tighter existing 32,000-character prompt bound and its own per-field/list limits.

## Advanced low-level CLI reference

The CLI help returned by `bun src/cli.ts --help` is:

```text
Tandem coordinator

Usage: bun src/cli.ts [command] [options]

Commands:
  launch       Launch the OMP coordinator in the owned Herdr context
  models       List available OMP models and saved global role choices
  configure-models  Validate and save global role choices (requires --input FILE --yes)
  doctor       Check model, Herdr, policy, and coordinator files without mutating
  setup        Propose or write Tandem-owned per-repository policy (requires --yes to write)
  onboard      Inspect Tandem-owned policy and validation surfaces
  create       Create a scout or implementation task
  list/status   List durable tasks
  show         Show one durable task
  messages     Inspect steer/answer delivery and blocker questions
  steer        Queue a concise user direction for a task
  answer       Answer the task's current needs-decision question
  approve      Approve implementation scope (requires --yes)
  tick/watch  Advance bounded scheduler work
  pause/resume/cancel  Control owned task work
  present/feedback/presentations  Route and inspect visual work
  pr describe/draft/publish/merge  Record, show progress on, or publish PR work
  cleanup      Release owned resources; --discard requires --yes

Safety options:
  --yes        Explicit human automation consent for approval-bearing commands
  --json       Emit one JSON result for automation
  --headless   Use a named headless Herdr server
  --no-attach  Do not launch a GUI; use headless Herdr
```

All parser-supported options are global; use only the ones relevant to the command. Value options accept `--name value` and `--name=value` forms.

### Boolean options

`--help`, `--json`, `--yes`, `--write`, `--discard`, `--continue`, `--headless`, and `--no-attach`.

### Value and repeatable options

| Option | Accepted value |
| --- | --- |
| `--home PATH` | Explicit Tandem durable home for task state, model preferences, and repository policy; bypasses the remembered setup. Otherwise `TANDEM_HOME`, the remembered setup, then `~/.tandem`. |
| `--session ID` | Named Herdr/OMP session. |
| `--parent-workspace ID`, `--parent ID` | Parent Herdr workspace. |
| `--pool-root PATH` | Treehouse pool root. |
| `--repo PATH` | Original subject repository identity; otherwise current directory. Launch derives the clean coordinator checkout separately. |
| `--model PROVIDER/MODEL` | Coordinator model pin; a different policy value is rejected. |
| `--thinking LEVEL` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `auto`; a different policy value is rejected. |
| `--extension PATH` | Launch option only; must be Tandem's checked-in extension. |
| `--config PATH` | Launch option only; must be Tandem's checked-in fallback-disabled config. |
| `--interval-ms POSITIVE_INT` | Watch delay; default 2,000 ms. |
| `--iterations POSITIVE_INT` | Finite watch count; omitted means continue. |
| `--kind scout\|implementation` | Create task kind; default `implementation`. |
| `--objective TEXT` | Create/presentation objective. |
| `--task ID`, `--task-id ID` | Task identifier. |
| `--text TEXT` | Direction or answer text for `steer`/`answer`; bounded by the communication contract. |
| `--question ID` | Current needs-decision question identifier for `answer`. |
| `--supersedes ID` | Repeatable obsolete-message identifier for `steer`; CLI-only convenience. |
| `--presentation ID`, `--presentation-id ID` | Presentation identifier. |
| `--reason TEXT` | Pause/cancel reason. |
| `--repository OWNER/REPO` | GitHub repository for publish. |
| `--title TEXT` | Pull-request title. |
| `--base BRANCH` | Pull-request base branch. |
| `--summary JSON` | PR summary object. |
| `--method merge\|squash\|rebase` | Merge method. |
| `--input JSON\|FILE` | Create-task object with exactly `repoPath`, `kind`, `objective`, `acceptanceCriteria`, and `surfaces`; configure-models reads a temporary file containing the complete six-role `{ "model", "thinking" }` map. |
| `--acceptance TEXT` | Repeatable create acceptance criterion. |
| `--surface TEXT` | Repeatable create surface. |
| `--artifact PATH` | Repeatable presentation artifact path. |

Command aliases are `status` for `list`, top-level `describe`/`draft`/`publish`/`merge`, and nested `pr describe`, `pr draft`, `pr publish`, and `pr merge`. The CLI accepts options without executing or mutating anything while parsing; execution and approval checks happen afterward.

Communication output is intentionally split: without `--json`, `steer`, `answer`, and `messages`
print a compact plain-language summary; with `--json`, the CLI emits the raw structured value
directly (there is no `.value` wrapper). Use the structured view for revisions, IDs, receipts,
question metadata, activity timestamps, and full message text.

## Local limits and source of truth

Tandem's orchestration, durable state, worker processes, Herdr workspaces, Treehouse pool, and Lavish control are local to the machine running the coordinator. It does not create remote fleets, alternate terminal/harness backends, social relays, or hosted Tandem state. GitHub PR publish/merge necessarily use the configured remote through the local `gh` and Git commands when explicitly requested.

The repository lock is a Darwin native `O_EXLOCK` lock at the task-store directory, with a five-second default acquisition timeout. Coordinator launches use the same native primitive for their own locks under `<home>/coordinator-registry/`: one per canonical repository, acquired before the per-session launch lock. Lock corruption, lock replacement, filesystem failures, ambiguous external identities, and unknown disk capacity fail closed rather than weakening the safety proof. The lock and durable state are local filesystem primitives; they are not a distributed lock for multiple machines or network filesystems.

The authoritative implementation contracts live in `src/contracts.ts`, with configuration and policy in `src/config/`, lifecycle rules in `src/tasks/lifecycle.ts`, native adapters in `src/adapters/`, service composition in `src/service/controller.ts`, and OMP integration in `src/extension.ts`, `src/extension/`, and `src/instructions.ts`. See [AGENTS.md](../AGENTS.md#source-layout) for the domain directory map and placement rules. This reference describes those current contracts and does not claim that an external Herdr, OMP provider, GitHub, or Lavish scenario has been run in every environment.
