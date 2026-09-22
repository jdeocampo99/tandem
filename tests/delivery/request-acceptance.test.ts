import { expect, test } from "bun:test";
import type {
  ModelSpec,
  PinnedValidationEvidence,
  RepoPolicy,
  RequestIntegration,
  ResolvedPolicy,
  ReviewLens,
  ReviewResult,
  TaskRecord,
  WorktreeLease,
} from "../../src/contracts.ts";
import {
  assertRequestAcceptance,
  describeRequestDraftPr,
  describeRequestPr,
  type PrSummary,
  requestAcceptanceStatus,
} from "../../src/delivery/evidence.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";

const NOW = "2030-01-02T03:04:05.000Z";
const INTEGRATED_HEAD = "integrated-head-1";
const MEMBER_HEAD = "member-head-1";
const CRITERIA = ["The whole request is delivered through one verified pull request."];

const models: Readonly<Record<string, ModelSpec>> = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  verifier: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
};

const policyConfig: RepoPolicy = {
  version: 1,
  models: models as RepoPolicy["models"],
  instructions: { implementation: [], validation: [], review: [] },
  instructionFiles: { implementation: [], validation: [], review: [] },
  validationCommands: [
    { name: "check", argv: ["bun", "run", "check"], surfaces: ["api"], timeoutMs: 10_000 },
  ],
  maxWorkers: 3,
  maxFixRounds: 3,
  reviewLevels: {
    reducedRouting: false,
    deepScrutiny: false,
    jevAssistance: "off",
    sourceTransmission: false,
  },
  requestBudget: { capMicros: "unset", operationEstimateMicros: "unset" },
};

const policy: ResolvedPolicy = {
  config: policyConfig,
  guidance: { implementation: [], validation: [], review: [] },
};

const lease: WorktreeLease = {
  root: "/tmp/pool",
  path: "/tmp/pool/request",
  name: "req-1",
  baseHead: "0".repeat(40),
  branch: "tandem/req-1",
  leaseId: "lease-request",
  leaseHolder: "tandem-req-1",
  leasedAt: NOW,
};

const summary: PrSummary = {
  tldr: ["Delivers the whole request at once."],
  what: ["Integrates every approved member."],
  why: ["A component is not the request."],
};

function review(lens: ReviewLens, head: string): ReviewResult {
  return { lens, head, generation: 0, pass: true, findings: [], summary: `${lens} passed` };
}

function evidence(head: string): PinnedValidationEvidence {
  return {
    name: "check",
    argv: ["bun", "run", "check"],
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    head,
    contract: "final",
    origin: "local",
    policyDigest: policyIdentity(policy),
  };
}

function member(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 9,
    repoPath: "/repo",
    requestId: "req-1",
    kind: "implementation",
    objective: "Deliver one member of the request",
    acceptanceCriteria: ["The member is reviewed."],
    surfaces: ["api"],
    stage: "ready",
    scopeApproved: true,
    policy,
    createdAt: NOW,
    updatedAt: NOW,
    worktree: { ...lease, branch: "tandem/task-1" },
    generation: 0,
    reviewRound: 0,
    reviewHead: MEMBER_HEAD,
    validationEvidence: [evidence(MEMBER_HEAD)],
    reviews: [
      review("behavior", MEMBER_HEAD),
      review("design", MEMBER_HEAD),
      review("coverage", MEMBER_HEAD),
      review("verification", MEMBER_HEAD),
    ],
    notifications: [],
    ...overrides,
  };
}

function integration(overrides: Partial<RequestIntegration> = {}): RequestIntegration {
  return {
    worktree: lease,
    baseHead: "0".repeat(40),
    head: INTEGRATED_HEAD,
    members: [{ taskId: "task-1", branch: "tandem/task-1", head: MEMBER_HEAD }],
    policyDigest: policyIdentity(policy),
    ownerSessionId: "session-1",
    integratedAt: NOW,
    evidence: [evidence(INTEGRATED_HEAD)],
    reviews: [
      review("behavior", INTEGRATED_HEAD),
      review("design", INTEGRATED_HEAD),
      review("coverage", INTEGRATED_HEAD),
      review("verification", INTEGRATED_HEAD),
    ],
    ...overrides,
  };
}

test("the integrated delivery is accepted only with checks and lenses bound to its own commit", () => {
  const status = requestAcceptanceStatus({
    integration: integration(),
    members: [member()],
    criteria: CRITERIA,
  });

  expect(status.satisfied).toBe(true);
  expect(status.contract.head).toBe(INTEGRATED_HEAD);
  expect(status.contract.criteria).toEqual(CRITERIA);
});

