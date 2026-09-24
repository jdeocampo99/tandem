import { expect, test } from "bun:test";
import {
  acknowledgement,
  findPullRequestRef,
  isRefusal,
  parsePullRequestRef,
  readPullRequest,
  summarizeChecks,
} from "../../src/pr-review/pull-request.ts";
import { failed, fakeGh, ok, prView } from "./fake-gh.ts";

const VIEW = "gh pr view 7 --repo acme/api";

test("reads PR links, shorthand, and links inside a sentence", () => {
  expect(parsePullRequestRef("https://github.com/Acme/API/pull/7")).toEqual({
    repo: "acme/api",
    number: 7,
  });
  expect(parsePullRequestRef("https://github.com/acme/api/pull/7/files#diff-1")).toEqual({
    repo: "acme/api",
    number: 7,
  });
  expect(parsePullRequestRef("acme/api#7")).toEqual({ repo: "acme/api", number: 7 });
  expect(parsePullRequestRef("https://github.com/acme/api/issues/7")).toBeUndefined();
  expect(findPullRequestRef("can you look at <https://github.com/acme/api/pull/7>?")).toEqual({
    repo: "acme/api",
    number: 7,
  });
  expect(findPullRequestRef("review the upload change")).toBeUndefined();
});

test("refuses merged, closed, and unreadable PRs with one plain line", async () => {
  for (const [reply, message] of [
    [ok(prView({ state: "MERGED" })), "acme/api#7 is already merged."],
    [ok(prView({ state: "CLOSED" })), "acme/api#7 is closed."],
    [
      failed("GraphQL: Could not resolve to a Repository\nmore"),
      "I can't open acme/api#7 with your GitHub login: GraphQL: Could not resolve to a Repository",
    ],
  ] as const) {
    const { run } = fakeGh({ [VIEW]: reply });
    const read = await readPullRequest(run, { repo: "acme/api", number: 7 }, "/tmp");
    expect(read).toEqual({ kind: "refused", message });
  }
});

test("reviews drafts and conflicted PRs, and says so in the acknowledgement", async () => {
  const { run } = fakeGh({
    [VIEW]: ok(
      prView({
        isDraft: true,
        mergeable: "CONFLICTING",
        statusCheckRollup: [
          { name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "test", status: "IN_PROGRESS", conclusion: "" },
        ],
      }),
    ),
  });
  const read = await readPullRequest(run, { repo: "acme/api", number: 7 }, "/tmp");
  if (isRefusal(read)) throw new Error(read.message);
  expect(read.linkedIssues).toEqual([{ number: 3, title: "Uploads fail on flaky wifi" }]);
  expect(acknowledgement(read, "for intent")).toBe(
    "Reviewing acme/api#7 for intent. Medium PR, about a 4-minute read. CI failing on lint. It's still a draft. It has merge conflicts with its base.",
  );
});

test("sorts check runs and status contexts into failing, pending, and passing", () => {
  expect(
    summarizeChecks([
      { name: "a", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "b", status: "COMPLETED", conclusion: "SKIPPED" },
      { name: "c", status: "QUEUED", conclusion: "" },
      { context: "ci/legacy", state: "PENDING" },
      { context: "ci/deploy", state: "ERROR" },
    ]),
  ).toEqual({ failing: ["ci/deploy"], pending: ["c", "ci/legacy"], passing: 2 });
});
