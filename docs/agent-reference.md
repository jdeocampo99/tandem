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

1. **Research is automatic.** A scout can start after task creation without implementation approval.
2. **Implementation is approved scope.** The coordinator interviews for ambiguity and risk, records the concrete scope, and waits for explicit approval before dispatching an implementer.
3. **Validation is runner-owned.** Configured argv commands run against the exact task HEAD and produce durable evidence. A worker must not claim a command ran when the runner did not record it.
4. **Review is independent.** The implementer is stopped while a fresh read-only reviewer examines the same task worktree. Review results are tied to an exact HEAD and generation.
5. **Delivery is gated.** Publishing and merging are explicit approval-bearing actions. Tandem never merges automatically.
6. **Presentation uses a separate artifact directory.** A presentation worker writes HTML outside the repository. The controller, not the worker, opens Lavish and owns the supervised continuous feedback listener.

Prompts are workflow guidance, not a security boundary. Runtime checks, Herdr/Treehouse ownership, filesystem checks, and Git/GitHub preconditions guard workflow mutations. Tool allowlists do not provide an operating-system or filesystem sandbox.

### Worker capabilities

| Role | Workspace and tools | Responsibility |
| --- | --- | --- |
| Coordinator | OMP conversation; `read`, `grep`, `glob`, `ask`, `tandem` | Owns user communication, policy, lifecycle, approvals, and routing. It does not edit repository code or run shell commands. |
| Scout | Isolated Treehouse worktree and child Herdr workspace; `read`, `grep`, `glob` | Read-only research. Returns findings, evidence, affected paths, risks, and open questions; does not write a report file or run project-wide gates. |
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
```

The core workflow expects these executables to be installed and available on `PATH`:

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

Open a **fresh agent session** and ask:

> How do I use Tandem?

The global `tandem` skill gives the short path without inspecting your filesystem or taking
action. For an actual request, use natural language:

> Onboard `/path/to/repo`.
>
> What is the current state of my Tandem tasks?
>
> Launch Tandem for `/path/to/repo`.

These route to the three global skills:

- `tandem` explains the workflow and the boundary between an ordinary agent session and a
  Tandem-managed coordinator.
- `tandem-onboard` performs read-only repository onboarding, followed by separately approved
  setup and a separately requested launch.
- `tandem-status` gives a bounded summary of recorded durable state and distinguishes it from
  live worker/process confirmation.

A how-to question is explanatory, not consent to inspect, onboard, launch, edit, validate,
publish, or merge. If natural-language selection does not choose a skill, invoke the exact
fallbacks `/skill:tandem`, `/skill:tandem-onboard`, or `/skill:tandem-status`. Start a fresh
session after installing or updating skills.

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

The command above installs for OMP/agents. Set `INSTALL_CLAUDE=1` before the command to install
the same links under `.claude/skills` as well. If the checkout moves, the old links do not match;
remove only links you own, then rerun the command. A copied skill can use `TANDEM_ROOT` pointing
to the actual checkout. For the workflow and central-home rules, use the sections below; there is
no global `tandem` executable.

### Manual CLI fallback

From this checkout:

```sh
# Show the actual CLI help without starting a coordinator.
bun src/cli.ts --help

# Inspect the target repository and propose validation surfaces.
bun src/cli.ts onboard --repo /absolute/path/to/repository

# Inspect the local prerequisites without mutating the repository.
bun src/cli.ts doctor --repo /absolute/path/to/repository

