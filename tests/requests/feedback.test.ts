import { expect, test } from "bun:test";
import {
  assertFeedbackSize,
  type BriefFeedback,
  briefApprovedPrompt,
} from "../../src/requests/feedback.ts";

const seen = {
  requestId: "req-1",
  briefRevision: 3,
  contentDigest: "content",
  agreementDigest: "agreement",
};

function feedbackOf(bytes: number): BriefFeedback {
  const base: BriefFeedback = { ...seen, comments: [], text: "" };
  return { ...base, text: "x".repeat(bytes - JSON.stringify(base).length) };
}

test("brief feedback up to 64,000 encoded bytes is accepted and one byte more is refused", () => {
  expect(() => assertFeedbackSize(feedbackOf(64_000))).not.toThrow();
  expect(() => assertFeedbackSize(feedbackOf(64_001))).toThrow(
    "Brief feedback may not exceed 64000 bytes",
  );
});

test("the feedback bound counts encoded bytes, not characters", () => {
  const wide: BriefFeedback = { ...seen, comments: [], text: "é".repeat(32_000) };
  expect(JSON.stringify(wide).length).toBeLessThan(64_000);
  expect(() => assertFeedbackSize(wide)).toThrow("may not exceed");
});

test("an approval tells the coordinator the recorded revision and to continue under it", () => {
  expect(briefApprovedPrompt(seen)).toBe(
    "From the open review page:\nThe user approved brief req-1, revision 3. Approval is already recorded for the displayed content and agreement. Continue the conversation under that approval.",
  );
});
