# PR watch

What PR watch guarantees while it keeps open pull requests moving: which pull requests it watches,
how it reads GitHub, what it does on its own, and when it tells the user.

Code: src/pr-watch/ (`decide.ts` the decision table, `github.ts` every GitHub read and write,
`watcher.ts` the schedule and effects, `store.ts` durable records, `view.ts` the table),
src/service/controller.ts (`prWatch*`), src/main.ts (`tandem watch`), src/terminal/status.ts,
src/extension/notifications.ts (`deliverPrWatchNotices`). Scenarios:
tests/evals/pr-watch-scenarios.test.ts.

## What is watched

| Moment | What happens |
| --- | --- |
| A Tandem task records a pull request (its draft at ready, or a publish) | Watched, tied to the task. |
| `tandem watch <link, owner/repo#N, or N>` or the `pr-watch-start` action | Watched. `N` means a pull request in the current directory's repository (the coordinator's project for the action). |
| `watchAllMyPrs = true` in `<home>/settings.toml` | Every open pull request the signed-in `gh` user authored, across repositories, found with `gh search prs --author @me`. |
| `tandem watch --stop PR`, the `pr-watch-stop` action ("hands off #N") | Stopped. The record stays, so neither its task nor `watchAllMyPrs` picks it up again; watching it by name starts it again. |
| GitHub reports it merged or closed | Done. It stays in the view as ⚪ for the rest of that day. |

A cancelled task's pull request is not picked up. A draft is watched for CI only.

## Durable state

- One row per pull request in the `pr_watches` table of `<home>/state.sqlite`, keyed by
  `owner/repo#N`: why watching started, the task it belongs to, the head last seen with its tree
  and when it was first seen, what the last read found, the current row, the action log, and a
  notification no Tandem has shown yet. A row in an unknown shape fails loudly.
- The poll schedule is one `pr_watch_poll` entry in the metadata table: when GitHub was last read,
  a lease while one Tandem reads it, and a rate-limit wait.
- The records belong to the Tandem home, not a session or coordinator, so any open Tandem picks
  them up. Never edit them by hand.

## Reading GitHub

- One `gh pr view --json` per watched pull request, with state, draft, head and base, mergeable,
  merge state, review decision and requested reviewers, labels, auto-merge, and the status check
  rollup. Checks go through the delivery parser (`parseRemoteCheck` in
  src/delivery/pull-requests.ts), so check runs and commit statuses both count. A skipped or
  neutral check counts as passed; every check is treated as required (the rollup does not say).
- A full page of 100 checks means there may be more: `gh pr checks --json` reads them all.
- The head commit's tree is read (`gh api repos/R/commits/SHA`) only when the head changes.
- Extra reads happen only when the decision asks for them: the base branch's checks (one GraphQL
  call) when a check fails.
- An unreadable pull request (missing SSO authorization, a GraphQL error, no rollup at all) shows
  `⚠ can't read` with GitHub's reason, never "no checks".
- `gh` output naming a rate limit (or HTTP 429) stops the pass, records a 15-minute wait, and the
  header says when the next check is.

## Schedule

- Checks run on the coordinator scheduler tick while any Tandem is open: every minute while a
  watched pull request has CI running or the watcher acted in the last 5 minutes, every 5 minutes
  otherwise, and not at all when nothing is watched (with `watchAllMyPrs`, every 5 minutes to find
  new pull requests). Each process looks at the shared schedule at most every 30 seconds.
- A pass takes a 5-minute lease first; while another Tandem holds it, the others wait. After the
  laptop sleeps, the next tick catches up and the header shows how old the data is.
- Opening the view (`tandem watch`, `tandem status`, or the coordinator's `pr-watch`) runs a pass
  first unless another Tandem holds the lease or GitHub's rate limit is in effect.
- A failed pass never holds up task work: the scheduler records a `pr-watch-failed` diagnostic
  and the next due tick tries again. A failure on one pull request only marks its own row.

## The decision

`decidePrWatch` (src/pr-watch/decide.ts) is a pure function of the GitHub observation, the action
log, and the repository's settings. It either names one extra read it needs or returns the row and
at most one action; the watcher makes the read or applies the action, then records it. Before
acting, the watcher checks the pull request is still watched. First match wins:

| GitHub reports | Action |
| --- | --- |
| Merged or closed | Done (⚪). |
| `mergeable` is `UNKNOWN` | Nothing; GitHub is still computing it. |
| Merge conflict | 🔴 red. |
| Changes requested | 🔴 red. |
| A check pending longer than `stuckAfterMinutes` (from its start, or from when the watcher first saw the head) | 🔴 red, `⏰ stuck`. |
| Checks running | Nothing. |
| A check failed, and fails on the base branch too | Wait, `🧱 main is red`. Once the base passes, the rules below apply. |
| A check failed with a retry left for this code | Empty commit to rerun CI. |
| A check failed again on the same code | 🔴 red, naming the check and linking its CI page. |
| Otherwise | A row saying what it waits on: draft, review (naming requested reviewers), or approved. |

- **Retry budget:** `maxCiRetries` (default 1) per check, per version of the code: the head
  commit's tree. An empty commit keeps the tree, so it spends the budget; a real push changes the
  tree and resets it.
- **Empty commit:** made through the GitHub API with no checkout. Tandem creates a commit with the
  head's tree and the head as its parent, then moves the branch to it with `force=false`. If
  someone pushed in between, GitHub refuses the move, the branch keeps their push, nothing is
  logged, and the next check sees the new head. It works with any CI that runs on push. A pull
  request from a fork is pushed to the fork, which needs write access there.
- The action log records each empty commit: the head and tree it answered, the checks it reran,
  the commit it pushed, and whether the pull request was approved just before.

## The view

```
PR watch · 4 open · checked 5s ago

🔴 #409 refactor-cache   ❌ 15/16   ❌ failing    🙋 test_cache_evict failed twice → https://ci/…
🟢 #420 add-cache        ⏳ 12/16   ✅ approved   🔁 retried e2e/login (flaky?)
⚪ #401 bump-deps        ✅         🎉 merged 11:02
```

- 🔴 needs you · 🟡 waiting on someone else · 🟢 moving · ⚪ done. Red rows come first.
- A red row names the failing check and links its CI page, so the user can decide without opening
  GitHub. Rows name `owner/repo#N` when more than one repository is watched.
- `tandem watch` prints it (`--json` for the structure); `tandem status` adds it below the tasks
  when anything is watched; the coordinator's `pr-watch` action returns it for the coordinator to
  show as-is.

## Notifications

- Only when a row turns red or a pull request merges. The text is stored on the record, and the
  first coordinator to take it shows it with `ctx.ui.notify`, with no model turn; taking it clears
  it, so another open Tandem never repeats it.

## Settings

- `watchAllMyPrs` lives in `<home>/settings.toml` (see [policy.md](policy.md#where-settings-live)).
- Until `[merging]` settings exist, every repository uses `maxCiRetries = 1` and
  `stuckAfterMinutes = 60`.
