import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { listenPresentation, openPresentation } from "../adapters/lavish.ts";
import { ApprovalRequiredError } from "../adapters/primitives.ts";
import type { Clock, CommandRunner, TaskRecord } from "../contracts.ts";
import { readNativeThreads } from "../pr-watch/native-cache.ts";
import { checkoutQuestion, findCheckout, type RepoLocation } from "../repos/locate.ts";
import { commentableLines } from "./diff.ts";
import { applyEdits, type PrReviewEdits, submissionEdits } from "./edits.ts";
import { buildReviewPage, parseReviewSubmission, type ReviewSubmission } from "./page.ts";
import { readPageComment, readSubmissionText } from "./page-feedback.ts";
import { readPageSources, reviewPageInput } from "./page-input.ts";
import {
  findPostedReview,
  postReview,
  type ReviewVerdict,
  replyToComment,
  reviewMarker,
} from "./post.ts";
import {
  acknowledgement,
  findPullRequestRef,
  isRefusal,
  type PullRequestFacts,
  readPullRequest,
} from "./pull-request.ts";
import { renderReviewText, replyPostNotes, uncertainPostMessage, wantsPage } from "./render.ts";
import { validateThreadReplies } from "./replies.ts";
import { createReplyPosting } from "./reply-posting.ts";
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

