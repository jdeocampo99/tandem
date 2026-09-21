import type {
  IsoTimestamp,
  Notification,
  RequestConflict,
  RequestDeliveryRecord,
  RequestDependency,
  RequestIntegration,
  RequestMember,
  RequestPublication,
  ReviewResult,
  TaskRecord,
  TaskStage,
} from "../contracts.ts";
import { isSafeRequestId } from "../contracts.ts";
import type { RequestApprovalState } from "./brief.ts";

export type RequestDeliveryErrorCode =
  | "invalid-request-id"
  | "request-not-found"
  | "not-a-member"
  | "member-mismatch"
  | "approval-required"
  | "duplicate-conflict"
  | "conflict-not-found"
  | "relation-unknown-task";

export class RequestDeliveryError extends Error {
  readonly code: RequestDeliveryErrorCode;
  readonly requestId: string;

  constructor(code: RequestDeliveryErrorCode, message: string, requestId: string) {
    super(message);
    this.name = "RequestDeliveryError";
    this.code = code;
    this.requestId = requestId;
  }
}

/** The task fields whole-request coordination reads; the task record stays the owner of all of them. */
export type RequestMemberTask = Pick<
  TaskRecord,
  "id" | "kind" | "stage" | "surfaces" | "requestId" | "reviewHead" | "blockReason"
>;

/** One member held back, naming the work it waits on rather than widening its scope. */
export type RequestWait = Readonly<{
  readonly taskId: string;
  readonly waitingFor: readonly string[];
  readonly reason: string;
}>;

/** One member stopped by an ordinary task blocker; independent members keep running beside it. */
export type RequestBlocker = Readonly<{
  readonly taskId: string;
  readonly reason: string;
}>;

/** Something only the user can settle. Every entry interrupts the main conversation exactly once. */
export type RequestDecisionRequest = Readonly<{
  readonly id: string;
  readonly subject: string;
  readonly detail: string;
}>;

/** Whether the recorded integration still describes the member outputs that exist now. */
export type RequestIntegrationStatus = "absent" | "stale" | "current";

export type RequestPublicationStatus = "absent" | "draft" | "published";

/** What the whole request looks like right now, derived from durable state and nothing else. */
export type RequestAggregate = Readonly<{
  readonly requestId: string;
  readonly briefRevision: number | undefined;
  readonly approvalState: RequestApprovalState;
  readonly activeTaskIds: readonly string[];
  readonly completedTaskIds: readonly string[];
  readonly waiting: readonly RequestWait[];
  readonly blockers: readonly RequestBlocker[];
  readonly decisions: readonly RequestDecisionRequest[];
  readonly dispatchableTaskIds: readonly string[];
  /** Member order a clean integration must follow, dependencies before dependents. */
  readonly integrationOrder: readonly string[];
  readonly integrationStatus: RequestIntegrationStatus;
  readonly publicationStatus: RequestPublicationStatus;
  readonly incompleteReasons: readonly string[];
  readonly readyToIntegrate: boolean;
  readonly delivered: boolean;
}>;

export type AdmitRequestMemberInput = Readonly<{
  readonly task: RequestMemberTask;
  readonly briefRevision: number;
  readonly agreementDigest: string;
  readonly approvalState: RequestApprovalState;
}>;

export type RequestRelationInput = Readonly<{
  readonly taskId: string;
  readonly dependsOn: string;
  readonly reason: string;
  readonly briefRevision: number;
}>;

export type RequestConflictInput = Readonly<{
  readonly id: string;
  readonly taskIds: readonly string[];
  readonly reason: string;
  readonly briefRevision: number;
}>;

/** Stages whose durable outcome is a finished component the request can integrate. */
const COMPLETE_STAGES: readonly TaskStage[] = ["ready", "completed", "merged"];

/** Stages where a member is progressing on its own and needs no request-level action. */
const RUNNING_STAGES: readonly TaskStage[] = [
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
];

const ABANDONED_STAGES: readonly TaskStage[] = ["cancelled"];

function commit(
  record: RequestDeliveryRecord,
  now: IsoTimestamp,
  changes: Partial<RequestDeliveryRecord>,
): RequestDeliveryRecord {
  return { ...record, ...changes, revision: record.revision + 1, updatedAt: now };
}

function activeMembers(record: RequestDeliveryRecord): readonly RequestMember[] {
  return record.members.filter((member) => member.status === "active");
}

