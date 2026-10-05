import type { RequestBriefContent, RequestBriefRecord } from "../contracts.ts";
import { requestApprovalState } from "./brief.ts";

export type BriefComment = Readonly<{
  id: string;
  requestId: string;
  briefRevision: number;
  contentDigest: string;
  lineId: string;
  body: string;
  author: string;
  at: string;
}>;
export type BriefLine = Readonly<{
  id: string;
  number: number;
  section: string;
  kind: "heading" | "text" | "item";
  text: string;
  isNew: boolean;
  comments: readonly BriefComment[];
}>;
export type BriefView = Readonly<{
  requestId: string;
  title: string;
  revision: number;
  changes: number;
  approval: Readonly<{
    requestId: string;
    briefRevision: number;
    contentDigest: string;
    agreementDigest: string;
  }>;
  approvalState: ReturnType<typeof requestApprovalState>;
  abandoned: boolean;
  lines: readonly BriefLine[];
  commentCount: number;
  browserUrl?: string;
}>;

export function briefView(
  record: RequestBriefRecord,
  comments: readonly BriefComment[] = [],
  browserUrl?: string,
): BriefView {
  const previous = record.history
    .filter((revision) => revision.revision < record.draft.revision)
    .toSorted((a, b) => b.revision - a.revision)[0];
  const current = contentLines(record.draft.content);
  const old = previous === undefined ? [] : contentLines(previous.content);
  const unchanged = matchingLines(old, current);
  const lines = current.map((line, index) => ({
    ...line,
    number: index + 1,
    isNew: previous !== undefined && !unchanged.has(index),
    comments: comments.filter(
      (comment) =>
        comment.lineId === line.id &&
        comment.requestId === record.id &&
        comment.briefRevision === record.draft.revision &&
        comment.contentDigest === record.draft.contentDigest,
    ),
  }));
  return {
    requestId: record.id,
    title: record.draft.content.summary?.title ?? "Request brief",
    revision: record.draft.revision,
    changes:
      previous === undefined
        ? 0
        : Math.max(current.length - unchanged.size, old.length - unchanged.size),
    approval: {
      requestId: record.id,
      briefRevision: record.draft.revision,
      contentDigest: record.draft.contentDigest,
      agreementDigest: record.draft.agreementDigest,
    },
    approvalState: requestApprovalState(record),
    abandoned: record.abandonedAt !== undefined,
    lines,
    commentCount: lines.reduce((sum, line) => sum + line.comments.length, 0),
    ...(browserUrl === undefined ? {} : { browserUrl }),
  };
}

type ContentLine = Omit<BriefLine, "number" | "isNew" | "comments">;
function contentLines(content: RequestBriefContent): ContentLine[] {
  const sections: Readonly<{ title: string; items: readonly string[]; kind: "text" | "item" }>[] = [
    { title: "TL;DR", items: [content.goal], kind: "text" },
    ...(content.summary === undefined
      ? []
      : [
          {
            title: "Before and after",
            items: content.summary.beforeAfter.flatMap((moment) => [
              moment.moment,
              `Before: ${moment.before}`,
              `After: ${moment.after}`,
            ]),
            kind: "text" as const,
          },
        ]),
    ...(content.openQuestions.length === 0
      ? []
      : [{ title: "Decisions needed", items: content.openQuestions, kind: "item" as const }]),
    ...(content.summary === undefined
      ? []
      : [
          {
            title: "Size and risk",
            items: [
              `Size: ${content.summary.size.level}. ${content.summary.size.reason}`,
              `Risk: ${content.summary.risk.level}. ${content.summary.risk.reason}`,
            ],
            kind: "text" as const,
          },
        ]),
    { title: "How you'll verify", items: content.manualVerification, kind: "item" },
    ...(content.skipReview !== true
      ? []
      : [{ title: "Code review", items: ["Skipped at your request"], kind: "text" as const }]),
    {
      title: "Approach",
      items:
        typeof content.recommendedApproach === "string"
          ? [content.recommendedApproach]
          : content.recommendedApproach,
      kind: "item",
    },
    { title: "In scope", items: content.scope, kind: "item" },
    { title: "Out of scope", items: content.nonGoals, kind: "item" },
    { title: "Automated checks", items: content.acceptanceCriteria, kind: "item" },
    { title: "Constraints", items: content.constraints, kind: "item" },
    { title: "Decisions already made", items: content.keyDecisions, kind: "item" },
    { title: "References", items: content.researchLinks, kind: "item" },
  ];
  return sections.flatMap((section) => [
    {
      id: `${section.title}:heading`,
      section: section.title,
      kind: "heading" as const,
      text: section.title,
    },
    ...section.items.flatMap((item, itemIndex) =>
      item.split(/\r?\n/u).map((text, lineIndex) => ({
        id: `${section.title}:${itemIndex}:${lineIndex}`,
        section: section.title,
        kind: section.kind,
        text,
      })),
    ),
  ]);
}

/** LCS compares content in a section, so inserting a line doesn't mark all following lines NEW. */
function matchingLines(
  old: readonly ContentLine[],
  current: readonly ContentLine[],
): ReadonlySet<number> {
  const equal = (left: ContentLine | undefined, right: ContentLine | undefined) =>
    left !== undefined &&
    right !== undefined &&
    left.section === right.section &&
    left.kind === right.kind &&
    left.text === right.text;
  const table = Array.from({ length: old.length + 1 }, () =>
    Array<number>(current.length + 1).fill(0),
  );
  for (let i = old.length - 1; i >= 0; i--)
    for (let j = current.length - 1; j >= 0; j--) {
      const row = table[i];
      if (row !== undefined)
        row[j] = equal(old[i], current[j])
          ? 1 + (table[i + 1]?.[j + 1] ?? 0)
          : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  const matched = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < old.length && j < current.length) {
    if (equal(old[i], current[j])) {
      matched.add(j);
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return matched;
}
