import { expect, test } from "bun:test";
import type {
  InstructionChannels,
  RepoPolicy,
  ResolvedPolicy,
  TaskRecord,
} from "../../src/contracts.ts";
import { createTask, type TaskInput } from "../../src/tasks/lifecycle.ts";
import {
  isClipPath,
  isImagePath,
  isPathWithinDirectory,
  isUserCheckYes,
  USER_CHECK_QUESTION_ID_PREFIX,
  userCheckCriteriaOf,
  userCheckDecisionQuestion,
  userCheckFinding,
  userCheckQuestion,
  userCheckQuestionId,
  userCheckStatus,
} from "../../src/tasks/user-checks.ts";

const models: RepoPolicy["models"] = {
  coordinator: { model: "coordinator-model", thinking: "high" },
  scout: { model: "scout-model", thinking: "medium" },
  implementer: { model: "implementer-model", thinking: "max" },
  reviewer: { model: "reviewer-model", thinking: "max" },
  verifier: { model: "verifier-model", thinking: "high" },
  presentation: { model: "presentation-model", thinking: "low" },
};

const channels: InstructionChannels = { implementation: [], validation: [], review: [] };

const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models,
    instructions: channels,
    instructionFiles: channels,
    validationCommands: [],
    setupCommands: [],
    maxWorkers: 3,
    maxFixRounds: 1,
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

const baseInput: TaskInput = {
  id: "streak-task",
  repoPath: "/repo",
  kind: "implementation",
  objective: "Add a streak bar. It glows at five in a row.",
  acceptanceCriteria: ["Build and lint pass"],
  surfaces: ["service"],
  policy,
};

function taskWith(overrides: Partial<TaskRecord>): TaskRecord {
  const task = createTask(baseInput, "2026-09-15T00:00:00.000Z");
  return { ...task, ...overrides };
}

test("userCheckCriteriaOf defaults to an empty list", () => {
  expect(userCheckCriteriaOf(taskWith({}))).toEqual([]);
  expect(userCheckCriteriaOf(taskWith({ userCheckCriteria: ["Streak bar glows"] }))).toEqual([
    "Streak bar glows",
  ]);
});

test("userCheckQuestionId names the generation and head, not the criteria", () => {
  expect(userCheckQuestionId(2, "abc123")).toBe(`${USER_CHECK_QUESTION_ID_PREFIX}2-abc123`);
});

test("the question is one ask plus at most one short note, with no ids", () => {
  const task = taskWith({
    generation: 3,
    reviewHead: "head-1",
    userCheckCriteria: ["Streak bar glows at 5 in a row"],
    userCheck: {
      head: "head-1",
      generation: 3,
      evidence: [{ criterion: "Streak bar glows at 5 in a row", paths: ["/a.png", "/b.png"] }],
    },
  });
  const question = userCheckQuestion(task, "head-1");
  expect(question.id).toBe(userCheckQuestionId(3, "head-1"));
  expect(question.text.split("?").length).toBe(2); // exactly one '?'
  expect(question.text).toContain("Does");
  expect(question.text).toContain("look right?");
  expect(question.text).toContain("2 screenshots attached.");
  expect(question.text).not.toContain(task.id);
  expect(question.text).not.toContain("head-1");
  expect(question.text).not.toContain("3");
});

test("the note counts images and clips and reports when nothing was saved", () => {
  const decisionNoEvidence = userCheckDecisionQuestion(taskWith({}));
  expect(decisionNoEvidence.note).toBe("No screenshots were saved.");

  const oneImage = userCheckDecisionQuestion(
    taskWith({
      userCheck: { head: "h", generation: 0, evidence: [{ criterion: "a", paths: ["/x.png"] }] },
    }),
  );
  expect(oneImage.note).toBe("1 screenshot attached.");

  const imagesAndClips = userCheckDecisionQuestion(
    taskWith({
      userCheck: {
        head: "h",
        generation: 0,
        evidence: [
          { criterion: "a", paths: ["/x.png", "/y.jpg"] },
          { criterion: "b", paths: ["/z.mp4"] },
        ],
      },
    }),
  );
  expect(imagesAndClips.note).toBe("2 screenshots and 1 clip attached.");
});

test("the note counts criteria review handed off with no screenshots, distinct from missing builder evidence", () => {
  const handedOffOnly = userCheckDecisionQuestion(
    taskWith({ handedOffCriteria: ["The layout matches the design exactly"] }),
  );
  expect(handedOffOnly.note).toBe(
    "No screenshots were saved. Review handed you 1 item with no screenshots.",
  );

  const mixed = userCheckDecisionQuestion(
    taskWith({
      userCheck: {
        head: "h",
        generation: 0,
        evidence: [
          { criterion: "a", paths: ["/x.png"] },
          { criterion: "b", paths: [] },
        ],
      },
      handedOffCriteria: ["The layout matches the design exactly", "Another handed-off item"],
    }),
  );
  expect(mixed.note).toBe(
    "1 screenshot attached. 1 item has none. Review handed you 2 items with no screenshots.",
  );
});