function memberFor(record: RequestDeliveryRecord, taskId: string): RequestMember | undefined {
  return record.members.find((member) => member.taskId === taskId);
}

function quarantinedDependency(dependency: RequestDependency, reason: string): RequestDependency {
  return { ...dependency, status: "quarantined", quarantineReason: reason };
}

/**
 * Walks the active dependency edges and answers which task ids can never be ordered, because each
 * one sits on a cycle. Contradictory ordering is reported, never broken by dropping an edge.
 */
function taskIdsOnDependencyCycle(
  memberIds: readonly string[],
  dependencies: readonly RequestDependency[],
): ReadonlySet<string> {
  const remaining = new Set(memberIds);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const taskId of [...remaining]) {
      const blocked = dependencies.some(
        (dependency) => dependency.taskId === taskId && remaining.has(dependency.dependsOn),
      );
      if (blocked) continue;
      remaining.delete(taskId);
      progressed = true;
    }
  }
  return remaining;
}

/** Orders members so every dependency precedes its dependents; cycles are reported, not ordered. */
function dependencyOrderedTaskIds(
  memberIds: readonly string[],
  dependencies: readonly RequestDependency[],
): readonly string[] {
  const cyclic = taskIdsOnDependencyCycle(memberIds, dependencies);
  const placed: string[] = [];
  const pending = memberIds.filter((taskId) => !cyclic.has(taskId));
  while (pending.length > placed.length) {
    const next = pending.find(
      (taskId) =>
        !placed.includes(taskId) &&
        dependencies
          .filter((dependency) => dependency.taskId === taskId)
          .every(
            (dependency) =>
              !pending.includes(dependency.dependsOn) || placed.includes(dependency.dependsOn),
          ),
    );
    if (next === undefined) break;
    placed.push(next);
  }
  return placed;
}

function sharedSurfaces(left: readonly string[], right: readonly string[]): readonly string[] {
  return left.filter((surface) => right.includes(surface));
}

function stageOf(tasks: readonly RequestMemberTask[], taskId: string): TaskStage | undefined {
  return tasks.find((task) => task.id === taskId)?.stage;
}

function isComplete(stage: TaskStage | undefined): boolean {
  return stage !== undefined && COMPLETE_STAGES.includes(stage);
}

function waitsForDependencies(
  taskId: string,
  dependencies: readonly RequestDependency[],
  tasks: readonly RequestMemberTask[],
): readonly string[] {
  return dependencies
    .filter(
      (dependency) =>
        dependency.status === "active" &&
        dependency.taskId === taskId &&
        !isComplete(stageOf(tasks, dependency.dependsOn)),
    )
    .map((dependency) => dependency.dependsOn);
}

/**
 * Known overlapping work is serialized automatically: among unfinished members that share a
 * surface, the one admitted first proceeds and the others wait. This is ordinary coordination and
 * never asks the user for anything.
 */
function serializedBehind(
  member: RequestMember,
  members: readonly RequestMember[],
  tasks: readonly RequestMemberTask[],
): readonly string[] {
  const position = members.indexOf(member);
  return members
    .slice(0, position)
    .filter(
      (earlier) =>
        !isComplete(stageOf(tasks, earlier.taskId)) &&
        sharedSurfaces(earlier.surfaces, member.surfaces).length > 0,
    )
    .map((earlier) => earlier.taskId);
}

function conflictedTaskIds(record: RequestDeliveryRecord): readonly string[] {
  return record.conflicts
    .filter((conflict) => conflict.decision === undefined)
    .flatMap((conflict) => conflict.taskIds);
}

function decisionRequests(
  record: RequestDeliveryRecord,
  approvalState: RequestApprovalState,
): readonly RequestDecisionRequest[] {
  const decisions: RequestDecisionRequest[] = [];
  if (approvalState === "superseded") {
    decisions.push({
      id: `${record.id}:reapproval`,
      subject: record.id,
      detail: `Request ${record.id} changed what was agreed after approval; its brief needs reapproval before member work continues`,
    });
  }
  for (const conflict of record.conflicts) {
    if (conflict.decision !== undefined) continue;
    decisions.push({
      id: `${record.id}:conflict:${conflict.id}`,
      subject: conflict.taskIds.join(", "),
      detail: `Conflict ${conflict.id} between ${conflict.taskIds.join(" and ")}: ${conflict.reason}`,
    });
  }
  for (const member of record.members) {
    if (member.status !== "quarantined") continue;
    decisions.push({
      id: `${record.id}:member:${member.taskId}`,
      subject: member.taskId,
      detail: `Membership of ${member.taskId} is quarantined: ${member.quarantineReason ?? "unknown reason"}`,
    });
  }
  for (const dependency of record.dependencies) {
    if (dependency.status !== "quarantined") continue;
    decisions.push({
      id: `${record.id}:dependency:${dependency.taskId}:${dependency.dependsOn}`,
      subject: `${dependency.taskId} -> ${dependency.dependsOn}`,
      detail: `Dependency of ${dependency.taskId} on ${dependency.dependsOn} is quarantined: ${dependency.quarantineReason ?? "unknown reason"}`,
    });
  }
  return decisions;
}

