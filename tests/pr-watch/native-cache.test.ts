import { expect, test } from "bun:test";
import type { CommandRequest, CommandRunner } from "../../src/contracts.ts";
import { readNativePullRequest } from "../../src/pr-watch/native-cache.ts";

const now = "2030-01-01T12:00:00Z";
const ref = { repo: "acme/app", number: 281 };
const view = {
  number: 281,
  title: "Port",
  url: "https://github.com/acme/app/pull/281",
  headRefOid: "abc",
  isDraft: true,
  body: "PR body",
  commits: [{ oid: "abc" }],
  additions: 1,
  deletions: 1,
  statusCheckRollup: [
    {
      name: "lint",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2030-01-01T11:59:00Z",
      completedAt: "2030-01-01T11:59:09Z",
    },
    { name: "tests", status: "IN_PROGRESS", startedAt: "2030-01-01T11:58:43Z" },
  ],
  comments: [],
  reviews: [],
};
function runner(moved = false): Readonly<{ run: CommandRunner; seen: CommandRequest[] }> {
  const seen: CommandRequest[] = [];
  return {
    seen,
    run: async (request) => {
      seen.push(request);
      if (request.argv.includes("graphql"))
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  headRefOid: "abc",
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread-1",
                        path: "src/a.ts",
                        line: 1,
                        diffSide: "RIGHT",
                        isResolved: false,
                        isOutdated: false,
                        comments: {
                          nodes: [
                            {
                              id: "comment-1",
                              author: { login: "reviewer" },
                              createdAt: now,
                              body: "Fix it",
                              url: "https://github.com/comment",
                            },
                          ],
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
          stderr: "",
        };
      if (request.argv.includes("diff"))
        return {
          code: 0,
          stdout: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
          stderr: "",
        };
      const onlyHead = request.argv.at(-1) === "headRefOid";
      return {
        code: 0,
        stdout: JSON.stringify(onlyHead ? { headRefOid: moved ? "changed" : "abc" } : view),
        stderr: "",
      };
    },
  };
}

test("Tandem caches PR body, CI times, diff and review threads under one verified head", async () => {
  const { run, seen } = runner();
  const cached = await readNativePullRequest(run, ref, "/repo", now);
  expect(cached).toMatchObject({ head: "abc", commits: 1, body: "PR body", readAt: now });
  expect(cached.checks.map((check) => check.state)).toEqual(["passed", "running"]);
  expect(cached.checks[0]?.completedAt).toBe("2030-01-01T11:59:09Z");
  expect(cached.threads[0]).toMatchObject({ resolved: false, side: "RIGHT", line: 1 });
  expect(seen).toHaveLength(4);
  expect(seen.every((request) => request.cwd === "/repo")).toBe(true);
});

test("moving PR head refuses the cache instead of pairing new diff rows with old threads", async () => {
  const { run } = runner(true);
  await expect(readNativePullRequest(run, ref, "/repo", now)).rejects.toThrow(
    "changed during cache",
  );
});
