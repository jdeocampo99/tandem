import { expect, test } from "bun:test";
import { commentableLines, lineRanges, numberedDiff } from "../../src/pr-review/diff.ts";
import {
  anchorProblems,
  checkReview,
  parsePrReview,
  stopProblem,
  type TourStop,
} from "../../src/pr-review/review.ts";

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
    tour: [],
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

function stop(file: string, from: number, to: number, title = "A stop"): TourStop {
  return { file, from, to, title, body: "What happens here." };
}

test("a tour stop must be a forward range on a changed file that touches the diff", () => {
  const lines = commentableLines(PATCH);
  expect(stopProblem(stop("src/other.ts", 1, 3), lines)).toBe(
    "src/other.ts is not in the diff; stop on a changed file",
  );
  expect(stopProblem(stop("src/upload.ts", 13, 11), lines)).toBe(
    "13-11 is not a line range; use 1 <= from <= to",
  );
  expect(stopProblem(stop("src/upload.ts", 0, 12), lines)).toBe(
    "0-12 is not a line range; use 1 <= from <= to",
  );
  expect(stopProblem(stop("src/upload.ts", 20, 30), lines)).toBe(
    "lines 20-30 of src/upload.ts are outside the diff; lines in the diff: 10-15",
  );
  // Line 15 is an unchanged context line inside the hunk; a range reaching it is fine.
  expect(stopProblem(stop("src/upload.ts", 15, 25), lines)).toBeUndefined();
  expect(stopProblem(stop("src/upload.ts", 5, 20), lines)).toBeUndefined();
});

test("the reviewer is told which tour stops to fix, with the lines it can use", () => {
  const review = parsePrReview({
    ...reviewWith([]),
    tour: [
      {
        title: "Retry",
        why: "The loop",
        stops: [stop("src/upload.ts", 11, 13, "Loop"), stop("src/upload.ts", 30, 31, "Off")],
      },
    ],
  });
  expect(anchorProblems(review, commentableLines(PATCH), true)).toEqual([
    'tour stop "Off": lines 30-31 of src/upload.ts are outside the diff; lines in the diff: 10-15',
  ]);
});

test("the runner drops bad stops and chapters left empty, and says so", () => {
  const checked = checkReview(
    {
      ...reviewWith([]),
      tour: [
        {
          title: "Retry",
          why: "The loop",
          stops: [stop("src/upload.ts", 11, 13), stop("x.ts", 1, 1)],
        },
        { title: "Gone", why: "Nothing valid", stops: [stop("src/upload.ts", 40, 41)] },
      ],
    },
    { kind: "full" },
    commentableLines(PATCH),
  );
  expect(checked.review.tour).toEqual([
    { title: "Retry", why: "The loop", stops: [stop("src/upload.ts", 11, 13)] },
  ]);
  expect(checked.notes).toEqual([
    "2 tour stops pointed outside the diff, so they were left out of the tour.",
  ]);
});

test("a round stored before the tour still reads, with an empty tour", () => {
  const stored = {
    head: "abc123",
    intent: "Retries failed uploads.",
    diagram: "flowchart TD\n  a --> b",
    readingOrder: [{ file: "src/upload.ts", why: "the retry loop" }],
    concerns: [],
    comments: [],
    summaryComment: "Looks good.",
  };
  const review = parsePrReview(stored);
  expect(review.tour).toEqual([]);
  expect(review.verdict).toBeUndefined();
  expect(Object.keys(review)).not.toContain("diagram");
  expect(Object.keys(review)).not.toContain("readingOrder");
});
