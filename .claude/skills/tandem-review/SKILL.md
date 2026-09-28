---
name: tandem-review
description: >-
  Draft error-analysis annotations over Tandem task traces since the last run, cluster them into a
  short "Tandem health" page in Lavish, and save the developer's keep/reject/edit decisions as the
  next baseline. Trigger on "review tandem traces", "tandem health", "how's tandem doing lately",
  or /tandem-review.
user-invocable: true
---

# tandem-review

An eval loop over Tandem's own task traces, run every ~10 tasks. Method (Hamel Husain / Shreya
Shankar style error analysis): you draft, the human decides. For each task, name the **first**
upstream problem a user would notice — specific, no root-causing — then let the developer
keep/reject/edit each draft note in a rendered page. Never grade Tandem's work as "good"; only
surface what's wrong, or say nothing was found.

**Read-only. This skill never changes Tandem's state.**

- Never modify `~/.tandem` (or `$TANDEM_HOME`) or `state.sqlite`.
- Never run `tandem fix`, `tandem reset`, `tandem update`, `tandem restart`, or `tandem watch`.
- Never answer a task's question or steer a task.
- Allowed: `tandem status [TASK_ID] --json`, `tandem trace [TASK_ID] --json`, `tandem trace --json`
  (cross-task rollup), and — only if the commands above can't enumerate a task's identity — a
  read-only `sqlite3 -readonly 'file:<home>/state.sqlite?mode=ro'` `SELECT`. Never `INSERT`,
  `UPDATE`, `DELETE`, or open the file without `-readonly`/`mode=ro`.
- If a command fails with "Could not acquire repository lock", wait a few seconds and retry, up to
  about 10 times. Never delete, touch, or work around the lock file.

Resolve `<home>` the same way Tandem does: `--home` if the user gave one, `TANDEM_HOME`, the `home`
in `$XDG_CONFIG_HOME/tandem/config.json` (default `~/.config/tandem/config.json`), then `~/.tandem`.

## 1. Find the last batch

```sh
ls ~/.claude/tandem-review/batches/*.json 2>/dev/null | grep -v '\.decisions\.json$' | sort | tail -1
```

The latest file by name (`YYYY-MM-DD.json`) is the previous batch; its `ranAt` is the cutoff. If a
same-named `<date>.decisions.json` file exists next to it, that holds the developer's decisions from
that run (see step 7) — read it too. No batch file at all means this is the baseline run: read every
task Tandem has recorded.

## 2. Enumerate tasks since the cutoff

`tandem status`/`tandem trace` scope to the current directory's repository *only when run inside
one*; run from a plain shell (not a project checkout) so they cover every onboarded project at once:

```sh
tandem status --home "<home>" --json | jq '.tasks | map(select(.createdAt > $cutoff or .updatedAt > $cutoff))' --arg cutoff "<previous ranAt, or omit to take all>"
```

Each entry has `id`, `title`/`objective`, `repoPath`, `kind`, `stage`, `createdAt`, `updatedAt`. This
is your task list. For each task id, read its full record:

```sh
tandem trace TASK_ID --home "<home>" --json     # timeline + rollup: fix rounds, first-pass review, blocked time, cost
tandem status TASK_ID --home "<home>" --json    # stage, block cause, review state
```

`tandem trace --home "<home>" --json` (no id) gives the cross-task rollup if you want the aggregate
numbers directly instead of summing per-task rollups yourself.

**Fallback only if the above can't enumerate task ids** (e.g. you need tasks Tandem's CLI won't
scope to, or the CLI itself is broken): read the tasks table directly, read-only:

```sh
sqlite3 -readonly "file:<home>/state.sqlite?mode=ro" \
  "SELECT id, json_extract(payload,'\$.repoPath'), json_extract(payload,'\$.title'), json_extract(payload,'\$.createdAt'), json_extract(payload,'\$.updatedAt') FROM tasks;"
```

Never write through this connection.

## 3. Annotate each task

For each task, write one specific sentence naming the first upstream, user-visible problem — the
thing a user would notice first, not its root cause. If nothing is wrong, say so; do not invent a
problem to fill a slot. Also capture:

- **facts**: 1-2 short strings, e.g. `"3 fix rounds"`, `"2h10m blocked"`.
- **quote**: one sentence, at most 25 words, lifted from the trace (an event message, finding text,
  or your own summary of it) — not paraphrased into something the trace doesn't say.
