import { realpath } from "node:fs/promises";
import type {
  Clock,
  CommandRunner,
  IdFactory,
  RequestBriefContent,
  RequestBriefRecord,
  RequestPlanningAnswer,
  RequestPlanningInterview,
  TaskRecord,
} from "../contracts.ts";
import { TaskStoreError } from "../tasks/store-errors.ts";
import {
  abandonRequestBriefRecord,
  addRequestPlanningQuestion,
  approveRequestBriefRecord,
  assertNotAbandoned,
  assertSafeRequestId,
  checkedRequestBriefContent,
  checkedRequestPlanningInterview,
  completeRequestPlanningInterview,
  decideRequestDispatch,
  openRequestForNewWork,
  type RequestApprovalState,
  RequestBriefError,
  type RequestPlanningQuestionInput,
  recordRequestPlanningAnswer,
  requestApprovalState,
  requestBriefDigests,
  reviseRequestBriefRecord,
  singlePendingApprovalId,
  tasksBlockedByRequest,
  withRequestReviewPane,
} from "./brief.ts";
import { renderRequestBriefMarkdown } from "./markdown.ts";
import {
  closeRequestBriefPane,
  projectRequestBriefPane,
  type RequestReviewPaneDependencies,
} from "./review-pane.ts";
import type { RequestBriefStore } from "./store.ts";

export type RequestBriefWorkflowDependencies = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly parentWorkspaceId: string | undefined;
  /** The Herdr pane the coordinator runs in; the review pane splits beside it when known. */
  readonly coordinatorPaneId: string | undefined;
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly store: RequestBriefStore;
  readonly listTasks: () => Promise<readonly TaskRecord[]>;
  /** The existing ownership-safe pause control; the workflow never stops work by itself. */
  readonly pauseTask: (taskId: string, reason: string) => Promise<void>;
  readonly idFactory: IdFactory;
}>;

/**
 * What an approver claims to be approving. `requestId` is optional: when omitted, approval
 * resolves to the one request whose brief is awaiting approval and fails closed when that is not
 * unambiguous. `briefRevision` and `contentDigest` stay required in every case — they are what
 * binds the approval to the exact text the approver saw, and a request can be redrafted at any
 * time by another call, so resolving them automatically could silently approve text nobody read.
 */
export type ApproveRequestBriefInput = Readonly<{
  readonly requestId?: string;
  readonly briefRevision: number;
  readonly contentDigest: string;
}>;

export type DraftRequestBriefInput = Readonly<{
  readonly repoPath: string;
  /** Omitted for a new request; supplied to revise an existing one. */
  readonly requestId?: string;
  readonly content: RequestBriefContent;
  /** False for a tiny in-chat fix, which keeps the same approval contract without a pane. */
  readonly reviewPane: boolean;
  /** Starts a durable implementation-planning interview on the created or revised request. */
  readonly startPlanningInterview?: boolean;
  /** Research whose findings led to this interview; retained for request provenance. */
  readonly researchTaskIds?: readonly string[];
}>;

/** Everything a caller needs to show the brief and act on it, read from durable state. */
export type RequestBriefView = Readonly<{
  readonly record: RequestBriefRecord;
  readonly approvalState: RequestApprovalState;
  readonly markdown: string;
  /** Tasks this call stopped because the agreement changed under them. */
  readonly pausedTaskIds: readonly string[];
}>;

export class RequestBriefWorkflow {
  readonly #deps: RequestBriefWorkflowDependencies;

  constructor(deps: RequestBriefWorkflowDependencies) {
    this.#deps = deps;
  }

  /**
   * Creates or revises a request, then projects its current draft. Work pauses whenever its request
   * cannot dispatch, including while an active planning interview awaits a decision.
   *
   * A pause or pane failure leaves the new revision durable and propagates. Redrafting the same
   * content is a no-op on the record and retries the pause and the projection, so a refused pause
   * surfaces instead of being swallowed and stays recoverable without a second revision.
   */
  async draft(input: DraftRequestBriefInput): Promise<RequestBriefView> {
    const content = checkedRequestBriefContent(input.content);
    const created = await this.#draftRecord(input, content);
    const pausedTaskIds = await this.#pauseWorkForRequest(created);
    const projected = input.reviewPane ? await this.#project(created) : created;
    return this.#view(projected, pausedTaskIds);
  }

