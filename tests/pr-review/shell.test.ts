import { expect, test } from "bun:test";
import { readOnlyCommandRefusal } from "../../src/pr-review/shell.ts";

test("allows plain read-only git and gh commands", () => {
  for (const command of [
    "git log --oneline -20 -- src/store.ts",
    "git blame -L 10,40 src/store.ts",
    'git show HEAD~1 --stat --format="%an %s"',
    "git diff abc123 def456 -- src",
    "gh pr view 7 --repo acme/api --json files",
    "gh pr checks 7 --repo acme/api",
    "gh api repos/acme/api/pulls/7/comments",
    "gh api -X GET repos/acme/api/issues/3",
  ]) {
    expect({ command, refusal: readOnlyCommandRefusal(command) }).toEqual({
      command,
      refusal: undefined,
    });
  }
});

test("refuses anything that could write, run a program, or chain commands", () => {
  for (const command of [
    "git checkout main",
    "git commit -m x",
    "git push origin HEAD",
    "git -c core.pager=sh log",
    "git diff --output=/tmp/x",
    "git log --ext-diff",
    "git grep -O foo",
    "gh pr merge 7",
    "gh pr comment 7 -b hi",
    "gh pr review 7 --approve",
    "gh api --method POST repos/acme/api/pulls/7/reviews",
    "gh api repos/acme/api/issues/3/comments -f body=hi",
    "gh pr view 7 --web",
    "git log | head",
    "git log; rm -rf /",
    "git log $(whoami)",
    "git log > out.txt",
    "rm -rf /",
    "bun test",
    'git log "unclosed',
  ]) {
    expect({ command, refused: readOnlyCommandRefusal(command) !== undefined }).toEqual({
      command,
      refused: true,
    });
  }
});