- Mark clearly, in your own working notes, which annotations need product judgment (e.g. "should
  this have auto-resumed?") versus which are mechanically obvious (e.g. "6 tasks share the same
  crash cancellation").

## 4. Cluster into ≤5 problems, set status

Group annotations that share a cause into at most 5 problem rows: `{ name, count, source, status }`.
`count` is `null` only for a human-reported ("you") problem with no per-task tally. Compare each
problem's name/cause against the **previous batch's** `problems` list (not the decisions file) to
set `status`:

- `new` — not present in the previous batch.
- `recurring` — present last time too, still happening.
- `fixed` — you have evidence (a merged fix) the cause no longer reproduces since the fix landed.
- `fix merged, unverified` — a fix merged for this exact cause, but no task since has run through
  the affected path to confirm it actually stopped. Put the PR reference in `note` (e.g.
  `"fix merged #245, unverified"`); the page shows `note` instead of the bare status when present.
- `one incident` — a single one-off event (e.g. an infra crash), not a pattern.

Carry over every `source: "you"` problem from the **previous batch's decisions file** (step 7) that
was `keep`d or `edit`ed, even if this batch's tasks don't mention it, until its own note says fixed.
A rejected "you" problem is dropped, not carried forward.

Anything seen only once and not worth its own row: fold into one `alsoSeen` sentence
(`"Also seen once: X; Y; Z."` — write just the `X; Y; Z` part).

## 5. Metrics

- `firstPassReview`: `{num, den}` — of implementation tasks that reached a review verdict this
  batch, how many passed round 1. Sum the per-task rollups' `firstPassReview`.
- `fixRoundsPerTask`: total fix rounds (sum of each task's `fixRounds`) divided by `taskCount`.
- `merged`: `{num, den}` — of implementation tasks, how many reached `merged`.
- `offScopeFiles`: `null` until you have a real measurement (diff size vs. brief scope); do not
  estimate it.
- `briefNoRate`: `null` until you're actually tracking brief approve/reject answers.

## 6. Cards ("needs your call")

Pick up to 4 annotations that need a product judgment call, not something you can decide yourself —
new patterns, ambiguous root cause, or a policy question. Each becomes a `cards` entry: `taskId`
(short, 8 hex chars is enough — just make it match what you'll show in the trace), `title` (the
task's objective), `facts`, `note` (the judgment call, one or two sentences), `quote`, and `trace` (a
small `key: value` map — Project, Outcome, Cost, Category, Detail — for the collapsed full-trace
view; keep values to what you'd actually want to re-read later).

Every other task goes into `noProblem` (`{taskId, title, reason}`, one short reason) or, if a set of
tasks share a distinct fate worth grouping on its own (e.g. all cancelled by the same crash), a
`folded` group (`{label, items}` with the same item shape).

## 7. Render and open

Write the batch:

```
~/.claude/tandem-review/batches/<today YYYY-MM-DD>.json
```

matching the shape in [render.ts](render.ts) (`Batch`). Then render and open it:

```sh
bun .claude/skills/tandem-review/render.ts ~/.claude/tandem-review/batches/<today>.json ~/.claude/tandem-review/pages/<today>.html
lavish-axi ~/.claude/tandem-review/pages/<today>.html
```

`render.ts` validates the JSON (it fails loudly, naming the bad field, if the shape is wrong),
finds the previous dated batch file in the same folder to compute each tile's delta, and writes a
self-contained page.

Report the opened URL/path plus a summary of at most 5 lines: the verdict, the top 1-2 problems, and
how many cards need a decision.

## 8. Collect decisions

The page's "Export decisions" button copies a small JSON object (`{ taskId: { decision, note } }`)
to the clipboard and shows it in a textarea. Ask the developer to paste it back, or — if they say
they clicked Export in a Lavish session you're still attached to — poll for it:

```sh
lavish-axi poll ~/.claude/tandem-review/pages/<today>.html --timeout-ms 30000
```

Once you have it, save it as-is:

```
~/.claude/tandem-review/batches/<today>.decisions.json
```

The next run reads this file (step 1) to drop rejected problems and adopt edited/added notes as
`source: "you"` problems (step 4).
