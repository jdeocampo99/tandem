import { expect, test } from "bun:test";
import {
  answerPendingDecision,
  checkResearchInterview,
  createResearchInterview,
  finishResearchInterview,
  openPendingDecision,
  pendingResearchDecision,
  researchInterviewFor,
} from "../../src/tasks/research-interview.ts";

const CREATED_AT = "2030-01-01T00:00:00.000Z";
const RESOLVED_AT = "2030-01-01T00:01:00.000Z";

function openDecision() {
  return openPendingDecision(createResearchInterview(), {
    id: "decision-1",
    question: "Which constraint changes the recommendation?",
    createdAt: CREATED_AT,
  });
}

test("a focused research decision records one durable, idempotent answer", () => {
  const pending = openDecision();
  expect(pendingResearchDecision(pending)).toMatchObject({
    id: "decision-1",
    status: "pending",
  });
  expect(() =>
    openPendingDecision(pending, {
      id: "decision-2",
      question: "A different question?",
      createdAt: CREATED_AT,
    }),
  ).toThrow("still awaiting an answer");

  const answered = answerPendingDecision(pending, {
    id: "decision-1",
    answer: "The constraint is the source commit.",
    resolvedAt: RESOLVED_AT,
  });
  expect(answered.decisions[0]).toMatchObject({
    status: "answered",
    answer: "The constraint is the source commit.",
    resolvedAt: RESOLVED_AT,
  });
  expect(
    answerPendingDecision(answered, {
      id: "decision-1",
      answer: "The constraint is the source commit.",
      resolvedAt: "2030-01-01T00:02:00.000Z",
    }),
  ).toBe(answered);
  expect(() =>
    answerPendingDecision(answered, {
      id: "decision-1",
      answer: "A different answer.",
      resolvedAt: RESOLVED_AT,
    }),
  ).toThrow("different answer");
  expect(
    openPendingDecision(answered, {
      id: "decision-2",
      question: "Which constraint changes the recommendation?",
      createdAt: RESOLVED_AT,
    }),
  ).toBe(answered);
  expect(checkResearchInterview(answered).valid).toBe(true);
});

test("stopping withdraws unanswered decisions and approval requires answers", () => {
  const pending = openDecision();
  expect(() => finishResearchInterview(pending, "approved", RESOLVED_AT)).toThrow(
    "must be answered before approval",
  );

  const stopped = finishResearchInterview(pending, "stopped", RESOLVED_AT);
  expect(stopped.status).toBe("stopped");
  expect(stopped.decisions[0]).toMatchObject({ status: "withdrawn", resolvedAt: RESOLVED_AT });
  expect(pendingResearchDecision(stopped)).toBeUndefined();
  expect(finishResearchInterview(stopped, "stopped", "2030-01-01T00:02:00.000Z")).toBe(stopped);
  expect(() =>
    answerPendingDecision(stopped, {
      id: "decision-1",
      answer: "Too late.",
      resolvedAt: RESOLVED_AT,
    }),
  ).toThrow("already closed");
  expect(checkResearchInterview({ ...stopped, extra: true })).toMatchObject({ valid: false });
});

test("legacy research state is inferred only for terminal scouts", () => {
  expect(researchInterviewFor({ kind: "scout", stage: "completed" })?.status).toBe("open");
  expect(researchInterviewFor({ kind: "scout", stage: "cancelled" })?.status).toBe("stopped");
  expect(researchInterviewFor({ kind: "scout", stage: "scouting" })).toBeUndefined();
  expect(researchInterviewFor({ kind: "implementation", stage: "completed" })).toBeUndefined();
});