function integrationStatusOf(
  record: RequestDeliveryRecord,
  tasks: readonly RequestMemberTask[],
): RequestIntegrationStatus {
  const integration = record.integration;
  if (integration === undefined) return "absent";
  const expected = activeMembers(record);
  if (expected.length !== integration.members.length) return "stale";
  return expected.every((member) =>
    integration.members.some(
      (integrated) =>
        integrated.taskId === member.taskId &&
        integrated.head === tasks.find((task) => task.id === member.taskId)?.reviewHead,
    ),
  )
    ? "current"
    : "stale";
}

function publicationStatusOf(record: RequestDeliveryRecord): RequestPublicationStatus {
  const publication = record.publication;
  if (publication === undefined) return "absent";
  return publication.draft || publication.pullRequest.state === "draft" ? "draft" : "published";
}

export function createRequestDeliveryRecord(
  input: Readonly<{ readonly id: string; readonly repoPath: string }>,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  if (!isSafeRequestId(input.id)) {
    throw new RequestDeliveryError(
      "invalid-request-id",
      `A request delivery record needs a request identity; received ${JSON.stringify(String(input.id))}`,
      String(input.id),
    );
  }
  return {
    schemaVersion: 1,
    id: input.id,
    revision: 0,
    repoPath: input.repoPath,
    createdAt: now,
    updatedAt: now,
    members: [],
    dependencies: [],
    conflicts: [],
    notifications: [],
  };
}

/**
 * Links one approved implementation task to this request and the brief revision that approved it.
 * Re-admitting an unchanged member is a no-op, so a retried admission never duplicates membership;
 * an admission under a different brief agreement is refused rather than re-pinned.
 */
export function admitRequestMember(
  record: RequestDeliveryRecord,
  input: AdmitRequestMemberInput,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  if (input.task.requestId !== record.id) {
    throw new RequestDeliveryError(
      "member-mismatch",
      `Task ${input.task.id} names request ${String(input.task.requestId)}, not ${record.id}`,
      record.id,
    );
  }
  if (input.approvalState !== "current") {
    throw new RequestDeliveryError(
      "approval-required",
      `Request ${record.id} has no current brief approval; its ${input.approvalState} brief cannot admit ${input.task.id}`,
      record.id,
    );
  }
  const existing = memberFor(record, input.task.id);
  if (existing !== undefined) {
    if (
      existing.briefRevision === input.briefRevision &&
      existing.agreementDigest === input.agreementDigest
    ) {
      return record;
    }
    throw new RequestDeliveryError(
      "member-mismatch",
      `Task ${input.task.id} is already admitted to ${record.id} under brief revision ${existing.briefRevision}, not ${input.briefRevision}`,
      record.id,
    );
  }
  const member: RequestMember = {
    taskId: input.task.id,
    briefRevision: input.briefRevision,
    agreementDigest: input.agreementDigest,
    surfaces: [...input.task.surfaces],
    admittedAt: now,
    status: "active",
  };
  return commit(record, now, { members: [...record.members, member] });
}

/**
 * Records that one member must wait for another. An edge that would make the order contradictory is
 * stored quarantined and needs a decision, rather than silently reordering approved work.
 */
