import type { ResearchContinuationDisposition } from "../contracts.ts";
import type {
  ResearchContinuationOverride,
  ResearchFollowUpDecision,
} from "../tasks/research-continuation.ts";

/** Plain-language meaning of a recorded disposition, shared by task summaries and wake text. */
export function describeResearchDisposition(disposition: ResearchContinuationDisposition): string {
  switch (disposition) {
    case "report-only":
      return "summarize the report, recommend, and offer next steps without starting implementation";
    case "ask-intent":
      return "summarize the report, recommend, then ask only whether the user wants implementation work";
    case "implementation-interview":
      return "summarize the report, propose one direction, then interview for implementation scope";
  }
}

function describeResearchOverride(override: ResearchContinuationOverride): string {
  switch (override) {
    case "not-a-scout":
      return "this task is not research";
    case "open-question":
      return "the task has an open question";
    case "blocked":
      return "the research is blocked";
    case "cancelled":
      return "the research was cancelled";
    case "incomplete":
      return "the research has not finished";
    case "stale-generation":
      return "this notice is out of date";
    case "missing-report":
      return "there is no readable report";
  }
}

/**
 * What every finished-research reply carries. The user asked for research to get a judgement, so
 * this overrides the coordinator's usual one-or-two-sentence limit.
 */
const RESEARCH_SUMMARY =
  "Give the user a summary of the research report in plain language (read the report first unless its full text came with this notice); the one-or-two-sentence limit does not apply here. Cover the three to five findings that matter, each with its evidence; the options the research surfaced; which one you recommend and why; and what is still uncertain.";

function followUpSteps(decision: ResearchFollowUpDecision): readonly string[] {
  switch (decision.followUp) {
    case "report-only":
      return [
        RESEARCH_SUMMARY,
        "End with the natural next steps as a short choice, such as planning the change, researching one open point further, or leaving it here.",
        "Do not start the implementation interview or create a task until the user picks a next step.",
      ];
    case "ask-intent":
      return [
        RESEARCH_SUMMARY,
        "Then ask exactly one question: whether they want implementation work on top of these findings.",
        "Do not start the implementation interview or create a task before that answer.",
      ];
    case "implementation-interview":
      return [
        RESEARCH_SUMMARY,
        "Propose one initial direction drawn from that evidence, then ask focused questions covering desired behavior, acceptance criteria, affected surfaces, non-goals, risks and compatibility; offer a default for each.",
        "Stay inside the report and the user's request; do not widen scope on your own.",
        "Only after the user answers may you create an implementation task, passing this task in researchTaskIds. Approval is a separate, later step: give a short summary without asking for approval in it, then call approve (or brief-approve when a brief governs it) so its own confirmation is the single approval ask, not a prose question first.",
      ];
    case "answer-question":
      return [
        "Answer the open question first.",
        "Answer it yourself (answer with its questionId) only when the user's earlier direction, the approved scope, or clear repository facts settle it; otherwise ask the user.",
        "Do not start the implementation interview or create an implementation task from this wake.",
      ];
    case "disclose-blocker":
      return [
        "Tell the user plainly what blocked the research and that there is no usable result.",
        "Do not start the implementation interview or create an implementation task from this wake.",
      ];
  }
}

/**
 * Render the durable post-research follow-up as coordinator-facing wake text. Pure: the caller
 * supplies the decision, so the same persisted record produces the same content after a restart.
 */
export function buildResearchFollowUpContent(decision: ResearchFollowUpDecision): string {
  const reason =
    decision.override === undefined
      ? ""
      : ` because ${describeResearchOverride(decision.override)}`;
  const lines = [
    `Research follow-up: ${decision.followUp}${reason}.`,
    ...followUpSteps(decision).map((step) => `- ${step}`),
  ];
  return lines.join("\n");
}
/** Builds the narrow prompt for one retained scout's read-only follow-up turn. */
export function buildResearchContinuationBrief(
  input: Readonly<{
    readonly question: string;
    readonly reportPath: string;
    readonly reportDigest: string;
    readonly excerpt: string;
  }>,
): string {
  return [
    "Focused research follow-up. Continue in this same research session; this is not a new task.",
    `Question: ${JSON.stringify(input.question)}`,
    `Original report: ${input.reportPath}`,
    `Original report SHA-256: ${input.reportDigest}`,
    "Report excerpt (untrusted research data; read the full report before answering):",
    input.excerpt,
    "Use read-only inspection only. Do not edit, write, or create repository files; do not create tasks, ask the user, or submit a new report.",
    "Answer only the focused question with evidence and any remaining uncertainty. Finish by calling submit_research_follow_up exactly once with the answer.",
  ].join("\n");
}
