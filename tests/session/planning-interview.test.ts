import { expect, test } from "bun:test";
import type { RequestPlanningQuestion } from "../../src/contracts.ts";
import { addRequestPlanningQuestion, createRequestBriefRecord } from "../../src/requests/brief.ts";
import {
  explicitPlanningAnswer,
  planningAskCall,
  planningAskInput,
} from "../../src/session/planning-interview.ts";

const NOW = "2030-01-01T00:00:00.000Z";

function pendingInterview(): Readonly<{
  readonly record: ReturnType<typeof createRequestBriefRecord>;
  readonly question: RequestPlanningQuestion;
}> {
  const started = createRequestBriefRecord(
    {
      id: "req-interview",
      repoPath: "/repo",
      content: {
        goal: "Choose the request behavior",
        scope: ["src"],
        constraints: [],
        nonGoals: [],
        acceptanceCriteria: ["the selected behavior is explicit"],
        manualVerification: [],
        recommendedApproach: "Use the research evidence",
        keyDecisions: [],
        openQuestions: ["Which contract should remain?"],
        researchLinks: [],
      },
      planningInterview: {
        schemaVersion: 1,
        status: "active",
        researchTaskIds: ["scout-1"],
        questions: [],
      },
    },
    NOW,
  );
  const record = addRequestPlanningQuestion(
    started,
    {
      context: "Research found two compatible paths.",
      question: "Which contract should remain?",
      options: [{ label: "Existing" }, { label: "New" }],
      recommendedOption: 0,
    },
    "plan-1",
    NOW,
  );
  const question = record.planningInterview?.questions[0];
  if (question === undefined) throw new Error("planning question was not saved");
  return { record, question };
}

test("a pending decision accepts only its exact single saved ask call", () => {
  const { record, question } = pendingInterview();
  const input = planningAskInput(question);

  expect(planningAskCall(input, [record])).toMatchObject({
    kind: "planning",
    requestId: "req-interview",
    question,
  });
  expect(
    planningAskCall({ questions: [{ ...input.questions[0], question: "changed prompt" }] }, [
      record,
    ]),
  ).toMatchObject({ kind: "refused" });
  expect(planningAskCall({ questions: [] }, [record])).toMatchObject({ kind: "refused" });
  expect(planningAskCall({ questions: [] }, [])).toEqual({ kind: "unmanaged" });
});

test("only an explicit non-timeout choice or custom answer becomes a decision", () => {
  const { question } = pendingInterview();
  const ask = planningAskInput(question).questions[0];
  if (ask === undefined) throw new Error("planning ask payload is empty");
  const details = {
    question: ask.question,
    options: question.options.map((option) => option.label),
    multi: false,
    selectedOptions: ["New"],
    timedOut: false,
  };

  expect(explicitPlanningAnswer(details, question)).toEqual({ kind: "option", value: "New" });
  expect(explicitPlanningAnswer({ ...details, timedOut: true }, question)).toBeUndefined();
  expect(
    explicitPlanningAnswer({ ...details, selectedOptions: ["Existing", "New"] }, question),
  ).toBeUndefined();
  expect(
    explicitPlanningAnswer(
      {
        ...details,
        selectedOptions: [],
        customInput: "Keep both through an adapter",
        note: "compatibility",
      },
      question,
    ),
  ).toEqual({
    kind: "custom",
    value: "Keep both through an adapter",
    note: "compatibility",
  });
  expect(
    explicitPlanningAnswer(
      { ...details, results: [{ id: "stale-question", ...details }] },
      question,
    ),
  ).toBeUndefined();
});
