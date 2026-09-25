import { expect, test } from "bun:test";
import type {
  JevChoiceAnswer,
  JevEvaluationInput,
  JevEvaluationResponse,
} from "../../src/adapters/typesafe.ts";
import { RESTART_QUESTION_ID_PREFIX } from "../../src/recovery/central.ts";
import type { TandemService } from "../../src/service/controller.ts";
import {
  type ChoiceReplyEvaluator,
  classifyChoiceReply,
  MAX_CHOICE_REPLY_CHARS,
  type OpenChoice,
  openChoices,
} from "../../src/session/choice-reply-route.ts";
import { KEEP_FIXING_QUESTION_ID_PREFIX } from "../../src/tasks/findings.ts";

const config = { apiKey: "key", timeoutMs: 1_500 };
const CHOICES: readonly OpenChoice[] = [
  {
    meaning: "Restart the stopped worker",
    action: { action: "answer", taskId: "task-1", questionId: "q", text: "restart" },
  },
  {
    meaning: "Leave it stopped",
    action: { action: "answer", taskId: "task-1", questionId: "q", text: "stop" },
  },
];
const OPTIONS = ["c1", "c2", "other"];

function reply(value: string, confidence = 0.95, seen: JevEvaluationInput[] = []) {
  const rest = (1 - confidence) / (OPTIONS.length - 1);
  const answer: JevChoiceAnswer = {
    type: "choice",
    choice: value,
    confidence,
    probabilities: Object.fromEntries(
      OPTIONS.map((option) => [option, option === value ? confidence : rest]),
    ),
  };
  const evaluate: ChoiceReplyEvaluator = async (input): Promise<JevEvaluationResponse> => {
    seen.push(input);
    return {
      model: "jev",
      answers: { reply: answer },
      usage: { input_tokens: 9, output_tokens: 1 },
    };
  };
  return evaluate;
}

test("a confident reply resolves to the open choice Jev picked", async () => {
  const seen: JevEvaluationInput[] = [];
  const result = await classifyChoiceReply(
    "yeah restart it",
    CHOICES,
    config,
    reply("c1", 0.95, seen),
  );
  expect(result.choice).toEqual(CHOICES[0]);
  expect(result.reason).toBe("jev-matched");
  expect(result.usage).toBeDefined();
  expect(Object.keys(seen[0]?.questions.reply?.criteria ?? {})).toEqual(OPTIONS);
  expect(seen[0]?.state).toEqual({ message: "yeah restart it" });
});

test("other, low confidence, long replies, and no key all go back to the coordinator", async () => {
  const other = await classifyChoiceReply(
    "restart it but on opus",
    CHOICES,
    config,
    reply("other"),
  );
  expect(other.choice).toBeUndefined();
  expect(other.reason).toBe("not-a-choice");

  const unsure = await classifyChoiceReply("hmm maybe", CHOICES, config, reply("c1", 0.6));
  expect(unsure.choice).toBeUndefined();
  expect(unsure.reason).toBe("low-confidence");

  const seen: JevEvaluationInput[] = [];
  const long = await classifyChoiceReply(
    "x".repeat(MAX_CHOICE_REPLY_CHARS + 1),
    CHOICES,
    config,
    reply("c1", 0.95, seen),
  );
  expect(long.reason).toBe("reply-too-long");
  expect(
    (await classifyChoiceReply("yes", CHOICES, { timeoutMs: 1_500 }, reply("c1", 0.95, seen)))
      .reason,
  ).toBe("jev-not-configured");
  expect((await classifyChoiceReply("yes", [], config, reply("c1", 0.95, seen))).reason).toBe(
    "no-open-choices",
  );
  expect(seen).toHaveLength(0);
});

test("open choices come from code-answered task questions and the one pending brief", async () => {
  const service = {
    list: async () => [
      {
        id: "task-1",
        stage: "blocked",
        communication: {
          revision: 1,
          messages: [],
          question: {
            id: `${RESTART_QUESTION_ID_PREFIX}abc`,
            text: 'The worker stopped. Restart it? Reply "restart" or "stop".',
          },
        },
      },
      {
        id: "task-2",
        stage: "blocked",
        communication: {
          revision: 1,
          messages: [],
          question: { id: `${KEEP_FIXING_QUESTION_ID_PREFIX}3`, text: 'Keep fixing "x"?' },
        },
      },
      // A worker's free-form question has no fixed choices, so code never answers it.
      {
        id: "task-3",
        stage: "blocked",
        communication: {
          revision: 1,
          messages: [],
          question: { id: "question-1", text: "Which database?" },
        },
      },
      // A finished task's question is never offered.
      {
        id: "task-4",
        stage: "completed",
        communication: {
          revision: 1,
          messages: [],
          question: { id: `${RESTART_QUESTION_ID_PREFIX}old`, text: "Restart?" },
        },
      },
    ],
    pendingBriefApprovalId: async () => "req-1",
    requestBrief: async () => ({
      record: {
        draft: { revision: 2, contentDigest: "digest", content: { goal: "Add a settings page" } },
      },
    }),
  } as unknown as TandemService;
  const choices = await openChoices(service);
  expect(choices.map((choice) => choice.action)).toEqual([
    {
      action: "answer",
      taskId: "task-1",
      questionId: `${RESTART_QUESTION_ID_PREFIX}abc`,
      text: "restart",
    },
    {
      action: "answer",
      taskId: "task-1",
      questionId: `${RESTART_QUESTION_ID_PREFIX}abc`,
      text: "stop",
    },
    {
      action: "answer",
      taskId: "task-2",
      questionId: `${KEEP_FIXING_QUESTION_ID_PREFIX}3`,
      text: "yes",
    },
    {
      action: "answer",
      taskId: "task-2",
      questionId: `${KEEP_FIXING_QUESTION_ID_PREFIX}3`,
      text: "no",
    },
    { action: "brief-approve", requestId: "req-1", briefRevision: 2, contentDigest: "digest" },
  ]);
  // Only approval is risky, so only it carries a confirmation.
  expect(choices.filter((choice) => choice.confirm !== undefined).map((c) => c.confirm)).toEqual([
    'Approve the brief for "Add a settings page"? (y/n)',
  ]);
});

test("no brief is offered when none or several are awaiting approval", async () => {
  const service = {
    list: async () => [],
    pendingBriefApprovalId: async () => {
      throw new Error("Several requests have a brief awaiting approval");
    },
  } as unknown as TandemService;
  expect(await openChoices(service)).toEqual([]);
});
