import { expect, test } from "bun:test";
import type { TaskRecord } from "../../src/contracts.ts";
import { renderDraftPrDescription, renderPrDescription } from "../../src/instructions.ts";
import { taskWithQuestion } from "../../src/service/records.ts";
import { createTask } from "../../src/tasks/lifecycle.ts";
import {
  approvedScopeLabel,
  approvedScopeMarkdown,
  checkQuickText,
  clockTime,
  QUICK_START_GRACE_MS,
  QUICK_TASK_TOO_SHORT,
  quickApproval,
  quickStartedText,
  quickStartUnfinished,
  quickTaskTitle,
  quickTextDigest,
} from "../../src/tasks/quick.ts";
import { quickScopeQuestionText } from "../../src/tasks/quick-scope.ts";
import { parseTaskRecord } from "../../src/tasks/store-codec.ts";
import { timelineEventsForChange } from "../../src/tasks/timeline.ts";
import { SCENARIO_NOW, SCENARIO_POLICY } from "../evals/scenario.ts";
import { quickTask, SCOPE, TEXT } from "./quick-fixture.ts";

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
