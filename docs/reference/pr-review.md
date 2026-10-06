# Reviewing someone else's pull request

What a `pr-review` task guarantees: finding the code, the review worktree, the read-only reviewer,
and posting one review only with the user's approval.

Code: src/pr-review/ (worktree.ts, run.ts, diff.ts, review.ts, edits.ts, page.ts,
page-input.ts, page-feedback.ts, post.ts, service.ts, route.ts, shell.ts, native-view.ts),
src/terminal/cli-view-actions.ts, tern-plugin/pr.luau, pr-content.luau, pr-diff.luau,
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
  review page: a native PR split in Tern, or Lavish in Herdr. The model never writes HTML.
- The Lavish page is built by `buildReviewPage` (page.ts) from one `ReviewPageInput`: the PR, the review,
  the round's run diff (`run-N/diff.patch`), and each changed file's full text at the reviewed head
  and at the diff's start, read with `git -C <checkout> show <sha>:<path>` (the run fetched both
  commits into `refs/tandem/pr-review`). A side is absent when the file does not exist there. It is
  written as `<home>/pr-review/TASK_ID/review-N.html` beside `review-N.files.json`, the full files
  the page loads the first time someone expands past its embedded lines.
- While a Lavish page is open, Tandem's code listens to it (src/session/review-page.ts, one listener per
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
  does not have is an error. It refuses a round already posted, then posts as below. Preflight
  refusals leave the drafts unchanged. Before the GitHub POST, the exact edited round and verdict
  are saved with `pendingPost`; a later submission reconciles those saved choices without replacing
  them with new choices.
- Native `review-submit` input also requires the displayed `reviewHead` and `reviewGeneration`.
  These travel separately from `ReviewSubmission` to the submit workflow. Every chat/page/native
  posting path claims its durable `pendingPost` with a revision-checked store update before sending.
  GitHub calls run outside the store lock, so a slow POST cannot block other tasks. The receipt is
  settled under a short lock on the exact posted head/generation, preserving other changes and
  newer review rounds. A competing caller cannot send another POST; it only reconciles a saved
  pending attempt. Submission refuses a head/round generation mismatch or an advanced re-review
  task generation before applying draft choices. Once a receipt is saved, every caller that reaches
  the posted round sends its unclaimed replies and reconciles the rest (see Replies below); another
  reconciliation retains the saved receipt/verdict/choices.
  Question follow-ups retain the same finished review round, so its unchanged binding remains valid.
  A stale pane must reopen before submitting. The HTML submission shape remains unchanged.
- `review-edit` rewrites, re-labels, or drops comments by id, adds the user's own comments
  (`add: [{file, line, body}]`), and replaces the summary, until the round is posted. An added
  comment must sit on a line the run's diff can anchor; otherwise the error names the lines that
  can. Added comments get ids `u1`, `u2`, ... that do not collide with existing ids.
  A round with an uncertain `pendingPost` cannot be edited until its receipt is reconciled.
- `review-post` from chat needs the user's approval and verdict (`comment`, `approve`,
  `request-changes`); Tandem never picks the verdict. Posting, from chat or the page, sends one
  review pinned to the reviewed `commit_id` and refuses when the PR moved. A hidden
  `tandem-review:TASK_ID:GENERATION` marker is looked for before and after posting. An unreadable
  marker list or PR head refuses a new POST. `pendingPost` is durable before the POST begins;
  a lost response, malformed receipt, or failure to save the receipt leaves that attempt uncertain
  across restarts. Retries only look for its marker and save the original verdict/choices as posted
  when found. Even a currently absent marker cannot prove an uncertain POST will never appear, so
  it does not permit an automatic POST. This also
  means a crash after saving the attempt but before sending it needs reconciliation rather than a
  blind repost. The receipt is saved before any reply is sent.

### Native PR pane and submission

- `tandem native open pr TASK_ID` opens the task's PR beside the conversation. A numeric PR id
  resolves one owning task first, then one cached PR in the selected project's bundle; ambiguous
  matches refuse. `repo#number` selects the exact cached PR, including a taskless watched PR.
  `native prs` opens a cached PR pane with a selector strip. Taskless PRs are read-only.
  PRs show Description, optional Tour, Diff, cached CI and threads.
  Read-only GitHub refreshes belong to TypeScript; the renderer makes no network reads.
- For `pr-review`, the summary, explicit verdict and Post controls stay visible below the diff.
  `tandem native review-submit TASK_ID --input FILE` takes the normal `ReviewSubmission`
  (`tandemPrReview:1`, `verdict`, `summary`, `drafts:[{id,decision,body?}]`,
  `yours:[{file,line,body}]`) plus the displayed `reviewHead` and `reviewGeneration`.
  Draft choices and new comments remain local until Post. The Post click is the user's approval;
  no second dialog or `--yes` is needed. The same pinned-head, revision-checked pending-post claim
  and receipt workflow applies as for the page. The user still chooses the verdict.
