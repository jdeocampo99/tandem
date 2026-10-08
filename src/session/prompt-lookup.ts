import { z } from "zod";
import {
  choiceConfidence,
  JEV_MODEL,
  type JevAttemptOutcome,
  type JevEvaluationInput,
  type JevEvaluationResponse,
  type JevQuestions,
  jevUsageRecord,
} from "../adapters/typesafe.ts";
import type {
  PromptRoutingClock,
  PromptRoutingDecision,
  PromptRoutingEvaluation,
} from "./prompt-routing.ts";

const ROUTING_QUESTIONS: JevQuestions = {
  action: {
    type: "choice",
    instructions:
      "Identify the single requested Tandem lookup. Do not invent arguments and do not choose a mutation or communication action.",
    criteria: {
      list: "The user asks for the current list or status of Tandem tasks.",
      presentations: "The user asks for current presentations or presentation status.",
      show: "The user asks to show one task or its durable record.",
      messages: "The user asks to read one task's durable messages or communication history.",
      inspect: "The user asks to inspect one task's runtime state.",
      receipt:
        "The user asks how much time, how many tokens, or how much money the current request has used so far.",
      board:
        'The user asks how Tandem or their work is going overall, like "how\'s it going?" or "what\'s waiting?": what needs them, what is running, and their pull requests at a glance.',
      "pr-watch":
        "The user asks how their pull requests are doing: CI, review, merge status, or whether one merged.",
      none: "The request is not exactly one supported read-only lookup.",
    },
  },
  target: {
    type: "choice",
    instructions: "Identify what the lookup is about.",
    criteria: {
      repository:
        "The lookup concerns the current repository, its task collection, the user's watched pull requests, or Tandem's work overall.",
      task: "The lookup concerns one explicitly identified Tandem task.",
      conversation:
        "The request concerns the chat or a general answer rather than durable Tandem state.",
      unresolved: "The target cannot be identified safely.",
    },
  },
  effect: {
    type: "choice",
    instructions: "Identify whether fulfilling the request only reads durable state.",
    criteria: {
      "read-only": "The request only reads existing state and makes no changes.",
      "state-change":
        "The request could create, control, acknowledge, steer, answer, or otherwise change state.",
      sensitive:
        "The request involves approval, credentials, publication, merging, deletion, or another sensitive action.",
      unknown: "The effect cannot be identified safely.",
    },
  },
  scope: {
    type: "choice",
    instructions: "Identify whether the lookup stays within the current Tandem repository scope.",
    criteria: {
      within:
        "The lookup stays within the current Tandem repository, its tasks, the user's watched pull requests, and Tandem's own work across projects.",
      changes: "The request asks to modify files, repositories, or external state.",
      unclear: "The scope is unclear or potentially outside the current repository.",
    },
  },
  composition: {
    type: "choice",
    instructions: "Identify whether this is one lookup or a mixed request.",
    criteria: {
      single: "The request asks for one supported lookup.",
      "homogeneous-batch": "The request asks for several lookups of one supported kind.",
      mixed: "The request combines different operations or includes unrelated work.",
    },
  },
};

const answerChoices = z.tuple([
  z.enum([
    "list",
    "presentations",
    "show",
    "messages",
    "inspect",
    "receipt",
    "board",
    "pr-watch",
    "none",
  ]),
  z.enum(["repository", "task", "conversation", "unresolved"]),
  z.enum(["read-only", "state-change", "sensitive", "unknown"]),
  z.enum(["within", "changes", "unclear"]),
  z.enum(["single", "homogeneous-batch", "mixed"]),
]);

export function lookupInput(prompt: string, taskId: string | undefined): JevEvaluationInput {
  return {
    model: JEV_MODEL,
    state: {
      prompt,
      explicitTaskId: taskId ?? null,
      supportedLookups: [
        "list",
        "presentations",
        "show",
        "messages",
        "inspect",
        "board",
        "pr-watch",
      ],
    },
    questions: ROUTING_QUESTIONS,
  };
}

function choiceAnswer(
  response: JevEvaluationResponse,
  id: string,
): Readonly<{ choice: string; confidence: number }> | undefined {
  const answer = response.answers[id];
  if (answer === undefined || answer.type !== "choice") return undefined;
  const confidence = choiceConfidence(answer);
  if (confidence === undefined) return undefined;
  return { choice: answer.choice, confidence };
}

export function lookupDecision(
  response: JevEvaluationResponse,
  taskId: string | undefined,
  confidenceThreshold: number,
): Readonly<{ reason: string; decision?: PromptRoutingDecision }> {
  const answers = ["action", "target", "effect", "scope", "composition"].map((id) =>
    choiceAnswer(response, id),
  );
  if (answers.some((answer) => answer === undefined))
    return { reason: "incomplete-classification" };
  const parsed = answerChoices.safeParse(answers.map((answer) => answer?.choice));
  if (!parsed.success) return { reason: "invalid-classification" };
  const [action, target, effect, scope, composition] = parsed.data;
  const confidence = Math.min(
    ...answers.flatMap((answer) => (answer === undefined ? [] : [answer.confidence])),
  );
  if (confidence < confidenceThreshold) return { reason: "low-confidence" };
  const repositoryWide = ["list", "presentations", "receipt", "board", "pr-watch"].includes(action);
  if (target !== (repositoryWide ? "repository" : "task"))
    return { reason: "classification-mismatch" };
  if (
    action === "none" ||
    effect !== "read-only" ||
    scope !== "within" ||
    composition !== "single"
  ) {
    return { reason: "normal-coordinator" };
  }
  if (!repositoryWide && taskId === undefined) return { reason: "missing-explicit-task-id" };
  return {
    reason: "direct-read-only",
    decision: {
      action,
      target,
      effect,
      scope,
      composition,
      ...(taskId === undefined ? {} : { taskId }),
      confidence,
    },
  };
}

export function evaluationResult(
  result: Readonly<{
    classifier: PromptRoutingEvaluation["classifier"];
    reason: string;
    outcome?: JevAttemptOutcome;
    decision?: PromptRoutingDecision;
  }>,
  startedAt: number,
  now: PromptRoutingClock,
): PromptRoutingEvaluation {
  const durationMs = Math.max(0, Math.round(now() - startedAt));
  const { classifier, reason, outcome, decision } = result;
  return {
    classifier,
    reason,
    durationMs,
    ...(outcome === undefined ? {} : { usage: jevUsageRecord({ outcome, durationMs, reason }) }),
    ...(decision === undefined ? {} : { decision }),
  };
}
