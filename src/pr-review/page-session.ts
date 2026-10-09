import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { listenPresentation, openPresentation } from "../adapters/lavish.ts";
import { buildReviewPage, parseReviewSubmission } from "./page.ts";
import { readPageComment, readSubmissionText } from "./page-feedback.ts";
import { readPageSources, reviewPageInput } from "./page-input.ts";
import { renderReviewText, wantsPage } from "./render.ts";
import type {
  PrReviewDependencies,
  ReviewedRound,
  ReviewPageEvent,
  ShowPrReviewResult,
} from "./service.ts";
import { type PrReviewRound, prReviewRunDiffPath } from "./state.ts";

export class ReviewPages {
  /** Tasks whose review page this process opened and has not seen close. */
  private readonly openTasks = new Set<string>();

  constructor(
    private readonly deps: Pick<PrReviewDependencies, "home" | "run" | "openNativePage">,
    private readonly reviewed: (taskId: string) => Promise<ReviewedRound>,
  ) {}

  readonly openPages = (): readonly string[] => [...this.openTasks];

  readonly show = async (
    taskId: string,
    options: Readonly<{ page?: boolean }> = {},
  ): Promise<ShowPrReviewResult> => {
    const { task, state, round } = await this.reviewed(taskId);
    const text = renderReviewText(state, round);
    if (options.page !== true && !(options.page === undefined && wantsPage(round))) {
      return { taskId: task.id, text };
    }
    if (this.deps.openNativePage !== undefined) {
      await this.deps.openNativePage(task);
      return { taskId: task.id, text };
    }
    const patch = await readFile(
      prReviewRunDiffPath(this.deps.home, task.id, round.generation),
      "utf8",
    );
    const sources = await readPageSources(this.deps.run, state.checkout, round, patch);
    const path = this.pagePath(task.id, round);
    const filesPath = path.replace(/\.html$/u, ".files.json");
    const built = await buildReviewPage(
      reviewPageInput(state, round, patch, sources),
      basename(filesPath),
    );
    await mkdir(this.pageDirectory(task.id), { recursive: true, mode: 0o700 });
    await writeFile(filesPath, built.files, { mode: 0o600 });
    await writeFile(path, built.html, { mode: 0o600 });
    const opened = await openPresentation(this.deps.run, path, this.pageDirectory(task.id));
    this.openTasks.add(task.id);
    return {
      taskId: task.id,
      text,
      ...(opened.sessionUrl === undefined ? {} : { pageUrl: opened.sessionUrl }),
    };
  };

  /**
   * Waits for the open page's next feedback; `reply` is shown in the page first. Only the tagged
   * Submit control's prompt row counts as a submission; anything else typed there is a comment.
   */
  readonly listen = async (
    taskId: string,
    signal: AbortSignal,
    reply?: string,
  ): Promise<ReviewPageEvent> => {
    if (!this.openTasks.has(taskId)) return { kind: "closed" };
    const { task, round } = await this.reviewed(taskId);
    let observation: Awaited<ReturnType<typeof listenPresentation>>;
    try {
      observation = await listenPresentation(
        async (request) => {
          if (signal.aborted) throw new Error("review page listener stopped");
          return this.deps.run({ ...request, signal });
        },
        this.pagePath(task.id, round),
        this.pageDirectory(task.id),
        { agentReply: reply },
      );
    } catch (error) {
      if (signal.aborted) return { kind: "stopped" };
      this.openTasks.delete(task.id);
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    if (observation.terminal) this.openTasks.delete(task.id);
    const event = pageEvent(observation);
    if (event.kind === "closed") this.openTasks.delete(task.id);
    return event;
  };

  private pageDirectory(taskId: string): string {
    return join(this.deps.home, "pr-review", taskId);
  }

  private pagePath(taskId: string, round: PrReviewRound): string {
    return join(this.pageDirectory(taskId), `review-${round.generation}.html`);
  }
}

function pageEvent(observation: Awaited<ReturnType<typeof listenPresentation>>): ReviewPageEvent {
  const ended = observation.terminal;
  if (observation.status !== "feedback") {
    if (!ended && observation.status !== "browser_disconnected" && observation.status !== "error") {
      return { kind: "other", ended: false };
    }
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
