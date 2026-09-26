# Pull-request delivery and presentations

What draft PRs, final publication, merge, and Lavish presentations must guarantee.

Code: src/delivery/pull-requests.ts, src/delivery/evidence.ts, src/delivery/preflight.ts,
src/instructions.ts (`renderPrDescription`, `renderDraftPrDescription`), src/adapters/git.ts,
src/service/controller.ts (`publish`, `publishNow`, `publishDraft`, `merge`),
src/service/draft-refresh.ts, src/presentations/, src/adapters/lavish.ts

## Approval boundaries

- Scope approval is never publication approval. Publish, publish-now, and merge each need their own
  explicit approval (`--yes` or live TUI confirmation). Once a pull request is published (not a
  draft), PR watch merges it on its own through GitHub auto-merge or the repository's queue label
  (see [pr-watch.md](pr-watch.md#merging)); that is the only merging Tandem does without asking.
- A draft PR is never an approval, and never satisfies any acceptance gate.

## Automatic draft at ready

- When an implementation task reaches `ready` with a worktree lease and no recorded PR, the
  scheduler opens a draft for it (`DraftRefreshWorkflow.openWhenReady`, src/service/draft-refresh.ts)
  in the same tick, so `show` has its link by the time the coordinator reads the delivery notice.
- Title is the objective's first line, cut to 72 characters. Base is the task target's branch, else
  the worktree's `origin/HEAD`. The final publish retitles it.
- Each task revision is attempted once. A failure appends a `draft-refresh-failed` diagnostic with
  step `open` and never blocks the task; a PR opened but not recorded is adopted on the next
  attempt. The user can still ask for `draft` by hand.

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
  updates the existing PR in place. Refresh never creates a PR (only the draft at ready does), changes draft state, asks for
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
- When the task's own draft is the pull request, publishing marks it ready for review
  (`gh pr ready`), which is what lets PR watch start merging it.
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
- A brief approved with `skipReview` gives its tasks required stages without review
  ([task-lifecycle.md](task-lifecycle.md#required-stages)); the review stage then applies the same
  event from `reviewing` once validation passes, without the stop step.
- `# Validation` says review was skipped, names any safety floors the diff tripped, and lists the
  validation that passed before the skip. If publication fails after the skip, the task stays
  `ready` and a normal `publish` can retry. Merge stays separate.

## Follow-ups on an open PR

- Once a task's PR is open (not a draft), the user's questions and changes about that work go to
  the same task with `steer`, in the same worktree; the coordinator never starts a new task for them.
- Steering records the task's [required stages](task-lifecycle.md#required-stages) as none: no
  Tandem validation or review. The PR's own CI is the check, and merge still verifies it.
- The direction gets one added line: if the agent changes code, it commits and does not push;
  Tandem pushes (`OPEN_PR_FOLLOW_UP` in src/tasks/control.ts).
- When the agent submits, `implementation-complete` returns the task straight to `ready` with
  `reviewSkippedHead` at the new HEAD. The receipt is not repeated.
- A ready task whose PR is open and behind its HEAD gets that exact HEAD pushed to the task branch,
  never forced (`pushWhenReady` in src/service/draft-refresh.ts, `pushPublishedTask` in
  src/delivery/pull-requests.ts). It re-observes the PR and records its new head. A refused push is
  one diagnostic (`draft-refresh-failed`, step `push`) per task revision and never blocks the task.

## Merge

- PR watch merges published pull requests on its own ([pr-watch.md](pr-watch.md#merging)). The
  `merge` action is for merging right now at the user's request.
- Method is explicit (`merge`, `squash`, `rebase`); the CLI defaults to `squash` only when none is
  given.
- Before `gh pr merge`, Tandem re-observes the PR and requires the same task, repository, base, and
  branch, an open non-draft state, a non-empty set of required CI checks, and all of them passing.
- It rechecks the local reviewed HEAD and passes it as `--match-head-commit`, then re-observes. The
  task becomes `merged` only when the remote reports `merged` at that SHA.

## Presentations and Lavish

- Use a presentation only when a visual artifact improves understanding.
- Only a research (scout) task draws, and its own agent draws it: `present` refuses any other task
  kind and a research task whose scout pane is not running. There is no separate presentation
  worker; records it left keep their Lavish listener, and unfinished ones fail.
- The controller creates a fresh private artifact directory outside the source repository, reads
  installed `lavish-axi --help`, selects matching playbooks, and requests fallback design guidance
  when neither the project nor the objective has a design direction (src/presentations/session.ts).
  It writes the draw request to `brief.md` there.
- A mockup or wireframe objective skips all Lavish guidance and the task's research checks. Its
  brief carries [mockup-style.md](../../src/presentations/mockup-style.md) (screens only, no AI
  visual or copy tells) and points the agent at the project's AGENTS.md/CLAUDE.md writing rules,
  which win over the guide.
- Each draw or revise request has a stable id and reaches the scout as a `mockup` terminal command
  (src/workers/terminal.ts) only while the scout has reported, is idle, and has nothing typed or
  queued in its pane; otherwise the next tick tries again. The scout's extension sends the brief as
  its next turn, and records the id as settled when that turn ends.
- During that turn the scout may `write` and `edit` only inside the artifact directory, and may
  `copy_asset` a regular file from its checkout into it, byte for byte, for relative reference.
  Outside a mockup turn, and for every other path, the scout's writes are refused
  (src/session/worker.ts).
- When a draw settles, the controller verifies the artifact is a regular file inside the directory
  before opening it in Lavish; a missing or escaping artifact fails the presentation with a
  coordinator notification.
- A request whose scout pane has closed or stopped heartbeating is abandoned: a draw fails, and a
  revision's comments go to the coordinator as a notification.

## Presentation feedback

- Each open presentation has one supervised continuous feedback listener with no client timeout.
  It is tracked, serialized with completion and notification persistence, and aborted and awaited
  at shutdown.
- The public `feedback` action is a bounded, cancellable check and may check a
  browser-disconnected presentation. Automatic listening resumes after it returns an open,
  non-disconnected observation.
- Ready/opened and ordinary ended observations are routine UI bookkeeping. Each feedback event is
  stored as full private evidence under the presentation directory. On a page the scout drew, the
  comment becomes that scout's next revise request (a `revision-<id>.md` brief to update the same
  artifact, which Lavish reloads in the open tab) and the coordinator gets a routine note, not a
  turn. A comment that arrives while a request is pending is queued and sent with the next one.
  Other feedback, poll failures, and `browser_disconnected` are delivered through the owning task's
  bounded notification path.
- The listener lays its observation over the record as it is when the poll returns, never over the
  copy it started with, so it cannot undo a request or failure recorded meanwhile.
- `browser_disconnected` leaves an open presentation recoverable without automatic reopen.
  `user-ended` is never reopened automatically, and its final feedback is drained once.
- `presentation-open` shows a presentation again because the user asked: an open, ended, or
  previously opened failed one. With its listener running it only resumes the browser view;
  otherwise it runs `lavish-axi <artifact> --reopen`, records the new observation, and restarts
  the listener (src/presentations/feedback.ts).
- Feedback is an observation, never approval for implementation or delivery. It changes only the
  artifact in the private directory.
