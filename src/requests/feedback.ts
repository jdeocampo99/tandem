import type { RequestBriefRecord, RequestBriefRevision } from "../contracts.ts";
import { assertNotAbandoned, RequestBriefError } from "./brief.ts";
import { renderRequestBriefMarkdown } from "./markdown.ts";

/** The brief identity the native view displayed, carried unchanged by every brief action. */
export type ViewedBrief = Readonly<{
  requestId: string;
  briefRevision: number;
  contentDigest: string;
  agreementDigest: string;
}>;

export type BriefFeedback = ViewedBrief &
  Readonly<{
    text?: string;
    comments: readonly Readonly<{ line: number; text: string }>[];
  }>;

/** Feedback may describe an older preserved draft, but may never claim text that was not shown. */
export function briefFeedbackPrompt(
  record: RequestBriefRecord,
  feedback: BriefFeedback,
  requestChanges: boolean,
): string {
  assertNotAbandoned(record);
  if (record.id !== feedback.requestId) {
    throw new RequestBriefError("request-mismatch", "Feedback names another request", record.id);
  }
  const draft: RequestBriefRevision | undefined = [record.draft, ...record.history].find(
    (revision) => revision.revision === feedback.briefRevision,
  );
  if (draft === undefined) {
    throw new RequestBriefError(
      "stale-revision",
      "Feedback names an unknown brief revision",
      record.id,
    );
  }
  if (draft.contentDigest !== feedback.contentDigest) {
    throw new RequestBriefError(
      "stale-content",
      "Feedback carries a different content digest",
      record.id,
    );
  }
  if (draft.agreementDigest !== feedback.agreementDigest) {
    throw new RequestBriefError(
      "stale-agreement",
      "Feedback carries a different agreement digest",
      record.id,
    );
  }
  const lines = renderRequestBriefMarkdown({ ...record, draft }).split("\n");
  const notes = feedback.comments.map((comment) => {
    const line = lines[comment.line - 1];
    if (line === undefined) throw new TypeError(`Brief line ${comment.line} does not exist`);
    return `Line ${comment.line} (${line}):\n${comment.text}`;
  });
  if (feedback.text !== undefined) notes.push(feedback.text);
  if (notes.length === 0) throw new TypeError("Brief feedback requires a comment");
  return [
    "From the open review page:",
    `Brief ${record.id}, revision ${draft.revision}: ${requestChanges ? "Request changes" : "Comment"}`,
    ...notes,
  ].join("\n\n");
}