  async addPlanningQuestion(
    requestId: string,
    input: RequestPlanningQuestionInput,
  ): Promise<RequestBriefRecord> {
    const current = await this.#require(requestId);
    return this.#deps.store.update(current.id, current.revision, (record) =>
      addRequestPlanningQuestion(
        record,
        input,
        `plan-${this.#deps.idFactory()}`,
        this.#deps.clock(),
      ),
    );
  }

  async recordPlanningAnswer(
    requestId: string,
    questionId: string,
    answer: RequestPlanningAnswer,
  ): Promise<Readonly<{ readonly record: RequestBriefRecord; readonly duplicate: boolean }>> {
    const current = await this.#require(requestId);
    const first = recordRequestPlanningAnswer(current, questionId, answer, this.#deps.clock());
    if (first.duplicate) return { record: current, duplicate: true };
    try {
      const updated = await this.#deps.store.update(
        current.id,
        current.revision,
        (record) =>
          recordRequestPlanningAnswer(record, questionId, answer, this.#deps.clock()).record,
      );
      return { record: updated, duplicate: false };
    } catch (error) {
      if (error instanceof TaskStoreError && error.code === "stale-revision") {
        const latest = await this.#require(requestId);
        const replay = recordRequestPlanningAnswer(latest, questionId, answer, this.#deps.clock());
        if (replay.duplicate) return { record: latest, duplicate: true };
      }
      throw error;
    }
  }

  async completePlanningInterview(requestId: string): Promise<RequestBriefView> {
    const current = await this.#require(requestId);
    const completed =
      current.planningInterview?.status === "complete"
        ? current
        : await this.#deps.store.update(current.id, current.revision, (record) =>
            completeRequestPlanningInterview(record, this.#deps.clock()),
          );
    const pausedTaskIds = await this.#pauseWorkForRequest(completed);
    return this.#view(completed, pausedTaskIds);
  }

  /** Reopens or refreshes the projection for the latest durable draft, proving ownership first. */
  async review(requestId: string): Promise<RequestBriefView> {
    const record = await this.#require(requestId);
    return this.#view(await this.#project(record), []);
  }

  /**
   * Records approval of one exact draft revision and then retires only the pane this request owns.
   * A pane that cannot be closed safely leaves the approval standing; approval is a conversation
   * decision, never a pane receipt.
   */
  async approve(intent: ApproveRequestBriefInput): Promise<RequestBriefView> {
    const requestId = intent.requestId ?? (await this.pendingApprovalId());
    const current = await this.#require(requestId);
    const approved = await this.#deps.store.update(current.id, current.revision, (record) =>
      approveRequestBriefRecord(
        record,
        { requestId, briefRevision: intent.briefRevision, contentDigest: intent.contentDigest },
        this.#deps.clock(),
      ),
    );
    const pane = await closeRequestBriefPane(this.#paneDependencies(), approved);
    if (pane === undefined) return this.#view(approved, []);
    const settled = await this.#deps.store.update(approved.id, approved.revision, (record) =>
      withRequestReviewPane(record, pane, this.#deps.clock()),
    );
    return this.#view(settled, []);
  }

  /**
   * Records that the user dropped a request whose brief was never approved, so it stops counting
   * as awaiting approval, then retires only the pane this request owns. The record and its history
   * stay; a pane that cannot be closed safely leaves the abandonment standing.
   */
  async abandon(requestId: string): Promise<RequestBriefView> {
    const current = await this.#require(requestId);
    const tasks = await this.#deps.listTasks();
    const abandoned = await this.#deps.store.update(current.id, current.revision, (record) =>
      abandonRequestBriefRecord(record, tasks, this.#deps.clock()),
    );
    const pane = await closeRequestBriefPane(this.#paneDependencies(), abandoned);
    if (pane === undefined) return this.#view(abandoned, []);
    const settled = await this.#deps.store.update(abandoned.id, abandoned.revision, (record) =>
      withRequestReviewPane(record, pane, this.#deps.clock()),
    );
    return this.#view(settled, []);
  }

  async read(requestId: string): Promise<RequestBriefView> {
    return this.#view(await this.#require(requestId), []);
  }

  /**
   * Whether work for one task may be dispatched. A task that names no request is governed by the
   * existing task-level approval alone and is left to it.
   */
  async dispatchDecisionForTask(
    task: Pick<TaskRecord, "requestId">,
  ): Promise<Readonly<{ readonly allowed: boolean; readonly reason: string }> | undefined> {
    if (task.requestId === undefined) return undefined;
    const record = await this.#require(task.requestId);
    const decision = decideRequestDispatch(record);
    return decision.allowed
      ? { allowed: true, reason: `approved brief revision ${decision.approvedRevision}` }
      : { allowed: false, reason: decision.reason };
  }

  /**
   * Stops scheduler advancement for a request-bound task until its brief can dispatch.
   * Pausing is ownership-safe through the injected task control.
   */
  async holdTaskForRequest(task: Pick<TaskRecord, "id" | "requestId" | "stage">): Promise<boolean> {
    if (task.requestId === undefined) return false;
    const record = await this.#require(task.requestId);
    const decision = decideRequestDispatch(record);
    if (decision.allowed) return false;
    if (tasksBlockedByRequest(record, [task]).includes(task.id)) {
      await this.#deps.pauseTask(task.id, this.#pauseReason(record));
    }
    return true;
  }

  /** Confirms a request exists before a task is bound to it, so no task points at nothing. */
  async requireRequest(requestId: string): Promise<RequestBriefRecord> {
    return this.#require(requestId);
  }

  /** The open approved request new implementation work in this repository joins, if any. */
  async openRequestForNewWork(
    repoPath: string,
    tasks: readonly Pick<TaskRecord, "requestId" | "stage">[],
  ): Promise<string | undefined> {
    const canonical = (path: string): Promise<string> => realpath(path).catch(() => path);
    const records = await Promise.all(
      (await this.#deps.store.list()).map(async (record) => ({
        ...record,
        repoPath: await canonical(record.repoPath),
      })),
    );
    return openRequestForNewWork(records, tasks, await canonical(repoPath), this.#deps.clock());
  }

  /** The one request whose brief is awaiting approval; fails closed when that is not unambiguous. */
  async pendingApprovalId(): Promise<string> {
    return singlePendingApprovalId(await this.#deps.store.list());
  }

  async #draftRecord(
    input: DraftRequestBriefInput,
    content: RequestBriefContent,
  ): Promise<RequestBriefRecord> {
    if (input.researchTaskIds !== undefined && input.startPlanningInterview !== true) {
      throw new RequestBriefError(
        "planning-interview-incomplete",
        "researchTaskIds require startPlanningInterview",
      );
    }
    const startInterview =
      input.startPlanningInterview === true
        ? initialPlanningInterview(input.researchTaskIds ?? [])
        : undefined;
    if (input.requestId === undefined) {
      return this.#deps.store.create({
        repoPath: input.repoPath,
        content,
        ...(startInterview === undefined ? {} : { planningInterview: startInterview }),
      });
    }
    const current = await this.#require(input.requestId);
    assertNotAbandoned(current);
    const finalContent =
      current.planningInterview?.status === "complete" &&
      current.draft.content.planningAnswers !== undefined
        ? checkedRequestBriefContent({
            ...content,
            planningAnswers: current.draft.content.planningAnswers,
          })
        : content;
    const contentChanged =
      requestBriefDigests(finalContent).contentDigest !== current.draft.contentDigest;
    const nextInterview =
      startInterview === undefined
        ? current.planningInterview
        : current.planningInterview === undefined
          ? startInterview
          : sameResearchTasks(current.planningInterview, startInterview)
            ? current.planningInterview
            : (() => {
                throw new RequestBriefError(
                  "planning-interview-incomplete",
                  `Request ${current.id} already has a planning interview`,
                  current.id,
                );
              })();
    if (!contentChanged && nextInterview === current.planningInterview) return current;
    return this.#deps.store.update(current.id, current.revision, (record) => {
      const revised = contentChanged
        ? reviseRequestBriefRecord(record, finalContent, this.#deps.clock())
        : { ...record, revision: record.revision + 1, updatedAt: this.#deps.clock() };
      return {
        ...revised,
        ...(nextInterview === undefined ? {} : { planningInterview: nextInterview }),
      };
    });
  }

  async #pauseWorkForRequest(record: RequestBriefRecord): Promise<readonly string[]> {
    const tasks = await this.#deps.listTasks();
    const taskIds = tasksBlockedByRequest(record, tasks);
    if (taskIds.length === 0 || decideRequestDispatch(record).allowed) return [];
    const paused: string[] = [];
    for (const taskId of taskIds) {
      await this.#deps.pauseTask(taskId, this.#pauseReason(record));
      paused.push(taskId);
    }
    return paused;
  }

  #pauseReason(record: RequestBriefRecord): string {
    const goal = record.draft.content.goal;
    return record.planningInterview?.status === "active"
      ? `Work on “${goal}” is paused until its planning interview is complete.`
      : `Work on “${goal}” is paused until the current brief is approved.`;
  }

  async #project(record: RequestBriefRecord): Promise<RequestBriefRecord> {
    const pane = await projectRequestBriefPane(this.#paneDependencies(), record);
    return this.#deps.store.update(record.id, record.revision, (stored) =>
      withRequestReviewPane(stored, pane, this.#deps.clock()),
    );
  }

  async #require(requestId: string): Promise<RequestBriefRecord> {
    assertSafeRequestId(requestId);
    const record = await this.#deps.store.read(requestId);
    if (record === undefined) {
      throw new RequestBriefError(
        "request-not-found",
        `Request ${requestId} does not exist`,
        requestId,
      );
    }
    return record;
  }

  #paneDependencies(): RequestReviewPaneDependencies {
    return {
      run: this.#deps.run,
      home: this.#deps.home,
      sessionId: this.#deps.sessionId,
      parentWorkspaceId: this.#deps.parentWorkspaceId,
      coordinatorPaneId: this.#deps.coordinatorPaneId,
      clock: this.#deps.clock,
    };
  }

  #view(record: RequestBriefRecord, pausedTaskIds: readonly string[]): RequestBriefView {
    return {
      record,
      approvalState: requestApprovalState(record),
      markdown: renderRequestBriefMarkdown(record),
      pausedTaskIds,
    };
  }
}

function initialPlanningInterview(researchTaskIds: readonly string[]): RequestPlanningInterview {
  return checkedRequestPlanningInterview({
    schemaVersion: 1,
    status: "active",
    researchTaskIds,
    questions: [],
  });
}

function sameResearchTasks(
  current: RequestPlanningInterview,
  requested: RequestPlanningInterview,
): boolean {
  return (
    current.status === "active" &&
    current.researchTaskIds.length === requested.researchTaskIds.length &&
    current.researchTaskIds.every((id, index) => id === requested.researchTaskIds[index])
  );
}
