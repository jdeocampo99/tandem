import { expect, test } from "bun:test";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import { readWatchedPullRequest } from "../../src/pr-watch/github.ts";

test("a pull request with a full page of checks has every page read", async () => {
  const calls: CommandRequest[] = [];
  const rollup = Array.from({ length: 100 }, (_, index) => ({
    __typename: "CheckRun",
    name: `shard-${index}`,
    status: "COMPLETED",
    conclusion: "SUCCESS",
  }));
  const allChecks = [
    ...rollup.map((check) => ({ name: check.name, state: "SUCCESS", bucket: "pass" })),
    { name: "shard-100", state: "FAILURE", bucket: "fail", link: "https://ci/100" },
  ];
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    calls.push(request);
    const [, command, verb] = request.argv;
    if (command === "pr" && verb === "view") {
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          state: "OPEN",
          isDraft: false,
          headRefName: "big",
          headRefOid: "head-1",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          statusCheckRollup: rollup,
        }),
      };
    }
    if (command === "pr" && verb === "checks") {
      return { code: 0, stderr: "", stdout: JSON.stringify(allChecks) };
    }
    throw new Error(`unexpected ${request.argv.join(" ")}`);
  };
  const read = await readWatchedPullRequest(
    run,
    { repo: "acme/app", number: 7 },
    { cwd: "/tmp", knownTree: { head: "head-1", tree: "tree-1" } },
  );
  if (read.kind !== "read") throw new Error("expected the pull request to be read");
  expect(read.observation.checks).toHaveLength(101);
  expect(read.observation.checks.at(-1)).toEqual({
    name: "shard-100",
    state: "failed",
    url: "https://ci/100",
  });
  expect(read.observation.tree).toBe("tree-1");
  expect(calls.map((call) => call.argv.slice(0, 3).join(" "))).toEqual([
    "gh pr view",
    "gh pr checks",
  ]);
});
