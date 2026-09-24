# PR review PRD

**Status: proposed, not implemented.**

## Goal

Paste any pull-request link and get fast context plus human-sounding draft comments that post to
GitHub in one approved step.

## Starting a review

- New `pr-review` task kind. It starts without approval because it is read-only.
- Prompt routing gains a "review a PR" option.
- **Lens**, inferred by Jev from the request; below the confidence threshold it falls back to Full:

| Lens | Looks at | Produces |
| --- | --- | --- |
| Full (default) | The existing review lens: behavior, edge cases, design, tests | Intent, diagram, concerns, inline comments |
| Intent | Approach, scope, fit with the codebase, simpler alternatives | Intent, diagram, 2–4 big-picture concerns, one summary comment; no inline comments |
| Focus on X | A free-text area ("the migration", "security") | Full depth on that area, light pass elsewhere |

- **State check up front.** Merged, closed, draft, merge conflicts, or no `gh` access each return a
  one-line answer instead of a failed task.
- **Acknowledgement** names lens, size, and CI: "Reviewing #123 for intent. Medium PR, ~10 min
  read. CI failing on lint."

## Finding the code

Deterministic code, not an agent. `locateRepo(owner/repo)` returns `found(path)`,
`ambiguous(paths)`, or `missing`.

1. Look up `repo_locations(repo, path, last_used_at)` in `state.sqlite`. A saved path is used only
   if the folder exists and its `origin` still matches; otherwise it is forgotten.
2. Crawl the configured root (default `~/Coding/Projects`, set during setup) a few levels deep and
   match by `git remote get-url origin`. One match is saved and used.
3. On `ambiguous` or `missing`, the coordinator asks the user. The answer is verified the same way
   and saved.
4. Clone only when the user says "clone it".

Worktree: `git fetch origin pull/N/head` (works for fork PRs), then `git worktree add` at that
commit with no branch. The user's checkout, branch, and uncommitted work are never touched; the
worktree is removed when the task is cleaned up.

## What the reviewer sees

- The diff against the merge base (`base...head`), so only the PR's own changes.
- PR description, linked issue, existing comments, and resolved threads, so it does not repeat or
  reopen settled points.
- `gh pr checks` results; it does not comment on anything CI already catches.
- Lockfiles and `linguist-generated` files are skipped and listed.
- Standards come from the target repo's `AGENTS.md`, `CLAUDE.md`, or contributing guide, falling
  back to general good practice. Tandem's own code standards do not apply to other repos.

## Reviewing

- One reviewer on the strongest model tier, with read-only `git` and `gh` commands added.
- It returns structured data; Tandem validates it before rendering or posting:

```text
intent        2-3 sentence summary
diagram       Mermaid text, or empty
readingOrder  [{file, why}]
concerns      [{title, detail, severity}]
comments      [{file, line, body, severity}]   every line must be in the diff
```

- Small fixes are written as GitHub ` ```suggestion ` blocks.
- Comments read like a teammate wrote them ("Could we move the release into a `finally`?").
  Severity only orders and labels them (blocking / nit / question); P0–P3 never appear.

## Talking to the reviewer

The reviewer session stays open after delivery so the user can ask about the PR ("why does `retry`
loop here?") with the same worktree and context. It closes when the review is posted or closed and
holds one worktree slot until then.

## Showing and posting

- A fixed Lavish template renders: what it does and why, diagram, how to read it, concerns, draft
  comments. Small PRs with no diagram render as plain text in chat.
- The diagram stays private and is never posted.
- The user edits drafts through chat or Lavish notes. One approval posts a single GitHub review; the
  user picks comment, approve, or request changes. Tandem never picks the verdict.
- The post carries `commit_id` for the reviewed commit. If the PR moved, Tandem warns and offers a
  re-review.
- A failed post is never blindly retried; Tandem first checks for an existing review at that
  commit.

## Re-review

- Runs on the same task over the diff since the last reviewed commit.
- Each earlier comment is reported as addressed, not addressed, or replied to without a change, with
  a short closing reply drafted where it fits.
- If history was rewritten (rebase or force-push), it reviews the full PR again and still checks
  earlier comments.

## Not in v1

- Review queue (`review-requested:@me`), open-in-editor command, drafts in the user's own voice,
  positive comments.
- Splitting large PRs across several reviewers.
- Automatic "PR was updated" notifications.
- Jev deciding whether a comment was addressed.

## Automated checks

`bun run check`, `bun test`, and `bun run lint` pass. Tests cover:

- **Repo lookup:** stale saved path, one match, no match, several matches, folder name that differs
  from the remote, clone fallback.
- **Worktree:** fork PR via `pull/N/head`, merge-base diff, cleanup removes only the review worktree.
- **PR state:** merged, closed, draft, conflicts, and no access each give the right one-line answer.
- **Review data:** a comment outside the diff is rejected; noise files are skipped and listed.
- **Lens:** Intent produces no inline comments; low confidence falls back to Full.
- **Posting:** request includes `commit_id`; a moved PR warns; a retry after an uncertain failure
  does not post twice.
- **Re-review:** correct range after a normal push and a force-push; per-comment status.
- **Routing:** a PR link routes to `pr-review`.

## Manual checks

- Review a real PR from another repo end to end.
- Comments read like a teammate wrote them; suggestion blocks apply cleanly.
- Posted comments land on the right lines.
- Follow-up questions get answers grounded in the PR.
