---
name: tandem
description: >-
  Explain how to use Tandem in plain language, including the difference between a normal agent
  conversation and a separately requested managed coordinator. Trigger for how-to questions or
  /skill:tandem.
user-invocable: true
---

# tandem

Use this as a short, conversational guide. Explain first; a how-to question is not approval to
inspect a repository, find an installation, onboard, launch, edit, test, publish, or merge.

## What Tandem is

Tandem helps you get coding work done with AI. You describe what you want and approve the plan;
Tandem organizes the coding, testing, and review. It remembers what’s finished, what’s still in
progress, and what needs your input, so you can return later without starting over.

An ordinary agent session is just the current conversation. It can explain or research when
asked, but it does not become Tandem because someone mentioned it. A managed coordinator is a
separate Tandem launch that the user has specifically requested.

The installed `tandem` command is the primary terminal front door. A bare invocation opens or
reconnects every valid saved project under the selected Tandem home from any directory; explicit
paths override that registry and open only the supplied subset or add/open projects. All projects in
one invocation share one Herdr session, while each gets its own coordinator conversation, clean
Treehouse source worktree, and child-worker group. Tandem keeps settings and progress in a local
home (the remembered setup, an explicit override, or `~/.tandem`), not in the project itself. The original
checkout may be dirty and remains untouched: source reads and delegated execution use each project's
clean committed snapshot, while task records and delivery retain the original project identity.

## Terminal front door

From the Tandem checkout, run `bun install` and `bun link` once, then use:

```sh
tandem
tandem /absolute/path/to/repo
tandem /absolute/path/to/first-repo /absolute/path/to/second-repo
tandem --continue /absolute/path/to/repo
tandem configure /absolute/path/to/repo
tandem config /absolute/path/to/repo
tandem --reset
tandem --reset --force
```

With no path, Tandem opens or reconnects every valid saved project under the selected home before
consulting the current working directory. It uses only saved registry records, not arbitrary disk
repositories, and does not show a project picker or request a path when the registry is non-empty,
including in non-TTY or `--headless`/`--no-attach` launches. If the registry is empty, a Git cwd
retains current-Git first-run onboarding and outside Git retains the existing interactive
project-path fallback. Explicit paths override the registry and select only the supplied project
subset or add/open paths.
Multiple paths share one Herdr session but remain separate project scopes.
`configure` remains a single-project catalogue-anchor flow: its current-Git or interactive fallback
never expands to all saved projects. It saves explicit choices for all six global roles without
launching. `--headless` and `--no-attach` prepare coordinators without attaching a GUI.
Ordinary use needs only the repository path: CLI and agent integration reuse the optional
`$XDG_CONFIG_HOME/tandem/config.json` preference (default `~/.config/tandem/config.json`).
Explicit home, session, and pool flags or environment values remain advanced overrides; an explicit
home bypasses the remembered home/session pair, and the pool defaults to `<selected-home>/pool`.
Normal launches never overwrite the remembered setup.

Use `tandem --reset` from a separate normal terminal when you deliberately need a clean reopen of
Tandem coordinators. With no paths it selects every valid saved project; explicit paths select only
that subset. Reset stops only idle coordinators with exact Tandem ownership, refuses busy, foreign,
unknown, or unsafe work before closing any pane, and then runs the normal launch/one-attach flow.
It preserves settings, conversation history, task records, worktrees, and repository files: reset is
not migration, task recovery, a factory reset, or data wiping. Add `--continue` only to resume saved
conversations; otherwise the reopened coordinators start fresh. Never run reset from inside Herdr.

Recorded coordinator panes left at their verified terminal shell are also closed by reset. Herdr
removes empty workspaces after the last pane closes; extra panes stay open. Only generated old
coordinator labels are retired, not custom labels. Labels never authorize closing unrelated terminals.

For deliberate interruption during testing, use `tandem --reset --force [PATH ...]`. It cancels
selected active tasks, closes owned worker/validation/presentation terminals and busy coordinators,
then performs the normal relaunch. Without paths it affects all saved projects. Files, dirty task
worktrees, completed task history, and settings remain intact. Foreign or ambiguous ownership and
unsafe coordinator sources still refuse; this is not permission to wipe state or discard changes.

An explicit `tandem PATH` opens or reconnects only that project after ownership checks. A bare
`tandem` applies the same checks to every project in its launch set (all saved projects when the
registry is non-empty). Add `--continue` only when starting a stopped coordinator and resuming its
saved conversation. An active coordinator stays pinned to its clean source `HEAD` even if the
original project advances; stop and relaunch when a fresh source snapshot is wanted. If an old
pre-registry coordinator is detected, stop its Herdr pane/process once, confirm it exited, and
relaunch. Tandem never adopts or duplicates it and never migrates existing tasks automatically.
## Durable state and recovery

`<home>/state.sqlite` is the canonical task/runtime authority. Do not edit or resume legacy
`runtime.json` or `tasks/*.json`, and do not retry work when an external outcome is uncertain. Legacy
state requires an explicit offline two-step migration from a separate normal terminal:

