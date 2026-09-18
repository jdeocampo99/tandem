---
name: tandem-onboard
description: >-
  Guide a user through safe, conversational onboarding of one or more Git repositories into
  Tandem. Trigger when the user asks to onboard a repository or invokes /skill:tandem-onboard.
user-invocable: true
---

# tandem-onboard

Use this as a concise capability reference. Onboarding is read-only; approved global model and project
setting writes and a later launch are separate actions.

## 1. Resolve Tandem without guessing

The installed `tandem` command is the primary terminal front door. From the Tandem checkout, run
`bun install` and `bun link` once; then normal onboarding and launch use `tandem [PATH ...]`.
A bare `tandem` opens or reconnects every valid saved project under the selected Tandem home from
any directory, before consulting the current working directory, without a project picker or path
entry when saved records exist, including in non-TTY or `--headless`/`--no-attach` launches. Explicit
paths override the registry and open only the supplied subset or add/open projects. If the registry is
empty, current-Git first-run onboarding and the outside-Git interactive project-path fallback remain.
Multiple paths share one Herdr session but keep separate project coordinators and child-worker groups.

For a deliberate clean reopen, use `tandem --reset` from a separate normal terminal. No paths
select all valid saved projects; explicit paths select only that subset. Reset stops only idle
Tandem-owned coordinators after a fail-closed preflight, then normal-launches them and attaches once.
Busy or unsafe work refuses before any pane closes. It preserves settings, history, task records,
worktrees, and files; it is not task recovery or data wiping. Add `--continue` only to resume saved
conversations, and never invoke reset from inside Herdr.
Reset also closes recorded coordinator shells after verifying native identity and worktree. Empty
workspaces disappear when their last pane closes; extra panes and custom labels remain. Generated
old coordinator labels are retired so retained terminals do not look like current coordinators.
For deliberate cancellation during testing, add `--force`: `tandem --reset --force [PATH ...]`.
This stops selected active owned work and cancels its tasks before reopening coordinators, while
preserving files and worktrees. It does not bypass ownership or coordinator source-safety checks.

This conversational skill is optional. For exact structured discovery or automation, resolve a
validated `TANDEM_ROOT` independently of every target repository and use the advanced
`bun "<TANDEM_ROOT>/src/cli.ts"` entry point. If neither the installed command nor a validated
checkout is available, use an explicitly supplied installation location; never hardcode a
machine-specific path, fall back to `Coding_Projects` or another project-folder convention, or
guess a different checkout. Use absolute paths thereafter and do not run package scripts while
locating the checkout.

## 2. Use the advanced CLI for exact discovery, model setup, approval, and readiness

Resolve Tandem's local home separately: `--home` wins, then `TANDEM_HOME`, then `~/.tandem`.
Use the same home for each command. It owns model preferences, policy records, and durable state;
target repositories are not written and need not check Tandem configuration into Git. Keep `configPath`,
and the exact proposal in structured state; expose them only on request or when needed to resolve
project ambiguity. For the project-setting step, after any required first-time model choice, ask only when
`existingConfig` is false:

> Save Tandem settings for `<project>`? These settings are saved on this computer, outside the project. They do not change the app or start work.
>
> Choose **Save settings** or **Not now**.

Keep default worker/fix limits, script identifiers, hash paths, raw commands, and JSON in structured
details; share them only on request or when the user must choose meaningful custom settings. Capture
each JSON result and project `repoPath`, `modelSettings`, `configPath`, `existingConfig`,
`validationCommands`, and `unresolved` before presenting or acting; retain full details without
dumping raw payloads, repeating discovery, or hiding CLI failures.

For normal user-facing onboarding and launch, prefer `tandem [PATH ...]`: bare `tandem` opens or
reconnects every valid saved project under the selected home, while explicit `PATH ...` values
override the registry for a subset or add/open flow. Use `tandem configure [PATH]` for the explicit
six-role global model flow; `configure` remains a single-project catalogue anchor and never selects
all saved projects. The commands below are the advanced low-level path when exact JSON proposals,
diagnostics, or automation are required.

