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
      return "this task is not a scout";
    case "open-question":
      return "a durable needs-decision question is open";
    case "blocked":
      return "the scout is blocked";
    case "cancelled":
      return "the scout was cancelled";
    case "incomplete":
      return "the scout has not reached durable completed state";
    case "stale-generation":
      return "the waking notification is bound to an older generation";
    case "missing-report":
      return "no readable completed report is recorded";
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
        "Summarize the report and cite the evidence it records.",
        "Propose one initial direction drawn from that evidence, then ask focused questions covering desired behavior, acceptance criteria, affected surfaces, non-goals, risks and compatibility, and approval; offer a default for each.",
        "Stay inside the report and the user's request; do not widen scope on your own.",
        "Only after the user answers may you create an implementation task citing this scout in researchTaskIds. It stays awaiting-approval and must not launch until the concrete scope is explicitly approved.",
      ];
    case "answer-question":
      return [
        "Resolve the open question first; it outranks the recorded disposition.",
        "Answer through the questionId-bound API only when explicit prior direction, the approved scope, or unambiguous in-scope repository facts settle it; otherwise ask the user.",
        "Do not start the implementation interview or create an implementation task from this wake.",
      ];
    case "disclose-blocker":
      return [
        "Disclose the exact durable blocker and say plainly that no usable research result is available.",
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
    `Post-research follow-up: ${decision.followUp}${reason}; recorded disposition ${decision.disposition} (routing only, never permission).`,
    ...followUpSteps(decision).map((step) => `- ${step}`),
  ];
  return lines.join("\n");
}
