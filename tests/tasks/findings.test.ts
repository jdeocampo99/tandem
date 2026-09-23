import { expect, test } from "bun:test";
import type {
  Finding,
  FindingLedgerEntry,
  ResolvedPolicy,
  ReviewResult,
  StoredReviewLens,
  TaskRecord,
} from "../../src/contracts.ts";
import {
  describeOpenFindings,
  fixRoundBudget,
  isBlockingFinding,
  KEEP_FIXING_QUESTION_ID_PREFIX,
  keepFixingGrant,
  keepFixingQuestion,
  ledgerBlockers,
  ledgerSuggestions,
  recordReviewFindings,
  repeatedFindings,
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
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
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
    lens?: StoredReviewLens;
    head: string;
    generation: number;
    findings: readonly Finding[];
  }>,
): ReviewResult {
  return {
    lens: input.lens ?? "review",
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

test("a later merged review settles a finding raised under a legacy lens name", () => {
  // ponytail: "behavior" is a pre-merge lens name; a stored finding under it must still decode
  // and, since one merged review now covers everything, settle once that review no longer reports it.
  const legacy = recordReviewFindings({
    ledger: [],
    review: review({
      lens: "behavior",
      head: "head-1",
      generation: 0,
      findings: [finding({ id: "f-1" })],
    }),
    reviewRound: 0,
  });
  const merged = recordReviewFindings({
    ledger: legacy,
    review: review({ head: "head-2", generation: 1, findings: [] }),
    reviewRound: 1,
  });

  expect(merged[0]?.status).toBe("addressed");
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

test("the open-findings details name the remaining blockers and forbid a new task", () => {
  const ledger = recordReviewFindings({
    ledger: [],
    review: review({
      head: "head-1",
      generation: 0,
      findings: [finding({ id: "f-1" }), finding({ id: "f-2", severity: "P3" })],
    }),
    reviewRound: 0,
  });
  const details = describeOpenFindings(taskWith(ledger));

  expect(details).toContain("Fix round 2 of 2");
  expect(details).toContain("1 open blocker(s)");
  expect(details).toContain("review/f-1");
  expect(details).not.toContain("f-2");
  expect(details).toContain("Never start a new task");
});

test("the open-findings details still explain an empty ledger", () => {
  expect(describeOpenFindings(taskWith([]))).toContain("No open blocker is recorded");
});

test("a spent fix-round budget asks Keep fixing? instead of failing silently", () => {
  const question = keepFixingQuestion(taskWith([]));

  expect(question?.id).toBe(`${KEEP_FIXING_QUESTION_ID_PREFIX}2`);
  expect(question?.text).toBe('Keep fixing "Bound the retry loop"? It used all 2 fix rounds.');
  expect(question?.recommendation).toContain('Reply "yes"');
  expect(keepFixingQuestion(taskWith([], 1))).toBeUndefined();
});

test("a yes to a spent budget grants another full budget on the same task", () => {
  const task = taskWith([]);
  const granted = { ...task, fixRoundGrants: [keepFixingGrant(task)] };

  expect(fixRoundBudget(granted)).toBe(4);
  expect(keepFixingQuestion(granted)).toBeUndefined();
});

test("a finding repeated unchanged after a fix round asks early and names it", () => {
  const repeated = finding({ id: "f-1" });
  const task: TaskRecord = {
    ...taskWith([], 1),
    reviews: [
      review({ head: "head-1", generation: 1, findings: [repeated] }),
      review({ head: "head-2", generation: 2, findings: [{ ...repeated, line: 40 }] }),
    ],
  };

  expect(repeatedFindings(task).map((entry) => entry.id)).toEqual(["f-1"]);
  expect(keepFixingQuestion(task)?.text).toBe(
    'Keep fixing "Bound the retry loop"? The same finding came back: The retry loop drops the cancellation signal.',
  );
  const approved = { ...task, fixRoundGrants: [keepFixingGrant(task)] };
  expect(approved.fixRoundGrants[0]?.rounds).toBe(0);
  expect(keepFixingQuestion(approved)).toBeUndefined();
});

test("a reworded finding is not a repeat, but any blocker at an unchanged HEAD is", () => {
  const task: TaskRecord = {
    ...taskWith([], 1),
    reviews: [
      review({ head: "head-1", generation: 1, findings: [finding({ id: "f-1" })] }),
      review({
        head: "head-2",
        generation: 2,
        findings: [finding({ id: "f-1", description: "Cancellation now leaks a timer." })],
      }),
    ],
  };
  expect(repeatedFindings(task)).toEqual([]);

  const unchanged: TaskRecord = {
    ...task,
    reviews: [
      review({ head: "head-2", generation: 1, findings: [finding({ id: "f-1" })] }),
      review({ head: "head-2", generation: 2, findings: [finding({ id: "f-9" })] }),
    ],
  };
  expect(repeatedFindings(unchanged).map((entry) => entry.id)).toEqual(["f-9"]);
});