export function recordRequestDependency(
  record: RequestDeliveryRecord,
  input: RequestRelationInput,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  for (const taskId of [input.taskId, input.dependsOn]) {
    if (memberFor(record, taskId) === undefined) {
      throw new RequestDeliveryError(
        "not-a-member",
        `Task ${taskId} is not a member of request ${record.id}`,
        record.id,
      );
    }
  }
  if (input.taskId === input.dependsOn) {
    throw new RequestDeliveryError(
      "relation-unknown-task",
      `Task ${input.taskId} cannot depend on itself`,
      record.id,
    );
  }
  const existing = record.dependencies.find(
    (dependency) => dependency.taskId === input.taskId && dependency.dependsOn === input.dependsOn,
  );
  if (existing !== undefined) return record;
  const candidate: RequestDependency = {
    taskId: input.taskId,
    dependsOn: input.dependsOn,
    reason: input.reason,
    briefRevision: input.briefRevision,
    recordedAt: now,
    status: "active",
  };
  const dependencies = [...record.dependencies, candidate];
  const cyclic = taskIdsOnDependencyCycle(
    record.members.map((member) => member.taskId),
    dependencies.filter((dependency) => dependency.status === "active"),
  );
  const settled = cyclic.has(input.taskId)
    ? [
        ...record.dependencies,
        quarantinedDependency(
          candidate,
          `depending on ${input.dependsOn} would make the member order contradictory`,
        ),
      ]
    : dependencies;
  return commit(record, now, { dependencies: settled });
}

/** Records contradicting member outputs. Only a user decision clears one; nothing retries it. */
export function recordRequestConflict(
  record: RequestDeliveryRecord,
  input: RequestConflictInput,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  if (record.conflicts.some((conflict) => conflict.id === input.id)) {
    throw new RequestDeliveryError(
      "duplicate-conflict",
      `Conflict ${input.id} already exists on request ${record.id}`,
      record.id,
    );
  }
  for (const taskId of input.taskIds) {
    if (memberFor(record, taskId) === undefined) {
      throw new RequestDeliveryError(
        "not-a-member",
        `Task ${taskId} is not a member of request ${record.id}`,
        record.id,
      );
    }
  }
  const conflict: RequestConflict = {
    id: input.id,
    taskIds: [...input.taskIds],
    reason: input.reason,
    briefRevision: input.briefRevision,
    recordedAt: now,
    status: "active",
  };
  return commit(record, now, { conflicts: [...record.conflicts, conflict] });
}

/** Settles one conflict with the instruction the user gave; the record keeps what was decided. */
export function decideRequestConflict(
  record: RequestDeliveryRecord,
  conflictId: string,
  instruction: string,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  const conflict = record.conflicts.find((entry) => entry.id === conflictId);
  if (conflict === undefined) {
    throw new RequestDeliveryError(
      "conflict-not-found",
      `Conflict ${conflictId} does not exist on request ${record.id}`,
      record.id,
    );
  }
  if (conflict.decision !== undefined) return record;
  return commit(record, now, {
    conflicts: record.conflicts.map((entry) =>
      entry.id === conflictId ? { ...entry, decision: { instruction, decidedAt: now } } : entry,
    ),
  });
}

/**
 * Quarantines membership and relations that durable task state has outgrown, so a contradiction
 * stays visible instead of being cleared or retried. Nothing here removes a record or resumes one.
 */
export function quarantineOutdatedRelations(
  record: RequestDeliveryRecord,
  input: Readonly<{
    readonly tasks: readonly RequestMemberTask[];
    readonly approvedBriefRevision: number | undefined;
    readonly approvedAgreementDigest: string | undefined;
  }>,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  const members = record.members.map((member) => {
    if (member.status === "quarantined") return member;
    const task = input.tasks.find((entry) => entry.id === member.taskId);
    const reason = memberQuarantineReason(member, task, { ...input, requestId: record.id });
    return reason === undefined
      ? member
      : ({ ...member, status: "quarantined", quarantineReason: reason } satisfies RequestMember);
  });
  const known = new Set(
    members.filter((member) => member.status === "active").map((m) => m.taskId),
  );
  const dependencies = record.dependencies.map((dependency) => {
    if (dependency.status === "quarantined") return dependency;
    if (known.has(dependency.taskId) && known.has(dependency.dependsOn)) return dependency;
    return quarantinedDependency(
      dependency,
      `${known.has(dependency.taskId) ? dependency.dependsOn : dependency.taskId} is no longer an active member`,
    );
  });
  const changed =
    members.some((member, index) => member !== record.members[index]) ||
    dependencies.some((dependency, index) => dependency !== record.dependencies[index]);
  return changed ? commit(record, now, { members, dependencies }) : record;
}