test("evidence recorded only at a member commit is refused as stale for the integrated commit", () => {
  const status = requestAcceptanceStatus({
    integration: integration({ evidence: [evidence(MEMBER_HEAD)] }),
    members: [member()],
    criteria: CRITERIA,
  });

  expect(status.satisfied).toBe(false);
  expect(status.manifest.stale.map((entry) => entry.name)).toEqual(["check"]);
  expect(() =>
    assertRequestAcceptance({
      integration: integration({ evidence: [evidence(MEMBER_HEAD)] }),
      members: [member()],
      criteria: CRITERIA,
    }),
  ).toThrow(/did not pass at the integrated HEAD/u);
});

test("review lenses recorded only at a member commit leave the integrated commit unreviewed", () => {
  const status = requestAcceptanceStatus({
    integration: integration({ reviews: [] }),
    members: [member()],
    criteria: CRITERIA,
  });

  expect(status.satisfied).toBe(false);
  expect(status.manifest.pendingLenses).toEqual(["behavior", "design", "coverage", "verification"]);
});

test("a member whose reviewed commit moved after integration refuses the delivery", () => {
  const status = requestAcceptanceStatus({
    integration: integration(),
    members: [member({ reviewHead: "member-head-2" })],
    criteria: CRITERIA,
  });

  expect(status.satisfied).toBe(false);
  expect(status.refusals.join(" ")).toContain("moved to HEAD member-head-2");
});

test("a member that is not a finished component refuses the delivery", () => {
  const status = requestAcceptanceStatus({
    integration: integration(),
    members: [member({ stage: "implementing" })],
    criteria: CRITERIA,
  });

  expect(status.refusals.join(" ")).toContain("is implementing, not a finished component");
});

test("a member absent from the integrated commit refuses the delivery", () => {
  const status = requestAcceptanceStatus({
    integration: integration(),
    members: [member(), member({ id: "task-2", reviewHead: "member-head-2" })],
    criteria: CRITERIA,
  });

  expect(status.refusals.join(" ")).toContain("task-2 is not contained in the integrated commit");
});

test("a member waiting on its hands-on check refuses the delivery", () => {
  const status = requestAcceptanceStatus({
    integration: integration(),
    members: [
      member({
        userCheckCriteria: ["Streak bar glows at 5 in a row"],
      }),
    ],
    criteria: CRITERIA,
  });

  expect(status.satisfied).toBe(false);
  expect(status.refusals.join(" ")).toContain(
    "task-1 is waiting for your check of its hands-on criteria",
  );
});

test("a member with a confirmed hands-on check does not refuse the delivery on that basis", () => {
  const status = requestAcceptanceStatus({
    integration: integration(),
    members: [
      member({
        userCheckCriteria: ["Streak bar glows at 5 in a row"],
        userCheck: {
          head: MEMBER_HEAD,
          generation: 0,
          evidence: [{ criterion: "Streak bar glows at 5 in a row", paths: ["/home/jobs/a.png"] }],
          answer: { outcome: "confirmed", answeredAt: NOW },
        },
      }),
    ],
    criteria: CRITERIA,
  });

  expect(status.refusals.join(" ")).not.toContain("hands-on criteria");
});

test("the request pull request body describes the checks in plain terms and lists members by id alone", () => {
  const body = describeRequestPr(
    { integration: integration(), members: [member()], criteria: CRITERIA },
    summary,
  );

  expect(body).toContain("The checks ran on the latest version of the combined work");
  expect(body).toContain("Combined from: task-1");
  expect(body).not.toContain(`task-1 at ${MEMBER_HEAD}`);
  expect(body).not.toContain("final acceptance manifest at the integrated HEAD");
});

test("a request draft stays visibly unfinished and lists what the request still owes", () => {
  const body = describeRequestDraftPr({
    requestId: "req-1",
    objective: "request req-1 delivers 2 approved task(s)",
    integratedHead: INTEGRATED_HEAD,
    members: ["task-1", "task-2"],
    activity: ["task-2 is still running."],
    blockers: [],
    remainingChecks: ["1 member(s) are still running"],
  });

  expect(body).toContain("Request req-1 is not finished.");
  expect(body).toContain("This draft reflects the latest version of the combined work.");
  expect(body).not.toContain(INTEGRATED_HEAD);
  expect(body).toContain("1 member(s) are still running");
});
