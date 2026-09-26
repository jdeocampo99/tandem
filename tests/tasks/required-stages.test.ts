import { expect, test } from "bun:test";
import type { PullRequestMetadata } from "../../src/contracts.ts";
import {
  decideRequiredStages,
  pullRequestPublished,
  requiredStagesOf,
} from "../../src/tasks/required-stages.ts";

function pullRequest(state: PullRequestMetadata["state"]): PullRequestMetadata {
  return { repository: "org/repo", number: 7, state, head: "head-1", base: "main" };
}

test.each([
  ["a normal new task", false, false, { validation: true, review: true }],
  ["a brief approved with skip review", true, false, { validation: true, review: false }],
  [
    "steering a task whose pull request is published",
    false,
    true,
    {
      validation: false,
      review: false,
    },
  ],
  [
    "steering a published task under a skip-review brief",
    true,
    true,
    {
      validation: false,
      review: false,
    },
  ],
] as const)("%s", (_situation, briefSkipsReview, published, expected) => {
  expect(decideRequiredStages({ briefSkipsReview, pullRequestPublished: published })).toEqual(
    expected,
  );
});

test("only an open pull request counts as published", () => {
  expect(pullRequestPublished({})).toBe(false);
  expect(pullRequestPublished({ pullRequest: pullRequest("draft") })).toBe(false);
  expect(pullRequestPublished({ pullRequest: pullRequest("open") })).toBe(true);
  expect(pullRequestPublished({ pullRequest: pullRequest("merged") })).toBe(false);
});

test("recorded stages win over the task's pull request", () => {
  expect(
    requiredStagesOf({
      requiredStages: { validation: true, review: true },
      pullRequest: pullRequest("open"),
    }),
  ).toEqual({ validation: true, review: true });
});

test("a record saved without required stages derives them from its pull request", () => {
  expect(requiredStagesOf({})).toEqual({ validation: true, review: true });
  expect(requiredStagesOf({ pullRequest: pullRequest("open") })).toEqual({
    validation: false,
    review: false,
  });
});
