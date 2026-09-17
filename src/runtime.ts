import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GitCheckpoint } from "./adapters.ts";
import type {
  Endpoint,
  IdFactory,
  IsoTimestamp,
  ReviewLens,
  TaskRecord,
  WorktreeLease,
} from "./contracts.ts";
import type { WorkerRole } from "./jobs.ts";
import type { TaskStore } from "./store.ts";

const RUNTIME_SCHEMA_VERSION = 1;

export type RuntimeJobPhase = "reserved" | "launching" | "running" | "consumed" | "failed";
export type RuntimeReservationPhase = "reserved" | "worktree" | "endpoint" | "released";
export type RuntimeJobKind = "worker" | "validation";

export type DurableJobConsumption = Readonly<{
  readonly schemaVersion: 1;
  readonly inputEventKey: string;
  readonly appliedEventKey: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly beforeFingerprint: string;
  readonly taskFingerprint: string;
  readonly now: IsoTimestamp;
  readonly notificationId: string;
}>;

export type DurableJob = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly role: WorkerRole | "validation";
  readonly kind: RuntimeJobKind;
  readonly cwd: string;
  readonly jobPath: string;
  readonly resultPath: string;
  readonly attempt: number;
  readonly phase: RuntimeJobPhase;
  readonly launchAttempted: boolean;
  readonly createdAt: IsoTimestamp;
  readonly launchedAt?: IsoTimestamp;
  readonly consumedAt?: IsoTimestamp;
  readonly endpoint?: Endpoint;
  readonly head?: string;
  readonly reviewLens?: ReviewLens;
  readonly receiptPath?: string;
  readonly instructionRevision?: number;
  readonly progressWarningAt?: IsoTimestamp;
  readonly consumption?: DurableJobConsumption;
  readonly error?: string;
}>;
export type DurableEndpointLaunch = Readonly<{
  readonly schemaVersion: 1;
  readonly reservationId: string;
  readonly sessionId: string;
  readonly taskName: string;
  readonly workspaceLabel: string;
  readonly cwd: string;
  readonly role: Endpoint["role"];
  readonly generation: number;
  readonly createdAt: IsoTimestamp;
  readonly parentWorkspaceId?: string;
}>;

export type DurableStopRequest = Readonly<{
  readonly schemaVersion: 1;
  readonly action: "pause" | "cancel";
  readonly generation: number;
  readonly requestedAt: IsoTimestamp;
}>;

export type DurableReservation = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly ownerSessionId: string;
  readonly phase: RuntimeReservationPhase;
  readonly createdAt: IsoTimestamp;
  readonly releasedAt?: IsoTimestamp;
}>;

export type RuntimeTaskState = Readonly<{
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly sourceCheckpoint: GitCheckpoint;
  readonly sourceRepoPath?: string;
  readonly taskName: string;
  readonly reservation?: DurableReservation;
  readonly endpointLaunch?: DurableEndpointLaunch;
  readonly stopRequest?: DurableStopRequest;
  readonly worktree?: WorktreeLease;
  readonly endpoints: readonly Endpoint[];
  readonly jobs: readonly DurableJob[];
  readonly sessionDirectory?: string;
  readonly fixContextPath?: string;
  readonly lastError?: string;
  readonly poolAdmissionKey?: string;
  readonly poolNotice?: string;
  readonly terminalCleanupRevision?: number;
}>;

export type RuntimePresentation = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly recordPath: string;
  readonly reservation?: DurableReservation;
  readonly endpointLaunch?: DurableEndpointLaunch;
  readonly job: DurableJob;
  readonly endpoint?: Endpoint;
  readonly lastError?: string;
}>;

export type RuntimeState = Readonly<{
  readonly schemaVersion: 1;
  readonly tasks: readonly RuntimeTaskState[];
  readonly presentations: readonly RuntimePresentation[];
}>;