# Launch the coordinator in a named Herdr session.
bun src/cli.ts launch --repo /absolute/path/to/repository --session tandem
```

The package script is equivalent to invoking the local CLI file; there is no `tandem` binary to install globally:

```sh
bun run start -- --help
bun run start -- launch --repo /absolute/path/to/repository
```

With no command, the CLI defaults to `launch`. Use the same `--home` and `--session` values when restarting so the durable state and named Herdr context are reused.

## Launching the coordinator

The CLI resolves the process boundary in this order. A command-line option wins over the corresponding environment variable; otherwise the default is used.

| Setting | Precedence and default |
| --- | --- |
| Durable home | `--home` → `TANDEM_HOME` → `~/.tandem` |
| Herdr/OMP session | `--session` → `TANDEM_SESSION` → `HERDR_SESSION` → `HERDR_SESSION_NAME` → `tandem` |
| Parent workspace | `--parent-workspace` or `--parent` → `TANDEM_PARENT_WORKSPACE` → `HERDR_WORKSPACE_ID` → unset |
| Treehouse pool root | `--pool-root` → `TANDEM_POOL_ROOT` → `<home>/pool` |
| Subject repository | `--repo` → `TANDEM_REPO` → current working directory |

`HERDR_PANE_ID` is also used by the CLI when reusing an existing Herdr context. Direct reuse is allowed only when `HERDR_ENV` is `1` or `true` and `HERDR_SESSION` (or `HERDR_SESSION_NAME`), `HERDR_WORKSPACE_ID`, and `HERDR_PANE_ID` are all present. A partial identity, an inactive `HERDR_ENV` with identity variables set, or a session-name mismatch fails closed rather than guessing which pane is active.

If there is no complete active context, `launch` starts the named Herdr session, waits for it to become ready, creates a labeled `Tandem coordinator` workspace, and runs OMP in its root pane. `--headless` starts `herdr --session <name> server`; `--no-attach` also selects server mode instead of launching a GUI. Resolved home, pool root, repository, session, and parent settings reach the actual OMP child in both direct and new-pane launches. Without an explicit parent, workers nest under the coordinator workspace.

Coordinator conversations live under `<home>/coordinator-sessions/<repo-hash>`. `--continue` resumes within that repository-scoped session directory; it does not select an unrelated conversation from OMP's global session history. Durable task state remains authoritative even when the conversation is new or compacted.

The coordinator uses Tandem's checked-in `src/extension.ts` and `src/worker-config.yml`. The CLI rejects alternate extension or config paths. The checked-in worker configuration disables model fallback, usage-aware fallback, context promotion, and prewalk, while enabling compaction. Before launch, the CLI validates the policy-pinned coordinator model with `omp models --json`; `--model` and `--thinking` cannot override a different pinned value.

`doctor` checks the regular checked-in extension and config files, the central repository policy
record, the pinned OMP model, and the named Herdr status. It does not write repository or task
state.

## Repository onboarding and central policy

### Inspect first, write once

Per-repository policy is Tandem-owned local state. Resolve the home independently from the
target repository: `--home` takes precedence over `TANDEM_HOME`, which takes precedence over
`~/.tandem`. A configured home is valid only when its central destination remains outside the
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
  `test`; `ci:local` has no fixed surface tag. Proposed commands use a 120,000 ms timeout.
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

On first onboarding, if `modelSettings.configured` is false, recommend from that catalogue: a strong
planning model, a cheaper/faster research model, and capable coding, review, and final-check choices
across all six roles. Present these as grouped human labels for planning, research, coding, review,
final checks, and presentations, with actual proposed model names and thinking values. Explain the
rationale briefly and let the user use, adjust, or decline. Empty or failed discovery stays visible;
never silently substitute. Explain that approved choices apply to future work across projects and do
not start work. After explicit approval, run `configure-models` once, then continue with normal project
setup and separately requested launch. Reuse saved choices for later projects; an explicit “change
Tandem models” request repeats this flow. No implicit configure occurs during read-only commands.

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
offer first-time selection before setup or launch. Saved choices are reused across projects; changing
them affects future resolutions and new tasks only, and never rewrites existing task policy snapshots.
Changing the main conversation model takes effect on the next Tandem launch; it never hot-swaps an
already-running OMP conversation.

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
        "timeoutMs": 120000
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
changing a guidance file later does not silently rewrite an existing task's instructions. The
default reader rejects absolute paths, Windows separators, traversal, missing configured files,
and symlinks that resolve outside the target repository. Root guidance files are optional;
configured instruction files are required.

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

A scout is created queued and scope-approved. An implementation is created in `awaiting-approval` with `scopeApproved: false`; creation does not approve it. Approve the recorded scope explicitly before dispatch:

```sh
bun src/cli.ts approve TASK_ID --yes
```

The durable stages are:

| Stage | Meaning |
| --- | --- |
| `awaiting-approval` | Implementation scope exists but has not been approved. |
| `queued` | Approved work is waiting for scheduler capacity. |
| `scouting` / `implementing` | A worker is active in its owned workspace. |
| `validating` | Implementation has produced a checkpoint and the runner is checking that exact HEAD. |
| `reviewing` | Validation succeeded; fresh reviewers are recording the required lenses. |
| `awaiting-fixes` | Validation or review found a failure; a bounded fix round may be started. |
| `ready` | Current validation and all required review lenses pass. |
| `paused` | Work is stopped with a resumable previous stage. |
| `blocked` | Work cannot safely proceed; a reason is durable and requires coordinator judgment. |
| `cancelled` / `completed` / `merged` | Terminal states. Scouts complete with a report; implementation reaches `merged` only after verified delivery. |

For implementation, each completion and fix cycle is bound to the current generation and HEAD. A fix cycle increments the generation, clears stale review/validation evidence, and returns to `implementing`. The default `maxFixRounds` is three; once exhausted, the task remains unresolved rather than looping indefinitely.

### Review and validation

Review is independent and sequential. Tandem stops or pauses the implementer, opens one fresh read-only reviewer pane in the same task worktree, and records one current result per lens:

- `behavior` — observable semantics, ordering, mutation timing, errors, and boundaries;
- `design` — function-review principles, honest dependencies, empathic signatures, abstraction levels, comments, and declaration order;
- `coverage` — changed behavior, affected callers, relevant tests/reports, and acceptance criteria;
- `verification` — fresh inspection of the exact HEAD and generation using runner evidence.

All four lenses are required. A failed lens sends the task to `awaiting-fixes`; passing all four sends it to `ready`. Reviewers remain read-only and do not invent command output.

Validation commands are argv-only and execute in declaration order. A command runs when its `surfaces` is empty, contains `*`, or intersects the task surfaces; a task surface of `*` matches every command. The runner stops after the first non-zero, timeout, or cancellation result. Every evidence record includes the command name, argv, exit code, captured stdout/stderr, and exact HEAD. No configured command or no matching command is a validation configuration failure, not a pass.

Child workers do not run project-wide tests, builds, formatters, linters, or other gates. The parent validation worker runs the configured commands and records evidence after implementation work is handed back. The implementer must report exactly one final `Outcome: implemented|needs-decision|failed` line and is expected to provide a commit checkpoint before `implemented`. For `Outcome: needs-decision`, emit one bounded single-line `Question: ...` and an optional bounded single-line `Recommendation: ...` (each no more than 1,000 characters); point to the report for full evidence instead of dumping logs or transcript text.

## Inspecting and controlling work

```sh
bun src/cli.ts list
bun src/cli.ts status
bun src/cli.ts show TASK_ID
bun src/cli.ts show TASK_ID --full
```

The summary is bounded for model-facing output; `--full` requests the larger structured view. A full task record includes the task identity and revision, repository, kind, objective, acceptance criteria and surfaces, stage, approval state, pinned policy, worktree and endpoint identities, generation and review round, reviewed HEAD, validation evidence, review results, report path, blocker, notifications, and pull-request metadata when present.

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

When a worker reports a current needs-decision question, relay its `Question:` and optional
`Recommendation:` to the user, then send the answer with the exact question identifier:

```sh
bun src/cli.ts answer --task TASK_ID --question QUESTION_ID \
  --text "Choose the compatibility-preserving option"
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
- `publish ... --yes` publishes a reviewed pull request;
- `merge ... --yes` merges a reviewed pull request;
- `cleanup TASK --discard --yes` permits destructive discard.

