# Request briefs and approval revisions

The durable request brief, how approval binds to one revision, and the read-only review pane.

Code: src/requests/brief.ts, src/requests/store.ts, src/requests/store-codec.ts,
src/requests/workflow.ts, src/requests/review-pane.ts, src/requests/markdown.ts,
src/requests/plain-language.ts, src/requests/native-view.ts,
src/native/actions.ts, tern-plugin/brief.luau

## Brief record

- One brief per substantial request: stable `req-` id, monotonic draft revision, bound approval.
  Stored in `request_briefs` in `<home>/state.sqlite` under task-style compare-and-swap. Every edit
  pushes the prior draft into preserved history. Tasks reference it via `requestId`.
- Agreement fields (in the agreement digest): goal, `summary`, scope, constraints, non-goals,
  `acceptanceCriteria`, `manualVerification`, approach, key decisions. Annotations: unresolved
  questions, research links.
- `goal` is the one-or-two-sentence TL;DR. `summary` holds the title, one to five before-and-after
  moments of the user's experience, and a size (`small`, `medium`, `large`) and risk (`low`,
  `medium`, `high`) label, each with one reason; the tool schema defines each label. The tool
  requires `summary` and a numbered `recommendedApproach`, but a brief saved before them has no
  summary and a one-paragraph approach, and `summary` joins the agreement digest only when present,
  so older briefs keep their digests and approval.
- Key decisions hold only the user's interview answers and the request's own words. A research
  recommendation the user has not agreed to is an open question, never a key decision or part of
  the approach.
- `acceptanceCriteria` is what validation or review can prove; `manualVerification` is what only a
  person can check. Tasks copy `manualVerification`; reviewers never judge it, implementers may
  report on it without blocking, and delivery renders it as an unticked PR checklist. It joins the
  agreement digest only when non-empty, so older briefs keep their digests and approval.
