import { dirname, isAbsolute, join, resolve } from "node:path";
import type { OmpModelRecord } from "../adapters/omp.ts";
import { EndpointOwnershipError } from "../adapters/primitives.ts";
import type {
  Clock,
  Endpoint,
  Finding,
  IsoTimestamp,
  RepoPolicy,
  ReviewLens,
  TaskQuestion,
  TaskRecord,
} from "../contracts.ts";
import { MODEL_ROLE_ORDER } from "../contracts.ts";
import { type AgentBriefReview, buildAgentBrief } from "../instructions.ts";
import { activeRuntimeJob } from "../runtime/activity.ts";
import { taskJobsDirectory } from "../runtime/persistence.ts";
import type {
  DurableEndpointLaunch,
  DurableJob,
  DurableOperation,
  DurableOperationKind,
  DurableReservation,
  RuntimePresentation,
  RuntimeState,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import type { TaskEvent } from "../tasks/lifecycle.ts";
import type { StoreTaskInput } from "../tasks/store.ts";
import type { WorkerRole } from "../workers/jobs.ts";

export const DEFAULT_STARTUP_GRACE_MS = 15 * 1000;

export type TaskCreationRequest = Readonly<{
  readonly kind: "scout" | "implementation";
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly surfaces: readonly string[];
}>;

export function isTerminalTask(task: TaskRecord): boolean {
  return task.stage === "cancelled" || task.stage === "completed" || task.stage === "merged";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty text without NUL characters`);
  }
  return value.trim();
}

export function hasPathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

export function pathText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty path without NUL characters`);
  }
  if (hasPathControlCharacter(value)) {
    throw new TypeError(`${field} must not contain control characters`);
  }
  return value;
}

export function singleLine(value: unknown, field: string): string {
  const result = text(value, field);
  if (/[\r\n\u2028\u2029]/u.test(result)) throw new TypeError(`${field} must be single-line`);
  return result;
}

export function absoluteDirectory(value: unknown, field: string): string {
  const result = pathText(value, field);
  if (!isAbsolute(result)) throw new TypeError(`${field} must be absolute`);
  return resolve(result);
}

export function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value as number;
}

