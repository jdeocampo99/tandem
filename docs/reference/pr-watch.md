# PR watch

What PR watch guarantees while it keeps open pull requests moving: which pull requests it watches,
how it reads GitHub, what it does on its own, and when it tells the user.

Code: src/pr-watch/ (`decide.ts` the decision table, `github.ts` every GitHub read and write,
`watcher.ts` the schedule and effects, `store.ts` durable records, `view.ts` the table),
src/service/controller.ts (`prWatch*`), src/main.ts (`tandem watch`), src/terminal/status.ts,
src/session/notifications.ts (`deliverPrWatchNotices`). Scenarios:
tests/evals/pr-watch-scenarios.test.ts.

## What is watched

| Moment | What happens |
| --- | --- |
| A Tandem task records a pull request (its draft at ready, or a publish) | Watched, tied to the task. A draft is watched for CI only and never queued. |
| It is published (draft to ready; Tandem's `publish` marks its draft ready) | Also merged: auto-merge is armed or the queue label added. |
| `tandem watch <link, owner/repo#N, or N>` or the `pr-watch-start` action ("watch #N") | Watched. `N` means a pull request in the current directory's repository (the coordinator's project for the action). Naming one already watched starts it over (see [Conflicts](#conflicts)). |
| `tandem watch --stop PR`, the `pr-watch-stop` action ("hands off #N") | Stopped. The record stays, so its task never picks it up again; watching it by name starts it again. |
| GitHub reports it merged or closed | Done. It stays in the view as ⚪ for the rest of that day. |

A cancelled task's pull request is not picked up. Whether to merge follows GitHub's draft flag on
every read, so a pull request watched by name merges once it is not a draft.

The watcher acts only on these. The view also lists every other open pull request the signed-in
`gh` user authored, across repositories (`gh search prs --author @me`, read when the view opens),
as ⚪ rows with their draft or open status and a hint that "watch #N" hands one over. Nothing
reads them further and nothing acts on them.

## Durable state

- One row per pull request in the `pr_watches` table of `<home>/state.sqlite`, keyed by
  `owner/repo#N`: why watching started, the task it belongs to, the head last seen with its tree
  and when it was first seen, what the last read found, the current row, the action log, and a
  notification no Tandem has shown yet. A row in an unknown shape fails loudly.
- The poll schedule is one `pr_watch_poll` entry in the metadata table: when the tick last checked
  (the schedule counts from it), when GitHub was last read by anything (the header's age), a lease
  while one Tandem reads it, and a rate-limit wait.
- The records belong to the Tandem home, not a session or coordinator, so any open Tandem picks
  them up. Never edit them by hand.

## Reading GitHub

- One `gh pr view --json` per watched pull request, with state, draft, head and base, mergeable,
  merge state, review decision and requested reviewers, labels, auto-merge, and the status check
  rollup. Checks go through the delivery parser (`parseRemoteCheck` in
  src/delivery/pull-requests.ts), so check runs and commit statuses both count. A skipped or
  neutral check counts as passed.
- **Required checks.** The rollup does not say which checks branch protection requires, so one
  GraphQL call reads `isRequired(pullRequestNumber:)` for the reported checks, every page. It is
  kept per head and read again only when a check shows up that was not reported before. Only
  required checks drive retries, red rows, "stuck", and waiting before merging; optional ones
  still show in the checks column. A repository that requires none counts every check.
- A full page of 100 checks means there may be more: `gh pr checks --json` reads them all.
- The head commit's tree is read (`gh api repos/R/commits/SHA`) only when the head changes.
- Extra reads happen only when the decision asks for them: the base branch's checks (one GraphQL
  call) when a check fails, the files both sides changed (two compare calls) on a conflict, and the issue events (label and auto-merge changes, with who made
  them) when the pull request left the queue.
- An unreadable pull request (missing SSO authorization, a GraphQL error, no rollup at all) shows
  `⚠ can't read` with GitHub's reason, never "no checks".
- `gh` output naming a rate limit (or HTTP 429) stops the pass, records a 15-minute wait, and the
  header says when the next check is.

## Schedule

- Checks run from the coordinator scheduler tick while any Tandem is open, without holding the tick
  up (a check already running in the process is joined, and shutdown waits for it): every minute while a
  watched pull request has CI running or the watcher acted in the last 5 minutes, every 5 minutes
  otherwise, and not at all when nothing is watched. Each process looks at the shared schedule at
  most every 30 seconds. The tick is the only place the watcher acts.
- A pass takes a 5-minute lease first; while another Tandem holds it, the others wait. A pass that
  outlives its lease leaves the schedule to whoever claimed it next. After the laptop sleeps, the
  next tick catches up and the header shows how old the data is.
- Opening the view (`tandem watch`, `tandem status`, the coordinator's `pr-watch`, or the Jev
  shortcut) reads GitHub first, unless another Tandem holds the lease or GitHub's rate limit is in
  effect, and records rows but never acts: no empty commits, labels, auto-merge, branch updates,
  steers, or fix questions. It does not move the tick's schedule.
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
| A required check pending longer than `stuckAfterMinutes` (from its start, or from when the watcher first saw the head) | 🔴 red, `⏰ stuck`. |
| Checks still running | The failed-check rows below wait until every check finishes. |
| A check failed, and fails or is still running on the base branch too | Wait, `🧱 main is red`. Once the base passes, the rules below apply. |
| A check failed with a retry left for this code | Empty commit to rerun CI. Not on a fork (red instead), and not on a Tandem task's draft, whose task still pushes its own commits there: that waits, yellow, until it is published. |
| A check failed again on the same code | 🔴 red, naming the check and linking its CI page. |
| A draft | Nothing more: CI only. |
| Published, and the repository's merging is not set up | Ask once how it merges (see [Setting up merging](#setting-up-merging)); never arm. |
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
  row red and is asked once per pull request: not again, even as the base moves on, until the user
  asks to fix it or watches it again ("watch #N").
- One fix attempt per pull request. Still conflicting after the task stops working (ready,
  blocked, paused), or conflicting again, is 🔴 red, and the task is not steered again as the base
  moves on. A new attempt needs a new episode: someone pushed since the attempt and the base moved
  on too, such as conflicts coming back weeks after a fix that worked.

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
  when it has any rows; the coordinator's `pr-watch` action returns it for the coordinator to
  show as-is. `tandem board` shows the saved rows without reading GitHub: red rows under "Needs
  you", the rest under PRs (see [board.md](board.md)). The header counts watched pull requests still open; the user's unwatched ones come
  last.

## Coordinator shortcut

- With Jev prompt routing on, a coordinator message Jev confidently classifies as asking how the
  user's pull requests are doing ("how are my PRs?", "did #409 merge?") prints the PR watch view
  and skips the coordinator turn (`pr-watch` in the lookup list of src/session/prompt-routing.ts,
  question schema version 3). Opening the view only reads, so a wrong guess only shows a table.
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

- Per repository, `[merging]` in the project's settings.toml, read live on every check like
  `cleanupCommands` and never pinned to a task:

  ```toml
  [merging]
  mergeWith = "queue-label"     # "auto-merge" (GitHub), "queue-label", or "off"
  queueLabel = "mergequeue"     # added to put the pull request in the queue
  blockedLabel = "blocked"      # present when the queue kicked it out
  maxCiRetries = 1
  stuckAfterMinutes = 60
  ```

- Merging is opt-in per repository. Until `mergeWith` is saved, and with `mergeWith = "off"`, the
  watcher still retries CI and reports, but never arms auto-merge, adds or swaps labels, requeues,
  or updates branches; the row says merging isn't set up (or is off). Other keys default to one
  retry and 60 minutes; `queueLabel` defaults to `mergequeue`.
- The user never has to know the section exists: onboarding asks (see
  [Setting up merging](#setting-up-merging)), and so does PR watch the first time it watches a
  pull request in a repository with no choice saved.
- The settings come from the checkout the watch belongs to: the task's repository (or its target
  checkout), the directory or project it was named from when that is its repository, or else the
  registered Tandem project whose `origin` is its repository (looked up once, when the watch
  starts). With none of those, the defaults apply.
- Setup writes the section commented out with descriptions, like the other settings.

## Setting up merging

- **The check** (`checkMerging`, src/pr-watch/merging-check.ts) is read-only: `gh api repos/R`
  (readable at all, "Allow auto-merge", default branch), `.aviator/config.yml`, the default
  branch's rulesets (`repos/R/rules/branches/B`) and, where this login may read it, its classic
  protection. It reports:
  - an unreadable repository (not signed in, SSO not authorized) as one plain sentence to act on;
  - the method: Aviator config → `queue-label` with `mergequeue` and `blocked`; otherwise "Allow
    auto-merge" on → `auto-merge`; otherwise unknown, which needs one question (which label
    queues a pull request, or GitHub auto-merge once turned on);
  - whether the base requires checks (`yes`, `none`, or `unknown` when GitHub won't say), with a
    warning when none: a pull request could merge before CI finishes;
  - whether a push dismisses approvals (`yes`, `no`, `unknown`), with a warning when it does:
    every CI retry would cost the pull request its approvals.
- `onboard --json` includes it as `merging`, plus `workerSkillOffer`: Claude Code plugin skills
  not yet in `workerSkills`, empty once the user answered that offer. The onboarding skill asks
  one optional question for each and never about retries or other knobs.
- **First watch.** `tandem watch` / `pr-watch-start` on a pull request whose repository has a
  Tandem project and no saved choice runs the check and raises the question at once; a published
  Tandem task's pull request raises it on the next tick (the `offer-merging` action, once per pull
  request). The question reaches the coordinator's chat with a hidden line saying how to save the
  answer, like the conflict question.
- **Saving.** The answer is saved by `pr-watch-merging` (the coordinator; needs the user's approval
  in the TUI) or `configure-merging --input FILE --yes` (onboarding). "Not now" saves
  `mergeWith = "off"`, so it isn't asked again. Onboarding saves the plugin-skill answer with
  `configure-worker-skills --input FILE --yes` into `<home>/settings.toml`, an empty list for no.
- **How it writes.** `saveMergingChoice` (src/config/repositories.ts) is the only edit Tandem makes
  to a saved project's settings.toml: it adds `mergeWith` (and the labels) to `[merging]`, adding
  the section at the end when there is none, never replaces a `mergeWith` already there, validates
  the result, re-reads the file just before writing and writes nothing if it changed, and writes
  atomically. The settings path goes through the same symlink checks as every policy read.
  `saveWorkerSkills` does the same for `workerSkills` in the home settings, creating the file
  exclusively when it is missing.
