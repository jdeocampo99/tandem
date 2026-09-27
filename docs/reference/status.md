# Status

What `tandem status` shows across projects, where its data comes from, its live view, its
one-line form in Herdr's tab bar, and the Herdr notification when something new needs you.

Code: src/board/ (`view.ts` sections and the chat rendering, `terminal.ts` the terminal
rendering, `read.ts` the state read and live loop), src/terminal/status.ts (the footer's
data), src/main.ts (`tandem status`), src/session/coordinator.ts (`notifyOnArrival`),
src/session/prompt-routing.ts (the `board` lookup), src/terminal/herdr-setup.ts (the Herdr
config that setup.sh adds). Tests: tests/board/,
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
| Needs you | Briefs whose current draft is not approved (new, or changed after approval); tasks with an open question; tasks stopped on a model (routing) question for their current generation, shown as `model question: keep <model>? <why>` instead of their running stage; tasks awaiting approval, blocked (with the reason), or ready; pull requests PR watch marked red. Always shown; "Nothing needs you." when empty. |
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

- The weekly line is computed on read from each task's timeline and the usage ledger scope that
  holds its work (its request's, or its own task scope without one)
  (see [task-lifecycle.md](task-lifecycle.md#timeline-and-trace)),
  through `taskRollup`, `taskCost`, and `summarizeRollups` in src/tasks/trace.ts. Only completed
  or merged tasks updated in the last 7 days have their timeline read. A task with no recorded
  work has no recorded cost; usage with no price shows as "+ unpriced usage".

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
- Runs until Esc, q, or Ctrl-C when its input is a terminal (read in raw mode, so arrow keys do
  nothing), and until Ctrl-C otherwise. Closing cuts the wait between redraws short, so it exits at
  once. Esc and q are what close it in Herdr's popup, which receives every key, including Herdr's
  prefix, until its command exits. It takes no task ID, `--json`, `--logs`, or `--line`.

## In Herdr: the tab bar and `prefix+t`

- `tandem status --line` prints one line for Herdr's tab-bar status area (`ui.tab_bar_right`),
  like `🙋 3 need you · 🔨 2 running · 🔴 1 🟡 1 🟢 1`:
  - `🙋 N need(s) you` counts the Needs you rows, or `✓ nothing needs you` when there are none;
  - `🔨 N running` counts Running rows other than paused ones, and is left out at zero;
  - the dots count pull requests by PR watch color (red ones come from Needs you), each left out
    at zero;
  - with nothing needing you, running, or watched it prints `✓ all quiet`.
  Herdr strips colors there, so emoji carry the meaning. It reads saved state like `tandem status`
  (never GitHub, no footer, no git call) and takes no task ID, `--json`, `--logs`, or `--watch`.
  A locked state or any other error exits non-zero with nothing on stdout, and Herdr clears the
  entry until the next run.
- `setup.sh` runs src/terminal/herdr-setup.ts, which:
  - updates Herdr when `herdr --version` is older than 0.8.2, the first release with command
    entries in the tab bar (popup keybindings arrived in 0.7.4): `brew upgrade herdr` when the
    binary resolves under Homebrew, `herdr update` otherwise, showing its output only if Herdr is
    still too old afterwards. A
    mise or Nix install is left to its package manager with a message; setup stops if Herdr is
    still older;
  - plans additions to `$XDG_CONFIG_HOME/herdr/config.toml` (default `~/.config/herdr/`; one file
    for every Herdr session): a `tab_bar_right` command entry running `status --line` every 5
    seconds with a 10-second timeout, `[ui.toast]` with `delivery = "herdr"` (Herdr's
    notifications are off by default), and a `[[keys.command]]` popup on `prefix+t` (90% by 90%)
    running `status --watch`. Both commands use absolute paths to Bun and `src/main.ts`, because
    Herdr runs them through `/bin/sh -lc`, whose PATH may not include Bun's bin directory;
  - leaves the user's settings alone: an existing `tab_bar_right`, a `ui` set without a `[ui]`
    table, a config that mentions toasts at all (including `off`), or another binding on
    `prefix+t` is skipped, and it prints the line to add by hand. An existing `[ui]` table gets
    the entry inserted under its header; otherwise a `[ui]` table is appended. Entries already
    running `status --line` or `status --watch` count as done, so re-running adds nothing;
  - names what it would add in one question (like "Add Tandem's tab bar and prefix+t popup to
    Herdr?") and writes nothing without a terminal to ask in or a yes. Parts already there print
    nothing; parts left to the user print one line each with what to add. It copies the old file to `config.toml.before-tandem`, and if `herdr config check`
    passed before and fails after, it writes the old file back;
  - then, on every run, applies the config to the Herdr session Tandem uses (resolved like
    `tandem` does: `TANDEM_SESSION`, Herdr's session variables, the remembered setup, then
    `tandem`), read with `herdr --session <session> status server`:
    - not running: it reads the config when `tandem` next starts it;
    - running Herdr 0.8.2 or newer: `herdr --session <session> server reload-config` (plain
      `herdr server reload-config` would reach only the default session);
    - still running an older Herdr, which an update does not replace: only a restart helps, and
      it closes the session's panes. Setup offers `herdr session stop <session>` only when it
      runs outside that session, the board shows no running task (a board it cannot read counts
      as busy), and the user says yes; then the user runs `tandem` to reopen projects.
      Otherwise it prints the command to run later.
  - then, whatever happened above, links Tandem's Herdr plugin (`herdr-plugin/`, id `tandem.ui`,
    which holds the welcome popup; see [coordinator.md](coordinator.md#the-tandem-coordinator))
    with `herdr --session <session> plugin link` after asking "Add Tandem's welcome popup to
    Herdr?". A plugin already in `herdr plugin list` counts as done; no terminal or a no links
    nothing.

## The notification when something new needs you

- On each scheduler reconcile, a coordinator reads the board and keeps the keys of the "Needs you"
  rows that belong to its own project (a pull request belongs to its task's project, or to the
  checkout it was watched from) and that `notifiesUser` accepts: briefs awaiting approval, task
  questions, model questions, red pull requests, and tasks awaiting approval or ready.
- When keys appear that were not there on the last reconcile, it sends one
  `herdr notification show` for all of them, with Herdr's needs-input sound. One new row reads
  `Tandem: <name>` over `<reason> · prefix+t for status`; several read
  `Tandem: N things need you` over their names.
- Blocked tasks stay listed but never notify: recovery restarts most blocks on its own.
- Rows already there when the coordinator started count as seen, so a relaunch or `tandem update`
  notifies nothing.
- Herdr delivers it through the user's `[ui.toast]` setting (in-app toast, system or terminal
  notification, or off), and skips it for the tab the user is looking at. Without a coordinator
  pane (no Herdr context) nothing is sent. A failure is logged and never blocks the reconcile.

## "How's it going?"

- With Jev prompt routing on, a message Jev confidently classifies as asking how things are going
  overall runs the read-only `board` action without a coordinator turn. In OMP chat, it shows the
  same colored, column-fitted status sections as `tandem status`, using the terminal board formatter
  at the chat width; the CLI adds its own footer, which chat omits. A live-view pointer follows the
  board. If the host cannot render custom status messages, the Markdown board remains the fallback.
  If Jev fails or is unsure, the message goes to the coordinator as before (see
  [policy.md](policy.md#jev-prompt-routing)).
- The coordinator's `board` action uses that same colored status message and tells the model not to
  repeat the rows. `renderBoard` remains the shared Markdown fallback for hosts without the custom
  renderer.
