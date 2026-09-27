import { expect, test } from "bun:test";
import { classifyReviewLevel } from "../../src/tasks/review-levels.ts";

/** A unified diff that changes `lines` lines in each of `files` files. */
function diff(files: readonly string[], linesPerFile: number, truncated = false) {
  const patch = files
    .map((path) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -1,${linesPerFile} +1,${linesPerFile} @@`,
        ...Array.from({ length: linesPerFile }, (_, index) =>
          index % 2 === 0 ? `+added ${index}` : `-removed ${index}`,
        ),
      ].join("\n"),
    )
    .join("\n");
  return { changedFiles: files, patch, truncated };
}

const files = (count: number) => Array.from({ length: count }, (_, index) => `src/f${index}.ts`);

test("five changed files are light and a sixth makes the change standard", () => {
  expect(classifyReviewLevel(diff(files(5), 10)).level).toBe("light");
  const six = classifyReviewLevel(diff(files(6), 10));
  expect(six).toEqual({
    level: "standard",
    reason: "6 changed files exceed 5, so P0 and P1 findings block",
  });
});

test("200 changed lines are light and a 201st makes the change standard", () => {
  const light = classifyReviewLevel(diff(files(1), 200));
  expect(light).toEqual({
    level: "light",
    reason: "1 changed file(s) and 200 changed line(s), so only P0 findings block",
  });
  expect(classifyReviewLevel(diff(files(1), 201)).level).toBe("standard");
});

test("file headers and hunk markers are not counted as changed lines", () => {
  expect(classifyReviewLevel(diff(files(4), 50)).level).toBe("light");
});

test("a lockfile, build config, CI, or migration path is standard however small", () => {
  for (const path of [
    "bun.lock",
    "tsconfig.json",
    ".github/workflows/ci.yml",
    "db/migrations/1.sql",
  ]) {
    const classified = classifyReviewLevel(diff([path], 1));
    expect(classified.level).toBe("standard");
    expect(classified.reason).toContain(path);
  }
});

test("content alone never raises the level", () => {
  const change = diff(["src/lock.ts"], 2);
  const patch = change.patch.replace("+added 0", "+export const auth = Promise.all([lock()]);");
  expect(classifyReviewLevel({ ...change, patch }).level).toBe("light");
});

test("a truncated diff is standard", () => {
  expect(classifyReviewLevel(diff(files(1), 1, true))).toEqual({
    level: "standard",
    reason: "the diff was too large to read in full, so P0 and P1 findings block",
  });
});
