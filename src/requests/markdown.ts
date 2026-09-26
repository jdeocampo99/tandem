import type { RequestBriefContent, RequestBriefRecord } from "../contracts.ts";
import { requestApprovalState } from "./brief.ts";

/** What a reviewer needs to approve, in reading order. */
const SUMMARY_SECTIONS = [
  ["openQuestions", "Decisions required"],
  ["scope", "In scope"],
  ["nonGoals", "Out of scope"],
  ["acceptanceCriteria", "Automated checks"],
  ["manualVerification", "Manual verification"],
  ["keyDecisions", "Key decisions"],
] as const satisfies readonly (readonly [keyof RequestBriefContent, string])[];

/**
 * Renders the current draft as the read-only view of the durable record. It is a projection only:
 * the pane showing it offers no editing path, and SQLite remains the authority for every field
 * repeated here. The summary comes first so a reviewer can approve from it; how the work gets done
 * and the record's bookkeeping follow under Details.
 */
export function renderRequestBriefMarkdown(record: RequestBriefRecord): string {
  const content = record.draft.content;
  const lines: string[] = [
    "# Request brief",
    "",
    `Revision ${record.draft.revision}, ${approvalLine(record)}. Reply in the main conversation to change it; editing here changes nothing.`,
    "",
    "## Goal",
    content.goal,
  ];
  for (const [section, title] of SUMMARY_SECTIONS) {
    const entries = content[section];
    // An empty question list means nothing waits on the reader, so it earns no heading.
    if (section === "openQuestions" && entries.length === 0) continue;
    lines.push("", `## ${title}`, ...bullets(entries));
  }
  if (content.skipReview === true) {
    lines.push(
      "",
      "## Code review",
      "Skipped at your request: once validation passes, the work is ready to publish unreviewed.",
    );
  }
  lines.push(
    "",
    "---",
    "",
    "# Details",
    "",
    "## Approach",
    content.recommendedApproach,
    "",
    "## Constraints",
    ...bullets(content.constraints),
    "",
    "## References",
    ...bullets(content.researchLinks),
    "",
    "## Record",
    `- Request: ${record.id}`,
    `- Repository: ${record.repoPath}`,
    `- Revision ${record.draft.revision}: ${record.draft.changeKind} change, recorded ${record.draft.recordedAt}`,
    `- Content digest: ${record.draft.contentDigest}`,
  );
  return `${lines.join("\n")}\n`;
}

function approvalLine(record: RequestBriefRecord): string {
  if (record.abandonedAt !== undefined) return `abandoned on ${record.abandonedAt}`;
  const state = requestApprovalState(record);
  if (state === "unapproved" || record.approval === undefined) return "not approved yet";
  if (state === "current") {
    return `approved at revision ${record.approval.briefRevision} on ${record.approval.approvedAt}`;
  }
  return `needs reapproval; the approval of revision ${record.approval.briefRevision} no longer covers this draft`;
}

function bullets(entries: readonly string[]): readonly string[] {
  return entries.length === 0 ? ["- None recorded."] : entries.map((entry) => `- ${entry}`);
}
