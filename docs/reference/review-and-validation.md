# Review and validation

What validation and review must prove before a task is `ready`, how findings persist across fix
rounds, and how review depth is classified.

Code: src/tasks/acceptance.ts, src/tasks/findings.ts, src/tasks/review-brief.ts,
src/tasks/review-levels.ts, src/tasks/review-assistance.ts, src/tasks/lifecycle.ts,
src/validation-worker.ts, src/workers/validation.ts, src/workers/protocol.ts, src/workers/review-round.ts,
src/workers/prompts.ts, src/instructions.ts

## Review

- The implementer is stopped or paused and one fresh, read-only reviewer pane opens in the same
  worktree with no implementer conversation. That session is the whole review for the round.
- The requirement is exactly one passing `review` lens result at the reviewed HEAD and generation.
  Legacy lens names and the `verifier` role still decode (`LEGACY_REVIEW_LENSES`,
  `LEGACY_ENDPOINT_ROLES` in src/contracts.ts) but never count.
- Manual verification items are a person's to check. The reviewer reviews their code but never demands
  proof they work, so a hands-on check cannot loop a task through fix rounds.
- Failed review goes to `awaiting-fixes`; passing review goes to the final validation run.

## Validation commands

- Argv-only, run in declaration order, stopping at the first non-zero exit, timeout, or cancellation.
- A command applies when its `surfaces` is empty, contains `*`, or intersects the task surfaces (a
  task surface `*` matches all). No configured or matching command is a failure, never a pass.
- Evidence records command, argv, exit code, output, HEAD, contract, origin, and policy digest.
- Runner evidence is `origin: "local"` and satisfies only local requirements. Remote required checks
  are the GitHub `RemoteCheck` rollup asserted at merge; a local pass is never relabeled remote.

## Iteration and final contracts

src/tasks/acceptance.ts owns both decisions; the runner and lifecycle only execute and record them.

- **Iteration**: an admitted fix round records a durable `iterationScope` (failing checks, their
  surfaces, findings to resolve, code and policy identity). The next run executes only those checks
  under `contract: "iteration"`. A targeted pass is progress and never satisfies acceptance.
- Targeted runs escalate to the full manifest, with the reason durable on the validation job:
  `stale-identity`, `disputed-result` (reviewer rejected a candidate whose checks all passed),
  `unknown-impact` (unconfigured check), `broad-impact` (scope already covers every check).
- **Final**: the complete manifest (every required check, the review lens, the acceptance criteria)
  is pinned to the delivered code, policy digest, and HEAD. It runs only after review passes at that
  HEAD and generation; `ready` needs every item passing under one code and policy identity. Delivery
  re-checks and refuses an incomplete, failed, or stale manifest. A failed final run returns to fix
  rounds and later restarts the full manifest from the beginning. No review level changes this.
- `canSkipValidation` sends a finished round straight to `reviewing` when the full manifest already
  passed at the reported HEAD and policy (a fix round with no commit), or when the round only answered
  findings after every check passed. Review completion refuses a HEAD with failed evidence but does
  not require evidence.

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
  and sets `pass` exactly when no P0 or P1 finding stands. A presentation submits an absolute
  `artifactPath`.
- An implementer's `implemented` is refused while `git status` in its worktree shows changes, so it
  commits before the job settles instead of blocking the task with `no-clean-checkpoint`. When git
  cannot report a status, the submission goes through and the settle-time checkpoint check decides.
- An invalid submission is a tool error naming the fix and never settles the job.

## Review briefs

- Each round writes `review-brief.md` beside the immutable diff in the reviewer's job directory,
  built by src/tasks/review-brief.ts as a pure function of durable task state plus injected git
  observations. Every field comes from existing records; it is not a memory or handoff system.
- Fix rounds point the reviewer at the diff since the last reviewed HEAD and the open findings.
- The seven code standards are mandatory blocking requirements, and implementer claims are never
  proof: every claim is confirmed against source, diff, or runner evidence.
