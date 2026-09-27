# Request briefs and approval revisions

The durable request brief, how approval binds to one revision, and the read-only review pane.

Code: src/requests/brief.ts, src/requests/store.ts, src/requests/store-codec.ts,
src/requests/workflow.ts, src/requests/review-pane.ts, src/requests/markdown.ts,
src/requests/plain-language.ts

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

- An explicit, human-confirmed main-conversation decision recording request id, revision, content
  digest, and agreement digest. Refused unless id, revision, and content digest match the current
  draft, so it never carries to another revision or request.
- An agreement change makes approval non-current: dispatch is refused and running work is paused
  via ownership-safe pause until reapproval. Annotation-only edits keep approval current.
- `brief-abandon` records `abandonedAt` when the user drops a request before approving it. Only a
  brief awaiting approval with no unfinished task under it can be abandoned; an approved request is
  ended by cancelling its work. An abandoned brief is final: it no longer counts as awaiting
  approval (so a no-id `brief-approve` and the status board's "Needs you" skip it), dispatch, revision,
  and approval are refused, and its owned review pane is retired. The record and history stay.
- Brief approval is agreement only; scope approval, publish, merge, deploy, and destructive actions
  stay separate.

## Review pane

- `reviewPane: true` renders read-only Markdown at `<home>/request-briefs/<requestId>.md` in one
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
