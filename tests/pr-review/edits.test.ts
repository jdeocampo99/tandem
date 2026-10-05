import { expect, test } from "bun:test";
import { applyEdits, submissionEdits } from "../../src/pr-review/edits.ts";
import type { ReviewSubmission } from "../../src/pr-review/page.ts";
import type { DraftComment, PrReview } from "../../src/pr-review/review.ts";

const COMMENTABLE = new Map([["src/upload.ts", new Set([10, 11, 12, 13, 20])]]);

function draft(id: string, line: number, body = `draft ${id}`): DraftComment {
  return { id, file: "src/upload.ts", line, body, severity: "suggestion" };
}

const review: PrReview = {
  head: "abc123",
  intent: "Retries uploads.",
  tour: [],
  concerns: [],
  comments: [draft("c1", 10), draft("c2", 11), draft("u1", 12), draft("c3", 13)],
  summaryComment: "Looks close.",
  priorComments: [],
};

test("added comments get the next free u-ids and sit after the drafts", () => {
  const edited = applyEdits(
    review,
    {
      add: [
        { file: "src/upload.ts", line: 20, body: " Could this be a constant? " },
        { file: "src/upload.ts", line: 11, body: "And this?" },
      ],
    },
    COMMENTABLE,
  );
  expect(edited.comments.map((comment) => comment.id)).toEqual([
    "c1",
    "c2",
    "u1",
    "c3",
    "u2",
    "u3",
  ]);
  expect(edited.comments.at(-2)).toEqual({
    id: "u2",
    file: "src/upload.ts",
    line: 20,
    body: "Could this be a constant?",
    severity: "suggestion",
  });
});

test("a comment on a line the diff cannot anchor is refused with the lines that can take one", () => {
  expect(() =>
    applyEdits(
      review,
      {
        add: [
          { file: "src/upload.ts", line: 15, body: "Hm" },
          { file: "src/other.ts", line: 1, body: "Hm" },
        ],
      },
      COMMENTABLE,
    ),
  ).toThrow(
    "Line 15 of src/upload.ts can't take a comment; lines that can: 10-13, 20.\nsrc/other.ts is not in the diff, so it can't take a comment.",
  );
});

test("rewrites, relabels, and drops still apply by id, and an unknown id is refused", () => {
  const edited = applyEdits(
    review,
    {
      comments: [
        { id: "c1", drop: true },
        { id: "c2", body: "Reworded", severity: "nit" },
      ],
      summaryComment: " New summary ",
    },
    COMMENTABLE,
  );
  expect(edited.comments.map((comment) => comment.id)).toEqual(["c2", "u1", "c3"]);
  expect(edited.comments[0]).toMatchObject({ body: "Reworded", severity: "nit" });
  expect(edited.summaryComment).toBe("New summary");
  expect(() => applyEdits(review, { comments: [{ id: "c9", drop: true }] }, COMMENTABLE)).toThrow(
    "No draft comment with id c9",
  );
});

function submission(overrides: Partial<ReviewSubmission> = {}): ReviewSubmission {
  return {
    tandemPrReview: 1,
    verdict: "request-changes",
    summary: "Two things before this merges.",
    drafts: [
      { id: "c1", decision: "post" },
      { id: "c2", decision: "post", body: "Edited on the page" },
      { id: "u1", decision: "drop" },
      { id: "c3", decision: "undecided", body: "Edited but never added" },
    ],
    yours: [{ file: "src/upload.ts", line: 20, body: "My own point" }],
    ...overrides,
  };
}

test("a submission keeps only the drafts marked post, with the user's wording, and adds theirs", () => {
  const edited = applyEdits(review, submissionEdits(review, submission()), COMMENTABLE);
  expect(edited.comments).toEqual([
    draft("c1", 10),
    draft("c2", 11, "Edited on the page"),
    { id: "u2", file: "src/upload.ts", line: 20, body: "My own point", severity: "suggestion" },
  ]);
  expect(edited.summaryComment).toBe("Two things before this merges.");
});

test("a draft the page never mentions is left out, and an id the review lacks is an error", () => {
  const edited = applyEdits(
    review,
    submissionEdits(review, submission({ drafts: [{ id: "c3", decision: "post" }], yours: [] })),
    COMMENTABLE,
  );
  expect(edited.comments.map((comment) => comment.id)).toEqual(["c3"]);
  expect(() =>
    submissionEdits(review, submission({ drafts: [{ id: "c7", decision: "post" }] })),
  ).toThrow("The page sent draft ids this review does not have: c7");
});