export type RuntimeMutation = (state: RuntimeState) => RuntimeState | PromiseLike<RuntimeState>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be a non-empty string without NUL characters`);
  }
  return value;
}

function singleLine(value: unknown, field: string): string {
  const result = text(value, field);
  if (/[\r\n\u2028\u2029]/u.test(result)) {
    throw new TypeError(`${field} must be a single-line value`);
  }
  return result;
}

function absolutePath(value: unknown, field: string): string {
  const result = singleLine(value, field);
  if (!isAbsolute(result)) throw new TypeError(`${field} must be absolute`);
  return resolve(result);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
  return value;
}

function enumValue<Value extends string>(
  value: unknown,
  values: readonly Value[],
  field: string,
): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) {
    throw new TypeError(`${field} has an unsupported value`);
  }
  return value as Value;
}
function parseEndpointLaunch(value: unknown, field: string): DurableEndpointLaunch {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const parentWorkspaceId =
    value.parentWorkspaceId === undefined
      ? undefined
      : singleLine(value.parentWorkspaceId, `${field}.parentWorkspaceId`);
  return {
    schemaVersion: 1,
    reservationId: singleLine(value.reservationId, `${field}.reservationId`),
    sessionId: singleLine(value.sessionId, `${field}.sessionId`),
    taskName: singleLine(value.taskName, `${field}.taskName`),
    workspaceLabel: singleLine(value.workspaceLabel, `${field}.workspaceLabel`),
    cwd: absolutePath(value.cwd, `${field}.cwd`),
    role: enumValue(
      value.role,
      ["coordinator", "scout", "implementer", "reviewer", "verifier", "presentation"] as const,
      `${field}.role`,
    ),
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
    createdAt: singleLine(value.createdAt, `${field}.createdAt`),
    ...(parentWorkspaceId === undefined ? {} : { parentWorkspaceId }),
  };
}

function parseStopRequest(value: unknown, field: string): DurableStopRequest {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return {
    schemaVersion: 1,
    action: enumValue(value.action, ["pause", "cancel"] as const, `${field}.action`),
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
    requestedAt: singleLine(value.requestedAt, `${field}.requestedAt`),
  };
}

function parseJobConsumption(value: unknown, field: string): DurableJobConsumption {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return {
    schemaVersion: 1,
    inputEventKey: text(value.inputEventKey, `${field}.inputEventKey`),
    appliedEventKey: text(value.appliedEventKey, `${field}.appliedEventKey`),
    beforeRevision: nonNegativeInteger(value.beforeRevision, `${field}.beforeRevision`),
    afterRevision: nonNegativeInteger(value.afterRevision, `${field}.afterRevision`),
    beforeFingerprint: text(value.beforeFingerprint, `${field}.beforeFingerprint`),
    taskFingerprint: text(value.taskFingerprint, `${field}.taskFingerprint`),
    now: singleLine(value.now, `${field}.now`),
    notificationId: singleLine(value.notificationId, `${field}.notificationId`),
  };
}

function endpoint(value: unknown, field: string): Endpoint {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const role = enumValue(
    value.role,
    ["coordinator", "scout", "implementer", "reviewer", "verifier", "presentation"] as const,
    `${field}.role`,
  );
  return {
    sessionId: singleLine(value.sessionId, `${field}.sessionId`),
    workspaceId: singleLine(value.workspaceId, `${field}.workspaceId`),
    tabId: singleLine(value.tabId, `${field}.tabId`),
    paneId: singleLine(value.paneId, `${field}.paneId`),
    role,
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
  };
}

function checkpoint(value: unknown, field: string): GitCheckpoint {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const diff = value.diff;
  if (typeof diff !== "string" || diff.includes("\0")) {
    throw new TypeError(`${field}.diff must be text without NUL characters`);
  }
  return {
    head: singleLine(value.head, `${field}.head`),
    base: singleLine(value.base, `${field}.base`),
    diff,
    dirty: boolean(value.dirty, `${field}.dirty`),
    unmerged: boolean(value.unmerged, `${field}.unmerged`),
  };
}

function worktree(value: unknown, field: string): WorktreeLease {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return {
    root: absolutePath(value.root, `${field}.root`),
    path: absolutePath(value.path, `${field}.path`),
    name: singleLine(value.name, `${field}.name`),
    baseHead: singleLine(value.baseHead, `${field}.baseHead`),
    branch: singleLine(value.branch, `${field}.branch`),
    leaseId: singleLine(value.leaseId, `${field}.leaseId`),
    leaseHolder: singleLine(value.leaseHolder, `${field}.leaseHolder`),
    leasedAt: singleLine(value.leasedAt, `${field}.leasedAt`),
  };
}

function parseReservation(value: unknown, field: string): DurableReservation {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const releasedAt =
    value.releasedAt === undefined
      ? undefined
      : singleLine(value.releasedAt, `${field}.releasedAt`);
  return {
    schemaVersion: 1,
    id: singleLine(value.id, `${field}.id`),
    taskId: singleLine(value.taskId, `${field}.taskId`),
    ownerSessionId: singleLine(value.ownerSessionId, `${field}.ownerSessionId`),
    phase: enumValue(
      value.phase,
      ["reserved", "worktree", "endpoint", "released"] as const,
      `${field}.phase`,
    ),
    createdAt: singleLine(value.createdAt, `${field}.createdAt`),
    ...(releasedAt === undefined ? {} : { releasedAt }),
  };
}

function parseJob(value: unknown, field: string): DurableJob {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const role = enumValue(
    value.role,
    ["scout", "implementer", "reviewer", "verifier", "presentation", "validation"] as const,
    `${field}.role`,
  );
  const kind = enumValue(value.kind, ["worker", "validation"] as const, `${field}.kind`);
  const launchedAt =
    value.launchedAt === undefined
      ? undefined
      : singleLine(value.launchedAt, `${field}.launchedAt`);
  const consumedAt =
    value.consumedAt === undefined
      ? undefined
      : singleLine(value.consumedAt, `${field}.consumedAt`);
  const endpointValue =
    value.endpoint === undefined ? undefined : endpoint(value.endpoint, `${field}.endpoint`);
  const head = value.head === undefined ? undefined : singleLine(value.head, `${field}.head`);
  const reviewLens =
    value.reviewLens === undefined
      ? undefined
      : enumValue(
          value.reviewLens,
          ["behavior", "design", "coverage", "verification"] as const,
          `${field}.reviewLens`,
        );
  const receiptPath =
    value.receiptPath === undefined
      ? undefined
      : absolutePath(value.receiptPath, `${field}.receiptPath`);
  const instructionRevision =
    value.instructionRevision === undefined
      ? undefined
      : nonNegativeInteger(value.instructionRevision, `${field}.instructionRevision`);
  const progressWarningAt =
    value.progressWarningAt === undefined
      ? undefined
      : singleLine(value.progressWarningAt, `${field}.progressWarningAt`);
  const error = value.error === undefined ? undefined : text(value.error, `${field}.error`);
  const consumption =
    value.consumption === undefined
      ? undefined
      : parseJobConsumption(value.consumption, `${field}.consumption`);
  if (kind === "validation" && role !== "validation") {
    throw new TypeError(`${field}.role must be validation for validation jobs`);
  }
  if (kind === "worker" && role === "validation") {
    throw new TypeError(`${field}.role cannot be validation for worker jobs`);
  }
  return {
    schemaVersion: 1,
    id: singleLine(value.id, `${field}.id`),
    taskId: singleLine(value.taskId, `${field}.taskId`),
    generation: nonNegativeInteger(value.generation, `${field}.generation`),
    role,
    kind,
    cwd: absolutePath(value.cwd, `${field}.cwd`),
    jobPath: absolutePath(value.jobPath, `${field}.jobPath`),
    resultPath: absolutePath(value.resultPath, `${field}.resultPath`),
    attempt: positiveInteger(value.attempt, `${field}.attempt`),
    phase: enumValue(
      value.phase,
      ["reserved", "launching", "running", "consumed", "failed"] as const,
      `${field}.phase`,
    ),
    launchAttempted: boolean(value.launchAttempted, `${field}.launchAttempted`),
    createdAt: singleLine(value.createdAt, `${field}.createdAt`),
    ...(launchedAt === undefined ? {} : { launchedAt }),
    ...(consumption === undefined ? {} : { consumption }),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    ...(endpointValue === undefined ? {} : { endpoint: endpointValue }),
    ...(head === undefined ? {} : { head }),
    ...(reviewLens === undefined ? {} : { reviewLens }),
    ...(receiptPath === undefined ? {} : { receiptPath }),
    ...(instructionRevision === undefined ? {} : { instructionRevision }),
    ...(progressWarningAt === undefined ? {} : { progressWarningAt }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseTask(value: unknown, field: string): RuntimeTaskState {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const reservation =
    value.reservation === undefined
      ? undefined
      : parseReservation(value.reservation, `${field}.reservation`);
  const endpointLaunch =
    value.endpointLaunch === undefined
      ? undefined
      : parseEndpointLaunch(value.endpointLaunch, `${field}.endpointLaunch`);
  const stopRequest =
    value.stopRequest === undefined
      ? undefined
      : parseStopRequest(value.stopRequest, `${field}.stopRequest`);
  const worktreeValue =
    value.worktree === undefined ? undefined : worktree(value.worktree, `${field}.worktree`);
  if (!Array.isArray(value.endpoints)) throw new TypeError(`${field}.endpoints must be an array`);
  if (!Array.isArray(value.jobs)) throw new TypeError(`${field}.jobs must be an array`);
  const endpoints = value.endpoints.map((entry, index) =>
    endpoint(entry, `${field}.endpoints[${index}]`),
  );
  const jobs = value.jobs.map((entry, index) => parseJob(entry, `${field}.jobs[${index}]`));
  const sourceRepoPath =
    value.sourceRepoPath === undefined
      ? undefined
      : absolutePath(value.sourceRepoPath, `${field}.sourceRepoPath`);
  const sessionDirectory =
    value.sessionDirectory === undefined
      ? undefined
      : absolutePath(value.sessionDirectory, `${field}.sessionDirectory`);
  const fixContextPath =
    value.fixContextPath === undefined
      ? undefined
      : absolutePath(value.fixContextPath, `${field}.fixContextPath`);
  const poolAdmissionKey =
    value.poolAdmissionKey === undefined
      ? undefined
      : text(value.poolAdmissionKey, `${field}.poolAdmissionKey`);
  const poolNotice =
    value.poolNotice === undefined ? undefined : text(value.poolNotice, `${field}.poolNotice`);
  const terminalCleanupRevision =
    value.terminalCleanupRevision === undefined
      ? undefined
      : nonNegativeInteger(value.terminalCleanupRevision, `${field}.terminalCleanupRevision`);
  const lastError =
    value.lastError === undefined ? undefined : text(value.lastError, `${field}.lastError`);
  return {
    schemaVersion: 1,
    taskId: singleLine(value.taskId, `${field}.taskId`),
    sourceCheckpoint: checkpoint(value.sourceCheckpoint, `${field}.sourceCheckpoint`),
    ...(sourceRepoPath === undefined ? {} : { sourceRepoPath }),
    taskName: singleLine(value.taskName, `${field}.taskName`),
    ...(reservation === undefined ? {} : { reservation }),
    ...(endpointLaunch === undefined ? {} : { endpointLaunch }),
    ...(stopRequest === undefined ? {} : { stopRequest }),
    ...(worktreeValue === undefined ? {} : { worktree: worktreeValue }),
    endpoints,
    jobs,
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    ...(fixContextPath === undefined ? {} : { fixContextPath }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(poolAdmissionKey === undefined ? {} : { poolAdmissionKey }),
    ...(poolNotice === undefined ? {} : { poolNotice }),
    ...(terminalCleanupRevision === undefined ? {} : { terminalCleanupRevision }),
  };
}
function parsePresentation(value: unknown, field: string): RuntimePresentation {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const endpointLaunch =
    value.endpointLaunch === undefined
      ? undefined
      : parseEndpointLaunch(value.endpointLaunch, `${field}.endpointLaunch`);
  const reservation =
    value.reservation === undefined
      ? undefined
      : parseReservation(value.reservation, `${field}.reservation`);
  const endpointValue =
    value.endpoint === undefined ? undefined : endpoint(value.endpoint, `${field}.endpoint`);
  const lastError =
    value.lastError === undefined ? undefined : text(value.lastError, `${field}.lastError`);
  const job = parseJob(value.job, `${field}.job`);
  if (job.kind !== "worker" || job.role !== "presentation") {
    throw new TypeError(`${field}.job must be a presentation worker job`);
  }
  return {
    schemaVersion: 1,
    id: singleLine(value.id, `${field}.id`),
    taskId: singleLine(value.taskId, `${field}.taskId`),
    recordPath: absolutePath(value.recordPath, `${field}.recordPath`),
    ...(reservation === undefined ? {} : { reservation }),
    ...(endpointLaunch === undefined ? {} : { endpointLaunch }),
    job,
    ...(endpointValue === undefined ? {} : { endpoint: endpointValue }),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

export function parseRuntimeState(value: unknown, source = "runtime state"): RuntimeState {
  if (!isRecord(value)) throw new TypeError(`${source} must be an object`);
  if (value.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
    throw new TypeError(`${source}.schemaVersion must be ${RUNTIME_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.tasks)) throw new TypeError(`${source}.tasks must be an array`);
  if (!Array.isArray(value.presentations))
    throw new TypeError(`${source}.presentations must be an array`);
  const tasks = value.tasks.map((entry, index) => parseTask(entry, `${source}.tasks[${index}]`));
  const presentations = value.presentations.map((entry, index) =>
    parsePresentation(entry, `${source}.presentations[${index}]`),
  );
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.taskId))
      throw new TypeError(`${source} contains duplicate task ${task.taskId}`);
    taskIds.add(task.taskId);
  }
  const presentationIds = new Set<string>();
  for (const presentation of presentations) {
    if (presentationIds.has(presentation.id)) {
      throw new TypeError(`${source} contains duplicate presentation ${presentation.id}`);
    }
    presentationIds.add(presentation.id);
  }
  return { schemaVersion: 1, tasks, presentations };
}

