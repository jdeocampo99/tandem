import type { RequestBriefRecord } from "../contracts.ts";
import { requestApprovalState } from "./brief.ts";

/**
 * Renders the current draft as the read-only view of the durable record. SQLite remains the
 * authority for every field repeated here.
 */
export function renderRequestBriefMarkdown(record: RequestBriefRecord): string {
  const content = record.draft.content;
  const lines: string[] = [
    "# Request brief",
    "",
    `Revision ${record.draft.revision}. Plan status: ${approvalLine(record)}.`,
    "Reply in the main conversation to change it; editing here changes nothing.",
    "",
    "## Goal",
    content.goal,
  ];
  if (content.userStories.length > 0) {
    lines.push(
      "",
      "## User stories",
      ...content.userStories.map(
        (story) => `- ${story.actor} can ${story.action}, so ${story.outcome}.`,
      ),
    );
  }
  lines.push(
    "",
    "## Proposed approach",
    content.recommendedApproach,
    "",
    "## Approval scope",
    "Brief approval confirms agreement with this plan only. Implementation still requires separate approval of its final scope. Publishing, merging, deploying, and destructive actions need separate approval.",
    "",
    "Critical safety limits:",
    ...bullets(content.constraints),
  );
  if (content.skipReview === true) {
    lines.push(
      "",
      "Code review is skipped at your request after validation; publishing still requires approval.",
    );
  }
  if (content.openQuestions.length > 0) {
    lines.push("", "## Decisions required", ...bullets(content.openQuestions));
  }
  lines.push(
    "",
    "## What is included",
    ...bullets(content.scope),
    "",
    "## How it is checked",
    "",
    "### Behavioral checks",
    ...bullets(content.acceptanceCriteria),
  );
  if (content.verificationCommands.length > 0) {
    lines.push("", "### Routine project commands", ...bullets(content.verificationCommands));
  }
  lines.push(
    "",
    "### Hands-on verification",
    ...bullets(content.manualVerification),
    "",
    "## Limits",
    "",
    "### Out of scope",
    ...bullets(content.nonGoals),
    "",
    "### Constraints",
    ...bullets(content.constraints),
    "",
    "## Key decisions",
    ...bullets(content.keyDecisions),
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