Safe cleanup does not require `--yes`. In the OMP extension, configure-models, setup, approve, cancel,
publish, merge, and discard cleanup require a live TUI confirmation; without an interactive UI those
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

The extension scheduler starts at session start with a 2,000 ms default interval and reconciles once immediately. It refreshes the durable digest before an agent turn, during OMP-native compaction, and after compaction. Routine notices, receipts, heartbeats, and passive progress are shown with `ctx.ui.notify` and appended to the durable UI log without a model turn. The newest actionable notices in one delivery batch are coalesced into at most one follow-up/model wake; routine backlog is excluded from that wake. Current blocked tasks, completed scout reports, and PR-ready coordinator notices are the judgment-needed cases. Progress is not death: after roughly five minutes without meaningful activity, or about 60 seconds without a startup heartbeat, Tandem emits one actionable inspection warning per inactivity episode and resets the episode when progress resumes; it does not kill a worker merely because time elapsed. Actual process exit or error still follows the existing failed/blocked path.

## Worktrees, cleanup, and disk pressure

Treehouse worktrees are acquired under the configured pool root and tied to the source/base HEAD, lease holder, lease ID, task branch, and task generation. Branches use the `tandem/<safe-task-name>` form. Runtime passes every owned task worktree as protected to pool maintenance.

