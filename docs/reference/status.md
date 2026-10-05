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

One view across every onboarded project. The Running section groups tasks beneath their project;
other rows name the project inline. No row shows a task ID.

```
 tandem   tandem, tagalingo · PRs checked 40s ago

NEEDS YOU 4 ──────────────────────────────────────────────────────────────────────────────
🙋 tandem     Dark mode                    brief waiting for approval
🙋 tagalingo  Refactor cache               question: keep the old eviction order?
🙋 tandem     Retry research               blocked: reviewer timed out twice
🔴 tagalingo  acme/app#409 refactor-cache  🙋 test_cache_evict failed twice → https://ci/…

RUNNING 3 ────────────────────────────────────────────────────────────────────────────────
  tagalingo
  ⏸️ paused · 2h  Dark mode tokens

  tandem
  🔍 researching · 3m  Research retry policy
  🔨 implementing · 12m  Fix the flaky login

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
| Running | Tasks paused by the user, queued, researching, implementing, checking, in review, or fixing findings, grouped by repository path. Groups sort by project name and path; tasks sort by workflow stage, objective, and task ID. Each task shows the time since it was created, or `idle 42m` once its worker's receipt shows no progress for over 5 minutes (heartbeats do not count). Left out when empty. |
| PRs | Every other watched pull request, as PR watch's rows with `owner/repo#N`. Left out when empty. |
| This week | One line for the 7 days before now, across every project: tasks whose timeline last moved them to completed or merged in that window, how many of those that went through review passed it the first time, and what those tasks cost. Left out when none finished. |

