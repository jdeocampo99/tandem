import { expect, test } from "bun:test";
import { commentableLines, lineRanges, numberedDiff } from "../../src/pr-review/diff.ts";
import { anchorProblems, checkReview, parsePrReview } from "../../src/pr-review/review.ts";

const PATCH = `diff --git a/src/upload.ts b/src/upload.ts
index 1111111..2222222 100644
--- a/src/upload.ts
+++ b/src/upload.ts
@@ -10,4 +10,6 @@ export function upload() {
   const file = open();
-  send(file);
+  for (let attempt = 0; attempt < 3; attempt += 1) {
+    if (send(file)) break;
+  }
   close(file);
 }
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
`;

function reviewWith(comments: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    head: "abc123",
    intent: "Retries failed uploads.",
    readingOrder: [{ file: "src/upload.ts", why: "the retry loop" }],
    concerns: [
      { title: "Style", detail: "Minor naming.", severity: "nit" },
      { title: "Lock leak", detail: "The lock is never released on error.", severity: "blocking" },
    ],
    comments,
    summaryComment: "Nice change, a couple of thoughts.",
  };
}

test("commentable lines are the new-side added and context lines inside each hunk", () => {
  expect(commentableLines(PATCH)).toEqual(
    new Map([["src/upload.ts", new Set([10, 11, 12, 13, 14, 15])]]),
  );
});

test("a comment outside the diff moves into the summary instead of failing the post", () => {
  const checked = checkReview(
    reviewWith([
      {
        id: "c1",
        file: "src/upload.ts",
        line: 12,
        body: "nit: `attempt` could be `tries`",
        severity: "nit",
      },
      {
        id: "c2",
        file: "src/upload.ts",
        line: 40,
        body: "Could we log the final failure?",
        severity: "suggestion",
      },
      {
        id: "c3",
        file: "src/upload.ts",
        line: 11,
        body: "What if send throws?",
        severity: "blocking",
      },
    ]),
    { kind: "full" },
    commentableLines(PATCH),
  );
  expect(checked.review.comments.map((comment) => comment.id)).toEqual(["c3", "c1"]);
  expect(checked.review.concerns.map((concern) => concern.title)).toEqual(["Lock leak", "Style"]);
  expect(checked.review.summaryComment).toBe(
    "Nice change, a couple of thoughts.\n\nOn `src/upload.ts:40`: Could we log the final failure?",
  );
  expect(checked.notes).toEqual([
    "1 comment pointed outside the diff, so it moved into the summary.",
  ]);
});

test("an intent review posts no inline comments", () => {
  const checked = checkReview(
    reviewWith([
      {
        id: "c1",
        file: "src/upload.ts",
        line: 12,
        body: "Could this live in the client?",
        severity: "question",
      },
    ]),
    { kind: "intent" },
    commentableLines(PATCH),
  );
  expect(checked.review.comments).toEqual([]);
  expect(checked.review.summaryComment).toContain(
    "On `src/upload.ts:12`: Could this live in the client?",
  );
});

test("a malformed review names the field that is wrong", () => {
  expect(() => parsePrReview({ ...reviewWith([]), intent: "" })).toThrow("review.intent");
  expect(() =>
    parsePrReview(reviewWith([{ file: "a.ts", line: 0, body: "x", severity: "nit" }])),
  ).toThrow("review.comments[0].line");
});

test("the numbered diff shows each line's new-file number, and removed lines show none", () => {
  const numbered = numberedDiff(PATCH).split("\n");
  expect(numbered).toContain("       -  send(file);");
  expect(numbered).toContain("    11 +  for (let attempt = 0; attempt < 3; attempt += 1) {");
  expect(numbered).toContain("    10    const file = open();");
  expect(numbered).toContain("@@ -10,4 +10,6 @@ export function upload() {");
});

test("line ranges compress consecutive lines", () => {
  expect(lineRanges(new Set([15, 10, 11, 12, 40, 41, 7]))).toBe("7, 10-12, 15, 40-41");
});

test("misplaced comments get a fix the reviewer can act on", () => {
  const review = parsePrReview(
    reviewWith([
      { id: "c1", file: "src/upload.ts", line: 12, body: "ok", severity: "nit" },
      { id: "c2", file: "src/upload.ts", line: 40, body: "off", severity: "nit" },
      { id: "c3", file: "src/other.ts", line: 3, body: "elsewhere", severity: "nit" },
    ]),
  );
  expect(anchorProblems(review, commentableLines(PATCH), true)).toEqual([
    "c2: line 40 of src/upload.ts is not in the diff; lines that can take comments: 10-15",
    "c3: src/other.ts is not in the diff; comment on a changed file or use summaryComment",
  ]);
  expect(anchorProblems(review, commentableLines(PATCH), false)).toEqual([
    "this is an intent review: leave comments empty and put those points in concerns and summaryComment",
  ]);
});

test("a multi-line comment must cover lines in one part of the diff", () => {
  const review = parsePrReview(
    reviewWith([
      {
        id: "r1",
        file: "src/upload.ts",
        startLine: 11,
        line: 13,
        body: "ok",
        severity: "suggestion",
      },
      { id: "r2", file: "src/upload.ts", startLine: 9, line: 12, body: "off", severity: "nit" },
    ]),
  );
  expect(anchorProblems(review, commentableLines(PATCH), true)).toEqual([
    "r2: lines 9-12 of src/upload.ts are not all in one part of the diff; lines that can take comments: 10-15",
  ]);
  const checked = checkReview(review, { kind: "full" }, commentableLines(PATCH));
  expect(checked.review.comments.map((comment) => comment.id)).toEqual(["r1"]);
  expect(checked.review.summaryComment).toContain("On `src/upload.ts:9-12`: off");
});

test("startLine must sit below line", () => {
  expect(() =>
    parsePrReview(
      reviewWith([{ file: "a.ts", startLine: 12, line: 12, body: "x", severity: "nit" }]),
    ),
  ).toThrow("startLine must be a positive integer below line");
});
