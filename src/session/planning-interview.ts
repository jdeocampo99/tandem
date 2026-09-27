import type {
  RequestBriefRecord,
  RequestPlanningAnswer,
  RequestPlanningQuestion,
} from "../contracts.ts";

export type PlanningAskOption = Readonly<{
  readonly label: string;
  readonly description?: string | undefined;
}>;
export type PlanningAskQuestionInput = Readonly<{
  readonly id: string;
  readonly question: string;
  readonly options: readonly PlanningAskOption[];
  readonly recommended: number;
}>;
export type PlanningAskInput = Readonly<{
  readonly questions: readonly [PlanningAskQuestionInput];
}>;

export type PlanningAskCall =
  | Readonly<{ readonly kind: "unmanaged" }>
  | Readonly<{ readonly kind: "refused"; readonly reason: string }>
  | Readonly<{
      readonly kind: "planning";
      readonly requestId: string;
      readonly question: RequestPlanningQuestion;
    }>;

export function planningAskInput(question: RequestPlanningQuestion): PlanningAskInput {
  return {
    questions: [
      {
        id: question.id,
        question: `${question.context}\n\n${question.question}`,
        options: question.options,
        recommended: question.recommendedOption,
      },
    ],
  };
}

/** Matches a saved question and blocks unmanaged asks while an interview is active. */
export function planningAskCall(
  input: unknown,
  requests: readonly RequestBriefRecord[],
): PlanningAskCall {
  const hasActiveInterview = requests.some(
    (record) => record.abandonedAt === undefined && record.planningInterview?.status === "active",
  );
  const hasPending = requests.some((record) => {
    const interview = record.planningInterview;
    const last = interview?.questions.at(-1);
    return (
      record.abandonedAt === undefined &&
      interview?.status === "active" &&
      last !== undefined &&
      last.answer === undefined
    );
  });
  const refuseUnmanaged = (): PlanningAskCall =>
    !hasActiveInterview
      ? { kind: "unmanaged" }
      : {
          kind: "refused",
          reason: hasPending
            ? "A saved planning question is pending; ask it exactly before asking anything else."
            : "A planning interview is active without a pending question; save its next question or complete it before using OMP ask.",
        };
  const questions = asRecord(input)?.questions;
  if (!Array.isArray(questions)) return refuseUnmanaged();
  const ids = questions.map((value) => asRecord(value)?.id).filter(isText);
  const matches = requests.flatMap((record) =>
    (record.planningInterview?.questions ?? [])
      .filter((question) => ids.includes(question.id))
      .map((question) => ({ record, question })),
  );
  if (matches.length === 0) return refuseUnmanaged();
  if (matches.length !== 1) {
    return {
      kind: "refused",
      reason: "This ask call names more than one saved planning question.",
    };
  }
  const match = matches[0];
  if (match === undefined) return refuseUnmanaged();
  const interview = match.record.planningInterview;
  const pending = interview?.questions.at(-1);
  if (
    match.record.abandonedAt !== undefined ||
    interview?.status !== "active" ||
    pending?.id !== match.question.id ||
    pending.answer !== undefined
  ) {
    return {
      kind: "refused",
      reason:
        "This saved planning question is stale or already answered. Read the request brief and continue from its current state.",
    };
  }
  if (questions.length !== 1 || !matchesAskQuestion(questions[0], match.question)) {
    return {
      kind: "refused",
      reason:
        "Use the exact saved planning question, with no additional questions, in this ask call.",
    };
  }
  return { kind: "planning", requestId: match.record.id, question: match.question };
}

/** Returns only a user-entered choice; timeout defaults and incomplete results are not answers. */
export function explicitPlanningAnswer(
  details: unknown,
  question: RequestPlanningQuestion,
): RequestPlanningAnswer | undefined {
  const outer = asRecord(details);
  if (outer === undefined || outer.timedOut === true || outer.chatRedirect === true)
    return undefined;
  let result = outer;
  if (Array.isArray(outer.results)) {
    if (outer.results.length !== 1) return undefined;
    const only = asRecord(outer.results[0]);
    if (only === undefined || only.id !== question.id) return undefined;
    result = only;
  }
  if (result.timedOut === true || result.chatRedirect === true || result.multi === true) {
    return undefined;
  }
  const expected = planningAskInput(question).questions[0];
  if (result.question !== expected.question || !sameOptionLabels(result.options, question)) {
    return undefined;
  }
  const selected = result.selectedOptions;
  if (!Array.isArray(selected)) return undefined;
  const customInput = result.customInput;
  const note = isText(result.note) && result.note.trim().length > 0 ? result.note : undefined;
  if (typeof customInput === "string") {
    if (customInput.trim().length === 0 || selected.length !== 0) return undefined;
    return { kind: "custom", value: customInput, ...(note === undefined ? {} : { note }) };
  }
  if (
    selected.length !== 1 ||
    !isText(selected[0]) ||
    !question.options.some((option) => option.label === selected[0])
  ) {
    return undefined;
  }
  return {
    kind: "option",
    value: selected[0],
    ...(note === undefined ? {} : { note }),
  };
}

function matchesAskQuestion(value: unknown, question: RequestPlanningQuestion): boolean {
  const record = asRecord(value);
  const expected = planningAskInput(question).questions[0];
  return (
    record !== undefined &&
    record.id === expected.id &&
    record.question === expected.question &&
    (record.multi === undefined || record.multi === false) &&
    record.recommended === expected.recommended &&
    sameOptions(record.options, expected.options)
  );
}

function sameOptionLabels(value: unknown, question: RequestPlanningQuestion): boolean {
  if (!Array.isArray(value) || value.length !== question.options.length) return false;
  return value.every((option, index) => option === question.options[index]?.label);
}
function sameOptions(value: unknown, expected: readonly PlanningAskOption[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((option, index) => {
    const actual = asRecord(option);
    const wanted = expected[index];
    return (
      actual !== undefined &&
      wanted !== undefined &&
      actual.label === wanted.label &&
      actual.description === wanted.description
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}
