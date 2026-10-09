import { readFile } from "node:fs/promises";
import { ApprovalRequiredError } from "../adapters/primitives.ts";
import type { Clock, CommandRunner, TaskRecord } from "../contracts.ts";
import { commentableLines } from "./diff.ts";
import { applyEdits, type PrReviewEdits, submissionEdits } from "./edits.ts";
import type { ReviewSubmission } from "./page.ts";
import { ReviewPages } from "./page-session.ts";
import type { PostReceiptOutcome, ReviewVerdict } from "./post.ts";
import { createReviewReceipts } from "./receipts.ts";
import { renderReviewText, replyPostNotes, reviewPostFailure } from "./render.ts";
import type { ReviewLens } from "./review.ts";
import { startPrReview } from "./start.ts";
import {
  latestRound,
  type PrReviewMode,
  type PrReviewRound,
  type PrReviewState,
  postedRound,
  prReviewRunDiffPath,
  replaceLatestRound,
  reviewState,
} from "./state.ts";

export type StartPrReviewInput = Readonly<{
  /** A PR URL, `owner/repo#123`, or text containing one. */
  pullRequest: string;
  /** The coordinator's project, whose policy and model settings the review runs under. */
  repoPath: string;
  lens?: ReviewLens;
  /** A path the user named when Tandem asked where the repository is. */
  checkout?: string;
  /** The user said "clone it". */
  clone?: boolean;
}>;

export type StartPrReviewResult =
  | Readonly<{ kind: "started"; taskId: string; message: string }>
  | Readonly<{ kind: "existing"; taskId: string; message: string }>
  | Readonly<{
      kind: "needs-location";
      repo: string;
      paths: readonly string[];
      /** The question for the user. */
      message: string;
      /** What the coordinator does with the user's answer. */
      nextStep: string;
    }>
  | Readonly<{ kind: "refused"; message: string }>;

export type ShowPrReviewResult = Readonly<{
  taskId: string;
  text: string;
  pageUrl?: string;
}>;

/** What one wait on an open review page ended with. */
export type ReviewPageEvent =
  | Readonly<{ kind: "submission"; submission: ReviewSubmission; ended: boolean }>
  | Readonly<{ kind: "invalid"; problems: readonly string[]; ended: boolean }>
  | Readonly<{ kind: "comment"; text: string; ended: boolean }>
  | Readonly<{ kind: "other"; ended: boolean }>
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "stopped" }>;

export type PostPrReviewResult = Readonly<{
  taskId: string;
  posted: boolean;
  message: string;
  url?: string;
}>;

export type ReceiptResult =
  | Readonly<{ kind: "posted"; round: PrReviewRound; label: string }>
  | Readonly<{
      kind: "unconfirmed";
      outcome: Exclude<PostReceiptOutcome, { kind: "posted" }>;
      recovering: boolean;
    }>;

/** The finished review round the native pane displayed when the user clicked Submit. */
export type ReviewSubmissionBinding = Readonly<{ head: string; generation: number }>;

/** One explicitly confirmed recovery of the exact task revision the user inspected. */
export type ReviewPostRecovery =
  | Readonly<{ kind: "post-again"; taskRevision: number }>
  | Readonly<{ kind: "mark-posted"; taskRevision: number; url: string }>
  | Readonly<{ kind: "post-reply-again"; taskRevision: number; replyIndex: number }>
  | Readonly<{ kind: "mark-reply-posted"; taskRevision: number; replyIndex: number; url: string }>;

