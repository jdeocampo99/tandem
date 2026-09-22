import type { ResearchContinuationDisposition } from "../contracts.ts";
import type {
  ResearchContinuationOverride,
  ResearchFollowUpDecision,
} from "../tasks/research-continuation.ts";

/** Plain-language meaning of a recorded disposition, shared by task summaries and wake text. */
export function describeResearchDisposition(disposition: ResearchContinuationDisposition): string {
  switch (disposition) {
    case "report-only":
      return "summarize the report and stop";
    case "ask-intent":
      return "summarize the report, then ask only whether the user wants implementation work";
    case "implementation-interview":
      return "summarize the report with its evidence, propose one direction, then interview for implementation scope";
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

function followUpSteps(decision: ResearchFollowUpDecision): readonly string[] {
  switch (decision.followUp) {
    case "report-only":
      return [
        "Summarize the report for the user in plain language and stop.",
        "Do not propose implementation work, ask implementation questions, or create a task from this report.",
      ];
    case "ask-intent":
      return [
        "Summarize the report for the user in plain language.",
        "Then ask exactly one question: whether they want implementation work on top of these findings.",
        "Do not start the implementation interview or create a task before that answer.",
      ];
    case "implementation-interview":
      return [
        "Summarize the report and what it found.",
        "Propose one initial direction drawn from that evidence, then ask focused questions covering desired behavior, acceptance criteria, affected surfaces, non-goals, risks and compatibility, and approval; offer a default for each.",
        "Stay inside the report and the user's request; do not widen scope on your own.",
        "Only after the user answers may you create an implementation task, passing this task in researchTaskIds. It waits for the user to approve the concrete scope before starting.",
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
