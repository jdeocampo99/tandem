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
| A Tandem task records a pull request (its draft at ready, or a publish) | Watched, tied to the task. A draft is watched for CI only and never queued. |
| It is published (draft to ready; Tandem's `publish` marks its draft ready) | Also merged: auto-merge is armed or the queue label added. |
| `tandem watch <link, owner/repo#N, or N>` or the `pr-watch-start` action | Watched. `N` means a pull request in the current directory's repository (the coordinator's project for the action). |
| `watchAllMyPrs = true` in `<home>/settings.toml` | Every open pull request the signed-in `gh` user authored, across repositories, found with `gh search prs --author @me`. |
| `tandem watch --stop PR`, the `pr-watch-stop` action ("hands off #N") | Stopped. The record stays, so neither its task nor `watchAllMyPrs` picks it up again; watching it by name starts it again. |
| GitHub reports it merged or closed | Done. It stays in the view as ⚪ for the rest of that day. |

A cancelled task's pull request is not picked up. Whether to merge follows GitHub's draft flag on
every read, so a pull request watched by name merges once it is not a draft.

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
  call) when a check fails, the files both sides changed (two compare calls) on a conflict, and the issue events (label and auto-merge changes, with who made
  them) when the pull request left the queue. Whether the repository has `.aviator/config.yml` is
  read once per watch, and only when its settings do not name `mergeWith`.
- An unreadable pull request (missing SSO authorization, a GraphQL error, no rollup at all) shows
  `⚠ can't read` with GitHub's reason, never "no checks".
- `gh` output naming a rate limit (or HTTP 429) stops the pass, records a 15-minute wait, and the
  header says when the next check is.

## Schedule

- Checks run from the coordinator scheduler tick while any Tandem is open, without holding the tick
  up (a check already running in the process is joined, and shutdown waits for it): every minute while a
  watched pull request has CI running or the watcher acted in the last 5 minutes, every 5 minutes
  otherwise, and not at all when nothing is watched (with `watchAllMyPrs`, every 5 minutes to find
  new pull requests). Each process looks at the shared schedule at most every 30 seconds.
- A pass takes a 5-minute lease first; while another Tandem holds it, the others wait. A pass that
  outlives its lease leaves the schedule to whoever claimed it next. Failing to list the user's
  pull requests for `watchAllMyPrs` skips only that step. After the
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
| Merge conflict | See [Conflicts](#conflicts): steer the task, or ask the user. |
| Changes requested | 🔴 red. |
| The watcher's own push is the head, the pull request was approved before it, and is not now | 🔴 red: the push dismissed the approval. |
| A check pending longer than `stuckAfterMinutes` (from its start, or from when the watcher first saw the head) | 🔴 red, `⏰ stuck`. |
| Checks still running | The failed-check rows below wait until every check finishes. |
| A check failed, and fails or is still running on the base branch too | Wait, `🧱 main is red`. Once the base passes, the rules below apply. |
| A check failed with a retry left for this code | Empty commit to rerun CI. Not on a fork (red instead), and not on a Tandem task's draft, whose task still pushes its own commits there: that waits, yellow, until it is published. |
| A check failed again on the same code | 🔴 red, naming the check and linking its CI page. |
| A draft | Nothing more: CI only. |
| Published and never put up for merging (not already queued, blocked, or on auto-merge) | Look up who last took it out of the queue; unless a person did, arm auto-merge or add `queueLabel`. Once per pull request, even while checks run. |
| Checks running, or none reported yet on a head first seen under 5 minutes ago | Nothing. |
| Behind its base, no conflicts, and GitHub requires up-to-date branches (`mergeStateStatus` `BEHIND`) | Update the branch, once per head. Not for a pull request from a fork. |
| Out of the queue: `blockedLabel` present, or the queue label or auto-merge gone after the watcher set it | Look up who did it. A person, or no event naming anyone: leave it alone and show who. The queue (a bot or app): requeue, once per head commit; a second kick-out at the same head goes 🔴 red. |
| Otherwise | A row saying what it waits on: queued, auto-merge, review (naming requested reviewers), or approved. |

- **Retry budget:** `maxCiRetries` (default 1) per check, per version of the code: the head
  commit's tree. An empty commit keeps the tree, so it spends the budget; a real push changes the
  tree and resets it.
- **Empty commit:** made through the GitHub API with no checkout. Tandem creates a commit with the
  head's tree and the head as its parent, then moves the branch to it with `force=false`. If
  someone pushed in between, GitHub refuses the move, the branch keeps their push, nothing is
  logged, and the next check sees the new head. It works with any CI that runs on push. A pull
  request from a fork is pushed to the fork, which needs write access there.
- The action log records every action with the head and tree it answered: each empty commit and
  branch update with the commit it pushed and whether the pull request was approved just before
  (that is how a lost approval is noticed), and each queue, auto-merge, and requeue.

## Merging

- **Auto-merge** (`mergeWith = "auto-merge"`, the default): `gh pr merge --auto` with the first
  method the repository allows of squash, merge commit, and rebase, pinned with
  `--match-head-commit` to the head it saw. Turned off after the watcher armed it: a person's
  `auto_merge_disabled` is left alone; otherwise it is armed again, once per head.
- **Queue label** (`mergeWith = "queue-label"`): `gh pr edit --add-label queueLabel`. A requeue
  removes `blockedLabel` (when present) in the same edit. Tagalingo-style queues with no
  `blockedLabel` count the queue label disappearing as the kick-out.
- **Updating a branch** merges the base into it through the GitHub API (`POST repos/R/merges`),
  which only adds a commit on top, and records the merge commit.
- A person is any actor that is not a GitHub `Bot` and whose login does not end in `[bot]`; the
  signed-in user's own label changes count as a person's.
- These are the only merges Tandem makes without asking. The `merge` action still merges right
  away when the user asks and approves it.

## Conflicts

- GitHub does not name conflicting files, so the row names the files both the pull request and its
  base changed since they split (`compare` both ways), the closest guess without a checkout.
- **A Tandem task's pull request:** the task is steered: "Pull this branch from origin, merge
  `origin/<base>` into it, resolve the conflicts, commit, and push. Never force-push." (It pulls
  first because the watcher's own commits may be on the branch.) Merge instead of rebase, because
  open-PR follow-ups never force-push (`OPEN_PR_FOLLOW_UP` in src/tasks/control.ts). CI checks
  the result. The row shows `🔀 resolving conflicts in <files>` while the task works, then
  `🔀 resolved conflicts in <files> · CI running`. Only the coordinator whose project the task
  belongs to steers it; elsewhere the row waits for it. A cancelled, merged, or completed task
  counts as no task.
- **Anyone else's pull request:** the user is asked first ("acme/app#409 has merge conflicts in
  auth/session.ts. Fix them?"), since a fix pushes to a branch they may have local commits on. The
  question is shown in the coordinator's chat with the pull request in a hidden line, without a
  model turn. On yes the coordinator calls `pr-watch-fix`, which needs the user's approval and
  starts an approved implementation task that adopts the pull request (so it returns straight to
  ready when it pushes, like any open-PR follow-up), starts from the pull request's branch in its
  own worktree, merges the base, resolves, and pushes with `git push origin HEAD:<branch>`. That
  task becomes the pull request's task. It runs in the coordinator's project when that is the pull
  request's repository, otherwise as a task in that repository (see
  [other-repositories.md](other-repositories.md)). A declined or unanswered question leaves the
  row red and is not asked again for that base commit.
