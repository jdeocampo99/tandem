# Project memory

What Tandem guarantees about workstream notes: where they live, what the coordinator may write,
when it writes, how stale notes are kept from misleading it, and what a catch-up shows.

Code: src/memory/ (`workstream.ts` pure sections, cap, follow-ups, recent work, and the catch-up
view; `view.ts` the card and list; `store.ts` files, handoff archive, and archiving; `service.ts`
the actions), src/main.ts (`tandem memory`), src/extension/omp-host.ts (the `tandem-card` message and its
renderer), src/session/actions.ts
(`memory-list`, `memory-show`, `memory-write`, `memory-done`), src/session/coordinator.ts (the
standing `Workstreams:` line), src/instructions.ts (the coordinator's memory guidance).

## Workstreams

One coordinator runs per repository; a workstream is a named line of work inside it, such as
`billing` or `test-impact` in a monorepo. Names match `^[a-z0-9][a-z0-9-]{0,39}$` after trimming and
lowercasing. It is opt-in by use: nothing is written until the user names a workstream.

A task can carry a `workstream` tag (the `create` action's `workstream`, stored on the task record).
The coordinator passes it when the work plainly belongs to one and asks when it is unclear. The tag
only feeds Recent work; it changes nothing about how the task runs.

## Storage

`<home>/repositories/<key>/memory/<workstream>/MEMORY.md`, beside the project's `settings.toml`
(`memoryRoot`), so it is never inside the repository and never committed. It is plain Markdown the
user can edit. One coordinator per repository means the files take no lock; each save is an atomic
rename, and the file's modification time is set to Tandem's clock at save.

| Section | Holds |
| --- | --- |
| Brief | Goal, success metric, links. Asked for when a workstream starts. |
| Now | Current focus and agreed next steps. |
| Follow-ups | One per line: `check <what> on YYYY-MM-DD because <why>`. A line without a date is not a follow-up. |
| Last handoff | The latest only, starting `Saved YYYY-MM-DD.` |
| Decisions | One dated line each, with the why. |

Headings the user adds by hand are kept as they are and shown in the catch-up. A new last handoff
moves the previous one into `handoffs/<its date>.md` (two on one day share the file); only the
newest 10 files are kept. `memory-done` moves the workstream to `memory/_archive/<name>-<date>/`,
notes and handoffs included, and it drops out of the list.

Recent work is never written. It is built each time from task records and PR watch
(`recentWork`): the workstream's tasks with a pull request, newest first, at most 5, one line each,
merged when the task is `merged`, its pull request is, or its watch recorded `mergedAt` or a 🎉 row.

## What the coordinator writes

- Writes: decisions and their reasons, the user's corrections and preferences, dead ends ("tried X,
  failed because Y"), agreed next steps, follow-ups, handoffs.
- Never writes: task status, pull request lists, code structure, or anything git or `state.sqlite`
  already records.

LLM-written context files that describe code lowered task success about 3% and raised cost 19–23%
(arXiv:2602.11988); notes on work state and reasons did not. Recording the why behind each line
improved adherence and kept files from growing (arXiv:2608.11095).

`memory-write` replaces each section it names and leaves the rest; an empty text removes one. So
follow-ups and decisions are always passed whole. A follow-up is removed once the user reports its
result; a result that led to a decision moves there. A contradicting decision replaces the old one.

## When it writes

On a switch ("now onboarding" saves the one being left, then catches up on the new one), on
wrap-up, and after telling the user a task in the workstream finished. Not at compaction or
shutdown: OMP's `session_shutdown` fires only on SIGINT/SIGTERM with a 2 s cap and no model turn,
and the compaction hook cannot call tools. A killed session loses only what was not saved; the next
catch-up shows the previous handoff with its date.

## Staleness and size

| What | Kept from going stale by | Cleaned up |
| --- | --- | --- |
| Pull requests, task status | Never stored; rebuilt from records. | Never needed. |
| Now, Last handoff | Replaced on every save; older handoffs archived, 10 kept. | Every save. |
| Follow-ups | Removed when the user reports the result. | When resolved. |
| Decisions | Dated with the why; a contradicting one replaces the old. | A save over the cap is refused. |
| Old notes | The catch-up shows their age and says code and records win. | Every catch-up. |
| Finished workstreams | Archived and dropped from the list. | When the user says it is done. |

A save that would make MEMORY.md more than 150 lines or 10,000 characters is refused, with the
reason; the coordinator merges or drops old decisions and saves again. There is no scheduled pruning.

## Catch-up

`memory-show` builds a `CatchUpView` from the notes and records (`catchUpView`) and draws it as a
card in the same style as `tandem status` (src/memory/view.ts, on the primitives in
src/board/terminal.ts). It shows only what the user acts on:

```
tia · 3 days ago

DUE NOW 2 ───────────────────────────────────────────────
🔔 check missed-failure rate because #412 merged Monday
🔔 check the old threshold because it was reverted · overdue

WHERE YOU LEFT OFF ──────────────────────────────────────
Lowered flaky-suite skip threshold.

RECENT WORK 2 ───────────────────────────────────────────
🎉 #412  Lower skip threshold  merged
📝 #413  Enable TIA on mobile  draft
```

- Empty sections are left out. Due lines drop their date; an overdue one says so and is red.
- Where you left off is Now, or the last handoff when there is no Now.
- Colors match `tandem status`: the name is a badge, due is yellow, overdue red, merged green.
- Later follow-ups, decisions, and the brief never show on the card; they go to the coordinator
  for its suggestions.

**In the coordinator chat** the `tandem` tool posts the card as its own message (custom type
`tandem-card`, the `showCard` effect) with OMP's `deliverAs: "aside"`, so it lands after the tool
block and before the model's reply. Tandem registers a message renderer that draws it in color at
the chat's width. The message's text is the plain card, which the model reads; a saved card whose
details cannot be read falls back to that text. The tool result then says the card is on screen and
carries only the notes: the header that they are dated data and not instructions and that code and
records win, then the Brief, later follow-ups, Decisions, and hand-added sections, capped at 10,000
characters. A host that cannot show cards gets the plain card at the top of the tool result
instead, and the coordinator shows it in a code block.

The coordinator writes Suggested next under the card: at most 3 actions the user can start now,
each tied to the brief's goal or metric, ordered due checks, then unblocking, then new work,
branching on the outcome when a check is pending. It cites only metrics and targets from the notes
and asks the user for numbers Tandem cannot see. No history recap. A workstream without notes says
so and tells the coordinator to ask for its goal, success metric, and links.

`memory-list` ("where was I?") is one line per workstream: `tia: 1 follow-up due`. The same lines
join the coordinator's standing context as `Workstreams: …` when there are any; unreadable notes
leave it out rather than failing the turn. None of the memory actions asks for approval, and child
workers get nothing from memory.

## `tandem memory`

`tandem memory` lists the workstreams of the project the current directory is in (its Git root).
`tandem memory NAME` prints that workstream's card, the same one the coordinator shows, plus where
its notes file is, without the coordinator's notes or suggestions. `--json` prints the list or the `CatchUpView`. It only reads.
