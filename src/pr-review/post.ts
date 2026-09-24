import { isRecord } from "../adapters/primitives.ts";
import type { CommandRunner } from "../contracts.ts";
import type { PullRequestRef } from "./pull-request.ts";
import type { PrReview } from "./review.ts";

/** The verdict is always the user's; Tandem never picks it. */
export type ReviewVerdict = "comment" | "approve" | "request-changes";

export type PostReviewInput = Readonly<{
  ref: PullRequestRef;
  review: PrReview;
  verdict: ReviewVerdict;
  /** Hidden in the rendered body; identifies this post so a retry never posts twice. */
  marker: string;
  cwd: string;
}>;

export type PostReviewOutcome =
  | Readonly<{ kind: "posted"; url: string }>
  | Readonly<{ kind: "already-posted"; url: string }>
  | Readonly<{ kind: "moved"; head: string }>
  | Readonly<{ kind: "failed"; message: string }>;

const EVENTS: Readonly<Record<ReviewVerdict, string>> = {
  comment: "COMMENT",
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
};

/** A marker unique to one task's review round, as an HTML comment GitHub does not render. */
export function reviewMarker(taskId: string, round: number): string {
  return `<!-- tandem-review:${taskId}:${round} -->`;
}

/** The `POST /pulls/{n}/reviews` payload, pinned to the reviewed commit. */
export function reviewRequestBody(input: Omit<PostReviewInput, "cwd">): Record<string, unknown> {
  const body = [input.review.summaryComment, input.marker].filter((part) => part.length > 0);
  return {
    commit_id: input.review.head,
    event: EVENTS[input.verdict],
    body: body.join("\n\n"),
    comments: input.review.comments.map((comment) => ({
      path: comment.file,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    })),
  };
}

/**
 * Posts one GitHub review. It refuses when the PR moved past the reviewed commit, and it looks for
 * its own marker before and after posting, so an uncertain failure is never blindly retried.
 */
export async function postReview(
  run: CommandRunner,
  input: PostReviewInput,
): Promise<PostReviewOutcome> {
  const existing = await findPostedReview(run, input);
  if (existing !== undefined) return { kind: "already-posted", url: existing };

  const head = await currentHead(run, input);
  if (head !== undefined && head !== input.review.head) return { kind: "moved", head };

  const result = await run({
    argv: [
      "gh",
      "api",
      "--method",
      "POST",
      `repos/${input.ref.repo}/pulls/${input.ref.number}/reviews`,
      "--input",
      "-",
    ],
    cwd: input.cwd,
    stdin: JSON.stringify(reviewRequestBody(input)),
  });
  if (result.code === 0) {
    const posted: unknown = JSON.parse(result.stdout);
    return { kind: "posted", url: isRecord(posted) ? String(posted.html_url ?? "") : "" };
  }
  const landed = await findPostedReview(run, input);
  if (landed !== undefined) return { kind: "posted", url: landed };
  return {
    kind: "failed",
    message: result.stderr.trim().split("\n")[0] ?? "GitHub refused the review",
  };
}

/** Posts a short reply on an earlier review thread, for comments marked addressed. */
export async function replyToComment(
  run: CommandRunner,
  input: Readonly<{ ref: PullRequestRef; commentId: number; body: string; cwd: string }>,
): Promise<boolean> {
  const result = await run({
    argv: [
      "gh",
      "api",
      "--method",
      "POST",
      `repos/${input.ref.repo}/pulls/${input.ref.number}/comments/${input.commentId}/replies`,
      "-f",
      `body=${input.body}`,
    ],
    cwd: input.cwd,
  });
  return result.code === 0;
}

async function findPostedReview(
  run: CommandRunner,
  input: PostReviewInput,
): Promise<string | undefined> {
  const result = await run({
    argv: [
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/${input.ref.repo}/pulls/${input.ref.number}/reviews`,
    ],
    cwd: input.cwd,
  });
  if (result.code !== 0) return undefined;
  const pages: unknown = JSON.parse(result.stdout);
  const reviews = Array.isArray(pages) ? pages.flat() : [];
  for (const review of reviews) {
    if (isRecord(review) && typeof review.body === "string" && review.body.includes(input.marker)) {
      return String(review.html_url ?? "");
    }
  }
  return undefined;
}

async function currentHead(
  run: CommandRunner,
  input: PostReviewInput,
): Promise<string | undefined> {
  const result = await run({
    argv: [
      "gh",
      "pr",
      "view",
      String(input.ref.number),
      "--repo",
      input.ref.repo,
      "--json",
      "headRefOid",
      "--jq",
      ".headRefOid",
    ],
    cwd: input.cwd,
  });
  const head = result.stdout.trim();
  return result.code === 0 && head.length > 0 ? head : undefined;
}