- One attempt per base commit. Still conflicting after the task stops working (ready, blocked,
  paused), or conflicting again at the same base commit, is 🔴 red. A new base commit gets a new
  attempt.

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

## Coordinator shortcut

- With Jev prompt routing on, a coordinator message Jev confidently classifies as asking how the
  user's pull requests are doing ("how are my PRs?", "did #409 merge?") prints the PR watch view
  and skips the coordinator turn (`pr-watch` in the lookup list of src/extension/prompt-routing.ts,
  question schema version 3). Opening the view is the same check a tick would run, so a wrong
  guess only shows a table.
- Messages that change something ("hands off #409", "watch #412") stay with the coordinator, which
  uses `pr-watch-stop` and `pr-watch-start`. A message with a PR link or `owner/repo#N` goes to the
  PR review route first, as before (see [policy.md](policy.md#jev-prompt-routing)).

## Notifications

- Only when a row turns red for a reason not told before (a brief green read, such as GitHub
  recomputing mergeability after a push to the base, does not repeat it) or a pull request merges,
  plus the question whether to fix someone's
  conflicts. The notice is stored on the record, and the first coordinator to take it shows it:
  a routine one with `ctx.ui.notify`, the question in the chat as described above, neither with a
  model turn. Taking it clears it, so another open Tandem never repeats it.

## Settings

- `watchAllMyPrs` lives in `<home>/settings.toml` (see [policy.md](policy.md#where-settings-live)).
- Per repository, `[merging]` in the project's settings.toml, read live on every check like
  `cleanupCommands` and never pinned to a task:

  ```toml
  [merging]
  mergeWith = "queue-label"     # "auto-merge" (GitHub) or "queue-label"
  queueLabel = "mergequeue"     # added to put the pull request in the queue
  blockedLabel = "blocked"      # present when the queue kicked it out
  maxCiRetries = 1
  stuckAfterMinutes = 60
  ```

- Defaults: `auto-merge`, one retry, 60 minutes. A repository with `.aviator/config.yml` defaults
  to `queue-label` with `mergequeue` and `blocked`. Keys left out keep their default.
- The settings come from the checkout the watch belongs to: the task's repository (or its target
  checkout), the directory or project it was named from when that is its repository, or else the
  registered Tandem project whose `origin` is its repository (looked up once, when the watch
  starts). With none of those, the defaults apply.
- Setup writes the section commented out with descriptions, like the other settings.
