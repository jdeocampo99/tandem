# Review and validation

What validation and review must prove before a task is `ready`, how findings persist across fix
rounds, and how review depth is classified.

Code: src/tasks/acceptance.ts, src/tasks/findings.ts, src/tasks/review-brief.ts,
src/tasks/review-levels.ts, src/tasks/lifecycle.ts,
src/validation-worker.ts, src/workers/validation.ts, src/workers/protocol.ts, src/workers/review-round.ts,
src/workers/prompts.ts, src/workers/validation-stage.ts, src/workers/review-stage.ts,
src/instructions.ts

## Review

- The implementer is stopped or paused and one fresh, read-only reviewer pane opens in the same
  worktree with no implementer conversation. That session is the whole review for the round.
  Read-only is enforced twice: the reviewer's tool list has nothing that edits, and the worker's
  tool guard (`reviewerToolRefusal` in src/session/worker.ts) refuses Write, Edit, Bash, subagents,
  and `copy_asset` on either harness.
- The requirement is exactly one passing `review` lens result at the reviewed HEAD and generation.
  Legacy lens names and the `verifier` role still decode (`LEGACY_REVIEW_LENSES`,
  `LEGACY_ENDPOINT_ROLES` in src/contracts.ts) but never count.
- Manual verification items are a person's to check. The reviewer reviews their code but never demands
  proof they work, so a hands-on check cannot loop a task through fix rounds.
- Failed review goes to `awaiting-fixes`; passing review goes to `ready`, since every check already passed at that HEAD.

## Validation commands

- Argv-only, run in declaration order, stopping at the first non-zero exit, timeout, or cancellation.
- A command applies when its `surfaces` is empty, contains `*`, or intersects the task surfaces (a
  task surface `*` matches all). No configured or matching command is a failure, never a pass.
- Evidence records command, argv, exit code, output, HEAD, contract, origin, and policy digest.
- Runner evidence is `origin: "local"` and satisfies only local requirements. Remote required checks
  are the GitHub `RemoteCheck` rollup asserted at merge; a local pass is never relabeled remote.

## Fix rounds and the final contract

src/tasks/acceptance.ts owns both decisions; the runner and lifecycle only execute and record them.

- Every validation run executes the complete manifest (every command matching the task surfaces)
  under `contract: "final"`, so a fix round never reaches review with an unrun check. Evidence saved
  under the retired `contract: "iteration"` stays readable and never satisfies acceptance.
