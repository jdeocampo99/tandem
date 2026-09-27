# Working in another repository

What a task with a `target` guarantees: finding the other repository's checkout, the commit it
starts from, whose policy it runs under, and where its pull request goes.

Code: src/repos/locate.ts (`locateRepo`, `findCheckout`, `pinDefaultBranch`, `cloneRepo`),
src/service/controller.ts (`pinTarget`, `targetPolicy`), src/service/source.ts (`taskCheckoutPath`).
Scenario: tests/evals/cross-repo-scenarios.test.ts.

## Ownership

- `create` with `targetRepo: "owner/repo"` makes a research or implementation task in that
  repository. `repoPath` stays the coordinator's project, so the task is listed, owned, recovered,
  and reset with the coordinator's other tasks.
- `task.target` records `repo` (lowercased), `checkout` (the user's checkout), and `branch` (the
  default branch the source commit was pinned from). Git work, worktree release, containment
  checks, and cleanup commands use `checkout`; everything else uses `repoPath`.
- Work across several repositories is one task per repository. A target naming the coordinator's
  own checkout is refused.

## Finding the checkout

- Shared with PR review. A saved `repo_locations` row in `state.sqlite` is re-checked on every use
  (the folder exists and a remote still names the repository), then the project roots are crawled
  up to three levels deep, matching any remote and preferring `origin`.
- Roots are read on each use (`projectRoots` in src/repos/locate.ts): `TANDEM_PROJECT_ROOTS`
  (colon-separated) when set, then `projectRoots` in `<home>/settings.toml` (saved during
  onboarding), then the usual places under the home folder (`~/Coding/Projects`,
  `~/Coding_Projects`, `~/code`, `~/Projects`, `~/src`, `~/dev`, `~/Developer`, `~/git`, `~/repos`,
  `~/workspace`, `~/GitHub`, and a few spellings of these). A checkout two roots reach is counted once.
- No match or several matches make `create` fail with the question to ask the user. The answer
  comes back as `targetCheckout` (re-checked, then saved) or `targetClone: true` (a blobless clone
  under `<home>/clones/owner/repo`).

## Source commit

- The remote's default branch is read with `git ls-remote --symref` and fetched into
  `refs/tandem/default/<branch>` in the checkout. The user's branches, remote-tracking refs,
  `FETCH_HEAD`, and working files are never touched.
- That commit is the task's `sourceCheckpoint`, and the checkout is its `sourceRepoPath`, so
  Treehouse leases the worktree from the checkout at that commit and still proves the lease shares
  the checkout's Git common directory.
- The user's checkout may be dirty or on any branch. Launch, approval, and re-entry skip the
  source-unchanged checks that guard the coordinator's own clean source.
- An implementation adopts a research worktree only when both tasks name the same target (or
  neither does).

## Policy

- The target's own saved settings and guidance apply to its tasks when it is onboarded; otherwise
  the saved global model choices and built-in defaults do.
- Setup can inspect a foreign checkout directly, from the Repos page or the chat fallback. It
  reads that checkout's package scripts and lockfile, lets the user confirm or edit validation and
  install commands, and writes the target's central Tandem settings once after approval. This
  setup-only path does not require opening the checkout as the coordinator's source.
- Ordinary task creation does not silently onboard a foreign checkout or modify its settings.
  Implementation there needs validation commands. When the target has none saved, `create` fails
  with a question for the user; their answer goes into the brief's automated checks and comes back
  as `validationCommands`, appended to the pinned policy. Nothing is written to the target's
  repository by this fallback.

## Delivery

- The pull request opens against the worktree's `origin` with the default branch as base. Publish
  and draft refuse when `origin` names a repository other than the target, such as a fork.
