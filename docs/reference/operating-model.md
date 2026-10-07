# Operating model

What each Tandem role may do, what actually enforces the workflow, and the local-only limits of
Tandem's state and locks.

Code: src/contracts.ts, src/worker.ts, src/coordinator/launch.ts, src/session/tool-guard.ts,
src/config/policy.ts, src/tasks/lifecycle.ts, src/tasks/store.ts, src/coordinator/lock.ts

## Roles and approvals

The main OMP conversation is authoritative. Tandem records tasks, policy snapshots, worker jobs,
review evidence, reports, worktree leases, notifications, task communication, and delivery state so
a restart never has to rebuild workflow from chat.

1. **Research is automatic when delegated.** A scout may start after task creation without
   implementation approval. Queued or blocked delegation is not active or completed research;
   blockers surface as actionable coordinator notifications. Direct research takeover by the
   coordinator needs explicit user authorization.
2. **Implementation needs approved scope.** The coordinator records concrete scope and waits for
   explicit approval before dispatching an implementer. Before that it interviews the user in
   rounds: one `ask` per round holding every decision the request and research report leave open,
   each with a recommendation drawn from the report. Options beyond the request are labeled as such
   with their concrete cost; facts go to research, never the user; a timed-out or auto-selected
   answer is re-asked. The user confirms the settled decisions before the brief is drafted.
   **Quick tasks are the one exception, and only the user makes one.** No model ever decides that
   a request is quick. Only the user does, through the quick task composer's Start, and that click is
   their approval of exactly the text they typed: no interview, no brief. Tandem's code checks the text, records the approval on the task and
   approves it through the ordinary path; validation, review, the draft PR and publishing approval
   are unchanged. The implementer may stop once to say the request exceeds a small change; the user
   then chooses Proceed, Convert to request (back to the interview) or Cancel. See
   [quick tasks](task-lifecycle.md#quick-tasks).
3. **Validation is runner-owned.** Configured argv commands run against the exact task HEAD and
   produce durable evidence. A worker never claims a command ran unless the runner recorded it.
4. **Review is independent.** The implementer is stopped while a fresh read-only reviewer examines
   the same worktree. Results bind to an exact HEAD and generation.
5. **Delivery is gated.** A ready task opens its own draft PR. Final publishing is an explicit
   approval-bearing action; once published, PR watch merges the pull request when its checks
   pass ([pr-watch.md](pr-watch.md)). A draft is never merged.
6. **Posting a PR review needs the user's approval.** From chat, `review-post` asks for a yes and
   the user's verdict. On the review page, the user's Submit is that approval: Tandem's own code
   (never the model) reads the tagged Submit control's message and posts with no second yes. Either
   way the review is pinned to the reviewed commit and refused if the PR moved
   ([pr-review.md](pr-review.md#show-edit-post)).
7. **A native click approves only from a proven block.** Tern's views can approve a brief, request
   changes, steer, restart, comment on or post a PR review, and save settings. Each of those
   verbs must come from the exact `tandem.<kind>` block Tandem opened for this coordinator and
   subject, as Tern lists it. A worker pane, a window command, the conversation pane, and every
   Herdr pane are refused. Herdr approvals go through the conversation. A reply link only opens
   the view where the user chooses. See
   [approval-bearing clicks](native-views.md#approval-bearing-clicks).
8. **Visuals are drawn outside the repository.** A research task's own scout writes HTML to a
   private artifact directory when asked; the controller, not the scout, opens Lavish and owns the
   feedback listener, and routes the user's comments back to that scout.

## Worker capabilities

Tool sets are fixed in code (`COORDINATOR_TOOLS` in launch.ts; `*_TOOLS` in worker.ts). Every
child worker also gets `submit_report`.

Coordinator and child-worker OMP processes use the skills and MCP servers OMP loads for that
process's checkout and user configuration. Tandem has no per-repository MCP approval list and no
global worker-skill selection. OMP's own configuration decides which sources are enabled; Tandem
does not make skills or servers available when OMP has intentionally disabled them. A task's
explicit `skills` remain the exception: Tandem resolves and pins exactly those requested skills into
the task brief. That explicit pin does not grant other skills or broaden OMP's runtime scope.

| Role | Workspace | Tools | Must not |
| --- | --- | --- | --- |
| Coordinator | OMP conversation in the clean source worktree | `read`, `ask`, `tandem`, plus MCP servers OMP loaded for this checkout and user configuration | Edit code, run shell commands, search the repo (scouts do that) |
| Scout | Isolated Treehouse worktree, child terminal workspace | `read`, `grep`, `glob`, `web_search`, `task` (fans broad scope out to OMP's bundled read-only `scout` subagents; other bundled agents are disabled in worker-config.yml, repository-defined agents are not blocked); `write`, `edit`, `copy_asset` only inside a presentation's artifact directory during a mockup turn | Write anywhere else, run project-wide gates, invent findings when a tool fails (report the exact failure) |
| Implementer | Assigned task worktree, child terminal workspace | `read`, `grep`, `glob`, `edit`, `write`, `bash`, `todo` (holds its [playbook](task-lifecycle.md#playbooks) steps) | Exceed approved scope or change existing behavior the brief didn't ask for, merge, deploy, destructive cleanup, claim validation results (it may run the pinned validation commands, but only the validation runner's records count as evidence) |
| Reviewer | Fresh read-only pane in the task worktree | `read`, `grep`, `glob` | Edit or write a report file; submits findings and a summary; Tandem binds them to the reviewed HEAD and derives the verdict |

Default policy: `maxFixRounds: 2` (src/config/policy.ts). There is no limit on how many workers run
at once, in one repository or across them; only free disk space holds new work back. A policy pinned
before the limit was removed keeps its unread `maxWorkers` so its policy digest still matches, and a
settings file that still sets it loads with the value ignored. The `verifier` role was removed; it
survives only as a legacy decode value in `LEGACY_ENDPOINT_ROLES` (src/contracts.ts) and is never
assigned to new work.

## What guards the workflow

- Prompts are guidance, not a security boundary or policy engine. Runtime checks, terminal/Treehouse
  ownership proofs, filesystem checks, and Git/GitHub preconditions guard mutations.
- Tool allowlists are not an OS or filesystem sandbox, and a private artifact directory is not
  credential isolation: workers inherit the local environment.
- Approval checks therefore stop mistakes and casual forgery, not a determined worker. An
  implementer's `bash` runs as the user, so it can run the advanced action CLI with `--yes`. It
  can replay a genuine native block's pane id, or open a look-alike block through `tern open`. It
  can also call Tandem's service from its own Bun process. No environment variable, TTY, process
  ancestry, or file in the Tandem home tells the user's shell from a worker's, because the worker
  can set, allocate, spawn through Tern, or read each of them. Isolating workers needs a separate
  OS user or a sandbox.
- Tandem has no login flow and copies no credentials. OMP, the selected terminal, Treehouse, `gh`, and Git use
  their existing local configuration and authentication.

## Threat model

Workers run as the user's own OS account with a shell, so Tandem cannot stop a worker that
deliberately forges approvals: it can pipe a crafted envelope into `tandem native act`, draw a
look-alike view, call the service directly, or pass `--yes` to the CLI. The native click checks
(proven block origins, reply links only from the coordinator pane) guard against accidental misuse
only. Real isolation would need a sandbox or a separate OS user, which is out of scope. Reviews
should not treat deliberate worker forgery as a defect.

## Local limits and source of truth

- Everything runs on the local machine: orchestration, durable state, workers, terminal workspaces,
  Treehouse pool, Lavish control. No remote fleets, harnesses other than OMP and Claude Code
  ([harness.md](harness.md)), terminal backends other than Herdr and Tern behind the terminal port, relays, or hosted state. Only the automatic draft at ready, explicitly requested PR publish/merge, and an
  implementer's follow-up push to its own open PR touch the remote, through local `gh` and Git.
- macOS only. The task-store lock is a Darwin native `O_EXLOCK` lock on the task-store directory
  with a 5-second default acquisition timeout (`DEFAULT_LOCK_TIMEOUT_MS`). Coordinator locks under
  `<home>/coordinator-registry/` use the same primitive and timeout; see
  [One coordinator per repository](coordinator.md#one-coordinator-per-repository).
- Lock corruption or replacement, filesystem failures, ambiguous external identities, and unknown
  disk capacity fail closed. These locks are local filesystem primitives, not distributed locks;
  they do not protect multiple machines or network filesystems.
- Authoritative contracts are in code: src/contracts.ts (types and roles), src/config/ (policy),
  src/tasks/lifecycle.ts (transitions), src/adapters/ (native tools), src/service/controller.ts
  (composition), src/harness/omp/, src/session/, src/instructions.ts (OMP integration).

## Terminal backends

Tern is the default terminal; Herdr is the other supported backend, used only when settings say
`terminal = "herdr"`. `src/terminal-backend/compose.ts` selects one. Both use the same terminal
port and endpoint ownership
checks. Tern adds daemon-hosted native views; it does not change task policy, approval or
recovery. See [terminal.md](terminal.md) for selection, resource mapping, process proof,
foreign-endpoint quarantine, native hosting and global-settings consent.
