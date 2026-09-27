import type { RequestBriefRecord } from "../contracts.ts";
import { requestApprovalState } from "./brief.ts";

/**
 * Renders the current draft as the read-only view of the durable record. It is a projection only:
 * the pane showing it offers no editing path, and SQLite remains the authority for every field
 * repeated here. Everything above the divider is what the reader needs to approve; the details
 * below it are for checking specifics.
 */
export function renderRequestBriefMarkdown(record: RequestBriefRecord): string {
  const content = record.draft.content;
  const summary = content.summary;
  const lines: string[] = [
    `# ${summary?.title ?? "Request brief"}`,
    "",
    `Revision ${record.draft.revision}, ${approvalLine(record)}. Reply in the main conversation to change it; editing here changes nothing.`,
    "",
    "## TL;DR",
    content.goal,
  ];
  if (summary !== undefined) {
    lines.push("", "## Before and after");
    summary.beforeAfter.forEach((moment, index) => {
      lines.push(
        `${index + 1}. **${moment.moment}**`,
        `   - Before: ${moment.before}`,
        `   - After: ${moment.after}`,
      );
    });
  }
  // An empty question list means nothing waits on the reader, so it earns no heading.
  if (content.openQuestions.length > 0) {
    lines.push("", "## Decisions needed", ...bullets(content.openQuestions));
  }
  if (summary !== undefined) {
    lines.push(
      "",
      "## Size and risk",
      `- **Size: ${capitalized(summary.size.level)}.** ${summary.size.reason}`,
      `- **Risk: ${capitalized(summary.risk.level)}.** ${summary.risk.reason}`,
    );
  }
  lines.push("", "## How you'll verify", ...bullets(content.manualVerification));
  if (content.skipReview === true) {
    lines.push(
      "",
      "## Code review",
      "Skipped at your request: once validation passes, the work is ready to publish unreviewed.",
    );
  }
  lines.push(
    "",
    "## Approach",
    ...approach(content.recommendedApproach),
    "",
    "---",
    "",
    "## Details",
    "",
    "### In scope",
    ...bullets(content.scope),
    "",
    "### Out of scope",
    ...bullets(content.nonGoals),
    "",
    "### Automated checks",
    ...bullets(content.acceptanceCriteria),
    "",
    "### Constraints",
    ...bullets(content.constraints),
    "",
    "### Decisions already made",
    ...bullets(content.keyDecisions),
    "",
    "### References",
    ...bullets(content.researchLinks),
    "",
    "### Record",
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

/** Numbered steps, or the single paragraph a brief saved before steps holds. */
function approach(steps: string | readonly string[]): readonly string[] {
  if (typeof steps === "string") return [steps];
  return steps.map((step, index) => `${index + 1}. ${step}`);
}

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}
