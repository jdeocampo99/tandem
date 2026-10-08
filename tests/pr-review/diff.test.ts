import { expect, test } from "bun:test";
import { AdapterCommandError } from "../../src/adapters/primitives.ts";
import type { CommandRequest, CommandRunner } from "../../src/contracts.ts";
import { readReviewDiff } from "../../src/pr-review/diff.ts";

test("review diffs preserve filename whitespace and raw patch stdout", async () => {
  const patch = "diff --git a/ file.ts b/ file.ts\n+++ b/ file.ts\n@@ -1 +1 @@\n+ value \n\n";
  const calls: CommandRequest[] = [];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    let stdout = patch;
    if (request.argv.includes("--name-only")) stdout = " file.ts\0";
    else if (request.argv.includes("check-attr"))
      stdout = " file.ts\0linguist-generated\0unspecified\0";
    return { code: 0, stdout, stderr: "" };
  };
  const diff = await readReviewDiff(run, "/tmp/review", "base", "head");
  expect(diff.files).toEqual([" file.ts"]);
  expect(diff.patch).toBe(patch);
  expect(diff.commentable.get(" file.ts")).toEqual(new Set([1]));
  expect(calls.map((call) => call.argv.slice(3))).toEqual([
    ["diff", "--name-only", "-z", "base", "head"],
    ["check-attr", "-z", "linguist-generated", "--", " file.ts"],
    ["diff", "--no-ext-diff", "--no-color", "base", "head", "--", " file.ts"],
  ]);
});

test("empty review diffs skip attribute and patch reads", async () => {
  let calls = 0;
  const diff = await readReviewDiff(
    async () => {
      calls += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
    "/tmp/review",
    "base",
    "head",
  );
  expect(calls).toBe(1);
  expect(diff.files).toEqual([]);
  expect(diff.patch).toBe("");
});

test("review diff command failures retain their adapter operation", async () => {
  const error = await readReviewDiff(
    async () => ({ code: 2, stdout: "", stderr: "bad revision\n" }),
    "/tmp/review",
    "base",
    "head",
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AdapterCommandError);
  if (!(error instanceof AdapterCommandError)) throw new Error("expected diff failure");
  expect(error.operation).toBe("git diff");
  expect(error.message).toBe(
    'git diff exited with code 2: ["git","-C","/tmp/review","diff","--name-only","-z","base","head"] in "/tmp/review"; bad revision',
  );
});