/** What the review workflow needs from the task service; everything else it does itself. */
export type PrReviewDependencies = Readonly<{
  home: string;
  /** Tern presents the same reviewed result in a native PR split instead of Lavish. */
  openNativePage?: (task: TaskRecord) => Promise<void>;
  run: CommandRunner;
  clock: Clock;
  /** Folders crawled for a checkout, read on each use; see `projectRoots` in repos/locate.ts. */
  projectRoots: () => Promise<readonly string[]>;
  listTasks: () => Promise<readonly TaskRecord[]>;
  getTask: (id: string) => Promise<TaskRecord>;
  createTask: (
    input: Readonly<{ repoPath: string; objective: string; prReview: PrReviewState }>,
  ) => Promise<TaskRecord>;
  updatePrReview: (task: TaskRecord, next: PrReviewState) => Promise<TaskRecord>;
  /** Applies a pure review mutation under a short store lock, preserving other task changes. */
  mutatePrReview: (
    taskId: string,
    update: (task: TaskRecord) => PrReviewState,
  ) => Promise<Readonly<{ task: TaskRecord; changed: boolean }>>;
  /** Moves a completed review back to queued for another run, and starts it. */
  runAgain: (task: TaskRecord) => Promise<void>;
  /** Releases a settled task's pane and, once closed, its worktree. */
  settle: (taskId: string) => Promise<void>;
}>;

export type ReviewedRound = Readonly<{
  task: TaskRecord;
  state: PrReviewState;
  round: PrReviewRound;
}>;

export function createPrReviewWorkflow(deps: PrReviewDependencies) {
  const taskReview = new TaskReview(deps);
  const pages = new ReviewPages(deps, taskReview.reviewed);
  return {
    start: (input: StartPrReviewInput) => startPrReview(deps, input),
    show: pages.show,
    listen: pages.listen,
    openPages: pages.openPages,
    edit: taskReview.edit,
    submit: taskReview.submit,
    post: taskReview.post,
    again: taskReview.again,
    ask: taskReview.ask,
    close: taskReview.close,
  };
}

export type PrReviewWorkflow = ReturnType<typeof createPrReviewWorkflow>;

class TaskReview {
  private readonly receipts: ReturnType<typeof createReviewReceipts>;

  constructor(private readonly deps: PrReviewDependencies) {
    this.receipts = createReviewReceipts(deps);
  }

  readonly edit = async (taskId: string, edits: PrReviewEdits): Promise<ShowPrReviewResult> => {
    const { task, state, round } = await this.reviewed(taskId);
    if (round.posted !== undefined) {
      throw new Error(
        `This review was already posted at ${round.posted.url}; ask for a re-review instead.`,
      );
    }
    if (round.pendingPost !== undefined) {
      throw new Error("This review has an uncertain post; reconcile it before editing.");
    }
    const edited: PrReviewRound = {
      ...round,
      review: applyEdits(round.review, edits, await this.commentable(task.id, round)),
    };
    const next = replaceLatestRound(state, edited);
    await this.deps.updatePrReview(task, next);
    return { taskId: task.id, text: renderReviewText(next, edited) };
  };

  /**
   * Posts what the user chose on the page. The click on Submit is the user's approval, so this
   * posts without asking again; it still pins to the reviewed commit and refuses if the PR moved.
   * The exact submission is saved before posting; an uncertain outcome must be reconciled.
   */
  readonly submit = async (
    taskId: string,
    submission: ReviewSubmission,
    expected?: ReviewSubmissionBinding,
  ): Promise<PostPrReviewResult> => {
    const { task, state, round } = await this.reviewed(taskId);
    if (
      expected !== undefined &&
      (round.head !== expected.head ||
        round.generation !== expected.generation ||
        // Question follow-ups retain the same finished review; a re-review replaces it.
        (state.mode !== "question" && task.generation !== expected.generation))
    ) {
      throw new Error("The displayed PR review is stale; reopen the pane before submitting.");
    }
    if (round.posted !== undefined) {
      throw new Error(`This review was already posted at ${round.posted.url}.`);
    }
    if (round.pendingPost !== undefined) {
      return this.postResult(
        task.id,
        state.url,
        await this.receipts.publish({ task, state, round }, round.pendingPost.verdict),
      );
    }
    const review = applyEdits(
      {
        ...round.review,
        ...(submission.replies === undefined ? {} : { replies: submission.replies }),
      },
      submissionEdits(round.review, submission),
      await this.commentable(task.id, round),
    );
    return this.postResult(
      task.id,
      state.url,
      await this.receipts.publish({ task, state, round: { ...round, review } }, submission.verdict),
    );
  };

