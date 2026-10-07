import { expect, test } from "bun:test";
import { nativeTaskAlert } from "../../src/board/native-alerts.ts";
import type { QuickScopeReport, TaskRecord } from "../../src/contracts.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { renderDraftPrDescription, renderPrDescription } from "../../src/instructions.ts";
import { taskWithQuestion } from "../../src/service/records.ts";
import { createTask, TaskTransitionError, transitionTask } from "../../src/tasks/lifecycle.ts";
import {
  approvedScopeLabel,
  approvedScopeMarkdown,
  checkQuickText,
  clockTime,
  parseQuickScopeAnswer,
  QUICK_START_GRACE_MS,
  QUICK_TASK_TOO_SHORT,
  quickApproval,
  quickConvertedText,
  quickScopeAwaitingAnswer,
  quickScopeLines,
  quickScopeNextStep,
  quickScopeQuestionAllowed,
  quickScopeQuestionText,
  quickStartedText,
  quickStartUnfinished,
  quickTaskInstructions,
  quickTaskTitle,
  quickTextDigest,
} from "../../src/tasks/quick.ts";
import { parseTaskRecord } from "../../src/tasks/store-codec.ts";
import { timelineEventsForChange } from "../../src/tasks/timeline.ts";
import type { WorkerJob } from "../../src/workers/jobs.ts";
import { ReportRejection, resolveSubmittedReport } from "../../src/workers/protocol.ts";
import { SCENARIO_NOW, SCENARIO_POLICY } from "../evals/scenario.ts";

const TEXT = "Rename the Save button to Save draft on the settings page";
const SCOPE: QuickScopeReport = {
  files: 14,
  areas: ["billing", "the settings page", "the CLI"],
  decision: "whether drafts expire",
  plan: "split it into a request with a brief",
};

function quickTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask(
      {
        id: "task-q1",
        repoPath: "/work/project",
        kind: "implementation",
        objective: TEXT,
        title: quickTaskTitle(TEXT),
        acceptanceCriteria: [],
        surfaces: ["*"],
        policy: SCENARIO_POLICY,
        quick: quickApproval({ text: TEXT, at: SCENARIO_NOW }),
      },
      SCENARIO_NOW,
    ),
    ...overrides,
  };
}

test("quick text is refused without a model when it does not yet describe a change", () => {
  for (const short of ["", "   ", "fix it", "Rename button", "a b c", "tiny change x"])
    expect(checkQuickText(short)).toEqual({ ok: false, problem: QUICK_TASK_TOO_SHORT });
  expect(QUICK_TASK_TOO_SHORT).toBe("Describe the change in a sentence or two.");
  expect(checkQuickText(`  ${TEXT}\n`)).toEqual({ ok: true, text: TEXT });
  expect(checkQuickText("x ".repeat(2_500)).ok).toBe(false);
});

test("the title is the first line, cut at a word boundary; no model names it", () => {
  expect(quickTaskTitle(`\n  ${TEXT}  \nMore detail on a second line.`)).toBe(TEXT);
  const long = quickTaskTitle(
    "Make every settings page button use the same spacing and colors as the dashboard buttons do",
  );
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long.endsWith("…")).toBe(true);
  expect(long).toBe("Make every settings page button use the same spacing and…");
});

test("the approval records who approved what and when, bound to the exact bytes", () => {
  const approval = quickApproval({ text: TEXT, at: SCENARIO_NOW });
  expect(approval).toEqual({
    kind: "quick-task",
    text: TEXT,
    textDigest: quickTextDigest(TEXT),
    approvedAt: SCENARIO_NOW,
  });
  expect(approval.textDigest).toMatch(/^[0-9a-f]{64}$/u);
});

