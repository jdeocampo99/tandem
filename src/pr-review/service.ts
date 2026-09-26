import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openPresentation, pollPresentation } from "../adapters/lavish.ts";
import { ApprovalRequiredError } from "../adapters/primitives.ts";
import type { Clock, CommandRunner, TaskRecord } from "../contracts.ts";
import { checkoutQuestion, findCheckout, type RepoLocation } from "../repos/locate.ts";
import { postReview, type ReviewVerdict, replyToComment, reviewMarker } from "./post.ts";
import {
  acknowledgement,
  findPullRequestRef,
  isRefusal,
  type PullRequestFacts,
  readPullRequest,
} from "./pull-request.ts";
import { renderReviewHtml, renderReviewText, wantsPage } from "./render.ts";
import type { CommentSeverity, ReviewLens } from "./review.ts";
import {
  latestRound,
  lensLabel,
  type PrReviewMode,
  type PrReviewRound,
  type PrReviewState,
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

export type CommentEdit = Readonly<{
  id: string;
  body?: string | undefined;
  severity?: CommentSeverity | undefined;
  drop?: boolean | undefined;
}>;

export type PrReviewEdits = Readonly<{
  comments?: readonly CommentEdit[];
  summaryComment?: string;
}>;

export type PostPrReviewResult = Readonly<{
  taskId: string;
  posted: boolean;
  message: string;
  url?: string;
}>;

/** What the review workflow needs from the task service; everything else it does itself. */
export type PrReviewDependencies = Readonly<{
  home: string;
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
  /** Moves a completed review back to queued for another run, and starts it. */
  runAgain: (task: TaskRecord) => Promise<void>;
  /** Releases a settled task's pane and, once closed, its worktree. */
  settle: (taskId: string) => Promise<void>;
}>;

export function createPrReviewWorkflow(deps: PrReviewDependencies) {
  async function start(input: StartPrReviewInput): Promise<StartPrReviewResult> {
    const ref = findPullRequestRef(input.pullRequest);
    if (ref === undefined) {
      return { kind: "refused", message: "That doesn't look like a GitHub pull request link." };
    }
    const existing = (await deps.listTasks()).find(
      (task) =>
        task.prReview !== undefined &&
        task.prReview.closed !== true &&
        task.stage !== "cancelled" &&
        task.prReview.ref.repo === ref.repo &&
        task.prReview.ref.number === ref.number,
    );
    if (existing !== undefined) {
      return {
        kind: "existing",
        taskId: existing.id,
        message: `I'm already reviewing ${ref.repo}#${ref.number} as task ${existing.id}. Ask for a re-review to look at new pushes.`,
      };
    }
    const facts = await readPullRequest(deps.run, ref, deps.home);
    if (isRefusal(facts)) return facts;
    const location = await findCheckout(ref.repo, input, {
      home: deps.home,
      run: deps.run,
      clock: deps.clock,
      roots: await deps.projectRoots(),
    });
    if (location.kind !== "found") {
      return {
        kind: "needs-location",
        repo: ref.repo,
        paths: location.kind === "ambiguous" ? location.paths : [],
        message: checkoutQuestion(ref.repo, location, input.checkout),
        nextStep:
          "Ask the user this, then call review-pr again with checkout set to their path, or clone true if they say to clone it.",
      };
    }
    const lens = input.lens ?? { kind: "full" };
    const task = await deps.createTask({
      repoPath: input.repoPath,
      objective: `Review ${ref.repo}#${ref.number}: ${facts.title || "pull request"}`,
      prReview: stateFor(facts, location, lens),
    });
    const label = lensLabel(lens);
    return { kind: "started", taskId: task.id, message: acknowledgement(facts, label) };
  }

  async function show(
    taskId: string,
    options: Readonly<{ page?: boolean }> = {},
  ): Promise<ShowPrReviewResult> {
    const { task, state, round } = await reviewed(taskId);
    const text = renderReviewText(state, round);
    if (options.page !== true && !(options.page === undefined && wantsPage(round))) {
      return { taskId: task.id, text };
    }
    const path = pagePath(task.id, round);
    await mkdir(join(deps.home, "pr-review", task.id), { recursive: true, mode: 0o700 });
    await writeFile(path, renderReviewHtml(state, round), { mode: 0o600 });
    const opened = await openPresentation(deps.run, path, join(deps.home, "pr-review", task.id));
    return {
      taskId: task.id,
      text,
      ...(opened.sessionUrl === undefined ? {} : { pageUrl: opened.sessionUrl }),
    };
  }

  /** Notes the user left on the review page, raw, for the coordinator to turn into edits. */
  async function notes(taskId: string): Promise<Readonly<{ taskId: string; feedback: string }>> {
    const { task, round } = await reviewed(taskId);
    const observed = await pollPresentation(
      deps.run,
      pagePath(task.id, round),
      join(deps.home, "pr-review", task.id),
    );
    return { taskId: task.id, feedback: observed.rawFeedback };
  }

  async function edit(taskId: string, edits: PrReviewEdits): Promise<ShowPrReviewResult> {
    const { task, state, round } = await reviewed(taskId);
    if (round.posted !== undefined) {
      throw new Error(
        `This review was already posted at ${round.posted.url}; ask for a re-review instead.`,
      );
    }
    const byId = new Map((edits.comments ?? []).map((change) => [change.id, change]));
    const unknown = [...byId.keys()].filter(
      (id) => !round.review.comments.some((comment) => comment.id === id),
    );
    if (unknown.length > 0) throw new Error(`No draft comment with id ${unknown.join(", ")}`);
    const comments = round.review.comments.flatMap((comment) => {
      const change = byId.get(comment.id);
      if (change === undefined) return [comment];
      if (change.drop === true) return [];
      return [
        {
          ...comment,
          ...(change.body === undefined ? {} : { body: nonEmpty(change.body, "comment body") }),
          ...(change.severity === undefined ? {} : { severity: change.severity }),
        },
      ];
    });
    const edited: PrReviewRound = {
      ...round,
      review: {
        ...round.review,
        comments,
        ...(edits.summaryComment === undefined
          ? {}
          : { summaryComment: edits.summaryComment.trim() }),
      },
    };
    const next = replaceLatestRound(state, edited);
    await deps.updatePrReview(task, next);
    return { taskId: task.id, text: renderReviewText(next, edited) };
  }

  async function post(
    taskId: string,
    verdict: ReviewVerdict,
    approved: boolean,
  ): Promise<PostPrReviewResult> {
    if (!approved) throw new ApprovalRequiredError("posting a PR review needs the user's approval");
    const { task, state, round } = await reviewed(taskId);
    if (round.posted !== undefined) {
      return {
        taskId: task.id,
        posted: true,
        url: round.posted.url,
        message: `Already posted: ${round.posted.url}`,
      };
    }
    const outcome = await postReview(deps.run, {
      ref: state.ref,
      review: round.review,
      verdict,
      marker: reviewMarker(task.id, round.generation),
      cwd: state.checkout,
    });
    if (outcome.kind === "moved") {
      return {
        taskId: task.id,
        posted: false,
        message: `The PR moved to ${outcome.head.slice(0, 12)} since this review, so the comments could land on the wrong lines. Ask for a re-review first.`,
      };
    }
    if (outcome.kind === "failed") {
      return {
        taskId: task.id,
        posted: false,
        message: `GitHub didn't take the review: ${outcome.message}`,
      };
    }
    const replies = await postReplies(state, round);
    await deps.updatePrReview(
      task,
      replaceLatestRound(state, {
        ...round,
        posted: { url: outcome.url, verdict, postedAt: deps.clock() },
      }),
    );
    return {
      taskId: task.id,
      posted: true,
      url: outcome.url,
      message: `Posted ${round.review.comments.length} comment${round.review.comments.length === 1 ? "" : "s"}${replies === 0 ? "" : ` and ${replies} ${replies === 1 ? "reply" : "replies"}`}: ${outcome.url}`,
    };
  }

  /** Short replies on earlier threads the author addressed; a failed reply never blocks the review. */
  async function postReplies(state: PrReviewState, round: PrReviewRound): Promise<number> {
    let posted = 0;
    for (const prior of round.review.priorComments) {
      if (prior.status !== "addressed" || prior.reply === undefined) continue;
      const ok = await replyToComment(deps.run, {
        ref: state.ref,
        commentId: prior.commentId,
        body: prior.reply,
        cwd: state.checkout,
      });
      if (ok) posted += 1;
    }
    return posted;
  }

  /** Reviews the author's new pushes, checking each of the user's earlier comments. */
  async function again(taskId: string): Promise<TaskRecord> {
    return rerun(taskId, "re-review");
  }

  /** Sends a follow-up question already in the task inbox to the reviewer. */
  async function ask(taskId: string): Promise<TaskRecord> {
    return rerun(taskId, "question");
  }

  async function rerun(taskId: string, mode: PrReviewMode): Promise<TaskRecord> {
    const task = await deps.getTask(taskId);
    const state = requireState(task);
    if (state.closed === true) throw new Error(`The review in task ${task.id} is closed.`);
    if (task.stage !== "completed") {
      throw new Error(`Task ${task.id} is ${task.stage}; wait for it to finish first.`);
    }
    const updated = await deps.updatePrReview(task, { ...state, mode });
    await deps.runAgain(updated);
    return deps.getTask(task.id);
  }

  async function close(taskId: string): Promise<TaskRecord> {
    const task = await deps.getTask(taskId);
    const state = requireState(task);
    if (task.stage !== "completed" && task.stage !== "cancelled") {
      throw new Error(
        `Task ${task.id} is ${task.stage}; cancel it or wait for it to finish first.`,
      );
    }
    const updated =
      state.closed === true ? task : await deps.updatePrReview(task, { ...state, closed: true });
    await deps.settle(updated.id);
    return deps.getTask(task.id);
  }

  async function reviewed(
    taskId: string,
  ): Promise<{ task: TaskRecord; state: PrReviewState; round: PrReviewRound }> {
    const task = await deps.getTask(taskId);
    const state = requireState(task);
    const round = latestRound(state);
    if (round === undefined) throw new Error(`Task ${task.id} has no finished review yet.`);
    return { task, state, round };
  }

  function pagePath(taskId: string, round: PrReviewRound): string {
    return join(deps.home, "pr-review", taskId, `review-${round.generation}.html`);
  }

  return { start, show, notes, edit, post, again, ask, close };
}

export type PrReviewWorkflow = ReturnType<typeof createPrReviewWorkflow>;

function stateFor(
  facts: PullRequestFacts,
  location: Extract<RepoLocation, { kind: "found" }>,
  lens: ReviewLens,
): PrReviewState {
  return {
    ref: facts.ref,
    url: facts.url,
    title: facts.title,
    author: facts.author,
    baseRef: facts.baseRef,
    checkout: location.path,
    remote: location.remote,
    lens,
    mode: "review",
    rounds: [],
  };
}

function replaceLatestRound(state: PrReviewState, round: PrReviewRound): PrReviewState {
  return { ...state, rounds: [...state.rounds.slice(0, -1), round] };
}

function requireState(task: TaskRecord): PrReviewState {
  if (task.prReview === undefined) throw new Error(`Task ${task.id} is not a PR review.`);
  return task.prReview;
}

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be empty`);
  return trimmed;
}
