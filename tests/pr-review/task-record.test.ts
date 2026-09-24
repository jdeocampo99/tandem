import { expect, test } from "bun:test";
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
  model: { model: "test/review", thinking: "high" },
  prompt: "review",
  resultPath: "/tmp/result.json",
  prReview: { structuredReport: true },
};

const review = {
  head: "abc123",
  intent: "Retries uploads.",
  readingOrder: [],
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