function memberQuarantineReason(
  member: RequestMember,
  task: RequestMemberTask | undefined,
  input: Readonly<{
    readonly requestId: string;
    readonly approvedBriefRevision: number | undefined;
    readonly approvedAgreementDigest: string | undefined;
  }>,
): string | undefined {
  if (task === undefined) return "the member task no longer exists in durable state";
  if (task.requestId !== input.requestId) {
    return `the member task now names request ${String(task.requestId)}`;
  }
  if (ABANDONED_STAGES.includes(task.stage)) return `the member task is ${task.stage}`;
  if (
    input.approvedAgreementDigest !== undefined &&
    member.agreementDigest !== input.approvedAgreementDigest
  ) {
    return `the member was admitted under brief revision ${member.briefRevision}, which is not the approved agreement (revision ${String(input.approvedBriefRevision)})`;
  }
  return undefined;
}

/** Adds one notification per message that is not already recorded, so a retry never duplicates it. */
export function withRequestNotifications(
  record: RequestDeliveryRecord,
  entries: readonly Notification[],
  now: IsoTimestamp,
): RequestDeliveryRecord {
  const added = entries.filter(
    (entry) => !record.notifications.some((existing) => existing.id === entry.id),
  );
  if (added.length === 0) return record;
  return commit(record, now, { notifications: [...record.notifications, ...added] });
}

export function acknowledgeRequestNotification(
  record: RequestDeliveryRecord,
  notificationId: string,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  if (!record.notifications.some((entry) => entry.id === notificationId && !entry.acknowledged)) {
    return record;
  }
  return commit(record, now, {
    notifications: record.notifications.map((entry) =>
      entry.id === notificationId ? { ...entry, acknowledged: true } : entry,
    ),
  });
}

export function withRequestIntegration(
  record: RequestDeliveryRecord,
  integration: RequestIntegration,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  return commit(record, now, { integration });
}

/**
 * Records one review lens against the integrated commit, replacing an earlier result for the same
 * lens. A review that names another commit is refused rather than retargeted.
 */
export function withRequestIntegrationReview(
  record: RequestDeliveryRecord,
  review: ReviewResult,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  const integration = record.integration;
  if (integration === undefined) {
    throw new RequestDeliveryError(
      "request-not-found",
      `Request ${record.id} has no integrated commit to review`,
      record.id,
    );
  }
  if (review.head !== integration.head) {
    throw new RequestDeliveryError(
      "member-mismatch",
      `Review names HEAD ${review.head}, not the integrated HEAD ${integration.head}`,
      record.id,
    );
  }
  return commit(record, now, {
    integration: {
      ...integration,
      reviews: [...integration.reviews.filter((entry) => entry.lens !== review.lens), review],
    },
  });
}

export function withRequestPublication(
  record: RequestDeliveryRecord,
  publication: RequestPublication,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  return commit(record, now, { publication });
}

export function withApprovedDeliverySplit(
  record: RequestDeliveryRecord,
  now: IsoTimestamp,
): RequestDeliveryRecord {
  return record.splitApproved === true ? record : commit(record, now, { splitApproved: true });
}

/**
 * The whole-request view: which members run, which wait, what needs a decision, and every reason
 * the request is not finished. A subset of ready members never empties `incompleteReasons`.
 */
export function summarizeRequestProgress(
  input: Readonly<{
    readonly record: RequestDeliveryRecord;
    readonly approvalState: RequestApprovalState;
    readonly approvedBriefRevision: number | undefined;
    readonly tasks: readonly RequestMemberTask[];
  }>,
): RequestAggregate {
  const { record, tasks } = input;
  const members = activeMembers(record);
  const decisions = decisionRequests(record, input.approvalState);
  const disputed = new Set(conflictedTaskIds(record));
  const active: string[] = [];
  const completed: string[] = [];
  const waiting: RequestWait[] = [];
  const blockers: RequestBlocker[] = [];
  const dispatchable: string[] = [];
  const pending: string[] = [];

  for (const member of members) {
    const task = tasks.find((entry) => entry.id === member.taskId);
    const stage = task?.stage;
    if (isComplete(stage)) {
      completed.push(member.taskId);
      continue;
    }
    if (stage === "blocked" || stage === "paused") {
      blockers.push({
        taskId: member.taskId,
        reason: task?.blockReason ?? `member task is ${String(stage)}`,
      });
      continue;
    }
    const heldFor = disputed.has(member.taskId)
      ? { waitingFor: [], reason: "an unresolved conflict needs a decision" }
      : holdReason(member, members, record.dependencies, tasks);
    if (heldFor !== undefined) {
      waiting.push({ taskId: member.taskId, ...heldFor });
      continue;
    }
    if (stage !== undefined && RUNNING_STAGES.includes(stage)) active.push(member.taskId);
    else pending.push(member.taskId);
    dispatchable.push(member.taskId);
  }

  const integrationStatus = integrationStatusOf(record, tasks);
  const publicationStatus = publicationStatusOf(record);
  const incompleteReasons = incompleteRequestReasons({
    record,
    approvalState: input.approvalState,
    members,
    active,
    pending,
    waiting,
    blockers,
    decisions,
    integrationStatus,
    publicationStatus,
  });

  return {
    requestId: record.id,
    briefRevision: input.approvedBriefRevision,
    approvalState: input.approvalState,
    activeTaskIds: active,
    completedTaskIds: completed,
    waiting,
    blockers,
    decisions,
    dispatchableTaskIds: dispatchable,
    integrationOrder: dependencyOrderedTaskIds(
      members.map((member) => member.taskId),
      record.dependencies.filter((dependency) => dependency.status === "active"),
    ),
    integrationStatus,
    publicationStatus,
    incompleteReasons,
    readyToIntegrate:
      members.length > 0 &&
      decisions.length === 0 &&
      waiting.length === 0 &&
      blockers.length === 0 &&
      active.length === 0 &&
      completed.length === members.length,
    delivered:
      incompleteReasons.length === 0 &&
      integrationStatus === "current" &&
      publicationStatus === "published",
  };
}

