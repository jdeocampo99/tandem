# Report

What `tandem report` shows, where its numbers come from, how it names what held a task up, and
where the page is written.

Code: src/report/ (`model.ts` the view contract, `build.ts` pure assembly and choke rules,
`render.ts` and `page.html` the page, on the shared stylesheet src/pages/tandem.css, `publish.ts`
writing and opening it), `TaskService.report`
in src/service/controller.ts (reads records and calls `build.ts`), src/main.ts (`tandem report`),
src/terminal/arguments.ts (`--since`). Tests: tests/report/, tests/terminal/main.test.ts.

## What it shows

One static HTML page listing every task in scope, sorted by time lost (waiting on the user or held
up, plus a review loop's span), largest first. For each task: its title (the objective's first
line), kind, stage, status (merged, completed, cancelled, PR open, or in progress), a timeline of stage
segments, time split into working, waiting on you, and held up (queued or stuck), per-lane totals
(research, implement, validate, review, queued, waiting on you, stuck) with cost where priced agent
work ran, the settled agent runs, total cost, and at most one choke.

A task's window runs from creation until it first reaches ready, completed, merged, or cancelled,
or until the report's generation time. Time after ready is a person merging, not Tandem.

Status comes from the task's current stage: `merged`, `completed`, and `cancelled` keep their
names, `ready` is `pr-open` (its draft pull request is open and waiting on a person; the page draws
a pull-request icon in the implement color with the tooltip "PR open"), and every other stage is
`in-progress`.

## Data sources

- Stage segments come from the task's timeline events (`tasks/timeline-store.ts`), in `seq` order.
  Rows that cannot be decoded are skipped and counted in the page's `unreadableEvents`.
- Agent runs and cost come from the usage `work` events that hold the task's own work
  (`runtime/usage-ledger.ts` `readTaskUsage`), filtered to the task's own `identity.taskId`: its
  request's ledger, or, for a task no request governs (usually research and PR reviews), its
  task-scoped ledger (see usage-and-routing.md, Task-scoped usage). Each request is read once even
  when several tasks share it. A task with no recorded work has no cost, never zero cost.
- Coordinator cost is recorded per request, not per task, so it is not split across tasks and is
  not shown. Coordinator and legacy verification work belongs to no lane.
- Unpriced samples are counted; their cost is unknown, not zero.
- Tasks created before timeline history was recorded have no segments; their window ends at
  `updatedAt` when their current stage ends the window, else at the generation time.

## Chokes

Fixed rules name at most one choke per task (`build.ts`):

- The longest stuck (blocked), waiting-on-you (awaiting approval, paused, or an unanswered
  question), or queued stretch of at least `CHOKE_THRESHOLD_MS` (5 minutes); shorter stretches are
  ordinary friction.
- Or a review loop: review sent the task back for fixes `REVIEW_LOOP_MIN_ROUNDS` (2) or more times,
  compared by its span from the first review exit to the window's end. The round count matches
  `tandem trace`.
- A queued stretch with `admission-waiting` events inside it names the reason that covered most of
  it: each event covers the stretch until the next one or the stretch's end, time before the first
  is no reason's, and ties go to the reason recorded first. The headline then ends "waiting for
  disk space for a new worktree", "waiting for a worktree capacity check", or "waiting on a model
  routing question", and the explanation says how long of it (for example "Queued 26m, 20m of it
  waiting for disk space for a new worktree."). With no such events the headline is "Queued 26m".
- Ties go to the earlier rule in that order, then the earlier stretch. The choke carries a short
  headline and, when the records say more, one plain sentence: the block's cause and any restart,
  the work before a wait, the stage a queue led into, or the findings review raised.

## Command

`tandem report [--since DATE] [--json] [--no-open] [--home PATH]`

- Scope follows the service's repository scope, like `tandem trace`: from the terminal that is
  every task. The page's label is the scoped repository's folder name, the one project every task
  belongs to, or "All projects".
- `--since` keeps tasks created at or after it. It takes `YYYY-MM-DD` (local midnight) or an ISO
  timestamp with `Z` or an offset; anything else is an error with exit code 1.
- `--json` prints the `ReportView` and writes and opens nothing.
- Otherwise the page is written to `<home>/reports/report-<generatedAt>.html` (`:` and `.`
  replaced by `-`; directory `0700`, file `0600`) and opened with `lavish-axi <path>` through the
  injected command runner, with the reports directory as its working directory. Nothing polls it
  for feedback. If Lavish is missing, fails, or reports an error, the command still succeeds and
  prints the path to open by hand with one plain sentence: "Lavish isn't installed or couldn't
  start." when the command could not start (spawn failure, `ENOENT`, exit 127), else "Lavish
  couldn't open the page." Raw adapter text stays off that line; a short (at most 120 characters)
  first line of Lavish's error or stderr, or a timeout, may follow on a `Details:` line.
  `--no-open` writes the file and runs nothing.
- After writing, the reports directory keeps the newest `REPORT_FILES_KEPT` (20) report pages,
  counting the new one. Only regular files named like `report-*.html` count and are deleted, oldest
  first by name (the name is the generation time); the page just written, other files,
  directories, and symlinks are never touched. `publish.ts` decides the names from a listing
  (`reportFilesToPrune`, pure) and then deletes them; a listing or delete that fails is skipped and
  never fails the command. `--json` writes nothing, so it prunes nothing.
