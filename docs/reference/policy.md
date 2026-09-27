# Repository policy and settings

How Tandem stores per-project settings and global model choices, resolves them into a pinned task
policy, routes coordinator prompts through Jev, and records where each instruction came from.

Code: src/config/repositories.ts, src/config/policy.ts, src/config/models.ts,
src/config/storage.ts, src/config/values.ts, src/config/environment.ts,
src/terminal/onboarding.ts, src/session/tool-guard.ts, src/session/prompt-routing.ts,
src/adapters/typesafe.ts, src/instructions.ts

## Where settings live

- Policy is Tandem-owned local state, never a file in the target repository. Targets do not check
  Tandem policy into Git, and onboarding never writes application files.
- The home resolves independently of the target: `--home`, then `TANDEM_HOME`, then the
  remembered setup, then `~/.tandem`. A home whose central destination falls inside the target
  repository is refused.
- Per-project settings: `<home>/repositories/<key>/settings.toml`. `<key>` is the first 24 hex
  characters of SHA-256 of the canonical realpath of the Git root, so symlink aliases share a
  record and same-basename repositories at different roots stay separate.
- `repoPath` in the record equals that canonical root. Treat it as a known project-index entry,
  never as a reason to crawl a home directory, guess a basename, clone, or create a checkout.
- Global model choices: `<home>/models.json`.
- Home settings: `<home>/settings.toml`, optional and hand-written, read live on each use and never
  pinned (src/config/home-settings.ts). It stores `projectRoots` (folders searched for checkouts)
  and `selfImprovement` (`"off"` by default, or `"fix"`/`"report"`); see
  [self-improvement.md](self-improvement.md). Older `workerSkills` entries are accepted while
  reading old homes but ignored. Unknown other keys and bad TOML are refused.
- Any symlink in the policy namespace below the home (`inspectPolicyPath`) fails closed. New
  directories use `0700`; new files use `0600`.
- A child-root `.tandem.json` from old builds is ignored: neither imported nor deleted.

## Onboarding: inspect first, write once

- `onboard`, `doctor`, and `models` are read-only and create no directory or file. A read-only
  proposal is not a completed setup.
- Discovery reads `package.json`, the lockfiles below, and the central record. It never executes
  scripts or inspects CI. It reads from the source checkout when one is given. `discovery` in the
  result names the scripts behind the proposed checks and the lockfile behind the install, which
  the setup page shows.
- The write (`setup --yes`, or `onboard --write --yes`) creates only a missing record, exclusively
  (`wx`), re-checking for either settings file just before writing. An existing, malformed, or
  mismatched record is refused, never repaired or replaced. The CLI has no custom-command override.
