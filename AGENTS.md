# Tandem agent guide

Local, OMP-first orchestration for durable repository work. Bun + strict TypeScript; macOS required
for the task store's native `O_EXLOCK` locking.

## Start here

1. Find the relevant domain below; read its implementation and matching `tests/<domain>/`.
2. Follow imports and read only the relevant [behavioral contract](#read-on-demand), not the entire reference.
3. Shared types/roles: [contracts.ts](src/contracts.ts). Service composition/scheduling:
   [service/controller.ts](src/service/controller.ts). Setup/examples: [README.md](README.md).

## Source layout

Paths are relative to `src/`; tests mirror domain folders under `tests/`.

| Working on | Start here |
| --- | --- |
| Normal `tandem`, onboarding, project selection | [main.ts](src/main.ts) → [terminal/](src/terminal/) |
| Action CLI / JSON automation | [cli.ts](src/cli.ts) → [terminal/cli-application.ts](src/terminal/cli-application.ts) |
| Launch, reconnect, reset, ownership | [coordinator/](src/coordinator/): `launch.ts`, `ownership.ts`, `reset.ts`, `workspace.ts`, `resources.ts`, `exclusivity.ts`, `reconcile.ts` |
| Models, environment, policy | [config/](src/config/) |
| Request briefs, approval revisions, review pane | [requests/](src/requests/): `brief.ts`, `store.ts`, `store-codec.ts`, `markdown.ts`, `review-pane.ts`, `workflow.ts` |
| Whole-request membership, dependencies, integration, single-PR delivery | [requests/](src/requests/): `aggregate.ts`, `delivery.ts`, `delivery-store.ts`, `delivery-codec.ts`; [delivery/integration.ts](src/delivery/integration.ts) |
| Transitions, approvals, storage, communication | [tasks/](src/tasks/): `lifecycle.ts`, `acceptance.ts`, `findings.ts`, `review-brief.ts`, `review-levels.ts`, `review-assistance.ts`, `store.ts`, `control.ts` |
| Durable jobs, reservations, reconciliation, recovery | [runtime/](src/runtime/) + [service/](src/service/) + [recovery/workflow.ts](src/recovery/workflow.ts) |
| Request usage, cost, quota, elapsed-time receipts | [runtime/](src/runtime/): `usage.ts`, `usage-events.ts`, `usage-ledger.ts`, `usage-codec.ts`, `usage-receipt.ts` |
| Worker execution, results, control, validation | [workers/](src/workers/); entry points: [worker.ts](src/worker.ts), [worker-control.ts](src/worker-control.ts), [validation-worker.ts](src/validation-worker.ts) |
| OMP tools, notifications, compaction, prompts | [extension.ts](src/extension.ts) → [extension/](src/extension/); [instructions.ts](src/instructions.ts), [worker-config.yml](src/worker-config.yml) |
| Worktree capacity and maintenance | [pool/](src/pool/) |
| Evidence, PR publication, merge | [delivery/](src/delivery/) |
| Artifacts, feedback, Lavish | [presentations/](src/presentations/) |
| Herdr, Treehouse, OMP, Lavish, Git/GitHub commands | [adapters/](src/adapters/) |

## Safety boundaries

- The main conversation owns approvals. Delegated research is automatic; implementation needs approved
  scope. Publishing, merging, deploying, and destructive actions need specific approval. Never auto-merge.
- Separate original repository identity from the coordinator's clean, commit-pinned worktree.
  Preserve the original checkout, unmerged work, reports, and history.
- Fail closed on ambiguous ownership. Labels alone never authorize terminal closure; force reset
  still checks ownership/source safety and preserves unrelated panes.
- Durable records and task/generation/HEAD-bound evidence are authoritative, not chat or stdout.
  Queued/blocked is not completed. Preserve pinned policy, instruction provenance, and configured limits.
- `<home>/state.sqlite` is the canonical task/runtime authority. Never edit legacy `runtime.json` or
  `tasks/*.json`; an offline legacy migration is an explicit two-step operation: inspect with
  `tandem migrate-state --home PATH`, then apply with `tandem migrate-state --home PATH --yes`.
  Read-only status/planning never applies; migration preserves durable records and archives/fences
  original bytes.
- Never delete coordinator records, panes, worktrees, or lock files by hand; run the dry-run-by-default
  `tandem reconcile-resources`, then `--yes`, which classifies every resource before changing any of it.
- Unknown owned-operation outcomes are quarantined with capacity/resources retained; never clear a
  reservation, replace a task, retry uncertain work, or change policy to bypass ownership. Reset is
  not migration or recovery; `tandem --reset --force [PATH ...]` cancels selected active tasks.
- Child agents run interactive OMP. Fresh reviewers are read-only; stop implementer mutation during
  validation/review. Validation runs separately without a model. No remote fleets or alternate harnesses.
- When a session is bad or blocked, inspect durable state first with `tandem inspect TASK_ID --json`, then run the read-only `tandem recovery-plan TASK_ID --json`. Apply only the recommended approved action; never manually edit SQLite/runtime state, reuse the worktree for a new task, or override unknown ownership.

## Change and verify

- Use one-level domain folders and direct imports; avoid generic utilities, forwarding barrels, and
  duplicate owners. Shared activity predicates live in `runtime/activity.ts`; retain session-specific guards.
- Separate decisions from effects; inject runners, clocks, IDs, and policy. Update all affected callers.
  No `any`, stubs, suppressed checks, or compatibility shims.
- File moves must update imports and `import.meta.url` worker/extension resource paths together.
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

Before changing behavior, read its contract:

- Launch/reset/ownership: [Launching the coordinator](docs/agent-reference.md#launching-the-coordinator).
- Policy/instructions: [Repository onboarding and central policy](docs/agent-reference.md#repository-onboarding-and-central-policy).
- Approvals/validation/review/child results: [Task lifecycle](docs/agent-reference.md#task-lifecycle).
- Request briefs/approval revisions/review pane: [Request briefs and approval revisions](docs/agent-reference.md#request-briefs-and-approval-revisions).
- Usage/cost/quota/elapsed-time receipts: [Request usage receipts and the accounting ledger](docs/agent-reference.md#request-usage-receipts-and-the-accounting-ledger).
- Whole-request coordination/single-PR delivery: [Whole-request coordination and single-PR delivery](docs/agent-reference.md#whole-request-coordination-and-single-pr-delivery).
- Messages/control: [Inspecting and controlling work](docs/agent-reference.md#inspecting-and-controlling-work).
- Tools/notifications/compaction: [OMP extension](docs/agent-reference.md#omp-extension).
- Capacity/disk admission: [Safe automatic maintenance](docs/agent-reference.md#safe-automatic-maintenance).
- PRs/artifacts: [Pull-request delivery](docs/agent-reference.md#pull-request-delivery), [Presentations and Lavish](docs/agent-reference.md#presentations-and-lavish).
- Persistence/restart/locking: [Recovery and durable state](docs/agent-reference.md#recovery-durable-state-and-compaction), [Local limits](docs/agent-reference.md#local-limits-and-source-of-truth).
- Recovery/rescue workflow: [First-class bounded recovery actions](docs/agent-reference.md#first-class-bounded-recovery-actions).
- Stale records/panes/leases: [Reconciling Tandem resources across sessions](docs/agent-reference.md#reconciling-tandem-resources-across-sessions).

Keep this file a routing map and cross-cutting rules. Update links when code moves; put detailed
behavior in the reference instead of accumulating incident-specific instructions here.
