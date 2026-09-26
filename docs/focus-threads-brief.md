# Brief: one thread at a time in the coordinator

## Goal

While you're working through something with the coordinator (an interview, a question, a review),
new items don't make it change topic. When that thread ends, it tells you what came in and offers
to start on one.

## How it works

```
you:    ...yeah, keep the retry at 2
tandem: Got it. Brief updated and approved; task started.
        While we talked, 3 things came in:
          • PR #201 is ready for review
          • the auth task is blocked on a question
          • the pricing scout finished its report
        Want to start with the auth question?
you:    yes
```

- **A thread opens** when you send the coordinator a message.
- **While a thread is open**, judgment-needed notices (blocked tasks, finished scout reports,
  PR-ready) do not wake the model. You see a quiet toast ("2 waiting"), and they stay in "Needs
  you" as today.
- **The thread closes** when the model says it's done. The moments are usually clear: a brief is
  approved, a task starts, a question is answered, a review is accepted or sent back, or you say
  "ok thanks" or change topic. The model's closing reply lists what's waiting and suggests one to
  start with. Blocked tasks and questions come first because they're holding work up.
- **With no thread open** (you've been away, or you finished and didn't pick anything up), notices
  wake the model immediately, as today.
- **At any time**, "what's waiting?" shows the board through the existing Jev `board` route, with
  no coordinator turn. "Hold on, let's do X" switches topics on purpose.

## Why

With several PRs in flight, a notice can wake the coordinator while you're partway through
something else, and it changes topic. The notices are already saved in "Needs you", so holding the
wake back loses nothing. Only the timing changes.

## Scope

- `deliverPendingNotifications` (src/session/notifications.ts) takes the thread state: while it is
  open, judgment-needed notices stay pending and a toast says how many are waiting. When it closes,
  they go out as one wake with a hidden line telling the model to list them and offer one.
- `CoordinatorSession` (src/session/coordinator.ts) opens the thread on your message or your answer
  to the model's question, and closes it on `thread-done` or after 30 minutes with no message from you.
- A `thread-done` action on the `tandem` tool, and a line in the coordinator's instructions saying when
  to call it.
- The Jev `board` route also recognizes "what's waiting?".

## Non-goals

- No quiet-period timer. If you walk away mid-thread, the toast and `tandem status` already show
  what's waiting.
- No priority rules or urgent notices that break through. Nothing in Tandem needs you within
  minutes.
- No change to routine toasts, PR watch notices, or the `tandem status --watch` pane opening.
- No new stored state. "Needs you" is the queue.

## Acceptance criteria

- A judgment-needed notice that arrives while a thread is open causes no model turn.
- Closing the thread delivers every held notice once, in the closing reply.
- With no thread open, a notice wakes the model as today.
- A held notice survives coordinator restart (it's still pending in durable state and gets
  delivered on the next close, or immediately if no thread is open).

## Manual verification

- Mid-interview, finish a scout. The coordinator stays on topic, then lists the report when the
  brief is approved.
- Ask "what's waiting?" mid-thread and get the board without a coordinator reply.

## If the model never closes the thread

After 30 minutes with no message from you, the thread counts as over and what's waiting wakes the
coordinator. You're most likely away by then, so the message is there when you come back.