- In chat, the Tandem coordinator runs the same steps with the same approvals (see
  [coordinator.md](coordinator.md#the-tandem-coordinator)); `open-project` then opens the saved
  project's own coordinator. Before that first write the user may replace the discovered commands:
  `setup` takes `validationCommands` and `setupCommands`, which replace the proposal. The write is
  still the one exclusive create.
- In chat, these two home settings each retain their own approval through `saveHomeSetting` in
  src/config/home-settings.ts (a one-line value is replaced, a missing key is added first, a
  multi-line value or a file changed since reading is refused): `projectRoots`, the absolute
  folders searched for checkouts by name, and `selfImprovement`. The Lavish Review Save bundles
  them into its one user consent after the backend re-checks the answer.
- The setup page (see [coordinator.md](coordinator.md#the-tandem-coordinator)) covers four stages:
  Models, Repos, Self-improvement, and Review. Review's Save and continue is the user's one consent
  to apply the complete answer: models and selected providers, code folders, the self-improvement
  setting, and selected repository settings before opening chats for selected repositories. The
  backend validates the answer against the current machine before writing, then posts a fixed
  success or error status without a model turn. Chat setup actions retain their own approval. The
  page does not ask the user to choose MCP servers or worker skills; OMP determines skills and MCP
  availability from each coordinator or child worker's checkout and user configuration.
- The native terminal asks **Save settings** / **Not now** before writing; **Not now** or Ctrl+C
  creates no project record and leaves saved model choices intact. The interview text and choice
  rules live in `src/terminal/onboarding.ts` and `src/instructions.ts`.
- A later custom policy edit requires approval scoped to the project and fields, a re-read
  immediately before writing (stale-snapshot guard for an existing file, exclusive create for a
  missing one), and refusal if a path or symlink could escape the home. Do not add a CLI flag for it.
- The one such edit Tandem makes is saving how PR watch merges (`[merging] mergeWith`), after the
  user answered in onboarding or at the first watch: `configure-merging` or `pr-watch-merging`,
  each with its own approval, through `saveMergingChoice`, which only adds fields and follows the
  guard above (see [pr-watch.md](pr-watch.md#setting-up-merging)).

### Proposed commands

- `setupCommands`: the install for the first lockfile found, in order `bun.lock`, `bun.lockb`,
  `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `uv.lock`. No lockfile, no setup command.
- `validationCommands`: a non-empty `ci:local` script wins alone. Otherwise non-empty `check`,
  `typecheck`, `lint`, `test`, in that order. Each runs as `<runner> run <script>` with the
  lockfile's package manager, `bun` when there is none (including `uv.lock`).
- Proposals are plain strings, so they cover every surface and get the 10-minute default timeout.
- Missing or invalid `package.json`, no scripts, no `ci:local`, or no discovered scripts are
  reported in `unresolved`. Unresolved discovery is never a passing check; a missing validation
  command is a readiness gap.

## Coordinator tool limits

The coordinator delegates research and does judgement itself.

- Its `--tools` are `read`, `ask`, and `tandem`; no `grep` or `glob`, so it reads only paths a
  report, brief, or the user names.
- OMP loads MCP servers outside `--tools`; the coordinator may use every MCP server OMP successfully
  loads for its checkout and user configuration. Tandem has no per-project MCP allowlist, and an old
  `coordinatorMcpServers` value is inert. The web-URL read guard still applies. Child workers use
  OMP's own loading rules for their child checkout and user configuration.
- While a scout for the project is queued or scouting, `read` of any file outside the Tandem home,
  or inside its `pool/`, is refused. Reports and briefs stay readable. If the task list cannot be
  read, the refusal applies.

## Global model preferences

- `models.json` is `{ schemaVersion: 1, models, enabledProviders?, jev? }`. `models` must name all five
  roles (`coordinator`, `scout`, `implementer`, `reviewer`, `presentation`), each with exactly
  `model` (exact `provider/model`) and `thinking` (a supported level). A partial or hand-edited
  file never becomes implicit defaults. A legacy `verifier` entry is accepted and ignored.
- `enabledProviders` lists providers approved for spending; absent means none, never "all
  discovered". A write that omits it preserves the saved value.
- Absent reads create nothing. Malformed or symlinked `models.json`, or a home inside the target,
  fails closed. Writes replace the file atomically.
- The catalogue comes from `omp models --json`, one lookup per operation. Never parse private
  model configuration or invent names. Catalogue cost is descriptive, not a price guarantee.
- `configure-models` takes a file mapping all five roles directly to `{ model, thinking }` (not
  the storage envelope), with no model-controlled approval field. It refuses without `--yes`, and
  rejects missing or ambiguous selectors and unsupported thinking for every role before writing.
  Stage the file outside the target project.

### Onboarding choice rules

- Every onboarding makes all five roles explicit. First time: collect an explicit selector and
  supported thinking level per role. Saved choices: show all five and offer **Keep all**
  (read-only reuse, no `configure-models`), **Change roles** (explicit choice or keep-current per
  role, then a full recap), or **Not now**.
- **Not now** stops before `configure-models`, `setup`, or `launch` and never falls through to
  built-in defaults. Never infer omitted roles, merge roles, or treat recommendation approval as
  consent. Empty or failed discovery stays visible and never falls back.
- `configure-models` runs once, only after explicit approval of the complete recap.

### Resolution order

Built-in defaults < saved global choices < injected `globalPolicy` < per-project settings.
`resolveRepoPolicy` and `onboardRepo` apply the same order. Built-in defaults exist for direct
APIs only; onboarding must still offer explicit selection. Changing choices affects new tasks
only and never rewrites a task's pinned policy. A new coordinator model applies at the next
launch; a running OMP conversation is never hot-swapped. A launch `--model` or `--thinking` that
differs from resolved policy is rejected.

## Settings file fields

`parsePolicyOverride` in `src/config/policy.ts` is the full schema; unknown keys are rejected.
Contracts the parser does not make obvious:

- `repoPath` must equal the canonical root. `cleanupCommands`, and `[merging]` (PR watch; see
  [pr-watch.md](pr-watch.md#settings)) are machine settings read live from `settings.toml`; they
  are stripped out of task policy and never pinned. Legacy `coordinatorMcpServers` is accepted
  when decoding old project settings but ignored; it is not an MCP allowlist. Everything else is
  policy, pinned with the task at creation, so edits apply to new tasks.
- Setup writes the file once with discovered commands filled in and every other setting commented
  out with a description and example. A test uncomments them all and checks the result parses;
  keep that true when adding a setting.
- A project saved before `settings.toml` keeps its `config.json` envelope
  (`{ schemaVersion: 1, repoPath, policy }`), which is read and validated but never rewritten.
  A directory holding both files is refused.
- Array settings (`instructions`, `instructionFiles`, `validationCommands`, `setupCommands`)
  append to the inherited layer; command names must not collide with inherited ones.
- A command string runs through `/bin/sh -c`, is its own name, has `surfaces: []` (covers every
  surface), and gets a 600,000 ms timeout.
- `setupCommands` run in the implementer's pane before OMP starts, on every launch, and in the
  delivery worktree before final validation. A nonzero exit or timeout fails that worker, naming
  the command.
- `cleanupCommands` run through `/bin/sh -c` in the task's worktree with a two-minute timeout,
  once the task is finished and its panes are closed, and again on manual `cleanup`, whether the
  worktree is then released or kept. A failure never keeps the worktree; it is named in the
  cleanup outcome. Owner: `src/service/scout-cleanup.ts`.
- `standards` is `"tandem"` (default) or `"none"`. `"none"` leaves Tandem's code standards and
  principles (`src/instructions.ts`) out of implementer and reviewer briefs and the review brief's
  mandatory principles, so the repository's own guidance governs. It is pinned only when `"none"`,
  so policies pinned before the setting keep their digest.
- Legacy keys `requestBudget`, `maxWorkers`, and `reviewLevels` decode but are ignored. A task
  pinned with `reviewLevels` carries it unread so its policy digest still matches.
- Existing valid settings are preserved; an invalid file (bad TOML or JSON, unknown fields, wrong
  schema version, mismatched `repoPath`, invalid policy, symlink) blocks while the raw file stays
  untouched.

## Instruction sources and provenance

Policy resolution builds a guidance snapshot per channel (`implementation`, `validation`,
`review`) in this order:

1. inline `instructions`, with provenance like `policy.instructions.implementation[0]`;
2. root `AGENTS.md`, if present;
3. root `CLAUDE.md`, if present;
4. that channel's `instructionFiles`, in declaration order.

- Identical text is de-duplicated, keeping the first source. Entries keep channel and source.
- The task stores the resolved snapshot at creation; later file edits never rewrite it.
- Guidance is always read from the target repository, never the central home. Root guidance is
  optional; configured instruction files are required.
- The reader rejects absolute paths, Windows separators, traversal, missing configured files, and
  symlinks resolving outside the guidance checkout.
- For a clean-bound coordinator, `TANDEM_REPO` stays the policy and task identity, while
  `TANDEM_SOURCE_REPO` supplies the committed checkout for `package.json`, lockfiles, root
  guidance, and `instructionFiles`. The original checkout's dirty guidance is never read.
- Implementation and review briefs include the pinned entries with source labels. The validation
  channel is retained in the snapshot, but validation decisions come from the pinned command specs
  and runner evidence.

## Skills

OMP controls the skills visible to each process. A coordinator and each child worker run in the
context of their own checkout and user configuration, so they see the skills OMP loads for that
context. Tandem does not offer a global worker-skill selection or turn every skill found on disk
into a worker skill. Sources that OMP intentionally disables remain unavailable.

- `create` takes `skills`, the names the user explicitly asked this work to use; `/skill:` prefixes
  are dropped. Tandem resolves and pins those names for the task. This explicit pin does not grant
  other skills or broaden OMP's runtime scope. Owner: `src/config/skills.ts`.
- A task stores each explicitly requested skill's name, origin, real folder path, and SKILL.md body
  without frontmatter. Later edits to the skill never change the task; fix rounds and restarts use
  the pinned copy.
- Scout, implementer, and reviewer briefs carry every explicitly pinned skill in full with its
  folder. Workers also have whatever OMP loads for their own checkout and user configuration at
  runtime; Tandem's explicit task pins do not expand that OMP scope. Presentation briefs carry no
  explicit task skills.
- Create fails, with a message the coordinator puts to the user, when an explicit name is not a
  plain folder name, matches nothing, matches two different folders in the same place, has an empty
  SKILL.md, or the pinned skills together pass 32 KB (`MAX_TASK_SKILLS_BYTES`).
- Tasks created before this recorded one `skill` with the coordinator's own summary; they load as a
  single `summary`-origin skill without a folder. A record with both `skill` and `skills` is corrupt.

## Jev prompt routing

Jev optionally classifies unmatched natural-language coordinator prompts so simple read-only
lookups, and short replies to Tandem's fixed-choice questions, skip the model.

- Enabled only when `TYPESAFE_API_KEY` is set at launch; otherwise the coordinator path is
  unchanged. Jev is on by default: onboarding and `tandem configure` say whether a key is set,
  show the lines to add if not, and offer to turn it off. Keys stay in the shell profile; Tandem
  never asks for or stores them. `"jev": "off"` in `<home>/models.json` launches coordinators
  with an empty `TYPESAFE_API_KEY`, so neither they nor their tasks call Jev. Model `jev-1.13.0` at `https://api.typesafe.ai/v1/systemone`.
  With `PORTKEY_BASE_URL` set, the same request goes to `$PORTKEY_BASE_URL/proxy/decisions`
  instead, adding `x-portkey-api-key`, `x-portkey-provider`, and `x-portkey-custom-host` from
  `PORTKEY_API_KEY`, `PORTKEY_PROVIDER`, and `PORTKEY_CUSTOM_HOST`. `PORTKEY_JEV_MODEL` is the
  gateway's name for Jev (default `jev-1.13.0`); receipts still record `jev-1.13.0`.
  `TANDEM_JEV_TIMEOUT_MS` accepts 100 to 10,000 (default 1,500); out-of-range falls back to default.
- Exact slash commands bypass Jev. Other prompts send one request with only the prompt, an
  explicit task ID if present, and the lookup list.
- Jev returns action, target, effect, scope, and composition. Confidence is the minimum across
  the five; below 0.80 goes to the coordinator.
- Direct dispatch is read-only through the existing service: `list`, `presentations`, `receipt`,
  `board` ("how's it going?" prints the board, see [status.md](status.md#hows-it-going)), and
  `pr-watch` (repository-wide; questions like "how are my PRs?" or "did #409 merge?" print the
  PR watch view, see [pr-watch.md](pr-watch.md#coordinator-shortcut)), plus `show`, `messages`,
  `inspect`, which need an explicit `task-...` ID or UUID in the prompt.
- Choice replies (src/session/choice-reply-route.ts): a prompt of at most 160 characters, while
  Tandem is waiting on a fixed-choice answer, first gets one Jev call listing those choices plus
  `other`. The choices are read from durable state: each open recovery restart (`restart`/`stop`),
  validation retry (`retry`/`stop`), and "Keep fixing?" (`yes`/`no`) question on a non-terminal
  task, and approval of the one brief awaiting it (none when zero or several are pending). A
  choice picked with confidence of at least 0.80 runs in code with no coordinator turn:
  - Low-risk choices (every task-question reply) run `answer` with the exact reply text, so the
    question's own answer path still validates and acts.
  - Risky choices (brief approval) only display a code-written `... ? (y/n)` line. The next
    message decides: an exact `y` runs the action bound to that brief revision and digest, and
    stands in for the approval dialog; an exact `n` drops it; anything else drops it and routes
    as a new prompt. Jev never approves anything on its own.
  - `other`, low confidence, and provider errors continue to the routes below, then the
    coordinator.
- Pull-up: a prompt that names a brief or a visual and a verb like "pull up", "open", or "show"
  first gets one Jev call (src/session/pull-up-route.ts) listing the coordinator repository's
  briefs and openable presentations (15 newest of each), described by goal or objective. Only a
  confident `open` request that matches one listed item runs `brief-review` or
  `presentation-open`; anything else continues to the lookup routing above.
- Investigate: with self-improvement on, a prompt that says "why" and names task trouble (took long,
  restarted, stuck, fix rounds) gets one Jev call (src/session/investigate-route.ts) listing the
  15 most recently changed tasks by objective. Only a confident `investigate` request that matches
  one listed task runs `investigate` with the prompt as its question; anything else continues to
  the lookup routing above. See [self-improvement.md](self-improvement.md#on-demand).
- Everything else goes to normal coordinator handling: incomplete or invalid output, target
  mismatch, non-read-only effect, mixed or multi-part requests, provider errors, missing task ID.
  Jev never generates commands, authorizes actions, mutates state, or picks a model; it only picks
  among choices code listed. Tandem code still validates identity, ownership, state, approvals,
  and policy.
- Diagnostics append to `<home>/logs/tandem.jsonl`: short prompt hash, route facts, confidence,
  reason, latency. An attempted request adds a schema-versioned usage record (tokens or an
  explicit `unavailable`, never zero; duration; timeout; pricing snapshot or `unavailable`) read
  by `src/runtime/usage.ts`. Raw prompts, API keys, and provider payloads are never logged; the
  prompt hash is the only join key to evaluation results. Cost never authorizes or blocks work.
  Readers must accept events recorded before usage existed.
- Background: [prompt-routing PRD](../jev-prompt-routing-prd.md), [integration overview](../jev-prd.md),
  [evaluation plan](../jev-evaluation.md).
