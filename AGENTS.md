# Tandem agent guidance

Read [README.md](README.md) for the user-facing overview and the
[agent reference](docs/agent-reference.md) for installation, CLI commands, configuration, and operational contracts.

## Workflow

- Tandem is a local, OMP-first agent distro. Keep the lifecycle core small and durable; put policy, prompts, and configuration at its boundary.
- Use command-based adapters for Treehouse, Herdr, OMP, Lavish, and GitHub. The coordinating service and CLI own orchestration; the OMP extension owns OMP integration.
- Main conversation orchestration is authoritative. Every child OMP agent runs in an interactive terminal. Its extension publishes the delegated result independently of stdout; completed terminals remain available for read-only follow-up. Reviewers are fresh OMP instances in the task worktree, and implementer mutation is disabled during validation and review. Validation uses a separate non-model pane.
- A launched coordinator owns a distinct clean Treehouse source worktree pinned to the original
  committed HEAD. The original checkout may be dirty and remains untouched; keep its canonical
  repository identity for task records, policy, and delivery while source reads and delegated
  execution use the clean checkout.
- Research is automatic when delegated; scout workers use isolated read-only `read`, `grep`, `glob`, and native `web_search` access. Implementation requires approved scope. Merge, deploy, and destructive actions require specific human approval. Never merge automatically.
- Disclose queued or blocked delegation as actionable state, never describe it as completed research or silently take over research without explicit user authorization; derive recorded task counts from durable state.
- Preserve reports and unmerged work. Do not create remote fleets, other harness integrations, terminal backends, or social relays.
- Child workers must not run tests, builds, formatters, linters, or other project-wide gates. Put tests in `tests/`; the parent workflow runs validation once after changes land.
- Keep implementation, validation, and review instruction channels appendable and preserve source references. Pin the resolved policy on each task.
- Use OMP-native compaction together with a durable digest. Keep default worker/fix limits from policy; do not silently broaden them.

## Source layout

Keep implementation and matching tests in one-level domain folders:

| Domain | Responsibility |
| --- | --- |
| `terminal/` | CLI arguments, prompts, project selection, preparation, and launch UI |
| `coordinator/` | Coordinator registry, ownership proofs, launch, locking, and reset |
| `config/` | Model settings, repository policy, environment resolution, and secure configuration storage |
| `tasks/` | Task lifecycle, storage, communication, and pause/resume/cancel recovery |
| `runtime/` | Durable runtime schema, persistence, reservations, and activity predicates |
| `workers/` | Worker jobs, execution workflow, output/control protocols, and validation |
| `presentations/` | Session preparation, durable workflow, feedback, records, evidence, and locking |
| `delivery/` | Reviewed-change evidence, pull-request publication, and merge |
| `pool/` | Worktree capacity, allocation policy, and safe maintenance |
| `adapters/` | Native tool protocols, subprocess execution, and shared adapter errors |
| `service/` | Public service composition, cross-domain scheduling, and shared coordination records |
| `extension/` | OMP action registration, command parsing, summaries, and notifications |

- Mirror these domains under `tests/`; test public behavior rather than internal file layout.
- Keep executable entrypoints at `src/main.ts`, `src/cli.ts`, `src/extension.ts`,
  `src/worker.ts`, `src/worker-control.ts`, and `src/validation-worker.ts`. Their supporting
  implementation belongs in the domain folders, not forwarding entrypoint shims.
- Keep shared contracts and role metadata in `src/contracts.ts`, shared agent instructions in
  `src/instructions.ts`, and the worker launch configuration at `src/worker-config.yml`.
- Place new code by responsibility. Avoid redundant domain prefixes, generic `utils/` buckets,
  forwarding `index.ts` barrels, and deeper nesting without a concrete boundary.
- Give shared behavior one owner and import it directly. Runtime activity predicates live in
  `runtime/activity.ts`; OMP notification completion lives in `extension/notifications.ts`.
  Do not collapse distinct session-specific safety rules into a generic activity check.
- Split mixed responsibilities at a stable contract, independent consumer, or effect boundary.
  File length is a review signal, not a quota; leave cohesive state machines intact.
- When moving code, update imports and file-relative resource paths together, including
  `import.meta.url` references used to launch workers and load extensions.

## Parent-owned toolchain

- `bun link` exposes the local terminal front door as `tandem`; bare `tandem` opens or reconnects
  every valid saved project from any cwd. Pass explicit `PATH ...` values to open only a saved
  subset or add/open projects; `tandem configure [PATH]` remains a one-project model catalogue
  anchor.
- A no-path launch reads saved registry records under the selected home before consulting cwd. If
  the registry is empty, retain current-Git first-run onboarding and the existing interactive
  fallback outside Git. Saved-project selection is not arbitrary disk discovery or auto-registration
  and needs no project picker in non-TTY/headless launches.
- `tandem --reset` is a launch-only maintenance flow: with no paths it selects every saved project,
  while explicit paths narrow the set. It preflights all roots, stops only idle coordinators with
  exact Tandem ownership, and then normal-launches them. Busy or unsafe work refuses before any pane
  closes; a later failure after some panes already closed stops and reports the already-closed set
  instead of claiming atomicity. It retains settings, history, task records, worktrees, and files; it
  never recovers tasks,
  wipes state, stops a server, or deletes workspaces. Run it from a separate normal terminal, never
  from inside Herdr; add `--continue` only to resume saved conversations.
- A launch may share one Herdr session across multiple projects; each project has its own clean
  coordinator source and child-worker group, and the original checkout remains untouched.
- `bun run check` runs `tsc --noEmit`.
- `bun run test` runs `bun test`.
- `bun run lint` runs `biome check`.
- `bun run format` runs `biome format --write`.
- `bun run start` launches the advanced low-level `src/cli.ts` action CLI.
- Only the parent workflow runs these gates after child work lands; child workers must not run them.

## Code standards

- TypeScript is strict and Bun is the runtime. Keep source-of-truth public types in `src/contracts.ts`.
- Prefer honest dependencies: pass clocks, ID factories, command runners, adapters, and policy explicitly. Do not hide shell, filesystem, process, or session state behind globals.
- Prefer empathic signatures: group coherent arguments in named records, use precise names and units, and make optional fields represent a real lifecycle state only.
- Keep each abstraction layer cohesive. Separate pure lifecycle and policy decisions from effectful command and workspace adapters.
- Keep declarations reader-oriented: public contracts first, supporting types next, then implementations and effect boundaries.
- Keep comments only when they explain a non-obvious invariant, external constraint, or edge-case rationale. Prefer clear names and structure over narration.
- Do not add `any`, stubs, placeholder fallbacks, no-op implementations, suppressions, or compatibility aliases. Remove obsolete paths during a clean cutover.
- Keep changes focused, preserve observable behavior, and update every caller when a contract changes.