export function createPrReviewWorkflow(deps: PrReviewDependencies) {
  /** Tasks whose review page this process opened and has not seen close. */
  const openPages = new Set<string>();
  const replyPosting = createReplyPosting(deps);

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
    if (round.pendingPost !== undefined) {
      throw new Error("This review has an uncertain post; reconcile it before editing.");
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
   * The exact submission is saved before posting; an uncertain outcome must be reconciled.
   */
  async function submit(
    taskId: string,
    submission: ReviewSubmission,
    expected?: ReviewSubmissionBinding,
  ): Promise<PostPrReviewResult> {
    const { task, state, round } = await reviewed(taskId);
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
      return publish(task, state, round, round.pendingPost.verdict);
    }
    const review = applyEdits(
      {
        ...round.review,
        ...(submission.replies === undefined ? {} : { replies: submission.replies }),
      },
      submissionEdits(round.review, submission),
      await commentable(task.id, round),
    );
    return publish(task, state, { ...round, review }, submission.verdict);
  }

  async function post(
    taskId: string,
    verdict: ReviewVerdict,
    approved: boolean,
    recovery?: ReviewPostRecovery,
  ): Promise<PostPrReviewResult> {
    if (!approved) throw new ApprovalRequiredError("posting a PR review needs the user's approval");
    const { task, state, round } = await reviewed(taskId);
    if (recovery !== undefined) {
      if (!Number.isSafeInteger(recovery.taskRevision) || task.revision !== recovery.taskRevision) {
        throw new Error(
          "The review changed since you checked it; inspect it again before confirming recovery.",
        );
      }
      if (recovery.kind === "post-reply-again" || recovery.kind === "mark-reply-posted") {
        const index = recovery.replyIndex;
        if (
          round.posted === undefined ||
          !Number.isSafeInteger(index) ||
          index < 0 ||
          round.review.replies?.[index] === undefined
        )
          throw new Error("Recovery must name a saved reply on a posted review.");
        if (verdict !== round.posted.verdict)
          throw new Error("Recovery must keep the saved review verdict.");
        if (round.replyPosts?.find((post) => post.index === index)?.kind === "posted")
          throw new Error("This reply already has a posted receipt.");
        if (recovery.kind === "mark-reply-posted") {
          await replyPosting.markPosted(
            task,
            round,
            index,
            confirmedReviewUrl(recovery.url, state, true),
          );
        } else {
          await replyPosting.attempt(task.id, round, index, true, recovery.taskRevision);
        }
        return postedResult(task.id, round, "Saved review posted");
      }
      if (round.pendingPost === undefined)
        throw new Error("This review has no uncertain post to recover.");
      if (verdict !== round.pendingPost.verdict)
        throw new Error("Recovery must keep the saved review verdict and choices.");
      if (recovery.kind === "post-again") {
        // The saved attempt remains durable until preflight succeeds and a fresh attempt is saved.
        const { pendingPost: _pendingPost, ...retry } = round;
        return publish(task, state, retry, verdict, true);
      }
      const url = confirmedReviewUrl(recovery.url, state);
      const { pendingPost: _pendingPost, ...confirmed } = round;
      await deps.updatePrReview(
        task,
        replaceLatestRound(state, {
          ...confirmed,
          posted: { url, verdict, postedAt: deps.clock(), confirmedByUser: true },
        }),
      );
      return postedResult(
        task.id,
        round,
        "Marked your saved review as posted using the link you confirmed",
      );
    }
    if (round.posted !== undefined) {
      await replyPosting.reconcile(task.id, round);
      return postedResult(task.id, round, "Already posted");
    }
    return publish(task, state, round, verdict);
  }

  /** Records the submitted round before posting, then saves or reconciles its receipt. */
  async function publish(
    task: TaskRecord,
    state: PrReviewState,
    round: PrReviewRound,
    verdict: ReviewVerdict,
    recovering = false,
  ): Promise<PostPrReviewResult> {
    if (round.pendingPost === undefined && round.review.replies?.length) {
      validateThreadReplies(
        round.review.replies,
        await readNativeThreads(deps.run, state.ref, state.checkout, round.head),
      );
    }
    const input = {
      ref: state.ref,
      review: round.review,
      verdict: round.pendingPost?.verdict ?? verdict,
      marker: reviewMarker(task.id, round.generation),
      cwd: state.checkout,
    };
    const outcome =
      round.pendingPost === undefined
        ? await postReview(deps.run, input, async () => {
            // The revision-checked update is the exclusive claim. A losing caller never POSTs.
            await deps.updatePrReview(
              task,
              replaceLatestRound(state, {
                ...round,
                pendingPost: { verdict, attemptedAt: deps.clock() },
              }),
            );
          })
        : await findPostedReview(deps.run, input);
    if (
      outcome.kind === "absent" ||
      outcome.kind === "unreadable" ||
      outcome.kind === "uncertain"
    ) {
      return {
        taskId: task.id,
        posted: false,
        message: uncertainPostMessage(
          state.url,
          outcome.kind === "absent"
            ? "GitHub has not returned the saved marker yet."
            : outcome.message,
        ),
      };
    }
    if (outcome.kind === "moved") {
      return {
        taskId: task.id,
        posted: false,
        message: recovering
          ? uncertainPostMessage(
              state.url,
              `A new post was refused because the PR moved to ${outcome.head.slice(0, 12)}.`,
            )
          : `The PR moved to ${outcome.head.slice(0, 12)} since this review, so the comments could land on the wrong lines. Ask for a re-review first.`,
      };
    }
    if (outcome.kind === "failed") {
      return {
        taskId: task.id,
        posted: false,
        message: recovering
          ? uncertainPostMessage(state.url, `A new post was refused: ${outcome.message}`)
          : `The review was not sent: ${outcome.message}`,
      };
    }
    const postedAt = deps.clock();
    const settled = await deps.mutatePrReview(task.id, (current) => {
      const live = requireState(current);
      const index = live.rounds.findIndex(
        (candidate) => candidate.generation === round.generation && candidate.head === round.head,
      );
      const saved = live.rounds[index];
      if (
        live.ref.repo !== state.ref.repo ||
        live.ref.number !== state.ref.number ||
        saved === undefined
      ) {
        throw new Error(`The posted review round changed; check the PR: ${outcome.url}`);
      }
      if (saved.posted !== undefined) return live;
      const { pendingPost, ...confirmed } = saved;
      return {
        ...live,
        rounds: live.rounds.map((candidate, i) =>
          i === index
            ? {
                ...confirmed,
                posted: {
                  url: outcome.url,
                  verdict: pendingPost?.verdict ?? input.verdict,
                  postedAt,
                },
              }
            : candidate,
        ),
      };
    });
    const confirmedState = requireState(settled.task);
    const confirmed = confirmedState.rounds.find(
      (candidate) => candidate.generation === round.generation && candidate.head === round.head,
    );
    if (confirmed?.posted === undefined) throw new Error("The review receipt was not saved.");
    // Only the caller recording the review receipt initiates the selected reply effects.
    if (settled.changed) await postReplies(task.id, confirmedState, confirmed);
    else await replyPosting.reconcile(task.id, confirmed);
    return postedResult(
      task.id,
      confirmed,
      `Posted ${confirmed.review.comments.length} comment${confirmed.review.comments.length === 1 ? "" : "s"}`,
    );
  }

  async function postedResult(
    taskId: string,
    binding: PrReviewRound,
    label: string,
  ): Promise<PostPrReviewResult> {
    const current = await deps.getTask(taskId);
    const state = requireState(current);
    const round = state.rounds.find(
      (candidate) => candidate.generation === binding.generation && candidate.head === binding.head,
    );
    if (round?.posted === undefined) throw new Error("The review receipt was not saved.");
    const count = round.replyPosts?.filter((post) => post.kind === "posted").length ?? 0;
    const notes = replyPostNotes(state.url, round);
    return {
      taskId,
      posted: true,
      url: round.posted.url,
      message: `${label}${count === 0 ? "" : ` with ${count} ${count === 1 ? "reply" : "replies"}`}: ${round.posted.url}${notes.length === 0 ? "" : `\n${notes.join("\n")}`}`,
    };
  }

  /** The review receipt is saved first; each native reply claims and settles its own effect. */
  async function postReplies(
    taskId: string,
    state: PrReviewState,
    round: PrReviewRound,
  ): Promise<void> {
    for (const index of (round.review.replies ?? []).keys())
      await replyPosting.attempt(taskId, round, index, true);
    for (const prior of round.review.priorComments) {
      if (prior.status !== "addressed" || prior.reply === undefined) continue;
      await replyToComment(deps.run, {
        ref: state.ref,
        commentId: prior.commentId,
        body: prior.reply,
        cwd: state.checkout,
      });
    }
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

function confirmedReviewUrl(value: string, state: PrReviewState, reply = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Use the GitHub review link you checked on this PR.");
  }
  if (
    url.origin !== "https://github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.pathname.toLowerCase() !== `/${state.ref.repo}/pull/${state.ref.number}`.toLowerCase() ||
    !(reply ? /^#discussion_r[1-9][0-9]*$/u : /^#pullrequestreview-[1-9][0-9]*$/u).test(url.hash)
  )
    throw new Error(
      `Use a GitHub ${reply ? "reply" : "review"} link for this same PR, including its ${reply ? "discussion" : "review"} anchor.`,
    );
  return url.href;
}
