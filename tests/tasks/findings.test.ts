import { expect, test } from "bun:test";
import type {
  Finding,
  FindingLedgerEntry,
  ResolvedPolicy,
  ReviewLens,
  ReviewResult,
  TaskRecord,
} from "../../src/contracts.ts";
import {
  describeFixRoundExhaustion,
  isBlockingFinding,
  ledgerBlockers,
  ledgerSuggestions,
  recordReviewFindings,
  settledFindings,
} from "../../src/tasks/findings.ts";

const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: { model: "test/coordinator", thinking: "low" },
      scout: { model: "test/scout", thinking: "low" },
      implementer: { model: "test/implementer", thinking: "low" },
      reviewer: { model: "test/reviewer", thinking: "low" },
      verifier: { model: "test/verifier", thinking: "low" },
      presentation: { model: "test/presentation", thinking: "low" },
    },
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [
      { name: "check", argv: ["bun", "run", "check"], surfaces: ["service"], timeoutMs: 1_000 },
    ],
    setupCommands: [],
    maxWorkers: 3,
    maxFixRounds: 2,
    reviewLevels: {
      reducedRouting: false,
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
    requestBudget: { capMicros: "unset", operationEstimateMicros: "unset" },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

function finding(input: Partial<Finding> & Pick<Finding, "id">): Finding {
  return {
    severity: "P1",
    verdict: "confirmed",
    description: "The retry loop drops the cancellation signal.",
    file: "src/service/controller.ts",
    ...input,
  };
}

function review(
  input: Readonly<{
    lens?: ReviewLens;
    head: string;
    generation: number;
    findings: readonly Finding[];
  }>,
): ReviewResult {
  return {
    lens: input.lens ?? "behavior",
    head: input.head,
    generation: input.generation,
    pass: input.findings.length === 0,
    findings: input.findings,
    summary: "recorded review",
  };
}

function taskWith(
  ledger: readonly FindingLedgerEntry[],
  reviewRound = policy.config.maxFixRounds,
): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-1",
    revision: 1,
    repoPath: "/repo",
    kind: "implementation",
    objective: "Bound the retry loop",
    acceptanceCriteria: ["Cancellation is honoured"],
    surfaces: ["service"],
    stage: "awaiting-fixes",
    scopeApproved: true,
    policy,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    generation: 2,
    reviewRound,
    reviewHead: "head-2",
    validationEvidence: [],
    reviews: [],
    findingLedger: ledger,
    notifications: [],
  };
}

test("separates evidence-backed blockers from optional suggestions by the recorded pass rule", () => {
  expect(isBlockingFinding({ severity: "P2", verdict: "confirmed" })).toBe(true);
  expect(isBlockingFinding({ severity: "P2", verdict: "plausible" })).toBe(false);
  expect(isBlockingFinding({ severity: "P1", verdict: "plausible" })).toBe(true);
  expect(isBlockingFinding({ severity: "P3", verdict: "confirmed" })).toBe(false);
});

test("a first review raises each finding as unresolved with a stable identity", () => {
  const ledger = recordReviewFindings({
    ledger: [],
    review: review({ head: "head-1", generation: 0, findings: [finding({ id: "f-1" })] }),
    reviewRound: 0,
  });

  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.id).toBe("f-1");
  expect(ledger[0]?.status).toBe("unresolved");
  expect(ledger[0]?.raisedAt).toEqual({ head: "head-1", generation: 0, reviewRound: 0 });
  expect(ledger[0]?.statusAt).toEqual({ head: "head-1", generation: 0, reviewRound: 0 });
});

test("a later review that stops reporting a finding settles it with the supporting change", () => {
  const first = recordReviewFindings({
    ledger: [],
    review: review({ head: "head-1", generation: 0, findings: [finding({ id: "f-1" })] }),
    reviewRound: 0,
  });
  const second = recordReviewFindings({
    ledger: first,
    review: review({ head: "head-2", generation: 1, findings: [] }),
    reviewRound: 1,
  });

  expect(settledFindings(second).map((entry) => entry.id)).toEqual(["f-1"]);
  expect(second[0]?.statusAt).toEqual({ head: "head-2", generation: 1, reviewRound: 1 });
  expect(ledgerBlockers(second)).toEqual([]);
});