- Impact is `contained`, `expanded`, or `unknown`, reusing `EscalationReason`: outside the authorized
  surface is `broad-impact`; an unboundable surface, truncated patch, or missing prior reviewed HEAD is
  `unknown-impact`. Anything but `contained` requires reading the cumulative diff and callers in full.
- `REVIEW_BRIEF_LIMITS` bounds the brief. Blocker identities and status are never elided; any elision
  is stated with a pointer to the durable record.
- Advisory leads render with provenance under an untrusted heading and can never become blockers,
  drop mandatory context, or authorize acceptance.
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
- `record-review` stores `pass` as "no P0 or P1 stands", ignoring the reviewer's flag. P0/P1
  (confirmed or plausible) blocks; P2/P3 is a known issue that never costs a fix round and is listed
  in the ready message and the PR's `# Known issues`. A violated mandatory design rule is P1.
- A spent fix-round budget asks `Keep fixing?` ([Task lifecycle](task-lifecycle.md#fix-rounds)).
  Nothing retries without `yes`, auto-passes, or downgrades a blocker.
- Pre-ledger records load with no ledger. An entry with an unknown status or no supporting observation
  fails closed.

## Review levels

src/tasks/review-levels.ts classifies each round `light`, `standard`, or `deep` from changed paths,
their observed content, files referencing them, and the round's impact. Level, reason, and fired floors
are recorded on the task and shown by `tandem show`.

- Line count, title, or extension is never enough alone. Paths categorize only enumerated sensitive
  locations (`package.json`, `migrations/`, `.github/`); everything else comes from diff content.
- Safety floors: `permissions-security`, `data-integrity`, and `shared-contracts-concurrency` force
  `deep`; `dependency-build-infra` forces `standard`.
- Unknown impact is `deep`. Unobserved content, truncated patch, binary file, no observed file, or a
  change outside the authorized surface is `standard`. `light` needs contained impact, every file
  observed and categorized as implementation, tests, or docs, no floor, and counts within
  `LIGHT_CLASSIFICATION_LIMITS`.
- Reclassification only raises. Classification never touches pinned policy or model choices.
- Pre-level records read as `standard` with every `reviewLevels` opt-in off. An unknown level or floor,
  or a missing reason, fails closed.
- With default policy the level changes nothing: every round runs the single `review` lens. The
  `reviewLevels` policy (all off by default) adds `deepScrutiny` (fired floors become mandatory
  scrutiny in a `deep` brief; adds work only), `jevAssistance` (`off` or `shadow`), and
  `sourceTransmission` (explicit opt-in to send source out, separate from having `TYPESAFE_API_KEY`).
  A retired `reducedRouting` key loads and is ignored.

## Shadow helper assistance

- src/tasks/review-assistance.ts asks the Jev transport (src/adapters/typesafe.ts) for a depth and
  focus flags in one call. It runs only with `jevAssistance: "shadow"`, `sourceTransmission: true`,
  and a credential; otherwise no source leaves the process.
- Flags become advisory leads with full provenance and never become findings or authorize acceptance.
- `raiseReviewLevel` can only raise; in shadow mode the deterministic level is used unchanged. Any
  failure, timeout, malformed answer, low confidence, or stale context yields nothing and never blocks.
- Screening refuses secret-bearing paths (`.env`, `*.pem`, `.ssh/`, and others) and obvious secret
  content; the rest is capped by the `maxTransmitted*` limits in `REVIEW_ASSISTANCE_LIMITS`, whose
  thresholds are provisional but whose transmission bounds are hard. Diagnostics go to
  `<home>/logs/tandem.jsonl` without source content. The cache matches all six identities exactly.
- Before moving `jevAssistance` past shadow, publish from `evals/review-levels/`: the issue #20
  end-to-end benchmark, zero false-safe routing on high-risk, Tagalog, and adversarial fixtures
  (reported separately from agreement), a threshold sweep, and a comparison against the deterministic
  baseline, keeping the baseline unless clearly worse.
