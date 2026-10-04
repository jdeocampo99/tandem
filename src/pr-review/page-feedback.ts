import { feedbackMessages } from "../adapters/lavish.ts";
import { isRecord } from "../adapters/primitives.ts";
import { SUBMISSION_TAG, SUBMIT_SELECTOR } from "./page.ts";

/**
 * A submission posts the review under the user's name, so it is accepted only from the page's
 * tagged Submit control: a prompt row whose selector and tag match exactly. Scanning every quoted
 * string would let a plain page comment holding submission JSON post a review.
 */
const SUBMIT_ROW = new RegExp(
  `^\\s+"(?:[^"\\\\]|\\\\.)*",("(?:[^"\\\\]|\\\\.)*"),${escapeRegExp(SUBMIT_SELECTOR)},${escapeRegExp(SUBMISSION_TAG)}(?:,|$)`,
  "u",
);

/** The latest submission text from the Submit control in one poll's feedback, unparsed. */
export function readSubmissionText(rawFeedback: string): string | undefined {
  let inPrompts = false;
  let found: string | undefined;
  for (const line of rawFeedback.split(/\r?\n/u)) {
    if (/^prompts\[\d+\]\{/u.test(line)) {
      inPrompts = true;
      continue;
    }
    if (/^(?:feedback|session|errors|warnings)\b/u.test(line)) {
      inPrompts = false;
      continue;
    }
    if (!inPrompts) continue;
    const quoted = SUBMIT_ROW.exec(line)?.[1];
    if (quoted === undefined) continue;
    try {
      const text: unknown = JSON.parse(quoted);
      if (typeof text === "string" && /^\s*\{/u.test(text)) found = text;
    } catch {
      // A malformed prompt row is not a submission.
    }
  }
  return found;
}

/** Plain comments left on the page in one poll, leaving out submission rows. */
export function readPageComment(rawFeedback: string): string | undefined {
  return feedbackMessages(rawFeedback, (action) => isRecord(action) && "tandemPrReview" in action);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
