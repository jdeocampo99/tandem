# Tandem panel PRD

**Status: proposed.** Interactive mockup: https://claude.ai/artifact/QNLd6MVPQ1eTXghaHMhehg

## Goal

See what every agent is doing right now, and get to anything in one key, without spending
coordinator tokens or opening an agent's pane to ask.

## Who does what

| Surface | Job |
| --- | --- |
| Coordinator chat | Ask and decide. Approvals, answers, steering, and publishing stay here |
| Tandem panel | See and navigate: switch projects, watch agents, jump to workers and PRs |
| Browser and Lavish | Read rich things: briefs, mockups, PRs, diffs, `tandem report` |
| Agent pane | Dig in and talk to one agent |
| Tab bar and toast | Interrupt only when something needs you |

The panel never approves, answers, or publishes. `AGENTS.md` gives approvals to the main
conversation, and the chat sits beside the panel.

## Layout

- The panel is a Herdr plugin pane, about 46 columns, split to the right of each coordinator's chat.
- One panel per project, showing only that project. Coordinators stay one per project.
- Herdr's sidebar starts hidden, so the panel is how you reach projects and workers. `prefix b`
  (Herdr's own toggle) shows it again.
- In a worker, the agent gets the full width. `prefix t` opens the same panel as a popup.
- The tab bar line is trimmed to the count across all projects: `● 2 need you` or
  `✓ nothing needs you`.

## What the panel shows

From the top:

1. **Project row.** One chip per project with its number and the count that needs you there.
   The current project is outlined; an offline coordinator is dashed and says `offline`.
2. **Summary.** `2 need you · 4 running`.
3. **Needs you**, **Running**, **Pull requests**, **Done today**. Empty sections are left out.
   With nothing needing you or running, the panel says `✓ All quiet.`

Every row is a name, a stage, and at most two short lines in plain words. No fractions, task IDs,
worktrees, pane names, or models.

| Row | Second line |
| --- | --- |
| Brief to approve | `brief: 3 files · standard review` |
| Question | The question itself |
| Ready to publish | `ready to publish · draft PR #421` |
| Stopped | The cause in plain words: `stopped after 2 restarts: reviewer timed out` |
| Implementing | The current playbook step, then `▸ edit src/auth/session.ts · 4s` |
| Researching, reviewing | `▸ read docs/reference/recovery.md · 2s` |
| Fixing after review | `review found 2 issues · fixing them` |
| Checking | `running checks · bun test` |
| Stuck | `stuck 6m · Tandem is restarting it` (yellow: noticed and handled) |
| Queued | `waiting for a free worktree` |
| Paused | `paused by you` |
| Pull request | Who acts next: `re-running a flaky check`, `merges when the last 4 checks pass`, `waiting on @alice · 2d` |
| Done | `notes ready in chat`, `merged` |

- A task that opens its draft PR leaves Running and becomes a PR row, so the same work never shows
  twice. A red PR moves up to Needs you. Done rows clear after a day.
- Yellow waits on you or is being handled, red needs you because something failed, blue is
  working, magenta is checking or review, green is done. Every color has a glyph too.
- A blue `•` marks rows that changed since you last focused the panel.
- When the panel cannot read state, the footer turns yellow: `⚠ updated 43s ago · can't read state, retrying`.
- Hovering a task name in the chat highlights its row (later).

## Keys

Plain keys belong to whatever has focus. Prefix keys (Herdr's prefix, `ctrl+b` by default) work
anywhere, including inside a worker, where plain keys go to the agent.

| Anywhere | Does |
| --- | --- |
| `prefix t` | Panel popup |
| `prefix h` | Home: this project's coordinator |
| `prefix 1`-`9`, `prefix [` `]` | Switch project |

| In the panel or popup | Does |
| --- | --- |
| `j` `k`, arrows | Move |
| `Enter`, double-click | Go: needs-you rows focus the chat, running rows open the agent, PRs open in the browser |
| `Space` | Show or hide a task's step checklist |
| `1`-`9`, `[` `]` | Switch project |
| `Esc` | Close the popup |

- A click on a project chip switches, like a tab. A click on a task row only selects it, so a
  click to focus the pane never pulls you out of the chat.
- On first run the panel shows these keys in a box that hides after first use or on `x`.

## Data

| Signal | Source | Exists |
| --- | --- | --- |
| Sections, stages, PR rows, weekly numbers | `readBoard` in src/board/read.ts | Yes |
| Phase, tool name, last progress | Worker receipt (`touchedReceipt` in src/workers/control-protocol.ts) | Yes |
| Stuck, restarts, block cause | Receipt age, task record, recovery | Yes |
| Current playbook step | The implementer's `todo` list | No: the worker writes it to a sidecar file |
| Tool target (file, command, query) | Tool call arguments | No: same sidecar |
| Brief size and review level | Brief record | Yes |

- One process writes a board snapshot file; every panel and the popup read the file. Panels never
  take the state lock, so N panels cost nothing.
- The sidecar is a projection, never task state, like `communications/<task>/inbox.json`.
- The panel's view model is pure and shared with `tandem status`, so both use the same words.

## Herdr integration

- `tandem.ui` gains a `split` pane for the panel, a `popup` pane for `prefix t`, and keybindings for
  `prefix h`, `prefix 1`-`9`, and `prefix [` `]`.
- `setup.sh` adds `sidebar_start_collapsed = true` and `sidebar_collapsed_mode = "hidden"` under
  `[ui]` in Herdr's config through src/terminal/herdr-setup.ts, the same way it adds the tab bar and
  popup: it asks first and leaves any existing value alone. The start setting applies on Herdr's
  next launch, so a running session keeps its sidebar until Herdr restarts.
- Tandem opens the panel in each coordinator workspace.
- Closing the panel loses nothing. `prefix t` and running `tandem` bring it back. It never respawns
  on its own.
- Retiring a coordinator closes its panel too, or the panel would keep the workspace alive.
- `tandem fix` classifies panel panes as Tandem UI so they are never reported as unknown.

## Build order

1. Panel v1 on today's data: sections, rows, `Enter` navigation, project row, popup, keys.
2. Snapshot file and the worker sidecar (step and tool target).
3. Brief size, review outcome wording, ready to publish, plain-language stops, offline coordinator,
   first-run keys.
4. Later: mockup-ready rows, PR-review rows, catch-up summary after time away, cost on Done rows,
   "Tandem fixing itself" label, chat-mention highlighting.

## Not in v1

- Approving, answering, or steering from the panel.
- A panel in every worker workspace.
- Moving workers into tabs of the coordinator workspace. The hidden sidebar makes this unnecessary.
- A web or desktop UI.

## Open questions

- Can a plugin `split` pane be opened in a chosen workspace, and can a plugin focus another
  workspace's pane? The design depends on both.
- Does Herdr have a "previous workspace" command, or does `prefix h` need its own lookup?

## Automated checks

- The view model maps every task state in the table above to its row, from fixed board fixtures.
- `Enter` resolves to the right target for each row kind; queued rows have none.
- A project with nothing running renders `✓ All quiet.`; an unreadable snapshot renders the stale
  footer.
- Panels read only the snapshot file and never take the state lock.

## Manual checks

- With two projects, switch by chip, `1`-`9`, `[` `]`, and `prefix` keys from the chat.
- Inside a worker, `Esc` reaches the agent; `prefix h` returns home; `prefix t` opens the popup and
  `Enter` there jumps to another worker.
- Close the panel by accident and bring it back with `prefix t`.
