import { readGitText } from "../adapters/primitives.ts";
import type { Clock, CommandRunner, PullRequestMetadata, TaskRecord } from "../contracts.ts";
import { draftProgressDigest } from "../delivery/evidence.ts";
import {
  type DraftPublication,
  publishTaskDraft,
  pushPublishedTask,
  refreshTaskDraft,
} from "../delivery/pull-requests.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import { pullRequestPublished } from "../tasks/required-stages.ts";
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

type DraftRefreshStep = "digest" | "remote-refresh" | "record" | "open" | "push";

const TITLE_MAX_CHARS = 72;

/**
 * Opens a draft pull request when an implementation task becomes ready, then keeps it showing
 * current durable task state, and pushes ready work to a published pull request. It never blocks
 * durable work when the remote is unavailable; the next durable change retries.
 */
export class DraftRefreshWorkflow {
  readonly #deps: DraftRefreshDependencies;
  /** Durable-state digest of the draft body last published per task, to avoid redundant refreshes. */
  readonly #digests = new Map<string, string>();
  /** Task revision each ready task's draft was last attempted at, so a failure is one attempt. */
  readonly #openAttempts = new Map<string, number>();
  /** Task revision each ready task's push was last attempted at, so a failure is one attempt. */
  readonly #pushAttempts = new Map<string, number>();

  constructor(deps: DraftRefreshDependencies) {
    this.#deps = deps;
  }

  /** Records that the task's draft body was just published from this durable state. */
  published(task: TaskRecord): void {
    this.#digests.set(task.id, draftProgressDigest(task));
  }

  /**
   * Opens a draft for a ready implementation task that has no pull request. The draft is marked
   * unfinished and approves nothing; final publish and merge keep their own approvals. Answers
   * whether the task record changed.
   */
  async openWhenReady(task: TaskRecord): Promise<boolean> {
    if (task.kind !== "implementation" || task.stage !== "ready") return false;
    if (task.pullRequest !== undefined || task.worktree === undefined) return false;
    if (this.#openAttempts.get(task.id) === task.revision) return false;
    this.#openAttempts.set(task.id, task.revision);
    let publication: DraftPublication;
    try {
      publication = await publishTaskDraft({
        task,
        title: draftTitle(task.objective),
        base: task.target?.branch ?? (await defaultBranch(this.#deps.run, task.worktree.path)),
        approved: true,
        run: this.#deps.run,
      });
    } catch (error) {
      await this.recordFailure(task.id, "open", undefined, error);
      return false;
    }
    try {
      await this.#deps.recordPullRequest(task.id, task.revision, publication.pullRequest);
    } catch (error) {
      // The next attempt observes and adopts this pull request rather than opening another.
      await this.recordFailure(task.id, "record", publication.pullRequest.number, error);
      return false;
    }
    this.published(task);
    return true;
  }

  /**
   * Pushes a ready task's HEAD to its published pull request: Tandem, not the agent, pushes once
   * the task's required stages pass. Answers whether the task record changed.
   */
  async pushWhenReady(task: TaskRecord): Promise<boolean> {
    const recorded = task.pullRequest;
    if (task.kind !== "implementation" || task.stage !== "ready") return false;
    if (recorded === undefined || !pullRequestPublished(task)) return false;
    if (task.reviewHead === undefined || recorded.head === task.reviewHead) return false;
    if (this.#pushAttempts.get(task.id) === task.revision) return false;
    this.#pushAttempts.set(task.id, task.revision);
    let pushed: PullRequestMetadata | undefined;
    try {
      pushed = await pushPublishedTask({ task, run: this.#deps.run });
    } catch (error) {
      await this.recordFailure(task.id, "push", recorded.number, error);
      return false;
    }
    if (pushed === undefined || samePullRequest(pushed, recorded)) return false;
    try {
      await this.#deps.recordPullRequest(task.id, task.revision, pushed);
      return true;
    } catch (error) {
      await this.recordFailure(task.id, "record", pushed.number, error);
      return false;
    }
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
    pullRequestNumber: number | undefined,
    error: unknown,
  ): Promise<void> {
    await appendDiagnosticEvent(
      this.#deps.home,
      {
        event: "draft-refresh-failed",
        taskId,
        details: {
          step,
          errorClass: errorClassName(error),
          ...(pullRequestNumber === undefined ? {} : { pullRequest: pullRequestNumber }),
        },
      },
      this.#deps.clock,
    );
  }
}

/** The objective's first line, cut to a title-sized length. */
function draftTitle(objective: string): string {
  const line = objective.trim().split("\n")[0]?.trim() ?? "";
  return line.length <= TITLE_MAX_CHARS ? line : `${line.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

// ponytail: reads the clone's cached origin/HEAD; a clone without one gets a failed-open
// diagnostic, and the coordinator's draft action still works. Ask the remote if that shows up.
export async function defaultBranch(run: CommandRunner, cwd: string): Promise<string> {
  const ref = await readGitText(
    run,
    cwd,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    "default branch",
  );
  return ref.replace(/^origin\//u, "");
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
