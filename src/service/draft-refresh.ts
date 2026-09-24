import type { Clock, CommandRunner, PullRequestMetadata, TaskRecord } from "../contracts.ts";
import { draftProgressDigest } from "../delivery/evidence.ts";
import { type DraftPublication, refreshTaskDraft } from "../delivery/pull-requests.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import { errorClassName } from "./records.ts";

export type DraftRefreshDependencies = Readonly<{
  readonly home: string;
  readonly clock: Clock;
  readonly run: CommandRunner;
  readonly recordPullRequest: (
    taskId: string,
    expectedRevision: number,
    metadata: PullRequestMetadata,
  ) => Promise<TaskRecord>;
}>;

type DraftRefreshStep = "digest" | "remote-refresh" | "record";

/**
 * Keeps an already approved draft pull request showing current durable task state. It never
 * creates a pull request, never asks for a new approval, and never blocks durable work when the
 * remote is unavailable; the next durable change retries.
 */
export class DraftRefreshWorkflow {
  readonly #deps: DraftRefreshDependencies;
  /** Durable-state digest of the draft body last published per task, to avoid redundant refreshes. */
  readonly #digests = new Map<string, string>();

  constructor(deps: DraftRefreshDependencies) {
    this.#deps = deps;
  }

  /** Records that the task's draft body was just published from this durable state. */
  published(task: TaskRecord): void {
    this.#digests.set(task.id, draftProgressDigest(task));
  }

  /** Answers whether the task record changed. */
  async refresh(task: TaskRecord): Promise<boolean> {
    const recorded = task.pullRequest;
    if (recorded === undefined || recorded.state !== "draft") {
      this.#digests.delete(task.id);
      return false;
    }
    let digest: string;
    try {
      digest = draftProgressDigest(task);
    } catch (error) {
      await this.recordFailure(task.id, "digest", recorded.number, error);
      return false;
    }
    if (this.#digests.get(task.id) === digest) return false;
    // Consume this durable state before attempting it, so one failure is one bounded attempt and
    // one diagnostic rather than a per-tick retry loop against an unavailable remote.
    this.#digests.set(task.id, digest);

    let publication: DraftPublication | undefined;
    try {
      publication = await refreshTaskDraft({ task, run: this.#deps.run });
    } catch (error) {
      await this.recordFailure(task.id, "remote-refresh", recorded.number, error);
      return false;
    }
    if (publication === undefined || samePullRequest(publication.pullRequest, recorded)) {
      return false;
    }
    try {
      await this.#deps.recordPullRequest(task.id, task.revision, publication.pullRequest);
      return true;
    } catch (error) {
      await this.recordFailure(task.id, "record", publication.pullRequest.number, error);
      return false;
    }
  }

  /**
   * Makes a stale draft observable without letting observability change workflow behavior.
   * Details stay bounded: task id, pull request number, which step failed, and the error class
   * name. No message text, stdout, stderr, or command payload.
   */
  private async recordFailure(
    taskId: string,
    step: DraftRefreshStep,
    pullRequestNumber: number,
    error: unknown,
  ): Promise<void> {
    await appendDiagnosticEvent(
      this.#deps.home,
      {
        event: "draft-refresh-failed",
        taskId,
        details: { step, errorClass: errorClassName(error), pullRequest: pullRequestNumber },
      },
      this.#deps.clock,
    );
  }
}

function samePullRequest(left: PullRequestMetadata, right: PullRequestMetadata): boolean {
  return (
    left.repository === right.repository &&
    left.number === right.number &&
    left.state === right.state &&
    left.head === right.head &&
    left.base === right.base
  );
}