```sh
set -o pipefail
bun "<tandem-root>/src/cli.ts" --help
bun "<tandem-root>/src/cli.ts" onboard --repo "<canonical-repo>" --home "<home>" --json |
  jq '{
    repoPath,
    existingConfig,
    modelSettings,
    configPath,
    validationCommands,
    unresolved
  }'
bun "<tandem-root>/src/cli.ts" models --repo "<canonical-repo>" --home "<home>" --json |
  jq '{
    modelSettings,
    availableModels: ((.availableModels // []) | map({
      selector, id, provider, thinking, name, reasoning, contextWindow, cost
    }))
  }'
bun "<tandem-root>/src/cli.ts" configure-models --repo "<canonical-repo>" --home "<home>" --input "<selection-file-outside-project>" --yes
bun "<tandem-root>/src/cli.ts" setup --repo "<canonical-repo>" --home "<home>" --yes
bun "<tandem-root>/src/cli.ts" doctor --repo "<canonical-repo>" --home "<home>"
bun "<tandem-root>/src/cli.ts" launch --repo "<canonical-repo>" --home "<home>"
```

`onboard` discovers package validation surfaces and returns `modelSettings` without writing. The
model-selection conversation is explicit and role-by-role:

- Use these human labels and identities: **Planning** (`coordinator`), **Research** (`scout`),
  **Coding** (`implementer`), **Review** (`reviewer`), **Final checks** (`verifier`), and
  **Presentations** (`presentation`).
- If `modelSettings.configured` is false, run `models` once and use only its catalogue. For each
  role, show the suggested exact catalogue `selector` and the thinking levels that selector supports.
  Ask for an explicit selector and supported thinking level for every role. Offer **Not now** as an
  explicit pause: it ends onboarding without `configure-models`, `setup`, or `launch` and never
  falls through to built-in defaults. One reply may contain all six answers, but never infer omitted
  roles, combine roles, or treat a general recommendation approval as consent; accepting a suggestion
  must be explicit for that role.
- If saved choices exist, show all six current exact catalogue selectors and thinking levels on every
  onboarding, then offer **Keep all**, **Change roles**, or **Not now**. **Keep all** only reuses the
  displayed choices, requires no new role answers, and is read-only: do not call `configure-models`;
  it may continue the existing project-setting approval flow. **Not now** pauses onboarding, leaves
  the choices unchanged, and does not run `configure-models`, `setup`, or `launch` or fall through to
  built-in defaults. **Change roles** reruns `models` and asks for an explicit selector and supported
  thinking level for each role; the user may explicitly keep current values for untouched roles. Show
  all six, including untouched roles, in a complete recap before saving.
- Explain recommendations briefly and that approved choices apply to future work across projects and
  do not start work. Recommendations are suggestions only; never invent model names, promise pricing
  or latency, parse private config, or silently substitute. Empty or failed discovery stays visible
  and requires asking, not fallback.

Only after explicit approval of the complete six-role recap (never after **Not now**) save the
global choices once. In the normal terminal flow use `tandem configure <canonical-repo>`; in the
advanced low-level path use `configure-models` with a temporary selection JSON outside the target
project and remove it afterward. If `existingConfig` is true, preserve the existing project
settings and skip `setup`; a first-time global model choice may still be needed. Otherwise,
continue with normal project setup, then separately request `tandem <canonical-repo>` to launch that
explicit project.

An explicit `tandem <canonical-repo>` opens or reconnects only that project after ownership checks.
When saved records exist, a bare `tandem` instead opens or reconnects every valid saved project under
the selected home; it does not use arbitrary disk discovery or auto-registration. Add `--continue`
only when starting a stopped coordinator and resuming its saved conversation. An active coordinator
remains pinned to its clean source even when the original HEAD advances; stop and relaunch to refresh.
Stop any old pre-registry coordinator once before relaunching; Tandem never adopts it and never
migrates existing tasks automatically. Changing the main conversation model takes effect on the next
launch, not as a hot swap of an already-running OMP conversation.

## 3. Resolve explicit paths and saved registry records without guessing

For explicit paths, expand `~`, resolve relative paths against the current workspace, and obtain
the canonical Git top-level root. For a bare launch, use only valid canonical `repoPath` values from
saved central registrations under `<home>/repositories/*/config.json`; these are saved projects, not
arbitrary disk repositories. For names, consider supplied paths, workspace roots and additional
directories, workspace configuration, known project indexes, and known central registrations.
Do not crawl the home directory, clone, auto-register, or use Tandem's installation as a project
registry. The first basename match is not proof; ask when no confident root or multiple plausible
roots remain.

Verify real Git-backed directories, represent nested paths and symlink aliases by canonical root,
and deduplicate aliases. Keep central policy records and task identities keyed to the original
canonical root. When a launch supplies `TANDEM_SOURCE_REPO`, read package metadata, root guidance,
and repository-relative `instructionFiles` from that clean committed checkout instead; never silently
read dirty guidance from the original checkout. Approval for one canonical root never applies to
another.
