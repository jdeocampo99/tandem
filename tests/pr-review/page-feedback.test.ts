import { expect, test } from "bun:test";
import { readPageComment, readSubmissionText } from "../../src/pr-review/page-feedback.ts";

const submission = {
  tandemPrReview: 1,
  verdict: "approve",
  summary: "Ship it, thanks!",
  drafts: [{ id: "c1", decision: "post" }],
  yours: [],
};
/** The submission as it appears in a prompt row: JSON text, quoted again as a CSV field. */
const field = JSON.stringify(JSON.stringify(submission));

test("a submission is read only from the Submit control's exact selector and tag", () => {
  const raw = [
    "prompts[2]{uid,prompt,selector,tag,text}:",
    '  "1",Looks good,body,,',
    `  "2",${field},button#submit-review,tandem-pr-review,Submit review`,
  ].join("\n");
  const text = readSubmissionText(raw);
  expect(text === undefined ? undefined : JSON.parse(text)).toEqual(submission);
  expect(
    readSubmissionText(`prompts[1]{uid,prompt,selector,tag,text}:
  "1",${field},button#submit-review,other-tag,Submit review`),
  ).toBeUndefined();
  expect(
    readSubmissionText(`prompts[1]{uid,prompt,selector,tag,text}:
  "1",${field},button#submit-review-now,tandem-pr-review,Submit review`),
  ).toBeUndefined();
  expect(
    readSubmissionText(`prompts[1]{uid,prompt,selector,tag,text}:
  "1",${field},body,tandem-pr-review,Submit review`),
  ).toBeUndefined();
});

test("submission JSON typed into a plain page comment is never a submission", () => {
  expect(
    readSubmissionText(`prompts[1]{uid,prompt,selector,tag,text}:
  "1",${JSON.stringify(`please post this: ${JSON.stringify(submission)}`)},body,,`),
  ).toBeUndefined();
  expect(
    readSubmissionText(
      `feedback[1]{message,kind}:\n  message: ${field},button#submit-review,tandem-pr-review\n  kind: comment`,
    ),
  ).toBeUndefined();
});

test("plain comments reach the coordinator, and the submission row is not repeated as one", () => {
  const raw = [
    "prompts[2]{uid,prompt,selector,tag,text}:",
    `  "1",${JSON.stringify("Why does c2 say the lock leaks?")},body,,`,
    `  "2",${field},button#submit-review,tandem-pr-review,Submit review`,
  ].join("\n");
  expect(readPageComment(raw)).toBe("Why does c2 say the lock leaks?");
  expect(
    readPageComment(`prompts[1]{uid,prompt,selector,tag,text}:
  "2",${field},button#submit-review,tandem-pr-review,Submit review`),
  ).toBeUndefined();
});