- Native actions include `--pane ID --cwd ABSOLUTE_PATH [--window KEY]`; the shared
  [private JSON transport](terminal.md#native-views-and-actions) owns input-file cleanup.
  Nonzero stderr becomes a toast, local drafts remain available, and no outcome is retried.
  Exit zero alone does not prove a review posted: the renderer requires the CLI's
  `posted:true` receipt before marking it submitted and closing a standalone PR pane.
  `posted:false` keeps the pane with its diagnostic; unreadable receipts ask the user to check
  the PR. An embedded task PR view records success locally and leaves navigation to its host.
- On Tandem's own implementation PRs, `native pr-comment TASK_ID --text TEXT` or
  `--input FILE` with `{text?,comments:[{file,line,text}]}` sends a `PR fix request:` through
  normal worker steering. It never posts to GitHub. The task must have an open/draft PR; a
  finished worker is refused with a request to arrange follow-up in the coordinator. Feedback
  can be saved even if the worker cannot start fixing, so a nonzero result never permits a
  blind repeat. For someone else's reviewed PR, new comments instead stay local until Post.

### Recovering an uncertain post

- An uncertain result, `review-show`, and native PR review notes say: "GitHub may or may not have
  received this review; check the PR." They link the PR and offer two choices through the Tandem
  conversation. Ordinary `review-post` and native/page submissions still only reconcile the marker.
- After checking the PR, the user can ask to post the saved review again. The coordinator uses
  `review-post` with the saved verdict and `recovery: {kind: "post-again", taskRevision}`. The
  confirmation warns that GitHub may already have it and this can create a duplicate. Reposting
  preserves the exact saved choices, checks the current head and readable marker list again, and
  persists a fresh attempt before sending it. A found marker saves its receipt without reposting.
- The user can instead supply the GitHub review link they checked and ask to mark it as posted:
  `recovery: {kind: "mark-posted", taskRevision, url}`. The URL must belong to this PR and include
  its `#pullrequestreview-N` anchor. Confirmation saves a receipt with `confirmedByUser: true`,
  preserves the saved choices/verdict, and clears the pending state without any GitHub requests or
  thread replies. This works even when GitHub API reads are unavailable.
- Both choices require explicit human confirmation through the existing approval dialog or its
  code-written conversation confirmation. `taskRevision` comes from the latest full task record;
  it binds consent to that exact pending attempt. Any intervening change refuses recovery, so a
  confirmation cannot be reused after a second uncertain attempt, even with an identical clock.
  No model, polling loop, or ordinary resubmission chooses recovery on its own.

## Follow-ups and close

- `review-again` re-reviews new pushes; `steer` on a finished review asks the reviewer a question.
  Both resume the same conversation in the same worktree.
- `review-close` marks the review closed, and cleanup removes the worktree and its refs. A
  cancelled review is cleaned the same way.
## Replies

A posted round sends two kinds of replies through one claim mechanism. Native submissions may
include `replies:[{threadId,commentId,replyTo,body}]`, separately from new root comments in
`yours`. The exact thread node, root comment node and positive REST database id must match a fresh
paginated thread read at the reviewed head, including outdated/out-of-diff threads. Every posting
path checks these identities before saving the selected round. A re-review's `priorComments`
entries marked `addressed` with a `reply` send that short reply on the user's earlier comment.
`roundReplies(review)` lists both in a fixed order, thread replies first, and `replyPosts.index`
indexes that list. The saved round retains every reply before any GitHub effect.

Each reply claims its own durable `replyPosts` entry (`kind:pending`, `attemptedAt`,
`attemptRevision`) with a revision-checked update before its POST, so a reply with no entry has
never been sent. GitHub runs outside the store lock. Its outcome is settled on the exact
head/generation/reply under a short lock, preserving concurrent task changes: `posted` saves
`url`/`postedAt`, `uncertain` keeps the attempt and failure detail, and a preflight refusal saves
`failed` with its reason. Each reply uses `in_reply_to`, the pinned `commit_id`, and its own hidden
task/generation/index marker; unreadable head or marker reads refuse posting. A lost response
reconciles the marker without retrying. Unconfirmed replies of both kinds are reported explicitly
and are never automatically retried, including after restart. Review-show, HTML notes and native
review notes retain each saved reply's index, text, target (thread/root identity, or the earlier
comment's GitHub id), and its receipt or warning after reload. A `failed` reply is reported as not
sent with its reason, since the refusal came before any POST. A reply on a posted round with no
entry is reported as not sent, and the next review-post sends it (a submission on a posted round is
refused). The posted message counts every reply with a `posted` receipt.

Older builds sent addressed prior-comment replies directly after saving the review receipt, with no
claim, marker or `replyPosts` entry. Every receipt this build saves, from a publish or from
`mark-posted` recovery, carries `priorRepliesClaimed:true`. On a posted round whose receipt lacks
it, the build that saved the receipt already sent the prior-comment replies, so they are never
claimed, POSTed, reported in notes or recoverable (`sentWithoutClaim`). Thread replies on such a
round still follow the claim rules, as older builds claimed those too.

Every review-post or submission that finds the receipt saved sends the round's unclaimed replies
and reconciles the claimed ones, so a crash mid-loop loses no reply: on re-entry the sent ones are
skipped by their receipt, a pending or uncertain one only has its marker read, and the rest are
claimed and sent. The claim's revision check means two callers cannot send the same reply. An
absent marker never permits an automatic POST of a claimed reply. A failed or uncertain reply never
blocks or undoes the review receipt, and a review receipt does not certify every reply succeeded.

The user can recover one saved reply through review-post with the saved review verdict and
`recovery:{kind:"post-reply-again", taskRevision, replyIndex}`, after a confirmation warning that
this can duplicate a reply. It works for any `roundReplies` index, so a prior-comment reply
recovers exactly like a thread reply. It preserves the exact body/root, rechecks thread identity
for a thread reply, then the marker and pinned head before saving a fresh claim. Two callers or a
stale task revision cannot claim it.
Alternatively `recovery:{kind:"mark-reply-posted", taskRevision, replyIndex, url}` records the
checked same-PR `#discussion_rN` URL with `confirmedByUser:true`, without any GitHub requests.
Both use the same approval flow as review recovery, bind to the latest full task revision, and
never retry or resend the parent review. A completed receipt cannot be recovered again.

Replies on Tandem-owned PRs preserve thread context in worker fix
requests and never post to GitHub. Taskless watched PR views are read-only.