export function emptyRuntimeState(): RuntimeState {
  return { schemaVersion: 1, tasks: [], presentations: [] };
}

function describeFailure(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

export function runtimeFile(home: string): string {
  const root = resolve(home);
  if (!isAbsolute(root)) throw new TypeError("home must resolve to an absolute directory");
  return join(root, "runtime.json");
}

export function jobsDirectory(home: string): string {
  return join(resolve(home), "jobs");
}

export function taskJobsDirectory(home: string, taskId: string): string {
  return join(jobsDirectory(home), taskId);
}

export function presentationsDirectory(home: string): string {
  return join(resolve(home), "presentations");
}

export function taskSessionDirectory(home: string, taskId: string): string {
  return join(resolve(home), "sessions", taskId);
}

export async function readRuntimeState(path: string): Promise<RuntimeState> {
  const runtimePath = absolutePath(path, "runtime path");
  let contents: string;
  try {
    contents = await readFile(runtimePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return emptyRuntimeState();
    throw new Error(`could not read runtime state at ${runtimePath}: ${describeFailure(error)}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`runtime state at ${runtimePath} is invalid JSON: ${describeFailure(error)}`, {
      cause: error,
    });
  }
  return parseRuntimeState(parsed, runtimePath);
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const destination = absolutePath(path, "destination path");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeTextAtomically(path: string, value: string): Promise<void> {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError("text value must be a string without NUL characters");
  }
  const destination = absolutePath(path, "destination path");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeRuntimeState(path: string, state: RuntimeState): Promise<void> {
  const parsed = parseRuntimeState(state, "runtime state");
  await writeJsonAtomically(path, parsed);
}

export async function updateRuntimeState(
  store: TaskStore,
  path: string,
  mutation: RuntimeMutation,
): Promise<RuntimeState> {
  if (typeof mutation !== "function") throw new TypeError("runtime mutation must be a function");
  return store.exclusive(async () => {
    const current = await readRuntimeState(path);
    const next = parseRuntimeState(await mutation(current), "runtime state mutation");
    await writeRuntimeState(path, next);
    return next;
  });
}

export function taskRuntime(state: RuntimeState, taskId: string): RuntimeTaskState | undefined {
  return state.tasks.find((entry) => entry.taskId === taskId);
}

export function presentationRuntime(
  state: RuntimeState,
  id: string,
): RuntimePresentation | undefined {
  return state.presentations.find((entry) => entry.id === id);
}

export function activeRuntimeJob(job: DurableJob): boolean {
  return job.phase === "reserved" || job.phase === "launching" || job.phase === "running";
}

export function activeReservations(state: RuntimeState): number {
  let count = 0;
  for (const task of state.tasks) {
    if (task.reservation !== undefined && task.reservation.phase !== "released") count += 1;
  }
  for (const presentation of state.presentations) {
    if (presentation.reservation !== undefined && presentation.reservation.phase !== "released")
      count += 1;
  }
  return count;
}

export function taskHasActiveJob(task: RuntimeTaskState): boolean {
  return task.jobs.some(activeRuntimeJob);
}

export function taskRecordForRuntime(
  task: TaskRecord,
  runtime: RuntimeTaskState | undefined,
): RuntimeTaskState | undefined {
  if (runtime === undefined || runtime.taskId !== task.id) return undefined;
  return runtime;
}

export function defaultIdFactory(): IdFactory {
  return () => randomUUID();
}