- An admitted fix round records a durable `iterationScope` (failing checks, their surfaces, the P0/P1
  findings to resolve, code and policy identity). P2/P3 findings are never in a fix round's scope
  or its fix context; they stay known issues reported with the ready task.
  A round for failed checks does not spend the fix-round budget; a check that fails again after
  the round that targeted it asks `Keep fixing?` ([fix rounds](task-lifecycle.md#fix-rounds)).
- **Final**: the complete manifest (every required check, the review lens, the acceptance criteria)
  is pinned to the delivered code, policy digest, and HEAD. `ready` needs every item passing under
  one code and policy identity. Delivery re-checks and refuses an incomplete, failed, or stale
  manifest. A failed run returns to fix rounds. No review level changes this.
- `canSkipValidation` sends a finished round straight to `reviewing` only when every manifest
  command already passed at the reported HEAD and policy (a fix round with no commit). Review
  completion refuses a HEAD with failed evidence.

## Evidence validity

- A fix round increments the generation and keeps only passing pinned evidence at its reported HEAD;
  `invalidate-evidence` also clears the scope and reviews.
- Evidence with a digest other than the run's is refused. Final evidence at another HEAD or digest is
  stale, never a pass.
- Pre-contract evidence loads as `legacy`, stays readable, and satisfies neither contract.
- Fail closed on a record with partial contract identity, a legacy record claiming an origin or digest,
  or a validation job without contract identity (the task blocks with that cause).

## Worker results

- Child workers run no project-wide gates; the parent validation worker runs configured commands.
- `submit_report` takes `outcome` (`implemented|needs-decision|failed` for implementers,
  `completed|needs-decision|failed` otherwise), a Markdown `report` (not required of reviewers), and
  role fields. `needs-decision` carries one single-line `question` and optional `recommendation`, each
  at most 1,000 characters; questions wake the coordinator, not the user. A reviewer's `review` holds
  only `findings` and `summary`: the worker extension fills in the job's lens, HEAD, and generation,
  and sets `pass` exactly when no P0 or P1 finding stands.
- An implementer's `implemented` is refused while `git status` in its worktree shows changes, so it
  commits before the job settles instead of blocking the task with `no-clean-checkpoint`. When git
  cannot report a status, the submission goes through and the settle-time checkpoint check decides.
- An implementer's `implemented` is also refused while any of its
  [specialist](task-lifecycle.md#specialists) steps is not completed or abandoned in its `todo` list.
- An implementer does not run the task's pinned validation commands; the validation worker runs
  them after the report. Its job spec lists each command line (a shell string as typed, otherwise
  its argv joined by spaces), and the worker extension's tool guard refuses a `bash` call that runs
  one of them unchanged, alone or chained, ignoring leading `VAR=value`/`env` prefixes and
  redirects (src/workers/validation-commands.ts). A command with other arguments, such as one test
  file, still runs.
- An invalid submission is a tool error naming the fix and never settles the job.

## Review briefs

- Each round writes `review-brief.md` beside the immutable diff in the reviewer's job directory,
  built by src/tasks/review-brief.ts as a pure function of durable task state plus injected git
  observations. Every field comes from existing records; it is not a memory or handoff system.
- A fix round with a complete (untruncated) since-last-review diff gets a "Fix-round focus": review
  that diff, confirm each prior blocker is resolved, and raise a new P0/P1 only on lines changed
  since the last review (older code is at most P2 unless it is a P0). The cumulative diff stays as
  reference. Without that diff, the impact assessment below decides the breadth.
- The eight code standards are mandatory blocking requirements, and implementer claims are never
  proof: every claim is confirmed against source, diff, or runner evidence.
- Principles (`src/instructions.ts`): nine one-line rules adapted from pstack (delete dead code
  first, define a repeated rule once, fix where a bug starts, migrate callers then delete, no
  one-caller layers, safe reruns, check outside data where it enters, script repeated edits,
  decide easy-to-undo choices). The implementer applies them inside the code the task changes and
  the callers of anything it replaces, and never changes existing behavior the brief didn't ask
  for. The reviewer gets the same rules and reports a violation there as P2. In evaluations, one-line rules changed
  the code, while pstack's full principle texts only got cited after the fact.
- Prior findings render by their bare `id`, which the reviewer reuses; the ledger also strips a
  copied `<lens>/` prefix, so `review/<id>` still names the same finding.
- Impact is `contained`, `expanded`, or `unknown`, with an `EscalationReason`: outside the authorized
  surface is `broad-impact`; an unboundable surface, truncated patch, or missing prior reviewed HEAD is
  `unknown-impact`. Outside a focused fix round, anything but `contained` requires reading the cumulative diff and callers in full.
- `REVIEW_BRIEF_LIMITS` bounds the brief. Blocker identities and status are never elided; any elision
  is stated with a pointer to the durable record.
- "User decisions" pairs earlier worker questions with the user's answers. `appendAnswer` clears
  `task.communication.question`, so the question survives as an acknowledged, non-surfacing
  notification under the id the answer's `replyTo` names. A listed decision is settled, and a
  criterion the user accepted without runner evidence counts as satisfied.

## Finding ledger

- Findings keep a stable `lens:id` on the durable `findingLedger`; `record-review` is the only writer.
- Status is `unresolved`, `addressed`, `regressed`, or `disputed`, with the rounds and HEAD behind it.
  A later-generation review that stops reporting an identity settles it `addressed` (any lens,
  including legacy); only a new report reopens it as `regressed`; contradicting verdicts are
  `disputed`.
- `record-review` stores `pass` as "no blocking finding stands", ignoring the reviewer's flag. A P0
  blocks; a P1 blocks only at `standard` (see [Review levels](#review-levels)); both count confirmed
  or plausible. Any other finding never costs a fix round, is not required in one, and is listed in
  the ready message and the PR's `# Known issues`. A violated mandatory requirement from the brief or a
  behavior change outside its scope is P1; a Principles rule violation or a contrived edge case is
  P2. A fix round may decline a finding in its report; the next reviewer accepts it as P2 or names
  a realistic failure inside the task's scope. A P0/P1 names a realistic failing input.
- A spent fix-round budget asks `Keep fixing?` once per task; after that extension is spent the task
  stops for the user ([Task lifecycle](task-lifecycle.md#fix-rounds)). Nothing retries without
  `yes`, auto-passes, or downgrades a blocker.
- Each finding carries the reviewer's `category` (`correctness`, `error-handling`, `security`,
  `tests`, `design`, `requirements`, `docs`) and `catchStage`, the earliest stage that should have
  caught it (`planning`, `implementation`, `validation`, `review`). They are fields of the review
  report, required by the `submit_report` schema, with no Jev call. The ledger keeps them, and the
  task timeline records them when a finding is raised ([task-lifecycle.md](task-lifecycle.md#timeline-and-trace)).
  Findings recorded before tagging load without them.
- Pre-ledger records load with no ledger. An entry with an unknown status or no supporting observation
  fails closed.

## Review levels

Before each review round, src/tasks/review-levels.ts classifies the task's cumulative diff at the
reviewed HEAD as `light` or `standard`. The level and a one-line reason are recorded on the task,
rendered as one line in the reviewer brief, and shown by `tandem show` and the draft PR.

- `light`: at most 5 changed files and 200 changed lines (added plus removed) and no sensitive path.
  Anything else is `standard`, as is a truncated diff.
- Sensitive paths are path-only: dependency manifests and lockfiles, build config, CI and
  infrastructure, and migrations. Diff content never raises the level.
- The level is recomputed fresh every round, so it can drop after a fix round shrinks the change.
- The reviewer assigns honest severities; `isBlockingFinding` applies the threshold. At `light` only a
  P0 blocks and a P1 is a known issue like a P2 or P3; at `standard` a P0 or P1 blocks. Every level
  runs the single `review` lens.
- A record with no level reads as `standard`. A record from before levels were cut to two may say
  `deep`, which reads as `standard`; its floors and helper recommendation are dropped. An unknown
  level or a missing reason fails closed.
