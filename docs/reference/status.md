# Status

What `tandem status` shows across projects, where its data comes from, its live view, and when
the coordinator opens it.

Code: src/board/ (`view.ts` sections and the chat rendering, `terminal.ts` the terminal
rendering, `read.ts` the state read and live loop,
`pane.ts` the Herdr pane), src/terminal/status.ts (the footer's data), src/main.ts
(`tandem status`), src/session/coordinator.ts (`showBoardOnArrival`),
src/session/prompt-routing.ts (the `board` lookup). Tests: tests/board/,
tests/terminal/main.test.ts.

## What it shows

One view across every onboarded project. Each row names its project; no row shows a task ID.

```
 tandem   tandem, tagalingo · PRs checked 40s ago

NEEDS YOU 4 ──────────────────────────────────────────────────────────────────────────────
🙋 tandem     Dark mode                    brief waiting for approval
🙋 tagalingo  Refactor cache               question: keep the old eviction order?
🙋 tandem     Retry research               blocked: reviewer timed out twice
🔴 tagalingo  acme/app#409 refactor-cache  🙋 test_cache_evict failed twice → https://ci/…

RUNNING 3 ────────────────────────────────────────────────────────────────────────────────
   PROJECT    TASK                   STAGE         TIME
🔨 tandem     Fix the flaky login    implementing   12m
🔍 tandem     Research retry policy  researching     3m
⏸️ tagalingo  Dark mode tokens       paused          2h

PRS 2 ────────────────────────────────────────────────────────────────────────────────────
   PULL REQUEST            CHECKS          STATUS       NEXT
🟡 acme/app#412 fix-auth   ████████ 16/16  👀 review    ⏳ waiting on @reviewer
🟢 acme/app#420 add-cache  ██████░░ 12/16  ✅ approved

THIS WEEK  7 done · 5 of 7 passed review first time · $14.20

──────────────────────────────────────────────────────────────────────────────────────────
3 finished tasks hidden · coordinators open: tandem, tagalingo
Tandem code: 9618fa9 Merge pull request #188 (/Users/me/Coding_Projects/tandem)
Ask the coordinator about any task · tandem status --json for task IDs · tandem status --watch for the live view
```

| Section | Rows |
| --- | --- |
| Needs you | Briefs whose current draft is not approved (new, or changed after approval); tasks with an open question; tasks awaiting approval, blocked (with the reason), or ready; pull requests PR watch marked red. Always shown; "Nothing needs you." when empty. |
| Running | Tasks paused by the user, queued, researching, implementing, checking, in review, or fixing findings, with the time since the task was created. Left out when empty. |
| PRs | Every other watched pull request, as PR watch's rows with `owner/repo#N`. Left out when empty. |
| This week | One line for the 7 days before now, across every project: tasks whose timeline last moved them to completed or merged in that window, how many of those that went through review passed it the first time, and what those tasks cost. Left out when none finished. |

- The header names the projects and how long ago PR watch last read GitHub ("PRs not checked
  yet" before the first read).
- Each section title carries its row count and a rule as wide as its widest row. Running and PRs
  have column headers; a pull request's checks show as an 8-cell bar of passed out of all checks
  when PR watch has the counts, otherwise its checks text (`no CI`, `⚠`).
- Columns are measured in terminal cells (`Bun.stringWidth`), so emoji take two.
- On a terminal, text is colored by meaning: yellow waits on the user (section title, brief and
  approval rows, `question:`), red failed (`blocked:`, red pull requests, failing checks), cyan and
  blue are work in progress, magenta is checking or review, green is done or passing, and the
  header's extras, project names, times, and footer are dim. Paused and queued rows are dim.
  Lines are cut with `…` to the terminal's width so a row never wraps.
- Colors and cutting apply only when stdout is a terminal. Piped or captured output, and any
  output when `NO_COLOR` is set, is plain text with the same layout; plain output says
  `Projects:` where the colored header shows a ` tandem ` badge.
- The footer counts finished tasks (completed, merged, cancelled), which are not listed, names the
  projects with an open coordinator, and gives the commit `tandem` runs from.
- "Needs you" is plain saved state; no model or Jev decides it.
- `tandem status --json` prints `code`, `coordinators`, `board` (the view above as data), and
  `tasks` (every task record, with IDs). `tandem status TASK_ID` is unchanged: one task's full
  inspection.

## Where the data comes from

- The weekly line is computed on read from each task's timeline and its request's usage ledger
  (see [task-lifecycle.md](task-lifecycle.md#timeline-and-trace)),
  through `taskRollup`, `taskCost`, and `summarizeRollups` in src/tasks/trace.ts. Only completed
  or merged tasks updated in the last 7 days have their timeline read. A task with no request has
  no recorded cost; usage with no price shows as "+ unpriced usage".

- `readBoard` reads tasks, briefs, and PR watch records from `<home>/state.sqlite` in one state
  transaction, plus the project list under `<home>/repositories`. Status never calls GitHub, so
  the live view costs no rate limit.
- PR rows are what PR watch last saved (see [pr-watch.md](pr-watch.md)), with that read's age in
  the header. The user's unwatched pull requests are not listed; they need a GitHub search, which
  `tandem watch` does.

## `tandem status --watch`

- Re-reads the state and open coordinators every 2 seconds and redraws (clearing the screen) only
  when the rendered text changed. It reads the terminal's width each round, so a resized pane is
  redrawn to fit. The code version is read once at start. A round that finds the
  state lock held by another Tandem is skipped.
- Runs until Ctrl-C. It takes no task ID, `--json`, or `--logs`.

## When the coordinator opens it

- On each scheduler reconcile, a coordinator reads the board and keeps the keys of the "Needs you"
  rows that belong to its own project (a pull request belongs to its task's project, or to the
  checkout it was watched from) and that `opensBoard` accepts: briefs awaiting approval, task
  questions, red pull requests, and tasks awaiting approval or ready. When such a key appears that
  was not there on the last reconcile, it opens the live view.
- Blocked tasks stay listed but never open it: recovery restarts most blocks on its own, so the
  pane would pop for blocks that clear themselves.
- Rows already there when the coordinator started count as seen, so a relaunch or `tandem update`
  opens nothing.
- It opens as an unfocused split beside the coordinator's pane, running
  `tandem status --watch --home <home>`. While that pane still exists, whatever runs in it,
  nothing new opens. The pane is remembered in memory only, and never closed by Tandem.
- Without a coordinator pane (no Herdr context) nothing opens. A failure to open is logged and
  never blocks the reconcile.

## "How's it going?"

- With Jev prompt routing on, a message Jev confidently classifies as asking how things are going
  overall runs the read-only `board` action and shows the header and sections, without the footer,
  in a compact uncolored form for the chat (`renderBoard`: plain section titles, no column
  headers, checks as text, times after the stage like `implementing · 12m`),
  with no coordinator turn (`board` in the lookup list, question schema version 5). If Jev fails or
  is unsure, the message goes to the coordinator as before (see
  [policy.md](policy.md#jev-prompt-routing)).
- The coordinator's `board` action returns the same view.