test("a quick task is approved implementation work whose record round-trips and refuses tampering", () => {
  const task = quickTask();
  expect(task.stage).toBe("awaiting-approval");
  expect(task.requiredStages).toEqual({ validation: true, review: true });
  expect(task.quick?.text).toBe(TEXT);
  expect(parseTaskRecord(JSON.parse(JSON.stringify(task)))).toEqual(task);
  expect(() => parseTaskRecord({ ...task, quick: { ...task.quick, text: `${TEXT}!` } })).toThrow(
    "does not match the approved text",
  );
  expect(() => parseTaskRecord({ ...task, kind: "scout" })).toThrow();
  expect(() =>
    createTask(
      {
        id: "task-s",
        repoPath: "/work/project",
        kind: "scout",
        objective: TEXT,
        acceptanceCriteria: [],
        surfaces: [],
        policy: SCENARIO_POLICY,
        quick: quickApproval({ text: TEXT, at: SCENARIO_NOW }),
      },
      SCENARIO_NOW,
    ),
  ).toThrow("only implementation tasks may be quick");
});

test("the timeline records the user's quick approval at creation and their Proceed once", () => {
  const task = quickTask();
  expect(timelineEventsForChange(undefined, task).map((event) => event.type)).toEqual([
    "created",
    "quick-approved",
  ]);
  expect(timelineEventsForChange(undefined, task)[1]).toMatchObject({
    textDigest: quickTextDigest(TEXT),
  });
  const asked = taskWithQuestion(task, {
    id: "job-1",
    text: quickScopeQuestionText(SCOPE),
    scope: SCOPE,
  });
  expect(asked.quick?.scopeQuestionId).toBe("job-1");
  const stretched = {
    ...asked,
    quick: { ...asked.quick, scopeExtendedAt: SCENARIO_NOW },
  } as TaskRecord;
  expect(timelineEventsForChange(asked, stretched).map((event) => event.type)).toEqual([
    "quick-scope-extended",
  ]);
  expect(timelineEventsForChange(stretched, stretched)).toEqual([]);
});

test("the coordinator's chat text and the scope heading use the approval's clock time", () => {
  expect(clockTime("2030-01-01T09:05:00.000Z", "UTC")).toBe("09:05");
  const task = quickTask();
  expect(quickStartedText(task, { approvedAt: "2030-01-01T14:30:00.000Z" }, "UTC")).toBe(
    `Quick task started\ntask-q1 · ${TEXT}\nScope approved 14:30`,
  );
  expect(approvedScopeLabel({ approvedAt: "2030-01-01T14:30:00.000Z" }, "UTC")).toBe(
    "Approved scope (quick task, 14:30)",
  );
});

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

test("the pull request and its draft carry the verbatim approved scope", () => {
  const approval = {
    ...quickApproval({
      text: `${TEXT}\n\nKeep the icon.`,
      at: "2030-01-01T14:30:00.000Z",
    }),
  };
  const section = approvedScopeMarkdown(approval, "UTC");
  expect(section).toBe(`# Approved scope (quick task, 14:30)\n> ${TEXT}\n>\n> Keep the icon.`);
  const body = renderPrDescription({
    tldr: ["Renames the button."],
    what: ["the label"],
    why: ["the user asked"],
    validation: ["bun test"],
    approvedScope: section,
  });
  expect(body).toContain(section);
  expect(body.indexOf(section)).toBeLessThan(body.indexOf("# What"));
  expect(
    renderDraftPrDescription({
      status: ["implementing"],
      reviewLevel: ["standard"],
      activity: ["editing"],
      blockers: [],
      remainingChecks: [],
      approvedScope: section,
    }),
  ).toContain(section);
  expect(
    approvedScopeMarkdown(
      { ...approval, scopeQuestionId: "j", scopeExtendedAt: "2030-01-01T15:00:00.000Z" },
      "UTC",
    ),
  ).toContain("proceed beyond a quick task at 15:00");
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

test("a quick task left awaiting approval past the grace is a Start that never finished", () => {
  const later = (ms: number) => new Date(Date.parse(SCENARIO_NOW) + ms).toISOString();
  const waiting = quickTask({ stage: "awaiting-approval" });
  expect(quickStartUnfinished(waiting, later(QUICK_START_GRACE_MS - 1))).toBe(false);
  expect(quickStartUnfinished(waiting, later(QUICK_START_GRACE_MS))).toBe(true);
  expect(quickStartUnfinished({ ...waiting, stage: "queued" }, later(QUICK_START_GRACE_MS))).toBe(
    false,
  );
  const { quick: _quick, ...ordinary } = waiting;
  expect(quickStartUnfinished(ordinary, later(QUICK_START_GRACE_MS))).toBe(false);
});
