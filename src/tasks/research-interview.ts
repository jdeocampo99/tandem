import {
  MAX_RESEARCH_DECISION_TEXT_BYTES,
  MAX_RESEARCH_INTERVIEW_BYTES,
  MAX_RESEARCH_INTERVIEW_DECISIONS,
  PENDING_DECISION_STATUSES,
  RESEARCH_INTERVIEW_STATUSES,
  type PendingDecision,
  type ResearchInterview,
  type ResearchInterviewStatus,
  type TaskRecord,
} from "../contracts.ts";

export type ResearchInterviewCheck =
  | Readonly<{ readonly valid: true; readonly interview: ResearchInterview }>
  | Readonly<{ readonly valid: false; readonly defect: string }>;

export function createResearchInterview(): ResearchInterview {
  return { schemaVersion: 1, status: "open", decisions: [] };
}

export function researchInterviewFor(
  task: Pick<TaskRecord, "kind" | "researchInterview" | "stage">,
): ResearchInterview | undefined {
  if (task.kind !== "scout") return undefined;
  if (task.researchInterview !== undefined) return task.researchInterview;
  if (task.stage === "completed") return createResearchInterview();
  if (task.stage === "cancelled") {
    return { schemaVersion: 1, status: "stopped", decisions: [] };
  }
  return undefined;
}

export function pendingResearchDecision(
  interview: ResearchInterview,
): PendingDecision | undefined {
  return interview.decisions.find((decision) => decision.status === "pending");
}

export function openPendingDecision(
  interview: ResearchInterview,
  input: Readonly<{
    readonly id: string;
    readonly question: string;
    readonly recommendation?: string;
    readonly createdAt: string;
  }>,
): ResearchInterview {
  if (interview.status !== "open") throw new Error("the research interview is already closed");
  const existing = interview.decisions.find((decision) => decision.id === input.id);
  if (existing !== undefined) {
    if (
      existing.question !== input.question ||
      existing.recommendation !== input.recommendation
    ) {
      throw new Error(`decision ${input.id} was already used for another question`);
    }
    if (existing.status === "withdrawn") {
      throw new Error(`decision ${input.id} was already withdrawn`);
    }
    return interview;
  }
  const pending = pendingResearchDecision(interview);
  if (pending !== undefined) {
    if (pending.question === input.question && pending.recommendation === input.recommendation) {
      return interview;
    }
    throw new Error(`decision ${pending.id} is still awaiting an answer`);
  }
  const previouslyAnswered = interview.decisions.find(
    (decision) =>
      decision.status === "answered" &&
      decision.question === input.question &&
      decision.recommendation === input.recommendation,
  );
  if (previouslyAnswered !== undefined) return interview;
  if (interview.decisions.length >= MAX_RESEARCH_INTERVIEW_DECISIONS) {
    throw new Error(`research interview is limited to ${MAX_RESEARCH_INTERVIEW_DECISIONS} decisions`);
  }
  return {
    ...interview,
    decisions: [
      ...interview.decisions,
      {
        id: input.id,
        question: input.question,
        ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
        status: "pending",
        createdAt: input.createdAt,
      },
    ],
  };
}

export function answerPendingDecision(
  interview: ResearchInterview,
  input: Readonly<{ readonly id: string; readonly answer: string; readonly resolvedAt: string }>,
): ResearchInterview {
  if (interview.status !== "open") throw new Error("the research interview is already closed");
  const decision = interview.decisions.find((entry) => entry.id === input.id);
  if (decision === undefined) throw new Error(`decision ${input.id} was not found`);
  if (decision.status === "answered") {
    if (decision.answer !== input.answer) {
      throw new Error(`decision ${input.id} already has a different answer`);
    }
    return interview;
  }
  if (decision.status !== "pending") throw new Error(`decision ${input.id} was withdrawn`);
  return {
    ...interview,
    decisions: interview.decisions.map((entry) =>
      entry.id === input.id
        ? { ...entry, status: "answered", answer: input.answer, resolvedAt: input.resolvedAt }
        : entry,
    ),
  };
}

export function finishResearchInterview(
  interview: ResearchInterview,
  status: Exclude<ResearchInterviewStatus, "open">,
  resolvedAt: string,
): ResearchInterview {
  if (interview.status === status) return interview;
  if (interview.status !== "open") {
    throw new Error(`research interview is already ${interview.status}`);
  }
  if (status === "approved" && pendingResearchDecision(interview) !== undefined) {
    throw new Error("research decisions must be answered before approval");
  }
  return {
    ...interview,
    status,
    decisions:
      status === "stopped"
        ? interview.decisions.map((decision) =>
            decision.status === "pending"
              ? { ...decision, status: "withdrawn", resolvedAt }
              : decision,
          )
        : interview.decisions,
  };
}

