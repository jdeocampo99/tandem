# Reviewing someone else's pull request

What a `pr-review` task guarantees: finding the code, the review worktree, the read-only reviewer,
and posting one review only with the user's approval.

Code: src/pr-review/ (locate.ts, worktree.ts, run.ts, diff.ts, review.ts, post.ts, service.ts,
route.ts, shell.ts), src/workers/workflow.ts (`preparePrReviewLease`, `readPrReviewRound`),
src/service/scout-cleanup.ts (`settlePrReviewWorktree`). Scenario: tests/evals/pr-review-scenarios.test.ts.

## Starting

- A `pr-review` task reviews a PR Tandem did not write, in any repository the user's `gh` login can
  read. It only reads, so it starts without scope approval, like research.
- `review-pr` takes a PR URL or `owner/repo#N`, the coordinator's project `repoPath` (whose policy
  and model settings the review runs under), and an optional lens: `full` (default), `intent`
  (approach and scope only, no inline comments), or `focus` with the user's own words.
- Merged, closed, and unreadable PRs are refused with one line; drafts and conflicted PRs are
  reviewed and noted. An open review of the same PR is returned instead of a second task.
- The prompt router starts a review directly only when Jev is confident a prompt with a PR link
  asks for one; an unsure lens becomes `full`, and anything else goes to the coordinator.

## Finding the code

- `locateRepo` is plain code, no agent: a saved `repo_locations` row in `state.sqlite`, re-checked
  on every use (the folder exists and a remote still names the repository), then a crawl of the
  project roots up to three levels deep, matching any remote and preferring `origin`.
- Roots default to `~/Coding/Projects`; `TANDEM_PROJECT_ROOTS` (colon-separated) overrides them.
- No match or several matches become a question for the user. The answer (`checkout`, or
  `clone: true` for a blobless clone under `<home>/pr-review/clones/`) is re-checked and saved.

## Review worktree

- Each run fetches `refs/pull/N/head` and the base branch into `refs/tandem/pr-review/N/*` in the
  user's checkout; its branches, remote-tracking refs, `FETCH_HEAD`, and working files are never
  touched. The worktree is detached at `<home>/pr-review/TASK_ID/worktree`.
- The lease record uses the checkout as `root`. Treehouse and the pool are never involved, and the
  project's cleanup commands never run there.
- `<home>/pr-review/TASK_ID/run-N/` holds what the reviewer reads: `diff.patch` (raw, which anchor
  checks read), `diff-numbered.patch` (each line's new-file number in front; the reviewer reads
  this), `context.md` (description, linked issues, CI, `git diff --stat`, files that mention the
  changed files as likely callers, the user's earlier threads with comment ids, other reviewers'
  threads, skipped files), and `run.json`. Lockfiles and `linguist-generated` files are skipped.
- The diff starts at the merge base on a first review, at the previous head on a re-review, and at
  the merge base again when the previous head is no longer an ancestor (a force-push).

## Reviewer

- A scout-role job with its own brief and `prReview.structuredReport`, on the review model
  (`modelRoleForTask`, used by both routing and launch).
- Tools are read, grep, glob, and bash. The worker extension refuses any bash command that is not
  one plain read-only `git` or `gh` command (src/pr-review/shell.ts).
- A review or re-review submits one `PrReview` JSON object, checked in the worker before it is
  accepted. A comment on a line outside the run's diff, or any inline comment in an intent review,
  is sent back naming the lines that can take comments. A follow-up question gets plain text.

## Result

- The runner checks the review against the lens and the run's diff: comments on lines GitHub cannot
  anchor move into the summary comment, and an intent review has no inline comments.
- The round is recorded on `task.prReview.rounds` with the runner's head, never the reviewer's copy.
  The report file is the review as plain text. The task completes, its pane closes, and its
  worktree is kept for follow-ups.

## Show, edit, post

- `review-show` returns the text and, for a review with a diagram or more than five comments (or
  `page: true`), opens a fixed HTML template in Lavish. The model never writes HTML.
- `review-notes` reads notes left on that page. `review-edit` rewrites, re-labels, or drops
  comments by id and replaces the summary until the round is posted.
- `review-post` needs the user's approval and verdict (`comment`, `approve`, `request-changes`);
  Tandem never picks the verdict. It posts one review pinned to the reviewed `commit_id` and
  refuses when the PR moved. A hidden `tandem-review:TASK_ID:GENERATION` marker is looked for
  before and after posting, so an uncertain failure never posts twice. Replies for addressed
  earlier comments are posted after it.

## Follow-ups and close

- `review-again` re-reviews new pushes; `steer` on a finished review asks the reviewer a question.
  Both resume the same conversation in the same worktree.
- `review-close` marks the review closed, and cleanup removes the worktree and its refs. A
  cancelled review is cleaned the same way.
