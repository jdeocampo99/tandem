import type { RequestBriefContent, RequestBriefRecord } from "../contracts.ts";
import { requestApprovalState } from "./brief.ts";

const SECTION_TITLES: Readonly<Record<keyof RequestBriefContent, string>> = {
  goal: "Goal",
  scope: "Scope",
  constraints: "Constraints",
  nonGoals: "Non-goals",
  acceptanceCriteria: "Tandem will check",
  userCheckCriteria: "You'll check (screenshots at the end)",
  recommendedApproach: "Recommended approach",
  keyDecisions: "Key decisions",
  openQuestions: "Unresolved questions",
  researchLinks: "Research links",
};

const LEADING_LIST_SECTIONS = ["scope", "constraints", "nonGoals"] as const;

const TRAILING_LIST_SECTIONS = ["keyDecisions", "openQuestions", "researchLinks"] as const;

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
  for (const section of LEADING_LIST_SECTIONS) {
    lines.push("", `## ${SECTION_TITLES[section]}`, ...bullets(content[section]));
  }
  const userCheckCriteria = content.userCheckCriteria ?? [];
  lines.push(
    "",
    `## ${SECTION_TITLES.acceptanceCriteria}`,
    ...checkedBullets(content.acceptanceCriteria, "✓"),
  );
  if (userCheckCriteria.length > 0) {
    lines.push(
      "",
      `## ${SECTION_TITLES.userCheckCriteria}`,
      ...checkedBullets(userCheckCriteria, "◻"),
    );
  }
  lines.push("", "Reply in the main conversation to move a criterion between the groups.");
  for (const section of TRAILING_LIST_SECTIONS) {
    lines.push("", `## ${SECTION_TITLES[section]}`, ...bullets(content[section]));
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

function checkedBullets(entries: readonly string[], mark: "✓" | "◻"): readonly string[] {
  return entries.length === 0
    ? ["- None recorded."]
    : entries.map((entry) => `- ${mark} ${entry}`);
}