```sh
tandem migrate-state --home "<home>"
tandem migrate-state --home "<home>" --yes
```

The first command is the read-only plan; only the second applies migration. Status and other
read-only planning never apply it. Migration archives and fences the original bytes while preserving
IDs, generations, fix-round/policy, and checkpoints/history; it refuses live or ambiguous ownership
and unsettled work. An unknown owned-operation outcome remains quarantined with capacity/resources
retained: never clear a reservation, replace a task, or change policy to bypass unknown ownership.
Reset is not migration or recovery; `tandem --reset --force [PATH ...]` cancels selected active tasks.

## The usual path

1. **Get oriented** — read-only onboarding checks the project and suggests settings. On first
   onboarding, Tandem presents all six roles—**Planning** (`coordinator`), **Research** (`scout`),
   **Coding** (`implementer`), **Review** (`reviewer`), **Final checks** (`verifier`), and
   **Presentations** (`presentation`)—with an exact catalogue model `selector` and supported
   thinking levels for each. Explicitly choose or accept a model-and-thinking pair for every role;
   recommendations never fill omitted roles, and a complete six-role recap appears before saving.
   **Not now** is an explicit pause: it performs no `configure-models`, project setup, or launch and
   never falls through to built-in defaults. When choices already exist, every onboarding shows all
   six saved exact selector/thinking pairs and offers **Keep all** (read-only, no new role answers;
   it may continue the existing project-setting flow), **Change roles** (explicitly choose or keep
   each role; untouched roles remain in the recap), or **Not now** (pause with choices unchanged,
   without setup or launch). The existing `configure-models` approval is required to save changes.
   Approved choices apply to future work across projects; use **Change roles** or say “Change Tandem
   models” to update them. A main-model change takes effect on the next Tandem launch, not in an
   already-running conversation. For an onboarding request, delegate to `tandem-onboard`; for a
   current-state request, delegate to `tandem-status`. Onboarding approval does not approve code
   changes or launch.
2. **Launch** — only after a separate request, acquire the clean committed coordinator snapshot and
   start the Tandem-managed coordinator; the original project path remains the durable identity for
   task creation and delivery.
3. **Agree on the work** — record what should change, how success will be recognized, and which
   part of the project is involved. Research may start automatically; coding waits for approval.

Delegated scouts have read-only repository tools plus native `web_search`: they prefer official or primary sources, use `read` for known URLs, cite sources, and separate verified facts from recommendations. Missing capabilities or tool failures must be reported explicitly rather than replaced with invented findings. Queued or blocked delegation is actionable state, not running or completed research; the coordinator discloses it and never silently takes over research without explicit user authorization. Task counts and statuses come from durable state, not receipts or process observations.
4. **Code, test, and review** — a worker makes the approved change, Tandem runs the configured
   checks, and a fresh reviewer examines the same change.
5. **Deliver deliberately** — publishing, merging, or destructive cleanup each needs its own
   explicit approval. Tandem never merges automatically.

## Continue an approved task

For a clear follow-up within the approved scope, tell the coordinator the concise delta; it can
forward it with `steer` without a redundant generic approval prompt. `steer` returns queued for
the next safe boundary, so the coordinator should batch independent directions in order and
explicitly supersede obsolete ones. Use `messages` only when you ask for a receipt or before a
dependent decision, never in a repeated model-driven polling loop. Queued/received/delivered are
not completion. If a worker asks a decision, the coordinator relays its `Question:` and optional
`Recommendation:`, sends your answer with the current question id, and checks the receipt when
needed.

Directions sent before initial approval remain visible at the approval boundary: confirmation shows
the current communication revision and every effective, non-superseded communication delta
(including answers that carry implementation direction), without replaying superseded messages or
full communication JSON.

Routine heartbeats, receipts, and passive progress are durable/UI activity, not model turns. A
PR-ready coordinator notice may wake the coordinator for delivery decisions, while elapsed time
alone does not kill a worker; explicit worker limits, cancellation, and existing approval/merge
safeguards still apply.

## Starter requests

- “How do I use Tandem?” — explain this path in plain language without looking at the filesystem.
- “Onboard `/path/to/repo`.” — use `tandem-onboard` (or `/skill:tandem-onboard`).
- “What is the current state of my Tandem tasks?” — use `tandem-status` (or
  `/skill:tandem-status`).
- “Launch Tandem for `/path/to/repo`.” — after the explicit request, use the installed
  `tandem /path/to/repo` command; the conversational flow is optional.

When execution is requested, use the installed `tandem` command (`tandem [PATH ...]`, or
`tandem configure [PATH]`). If it is unavailable, resolve a validated `TANDEM_ROOT` or the real
shipped skill path and ascend two levels (`../../`) to Tandem's root, then use
`bun "<TANDEM_ROOT>/src/cli.ts" --help` as the advanced low-level fallback. Do not resolve these
paths for explanation-only questions.
