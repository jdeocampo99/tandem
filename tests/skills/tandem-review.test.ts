import { expect, test } from "bun:test";
import {
  type Batch,
  computeDeltas,
  validateBatch,
} from "../../.claude/skills/tandem-review/render.ts";

function batch(overrides: Partial<Batch["metrics"]> = {}): Batch {
  return {
    ranAt: "2026-09-27T00:00:00.000Z",
    since: "baseline",
    taskCount: 21,
    verdict: "Baseline.",
    metrics: {
      firstPassReview: { num: 0, den: 8 },
      fixRoundsPerTask: 1.2,
      merged: { num: 0, den: 8 },
      offScopeFiles: null,
      briefNoRate: null,
      ...overrides,
    },
    problems: [],
    cards: [],
    noProblem: [],
    folded: [],
  };
}

test("validateBatch accepts a well-formed batch", () => {
  const raw = JSON.parse(JSON.stringify(batch()));
  expect(validateBatch(raw)).toEqual(batch());
});

test("validateBatch names the bad field on a type mismatch", () => {
  const raw = JSON.parse(JSON.stringify(batch()));
  raw.metrics.firstPassReview.num = "zero";
  expect(() => validateBatch(raw)).toThrow('"batch.metrics.firstPassReview.num" must be a number');
});

test("validateBatch rejects an unknown problem status", () => {
  const raw = JSON.parse(JSON.stringify(batch()));
  raw.problems = [{ name: "x", count: 1, source: "agent", status: "worse" }];
  expect(() => validateBatch(raw)).toThrow('"batch.problems[0].status"');
});

test("computeDeltas reports every tile as baseline with no previous batch", () => {
  const deltas = computeDeltas(batch(), undefined);
  expect(deltas.firstPassReview).toEqual({ kind: "baseline" });
  expect(deltas.fixRoundsPerTask).toEqual({ kind: "baseline" });
});

test("computeDeltas reports a percentage-point delta for a rate metric", () => {
  const previous = batch({ firstPassReview: { num: 2, den: 8 } }); // 25%
  const current = batch({ firstPassReview: { num: 6, den: 8 } }); // 75%
  expect(computeDeltas(current, previous).firstPassReview).toEqual({
    kind: "delta",
    text: "+50pp vs last",
  });
});

test("computeDeltas keeps a nullable metric honest when either side is unmeasured", () => {
  const previous = batch({ offScopeFiles: null });
  const current = batch({ offScopeFiles: 3 });
  expect(computeDeltas(current, previous).offScopeFiles).toEqual({
    kind: "delta",
    text: "not measured yet",
  });
});
