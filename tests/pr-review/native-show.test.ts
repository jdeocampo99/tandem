import { expect, test } from "bun:test";
import { createPrReviewWorkflow, type PrReviewDependencies } from "../../src/pr-review/service.ts";
import { task } from "../session/fixtures.ts";

const reviewed = task({
  kind: "pr-review",
  stage: "completed",
  prReview: {
    ref: { repo: "acme/app", number: 7 },
    url: "https://github.com/acme/app/pull/7",
    title: "Retry",
    author: "author",
    baseRef: "main",
    checkout: "/checkout",
    remote: "origin",
    lens: { kind: "full" },
    mode: "review",
    rounds: [
      {
        generation: 1,
        head: "abc",
        from: "base",
        notes: [],
        review: {
          head: "abc",
          intent: "Retry uploads",
          tour: [],
          concerns: [],
          comments: [],
          summaryComment: "Cap the retries",
          priorComments: [],
        },
      },
    ],
  },
});

function dependencies(
  openNativePage: PrReviewDependencies["openNativePage"],
): PrReviewDependencies {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected effect");
  };
  return {
    home: "/unused",
    clock: () => reviewed.updatedAt,
    run: unexpected,
    projectRoots: unexpected,
    listTasks: unexpected,
    getTask: async () => reviewed,
    createTask: unexpected,
    updatePrReview: unexpected,
    mutatePrReview: unexpected,
    runAgain: unexpected,
    settle: unexpected,
    ...(openNativePage === undefined ? {} : { openNativePage }),
  };
}

test("Tern review-show opens the reviewed task without building or listening to a Lavish page", async () => {
  const opened: string[] = [];
  const workflow = createPrReviewWorkflow(
    dependencies(async (value) => {
      opened.push(value.id);
    }),
  );
  const shown = await workflow.show(reviewed.id, { page: true });
  expect(opened).toEqual([reviewed.id]);
  expect(shown.text).toContain("Retry uploads");
  expect(shown.pageUrl).toBeUndefined();
  expect(workflow.openPages()).toEqual([]);
  expect(await workflow.listen(reviewed.id, new AbortController().signal)).toEqual({
    kind: "closed",
  });
  await workflow.show(reviewed.id, { page: false });
  expect(opened).toHaveLength(1);
});

test("a refused native review open is surfaced without opening Lavish or retrying", async () => {
  let count = 0;
  const workflow = createPrReviewWorkflow(
    dependencies(async () => {
      count++;
      throw new Error("ambiguous window");
    }),
  );
  await expect(workflow.show(reviewed.id, { page: true })).rejects.toThrow("ambiguous window");
  expect(count).toBe(1);
});
