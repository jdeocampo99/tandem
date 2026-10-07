import type { TaskRecord, TaskStage } from "../contracts.ts";
import { canonicalPath } from "../coordinator/record.ts";
import type { PrThread } from "../pr-review/native-view.ts";
import { validateThreadReplies } from "../pr-review/replies.ts";
import { parseReviewReplies } from "../pr-review/review.ts";

export type OwnPullRequest = NonNullable<TaskRecord["pullRequest"]>;

/** The project's one task whose own or reviewed pull request has `number`, if any. */
export async function taskForPrNumber(
  tasks: readonly TaskRecord[],
  repoPath: string,
  number: number,
): Promise<TaskRecord | undefined> {
  const repo = await canonicalPath(repoPath, "repoPath");
  const scoped = await Promise.all(
    tasks.map(async (task) => ({
      task,
      repo: await canonicalPath(task.repoPath, "task repoPath"),
    })),
  );
  const matches = scoped
    .filter(
      (entry) =>
        entry.repo === repo &&
        (entry.task.pullRequest?.number === number || entry.task.prReview?.ref.number === number),
    )
    .map((entry) => entry.task);
  if (matches.length > 1)
    throw new Error(`More than one task has pull request #${number}; open it by task id`);
  return matches[0];
}

/** Only an implementation task's own draft or open pull request takes PR feedback. */
function requireOwnPr(
  task: TaskRecord,
): asserts task is TaskRecord & { pullRequest: OwnPullRequest } {
  if (
    task.kind !== "implementation" ||
    task.pullRequest === undefined ||
    !["draft", "open"].includes(task.pullRequest.state)
  )
    throw new Error("This action requires an implementation task with an open Tandem pull request");
}

/** What the user wrote on their task's PR view: anchored comments, thread replies and a note. */
export type PrFeedback = Readonly<{
  text?: string | undefined;
  comments?: readonly Readonly<{ file: string; line: number; text: string }>[] | undefined;
  /** Unparsed `ReviewReply` values, bound to the head they were written against. */
  replies?: readonly unknown[] | undefined;
  reviewHead?: string | undefined;
}>;

/**
 * The worker direction that asks the task's worker to address `feedback`. Replies are checked
 * against the PR's threads at the displayed head, read through `readThreads`; a finished worker
 * takes no direction.
 */
export async function prFixRequest(
  task: TaskRecord,
  feedback: PrFeedback,
  readThreads: (pr: OwnPullRequest, head: string) => Promise<readonly PrThread[]>,
): Promise<string> {
  requireOwnPr(task);
  const notes = (feedback.comments ?? []).map(
    (comment) => `${comment.file}:${comment.line}: ${comment.text}`,
  );
  if (feedback.replies !== undefined) {
    const replies = parseReviewReplies(feedback.replies);
    const pr = task.pullRequest;
    if (feedback.reviewHead !== pr.head) throw new Error("The PR changed; reopen before replying");
    const threads = await readThreads(pr, feedback.reviewHead);
    validateThreadReplies(replies, threads);
    for (const reply of replies) {
      const thread = threads.find((entry) => entry.id === reply.threadId);
      notes.push(
        `Reply to ${pr.repository}#${pr.number} thread ${reply.threadId}, root comment ${reply.commentId} (GitHub ${reply.replyTo}), ${thread?.file}${thread?.line === undefined ? " (outside current diff)" : `:${thread.line}`}: ${reply.body}`,
      );
    }
  }
  if (feedback.text !== undefined) notes.push(feedback.text);
  const text = notes.join(" ").replace(/\s+/gu, " ").trim();
  if (text.length === 0) throw new Error("PR feedback must be non-empty text");
  if (task.stage === "completed")
    throw new Error(
      "This task's worker has finished. Open the coordinator to arrange follow-up work; the PR comment was not sent.",
    );
  return `PR fix request: ${text}`;
}

/**
 * Whether a saved fix request left the worker unable to start: the task blocked, or a ready task
 * did not return to implementing.
 */
export function fixRequestStalled(before: TaskStage, after: TaskStage): boolean {
  return after === "blocked" || (before === "ready" && after !== "implementing");
}