export function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}
export function readTextList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of strings`);
  const values: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    values.push(text(value[index], `${field}[${index}]`));
  }
  return values;
}

export function validateModelAssignments(
  assignments: RepoPolicy["models"],
  availableModels: readonly OmpModelRecord[],
): void {
  for (const role of MODEL_ROLE_ORDER) {
    const assignment = assignments[role];
    const matches = availableModels.filter((candidate) => candidate.selector === assignment.model);
    if (matches.length !== 1) {
      throw new Error(
        `${role} selector ${JSON.stringify(assignment.model)} matched ${matches.length} available models; no fallback is allowed`,
      );
    }
    const model = matches[0];
    if (model === undefined) {
      throw new Error(
        `${role} selector ${JSON.stringify(assignment.model)} matched no available model`,
      );
    }
    if (!model.thinking.includes(assignment.thinking)) {
      throw new Error(
        `${role} selector ${JSON.stringify(assignment.model)} does not support thinking ${JSON.stringify(assignment.thinking)}`,
      );
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return String(error);
}

export function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function isMissingEndpoint(error: unknown): boolean {
  return error instanceof EndpointOwnershipError && error.reason === "missing";
}

export function nowMilliseconds(clock: Clock): number {
  const value = Date.parse(clock());
  return Number.isFinite(value) ? value : Date.now();
}

export function isOlderThan(createdAt: IsoTimestamp, clock: Clock, ageMs: number): boolean {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return true;
  return nowMilliseconds(clock) - created >= ageMs;
}

export function replaceRuntimeTask(
  state: RuntimeState,
  taskId: string,
  transform: (task: RuntimeTaskState) => RuntimeTaskState,
): RuntimeState {
  let found = false;
  const tasks = state.tasks.map((task) => {
    if (task.taskId !== taskId) return task;
    found = true;
    return transform(task);
  });
  if (!found) throw new Error(`runtime state has no task ${taskId}`);
  return { ...state, tasks };
}

export function replaceRuntimePresentation(
  state: RuntimeState,
  id: string,
  transform: (presentation: RuntimePresentation) => RuntimePresentation,
): RuntimeState {
  let found = false;
  const presentations = state.presentations.map((presentation) => {
    if (presentation.id !== id) return presentation;
    found = true;
    return transform(presentation);
  });
  if (!found) throw new Error(`runtime state has no presentation ${id}`);
  return { ...state, presentations };
}

export function appendTaskJob(task: RuntimeTaskState, job: DurableJob): RuntimeTaskState {
  if (task.jobs.some((entry) => entry.id === job.id)) {
    throw new Error(`runtime task ${task.taskId} already contains job ${job.id}`);
  }
  if (task.jobs.some(activeRuntimeJob)) {
    throw new Error(`runtime task ${task.taskId} already has an active job`);
  }
  return { ...task, jobs: [...task.jobs, job] };
}

export function replaceJob(
  task: RuntimeTaskState,
  jobId: string,
  transform: (job: DurableJob) => DurableJob,
): RuntimeTaskState {
  let found = false;
  const jobs = task.jobs.map((job) => {
    if (job.id !== jobId) return job;
    found = true;
    return transform(job);
  });
  if (!found) throw new Error(`runtime task ${task.taskId} has no job ${jobId}`);
  return { ...task, jobs };
}

export function runtimeReservation(
  id: string,
  taskId: string,
  sessionId: string,
  now: IsoTimestamp,
  operationId?: string,
): DurableReservation {
  return {
    schemaVersion: 1,
    id,
    taskId,
    ownerSessionId: sessionId,
    ...(operationId === undefined ? {} : { operationId }),
    phase: "reserved",
    createdAt: now,
  };
}

export function durableOperation(
  id: string,
  taskId: string,
  kind: DurableOperationKind,
  role: DurableOperation["role"],
  generation: number,
  inputHead: string,
  policyDigest: string,
  instructionRevision: number,
  jobId: string,
  claimOwner: string,
  createdAt: IsoTimestamp,
): DurableOperation {
  return {
    schemaVersion: 1,
    id: singleLine(id, "operation id"),
    taskId: singleLine(taskId, "operation task id"),
    kind,
    role,
    generation,
    inputHead: singleLine(inputHead, "operation input head"),
    policyDigest: singleLine(policyDigest, "operation policy digest"),
    instructionRevision,
    jobId: singleLine(jobId, "operation job id"),
    phase: "prepared",
    fencingRevision: 1,
    claimOwner: singleLine(claimOwner, "operation claim owner"),
    createdAt,
    effects: [],
  };
}

export function workerRoleForTask(task: TaskRecord): WorkerRole {
  return task.kind === "scout" ? "scout" : "implementer";
}

export function roleChannel(role: WorkerRole): "implementation" | "review" {
  return role === "reviewer" || role === "verifier" ? "review" : "implementation";
}

export function reportPathFor(jobPath: string): string {
  return join(dirname(jobPath), "report.txt");
}

export function jobDirectoryFor(
  home: string,
  taskId: string,
  generation: number,
  jobId: string,
): string {
  return join(taskJobsDirectory(home, taskId), String(generation), jobId);
}

export function jobPaths(directory: string): Readonly<{ jobPath: string; resultPath: string }> {
  return { jobPath: join(directory, "job.json"), resultPath: join(directory, "result.json") };
}

export function currentWriter(runtime: RuntimeTaskState): Endpoint | undefined {
  const writer = runtime.endpoints.find(
    (endpoint) => endpoint.role === "scout" || endpoint.role === "implementer",
  );
  return writer;
}

export function reviewFindings(task: TaskRecord): readonly Finding[] {
  const findings: Finding[] = [];
  for (const review of task.reviews) {
    if (review.head !== task.reviewHead || review.generation !== task.generation || review.pass)
      continue;
    findings.push(...review.findings);
  }
  return findings;
}

export function buildPrompt(
  task: TaskRecord,
  role: WorkerRole,
  reportPath: string,
  artifacts: readonly string[],
  review: AgentBriefReview | undefined,
  extraInstructions: readonly string[] = [],
): string {
  const guidance = task.policy.guidance[roleChannel(role)].map((entry) => entry.text);
  return buildAgentBrief({
    role,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    instructions: [...guidance, ...extraInstructions],
    reportPath,
    ...(review === undefined ? {} : { review }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
  });
}

export function makeDurableJob(
  taskId: string,
  generation: number,
  role: DurableJob["role"],
  kind: DurableJob["kind"],
  cwd: string,
  jobPath: string,
  resultPath: string,
  attempt: number,
  now: IsoTimestamp,
  extras: Readonly<{
    operationId?: string;
    endpoint?: Endpoint;
    head?: string;
    reviewLens?: ReviewLens;
    receiptPath?: string;
    instructionRevision?: number;
  }> = {},
): DurableJob {
  return {
    schemaVersion: 1,
    id: jobPath.split("/").at(-2) ?? jobPath,
    taskId,
    generation,
    role,
    kind,
    cwd,
    jobPath,
    resultPath,
    attempt,
    phase: "reserved",
    launchAttempted: false,
    createdAt: now,
    ...(extras.operationId === undefined ? {} : { operationId: extras.operationId }),
    ...(extras.endpoint === undefined ? {} : { endpoint: extras.endpoint }),
    ...(extras.head === undefined ? {} : { head: extras.head }),
    ...(extras.reviewLens === undefined ? {} : { reviewLens: extras.reviewLens }),
    ...(extras.receiptPath === undefined ? {} : { receiptPath: extras.receiptPath }),
    ...(extras.instructionRevision === undefined
      ? {}
      : { instructionRevision: extras.instructionRevision }),
  };
}

export function workerCommand(scriptPath: string, jobPath: string): readonly string[] {
  return ["bun", scriptPath, jobPath];
}

export function taskNameFor(task: TaskRecord): string {
  return `tandem-${task.id}`;
}
export function endpointLaunchFor(
  reservation: DurableReservation,
  sessionId: string,
  taskName: string,
  workspaceLabel: string,
  cwd: string,
  role: Endpoint["role"],
  generation: number,
  now: IsoTimestamp,
  parentWorkspaceId: string | undefined,
  operationId?: string,
): DurableEndpointLaunch {
  return {
    schemaVersion: 1,
    reservationId: reservation.id,
    ...(operationId === undefined ? {} : { operationId }),
    sessionId,
    taskName,
    workspaceLabel: singleLine(workspaceLabel, "workspaceLabel"),
    cwd,
    role,
    generation,
    createdAt: now,
    ...(parentWorkspaceId === undefined ? {} : { parentWorkspaceId }),
  };
}

export function serializedIdentity(value: unknown, field: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${field} could not be serialized`);
  return serialized;
}