### Safe automatic maintenance

Normal users do not need to tune a pool cap or approve routine safe cleanup. The scheduler maintains capacity when a queued task needs a worktree:

- only explicitly managed paths inside the physical managed root are candidates;
- Treehouse metadata must unambiguously say the copy is available, Git-backed, unleased, and has no process metadata;
- the path must be a distinct child worktree, not the primary repository, and physical identity must remain inside the managed root;
- Git safety must prove no dirty or untracked content, no ignored content, no unmerged paths, and a clean worktree HEAD that is an ancestor of the current primary HEAD;
- active or otherwise protected task paths are never pruned;
- ambiguous metadata, missing physical identity, failed safety checks, ignored files, dirty files, unmerged paths, and non-ancestor work are retained with warnings.

Safe terminal cleanup closes stopped owned endpoints and attempts a lease-checked Treehouse return for `cancelled`, `completed`, or `merged` tasks. It requires the child worker to be stopped, exact lease metadata, the expected task branch, a clean/unmerged-free checkout, and task HEAD ancestry. If proof fails, Tandem retains the worktree and records the problem instead of deleting it.

Pool housekeeping keeps the policy-derived idle set and removes only additional proven-disposable copies. This is safe pool maintenance, not an automatic destructive discard of user work. Explicit discard is the only path that bypasses the Git safety proof.

### Disk-pressure admission

The default minimum free-space threshold is 2 GiB (`2 * 1024 * 1024 * 1024` bytes). When free space is below the threshold, maintenance may remove retained warm idle copies one at a time and recheck capacity. If free space is unknown or remains insufficient, the queued task stays queued, its reservation is released, and a durable blocker/notification explains that capacity must be verified or disk space freed. The next scheduler pass can retry. There is no fixed six-worktree limit; `maxWorkers` and the disk threshold govern admission.

Safe cleanup does not require user approval. `--discard` is different: it requires `--yes` in the CLI or a live TUI confirmation in the extension, then uses Treehouse's force return. Do not use discard to resolve an ambiguous, dirty, ignored, or unmerged worktree unless the human explicitly accepts losing that work.

## Pull-request delivery

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

The default durable home is `~/.tandem`; `--home PATH` or `TANDEM_HOME` selects another local
Tandem-home namespace. Global model preferences, repository policy records, and all other paths below
are Tandem-owned state, not files in target repositories:

| Path | Contents |
| --- | --- |
| `<home>/models.json` | Strict global model preference envelope for all six roles; approved updates atomically replace it with mode `0600`. |
| `<home>/repositories/<key>/config.json` | Private central policy envelope for the canonical repository root; `<key>` is the first 24 hex characters of its SHA-256 realpath digest. |
| `<home>/tasks/<task-id>.json` | Versioned task record, policy snapshot, lifecycle state, evidence, reviews, notifications, and delivery metadata. |
| `<home>/communications/<safe-task-id>/inbox.json` | Derived bounded task-message projection; canonical communication remains in the task record. |
| `<home>/runtime.json` | Versioned runtime state for reservations, endpoint identities, durable jobs, stop requests, and presentations. |
| `<home>/jobs/<task-id>/...` | Worker/validation job inputs, result files, and persisted reports. |
| `<home>/sessions/<task-id>/` | Implementer OMP session directories when continuation is needed. Scouts do not receive a session directory. |
| `<home>/presentations/<presentation-id>/` | Private presentation job, result, artifact, and `feedback/<event-id>.json` evidence files. |
| `<home>/pool/` | Default Treehouse pool root unless overridden. |

The central record's validated `repoPath` may be reused as an already-known project index when
resolving a requested name. It does not authorize a home crawl, a first-basename guess, cloning,
or checkout creation. Configured homes are namespace boundaries: the same repository root has a
different record under a different home.

`onboard`, `models`, and `doctor` do not create central directories or records. An approved default
setup creates only the missing central file, exclusively; `configure-models` writes only after explicit
approval and atomically replaces the global model envelope. Existing, malformed, mismatched, or
symlinked policy state is retained and reported rather than overwritten. New central directories use
`0700` and policy files use exclusive creation with `0600`. Runtime JSON/text state uses atomic
replacement; do not hand-edit durable task records while Tandem is running.

