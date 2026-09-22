import { acquireWorktree } from "../adapters/treehouse.ts";
import type {
  Clock,
  CommandRunner,
  IdFactory,
  Notification,
  PinnedValidationEvidence,
  RequestBriefRecord,
  RequestDeliveryRecord,
  RequestIntegratedMember,
  RequestIntegration,
  ReviewResult,
  TaskRecord,
  WorktreeLease,
} from "../contracts.ts";
import {
  describeRequestDraftPr,
  describeRequestPr,
  type PrSummary,
  type RequestAcceptanceStatus,
  requestAcceptanceStatus,
} from "../delivery/evidence.ts";
import {
  assertIntegratedCheckout,
  mergeMembersOntoDeliveryBranch,
} from "../delivery/integration.ts";
import { mergeIntegratedRequest, publishIntegratedRequest } from "../delivery/pull-requests.ts";
import { integratedAcceptanceContract, policyIdentity } from "../tasks/acceptance.ts";
import type { TaskEvent } from "../tasks/lifecycle.ts";
import { runValidation } from "../workers/validation.ts";
import {
  acknowledgeRequestNotification,
  admitRequestMember,
  decideRequestConflict,
  quarantineOutdatedRelations,
  type RequestAggregate,
  RequestDeliveryError,
  recordRequestConflict,
  recordRequestDependency,
  requestDispatchHold,
  summarizeRequestProgress,
  withApprovedDeliverySplit,
  withRequestIntegration,
  withRequestIntegrationReview,
  withRequestNotifications,
  withRequestPublication,
} from "./aggregate.ts";
import { assertSafeRequestId, requestApprovalState } from "./brief.ts";
import type { RequestDeliveryStore } from "./delivery-store.ts";

export type RequestDeliveryWorkflowDependencies = Readonly<{
  readonly sessionId: string;
  readonly poolRoot: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly store: RequestDeliveryStore;
  readonly readBrief: (requestId: string) => Promise<RequestBriefRecord>;
  readonly listTasks: () => Promise<readonly TaskRecord[]>;
  /** The existing lifecycle transition path; this workflow never writes a task record directly. */
  readonly transitionTask: (taskId: string, event: TaskEvent) => Promise<TaskRecord>;
}>;

/** Everything a caller needs to show a request and decide what to do next. */
export type RequestDeliveryView = Readonly<{
  readonly record: RequestDeliveryRecord;
  readonly aggregate: RequestAggregate;
  /** Present once an integration exists; absent while there is nothing to accept yet. */
  readonly acceptance?: RequestAcceptanceStatus;
}>;

export type PublishRequestInput = Readonly<{
  readonly repository: string;
  readonly title: string;
  readonly base: string;
  readonly summary: PrSummary;
  readonly approved: boolean;
}>;

export type MergeRequestInput = Readonly<{
  readonly approved: boolean;
  readonly method?: "merge" | "squash" | "rebase";
}>;

type LoadedRequest = Readonly<{
  readonly record: RequestDeliveryRecord;
  readonly brief: RequestBriefRecord;
  readonly tasks: readonly TaskRecord[];
  readonly members: readonly TaskRecord[];
}>;

function sameIntegratedMembers(
  left: readonly RequestIntegratedMember[],
  right: readonly RequestIntegratedMember[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (member, index) =>
        member.taskId === right[index]?.taskId && member.head === right[index]?.head,
    )
  );
}

/** The branch and reviewed commit one finished member contributes to the delivery branch. */
function integratedMemberFor(task: TaskRecord): RequestIntegratedMember {
  if (task.worktree === undefined || task.reviewHead === undefined) {
    throw new Error(`member ${task.id} has no reviewed commit on a leased branch`);
  }
  return { taskId: task.id, branch: task.worktree.branch, head: task.reviewHead };
}

/** Every member must have branched from the same source commit for one clean delivery branch. */
function sharedBaseHead(members: readonly TaskRecord[]): string {
  const baseHeads = new Set(members.map((member) => member.worktree?.baseHead));
  const [baseHead] = [...baseHeads];
  if (baseHeads.size !== 1 || baseHead === undefined) {
    throw new Error(
      "request members were branched from different source commits; integrating them needs a decision",
    );
  }
  return baseHead;
}

function sharedPolicyDigest(members: readonly TaskRecord[]): string {
  const digests = new Set(members.map((member) => policyIdentity(member.policy)));
  const [digest] = [...digests];
  if (digests.size !== 1 || digest === undefined) {
    throw new Error("request members are pinned to different repository policies");
  }
  return digest;
}

