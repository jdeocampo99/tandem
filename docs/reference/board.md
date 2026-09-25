# Board

What the board shows, where its data comes from, and when Tandem opens it.

Code: src/board/ (`view.ts` sections and rendering, `read.ts` the state read and live loop,
`pane.ts` the Herdr pane), src/main.ts (`tandem board`), src/session/coordinator.ts
(`showBoardOnArrival`), src/session/prompt-routing.ts (the `board` lookup). Tests: tests/board/.

## What it shows

One board across every onboarded project. Each row names its project.

```
Tandem · tandem, tagalingo · checked 5s ago

Needs you
🙋 tandem    Dark mode           brief waiting for approval
🙋 tagalingo #409 refactor-cache ❌ failing 🙋 test_cache_evict failed twice → https://ci/…

Running
🔨 tandem    Fix the flaky login implementing · 12m
🔍 tandem    Retry research      researching · 3m

PRs
🟡 acme/app#412 fix-auth  ✅ 16/16 👀 review   ⏳ waiting on @reviewer
🟢 acme/app#420 add-cache ⏳ 12/16 ✅ approved
```

| Section | Rows |
| --- | --- |
| Needs you | Briefs whose current draft is not approved (new, or changed after approval); tasks with an open question; tasks awaiting approval, blocked (with the reason), paused, or ready; pull requests PR watch marked 🔴. Always shown; "Nothing needs you." when empty. |
| Running | Tasks queued, researching, implementing, checking, in review, or fixing findings, with the time since the task was created. Left out when empty. |
| PRs | Every other watched pull request, as PR watch's rows with `owner/repo#N`. Left out when empty. |

- Finished tasks (completed, merged, cancelled) are not shown.
- "Needs you" is plain saved state; no model or Jev decides it.
- The header names the projects and how long ago PR watch last read GitHub ("PRs not checked
  yet" before the first read).

## Where the data comes from

- `readBoard` reads tasks, briefs, and PR watch records from `<home>/state.sqlite` in one state
  transaction, plus the project list under `<home>/repositories`. It never calls GitHub, so an
  open board costs no rate limit.
- PR rows are what PR watch last saved (see [pr-watch.md](pr-watch.md)), with that read's age in
  the header. The user's unwatched pull requests are not listed; they need a GitHub search.

## `tandem board`

- Re-reads the state every 2 seconds and redraws (clearing the screen) only when the rendered text
  changed. A round that finds the state lock held by another Tandem is skipped.
- Runs until Ctrl-C. It takes no flags besides `--home`.

## When Tandem opens it

- On each scheduler reconcile, a coordinator reads the board and keeps the keys of the "Needs you"
  rows that belong to its own project (a pull request belongs to its task's project, or to the
  checkout it was watched from). When a key appears that was not there on the last reconcile, it
  opens the board.
- Rows already there when the coordinator started count as seen, so a relaunch or `tandem update`
  opens nothing.
- It opens as an unfocused split beside the coordinator's pane, running `tandem board --home
  <home>`. While that pane still exists, whatever runs in it, nothing new opens. The pane is
  remembered in memory only, and never closed by Tandem.
- Without a coordinator pane (no Herdr context) nothing opens. A failure to open is logged and
  never blocks the reconcile.

## "How's it going?"

- With Jev prompt routing on, a message Jev confidently classifies as asking how things are going
  overall runs the read-only `board` action and shows the board text with no coordinator turn
  (`board` in the lookup list, question schema version 4). If Jev fails or is unsure, the message
  goes to the coordinator as before (see [policy.md](policy.md#jev-prompt-routing)).
- The coordinator's `board` action returns the same view.
