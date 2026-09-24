import { expect, test } from "bun:test";
import { commentableLines } from "../../src/pr-review/diff.ts";
import { checkReview, parsePrReview } from "../../src/pr-review/review.ts";

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
