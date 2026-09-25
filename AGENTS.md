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
| Launch, reconnect, reset, ownership | [coordinator/](src/coordinator/): `launch.ts`, `ownership.ts`, `registry.ts`, `restart.ts` (`tandem update`), `reset.ts`, `workspace.ts`, `resources.ts`, `exclusivity.ts`, `reconcile.ts` |
| Models, environment, policy, skill lookup | [config/](src/config/); skills: `skills.ts` |
| Request briefs, approval revisions, review pane | [requests/](src/requests/): `brief.ts`, `store.ts`, `store-codec.ts`, `markdown.ts`, `review-pane.ts`, `workflow.ts` |
| Transitions, approvals, storage, communication | [tasks/](src/tasks/): `lifecycle.ts`, `acceptance.ts`, `findings.ts`, `review-brief.ts`, `review-levels.ts`, `review-assistance.ts`, `store.ts`, `control.ts`, `question.ts`, `communication-protocol.ts`, `inspection.ts` (`tandem status TASK_ID`) |
| Durable jobs, reservations, reconciliation, recovery | [runtime/](src/runtime/) + [service/](src/service/) + [recovery/](src/recovery/): `central.ts` (stop/save/re-enter effects), `central-reentry.ts` (pure re-entry table and decisions), `central-review.ts` |
| Request usage, cost, quota, elapsed-time receipts | [runtime/](src/runtime/): `usage.ts`, `usage-events.ts`, `usage-ledger.ts`, `usage-codec.ts`, `usage-receipt.ts` |
| Model tier evidence and economical routing | [config/model-tier.ts](src/config/model-tier.ts), [workers/execution-routing.ts](src/workers/execution-routing.ts) |
| Worker execution, results, control, validation | [workers/](src/workers/); entry points: [worker.ts](src/worker.ts), [worker-control.ts](src/worker-control.ts), [validation-worker.ts](src/validation-worker.ts) |
| OMP tools, notifications, compaction, prompts | [extension.ts](src/extension.ts) (OMP adapter) → [extension/registration.ts](src/extension/registration.ts) (OMP wiring) and [session/](src/session/) (harness-neutral logic; `coordinator.ts` runs the coordinator's scheduler, status, and compaction; `tool-guard.ts` limits coordinator tools); [instructions.ts](src/instructions.ts), [worker-config.yml](src/worker-config.yml) |
| Worktree capacity and maintenance | [pool/](src/pool/) |
| Evidence, PR publication, merge | [delivery/](src/delivery/): `preflight.ts` checks a ready task before publishing |
| Artifacts, feedback, Lavish | [presentations/](src/presentations/) |
| Research and changes in another repository, finding a repository's checkout | [repos/locate.ts](src/repos/locate.ts); `target` on tasks |
| Reviewing someone else's PR (`pr-review` tasks) | [pr-review/](src/pr-review/): `worktree.ts`, `run.ts`, `review.ts`, `post.ts`, `service.ts` |
| Herdr, Treehouse, OMP, Lavish, Git/GitHub commands | [adapters/](src/adapters/) |

## Safety boundaries

- The main conversation owns approvals. Delegated research is automatic; implementation needs approved
  scope. A ready task opens its own draft PR; final publishing, merging, deploying, and destructive
  actions need specific approval. Never auto-merge.
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
  validation/review. Validation runs separately without a model. No remote fleets or alternate harnesses.
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
- Only the parent runs project-wide gates after integration; child workers run no tests, builds,
  formatters, or linters. From the repository root:

```sh
bun run check   # TypeScript
bun test
bun run lint    # Biome
```

Format changed files with `bun run format <files>`. `bun run start` invokes the **advanced action CLI**,
not the normal `tandem` front door.

## Read on demand

Before changing behavior, read its contract in [docs/reference/](docs/reference/):

- Roles, approvals, worker tools, what guards what: [operating-model.md](docs/reference/operating-model.md).
- Launch, reconnect, `update`, `reset`, coordinator ownership: [coordinator.md](docs/reference/coordinator.md).
- Onboarding, settings file, model choices, Jev routing, instruction provenance, skills: [policy.md](docs/reference/policy.md).
- Task stages, fix rounds, research continuation, child terminals: [task-lifecycle.md](docs/reference/task-lifecycle.md).
- Request briefs, approval revisions, review pane: [request-briefs.md](docs/reference/request-briefs.md).
- Usage receipts, model routing, premium-tier approval: [usage-and-routing.md](docs/reference/usage-and-routing.md).
- Validation, review, findings, review levels, child results: [review-and-validation.md](docs/reference/review-and-validation.md).
- Inspect, steer, answer, messages, CLI consent: [control.md](docs/reference/control.md).
- Tool actions, notifications, compaction, maintenance, disk admission: [omp-extension.md](docs/reference/omp-extension.md).
- Draft and final PRs, merge, presentations: [delivery.md](docs/reference/delivery.md).
- Tasks in another repository (`targetRepo`), finding checkouts: [other-repositories.md](docs/reference/other-repositories.md).
- Reviewing someone else's PR (`pr-review` tasks): [pr-review.md](docs/reference/pr-review.md).
- Durable state, locking, restart, central recovery and its re-entry table: [recovery.md](docs/reference/recovery.md).
- Block causes, stale records, panes, leases, `tandem fix`: [reconciliation.md](docs/reference/reconciliation.md).

Keep this file a routing map and cross-cutting rules. Update links when code moves; put detailed
behavior in docs/reference/ instead of accumulating incident-specific instructions here. The README
is written for users: describe benefits and everyday use there, and keep contracts in docs/reference/.
