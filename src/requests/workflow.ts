import { realpath } from "node:fs/promises";
import type { Clock, RequestBriefContent, RequestBriefRecord, TaskRecord } from "../contracts.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import {
  abandonRequestBriefRecord,
  approveRequestBriefRecord,
  assertNotAbandoned,
  assertSafeRequestId,
  checkedRequestBriefContent,
  decideRequestDispatch,
  openRequestForNewWork,
  type RequestApprovalState,
  RequestBriefError,
  requestApprovalState,
  requestBriefDigests,
  reviseRequestBriefRecord,
  singlePendingApprovalId,
  tasksAwaitingReapproval,
  withRequestReviewPane,
} from "./brief.ts";
import { renderRequestBriefMarkdown } from "./markdown.ts";
import type { BriefLanguageChecker } from "./plain-language.ts";
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
  readonly terminal: TerminalBackend;
  readonly clock: Clock;
  readonly store: RequestBriefStore;
  readonly listTasks: () => Promise<readonly TaskRecord[]>;
  /** The existing ownership-safe pause control; the workflow never stops work by itself. */
  readonly pauseTask: (taskId: string, reason: string) => Promise<void>;
  /** Advises on the top of a new draft; it never blocks one. */
  readonly checkLanguage: BriefLanguageChecker;
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
  readonly agreementDigest?: string;
}>;

export type DraftRequestBriefInput = Readonly<{
  readonly repoPath: string;
  /** Omitted for a new request; supplied to revise an existing one. */
  readonly requestId?: string;
  readonly content: RequestBriefContent;
  /** False for a tiny in-chat fix, which keeps the same approval contract without a pane. */
  readonly reviewPane: boolean;
}>;

/** Everything a caller needs to show the brief and act on it, read from durable state. */
export type RequestBriefView = Readonly<{
  readonly record: RequestBriefRecord;
  readonly approvalState: RequestApprovalState;
  readonly markdown: string;
  /** Tasks this call stopped because the agreement changed under them. */
  readonly pausedTaskIds: readonly string[];
  /** Sections of a new draft that may not read plainly; empty on every other call. */
  readonly plainLanguage: readonly string[];
}>;

export class RequestBriefWorkflow {
  readonly #deps: RequestBriefWorkflowDependencies;

  constructor(deps: RequestBriefWorkflowDependencies) {
    this.#deps = deps;
  }

  /**
   * Creates a request or advances its draft, then brings the owned projection up to date. An
   * agreement change makes the prior approval non-current and pauses the work running under it
   * before returning, so nothing keeps building against a brief the user has moved on from.
   *
   * A pause or pane failure leaves the new revision durable and propagates. Redrafting the same
   * content is a no-op on the record and retries the pause and the projection, so a refused pause
   * surfaces instead of being swallowed and stays recoverable without a second revision.
   */
  async draft(input: DraftRequestBriefInput): Promise<RequestBriefView> {
    const content = checkedRequestBriefContent(input.content);
    const created = await this.#draftRecord(input, content);
    const pausedTaskIds = await this.#pauseWorkAwaitingReapproval(created);
    const projected = input.reviewPane ? await this.#project(created) : created;
    return {
      ...this.#view(projected, pausedTaskIds),
      plainLanguage: await this.#deps.checkLanguage(content),
    };
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
      approveRequestBriefRecord(record, { ...intent, requestId }, this.#deps.clock()),
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

  /** Retires an owned review projection after feedback, without approving or changing the draft. */
  async closeReview(requestId: string, briefRevision: number): Promise<RequestBriefView> {
    const current = await this.#require(requestId);
    if (current.draft.revision !== briefRevision) return this.#view(current, []);
    const pane = await closeRequestBriefPane(this.#paneDependencies(), current);
    if (pane === undefined) return this.#view(current, []);
    const settled = await this.#deps.store.update(current.id, current.revision, (record) =>
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
    if (input.requestId === undefined) {
      return this.#deps.store.create({ repoPath: input.repoPath, content });
    }
    const current = await this.#require(input.requestId);
    assertNotAbandoned(current);
    if (requestBriefDigests(content).contentDigest === current.draft.contentDigest) return current;
    return this.#deps.store.update(current.id, current.revision, (record) =>
      reviseRequestBriefRecord(record, content, this.#deps.clock()),
    );
  }

  async #pauseWorkAwaitingReapproval(record: RequestBriefRecord): Promise<readonly string[]> {
    const taskIds = tasksAwaitingReapproval(record, await this.#deps.listTasks());
    const paused: string[] = [];
    for (const taskId of taskIds) {
      await this.#deps.pauseTask(
        taskId,
        `what was agreed for "${record.draft.content.goal}" changed after approval and needs reapproval`,
      );
      paused.push(taskId);
    }
    return paused;
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
      terminal: this.#deps.terminal,
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
      plainLanguage: [],
    };
  }
}
