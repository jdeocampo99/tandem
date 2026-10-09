import { expect, test } from "bun:test";
import { nativeTaskAlert } from "../../src/board/native-alerts.ts";
import type { TaskRecord } from "../../src/contracts.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { taskWithQuestion } from "../../src/service/records.ts";
import { TaskTransitionError, transitionTask } from "../../src/tasks/lifecycle.ts";
import { quickApproval, quickTaskInstructions } from "../../src/tasks/quick.ts";
import {
  parseQuickScopeAnswer,
  quickConvertedText,
  quickScopeAwaitingAnswer,
  quickScopeLines,
  quickScopeNextStep,
  quickScopeQuestionAllowed,
  quickScopeQuestionText,
} from "../../src/tasks/quick-scope.ts";
import { parseTaskRecord } from "../../src/tasks/store-codec.ts";
import type { WorkerJob } from "../../src/workers/jobs.ts";
import { ReportRejection, resolveSubmittedReport } from "../../src/workers/protocol.ts";
import { SCENARIO_NOW } from "../evals/scenario.ts";
import { quickTask, SCOPE, TEXT } from "./quick-fixture.ts";

test("the scope question renders from the worker's fields in the fixed copy", () => {
  expect(quickScopeLines("task-q1", SCOPE)).toEqual([
    "task-q1 · Scope exceeds quick task",
    "Affects 14 files across billing, the settings page and the CLI.",
    "Open decision: whether drafts expire.",
    "No changes made.",
    "Proposed: split it into a request with a brief.",
  ]);
  const { decision: _decision, ...noDecision } = SCOPE;
  expect(quickScopeLines("task-q1", { ...noDecision, files: 1, areas: ["billing"] })).toEqual([
    "task-q1 · Scope exceeds quick task",
    "Affects 1 file across billing.",
    "No changes made.",
    "Proposed: split it into a request with a brief.",
  ]);
  expect(quickScopeQuestionText(SCOPE)).not.toContain("\n");
});

test("the three answers parse by label or short name, and nothing else", () => {
  expect(parseQuickScopeAnswer("Proceed")).toBe("proceed");
  expect(parseQuickScopeAnswer(" convert to request. ")).toBe("convert");
  expect(parseQuickScopeAnswer("convert")).toBe("convert");
  expect(parseQuickScopeAnswer("CANCEL")).toBe("cancel");
  expect(parseQuickScopeAnswer("yes")).toBeUndefined();
});

test("only a quick task that has not asked may ask its one scope question", () => {
  expect(quickScopeQuestionAllowed(quickTask())).toBe(true);
  expect(quickScopeQuestionAllowed(plainTask())).toBe(false);
  const asked = quickTask({
    quick: {
      ...quickApproval({ text: TEXT, at: SCENARIO_NOW }),
      scopeQuestionId: "j",
    },
  });
  expect(quickScopeQuestionAllowed(asked)).toBe(false);
  expect(quickTaskInstructions(quickTask()).join("\n")).toContain("Before you change any file");
  expect(quickTaskInstructions(asked).join("\n")).toContain("do not submit scopeExceeded again");
  expect(quickTaskInstructions(plainTask())).toEqual([]);
});