- `skipReview: true` records the user's planning-time decision that the work needs no code review.
  It is agreement (it joins the digest only when set) and only the coordinator sets it, when the
  user says so. While the approval is current, tasks under the brief record
  [required stages](task-lifecycle.md#required-stages) without review, so a task skips the
  reviewer once validation passes: `advanceReview` records the review level, then applies the
  `skip-review` event (see [delivery.md](delivery.md#publish-now-user-skips-review)). Publishing still needs approval.

## Approval

- An explicit, human-confirmed decision in the main conversation or an Approve click in the native
  brief view records request id, revision, content digest, and agreement digest. The native click
  is the user's confirmation, like Submit on the PR review page; it needs no second dialog or
  `--yes`. the `brief-approve` action of `tandem native act` requires `briefRevision`,
  `contentDigest`, and `agreementDigest` copied from the displayed view. All must match the current
  durable draft inside the approval compare-and-swap. A stale click records nothing and never
  approves a revision the user did not see. Conversation approval still requires the exact id,
  revision, and content digest, with the agreement digest recorded from that draft.
- An agreement change makes approval non-current: dispatch is refused and running work is paused
  via ownership-safe pause until reapproval. Annotation-only edits keep approval current.
- `brief-abandon` records `abandonedAt` when the user drops a request before approving it. Only a
  brief awaiting approval with no unfinished task under it can be abandoned; an approved request is
  ended by cancelling its work. An abandoned brief is final: it no longer counts as awaiting
  approval (so a no-id `brief-approve` and the status board's "Needs you" skip it), dispatch, revision,
  and approval are refused, and its owned review pane is retired. The record and history stay.
- Brief approval is agreement only; scope approval, publish, merge, deploy, and destructive actions
  stay separate.
- A [quick task](task-lifecycle.md#quick-tasks) has no brief: its approval is recorded on the task
  itself (`quick`), and it never joins the project's open request. Converting one to a request
  hands its words to the coordinator, which starts a brief the usual way.

## Review pane

- With a terminal that hosts native views (Tern), `reviewPane: true` publishes the native brief
  detail and calls `terminal.views.open`
  beside the recorded coordinator. Exact block evidence reuses the split across revisions;
  the existing `reviewPane` receipt holds its native endpoint, detail path and shown revision.
  That endpoint records only the brief's terminal, session, workspace, tab, pane, role and
  generation identity. The coordinator's `notificationPane` stays on its own endpoint for alerts.
  Approval, abandonment and current-revision request changes retire it through scoped `views.close`.
  Unknown opening outcomes keep the host's durable ticket and resources quarantined; no legacy
  shell pane or automatic retry follows. Unknown closure leaves approval or feedback standing
  and quarantines the receipt. Tiny in-chat fixes still open no pane.
- A review receipt tagged for another terminal is quarantined with a plain warning before any
  terminal call. Approval, abandonment and feedback retirement preserve that receipt and its pane;
  none closes it through the active backend or marks it closed.
- In Herdr, `reviewPane: true` renders read-only Markdown at `<home>/request-briefs/<requestId>.md` in one
  owned temporary pane, an unfocused split right of the coordinator's pane. Without an active Herdr
  context (`HERDR_ENV`, `HERDR_PANE_ID`) in the Tandem session, it opens a separate
  `Tandem request brief · <repo>` workspace. Tiny fixes use an in-chat brief and no pane.
- The Markdown puts what approval needs above a divider: the title, TL;DR, before and after,
  decisions needed (omitted when there are none), size and risk, how you'll verify, and the
  numbered approach. Below it, Details holds in scope, out of scope, automated checks,
  constraints, decisions already made, references, and the record's id, revision, and digest. A
  brief without a summary omits its sections.

## Plain language

- `brief-draft` checks the sections above the divider and returns what may not read plainly; it
  never blocks a draft. Exact tells come first: em dashes, code formatting, file paths, code names,
  and the filler words the coordinator's prose rules ban. Then one Jev call judges each section for
  someone who uses the product but never read its code, and flags it only when at least 0.7 sure
  it is jargon. Without a TypeSafe key, or when Jev fails, only the exact tells are reported.
- The coordinator rewrites flagged sections and drafts once more before showing the user.
- The coordinator's pane is only the split anchor; a record naming it is quarantined, never written
  or closed. Users edit by replying, never in the pane.
- Every pane operation proves ownership with the coordinator-pane checks (session snapshot, endpoint
  identity, stopped-pane, close verification).
- With glow installed, the brief opens in glow's pager (`less`) from the top, wrapped at the pane's
  width; otherwise it prints as plain text. Before a refresh or close, a pane running only that
  pager gets `q` and must return to its shell; any other program leaves the pane `retained`.

| Status | Meaning |
| --- | --- |
| `open` | Owned pane shows the recorded revision. |
| `closed` | Approval retired it or it was gone; next projection reopens one. |
| `retained` | Transient refusal (busy). Nothing closed; retry. |
| `quarantined` | Ownership unproven or operation failed. Nothing closed or renamed until a human resolves it. |

- Pane failures never close an unrelated pane or lose the brief: SQLite keeps the record, history,
  and referring tasks, and the Markdown is rewritten regardless. A pane receipt never changes a task
  stage or scope approval.

## Native brief feedback

- The `brief-request-changes` action carries the
  displayed `briefRevision`, `contentDigest`, and `agreementDigest`, plus optional overall `text`
  and `comments: [{lineId, text}]`. Copy each stable string `lineId` from the displayed
  `briefView.lines[].id`; numeric Markdown line anchors are refused. At least
  one line comment or nonempty overall text is required; there are at most 100 line comments
  and 64,000 bytes of feedback.
- Feedback names the revision the user saw. A preserved older revision is accepted only with its
  matching digests and valid line ids. The CLI rebuilds `briefView` for that exact historical
  revision and resolves ids in that view, so a newer draft never supplies the quoted text or
  changes an anchor. Unknown ids, unpreserved revisions, and mismatched digests are refused clearly.
  It reaches the ownership-proven running coordinator as
  user input prefixed with "From the open review page:", with the request, revision, quoted lines,
  and comments. It never changes or approves the brief itself.
- Request changes retires the owned brief projection after delivery, only while it still shows
  that revision. A later revision stays open. Approval retires its projection through the existing
  ownership-safe workflow and prompts the coordinator to continue the conversation. If that
  notification fails after approval was recorded, the action returns the approval and a warning.
  If retiring the pane fails after feedback was delivered, request changes returns a successful
  delivery receipt with the pane warning and asks callers not to resubmit. Feedback delivery is
  not idempotent; neither projection failure nor a caller retry may imply that nothing was sent.

## Native brief pane

- An `open` action for a brief opens `tandem.brief` beside the verified project's
  conversation. Every native action is one envelope on the stdin of `tandem native act`, with the
  context the block was launched with as its origin (see [control.md](control.md#native-view-actions)).
- The pane shows the title, revision, change count and NEW lines. Hover `+` opens a line editor;
  Comment saves a local pending card under that line. Those cards and the optional overall text
  are sent on Request changes. Local drafts never write the task store, and a new view revision
  never silently reattaches them. The user can discard them and refresh. Invalid view files disable
  submission while keeping the last display readable. Opening before detail publication shows a
  loading message with no Approve or Request changes controls. Only a successfully parsed
  published revision with a complete approval triplet supplies the action binding.
- Approve sends exactly the displayed `{briefRevision,contentDigest,agreementDigest}` to
  `brief-approve`; it excludes pending feedback. The click is the approval, with no second
  dialog. Request changes sends that same binding plus `text?` and `comments:[{lineId,text}]`.
- After durable approval or delivered request changes, the CLI retires only the originating
  native brief split, and only if the current draft still matches the displayed revision and
  both digests. A changed draft stays open with a warning. Closure proves the exact program,
  all five launch arguments, session/tab and idle state through the terminal host; this native
  projection records its Tern-tagged endpoint, detail path and shown revision in `reviewPane`
  without creating a legacy Markdown pane.
- Approval prompts the verified coordinator to continue. Request changes delivers the user's
  feedback to that conversation. If the brief changed meanwhile, the outcome is `kept` with
  `brief-left-open`: the feedback was delivered, the current brief stays open, and the toast
  reads "Brief left open", never "completed". If notification or closure fails after
  completion, the outcome carries a `brief-warning` notice; the renderer disables further
  submission on that retained pane. Never resubmit to repair a display or notification failure.
  A refused outcome shows its reason as an error toast and causes no automatic retry. The local
  × closes only its block.
