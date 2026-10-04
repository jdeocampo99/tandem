import { PR_REVIEW_SCHEMA, type ReviewLens } from "./review.ts";
import type { PrReviewState } from "./state.ts";

export type PrReviewBriefInput = Readonly<{
  state: PrReviewState;
  head: string;
  from: string;
  contextPath: string;
  /** The diff with new-file line numbers in front of each line. */
  diffPath: string;
  /** Recovery notices and the user's messages, appended as given. */
  extra: readonly string[];
}>;

const VOICE = [
  'Write every comment the way a kind, busy teammate would: short, specific, and phrased as a suggestion or a question, e.g. "Could we move the release into a `finally`? Otherwise the lock leaks if `save` throws."',
  'Never use severity codes, P0-P3, headings, or bullet lists inside a comment. Start minor points with "nit:".',
  "For a small, exact fix, put the replacement lines in a GitHub ```suggestion block inside the comment body.",
  "Only raise what the diff or repository evidence supports; say so when you are unsure instead of asserting.",
];

const SCOPE = [
  "Judge the change against this repository's own guidance: read AGENTS.md, CLAUDE.md, CONTRIBUTING.md, or similar at the repository root when present, and fall back to general good practice.",
  "You are read-only. Use read, grep, and glob for files; bash only runs read-only git and gh commands, such as git log, git blame, git show, and gh pr view.",
  "Do not run tests, builds, installs, formatters, or linters.",
];

/** The brief for one PR review worker run. */
export function buildPrReviewBrief(input: PrReviewBriefInput): string {
  const { state } = input;
  const lines = [
    `# Tandem PR review: ${state.ref.repo}#${state.ref.number}`,
    "",
    "## Where things are",
    `- You are in a checkout of the PR at HEAD ${input.head}.`,
    `- PR context (description, CI, linked issues, existing threads): ${input.contextPath}`,
    `- The diff to review (${input.from}..${input.head}): ${input.diffPath}. The number before each line is its new-file line; anchor comments on those numbers. Removed lines have none and cannot take a comment.`,
    "",
    ...modeSection(input),
    "",
    "## Scope",
    ...SCOPE.map((line) => `- ${line}`),
    ...(input.extra.length === 0 ? [] : ["", "## Messages", ...input.extra]),
  ];
  return lines.join("\n");
}

function modeSection(input: PrReviewBriefInput): string[] {
  const { state } = input;
  if (state.mode === "question") {
    return [
      "## Task",
      "The user has a follow-up question about this PR in the messages below. Answer it from the code, the diff, and the PR context, citing file:line where it helps.",
      "Submit the answer with submit_report, outcome completed, as plain Markdown in the report field. Keep it short.",
    ];
  }
  return [
    "## Task",
    state.mode === "re-review"
      ? 'The author pushed changes since your last review. Review only the new diff, and for each of your earlier comments in the context file, report whether it was addressed, not addressed, or replied to without a change, in priorComments. Draft a short, warm reply (like "Looks good, thanks!") for each addressed one.'
      : "Review this pull request for the user, who wants fast context and draft comments they can post.",
    "",
    "## Lens",
    lensInstructions(state.lens),
    "",
    "## Voice",
    ...VOICE.map((line) => `- ${line}`),
    "",
    "## Output",
    "- intent: what the PR does and why, in 2-3 plain sentences a reviewer can read cold.",
    "- verdict: one sentence on whether it is safe to merge and what has to happen first.",
    "- tour: a guided walk through the code in 2-4 chapters, about 3-12 stops in all. Each stop is a new-file line range in the diff with a 1-2 sentence explanation, in the order the code runs.",
    "- concerns: at most 5, only points with no single line; a point about one line is a comment.",
    "- comments: inline drafts anchored to new-file lines inside the diff.",
    "- summaryComment: the review body to post, 1-4 sentences in the same voice.",
    "",
    PR_REVIEW_SCHEMA,
    `Use "${input.head}" as head.`,
  ];
}

function lensInstructions(lens: ReviewLens): string {
  if (lens.kind === "intent") {
    return "Intent only. Judge whether the approach makes sense, whether the scope is right, how it fits the codebase, and whether a simpler way exists. Leave comments empty and put 2-4 big-picture concerns in concerns and summaryComment. No nits.";
  }
  if (lens.kind === "focus") {
    return `Focus on what the user asked about: "${lens.focus}". Review that area in full depth and the rest lightly, raising only serious problems elsewhere.`;
  }
  return "Full review. Look at behavior, error handling, edge cases, ordering, design, and test coverage of the changed code and its callers.";
}