test("isUserCheckYes accepts only yes/y, ignoring case and trailing punctuation", () => {
  expect(isUserCheckYes("yes")).toBe(true);
  expect(isUserCheckYes("Yes.")).toBe(true);
  expect(isUserCheckYes("YES!")).toBe(true);
  expect(isUserCheckYes("y")).toBe(true);
  expect(isUserCheckYes(" Y ")).toBe(true);
  expect(isUserCheckYes("yes but the color is off")).toBe(false);
  expect(isUserCheckYes("looks good")).toBe(false);
  expect(isUserCheckYes("no")).toBe(false);
});

test("isUserCheckYes also accepts a clear leading yes/yep/yeah before punctuation, never a bare prefix", () => {
  expect(isUserCheckYes("yes, looks good")).toBe(true);
  expect(isUserCheckYes("yes. Ship it.")).toBe(true);
  expect(isUserCheckYes("yep")).toBe(true);
  expect(isUserCheckYes("Yep!")).toBe(true);
  expect(isUserCheckYes("yeah")).toBe(true);
  expect(isUserCheckYes("Yeah, that's right.")).toBe(true);
  // Not a bare prefix match inside a longer word or an unpunctuated qualifier.
  expect(isUserCheckYes("yesterday it was different")).toBe(false);
  expect(isUserCheckYes("yep but check the color")).toBe(false);
  expect(isUserCheckYes("looks good")).toBe(false);
});

test("userCheckStatus is none without criteria, and binds to the current HEAD and generation", () => {
  expect(userCheckStatus(taskWith({}))).toBe("none");

  const criteria = ["Streak bar glows"];
  const pending = taskWith({ userCheckCriteria: criteria, reviewHead: "head-1", generation: 0 });
  expect(userCheckStatus(pending)).toBe("pending");

  const staleAnswer = taskWith({
    userCheckCriteria: criteria,
    reviewHead: "head-2",
    generation: 1,
    userCheck: {
      head: "head-1",
      generation: 0,
      evidence: [],
      answer: { outcome: "confirmed", answeredAt: "2026-09-15T00:00:00.000Z" },
    },
  });
  expect(userCheckStatus(staleAnswer)).toBe("pending");

  const confirmed = taskWith({
    userCheckCriteria: criteria,
    reviewHead: "head-1",
    generation: 0,
    userCheck: {
      head: "head-1",
      generation: 0,
      evidence: [],
      answer: { outcome: "confirmed", answeredAt: "2026-09-15T00:00:00.000Z" },
    },
  });
  expect(userCheckStatus(confirmed)).toBe("confirmed");

  const changesRequested = taskWith({
    userCheckCriteria: criteria,
    reviewHead: "head-1",
    generation: 0,
    userCheck: {
      head: "head-1",
      generation: 0,
      evidence: [],
      answer: {
        outcome: "changes-requested",
        text: "The glow is the wrong color",
        answeredAt: "2026-09-15T00:00:00.000Z",
      },
    },
  });
  expect(userCheckStatus(changesRequested)).toBe("changes-requested");
});

test("userCheckFinding only appears for a current changes-requested answer", () => {
  expect(userCheckFinding(taskWith({}))).toBeUndefined();

  const criteria = ["Streak bar glows"];
  const pending = taskWith({ userCheckCriteria: criteria, reviewHead: "head-1", generation: 0 });
  expect(userCheckFinding(pending)).toBeUndefined();

  const changesRequested = taskWith({
    userCheckCriteria: criteria,
    reviewHead: "head-1",
    generation: 0,
    userCheck: {
      head: "head-1",
      generation: 0,
      evidence: [],
      answer: {
        outcome: "changes-requested",
        text: "The glow is the wrong color",
        answeredAt: "2026-09-15T00:00:00.000Z",
      },
    },
  });
  const finding = userCheckFinding(changesRequested);
  expect(finding?.id).toBe("user-check");
  expect(finding?.severity).toBe("P1");
  expect(finding?.verdict).toBe("confirmed");
  expect(finding?.description).toContain("The glow is the wrong color");
});

test("image and clip extensions are recognized case-insensitively", () => {
  expect(isImagePath("/a/b/screenshot.PNG")).toBe(true);
  expect(isImagePath("/a/b/screenshot.jpg")).toBe(true);
  expect(isImagePath("/a/b/clip.mp4")).toBe(false);
  expect(isClipPath("/a/b/clip.MP4")).toBe(true);
  expect(isClipPath("/a/b/clip.webm")).toBe(true);
  expect(isClipPath("/a/b/screenshot.png")).toBe(false);
});

test("isPathWithinDirectory is the one owner for both a submitted path and a resolved real path", () => {
  expect(isPathWithinDirectory("/tmp/user-checks", "/tmp/user-checks/a.png")).toBe(true);
  expect(isPathWithinDirectory("/tmp/user-checks", "/tmp/user-checks/sub/a.png")).toBe(true);
  expect(isPathWithinDirectory("/tmp/user-checks", "/tmp/user-checks")).toBe(false);
  expect(isPathWithinDirectory("/tmp/user-checks", "/tmp/other/a.png")).toBe(false);
  expect(isPathWithinDirectory("/tmp/user-checks", "/tmp/user-checks-sibling/a.png")).toBe(false);
  expect(isPathWithinDirectory("/tmp/user-checks", "relative/a.png")).toBe(false);
});
