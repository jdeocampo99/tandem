import { expect, test } from "bun:test";
import type { ResearchContinuation, TaskRecord } from "../../src/contracts.ts";
import {
  checkResearchContinuation,
  decideResearchFollowUp,
  defaultResearchContinuation,
  type ResearchContinuationOverride,
  type ResearchFollowUpInput,
  researchContinuationFor,
} from "../../src/tasks/research-continuation.ts";

type FollowUpTask = ResearchFollowUpInput["task"];
type FollowUpTaskOverrides = Readonly<{
  readonly kind?: FollowUpTask["kind"];
  readonly stage?: FollowUpTask["stage"];
  readonly generation?: number;
  readonly reportPath?: string | undefined;
  readonly researchContinuation?: ResearchContinuation | undefined;
  readonly communication?: TaskRecord["communication"];
}>;

function scout(overrides: FollowUpTaskOverrides = {}): FollowUpTask {
  const reportPath = "reportPath" in overrides ? overrides.reportPath : "/reports/scout.md";
  const stored =
    "researchContinuation" in overrides
      ? overrides.researchContinuation
      : defaultResearchContinuation();
  return {
    kind: overrides.kind ?? "scout",
    stage: overrides.stage ?? "completed",
    generation: overrides.generation ?? 0,
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(stored === undefined ? {} : { researchContinuation: stored }),
    ...(overrides.communication === undefined ? {} : { communication: overrides.communication }),
  };
}

function continuation(disposition: ResearchContinuation["disposition"]): ResearchContinuation {
  return { schemaVersion: 1, disposition, selectedBy: "explicit" };
}

test("accepts each disposition with well-formed provenance", () => {
  for (const disposition of ["report-only", "ask-intent", "implementation-interview"] as const) {
    const check = checkResearchContinuation({
      schemaVersion: 1,
      disposition,
      selectedBy: "deterministic",
      classifierVersion: "continuation-rules-1",
    });
    expect(check.valid).toBe(true);
  }
  const jev = checkResearchContinuation({
    schemaVersion: 1,
    disposition: "ask-intent",
    selectedBy: "jev",
    classifierVersion: "jev-continuation-2026-09",
  });
  expect(jev.valid).toBe(true);
});

test("fails closed on unsupported values, versions, fields, and provenance", () => {
  const candidates: readonly unknown[] = [
    "ask-intent",
    null,
    [],
    { schemaVersion: 2, disposition: "ask-intent", selectedBy: "deterministic" },
    { schemaVersion: 1, disposition: "implement-now", selectedBy: "deterministic" },
    { schemaVersion: 1, disposition: "ask-intent", selectedBy: "oracle" },
    { schemaVersion: 1, disposition: "ask-intent", selectedBy: "jev" },
    {
      schemaVersion: 1,
      disposition: "ask-intent",
      selectedBy: "explicit",
      classifierVersion: "jev-1",
    },
    {
      schemaVersion: 1,
      disposition: "ask-intent",
      selectedBy: "jev",
      classifierVersion: "line-one\nline-two",
    },
    { schemaVersion: 1, disposition: "ask-intent", selectedBy: "jev", classifierVersion: "" },
    {
      schemaVersion: 1,
      disposition: "ask-intent",
      selectedBy: "deterministic",
      confidence: 0.4,
    },
  ];
  for (const candidate of candidates) {
    const check = checkResearchContinuation(candidate);
    expect(check.valid).toBe(false);
    if (!check.valid) expect(check.defect.length).toBeGreaterThan(0);
  }
});

test("resolves the conservative default for scouts and nothing for implementations", () => {
  expect(researchContinuationFor({ kind: "scout" })).toEqual({
    schemaVersion: 1,
    disposition: "ask-intent",
    selectedBy: "deterministic",
  });
  expect(
    researchContinuationFor({
      kind: "implementation",
      researchContinuation: continuation("implementation-interview"),
    }),
  ).toBeUndefined();
});

test("follows the recorded disposition when the completed report is available", () => {
  for (const disposition of ["report-only", "ask-intent", "implementation-interview"] as const) {
    const decision = decideResearchFollowUp({
      task: scout({ researchContinuation: continuation(disposition) }),
      reportReadable: true,
    });
    expect(decision).toEqual({ followUp: disposition, disposition });
  }
});

test("an open needs-decision question outranks the recorded disposition", () => {
  const question: TaskRecord["communication"] = {
    revision: 1,
    messages: [],
    question: { id: "job-1", text: "Which subsystem should the fix target?" },
  };
  const decision = decideResearchFollowUp({
    task: scout({
      researchContinuation: continuation("implementation-interview"),
      communication: question,
    }),
    reportReadable: true,
  });
  expect(decision.followUp).toBe("answer-question");
  expect(decision.override).toBe("open-question");
  expect(decision.disposition).toBe("implementation-interview");
});

test("failed, blocked, stale, incomplete, and missing-report states disclose a blocker", () => {
  const cases: readonly Readonly<{
    readonly input: ResearchFollowUpInput;
    readonly override: ResearchContinuationOverride;
  }>[] = [
    {
      input: { task: scout({ stage: "blocked" }), reportReadable: true },
      override: "blocked",
    },
    {
      input: { task: scout({ stage: "cancelled" }), reportReadable: true },
      override: "cancelled",
    },
    {
      input: { task: scout({ stage: "scouting" }), reportReadable: true },
      override: "incomplete",
    },
    {
      input: { task: scout({ generation: 1 }), reportReadable: true, notifiedGeneration: 0 },
      override: "stale-generation",
    },
    {
      input: { task: scout({ reportPath: undefined }), reportReadable: true },
      override: "missing-report",
    },
    {
      input: { task: scout(), reportReadable: false },
      override: "missing-report",
    },
    {
      input: { task: scout({ kind: "implementation" }), reportReadable: true },
      override: "not-a-scout",
    },
  ];
  for (const entry of cases) {
    const decision = decideResearchFollowUp({
      ...entry.input,
      task: { ...entry.input.task, researchContinuation: continuation("implementation-interview") },
    });
    expect(decision.followUp).toBe("disclose-blocker");
    expect(decision.override).toBe(entry.override);
  }
});

test("a scout without a stored disposition still decides conservatively", () => {
  const decision = decideResearchFollowUp({
    task: scout({ researchContinuation: undefined }),
    reportReadable: true,
  });
  expect(decision).toEqual({ followUp: "ask-intent", disposition: "ask-intent" });
});
