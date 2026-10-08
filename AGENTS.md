# Tandem agent guide

Tandem runs a coordinator conversation plus child OMP agents that research, implement, validate,
review, and deliver repository changes, with every task saved to durable local state. Bun + strict
TypeScript; macOS required for the task store's native `O_EXLOCK` locking.

## Start here

1. Find the relevant domain below; read its implementation and matching `tests/<domain>/`.
2. Follow imports and read only the relevant [behavioral contract](#read-on-demand), not the entire reference.
3. Shared types/roles: [contracts.ts](src/contracts.ts). Service composition/scheduling:
   [service/controller.ts](src/service/controller.ts). What users see and do: [README.md](README.md).

## Source layout

Paths are relative to `src/`; tests mirror domain folders under `tests/`.

| Working on | Start here |
| --- | --- |
| `tandem` terminal command, onboarding, project selection | [main.ts](src/main.ts) → [terminal/](src/terminal/) |
| Action CLI / JSON automation | [cli.ts](src/cli.ts) → [terminal/cli-application.ts](src/terminal/cli-application.ts), per-command handlers in [terminal/cli-commands.ts](src/terminal/cli-commands.ts) |
| Launch, reconnect, reset, ownership | [coordinator/](src/coordinator/): `launch.ts`, `ownership.ts`, `registry.ts`, `recorded-owner.ts` (which recorded coordinator owns a pane or project), `restart.ts` (`tandem update`), `reset.ts`, `workspace.ts`, `resources.ts`, `quarantine.ts`, `exclusivity.ts`, `reconcile.ts` |
| The Tandem coordinator (Tandem's own chat), `open-project`, the welcome popup | [coordinator/tandem-checkout.ts](src/coordinator/tandem-checkout.ts), [coordinator/open-project.ts](src/coordinator/open-project.ts), [terminal/welcome.ts](src/terminal/welcome.ts), [herdr-plugin/](herdr-plugin/) |
| First-time setup in the chat checklist (Herdr, or when the block cannot open): checklist, tool check, finding repos by name | [onboarding/](src/onboarding/): `checklist.ts` (pure; also the guidance while the setup block is open), `tools.ts`; [session/onboarding-guide.ts](src/session/onboarding-guide.ts); [repos/locate.ts](src/repos/locate.ts) (`findCheckoutsByName`, `projectRoots`) |
| The native setup and settings block (first-time setup beside the Tandem coordinator; Settings from the palette, `cmd+shift+,` and the panel), `setup-save` | [onboarding/](src/onboarding/): `setup-view.ts` (pure `SetupView`: per-role recommendations and hints, per-repository commands and suggestions), `setup-answer.ts` (pure answer parsing and checks, including the validation-command gate), `setup-workflow.ts` (effects: gather facts, apply the answer); [tern-plugin/setup.luau](tern-plugin/setup.luau) and `setup.css` (the block); `open` of kind `setup` and the `setup-save` verb in [native/actions.ts](src/native/actions.ts); opened at session start by [session/coordinator.ts](src/session/coordinator.ts) through `openSetupBeside` in [harness/coordinator-session.ts](src/harness/coordinator-session.ts) (`terminal.views.open`). Contract: [native-views.md](docs/reference/native-views.md#setup-and-settings) |
| Shared look of Tandem's HTML pages (tokens, panel, buttons, tabs) | [pages/](src/pages/): `tandem.css`, `assemble.ts` (inlines it into a page template) |
| Models, environment, policy, skill lookup | [config/](src/config/); skills: `skills.ts` |
| Request briefs, approval revisions, review pane | [requests/](src/requests/): `brief.ts`, `store.ts`, `store-codec.ts`, `markdown.ts`, `review-pane.ts`, `workflow.ts` |
| Transitions, approvals, storage, communication | [tasks/](src/tasks/): `lifecycle.ts`, `acceptance.ts`, `findings.ts`, `review-brief.ts`, `review-levels.ts`, `store.ts`, `control.ts`, `question.ts`, `communication-protocol.ts`, `inspection.ts` (`tandem status TASK_ID`), `timeline.ts` / `timeline-store.ts` (task events), `trace.ts` (`tandem trace`), `pull-request.ts` (a task by PR number; PR comments as a worker fix request) |
| Durable jobs, reservations, reconciliation, recovery | [runtime/](src/runtime/) + [service/](src/service/) + [recovery/](src/recovery/): `central.ts` (stop/save/re-enter effects), `central-reentry.ts` (pure re-entry table and decisions), `central-review.ts` |
| Request usage, cost, quota, elapsed-time receipts | [runtime/](src/runtime/): `usage.ts`, `usage-events.ts`, `usage-ledger.ts`, `usage-codec.ts`, `usage-receipt.ts` |
| Model tier evidence and economical routing | [config/model-tier.ts](src/config/model-tier.ts), [workers/execution-routing.ts](src/workers/execution-routing.ts) |
| Implementer playbooks (per-job-type to-do steps, submit gate) | [playbooks/](src/playbooks/) |
| Worker execution, results, control, validation | Harness-neutral session logic: [session/worker.ts](src/session/worker.ts) (`WorkerSession`), [session/worker-steering.ts](src/session/worker-steering.ts) (`WorkerSteering`). [workers/](src/workers/) is the domain layer (jobs, protocol, terminal I/O); entry points: [worker.ts](src/worker.ts), [validation-worker.ts](src/validation-worker.ts); OMP adapters: [harness/omp/worker-control.ts](src/harness/omp/worker-control.ts), [harness/omp/terminal-extension.ts](src/harness/omp/terminal-extension.ts) |
| Harness choice and launch port: `HarnessName`, `harnessOf` (a role's model picks its harness), one `LaunchSpec`, coordinator and worker commands, process matching, model listing | [harness/contract.ts](src/harness/contract.ts) → [harness/resolve.ts](src/harness/resolve.ts) (`harnessFor`, the only way to get a harness; `runnableModels`), [harness/claude-code/models.ts](src/harness/claude-code/models.ts) (fixed Claude Code catalogue) → [harness/omp/launch.ts](src/harness/omp/launch.ts), [harness/claude-code/launch.ts](src/harness/claude-code/launch.ts) (commands for every role, conversation pointer, ready wait, exit keys), [harness/launch-io.ts](src/harness/launch-io.ts). Only [harness/omp/](src/harness/omp/) and `tests/harness/omp/` may import `@oh-my-pi/*` (Biome enforces it) |
| Claude Code adapter: the sidecar protocol, events in over a unix socket, effects out as stdout lines | [harness/claude-code/](src/harness/claude-code/): `host.ts` (`ClaudeCodePane`, the effect table, tool kinds), `coordinator.ts` (`CoordinatorSession` binding), `worker.ts` (`WorkerSession` and `WorkerSteering` binding), `tool-specs.ts` (the tools the ready line lists), `sidecar.ts` (Bun entry: socket, ready line, asks, shutdown), `socket.ts` (socket path); the mods in `plugins/`: `tandem/hooks/` (`register.ts` hooks module, `translate.ts` pure event mapping, `protocol.ts` wire types and import-free codecs), `tandem-renderer/` (hides wake prompts), checked with `claude plugin validate`/`claude plugin test`; setup shared with OMP in [harness/coordinator-session.ts](src/harness/coordinator-session.ts) and [harness/worker-session.ts](src/harness/worker-session.ts) |
| OMP tools, notifications, compaction, prompts | [harness/omp/extension.ts](src/harness/omp/extension.ts) (OMP adapter) → [harness/omp/registration.ts](src/harness/omp/registration.ts) (OMP wiring), [harness/omp/host.ts](src/harness/omp/host.ts) (shared OMP coordinator host) and [session/](src/session/) (harness-neutral logic; `tools.ts` has the tool schemas; `coordinator.ts` runs the coordinator's scheduler, status, and compaction; `tool-guard.ts` limits coordinator tools; `prompt-routing.ts` routes user input); [instructions.ts](src/instructions.ts), [harness/omp/worker-config.yml](src/harness/omp/worker-config.yml) |
| Worktree capacity and maintenance | [pool/](src/pool/) |
| Evidence, PR publication, merge | [delivery/](src/delivery/): `preflight.ts` checks a ready task before publishing |
| Artifacts, feedback, Lavish | [presentations/](src/presentations/) |
| Research and changes in another repository, finding a repository's checkout | [repos/locate.ts](src/repos/locate.ts); `target` on tasks |
| Reviewing someone else's PR (`pr-review` tasks) | [pr-review/](src/pr-review/): `worktree.ts`, `run.ts`, `review.ts`, `post.ts`, `service.ts` |
| `tandem report`, the HTML time/cost report | [report/](src/report/): `model.ts` (view contract), `build.ts` (pure assembly and choke rules), `render.ts` + `page.html` (on the shared [pages/tandem.css](src/pages/tandem.css)), `publish.ts` (write under the home, open in Lavish) |
| `tandem status`, `--watch`, `--line`, "Needs you", "how's it going?" | [board/](src/board/): `view.ts` (pure sections and chat rendering), `terminal.ts` (terminal rendering and the one-line summary), `read.ts`; [terminal/status.ts](src/terminal/status.ts); Herdr tab bar and `prefix+t` popup setup: [terminal-backend/herdr/setup.ts](src/terminal-backend/herdr/setup.ts) |
| `tandem panel`, the board snapshot file | [board/](src/board/): `snapshot.ts` (the file coordinators write), `panel.ts` (pure view model); [terminal/panel.ts](src/terminal/panel.ts) (keys, mouse, Herdr commands, drawing); opened beside each coordinator by [coordinator/panel.ts](src/coordinator/panel.ts) |
| PR watch: keeping open PRs moving until they merge, `tandem watch` | [pr-watch/](src/pr-watch/): `decide.ts` (pure decision table), `github.ts`, `watcher.ts`, `store.ts`, `view.ts` |
| Workstream memory: catch-ups, handoffs, follow-ups | [memory/](src/memory/): `workstream.ts` (pure sections, cap, catch-up view), `view.ts` (card and list), `store.ts` (files in the home), `service.ts`; `tandem memory` in [main.ts](src/main.ts) |
| Self-improvement: trigger rules, investigations, report-mode issues | [self-improvement/](src/self-improvement/): `triggers.ts` (pure rules), `issue-draft.ts` (scrub and Jev check), `service.ts` |
| Terminal port: panes, workspaces, process proof, close, focus, panel, notifications, inherited pane context, fences (unknown-outcome records `tandem fix` settles) | [terminal-backend/](src/terminal-backend/): `contract.ts` (`TerminalBackend`, `TerminalContext`), `compose.ts` (the one place a backend is picked: Tern, unless settings say `terminal = "herdr"`). Herdr implementation: [terminal-backend/herdr/](src/terminal-backend/herdr/). Only that folder and its tests may import Herdr modules (Biome enforces it) |
| Tern backend: exact ids, process proof, native hosting and global preferences | [terminal-backend/tern/](src/terminal-backend/tern/): `cli.ts` (the only Tern CLI runner: `ternCli`, the closed `mutate(op)` gate with durable pane quarantine, `tern plugin`), `backend.ts`, `protocol.ts`, `views.ts`, `host.ts` (staged open tickets, `decide()`, recovery), `fences.ts` (paused opens and pane quarantine as the port's `fences` for `tandem fix`), `plugin.ts` (catalog, link and reload; `TernRequiredError` when Tern is missing), `preferences.ts` (sidebar and shortcut plans, atomic settings and restoration records, and the shared setup lock); selection and foreign-endpoint guards: [terminal-backend/compose.ts](src/terminal-backend/compose.ts), `identity.ts` (`ternEndpoint` narrows the only endpoint `mutate` accepts). Only `tern/` may call the Tern CLI or parse its JSON, and within it only `cli.ts` runs commands (Biome enforces it). Contract: [terminal.md](docs/reference/terminal.md) (`cli.ts`, quarantine) and [native-views.md](docs/reference/native-views.md#staged-opens) (`host.ts`) |
| Native Tern blocks, window palette/routes, shared drawing API | [tern-plugin/](tern-plugin/): `host.luau`, `window.luau`, `layout.luau` (interprets open tickets; never retries), `rt.luau` (the only click transport: `act`, `origin`, toast by notice code; the only view-file reader: `watch`, `draw`), `plugin.toml`; foundation: `text-field.luau`, `diff-row.luau`, `components.luau`. One registration line and manifest entry per block. Contract: [native-views.md](docs/reference/native-views.md) |
| Cross-language native shapes: view kinds, block args, open ticket and receipt, `ViewFile` and its per-kind model schemas | One file per contract: [native/view-file.ts](src/native/view-file.ts) (`ViewFile`, `VIEW_MODELS`), [native/block.ts](src/native/block.ts) (`VIEW_KINDS`, `blockArgs`, `Ticket`, `Receipt`), [native/envelope.ts](src/native/envelope.ts) (`ActionEnvelope`, `Outcome`). Luau mirrors them by field name; `tests/native/` checks both sides. Owner and test per contract: [native-views.md](docs/reference/native-views.md#contracts-and-their-owners) |
| Native view store: `<home>/tern/<projectKey>/` views, `state.json`, open tickets; one lock per project | [native/store.ts](src/native/store.ts): the only owner of the lock and `state.json` (`publishViews`, `readPublished`, `recordVisit` with the visit and catch-up rules, `deliverNewAlerts` and the bell's read cursor, paths). Layout: [native-views.md](docs/reference/native-views.md#store-layout) |
| Native view models, publication and transition alerts | [board/](src/board/): `native-views.ts`, `native-read.ts` (reader and `NativeViewsPublisher`), `native-alerts.ts`; scheduling: [service/controller.ts](src/service/controller.ts); domain models: `tasks/page-view.ts`, `requests/native-view.ts`, `pr-review/native-view.ts`, `runtime/usage-view.ts`, `runtime/usage-display.ts`, `memory/native-view.ts`; the catch-up trigger on project entry: `memory/native-visits.ts` |
| `tandem native act`: one stdin `ActionEnvelope` in, one `Outcome` out; origin proof and the verb table | [native/actions.ts](src/native/actions.ts) (transport only: each verb calls its domain, e.g. `requests/feedback.ts`, `requests/native-pane.ts`, `tasks/pull-request.ts`, `onboarding/setup-workflow.ts`, and maps the result to an outcome); shapes in [native/envelope.ts](src/native/envelope.ts) (`ActionEnvelope`, `Outcome`, `NoticeCode`, `nativeLink`); reply links: [session/native-links.ts](src/session/native-links.ts), `harness/omp/native-links.ts` and the Claude Code coordinator adapter; Luau side: [tern-plugin/rt.luau](tern-plugin/rt.luau). Contract: [native-views.md](docs/reference/native-views.md#click-transport) |
| Treehouse, Lavish, Git/GitHub commands | [adapters/](src/adapters/); OMP commands: [harness/omp/adapter.ts](src/harness/omp/adapter.ts) |

## Safety boundaries

- The main conversation owns approvals. Delegated research is automatic; implementation needs approved
  scope. A ready task opens its own draft PR; final publishing, deploying, and destructive actions
  need specific approval. Only PR watch merges on its own, and only a published (non-draft) pull
  request, through GitHub auto-merge or the repository's queue label. Never force-push.
- Separate original repository identity from the coordinator's clean, commit-pinned worktree.
  Preserve the original checkout, unmerged work, reports, and history.
- Fail closed on ambiguous ownership. Labels alone never authorize terminal closure; force reset
  still checks ownership/source safety and preserves unrelated panes.
- Durable records and task/generation/HEAD-bound evidence are authoritative, not chat or stdout.
  Queued/blocked is not completed. Preserve pinned policy, instruction provenance, and configured limits.
- `<home>/state.sqlite` is the canonical task/runtime authority. Never edit it by hand.
- Never delete coordinator records, panes, worktrees, or lock files by hand; run `tandem fix`, which
  prints a dry run and asks before cleaning (`--yes` applies) and classifies every resource before changing any of it.
- Unknown owned-operation outcomes are quarantined with capacity/resources retained; never clear a
  reservation, replace a task, retry uncertain work, or change policy to bypass ownership. Reset is
  not recovery; `tandem reset` cancels all in-progress tasks across saved projects, and
  `tandem reset --hard` deletes the whole Tandem home.
- Child agents run interactive OMP. Fresh reviewers are read-only; stop implementer mutation during
  validation/review. Validation runs separately without a model. No remote fleets. Exactly two harnesses, OMP and Claude Code; each role's model picks its harness.
- When a session is bad or blocked, inspect durable state first with `tandem status TASK_ID --json`, then `restart` the task, which goes through central recovery; never manually edit SQLite/runtime state, reuse the worktree for a new task, or override unknown ownership.

## Change and verify

- Use one-level domain folders and direct imports; avoid generic utilities, forwarding barrels, and
  duplicate owners. Shared activity predicates live in `runtime/activity.ts`; retain session-specific guards.
- Separate decisions from effects; inject runners, clocks, IDs, and policy. Update all affected callers.
  No `any`, stubs, suppressed checks, or compatibility shims.
- File moves must update imports and `import.meta.url` worker/extension resource paths together.
- Running coordinators load extension code at launch; `tandem update` reloads them after a change.
- Test observable behavior. Native process/terminal checks use isolated Herdr sessions and temporary
  Tandem homes, never the user's live state.
- Cross-subsystem scenario evals live in [tests/evals/](tests/evals/). Reuse
  [scenario.ts](tests/evals/scenario.ts) for its temporary home, fake Herdr/Treehouse/git/OMP/TypeSafe
  boundaries, scripted failures, event trace, and retained/released/failed/quarantined resource ledger
  rather than writing another external-boundary fake. Focused unit tests stay the regression suite.
- The Tern parity contract is [tests/evals/tern-parity/](tests/evals/tern-parity/): `inventory.ts` drives
  every native view row through the real `tern-plugin/*.luau` screens (`host.luau` stands in for Tern)
  and the real CLI. `TernParityHost` in `harness.ts` owns every store path, plugin entry, toast
  normalization and transport detail (`runCli`, `publish` through the coordinator service); when one
  moves, change it, not the assertions. `known-divergence.ts` pins known bugs to flip on fix.
  Luau tests need `luau` and fail without it ([tests/luau.ts](tests/luau.ts)). Real-Tern probes
  ([probes-native.test.ts](tests/terminal-backend/tern/probes-native.test.ts)) run only with
  `TANDEM_TERN_NATIVE=1`.
- Only the parent runs project-wide gates after integration; child workers run no tests, builds,
  formatters, or linters. From the repository root:

```sh
bun run check   # TypeScript
bun test
bun run lint    # Biome, then the lint ratchet
```

The lint ratchet (`scripts/lint-ratchet.ts`) counts size, complexity, hidden-clock and type-assertion
findings per file against a committed baseline; counts may only go down. After cleaning some up, run
`bun run lint:ratchet --update` to lock in the lower counts. After a rename or split, `--update --allow-moves`
shifts counts between files as long as no rule's total rises.
`bun run report:dead` (knip) and `bun run report:dupes` (jscpd) print unused code and copy-paste; they never fail.

On Linux (for example a Claude Code cloud session), store-backed tests need
`TANDEM_IN_PROCESS_STORE_LOCK=1 bun test`: it swaps O_EXLOCK for an in-process lock
(src/tasks/store-lock.ts). The real-lock tests still fail there; never set it for a real home.

Format changed files with `bun run format <files>`. Pull request descriptions follow
[.github/pull_request_template.md](.github/pull_request_template.md), including those opened with `gh pr create --body`. `bun run start` invokes the **advanced action CLI**,
not the normal `tandem` front door.

## Read on demand

Before changing behavior, read its contract in [docs/reference/](docs/reference/):

- Herdr/Tern selection, the terminal port, Tern mapping, mutation guards, setup and consent, quarantine and `tandem fix`: [terminal.md](docs/reference/terminal.md).
- Native Tern views: store layout, contracts and their tests, click transport, staged opens, polling, every view and the Luau API: [native-views.md](docs/reference/native-views.md).
- Roles, approvals, worker tools, what guards what: [operating-model.md](docs/reference/operating-model.md).
- Launch, reconnect, `update`, `reset`, coordinator ownership: [coordinator.md](docs/reference/coordinator.md).
- Harnesses (OMP, Claude Code), how a role's model picks one, where it is recorded, the launch port, the Claude Code sidecar protocol: [harness.md](docs/reference/harness.md).
- Onboarding, settings file, model choices, Jev routing, instruction provenance, skills: [policy.md](docs/reference/policy.md).
- Task stages, fix rounds, research continuation, playbooks, child terminals: [task-lifecycle.md](docs/reference/task-lifecycle.md).
- Request briefs, approval revisions, review pane: [request-briefs.md](docs/reference/request-briefs.md).
- Usage receipts, model routing, premium-tier approval: [usage-and-routing.md](docs/reference/usage-and-routing.md).
- Validation, review, findings, review levels, child results: [review-and-validation.md](docs/reference/review-and-validation.md).
- Inspect, steer, answer, messages, CLI consent: [control.md](docs/reference/control.md).
- Tool actions, notifications, compaction, maintenance, disk admission: [omp-extension.md](docs/reference/omp-extension.md).
- Draft and final PRs, merge, presentations: [delivery.md](docs/reference/delivery.md).
- Tasks in another repository (`targetRepo`), finding checkouts: [other-repositories.md](docs/reference/other-repositories.md).
- Reviewing someone else's PR (`pr-review` tasks): [pr-review.md](docs/reference/pr-review.md).
- PR watch, its decision table, and `tandem watch`: [pr-watch.md](docs/reference/pr-watch.md).
- `tandem status`, "Needs you", the live view, and Herdr's tab bar, popup, and notification: [status.md](docs/reference/status.md).
- `tandem report`, its data sources, choke rules, and where the page is written: [report.md](docs/reference/report.md).
- Self-improvement modes, triggers, investigations, report-mode issues: [self-improvement.md](docs/reference/self-improvement.md).
- Workstreams, catch-ups, handoffs, and what the notes may hold: [project-memory.md](docs/reference/project-memory.md).
- Durable state, locking, restart, central recovery and its re-entry table: [recovery.md](docs/reference/recovery.md).
- Block causes, stale records, panes, leases, `tandem fix`: [reconciliation.md](docs/reference/reconciliation.md).

Keep this file a routing map and cross-cutting rules. Update links when code moves; put detailed
behavior in docs/reference/ instead of accumulating incident-specific instructions here. The README
is written for users: describe benefits and everyday use there, and keep contracts in docs/reference/.
