---
name: tandem-status
description: >-
  Give a brief evidence-only view of durable Tandem work for the current repository; trigger on
  status/progress questions or /skill:tandem-status.
user-invocable: true
---

# tandem-status

Read durable state once; do not advance work.

## Resolve scope without guessing

The installed `tandem` command is the primary launch/reconnect front door: bare `tandem` opens or
reconnects every valid saved project under the selected home from any cwd, while explicit paths
select only a subset or add/open projects. This status skill is optional and uses the advanced
low-level `src/cli.ts status` action for an evidence-only durable read. Resolve the checkout
independently: use validated `TANDEM_ROOT`, else this skill's real path plus `../../`. If unavailable,
ask where Tandem is installed; never assume `Coding_Projects` or run setup.

This status skill never performs a reset or launch. If a user explicitly asks to cleanly reopen
coordinators, explain that `tandem --reset` is the separate terminal front door: it targets only
selected idle Tandem-owned coordinators, refuses busy or unsafe work before closing panes, and
preserves durable settings, history, tasks, worktrees, and files. It must be run outside Herdr;
`--continue` is optional for resuming saved conversations.

For repository scope, canonicalize an explicit target or cwd to its Git top-level (expand `~`,
resolve relative paths, preserve symlink identity). If unresolved, ask briefly. Explicit all-project
scope skips Git-root resolution and `--repo`.

Home precedence is `--home` > `TANDEM_HOME` > `~/.tandem`; keep it absolute and consistent. The
store is `<home>/tasks/<task-id>.json`. Existence-check home and tasks before invoking, without
creating either. Missing means one sentence: no durable store and no read attempted. Other
filesystem errors are unknown/failed, not empty.

## Communication receipts

This skill reports the task list once; it does not perform a second communication read. In a

managed coordinator, use the `messages` action (or `bun src/cli.ts messages --task TASK_ID`) when
you need per-direction queued, received, or delivered receipts, a worker Question:, a
Recommendation:, or activity metadata. Queued/received/delivered are communication states, not
proof that code changed, and this summary never treats a recorded stage or passive progress as
proof that a live worker is running. Elapsed time alone does not kill a worker; explicit limits and
cancellation remain the controls.

Any task count or stage claim in this summary comes only from that durable read; queued/received/delivered receipts and live activity never establish a running or completed scout.

## Perform one read

When the task directory exists, run exactly once, capture CLI stderr, and preserve the pipeline
exit status with `pipefail`:

```sh
set -o pipefail
bun "<tandem-root>/src/cli.ts" status --home "<home>" --json |
  jq --arg repo "<canonical-repo>" 'map(select($repo == "" or .repoPath == $repo) | {id,repoPath,objective,stage,scopeApproved,blockReason,reportPath,pullRequest,updatedAt})'
```

`status` aliases `list`. The CLI success shape is a raw JSON array; the pipeline emits only the
compact projection. Use the exact canonical `repoPath` as `<canonical-repo>`. For explicit
all-project scope, pass an empty jq argument (`--arg repo ""`) and do not add CLI `--repo`; the
CLI flag does not filter. If `jq` is unavailable, use equivalent in-memory capture/filter/
projection. Never display raw records or policy/review payloads. Nonzero exit or malformed JSON is
failed; JSON errors go to stderr as `{ "error": { "name", "message" } }` (exit 1/2). Preserve
stderr and uncertainty; do not retry with `show`, `doctor`, or another read. Page captured
projected output if needed, never rerun status.

## Reply in 3–5 bullets

Omit empty headings: current work (objective and recorded stage), outcomes (terminal stage,
report/evidence, or PR metadata), blockers/needed decisions (`blockReason`, approval, paused/fix
signals), and next action supported by the record. Include concrete outcomes or unresolved
decisions explicitly stated in the current conversation, labeled as conversation context; chat is
not live-state proof. A successful empty selected array gets one sentence. Never imply `ready`
means merged/delivered or that any stage proves a live worker/process; this read checks neither.
Do not tick, watch, approve, launch, validate, set up, audit, or otherwise mutate anything.