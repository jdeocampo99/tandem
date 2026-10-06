import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { listenPresentation, openPresentation } from "../adapters/lavish.ts";
import { ApprovalRequiredError } from "../adapters/primitives.ts";
import type { Clock, CommandRunner, TaskRecord } from "../contracts.ts";
import { checkoutQuestion, findCheckout, type RepoLocation } from "../repos/locate.ts";
import { commentableLines } from "./diff.ts";
import { applyEdits, type PrReviewEdits, submissionEdits } from "./edits.ts";
import { buildReviewPage, parseReviewSubmission, type ReviewSubmission } from "./page.ts";
import { readPageComment, readSubmissionText } from "./page-feedback.ts";
import { readPageSources, reviewPageInput } from "./page-input.ts";
import { postReview, type ReviewVerdict, replyToComment, reviewMarker } from "./post.ts";
import {
  acknowledgement,
  findPullRequestRef,
  isRefusal,
  type PullRequestFacts,
  readPullRequest,
} from "./pull-request.ts";
import { renderReviewText, wantsPage } from "./render.ts";
import type { ReviewLens } from "./review.ts";
import {
  latestRound,
  lensLabel,
  type PrReviewMode,
  type PrReviewRound,
  type PrReviewState,
  prReviewRunDiffPath,
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
  /** Moves a completed review back to queued for another run, and starts it. */
  runAgain: (task: TaskRecord) => Promise<void>;
  /** Releases a settled task's pane and, once closed, its worktree. */
  settle: (taskId: string) => Promise<void>;
}>;

export function createPrReviewWorkflow(deps: PrReviewDependencies) {
  /** Tasks whose review page this process opened and has not seen close. */
  const openPages = new Set<string>();

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
    if (deps.openNativePage !== undefined) {
      await deps.openNativePage(task);
      return { taskId: task.id, text };
    }
    const patch = await readFile(prReviewRunDiffPath(deps.home, task.id, round.generation), "utf8");
    const sources = await readPageSources(deps.run, state.checkout, round, patch);
    const path = pagePath(task.id, round);
    const filesPath = path.replace(/\.html$/u, ".files.json");
    const built = await buildReviewPage(
      reviewPageInput(state, round, patch, sources),
      basename(filesPath),
    );
    await mkdir(pageDirectory(task.id), { recursive: true, mode: 0o700 });
    await writeFile(filesPath, built.files, { mode: 0o600 });
    await writeFile(path, built.html, { mode: 0o600 });
    const opened = await openPresentation(deps.run, path, pageDirectory(task.id));
    openPages.add(task.id);
    return {
      taskId: task.id,
      text,
      ...(opened.sessionUrl === undefined ? {} : { pageUrl: opened.sessionUrl }),
    };
  }

  /**
   * Waits for the open page's next feedback; `reply` is shown in the page first. Only the tagged
   * Submit control's prompt row counts as a submission; anything else typed there is a comment.
   */
  async function listen(
    taskId: string,
    signal: AbortSignal,
    reply?: string,
  ): Promise<ReviewPageEvent> {
    if (!openPages.has(taskId)) return { kind: "closed" };
    const { task, round } = await reviewed(taskId);
    let observation: Awaited<ReturnType<typeof listenPresentation>>;
    try {
      observation = await listenPresentation(
        async (request) => {
          if (signal.aborted) throw new Error("review page listener stopped");
          return deps.run({ ...request, signal });
        },
        pagePath(task.id, round),
        pageDirectory(task.id),
        { agentReply: reply },
      );
    } catch (error) {
      if (signal.aborted) return { kind: "stopped" };
      openPages.delete(task.id);
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    const ended = observation.terminal;
    if (ended) openPages.delete(task.id);
    if (observation.status !== "feedback") {
      if (
        !ended &&
        observation.status !== "browser_disconnected" &&
        observation.status !== "error"
      ) {
        return { kind: "other", ended: false };
      }
      openPages.delete(task.id);
      return { kind: "closed" };
    }
    const submitted = readSubmissionText(observation.rawFeedback);
    if (submitted !== undefined) {
      const parsed = parseReviewSubmission(submitted);
      return parsed.ok
        ? { kind: "submission", submission: parsed.submission, ended }
        : { kind: "invalid", problems: parsed.problems, ended };
    }
    const comment = readPageComment(observation.rawFeedback);
    return comment === undefined
      ? { kind: "other", ended }
      : { kind: "comment", text: comment, ended };
  }

  async function edit(taskId: string, edits: PrReviewEdits): Promise<ShowPrReviewResult> {
    const { task, state, round } = await reviewed(taskId);
    if (round.posted !== undefined) {
      throw new Error(
        `This review was already posted at ${round.posted.url}; ask for a re-review instead.`,
      );
    }
    const edited: PrReviewRound = {
      ...round,
      review: applyEdits(round.review, edits, await commentable(task.id, round)),
    };
    const next = replaceLatestRound(state, edited);
    await deps.updatePrReview(task, next);
    return { taskId: task.id, text: renderReviewText(next, edited) };
  }

  /**
   * Posts what the user chose on the page. The click on Submit is the user's approval, so this
   * posts without asking again; it still pins to the reviewed commit and refuses if the PR moved.
   * Nothing is saved unless the post lands, so a refused submission can be sent again.
   */
  async function submit(taskId: string, submission: ReviewSubmission): Promise<PostPrReviewResult> {
    const { task, state, round } = await reviewed(taskId);
    if (round.posted !== undefined) {
      throw new Error(`This review was already posted at ${round.posted.url}.`);
    }
    const review = applyEdits(
      round.review,
      submissionEdits(round.review, submission),
      await commentable(task.id, round),
    );
    return publish(task, state, { ...round, review }, submission.verdict);
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
    return publish(task, state, round, verdict);
  }

  /** Posts the round as given and, once GitHub has it, saves the round as posted. */
  async function publish(
    task: TaskRecord,
    state: PrReviewState,
    round: PrReviewRound,
    verdict: ReviewVerdict,
  ): Promise<PostPrReviewResult> {
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

  /** New-side lines the round's diff can anchor a comment on. */
  async function commentable(
    taskId: string,
    round: PrReviewRound,
  ): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
    return commentableLines(
      await readFile(prReviewRunDiffPath(deps.home, taskId, round.generation), "utf8"),
    );
  }

  function pageDirectory(taskId: string): string {
    return join(deps.home, "pr-review", taskId);
  }

  function pagePath(taskId: string, round: PrReviewRound): string {
    return join(pageDirectory(taskId), `review-${round.generation}.html`);
  }

  return {
    start,
    show,
    listen,
    openPages: (): readonly string[] => [...openPages],
    edit,
    submit,
    post,
    again,
    ask,
    close,
  };
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
