import { expect, test } from "bun:test";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import type { PrReviewState } from "../../src/pr-review/state.ts";
import { createTask } from "../../src/tasks/lifecycle.ts";
import { parseTaskRecord } from "../../src/tasks/store-codec.ts";
import type { WorkerJob } from "../../src/workers/jobs.ts";
import { ReportRejection, resolveSubmittedReport } from "../../src/workers/protocol.ts";
import { SCENARIO_NOW, SCENARIO_POLICY } from "../evals/scenario.ts";

const prReview: PrReviewState = {
  ref: { repo: "acme/api", number: 7 },
  url: "https://github.com/acme/api/pull/7",
  title: "Retry uploads",
  author: "sam",
  baseRef: "main",
  checkout: "/work/api",
  remote: "origin",
  lens: { kind: "intent" },
  mode: "review",
  rounds: [],
};

const base = {
  id: "task-1",
  repoPath: "/work/project",
  objective: "Review acme/api#7",
  acceptanceCriteria: [],
  surfaces: [],
  policy: SCENARIO_POLICY,
};

test("a PR review starts queued without approval and survives a store round trip", () => {
  const task = createTask({ ...base, kind: "pr-review", prReview }, SCENARIO_NOW);
  expect(task.stage).toBe("queued");
  expect(task.scopeApproved).toBe(true);
  expect(parseTaskRecord(JSON.parse(JSON.stringify(task)))).toEqual(task);
});

test("PR state belongs to PR review tasks only", () => {
  expect(() => createTask({ ...base, kind: "pr-review" }, SCENARIO_NOW)).toThrow("prReview");
  expect(() => createTask({ ...base, kind: "scout", prReview }, SCENARIO_NOW)).toThrow("prReview");
  const scout = createTask({ ...base, kind: "scout" }, SCENARIO_NOW);
  expect(() => parseTaskRecord({ ...scout, prReview })).toThrow("only pr-review tasks");
});

const job: WorkerJob = {
  schemaVersion: 1,
  id: "job-1",
  taskId: "task-1",
  generation: 0,
  role: "scout",
  cwd: "/work/review",
  harness: DEFAULT_HARNESS,
  model: { model: "test/review", thinking: "high" },
  prompt: "review",
  resultPath: "/tmp/result.json",
  prReview: { structuredReport: true },
};

const review = {
  head: "abc123",
  intent: "Retries uploads.",
  tour: [],
  concerns: [],
  comments: [],
  summaryComment: "Looks good.",
};

test("a structured PR review report must be one review object; a fence around it is fine", () => {
  const fenced = resolveSubmittedReport(job, {
    outcome: "completed",
    report: `\`\`\`json\n${JSON.stringify(review)}\n\`\`\``,
  });
  expect(JSON.parse(fenced.text)).toMatchObject({ head: "abc123", intent: "Retries uploads." });

  expect(() =>
    resolveSubmittedReport(job, { outcome: "completed", report: "Here is my review: looks fine" }),
  ).toThrow(ReportRejection);
  expect(() =>
    resolveSubmittedReport(job, {
      outcome: "completed",
      report: JSON.stringify({ ...review, intent: "" }),
    }),
  ).toThrow("review.intent");
});

test("a review with a comment off the diff is sent back with the lines it can use", () => {
  const anchors = new Map([["src/upload.ts", new Set([10, 11, 12])]]);
  const submit = (line: number) =>
    resolveSubmittedReport(
      job,
      {
        outcome: "completed",
        report: JSON.stringify({
          ...review,
          comments: [{ id: "c1", file: "src/upload.ts", line, body: "hm", severity: "nit" }],
        }),
      },
      anchors,
    );
  expect(() => submit(40)).toThrow("lines that can take comments: 10-12");
  expect(JSON.parse(submit(11).text).comments).toHaveLength(1);
});

test("a review with a tour stop off the diff is sent back naming the stop and its lines", () => {
  const anchors = new Map([["src/upload.ts", new Set([10, 11, 12])]]);
  const submit = (from: number, to: number) =>
    resolveSubmittedReport(
      job,
      {
        outcome: "completed",
        report: JSON.stringify({
          ...review,
          tour: [
            {
              title: "Upload",
              why: "The retry",
              stops: [{ file: "src/upload.ts", from, to, title: "Retry loop", body: "Loops." }],
            },
          ],
        }),
      },
      anchors,
    );
  expect(() => submit(30, 32)).toThrow(
    'tour stop "Retry loop": lines 30-32 of src/upload.ts are outside the diff; lines in the diff: 10-12',
  );
  expect(JSON.parse(submit(9, 11).text).tour[0].stops).toHaveLength(1);
});

test("reply claims, outcomes and receipts survive the task codec and reject invalid reply bindings", () => {
  const reply = {
    threadId: "thread-1",
    commentId: "node-22",
    replyTo: 22,
    body: "Keep this guard.",
  };
  const round = {
    generation: 0,
    head: "abc123",
    from: "base000",
    notes: [],
    review: { ...review, replies: [reply] },
    posted: {
      url: "https://github.com/acme/api/pull/7#pullrequestreview-1",
      verdict: "comment",
      postedAt: SCENARIO_NOW,
    },
  };
  const record = createTask(
    { ...base, kind: "pr-review", prReview: { ...prReview, rounds: [] } },
    SCENARIO_NOW,
  );
  for (const post of [
    { index: 0, kind: "pending", attemptedAt: SCENARIO_NOW, attemptRevision: 1 },
    {
      index: 0,
      kind: "uncertain",
      attemptedAt: SCENARIO_NOW,
      attemptRevision: 1,
      message: "response lost",
    },
    { index: 0, kind: "failed", message: "PR moved" },
    {
      index: 0,
      kind: "posted",
      url: "https://github.com/acme/api/pull/7#discussion_r23",
      postedAt: SCENARIO_NOW,
      confirmedByUser: true,
    },
  ] as const) {
    const input = {
      ...record,
      prReview: { ...prReview, rounds: [{ ...round, replyPosts: [post] }] },
    };
    expect(
      parseTaskRecord(JSON.parse(JSON.stringify(input))).prReview?.rounds[0]?.replyPosts,
    ).toEqual([post]);
    expect(() =>
      parseTaskRecord({
        ...input,
        prReview: { ...input.prReview, rounds: [{ ...round, replyPosts: [post, post] }] },
      }),
    ).toThrow("unique saved reply");
    expect(() =>
      parseTaskRecord({
        ...input,
        prReview: {
          ...input.prReview,
          rounds: [{ ...round, replyPosts: [{ ...post, index: 1 }] }],
        },
      }),
    ).toThrow("unique saved reply");
  }
});