function holdReason(
  member: RequestMember,
  members: readonly RequestMember[],
  dependencies: readonly RequestDependency[],
  tasks: readonly RequestMemberTask[],
): Readonly<{ readonly waitingFor: readonly string[]; readonly reason: string }> | undefined {
  const unmet = waitsForDependencies(member.taskId, dependencies, tasks);
  if (unmet.length > 0) {
    return { waitingFor: unmet, reason: `waiting for ${unmet.join(", ")} to finish` };
  }
  const serialized = serializedBehind(member, members, tasks);
  if (serialized.length > 0) {
    return {
      waitingFor: serialized,
      reason: `serialized behind ${serialized.join(", ")} on shared surfaces`,
    };
  }
  return undefined;
}

function incompleteRequestReasons(
  input: Readonly<{
    readonly record: RequestDeliveryRecord;
    readonly approvalState: RequestApprovalState;
    readonly members: readonly RequestMember[];
    readonly active: readonly string[];
    readonly pending: readonly string[];
    readonly waiting: readonly RequestWait[];
    readonly blockers: readonly RequestBlocker[];
    readonly decisions: readonly RequestDecisionRequest[];
    readonly integrationStatus: RequestIntegrationStatus;
    readonly publicationStatus: RequestPublicationStatus;
  }>,
): readonly string[] {
  const reasons: string[] = [];
  if (input.approvalState !== "current") {
    reasons.push(`the request brief approval is ${input.approvalState}`);
  }
  if (input.members.length === 0) reasons.push("no approved implementation task is a member yet");
  if (input.active.length > 0) reasons.push(`${input.active.length} member(s) are still running`);
  if (input.pending.length > 0) {
    reasons.push(`${input.pending.join(", ")} has not started producing a reviewed result yet`);
  }
  for (const wait of input.waiting) {
    reasons.push(`${wait.taskId} is ${wait.reason}`);
  }
  for (const blocker of input.blockers) {
    reasons.push(`${blocker.taskId} is blocked: ${blocker.reason}`);
  }
  for (const decision of input.decisions) {
    reasons.push(`a decision is needed: ${decision.detail}`);
  }
  if (input.integrationStatus !== "current") {
    reasons.push(
      input.integrationStatus === "absent"
        ? "the approved member outputs have not been integrated into one delivery commit"
        : "the recorded integration no longer describes the current member outputs",
    );
  }
  if (input.publicationStatus !== "published") {
    reasons.push(
      input.publicationStatus === "absent"
        ? "no pull request has been published for the integrated commit"
        : "the request pull request is still an unfinished draft",
    );
  }
  return reasons;
}

/** Why one member may not be dispatched right now, or undefined when nothing holds it. */
export function requestDispatchHold(
  aggregate: RequestAggregate,
  taskId: string,
): string | undefined {
  const wait = aggregate.waiting.find((entry) => entry.taskId === taskId);
  if (wait !== undefined) return `${taskId} is ${wait.reason}`;
  if (aggregate.approvalState !== "current") {
    return `request ${aggregate.requestId} brief approval is ${aggregate.approvalState}`;
  }
  return undefined;
}