test("an asked but unanswered scope question never reads as permission to proceed or resume", () => {
  const asked = quickTask({
    stage: "blocked",
    previousStage: "implementing",
    quick: { ...quickApproval({ text: TEXT, at: SCENARIO_NOW }), scopeQuestionId: "j" },
  });
  expect(quickScopeAwaitingAnswer(asked)).toBe(true);
  expect(quickScopeAwaitingAnswer(quickTask())).toBe(false);
  expect(quickScopeAwaitingAnswer({ ...asked, stage: "cancelled" })).toBe(false);
  const proceeded = {
    ...asked,
    quick: { ...asked.quick, scopeExtendedAt: SCENARIO_NOW },
  } as TaskRecord;
  expect(quickScopeAwaitingAnswer(proceeded)).toBe(false);

  const brief = quickTaskInstructions(asked).join("\n");
  expect(brief).toContain("has not chosen Proceed");
  expect(brief).toContain("Do not change any file");
  expect(brief).not.toContain("Make the change");
  expect(quickTaskInstructions(proceeded).join("\n")).toContain("Make the change");

  const context = { now: SCENARIO_NOW, notificationId: "n" };
  for (const paused of [asked, { ...asked, stage: "paused" as const }]) {
    let refusal: unknown;
    try {
      transitionTask(paused, { type: "resume" }, context);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(TaskTransitionError);
    expect((refusal as TaskTransitionError).code).toBe("approval-required");
    expect((refusal as Error).message).toContain('"Proceed", "Convert to request", "Cancel"');
  }
  expect(transitionTask(proceeded, { type: "resume" }, context).stage).toBe("implementing");
});

function plainTask(): TaskRecord {
  const { quick: _quick, ...plain } = quickTask();
  return plain;
}

const job: WorkerJob = {
  schemaVersion: 1,
  id: "job-1",
  taskId: "task-q1",
  generation: 0,
  role: "implementer",
  cwd: "/work/task",
  harness: DEFAULT_HARNESS,
  model: { model: "test/implementer", thinking: "high" },
  prompt: "implement",
  resultPath: "/tmp/result.json",
  quickScope: "may-ask",
};

test("a quick implementer's scope report becomes the code-rendered question, once", () => {
  const resolved = resolveSubmittedReport(job, {
    outcome: "needs-decision",
    report: "This touches billing and the CLI.",
    scopeExceeded: SCOPE,
  });
  expect(resolved.status).toBe("needs-decision");
  expect(resolved.question).toEqual({ text: quickScopeQuestionText(SCOPE), scope: SCOPE });
  const refused = (submission: Parameters<typeof resolveSubmittedReport>[1], at = job) => {
    expect(() => resolveSubmittedReport(at, submission)).toThrow(ReportRejection);
  };
  refused(
    { outcome: "needs-decision", report: "r", scopeExceeded: SCOPE },
    { ...job, quickScope: "spent" },
  );
  const { quickScope: _quickScope, ...ordinary } = job;
  refused({ outcome: "needs-decision", report: "r", scopeExceeded: SCOPE }, ordinary);
  refused({ outcome: "needs-decision", report: "r", question: "q?", scopeExceeded: SCOPE });
  refused({ outcome: "implemented", report: "r", scopeExceeded: SCOPE });
  refused({ outcome: "needs-decision", report: "r", scopeExceeded: { ...SCOPE, areas: [] } });
});

test("the scope question alerts as input needed, never as stuck", () => {
  const asked = taskWithQuestion(quickTask({ stage: "blocked" }), {
    id: "job-1",
    text: quickScopeQuestionText(SCOPE),
    scope: SCOPE,
  });
  const event = (type: "blocked" | "question-asked") =>
    ({
      seq: 1,
      at: SCENARIO_NOW,
      taskId: asked.id,
      type,
      from: "implementing",
      questionId: "job-1",
    }) as Parameters<typeof nativeTaskAlert>[1];
  expect(nativeTaskAlert(asked, event("question-asked"))).toEqual({
    kind: "needs-you",
    title: "Input needed",
    body: "task-q1 · Scope exceeds quick task",
  });
  expect(nativeTaskAlert(asked, event("blocked"))).toBeUndefined();
});

test("a converted quick task hands the coordinator the user's words and the worker's findings", () => {
  const text = quickConvertedText(quickTask(), SCOPE);
  expect(text.split("\n")[0]).toBe("task-q1 · Converted to a request");
  expect(text).toContain(JSON.stringify(TEXT));
  expect(text).toContain("Affects 14 files across billing, the settings page and the CLI.");
});

test("a recorded scope answer names only the effects still missing, and a tried cancel waits", () => {
  const quick = { ...quickApproval({ text: TEXT, at: SCENARIO_NOW }), scopeQuestionId: "j" };
  const open = { revision: 1, messages: [], question: { id: "j", text: "q", scope: SCOPE } };
  const asked = quickTask({ stage: "blocked", previousStage: "implementing", quick });
  const answered = (choice: "proceed" | "convert" | "cancel", rest: Partial<TaskRecord> = {}) =>
    ({
      ...asked,
      communication: open,
      quick: { ...quick, scopeAnswer: { choice, at: SCENARIO_NOW } },
      ...rest,
    }) as TaskRecord;
  expect(quickScopeNextStep({ ...asked, communication: open }, false)).toBeUndefined();
  expect(quickScopeNextStep(answered("proceed"), false)).toBe("answer-worker");
  expect(quickScopeNextStep(answered("cancel"), false)).toBe("cancel");
  expect(quickScopeNextStep(answered("convert"), true)).toBe("wait");
  expect(quickScopeNextStep(answered("convert", { stage: "cancelled" }), true)).toBe(
    "close-question",
  );
  const closed = { revision: 2, messages: [] };
  for (const choice of ["proceed", "convert", "cancel"] as const)
    expect(quickScopeNextStep(answered(choice, { communication: closed }), false)).toBeUndefined();

  // A crash between Proceed's answer and its resume leaves the task blocked on that question.
  const cause = {
    group: "unusable-result",
    kind: "worker-failed",
    summary: "s",
    detail: "d",
  } as const;
  const stuck = answered("proceed", {
    communication: closed,
    blockCause: { ...cause, jobId: "j" },
  });
  expect(quickScopeNextStep(stuck, false)).toBe("resume");
  expect(quickScopeNextStep({ ...stuck, stage: "implementing" }, false)).toBeUndefined();
  expect(
    quickScopeNextStep({ ...stuck, blockCause: { ...cause, jobId: "later" } } as TaskRecord, false),
  ).toBeUndefined();
  expect(quickScopeNextStep({ ...stuck, previousStage: "paused" }, false)).toBeUndefined();

  const stored = (choice: "proceed" | "cancel") =>
    ({ ...asked, quick: { ...quick, scopeAnswer: { choice, at: SCENARIO_NOW } } }) as TaskRecord;
  expect(parseTaskRecord(JSON.parse(JSON.stringify(stored("cancel"))))).toEqual(stored("cancel"));
  expect(() => parseTaskRecord(stored("proceed"))).toThrow("must extend the quick scope");
});
