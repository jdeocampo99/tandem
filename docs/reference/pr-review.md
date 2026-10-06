# Reviewing someone else's pull request

What a `pr-review` task guarantees: finding the code, the review worktree, the read-only reviewer,
and posting one review only with the user's approval.

Code: src/pr-review/ (worktree.ts, run.ts, diff.ts, review.ts, edits.ts, page.ts,
page-input.ts, page-feedback.ts, post.ts, service.ts, route.ts, shell.ts),
src/session/review-page.ts (the page listener), src/workers/worktree-lease.ts
(`preparePrReviewLease`), src/workers/workflow.ts (`readPrReviewRound`),
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

- `findCheckout` in src/repos/locate.ts, shared with tasks in another repository; see
  [other-repositories.md](other-repositories.md#finding-the-checkout). The answer to its question
  comes back as `checkout` or `clone: true`.

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
- A review or re-review submits one `PrReview` JSON object: `intent`, an optional one-sentence
  `verdict`, a `tour`, `concerns`, `comments`, `summaryComment`, and `priorComments`.
  - `tour` is 2-4 chapters (`title`, `why`, `stops`) and about 3-12 stops in all. A stop is `file`,
    `from`, `to` (new-file lines, inclusive), `title`, and a 1-2 sentence `body`, in the order the
    code runs. The page draws its diagram from the chapters. Renames and config-only changes leave
    it empty.
  - `concerns` are only points with no single line; a point about one line is a comment.
- The worker checks the object before accepting it. A comment on a line outside the run's diff, any
  inline comment in an intent review, or a bad tour stop is sent back naming the lines in the diff.
  A follow-up question gets plain text.
- A tour stop is valid when its file is in the diff, `1 <= from <= to`, and the range touches at
  least one line the diff shows (added or context). Those are the lines GitHub can anchor a comment
  on (`commentableLines` in diff.ts).
- Rounds stored before the tour have `diagram` and `readingOrder` instead; they still read, with
  those keys ignored and an empty tour.

## Result

- The runner checks the review against the lens and the run's diff: comments on lines GitHub cannot
  anchor move into the summary comment, an intent review has no inline comments, and bad tour stops
  are dropped (and chapters left empty with them), each with a plain-English note.
- The round is recorded on `task.prReview.rounds` with the runner's head, never the reviewer's copy.
  The report file is the review as plain text. The task completes, its pane closes, and its
  worktree is kept for follow-ups.

## Show, edit, post

- `review-show` returns the text: intent, verdict, the tour's chapters and stops, concerns, and
  drafts. For a review with a tour or more than five comments (or `page: true`) it also opens the
  review page in Lavish. The model never writes HTML.
- The page is built by `buildReviewPage` (page.ts) from one `ReviewPageInput`: the PR, the review,
  the round's run diff (`run-N/diff.patch`), and each changed file's full text at the reviewed head
  and at the diff's start, read with `git -C <checkout> show <sha>:<path>` (the run fetched both
  commits into `refs/tandem/pr-review`). A side is absent when the file does not exist there. It is
  written as `<home>/pr-review/TASK_ID/review-N.html` beside `review-N.files.json`, the full files
  the page loads the first time someone expands past its embedded lines.
- While a page is open, Tandem's code listens to it (src/session/review-page.ts, one listener per
  page, stopped when the page ends or the coordinator stops; it works the same under OMP and Claude
  Code).
  - A submission is accepted only from a prompt row whose selector is `SUBMIT_SELECTOR` and tag is
    `SUBMISSION_TAG` (page-feedback.ts), then read by `parseReviewSubmission`. Submission JSON in a
    plain page comment is never a submission.
  - A valid submission is posted by `submit` in code, with no approval dialog: the click is the
    user's approval. The chat gets the result as an aside ("Posted your review: URL", or why it was
    refused), and the page gets the same reply. An unreadable one sends its problems to both.
  - Anything else typed in the page reaches the coordinator as "From the open review page:" and its
    answer is shown in the page.
- `submit` maps the page's choices onto the round: a draft marked `post` is kept (with the user's
  `body` when they edited it), `drop`, `undecided`, and unmentioned drafts are left out, `yours` are
  added like `review-edit` `add`, and `summary` replaces the summary comment. A draft id the round
  does not have is an error. It refuses a round already posted, then posts as below. Nothing is
  saved unless the post lands, so a refused submission can be sent again.
- Native `review-submit` input also requires the displayed `reviewHead` and `reviewGeneration`.
  These travel separately from `ReviewSubmission` to the submit workflow. The service serializes
  submissions with task mutations through GitHub posting and saving the receipt; it refuses a
  head/round generation mismatch or an advanced re-review task generation before applying draft choices.
  Question follow-ups retain the same finished review round, so its unchanged binding remains valid.
  A stale pane must reopen before submitting. The HTML submission shape remains unchanged.
- `review-edit` rewrites, re-labels, or drops comments by id, adds the user's own comments
  (`add: [{file, line, body}]`), and replaces the summary, until the round is posted. An added
  comment must sit on a line the run's diff can anchor; otherwise the error names the lines that
  can. Added comments get ids `u1`, `u2`, ... that do not collide with existing ids.
- `review-post` from chat needs the user's approval and verdict (`comment`, `approve`,
  `request-changes`); Tandem never picks the verdict. Posting, from chat or the page, sends one
  review pinned to the reviewed `commit_id` and refuses when the PR moved. A hidden
  `tandem-review:TASK_ID:GENERATION` marker is looked for before and after posting, so an
  uncertain failure never posts twice. Replies for addressed earlier comments are posted after it.

## Follow-ups and close

- `review-again` re-reviews new pushes; `steer` on a finished review asks the reviewer a question.
  Both resume the same conversation in the same worktree.
- `review-close` marks the review closed, and cleanup removes the worktree and its refs. A
  cancelled review is cleaned the same way.