export function checkResearchInterview(value: unknown): ResearchInterviewCheck {
  if (!isRecord(value)) return { valid: false, defect: "must be an object" };
  if (!hasExactKeys(value, ["schemaVersion", "status", "decisions"])) {
    return { valid: false, defect: "has unsupported fields" };
  }
  if (value.schemaVersion !== 1) return { valid: false, defect: "schemaVersion must be 1" };
  if (!RESEARCH_INTERVIEW_STATUSES.includes(value.status as ResearchInterviewStatus)) {
    return { valid: false, defect: "status is unsupported" };
  }
  if (!Array.isArray(value.decisions) || value.decisions.length > MAX_RESEARCH_INTERVIEW_DECISIONS) {
    return { valid: false, defect: `decisions must contain at most ${MAX_RESEARCH_INTERVIEW_DECISIONS} entries` };
  }
  const decisions: PendingDecision[] = [];
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const [index, candidate] of value.decisions.entries()) {
    if (!isRecord(candidate)) return { valid: false, defect: `decisions[${index}] must be an object` };
    if (
      !hasExactKeys(candidate, ["id", "question", "recommendation", "status", "answer", "createdAt", "resolvedAt"])
    ) {
      return { valid: false, defect: `decisions[${index}] has unsupported fields` };
    }
    if (!isText(candidate.id) || !isText(candidate.question) || !isTimestamp(candidate.createdAt)) {
      return { valid: false, defect: `decisions[${index}] has invalid identity, question, or timestamp` };
    }
    if (ids.has(candidate.id)) return { valid: false, defect: `decision id ${candidate.id} is duplicated` };
    ids.add(candidate.id);
    if (!PENDING_DECISION_STATUSES.includes(candidate.status as PendingDecision["status"])) {
      return { valid: false, defect: `decisions[${index}].status is unsupported` };
    }
    const recommendation = candidate.recommendation;
    const answer = candidate.answer;
    const resolvedAt = candidate.resolvedAt;
    if (recommendation !== undefined && !isText(recommendation)) {
      return { valid: false, defect: `decisions[${index}].recommendation is invalid` };
    }
    if (candidate.status === "pending") {
      if (answer !== undefined || resolvedAt !== undefined) {
        return { valid: false, defect: `pending decision ${candidate.id} cannot have an answer` };
      }
    } else if (!isTimestamp(resolvedAt)) {
      return { valid: false, defect: `settled decision ${candidate.id} needs a resolvedAt timestamp` };
    }
    if (candidate.status === "answered" && !isText(answer)) {
      return { valid: false, defect: `answered decision ${candidate.id} needs an answer` };
    }
    if (candidate.status === "withdrawn" && answer !== undefined) {
      return { valid: false, defect: `withdrawn decision ${candidate.id} cannot have an answer` };
    }
    if (answer !== undefined && !isText(answer)) {
      return { valid: false, defect: `decisions[${index}].answer is invalid` };
    }
    for (const entry of [candidate.id, candidate.question, recommendation, answer]) {
      if (entry !== undefined) {
        const bytes = Buffer.byteLength(entry, "utf8");
        if (entry !== candidate.id && bytes > MAX_RESEARCH_DECISION_TEXT_BYTES) {
          return { valid: false, defect: `decisions[${index}] text exceeds ${MAX_RESEARCH_DECISION_TEXT_BYTES} bytes` };
        }
        totalBytes += bytes;
      }
    }
    decisions.push({
      id: candidate.id,
      question: candidate.question,
      ...(recommendation === undefined ? {} : { recommendation }),
      status: candidate.status as PendingDecision["status"],
      ...(answer === undefined ? {} : { answer }),
      createdAt: candidate.createdAt,
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
    });
  }
  if (totalBytes > MAX_RESEARCH_INTERVIEW_BYTES) {
    return { valid: false, defect: `text exceeds ${MAX_RESEARCH_INTERVIEW_BYTES} bytes` };
  }
  const status = value.status as ResearchInterviewStatus;
  const pendingCount = decisions.filter((decision) => decision.status === "pending").length;
  if (pendingCount > 1 || (status !== "open" && pendingCount > 0)) {
    return { valid: false, defect: "closed interviews cannot keep a pending decision" };
  }
  return { valid: true, interview: { schemaVersion: 1, status, decisions } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isTimestamp(value: unknown): value is string {
  return isText(value) && Number.isFinite(Date.parse(value));
}