- The header names the projects and how long ago PR watch last read GitHub ("PRs not checked
  yet" before the first read).
- Each section title carries its row count and a rule as wide as its widest row. PRs have column
  headers; a pull request's checks show as an 8-cell bar of passed out of all checks when PR watch
  has the counts, otherwise its checks text (`no CI`, `⚠`).
- Running groups tasks by repository path, orders projects by name and path, and sorts each
  project's tasks by workflow stage, objective, then task key. Duplicate basenames include a
  distinguishing repository path suffix in the heading. Each project has one dim heading and one
  blank line separates project groups.
- Running task rows show stage and elapsed time before the objective. On a terminal, objectives
  wrap to at most two lines at the available width; overflow ends with `…`.
- Columns are measured in terminal cells (`Bun.stringWidth`), so emoji take two.
- On a terminal, text is colored by meaning: yellow waits on the user (section title, brief and
  approval rows, `question:`), red failed (`blocked:`, red pull requests, failing checks), cyan and
  blue are work in progress, magenta is checking or review, green is done or passing, and the
  header's extras, project headings, times, and footer are dim. Paused and queued stages and
  descriptions are dim. Other rows are cut with `…` so they never wrap.
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
  when the rendered text changed. It reads the terminal's width each round, so the Running grouping
  and wrapped descriptions refit after a resize. The code version is read once. A round that finds
  the state lock held by another Tandem is skipped.
- Runs until Esc, q, or Ctrl-C when its input is a terminal (read in raw mode, so arrow keys do
  nothing), and until Ctrl-C otherwise. Closing cuts the wait between redraws short, so it exits at
  once. Esc and q are what close it in Herdr's popup, which receives every key, including Herdr's
  prefix, until its command exits. It takes no task ID, `--json`, `--logs`, or `--line`.

## In Herdr: the panel, the tab bar, and the keys

- Each coordinator's workspace has the panel (`tandem panel`, below) split 46 columns wide to the
  right of its chat; see [coordinator.md](coordinator.md#the-panel-beside-each-coordinator). Herdr's
  sidebar starts hidden, so the panel is how you reach projects and workers; `prefix+b` shows the
  sidebar again. Closing the panel loses nothing: `prefix+t` opens the same panel as a popup
  anywhere, and running `tandem` puts the split back.
- Keys, all through Herdr's prefix so they work inside a worker too:

  | Key | Does |
  | --- | --- |
  | `prefix+t` | The panel as a popup (90% by 90%), on the focused project; Esc closes it |
  | `prefix+0` | This project's coordinator chat |
  | `prefix+,` `prefix+.` | The previous or next project with an open coordinator, wrapping |

  `prefix+h`, `prefix+1`-`9`, and `prefix+[` are Herdr's own (focus left, switch tab, copy mode),
  so Tandem leaves them alone. `prefix+0`, `prefix+,`, and `prefix+.` run the `tandem.ui` plugin
  actions `home`, `project-prev`, and `project-next`, which run `tandem panel home|prev|next`.
- "This project" is the one Herdr's focus is in: the project whose coordinator, or running task's
  primary worker, owns the focused workspace (`HERDR_ACTIVE_WORKSPACE_ID` for popups,
  `workspace_id` in `HERDR_PLUGIN_CONTEXT_JSON` for actions and plugin panes), else the project
  containing the focused pane's directory (`focused_pane_cwd` in the same context, or
  `HERDR_ACTIVE_PANE_CWD`), else the first project. A coordinator's own panel is told its project
  with `TANDEM_PANEL_PROJECT`. `TANDEM_REPO` and `HERDR_WORKSPACE_ID` are not used: the Herdr
  server inherits the first coordinator's. With no open coordinator in the focused project, next
  goes to the first open project and prev to the last. A key that finds
  nowhere to go exits non-zero with the reason on stderr, which Herdr keeps in its plugin log.
- `tandem status --line` prints one line for Herdr's tab-bar status area (`ui.tab_bar_right`):
  `● N need(s) you`, counting Needs you rows across every project, or `✓ nothing needs you`. The
  panel shows the rest. It reads saved state like `tandem status` (never GitHub, no footer, no git
  call) and takes no task ID, `--json`, `--logs`, or `--watch`.
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
    seconds with a 10-second timeout, `sidebar_start_collapsed = true` and
    `sidebar_collapsed_mode = "hidden"` under `[ui]` (the start setting applies when Herdr next
    starts), `[ui.toast]` with `delivery = "herdr"` (Herdr's notifications are off by default), a
    `[[keys.command]]` popup on `prefix+t` (90% by 90%) running `panel --popup`, and
    `plugin_action` bindings for `prefix+0`, `prefix+comma`, and `prefix+period`. Commands use
    absolute paths to Bun and `src/main.ts`, because Herdr runs them through `/bin/sh -lc`, whose
    PATH may not include Bun's bin directory;
  - leaves the user's settings alone: an existing `tab_bar_right`, either sidebar key, a `ui` set
    without a `[ui]` table, a config that mentions toasts at all (including `off`), or another
    binding on any of its keys is skipped, and it prints the line to add by hand. An existing
    `[ui]` table gets entries inserted under its header; otherwise a `[ui]` table is appended.
    Entries already running `status --line` or `panel --popup`, or naming a `tandem.ui` action,
    count as done, so re-running adds nothing. The one `[[keys.command]]` block an earlier Tandem
    wrote, on `prefix+t` with exactly a quoted Bun then this checkout's quoted `src/main.ts status
    --watch`, has its command replaced by `panel --popup` and its `Tandem status` description by
    `Tandem panel`, in place. Any other `status --watch` binding is the user's;
  - names what it would add in one question (like "Add Tandem's tab bar, hidden sidebar, prefix+t
    panel, and prefix+0 prefix+comma prefix+period keys to Herdr?") and writes nothing without a
    terminal to ask in or a yes. Parts already there print
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
    which holds the welcome popup, the panel pane, and the key actions; see
    [coordinator.md](coordinator.md#the-tandem-coordinator)) with
    `herdr --session <session> plugin link` after asking "Add Tandem's welcome popup and panel to
    Herdr?". A plugin already in `herdr plugin list` counts as done: Herdr reads a linked
    plugin's manifest from its directory on each use, so an update's new panes and actions work
    without relinking or reloading (checked on Herdr 0.9.1). No terminal or a no links nothing.
    The welcome pane keeps running `welcome.sh`, which manifests linked before the panel name;
    new entries run `tandem.sh`.

## `tandem panel`

A narrow live view of one project (about 46 columns) that navigates instead of only showing.
Code: src/board/snapshot.ts (the file), src/board/panel.ts (pure view model),
src/terminal/panel.ts (keys, mouse, Herdr commands, drawing). Tests: tests/board/panel.test.ts,
tests/board/snapshot.test.ts, tests/terminal/panel.test.ts.

- Every coordinator reconcile reads the board once, uses it for the notification below, and
  writes it with its session's coordinator records to `<home>/board-snapshot.json` (temp file and
  rename; `version: 1`). A failed write never blocks the reconcile and is logged once until a write
  works again. Panels read only that file, every second, and redraw on change; they never take the
  state lock.
- The footer says why the panel may be out of date: `⚠ no status yet` before any snapshot,
  `⚠ can't read state, retrying` when the file cannot be read, and, once the snapshot is over 10
  seconds old, `⚠ updated 43s ago · no coordinator running` (or `· can't read state, retrying`).
- Top to bottom: one chip per project (number, name, how many need you, `offline` without a
  coordinator record), `2 need you · 4 running`, then Needs you, Running, Pull requests, and Done
  today (tasks completed or merged in the last day). Empty sections are left out; with nothing
  needing you or running it says `✓ All quiet.`. A running task with a watched pull request shows
  only as the pull request, and a task done today only as its Done row.
- A blue `•` marks rows whose stage or words changed since the panel last lost focus; elapsed
  times do not count. What was seen covers every project, so searching or switching marks nothing.
- Running rows use the stage words `tandem status` uses; a ready task's stage reads
  `ready to publish`. Second lines, each from what Tandem already saved, with the row's
  `tandem status` words when that is missing:
  - A brief: `brief: <size> change`, the brief's own size rating, then `no review` when the user
    chose that while planning, or the review level its task recorded (`light review`,
    `standard review`). The level is usually unknown before approval and is then left out.
  - A ready task: `draft PR #421` (or `PR #421`) from the task's pull request record.
  - A stop: the block cause in plain words from one table in src/board/panel.ts (`a review
    failed`, `out of fix rounds`), else the block reason the site wrote, prefixed
    `stopped after 2 restarts:` when recovery spent restarts on the task's current generation.
  - Fixing after review: `review found 2 issues · fixing them`, counting open ledger findings that
    block at the task's review level.
  - The question itself, `waiting for a free worktree` (queued), `paused by you`, `for 12m`, the
    PR's watch note.
  - A running row whose worker made no progress for 5 minutes turns yellow and reads
    `no progress for 6m`. It never says Tandem is restarting the worker: nothing records that
    recovery noticed a quiet worker that is still alive.
- A running row whose worker is in a tool also shows `▸ <verb> <target> · <age>`, like
  `▸ edit src/auth/session.ts · 4s`, from the primary worker's display-only activity file (see
  [control.md](control.md#message-receipts)). Verbs are plain for both harnesses' tool names
  (`read`, `edit`, `write`, `run`, `search`); any other tool shows its lowercased name. The age
  runs from the tool's start to the snapshot's time. A target too wide for the panel is cut from
  the left with `…`, so the file name stays. An implementing row puts its current step first: the
  to-do in progress, else the next pending one. Other running rows show only the tool line while
  a tool runs. `no progress for 6m` replaces the step; a row never shows more than two lines.
- Keys: `j`/`k`/arrows move, `Enter` goes, `Space` shows or hides the selected running row's step
  checklist (`☑` done, `▸` in progress, `☐` to do, `☒` dropped), `/` searches, `1`-`9` and `[` `]`
  switch project, `Esc` closes a `--popup` or clears a search, Ctrl-C closes. Clicking a chip
  switches; clicking a row selects it; double-clicking goes. The selection follows its task across
  stage changes. A key help box shows until `x` or the first key, remembered by
  `<home>/panel-keys-seen`. An escape sequence split across reads waits 50ms for its rest before
  it counts as `Esc`.
- When the rows are taller than the terminal, they scroll to keep the selection in sight; the
  chips, summary, and footer stay put.
- Going: Needs you and Done rows focus the project's coordinator, running rows with a live
  primary worker focus that worker's pane, pull requests `open` in the browser; queued and paused
  rows go nowhere. Focusing runs `herdr --session <session> workspace focus <workspace>` then
  `agent focus <pane>`; the second may fail (Herdr focuses only panes it knows run an agent) and
  the workspace focus still counts. Switching project focuses that coordinator's workspace. A
  `--popup` exits after a successful go or switch. A go or switch that cannot get there says so
  in the footer (`⚠ no coordinator is open for that project`, `⚠ Herdr couldn't focus it`,
  `⚠ couldn't open the link`) until the next key.
- Search matches every word as a prefix of a word in the row's name, stage, kind (`needs you`,
  `stuck`, `review`, `pr`, `queued`, `done`, `running`), or project, across every project, grouped
  under project headings. Query and rows split into words the same way, so `#412`, `fix-auth`,
  and `acme/app` match.
- SIGTERM, SIGHUP, and drawing errors close the panel the same way Esc does: the terminal leaves
  raw mode, mouse reporting, and the alternate screen before the process ends.
- Without a terminal to read keys from, it draws once and exits.

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