  readonly post = async (
    taskId: string,
    verdict: ReviewVerdict,
    approved: boolean,
    recovery?: ReviewPostRecovery,
  ): Promise<PostPrReviewResult> => {
    if (!approved) throw new ApprovalRequiredError("posting a PR review needs the user's approval");
    const reviewedRound = await this.reviewed(taskId);
    const result =
      recovery === undefined
        ? await this.receipts.publish(reviewedRound, verdict)
        : await this.receipts.recover(reviewedRound, verdict, recovery);
    return this.postResult(taskId, reviewedRound.state.url, result);
  };

  private async postResult(
    taskId: string,
    prUrl: string,
    result: ReceiptResult,
  ): Promise<PostPrReviewResult> {
    if (result.kind === "unconfirmed")
      return {
        taskId,
        posted: false,
        message: reviewPostFailure(prUrl, result.outcome, result.recovering),
      };
    const { state, round, posted } = postedRound(await this.deps.getTask(taskId), result.round);
    const count = round.replyPosts?.filter((reply) => reply.kind === "posted").length ?? 0;
    const notes = replyPostNotes(state.url, round);
    return {
      taskId,
      posted: true,
      url: posted.url,
      message: `${result.label}${count === 0 ? "" : ` with ${count} ${count === 1 ? "reply" : "replies"}`}: ${posted.url}${notes.length === 0 ? "" : `\n${notes.join("\n")}`}`,
    };
  }

  private async rerun(taskId: string, mode: PrReviewMode): Promise<TaskRecord> {
    const task = await this.deps.getTask(taskId);
    const state = reviewState(task);
    if (state.closed === true) throw new Error(`The review in task ${task.id} is closed.`);
    if (task.stage !== "completed") {
      throw new Error(`Task ${task.id} is ${task.stage}; wait for it to finish first.`);
    }
    const updated = await this.deps.updatePrReview(task, { ...state, mode });
    await this.deps.runAgain(updated);
    return this.deps.getTask(task.id);
  }

  readonly close = async (taskId: string): Promise<TaskRecord> => {
    const task = await this.deps.getTask(taskId);
    const state = reviewState(task);
    if (task.stage !== "completed" && task.stage !== "cancelled") {
      throw new Error(
        `Task ${task.id} is ${task.stage}; cancel it or wait for it to finish first.`,
      );
    }
    const updated =
      state.closed === true
        ? task
        : await this.deps.updatePrReview(task, { ...state, closed: true });
    await this.deps.settle(updated.id);
    return this.deps.getTask(task.id);
  };

  readonly reviewed = async (taskId: string): Promise<ReviewedRound> => {
    const task = await this.deps.getTask(taskId);
    const state = reviewState(task);
    const round = latestRound(state);
    if (round === undefined) throw new Error(`Task ${task.id} has no finished review yet.`);
    return { task, state, round };
  };

  /** New-side lines the round's diff can anchor a comment on. */
  private async commentable(
    taskId: string,
    round: PrReviewRound,
  ): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
    return commentableLines(
      await readFile(prReviewRunDiffPath(this.deps.home, taskId, round.generation), "utf8"),
    );
  }

  /** Reviews the author's new pushes, checking each of the user's earlier comments. */
  readonly again = async (taskId: string): Promise<TaskRecord> => this.rerun(taskId, "re-review");
  /** Sends a follow-up question already in the task inbox to the reviewer. */
  readonly ask = async (taskId: string): Promise<TaskRecord> => this.rerun(taskId, "question");
}