export function taskFingerprint(task: TaskRecord): string {
  return serializedIdentity(task, "task record");
}
export function taskWithQuestion(task: TaskRecord, question: TaskQuestion): TaskRecord {
  if (task.communication?.question?.id === question.id) return task;
  const notifications = [...task.notifications];
  const latest = notifications.at(-1);
  if (latest !== undefined) {
    notifications[notifications.length - 1] = { ...latest, kind: "coordinator" };
  }
  return {
    ...task,
    communication: {
      ...(task.communication ?? { revision: 0, messages: [] }),
      question,
    },
    notifications,
  };
}
export function instructionOptions(
  revision: number | undefined,
): Readonly<{ readonly instructionRevision?: number }> {
  return revision === undefined ? {} : { instructionRevision: revision };
}
export function taskWithQuestionCommit(
  task: TaskRecord,
  question: TaskQuestion,
  now: IsoTimestamp,
): TaskRecord {
  const updated = taskWithQuestion(task, question);
  return updated === task ? task : { ...updated, revision: task.revision + 1, updatedAt: now };
}

export function inputEventKey(jobId: string, event: TaskEvent): string {
  return `${jobId}:${serializedIdentity(event, "task event")}`;
}

export function hasEvidenceSuffix(
  task: TaskRecord,
  evidence: readonly TaskRecord["validationEvidence"][number][],
): boolean {
  if (evidence.length > task.validationEvidence.length) return false;
  const start = task.validationEvidence.length - evidence.length;
  return JSON.stringify(task.validationEvidence.slice(start)) === JSON.stringify(evidence);
}

export function recognizesAppliedEvent(task: TaskRecord, event: TaskEvent): boolean {
  switch (event.type) {
    case "scout-report-complete":
      return (
        task.kind === "scout" &&
        task.stage === "completed" &&
        task.generation === event.generation &&
        task.reportPath === event.reportPath
      );
    case "implementation-complete":
      return (
        task.kind === "implementation" &&
        task.generation === event.generation &&
        task.reviewHead === event.head &&
        task.reportPath === event.reportPath &&
        task.stage !== "implementing"
      );
    case "validation-succeeded":
      return (
        task.kind === "implementation" &&
        task.reviewHead === event.head &&
        task.generation === event.generation &&
        hasEvidenceSuffix(task, event.evidence) &&
        ["reviewing", "awaiting-fixes", "ready", "merged"].includes(task.stage)
      );
    case "validation-failed":
      return (
        task.kind === "implementation" &&
        task.reviewHead === event.head &&
        task.generation === event.generation &&
        hasEvidenceSuffix(task, event.evidence) &&
        ["awaiting-fixes", "implementing", "validating"].includes(task.stage)
      );
    case "record-review":
      return (
        task.kind === "implementation" &&
        task.reviewHead === event.review.head &&
        task.generation === event.review.generation &&
        task.reviews.some((review) => JSON.stringify(review) === JSON.stringify(event.review))
      );
    case "block":
      return task.stage === "blocked" && task.blockReason === event.reason;
    default:
      return false;
  }
}

export function taskInputFor(
  request: TaskCreationRequest,
  repoPath: string,
  policy: TaskRecord["policy"],
): StoreTaskInput {
  return {
    repoPath,
    kind: request.kind,
    objective: text(request.objective, "objective"),
    acceptanceCriteria: readTextList(request.acceptanceCriteria, "acceptanceCriteria"),
    surfaces: readTextList(request.surfaces, "surfaces"),
    policy,
  };
}
