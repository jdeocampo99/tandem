import type { JevQuestions } from "../adapters/typesafe.ts";
import type { TaskRecord } from "../contracts.ts";
import {
  RESTART_QUESTION_ID_PREFIX,
  VALIDATION_RETRY_QUESTION_ID_PREFIX,
} from "../recovery/central.ts";
import type { UsageRecord } from "../runtime/usage.ts";
import type { TandemService } from "../service/controller.ts";
import { isTerminalTask } from "../service/records.ts";
import { KEEP_FIXING_QUESTION_ID_PREFIX } from "../tasks/findings.ts";
import { taskName } from "../tasks/question.ts";
import type { TandemAction } from "./actions.ts";
import {
  JevChoiceAttempt,
  type JevChoiceConfig,
  type JevChoiceEvaluator,
} from "./jev-choice-attempt.ts";

/** Bumped whenever the questions below change shape or meaning. */
export const CHOICE_REPLY_ROUTE_QUESTION_VERSION = "choice-reply-route/1";
export const CHOICE_REPLY_ROUTE_CONFIDENCE_THRESHOLD = 0.8;
/** Longer messages carry instructions or questions the coordinator should read. */
export const MAX_CHOICE_REPLY_CHARS = 160;
const MAX_OPEN_CHOICES = 24;
const MAX_LABEL_CHARS = 300;

/**
 * One answer Tandem is waiting for, with the exact action that gives it. `confirm` marks a risky
 * choice: code asks it as a y/n question and runs the action only after an exact "y".
 */
export type OpenChoice = Readonly<{
  /** What picking this choice means, in the words shown to Jev. */
  readonly meaning: string;
  readonly action: TandemAction;
  readonly confirm?: string;
}>;

export type ChoiceReplyEvaluator = JevChoiceEvaluator;

export type ChoiceReplyEvaluation = Readonly<{
  reason: string;
  durationMs: number;
  choice?: OpenChoice;
  usage?: UsageRecord;
}>;

/** The fixed replies each code-answered task question accepts. */
const TASK_QUESTION_REPLIES: readonly Readonly<{
  readonly prefix: string;
  readonly replies: readonly Readonly<{ readonly text: string; readonly meaning: string }>[];
}>[] = [
  {
    prefix: RESTART_QUESTION_ID_PREFIX,
    replies: [
      { text: "restart", meaning: "Restart the stopped worker" },
      { text: "stop", meaning: "Leave it stopped and do not restart it" },
    ],
  },
  {
    prefix: VALIDATION_RETRY_QUESTION_ID_PREFIX,
    replies: [
      { text: "retry", meaning: "Run the checks again" },
      { text: "stop", meaning: "Leave it stopped and do not run the checks again" },
    ],
  },
  {
    prefix: KEEP_FIXING_QUESTION_ID_PREFIX,
    replies: [
      { text: "yes", meaning: "Yes, keep fixing" },
      { text: "no", meaning: "No, stop fixing and leave it blocked" },
    ],
  },
];

function clip(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, MAX_LABEL_CHARS);
}

function taskChoices(task: TaskRecord): readonly OpenChoice[] {
  const question = task.communication?.question;
  if (question === undefined || isTerminalTask(task)) return [];
  const known = TASK_QUESTION_REPLIES.find((entry) => question.id.startsWith(entry.prefix));
  if (known === undefined) return [];
  return known.replies.map((reply) => ({
    meaning: `${reply.meaning}, answering: ${clip(question.text)}`,
    action: { action: "answer", taskId: task.id, questionId: question.id, text: reply.text },
  }));
}

/** The brief awaiting approval, when exactly one is; approving it always needs a "y". */
async function briefChoice(service: TandemService): Promise<OpenChoice | undefined> {
  let requestId: string;
  try {
    requestId = await service.pendingBriefApprovalId();
  } catch {
    // None, or several: approval never guesses which brief was meant.
    return undefined;
  }
  const { record } = await service.requestBrief(requestId);
  return {
    meaning: `Approve the written plan (request brief) as it is, for: ${clip(record.draft.content.goal)}`,
    action: {
      action: "brief-approve",
      requestId,
      briefRevision: record.draft.revision,
      contentDigest: record.draft.contentDigest,
    },
    confirm: `Approve the brief for ${taskName(record.draft.content.goal)}? (y/n)`,
  };
}

/** Every fixed-choice answer Tandem is waiting for right now, read from durable state. */
export async function openChoices(service: TandemService): Promise<readonly OpenChoice[]> {
  const tasks = await service.list();
  const brief = await briefChoice(service);
  return [...tasks.flatMap(taskChoices), ...(brief === undefined ? [] : [brief])].slice(
    0,
    MAX_OPEN_CHOICES,
  );
}

function questions(choices: readonly OpenChoice[]): JevQuestions {
  const criteria: Record<string, string> = {};
  choices.forEach((choice, index) => {
    criteria[`c${index + 1}`] = choice.meaning;
  });
  criteria.other =
    "The message does not clearly pick exactly one listed choice: it adds conditions, changes, or other instructions, asks a question, hesitates, or is about something else.";
  return {
    reply: {
      type: "choice",
      instructions:
        "The user just sent this short message while Tandem was waiting for an answer. Choose the listed answer the message gives, only if it gives exactly that answer and nothing more.",
      criteria,
    },
  };
}

/**
 * Maps a short reply to the one open choice it picks. Anything short of a confident single match
 * goes back to the caller, which lets the coordinator handle the message.
 */
export async function classifyChoiceReply(
  prompt: string,
  choices: readonly OpenChoice[],
  config: JevChoiceConfig,
  evaluate?: ChoiceReplyEvaluator,
  now?: () => number,
): Promise<ChoiceReplyEvaluation> {
  const attempt = new JevChoiceAttempt(config, evaluate, now);
  if (choices.length === 0) return attempt.finish("no-open-choices");
  if (prompt.length > MAX_CHOICE_REPLY_CHARS) return attempt.finish("reply-too-long");
  if (config.apiKey === undefined) return attempt.finish("jev-not-configured");
  const failure = await attempt.run(prompt, () => questions(choices));
  if (failure !== undefined) return attempt.finish(failure);
  const answer = attempt.read("reply", CHOICE_REPLY_ROUTE_CONFIDENCE_THRESHOLD);
  if (answer.kind === "missing") return attempt.finish("no-confident-match");
  if (answer.kind === "uncertain") return attempt.finish("low-confidence");
  const choice = answer.choice.startsWith("c")
    ? choices[Number(answer.choice.slice(1)) - 1]
    : undefined;
  if (choice === undefined) return attempt.finish("not-a-choice");
  return attempt.finish(
    choice.confirm === undefined ? "jev-matched" : "jev-matched-needs-confirm",
    { choice },
  );
}
