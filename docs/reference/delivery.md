# Pull-request delivery and presentations

What draft PRs, final publication, merge, and Lavish presentations must guarantee.

Code: src/delivery/pull-requests.ts, src/delivery/evidence.ts, src/delivery/preflight.ts,
src/instructions.ts (`renderPrDescription`, `renderDraftPrDescription`), src/adapters/git.ts,
src/service/controller.ts (`publish`, `publishNow`, `publishDraft`, `merge`),
src/presentations/, src/adapters/lavish.ts

## Approval boundaries

- Scope approval is never publication approval. Draft, publish, publish-now, and merge each need
  their own explicit approval (`--yes` or live TUI confirmation). Tandem never merges on its own.
- A draft PR is never an approval, and never satisfies any acceptance gate.

## Draft eligibility

- A draft needs an implementation task with approved scope, a durable worktree lease, and a stage in
  `DRAFT_ELIGIBLE_STAGES` (src/delivery/evidence.ts): `implementing`, `validating`, `reviewing`,
  `awaiting-fixes`, `ready`, `paused`, or `blocked`.
- It needs no reviewed HEAD, passing validation, or passing review.
- Unmerged paths refuse the draft. Uncommitted changes do not; the body says it shows committed work
  only.

## Draft body

- Marked unfinished twice: GitHub draft state and a banner saying it is visibility only, not ready,
  mergeable, deployable, or accepted.
- Reports the recorded review level with the classifier's reason and safety floors, then what the
  pinned policy still requires at final acceptance regardless of level. No recorded level reads as
  `standard`. Showing a level never changes the gates.
- Reports current activity, blockers (durable block reason, bounded-loop exhaustion, unanswered
  question, failed validation, recorded findings), remaining checks, and the unchanged
  final-acceptance contract.
- Remaining checks come from the final acceptance manifest owner, so the draft lists exactly what
  the final gate requires: each requirement with no evidence, only stale evidence (other commit or
  policy), or a failing result; each pending review lens; and the runner-owned required GitHub
  checks. A surface set matching no pinned validation command is shown as the configuration failure
  the final gate refuses, never as a pass.

## Draft refresh

- When durable task state changes, the scheduler recomputes the body from the task record and
  updates the existing PR in place. Refresh never creates a PR, changes draft state, asks for
  approval, or blocks durable work when the remote is unavailable.
- The branch advances by pushing the exact task HEAD without force. A refused push leaves the
  published commit alone and the body discloses the lag.
- Each durable state is attempted at most once, so an unavailable remote never becomes a per-tick
  retry loop; the next durable change retries.
- A failed refresh appends a bounded `draft-refresh-failed` diagnostics event: task id, PR number,
  failed step (`digest`, `remote-refresh`, or `record`), and error class name. Never message text,
  command output, or payload. A task that advanced mid-refresh is recorded under `record`.

## Task-to-PR identity

- Publication observes the task branch before and after the push and reuses any PR it finds, so a
  retry or restart updates rather than duplicates.
- An uncertain `gh pr create` is re-observed once: an observed PR is adopted, otherwise the failure
  is raised and the operation quarantined. No blind retry, no second PR, no cleared reservation.
- `delivery-preflight` treats the task's own draft on the same repository and base as the PR final
  publication updates. Any other recorded or observed PR is refused.

## PR description

- The summary has exactly `tldr`, `what`, and `why` arrays of non-empty single-line entries; `tldr`
  has at most three, and entries may not inject Markdown headings.
- Tandem adds `# Validation` from recorded runner evidence, `# Manual verification` as unticked
  `- [ ]` items when the task has manual verification, and `# Known issues` listing every finding
  on the ledger not yet `addressed`.
- `describe` renders without publishing.

## Delivery preflight

`delivery-preflight` (src/delivery/preflight.ts) must pass before approved publication. It refuses
only what makes publishing wrong or impossible: a dirty or unmerged worktree, a HEAD other than the
reviewed HEAD, a branch other than the task's, an `origin` that is not a GitHub repository (the
repository is always read from `origin`), a failed GitHub lookup, or an open PR for the branch.

- It reruns no quality commands; validation already ran them at the reviewed HEAD. Being behind the
  base branch is not a refusal.
- Each refusal is one plain-English line. The coordinator reports it and stops; it never creates a
  new task or worktree to work around a refusal.

## Final publication

- The task must be `ready`. Publish verifies a clean worktree, the task branch, non-empty successful
  validation evidence, a passing current review lens, and worktree HEAD exactly equal to the
  reviewed HEAD.
- It pushes that exact SHA to the task branch of the GitHub repository named by the worktree's
  `origin`. `publish` takes no repository argument.
- Existing PRs are re-observed and must match repository, base, branch, and SHA; closed or merged
  duplicates are refused.

## Publish now (user skips review)

- Used only when the user explicitly asks to skip review or publish now; the coordinator never
  chooses it, and it needs confirmation like `publish`.
- Allowed for an implementation task in `validating`, `reviewing`, `awaiting-fixes`, or `blocked`,
  with a clean worktree and a commit beyond its base (`skipReview` in src/tasks/control.ts).
- Running validators/reviewers stop through the same pause path `restart` uses; a worker that
  cannot be proven stopped blocks the task and nothing moves. The abandoned job is settled.
- The `skip-review` lifecycle event makes the task `ready` at its current HEAD with
  `reviewSkippedHead` recorded. That record replaces the evidence, review, and final-acceptance
  checks at exactly that HEAD; any later fix round or evidence invalidation clears it.
- `# Validation` says review was skipped. If publication fails after the skip, the task stays
  `ready` and a normal `publish` can retry. Merge stays separate.

## Merge

- Method is explicit (`merge`, `squash`, `rebase`); the CLI defaults to `squash` only when none is
  given.
- Before `gh pr merge`, Tandem re-observes the PR and requires the same task, repository, base, and
  branch, an open non-draft state, a non-empty set of required CI checks, and all of them passing.
- It rechecks the local reviewed HEAD and passes it as `--match-head-commit`, then re-observes. The
  task becomes `merged` only when the remote reports `merged` at that SHA.

## Presentations and Lavish

- Use a presentation only when a visual artifact improves understanding.
- The controller creates a fresh private artifact directory outside the source repository, reads
  installed `lavish-axi --help`, selects matching playbooks, and requests fallback design guidance
  when neither the project nor the objective has a design direction (src/presentations/session.ts).
- The presentation worker gets a bounded brief, writes complete HTML only to the supplied path, and
  returns exactly one `Artifact: <absolute path>` line. It cannot open or poll Lavish.
- The controller verifies the artifact before opening it.

## Presentation feedback

- Each open presentation has one supervised continuous feedback listener with no client timeout.
  It is tracked, serialized with completion and notification persistence, and aborted and awaited
  at shutdown.
- The public `feedback` action is a bounded, cancellable check and may check a
  browser-disconnected presentation. Automatic listening resumes after it returns an open,
  non-disconnected observation.
- Ready/opened and ordinary ended observations are routine UI bookkeeping. Each feedback event is
  stored as full private evidence under the presentation directory and delivered through the
  owning task's bounded notification path; poll failures and `browser_disconnected` are persisted
  and delivered the same way.
- `browser_disconnected` leaves an open presentation recoverable without automatic reopen.
  `user-ended` is never reopened, and its final feedback is drained once.
- Feedback is an observation, never approval for implementation or delivery.