export class RequestDeliveryWorkflow {
  readonly #deps: RequestDeliveryWorkflowDependencies;

  constructor(deps: RequestDeliveryWorkflowDependencies) {
    this.#deps = deps;
  }

  /**
   * Links one approved implementation task to its request and the brief revision that approved it.
   * Tasks that name no request, and research tasks, are left to the task-level contract alone.
   */
  async admit(task: TaskRecord): Promise<void> {
    if (task.requestId === undefined || task.kind !== "implementation") return;
    const brief = await this.#deps.readBrief(task.requestId);
    const approval = brief.approval;
    const approvalState = requestApprovalState(brief);
    if (approval === undefined || approvalState !== "current") {
      throw new RequestDeliveryError(
        "approval-required",
        `Request ${brief.id} has no current brief approval; task ${task.id} cannot be admitted`,
        brief.id,
      );
    }
    const record = await this.#deps.store.open({
      requestId: brief.id,
      repoPath: brief.repoPath,
    });
    await this.#deps.store.update(record.id, record.revision, (current) =>
      admitRequestMember(
        current,
        {
          task,
          briefRevision: approval.briefRevision,
          agreementDigest: approval.agreementDigest,
          approvalState,
        },
        this.#deps.clock(),
      ),
    );
  }

  async status(requestId: string): Promise<RequestDeliveryView> {
    return this.#view(await this.#load(requestId));
  }

  /**
   * Brings relations back in line with durable task state and records the notifications the main
   * conversation should see. Routine progress records nothing; only decisions and true completion
   * produce a notification, and each one is recorded at most once.
   */
  async reconcile(requestId: string): Promise<RequestDeliveryView> {
    const loaded = await this.#load(requestId);
    const approval = loaded.brief.approval;
    const quarantined = await this.#update(loaded.record, (current) =>
      quarantineOutdatedRelations(
        current,
        {
          tasks: loaded.tasks,
          approvedBriefRevision: approval?.briefRevision,
          approvedAgreementDigest: approval?.agreementDigest,
        },
        this.#deps.clock(),
      ),
    );
    const settled = { ...loaded, record: quarantined };
    const aggregate = this.#aggregate(settled);
    const notified = await this.#update(quarantined, (current) =>
      withRequestNotifications(
        current,
        interruptions(aggregate, settled.brief.draft.content.goal),
        this.#deps.clock(),
      ),
    );
    return this.#view({ ...settled, record: notified });
  }

  /**
   * Refuses to deliver one member on its own unless splitting delivery was explicitly approved.
   * One verified pull request for the whole request is the default outcome.
   */
  async assertSeparateDeliveryApproved(
    task: Pick<TaskRecord, "id" | "requestId" | "kind">,
    action: string,
  ): Promise<void> {
    if (task.requestId === undefined || task.kind !== "implementation") return;
    const brief = await this.#deps.readBrief(task.requestId);
    const record = await this.#deps.store.open({
      requestId: brief.id,
      repoPath: brief.repoPath,
    });
    if (record.splitApproved === true) return;
    if (!record.members.some((member) => member.taskId === task.id)) return;
    throw new Error(
      `Task ${task.id} belongs to request ${record.id}, which delivers one pull request; ${action} for a single member needs explicit approval to split delivery`,
    );
  }

  /** Why one member may not be dispatched right now, read from its request alone. */
  async dispatchHold(
    task: Pick<TaskRecord, "id" | "requestId" | "kind">,
  ): Promise<string | undefined> {
    if (task.requestId === undefined || task.kind !== "implementation") return undefined;
    const loaded = await this.#load(task.requestId);
    return requestDispatchHold(this.#aggregate(loaded), task.id);
  }

  async relate(
    requestId: string,
    input: Readonly<{
      readonly taskId: string;
      readonly dependsOn: string;
      readonly reason: string;
    }>,
  ): Promise<RequestDeliveryView> {
    const loaded = await this.#load(requestId);
    const record = await this.#update(loaded.record, (current) =>
      recordRequestDependency(
        current,
        { ...input, briefRevision: this.#approvedRevision(loaded.brief) },
        this.#deps.clock(),
      ),
    );
    return this.#view({ ...loaded, record });
  }

  async conflict(
    requestId: string,
    input: Readonly<{ readonly taskIds: readonly string[]; readonly reason: string }>,
  ): Promise<RequestDeliveryView> {
    const loaded = await this.#load(requestId);
    const record = await this.#update(loaded.record, (current) =>
      recordRequestConflict(
        current,
        {
          id: this.#deps.idFactory(),
          taskIds: input.taskIds,
          reason: input.reason,
          briefRevision: this.#approvedRevision(loaded.brief),
        },
        this.#deps.clock(),
      ),
    );
    return this.#view({ ...loaded, record });
  }

  async decide(
    requestId: string,
    input: Readonly<{ readonly conflictId: string; readonly instruction: string }>,
  ): Promise<RequestDeliveryView> {
    const loaded = await this.#load(requestId);
    const record = await this.#update(loaded.record, (current) =>
      decideRequestConflict(current, input.conflictId, input.instruction, this.#deps.clock()),
    );
    return this.#view({ ...loaded, record });
  }

  /** Records that the user approved splitting delivery across more than one pull request. */
  async approveSplit(requestId: string): Promise<RequestDeliveryView> {
    const loaded = await this.#load(requestId);
    const record = await this.#update(loaded.record, (current) =>
      withApprovedDeliverySplit(current, this.#deps.clock()),
    );
    return this.#view({ ...loaded, record });
  }

  /** Admits one fresh read-only review of the integrated commit; another commit is refused. */
  async recordReview(requestId: string, review: ReviewResult): Promise<RequestDeliveryView> {
    const loaded = await this.#load(requestId);
    const record = await this.#update(loaded.record, (current) =>
      withRequestIntegrationReview(current, review, this.#deps.clock()),
    );
    return this.#view({ ...loaded, record });
  }

  async acknowledge(requestId: string, notificationId: string): Promise<RequestDeliveryView> {
    const loaded = await this.#load(requestId);
    const record = await this.#update(loaded.record, (current) =>
      acknowledgeRequestNotification(current, notificationId, this.#deps.clock()),
    );
    return this.#view({ ...loaded, record });
  }

  /**
   * Merges the finished member outputs into the one delivery branch and records the evidence the
   * pinned policy demands at the resulting commit. An integration that already covers exactly these
   * member commits is reused, so a restart never integrates or verifies the same work twice.
   */
  async integrate(requestId: string): Promise<RequestDeliveryView> {
    const loaded = await this.#load(requestId);
    const aggregate = this.#aggregate(loaded);
    if (!aggregate.readyToIntegrate) {
      throw new Error(
        `request ${loaded.record.id} cannot be integrated: ${aggregate.incompleteReasons.join("; ")}`,
      );
    }
    const ordered = aggregate.integrationOrder.map((taskId) => this.#memberTask(loaded, taskId));
    const members = ordered.map(integratedMemberFor);
    const recorded = loaded.record.integration;
    if (recorded !== undefined && sameIntegratedMembers(recorded.members, members)) {
      return this.#view(loaded);
    }
    const integration = await this.#integrateMembers(loaded, ordered, members);
    const record = await this.#update(loaded.record, (current) =>
      withRequestIntegration(current, integration, this.#deps.clock()),
    );
    return this.#view({ ...loaded, record });
  }

  /**
   * Publishes the single pull request the request delivers through. It refuses unless the complete
   * final acceptance contract holds at the integrated commit, and it never merges or deploys.
   */
  async publish(requestId: string, input: PublishRequestInput): Promise<RequestDeliveryView> {
    const loaded = await this.#load(requestId);
    const integration = this.#integration(loaded.record);
    const acceptanceInput = {
      integration,
      members: loaded.members,
      criteria: loaded.brief.draft.content.acceptanceCriteria,
    };
    const body = describeRequestPr(acceptanceInput, input.summary);
    const checkout = await assertIntegratedCheckout(this.#deps.run, {
      cwd: integration.worktree.path,
      branch: integration.worktree.branch,
      head: integration.head,
    });
    const pullRequest = await publishIntegratedRequest({
      checkout,
      repository: input.repository,
      title: input.title,
      base: input.base,
      body,
      approved: input.approved,
      run: this.#deps.run,
    });
    const record = await this.#update(loaded.record, (current) =>
      withRequestPublication(
        current,
        {
          pullRequest,
          integratedHead: integration.head,
          draft: pullRequest.state === "draft",
          publishedAt: this.#deps.clock(),
        },
        this.#deps.clock(),
      ),
    );
    return this.#reconciled({ ...loaded, record });
  }

  /**
   * Merges the request pull request under its own explicit approval and verified remote state, then
   * marks each member merged with the proof that the merged commit contains its reviewed work.
   */
  async merge(requestId: string, input: MergeRequestInput): Promise<RequestDeliveryView> {
    const loaded = await this.#load(requestId);
    const integration = this.#integration(loaded.record);
    const publication = loaded.record.publication;
    if (publication === undefined || publication.integratedHead !== integration.head) {
      throw new Error(
        `request ${loaded.record.id} has no published pull request for its integrated HEAD`,
      );
    }
    const checkout = await assertIntegratedCheckout(this.#deps.run, {
      cwd: integration.worktree.path,
      branch: integration.worktree.branch,
      head: integration.head,
    });
    const merged = await mergeIntegratedRequest({
      checkout,
      pullRequest: publication.pullRequest,
      approved: input.approved,
      method: input.method ?? "merge",
      run: this.#deps.run,
    });
    const record = await this.#update(loaded.record, (current) =>
      withRequestPublication(
        current,
        { ...publication, pullRequest: merged, draft: false },
        this.#deps.clock(),
      ),
    );
    for (const member of integration.members) {
      await this.#deps.transitionTask(member.taskId, {
        type: "merge",
        pullRequest: merged,
        approved: input.approved,
        verified: merged.state === "merged" && merged.head === integration.head,
        requestDelivery: {
          requestId: record.id,
          integratedHead: integration.head,
          memberHead: member.head,
        },
      });
    }
    return this.#reconciled({ ...loaded, record });
  }

  /**
   * Shows unfinished whole-request progress on the delivery branch. It states every reason the
   * request is not finished and can never stand in for the final acceptance contract.
   */
  describeDraft(view: RequestDeliveryView): string {
    const integration = this.#integration(view.record);
    return describeRequestDraftPr({
      requestId: view.record.id,
      objective: `request ${view.record.id} delivers ${view.record.members.length} approved task(s)`,
      integratedHead: integration.head,
      members: integration.members.map((member) => `${member.taskId} at ${member.head}`),
      activity: [
        ...view.aggregate.activeTaskIds.map((taskId) => `${taskId} is still running.`),
        ...view.aggregate.waiting.map((wait) => `${wait.taskId} is ${wait.reason}.`),
      ],
      blockers: [
        ...view.aggregate.blockers.map((blocker) => `${blocker.taskId}: ${blocker.reason}`),
        ...view.aggregate.decisions.map((decision) => decision.detail),
      ],
      remainingChecks: view.aggregate.incompleteReasons,
    });
  }

  async #integrateMembers(
    loaded: LoadedRequest,
    ordered: readonly TaskRecord[],
    members: readonly RequestIntegratedMember[],
  ): Promise<RequestIntegration> {
    const baseHead = sharedBaseHead(ordered);
    const policyDigest = sharedPolicyDigest(ordered);
    const worktree = await this.#deliveryWorktree(loaded, baseHead);
    const attempt = await mergeMembersOntoDeliveryBranch(this.#deps.run, {
      cwd: worktree.path,
      branch: worktree.branch,
      baseHead,
      members,
    });
    if (attempt.refusal !== undefined) {
      await this.#update(loaded.record, (current) =>
        recordRequestConflict(
          current,
          {
            id: this.#deps.idFactory(),
            taskIds: members.map((member) => member.taskId),
            reason: attempt.refusal.detail,
            briefRevision: this.#approvedRevision(loaded.brief),
          },
          this.#deps.clock(),
        ),
      );
      throw new Error(
        `request ${loaded.record.id} could not be integrated: ${attempt.refusal.detail}`,
      );
    }
    const head = attempt.head;
    return {
      worktree,
      baseHead,
      head,
      members: [...members],
      policyDigest,
      ownerSessionId: this.#deps.sessionId,
      integratedAt: this.#deps.clock(),
      evidence: await this.#verifyIntegration({
        brief: loaded.brief,
        members: ordered,
        worktreePath: worktree.path,
        head,
        policyDigest,
      }),
      reviews: [],
    };
  }

  /** Runs the pinned validation commands in the delivery worktree at the integrated commit. */
  async #verifyIntegration(
    input: Readonly<{
      readonly brief: RequestBriefRecord;
      readonly members: readonly TaskRecord[];
      readonly worktreePath: string;
      readonly head: string;
      readonly policyDigest: string;
    }>,
  ): Promise<readonly PinnedValidationEvidence[]> {
    const first = input.members[0];
    if (first === undefined) throw new Error("integration requires at least one member");
    const contract = integratedAcceptanceContract({
      policy: first.policy,
      surfaces: input.members.flatMap((member) => member.surfaces),
      head: input.head,
      criteria: input.brief.draft.content.acceptanceCriteria,
    });
    const evidence = await runValidation({
      repoPath: input.worktreePath,
      contract: "final",
      identity: { head: input.head, generation: 0, policyDigest: input.policyDigest },
      commands: contract.commands,
      run: this.#deps.run,
    });
    const pinned: PinnedValidationEvidence[] = [];
    for (const entry of evidence) {
      if (entry.contract === "final") pinned.push(entry);
    }
    return pinned;
  }

  async #deliveryWorktree(loaded: LoadedRequest, baseHead: string): Promise<WorktreeLease> {
    const recorded = loaded.record.integration?.worktree;
    if (recorded !== undefined) return recorded;
    return acquireWorktree(this.#deps.run, {
      repo: loaded.record.repoPath,
      root: this.#deps.poolRoot,
      tandemId: `tandem-${loaded.record.id}`,
      taskName: loaded.record.id,
      sourceHead: baseHead,
    });
  }

  #integration(record: RequestDeliveryRecord): RequestIntegration {
    const integration = record.integration;
    if (integration !== undefined) return integration;
    throw new RequestDeliveryError(
      "request-not-found",
      `Request ${record.id} has no recorded integration`,
      record.id,
    );
  }

  #memberTask(loaded: LoadedRequest, taskId: string): TaskRecord {
    const task = loaded.members.find((member) => member.id === taskId);
    if (task === undefined) {
      throw new RequestDeliveryError(
        "not-a-member",
        `Task ${taskId} is not a member of request ${loaded.record.id}`,
        loaded.record.id,
      );
    }
    return task;
  }

  #approvedRevision(brief: RequestBriefRecord): number {
    const approval = brief.approval;
    if (approval === undefined || requestApprovalState(brief) !== "current") {
      throw new RequestDeliveryError(
        "approval-required",
        `Request ${brief.id} has no current brief approval`,
        brief.id,
      );
    }
    return approval.briefRevision;
  }

  async #update(
    record: RequestDeliveryRecord,
    transform: (current: RequestDeliveryRecord) => RequestDeliveryRecord,
  ): Promise<RequestDeliveryRecord> {
    return this.#deps.store.update(record.id, record.revision, transform);
  }

  async #load(requestId: string): Promise<LoadedRequest> {
    assertSafeRequestId(requestId);
    const brief = await this.#deps.readBrief(requestId);
    const record = await this.#deps.store.open({ requestId, repoPath: brief.repoPath });
    const tasks = await this.#deps.listTasks();
    const members = record.members
      .filter((member) => member.status === "active")
      .flatMap((member) => tasks.filter((task) => task.id === member.taskId));
    return { record, brief, tasks, members };
  }

  #aggregate(loaded: LoadedRequest): RequestAggregate {
    return summarizeRequestProgress({
      record: loaded.record,
      approvalState: requestApprovalState(loaded.brief),
      approvedBriefRevision: loaded.brief.approval?.briefRevision,
      tasks: loaded.tasks,
    });
  }

  /** Re-runs reconciliation so a delivery effect records its completion notification immediately. */
  async #reconciled(loaded: LoadedRequest): Promise<RequestDeliveryView> {
    const aggregate = this.#aggregate(loaded);
    const record = await this.#update(loaded.record, (current) =>
      withRequestNotifications(
        current,
        interruptions(aggregate, loaded.brief.draft.content.goal),
        this.#deps.clock(),
      ),
    );
    return this.#view({ ...loaded, record });
  }

  #view(loaded: LoadedRequest): RequestDeliveryView {
    const aggregate = this.#aggregate(loaded);
    const integration = loaded.record.integration;
    if (integration === undefined || loaded.members.length === 0) {
      return { record: loaded.record, aggregate };
    }
    return {
      record: loaded.record,
      aggregate,
      acceptance: requestAcceptanceStatus({
        integration,
        members: loaded.members,
        criteria: loaded.brief.draft.content.acceptanceCriteria,
      }),
    };
  }
}

/**
 * The only request state that interrupts the main conversation: a decision the user must make, and
 * the request actually being delivered. Every other change stays passive and on demand. Requests
 * are named by their goal, never their id, so a person reading the notification never has to look
 * one up.
 */
function interruptions(aggregate: RequestAggregate, requestGoal: string): readonly Notification[] {
  const entries = aggregate.decisions.map((decision) => ({
    id: decision.id,
    message: `The request "${requestGoal}" needs a decision about ${decision.subject}: ${decision.detail}`,
    acknowledged: false,
    kind: "coordinator" as const,
  }));
  if (!aggregate.delivered) return entries;
  return [
    ...entries,
    {
      id: `${aggregate.requestId}:delivered`,
      message: `The request "${requestGoal}" is complete: one verified pull request delivers every approved task. Merge remains a separate explicit approval.`,
      acknowledged: false,
      kind: "coordinator" as const,
    },
  ];
}
