import { expect, test } from "bun:test";
import { defaultPolicy } from "../../src/config/policy.ts";
import type { PullRequestMetadata, ResolvedPolicy } from "../../src/contracts.ts";
import {
  decideRequiredStages,
  policyStageFacts,
  pullRequestPublished,
  requiredStagesOf,
} from "../../src/tasks/required-stages.ts";

function pullRequest(state: PullRequestMetadata["state"]): PullRequestMetadata {
  return { repository: "org/repo", number: 7, state, head: "head-1", base: "main" };
}

function policy(noChecks = false): ResolvedPolicy {
  return {
    config: { ...defaultPolicy(), ...(noChecks ? { validation: "none" as const } : {}) },
    guidance: { implementation: [], validation: [], review: [] },
  };
}

test.each([
  ["a normal new task", false, false, false, { validation: true, review: true }],
  ["a brief approved with skip review", true, false, false, { validation: true, review: false }],
  ["a project that chose no checks", false, false, true, { validation: false, review: true }],
  [
    "a project with no checks under a skip-review brief still reviews",
    true,
    false,
    true,
    { validation: false, review: true },
  ],
  [
    "steering a task whose pull request is published",
    false,
    true,
    false,
    {
      validation: false,
      review: false,
    },
  ],
  [
    "steering a published task under a skip-review brief",
    true,
    true,
    false,
    {
      validation: false,
      review: false,
    },
  ],
] as const)("%s", (_situation, briefSkipsReview, published, unvalidated, expected) => {
  expect(
    decideRequiredStages({ briefSkipsReview, pullRequestPublished: published, unvalidated }),
  ).toEqual(expected);
});

test("only an open pull request counts as published", () => {
  expect(pullRequestPublished({})).toBe(false);
  expect(pullRequestPublished({ pullRequest: pullRequest("draft") })).toBe(false);
  expect(pullRequestPublished({ pullRequest: pullRequest("open") })).toBe(true);
  expect(pullRequestPublished({ pullRequest: pullRequest("merged") })).toBe(false);
});

test("only a pinned policy that chose no checks is unvalidated", () => {
  expect(policyStageFacts({ policy: policy() })).toEqual({ unvalidated: false });
  expect(policyStageFacts({ policy: policy(true) })).toEqual({ unvalidated: true });
});

test("recorded stages win over the task's pull request", () => {
  expect(
    requiredStagesOf({
      requiredStages: { validation: true, review: true },
      pullRequest: pullRequest("open"),
      policy: policy(),
    }),
  ).toEqual({ validation: true, review: true });
});

test("a record saved without required stages derives them from its pull request and policy", () => {
  expect(requiredStagesOf({ policy: policy() })).toEqual({ validation: true, review: true });
  expect(requiredStagesOf({ pullRequest: pullRequest("open"), policy: policy() })).toEqual({
    validation: false,
    review: false,
  });
  expect(requiredStagesOf({ policy: policy(true) })).toEqual({ validation: false, review: true });
});