On restart, use the same home, repository, pool root, and named session. The scheduler reconciles durable endpoint-launch intent, Herdr identities, jobs, result files, reservations, and stop requests. It identifies a recoverable endpoint only by exact workspace label/root-pane/cwd identity. Missing or ambiguous resources block or remain pending rather than being guessed; worker output is accepted only when task ID, generation, and HEAD match. A failure preserves reports and worktree state.

Task communication is canonical in the task record and published as a small derived inbox under
`<home>/communications/<safe-task-id>/inbox.json`. The service persists canonical state before
publishing the projection and reconciles a stale or missing inbox after a crash. Worker receipts
are identity-bound to task, job, and generation; an applied receipt means provider-bound context,
not implementation completion. Pending directions survive restart unless the service explicitly
rejects them for a terminal resource or safety state.

OMP-native compaction and the durable store work together:

- before an agent turn, the extension appends coordinator instructions, tool guidance, and a digest of authoritative durable tasks;
- during `session.compacting`, it refreshes that context and preserves `tandemDigest`;
- after `session_compact`, it reconciles the scheduler and appends a fresh `tandem-digest` entry.

The aggregate durable digest is bounded to 8,000 characters and may omit older task detail; the task files and reports remain authoritative. Model-facing action summaries are bounded separately, while `show --full` retains more structured detail.

An undefined worker timeout means no default total-runtime deadline: Tandem omits OMP `--max-time`
and command request timeouts for that worker. Explicit positive worker limits remain honored, as do
validation-command timeouts and cancellation. Passive progress warnings are inspection events, not
automatic kills.

Ordinary non-presentation worker briefs fail closed above 64 KiB (65,536 bytes) of UTF-8. The error identifies the limit and asks for the objective, acceptance criteria, instructions, or artifact references to be shortened; Tandem does not silently truncate an ordinary brief. Presentation keeps its tighter existing 32,000-character prompt bound and its own per-field/list limits.

## CLI reference

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
  pr describe/publish/merge  Record or publish reviewed PR work
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
| `--home PATH` | Tandem durable home for task state, global model preferences, and central repository policy records; default `~/.tandem` or `TANDEM_HOME`. |
| `--session ID` | Named Herdr/OMP session. |
| `--parent-workspace ID`, `--parent ID` | Parent Herdr workspace. |
| `--pool-root PATH` | Treehouse pool root. |
| `--repo PATH` | Subject repository; otherwise current directory. |
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

Command aliases are `status` for `list`, top-level `describe`/`publish`/`merge`, and nested `pr describe`, `pr publish`, and `pr merge`. The CLI accepts options without executing or mutating anything while parsing; execution and approval checks happen afterward.

Communication output is intentionally split: without `--json`, `steer`, `answer`, and `messages`
print a compact plain-language summary; with `--json`, the CLI emits the raw structured value
directly (there is no `.value` wrapper). Use the structured view for revisions, IDs, receipts,
question metadata, activity timestamps, and full message text.

## Local limits and source of truth

Tandem's orchestration, durable state, worker processes, Herdr workspaces, Treehouse pool, and Lavish control are local to the machine running the coordinator. It does not create remote fleets, alternate terminal/harness backends, social relays, or hosted Tandem state. GitHub PR publish/merge necessarily use the configured remote through the local `gh` and Git commands when explicitly requested.

The repository lock is a Darwin native `O_EXLOCK` lock at the task-store directory, with a five-second default acquisition timeout. Lock corruption, lock replacement, filesystem failures, ambiguous external identities, and unknown disk capacity fail closed rather than weakening the safety proof. The lock and durable state are local filesystem primitives; they are not a distributed lock for multiple machines or network filesystems.

The authoritative implementation contracts live in `src/contracts.ts`, with policy resolution in `src/policy.ts`, lifecycle rules in `src/lifecycle.ts`, command/adapters in `src/adapters.ts`, orchestration in `src/service.ts`, and OMP integration in `src/extension.ts` and `src/instructions.ts`. This reference describes those current contracts and does not claim that an external Herdr, OMP provider, GitHub, or Lavish scenario has been run in every environment.
