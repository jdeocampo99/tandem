---
name: nightly-cleanup
description: >-
  Unattended nightly refactor: rank the worst hot spots, have subagents clean up at most two, verify
  them, and leave draft PRs for the morning. Trigger on "nightly cleanup", "run the nightly-cleanup
  skill", or /nightly-cleanup.
user-invocable: true
---

# nightly-cleanup

A scheduled, unattended run. Nobody is watching, so every decision below is already made: follow
the steps, and when a step says stop, print a one-line summary and end the session.

The run leaves **draft** PRs only. Never merge, never mark a PR ready, never force-push. A draft
also keeps Tandem's PR watch away, since it only auto-merges published PRs.

`<repo>` is the main checkout (`git rev-parse --show-toplevel`), `<date>` is `date +%F`.

## 1. Preconditions

Stop with a one-line summary on the first one that fails:

1. In `<repo>`, on `main`, `git status --porcelain` prints nothing.
2. `git pull --ff-only` succeeds.
3. `gh label create nightly-cleanup --color 0E8A16 --description "Nightly cleanup draft" --force`
   succeeds, then `gh pr list --label nightly-cleanup --state open --json number --jq length`
   prints less than 3.
4. `bun install`, `bun run check` and `bun run lint` pass.

## 2. Pick targets

```sh
bun scripts/cleanup-targets.ts --limit 2 --json
```

It already excludes files in open PRs, files changed in the last 48 hours, tests, Luau, docs, the
ratchet itself and `scripts/cleanup-targets.exclude`. A nonzero exit or `[]` means stop. For each
target, save its `reason` and its ratchet counts before the change:
`jq '.counts["<file>"]' scripts/lint-ratchet/baseline.json`.

`<slug>` is the target path without `src/` and `.ts`, with `/` turned into `-`
(`src/runtime/database.ts` is `runtime-database`).

## 3. Refactor

Per target:

```sh
git worktree add <repo>/.claude/worktrees/nightly-<date>-<slug> -b nightly/<date>-<slug> main
cd <repo>/.claude/worktrees/nightly-<date>-<slug> && bun install
```

Spawn one `Agent` with `subagent_type: "pstack:poteto-agent"`, `model: "opus"`, and the
**refactor brief** from [briefs.md](briefs.md), filled in for the target.

Run the two targets in parallel when neither file imports the other. Otherwise run them one after
the other, and add the first branch's changed files (`git diff --name-only main...HEAD`) to the
second brief as off-limits.

## 4. Verify

In each worktree, run the gates yourself:

```sh
bun run check && bun test && bun run lint
git diff main...HEAD -- scripts/lint-ratchet/baseline.json
```

The branch passes when all three gates pass, the subagent committed everything, and the baseline
diff only lowers or moves counts with the target's weighted debt lower than before (weights:
`RULE_WEIGHTS` in `scripts/cleanup-targets.ts`).

On a failure, spawn one fresh subagent with the **fix brief** and the failing output, then run the
gates again. A second failure abandons the target: note why, then
`git worktree remove --force <worktree>` and `git branch -D nightly/<date>-<slug>`.

## 5. Review

Per surviving branch, spawn one `Agent` with `subagent_type: "codex:codex-rescue"` and the
**review brief**. It reports behavior changes, weakened tests and scope creep. Each finding is real
when its scenario holds against the code; read the cited lines to check. Ignore style nits.

Real findings get one fix round (fix brief with the findings), then step 4's gates again, then at
most one re-review. Anything still real after that abandons the target as in step 4. An empty
review result gets one retry; if it is empty again, write "Review did not run" in the PR body.

## 6. Open draft PRs

Per surviving branch:

```sh
git push -u origin nightly/<date>-<slug>
gh pr create --draft --base main --label nightly-cleanup --title "refactor(<area>): <what got simpler>" --body-file <body>
```

The body follows `.github/pull_request_template.md`. Drop the `Closes #` line. "What this does"
says what got simpler, in plain English. "How it works" includes the target's ratchet counts
before and after, rule by rule, and what the review found (or that it found nothing real).

## 7. Finish

Remove the worktrees of abandoned targets (step 4) and leave the rest for the morning review. End
with a short plain-English summary: each PR link, the counts it lowered, and each abandoned target
with its reason.
