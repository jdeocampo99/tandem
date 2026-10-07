# Nightly cleanup briefs

Fill in the `<...>` fields and send each brief as the subagent's whole prompt.

## Refactor brief

> Work only in `<worktree>` on branch `nightly/<date>-<slug>`. Refactor `<file>` and what it pulls
> in, keeping behavior identical. The ranking flagged it for: `<reason>`. Its ratchet counts now:
> `<counts>`.
>
> Before writing code, read these in full and follow them:
> `~/.claude/skills/refactor-functions/SKILL.md`; the mattpocock `codebase-design` skill (deep
> modules, the deletion test, no shallow pass-throughs); the pstack skills
> `thermo-nuclear-code-quality-review`, `principle-minimize-reader-load` and
> `principle-laziness-protocol`; and `AGENTS.md`.
>
> Hard rules:
> - Behavior stays the same. Tests stay as strong as they are: keep every test and assertion.
> - The ratchet baseline only goes down. No new dependencies.
> - Change only `<file>`, the code it calls into, its direct callers when a signature changes, and
>   their tests. `<off-limits files, if any>` are off-limits.
>
> Done means: `bun run lint:ratchet --update` (or `--update --allow-moves` when you split the file)
> succeeds and lowers the target's counts with no rule total rising; `bun run check`,
> `bun run lint` and the tests for the files you touched pass; everything, baseline included, is
> committed with a conventional `refactor(<area>): ...` message ending in the session's
> Co-Authored-By line. Report what got simpler and the counts before and after.

## Fix brief

> Work only in `<worktree>` on branch `nightly/<date>-<slug>`. A behavior-preserving refactor of
> `<file>` is committed there (`git log main..HEAD`). Fix this and nothing else:
>
> `<failing gate output, or the review's real findings>`
>
> The refactor brief's hard rules still hold: same behavior, tests as strong as before, baseline
> only down, no new dependencies, no files beyond the refactor's own. Done means the failure above
> is gone, `bun run check`, `bun run lint` and the affected tests pass, and the fix is committed.

## Review brief

> --model gpt-6.1-sol --effort high --wait
>
> Read-only review; make no edits. In `<worktree>`, review `git diff main...HEAD`, a refactor of
> `<file>` that must preserve behavior. Report only:
> 1. Behavior changes: any input whose result, side effect, error, or ordering differs from `main`.
> 2. Weakened tests: a deleted test or assertion, or one that now checks less.
> 3. Scope creep: changes outside the target file, its callees, its callers, and their tests.
>
> For each, give `file:line` and a concrete scenario that shows it. Skip style and naming. If
> there is nothing, say "No findings."
