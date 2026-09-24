# Request briefs and approval revisions

The durable request brief, how approval binds to one revision, and the read-only review pane.

Code: src/requests/brief.ts, src/requests/store.ts, src/requests/store-codec.ts,
src/requests/workflow.ts, src/requests/review-pane.ts, src/requests/markdown.ts

## Brief record

- One brief per substantial request: stable `req-` id, monotonic draft revision, bound approval.
  Stored in `request_briefs` in `<home>/state.sqlite` under task-style compare-and-swap. Every edit
  pushes the prior draft into preserved history. Tasks reference it via `requestId`.
- Agreement fields (in the agreement digest): goal, scope, constraints, non-goals,
  `acceptanceCriteria`, `manualVerification`, approach, key decisions. Annotations: unresolved
  questions, research links.
- `acceptanceCriteria` is what validation or review can prove; `manualVerification` is what only a
  person can check. Tasks copy `manualVerification`; reviewers never judge it, implementers may
  report on it without blocking, and delivery renders it as an unticked PR checklist. It joins the
  agreement digest only when non-empty, so older briefs keep their digests and approval.

## Approval

- An explicit, human-confirmed main-conversation decision recording request id, revision, content
  digest, and agreement digest. Refused unless id, revision, and content digest match the current
  draft, so it never carries to another revision or request.
- An agreement change makes approval non-current: dispatch is refused and running work is paused
  via ownership-safe pause until reapproval. Annotation-only edits keep approval current.
- Brief approval is agreement only; scope approval, publish, merge, deploy, and destructive actions
  stay separate.

## Review pane

- `reviewPane: true` renders read-only Markdown at `<home>/request-briefs/<requestId>.md` in one
  owned temporary pane, an unfocused split right of the coordinator's pane. Without an active Herdr
  context (`HERDR_ENV`, `HERDR_PANE_ID`) in the Tandem session, it opens a separate
  `Tandem request brief · <repo>` workspace. Tiny fixes use an in-chat brief and no pane.
- The coordinator's pane is only the split anchor; a record naming it is quarantined, never written
  or closed. Users edit by replying, never in the pane.
- Every pane operation proves ownership with the coordinator-pane checks (session snapshot, endpoint
  identity, stopped-pane, close verification).

| Status | Meaning |
| --- | --- |
| `open` | Owned pane shows the recorded revision. |
| `closed` | Approval retired it or it was gone; next projection reopens one. |
| `retained` | Transient refusal (busy). Nothing closed; retry. |
| `quarantined` | Ownership unproven or operation failed. Nothing closed or renamed until a human resolves it. |

- Pane failures never close an unrelated pane or lose the brief: SQLite keeps the record, history,
  and referring tasks, and the Markdown is rewritten regardless. A pane receipt never changes a task
  stage or scope approval.
