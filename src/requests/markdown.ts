import type { RequestBriefContent, RequestBriefRecord } from "../contracts.ts";
import { requestApprovalState } from "./brief.ts";

const SECTION_TITLES: Readonly<Record<keyof RequestBriefContent, string>> = {
  goal: "Goal",
  scope: "Scope",
  constraints: "Constraints",
  nonGoals: "Non-goals",
  acceptanceCriteria: "Automated checks",
  manualVerification: "Manual verification",
  recommendedApproach: "Recommended approach",
  keyDecisions: "Key decisions",
  openQuestions: "Unresolved questions",
  researchLinks: "Research links",
  skipReview: "Code review",
};

const LIST_SECTIONS = [
  "scope",
  "constraints",
  "nonGoals",
  "acceptanceCriteria",
  "manualVerification",
  "keyDecisions",
  "openQuestions",
  "researchLinks",
] as const;

/**
 * Renders the current draft as the read-only view of the durable record. It is a projection only:
 * the pane showing it offers no editing path, and SQLite remains the authority for every field
 * repeated here.
 */
export function renderRequestBriefMarkdown(record: RequestBriefRecord): string {
  const content = record.draft.content;
  const lines: string[] = [
    `# Request brief ${record.id}`,
    "",
    `- Draft revision: ${record.draft.revision} (${record.draft.changeKind} change, recorded ${record.draft.recordedAt})`,
    `- Approval: ${approvalLine(record)}`,
    `- Content digest: ${record.draft.contentDigest}`,
    `- Repository: ${record.repoPath}`,
    "",
    "Read-only view. Reply in the main conversation to change this brief; editing here changes nothing.",
    "",
    `## ${SECTION_TITLES.goal}`,
    content.goal,
    "",
    `## ${SECTION_TITLES.recommendedApproach}`,
    content.recommendedApproach,
  ];
  for (const section of LIST_SECTIONS) {
    lines.push("", `## ${SECTION_TITLES[section]}`, ...bullets(content[section]));
  }
  if (content.skipReview === true) {
    lines.push(
      "",
      `## ${SECTION_TITLES.skipReview}`,
      "Skipped at your request: once validation passes, the work is ready to publish unreviewed.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function approvalLine(record: RequestBriefRecord): string {
  const state = requestApprovalState(record);
  if (state === "unapproved" || record.approval === undefined) {
    return "not approved; this draft has never been approved";
  }
  if (state === "current") {
    return `approved at revision ${record.approval.briefRevision} on ${record.approval.approvedAt}`;
  }
  return `superseded; the approval of revision ${record.approval.briefRevision} no longer covers this draft and reapproval is required`;
}

function bullets(entries: readonly string[]): readonly string[] {
  return entries.length === 0 ? ["- None recorded."] : entries.map((entry) => `- ${entry}`);
}