test("a settled finding reopens as regressed only when a later review reports it again", () => {
  const first = recordReviewFindings({
    ledger: [],
    review: review({ head: "head-1", generation: 0, findings: [finding({ id: "f-1" })] }),
    reviewRound: 0,
  });
  const settled = recordReviewFindings({
    ledger: first,
    review: review({ head: "head-2", generation: 1, findings: [] }),
    reviewRound: 1,
  });
  const reopened = recordReviewFindings({
    ledger: settled,
    review: review({ head: "head-3", generation: 2, findings: [finding({ id: "f-1" })] }),
    reviewRound: 2,
  });

  expect(reopened[0]?.status).toBe("regressed");
  expect(reopened[0]?.raisedAt.head).toBe("head-1");
  expect(reopened[0]?.statusAt.head).toBe("head-3");
  expect(ledgerBlockers(reopened).map((entry) => entry.id)).toEqual(["f-1"]);
});

test("a re-reported finding stays unresolved rather than being raised again", () => {
  const first = recordReviewFindings({
    ledger: [],
    review: review({ head: "head-1", generation: 0, findings: [finding({ id: "f-1" })] }),
    reviewRound: 0,
  });
  const second = recordReviewFindings({
    ledger: first,
    review: review({ head: "head-2", generation: 1, findings: [finding({ id: "f-1" })] }),
    reviewRound: 1,
  });

  expect(second).toHaveLength(1);
  expect(second[0]?.status).toBe("unresolved");
  expect(second[0]?.raisedAt.reviewRound).toBe(0);
  expect(second[0]?.statusAt.reviewRound).toBe(1);
});

test("contradicting verdicts for one identity are recorded as disputed", () => {
  const first = recordReviewFindings({
    ledger: [],
    review: review({ head: "head-1", generation: 0, findings: [finding({ id: "f-1" })] }),
    reviewRound: 0,
  });
  const disputed = recordReviewFindings({
    ledger: first,
    review: review({
      head: "head-2",
      generation: 1,
      findings: [finding({ id: "f-1", verdict: "plausible" })],
    }),
    reviewRound: 1,
  });

  expect(disputed[0]?.status).toBe("disputed");
  expect(ledgerBlockers(disputed).map((entry) => entry.id)).toEqual(["f-1"]);
});

test("another lens does not settle a finding it never reviewed", () => {
  const behavior = recordReviewFindings({
    ledger: [],
    review: review({ head: "head-1", generation: 0, findings: [finding({ id: "f-1" })] }),
    reviewRound: 0,
  });
  const design = recordReviewFindings({
    ledger: behavior,
    review: review({ lens: "design", head: "head-2", generation: 1, findings: [] }),
    reviewRound: 1,
  });

  expect(design[0]?.status).toBe("unresolved");
});

test("a P3 finding is carried as a suggestion rather than a blocker", () => {
  const ledger = recordReviewFindings({
    ledger: [],
    review: review({
      head: "head-1",
      generation: 0,
      findings: [finding({ id: "f-3", severity: "P3", verdict: "plausible" })],
    }),
    reviewRound: 0,
  });

  expect(ledgerBlockers(ledger)).toEqual([]);
  expect(ledgerSuggestions(ledger).map((entry) => entry.id)).toEqual(["f-3"]);
});

test("fix-round exhaustion names the remaining blockers and the available decision", () => {
  const ledger = recordReviewFindings({
    ledger: [],
    review: review({
      head: "head-1",
      generation: 0,
      findings: [finding({ id: "f-1" }), finding({ id: "f-2", severity: "P3" })],
    }),
    reviewRound: 0,
  });
  const reason = describeFixRoundExhaustion(taskWith(ledger));

  expect(reason).toContain("Bounded review loop exhausted");
  expect(reason).toContain("fix round budget spent at 2 of 2");
  expect(reason).toContain("the task is not ready and not accepted");
  expect(reason).toContain("1 evidence-backed blocker(s) remain");
  expect(reason).toContain("behavior/f-1");
  expect(reason).not.toContain("behavior/f-2");
  expect(reason).toContain("stop for a human decision, or revise and re-approve the task scope");
  expect(reason).toContain("No blocker is downgraded to a suggestion");
});

test("fix-round exhaustion with no recorded blocker still refuses a silent retry", () => {
  const reason = describeFixRoundExhaustion(taskWith([]));

  expect(reason).toContain("no evidence-backed blocker is recorded");
  expect(reason).toContain("no round is retried automatically");
});
