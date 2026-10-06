import { isRecord } from "../adapters/primitives.ts";
import type { CommandRunner } from "../contracts.ts";
import type { PullRequestRef } from "./pull-request.ts";
import type { PrReview, ReviewReply } from "./review.ts";

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
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "uncertain"; message: string }>;

export type PostedReviewLookup =
  | Readonly<{ kind: "found"; url: string }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable"; message: string }>;

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
  /** Persist the exact submission as uncertain before any posting effect. */
  beforePost: () => Promise<void>,
): Promise<PostReviewOutcome> {
  const existing = await findPostedReview(run, input);
  if (existing.kind === "found") return { kind: "already-posted", url: existing.url };
  if (existing.kind === "unreadable") return { kind: "failed", message: existing.message };

  const head = await currentHead(run, input);
  if (head.kind === "unreadable") return { kind: "failed", message: head.message };
  if (head.head !== input.review.head) return { kind: "moved", head: head.head };

  await beforePost();
  let failure: string;
  try {
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
      if (isRecord(posted) && typeof posted.html_url === "string" && posted.html_url.length > 0) {
        return { kind: "posted", url: posted.html_url };
      }
    }
    failure = result.stderr.trim().split("\n")[0] || "GitHub returned no review receipt";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const landed = await findPostedReview(run, input);
  if (landed.kind === "found") return { kind: "posted", url: landed.url };
  return {
    kind: "uncertain",
    message: `${failure}${landed.kind === "unreadable" ? `; ${landed.message}` : ""}`,
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

export type PostThreadReplyInput = Readonly<{
  ref: PullRequestRef;
  cwd: string;
  head: string;
  reply: ReviewReply;
  marker: string;
}>;

/** Read-only reconciliation of a saved reply attempt, including after restart. */
export async function findPostedReply(
  run: CommandRunner,
  input: PostThreadReplyInput,
): Promise<PostedReviewLookup> {
  try {
    const result = await run({
      argv: [
        "gh",
        "api",
        "--paginate",
        "--slurp",
        `repos/${input.ref.repo}/pulls/${input.ref.number}/comments`,
      ],
      cwd: input.cwd,
    });
    if (result.code !== 0) throw new Error(result.stderr || "GitHub returned no comments");
    const pages: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
      throw new Error("Invalid comment pages");
    for (const comment of pages.flat()) {
      if (!isRecord(comment) || typeof comment.body !== "string")
        throw new Error("Invalid comment record");
      if (comment.in_reply_to_id === input.reply.replyTo && comment.body.includes(input.marker)) {
        if (typeof comment.html_url !== "string" || !comment.html_url)
          throw new Error("Missing reply receipt");
        return { kind: "found", url: comment.html_url };
      }
    }
    return { kind: "absent" };
  } catch (error) {
    return { kind: "unreadable", message: String(error) };
  }
}

/** Claims one exact reply before sending; an uncertain reply never automatically retries. */
export async function postThreadReply(
  run: CommandRunner,
  input: PostThreadReplyInput,
  beforePost: () => Promise<void>,
): Promise<PostReviewOutcome> {
  const existing = await findPostedReply(run, input);
  if (existing.kind === "found") return { kind: "already-posted", url: existing.url };
  if (existing.kind === "unreadable") return { kind: "failed", message: existing.message };
  const head = await currentHead(run, { ref: input.ref, cwd: input.cwd });
  if (head.kind === "unreadable") return { kind: "failed", message: head.message };
  if (head.head !== input.head) return { kind: "moved", head: head.head };
  await beforePost();
  let failure = "GitHub returned no reply receipt";
  try {
    const result = await run({
      argv: [
        "gh",
        "api",
        "--method",
        "POST",
        `repos/${input.ref.repo}/pulls/${input.ref.number}/comments`,
        "--input",
        "-",
      ],
      cwd: input.cwd,
      stdin: JSON.stringify({
        commit_id: input.head,
        in_reply_to: input.reply.replyTo,
        body: `${input.reply.body}\n\n${input.marker}`,
      }),
    });
    if (result.code === 0) {
      const receipt: unknown = JSON.parse(result.stdout);
      if (
        isRecord(receipt) &&
        receipt.in_reply_to_id === input.reply.replyTo &&
        typeof receipt.html_url === "string" &&
        receipt.html_url
      )
        return { kind: "posted", url: receipt.html_url };
    }
    failure = result.stderr.trim() || failure;
  } catch (error) {
    failure = String(error);
  }
  const landed = await findPostedReply(run, input);
  if (landed.kind === "found") return { kind: "posted", url: landed.url };
  return { kind: "uncertain", message: failure };
}

export async function findPostedReview(
  run: CommandRunner,
  input: PostReviewInput,
): Promise<PostedReviewLookup> {
  try {
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
    if (result.code !== 0) throw new Error(result.stderr.trim() || "GitHub review lookup failed");
    const pages: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new Error("GitHub review lookup returned unreadable pages");
    }
    for (const review of pages.flat()) {
      if (!isRecord(review) || typeof review.body !== "string") {
        throw new Error("GitHub review lookup returned an unreadable review");
      }
      if (review.body.includes(input.marker)) {
        if (typeof review.html_url !== "string" || review.html_url.length === 0) {
          throw new Error("GitHub review marker has no receipt URL");
        }
        return { kind: "found", url: review.html_url };
      }
    }
    return { kind: "absent" };
  } catch (error) {
    return {
      kind: "unreadable",
      message: `Cannot read GitHub review markers: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function currentHead(
  run: CommandRunner,
  input: Pick<PostReviewInput, "ref" | "cwd">,
): Promise<
  Readonly<{ kind: "head"; head: string }> | Readonly<{ kind: "unreadable"; message: string }>
> {
  try {
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
    if (result.code !== 0 || head.length === 0) {
      throw new Error(result.stderr.trim() || "GitHub returned no PR head");
    }
    return { kind: "head", head };
  } catch (error) {
    return {
      kind: "unreadable",
      message: `Cannot read the current PR head: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
