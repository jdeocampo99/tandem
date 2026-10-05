import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCheckpoint } from "../adapters/git.ts";
import type { CommandRunner, Endpoint, TaskRecord } from "../contracts.ts";
import { harnessFor } from "../harness/resolve.ts";
import { withPresentationLock } from "../presentations/lock.ts";
import { readPresentationRecord } from "../presentations/records.ts";
import { activeRuntimeJob, unreleasedReservation } from "../runtime/activity.ts";
import {
  readRuntimeState,
  runtimeFile,
  writeJsonAtomically,
  writeRuntimeState,
} from "../runtime/persistence.ts";
import type {
  DurableJob,
  RuntimePresentation,
  RuntimeState,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import { replaceRuntimePresentation, replaceRuntimeTask } from "../service/records.ts";
import { recoverEndpointFromLaunch } from "../tasks/endpoint-launch.ts";
import { transitionTask } from "../tasks/lifecycle.ts";
import { createTaskStore, type TaskStore, type TaskStoreTransaction } from "../tasks/store.ts";
import type {
  EndpointInspection,
  SessionPane,
  TerminalBackend,
} from "../terminal-backend/contract.ts";
import { liveWorkerTerminal } from "../workers/terminal.ts";
import { workerJobForEndpoint } from "../workers/terminal-control.ts";
import { withCoordinatorLaunchLock } from "./lock.ts";
import {
  assertIdleCoordinatorPane,
  assertStoppedCoordinatorShell,
  findResetCoordinator,
  snapshotPaneForEndpoint,
} from "./ownership.ts";
import type { CoordinatorRecord } from "./record.ts";
import {
  canonicalHome,
  canonicalPath,
  ownershipFailure,
  pathIsWithin,
  sessionText,
} from "./record.ts";
import { listCoordinatorRecords } from "./registry.ts";
import { type CoordinatorWorkspaceRetirement, retireCoordinatorWorkspace } from "./workspace.ts";

/** A stopped coordinator plus what happened to its Herdr workspace when it was retired. */
export type RetiredCoordinator = CoordinatorRecord &
  Readonly<{ workspaceRetirement: CoordinatorWorkspaceRetirement }>;

const RESET_ACTIVE_TASK_STAGES: readonly TaskRecord["stage"][] = [
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
];

function runtimeTaskHasActiveState(runtime: RuntimeTaskState, sessionId: string): boolean {
  return (
    runtime.endpoints.some((endpoint) => endpoint.sessionId === sessionId) ||
    runtime.endpointLaunch !== undefined ||
    runtime.stopRequest !== undefined ||
    unreleasedReservation(runtime.reservation) ||
    runtime.jobs.some((job) => job.endpoint?.sessionId === sessionId || activeRuntimeJob(job))
  );
}

function hasSettledTerminalStopIntent(task: TaskRecord, runtime: RuntimeTaskState): boolean {
  return (
    runtime.stopRequest !== undefined &&
    (task.stage === "cancelled" || task.stage === "completed" || task.stage === "merged") &&
    runtime.endpoints.length === 0 &&
    !runtime.jobs.some(activeRuntimeJob) &&
    runtime.operation !== undefined &&
    ["completed", "failed", "cancelled"].includes(runtime.operation.phase)
  );
}

function runtimePresentationHasActiveState(
  runtime: RuntimePresentation,
  sessionId: string,
): boolean {
  return (
    runtime.endpoint?.sessionId === sessionId ||
    runtime.job?.endpoint?.sessionId === sessionId ||
    runtime.endpointLaunch !== undefined ||
    unreleasedReservation(runtime.reservation) ||
    (runtime.job !== undefined && activeRuntimeJob(runtime.job))
  );
}

function assertSafeTaskState(task: TaskRecord, runtime: RuntimeTaskState | undefined): void {
  if (RESET_ACTIVE_TASK_STAGES.includes(task.stage)) {
    throw new Error(`selected task ${JSON.stringify(task.id)} is active at stage ${task.stage}`);
  }
  if (runtime === undefined) return;
  if (runtime.endpointLaunch !== undefined) {
    throw new Error(`selected task ${JSON.stringify(task.id)} has a pending endpoint launch`);
  }
  if (runtime.stopRequest !== undefined && !hasSettledTerminalStopIntent(task, runtime)) {
    throw new Error(`selected task ${JSON.stringify(task.id)} has a pending stop intent`);
  }
  if (unreleasedReservation(runtime.reservation)) {
    throw new Error(`selected task ${JSON.stringify(task.id)} has an unreleased reservation`);
  }
  const activeJob = runtime.jobs.find(activeRuntimeJob);
  if (activeJob !== undefined) {
    throw new Error(
      `selected task ${JSON.stringify(task.id)} has a ${activeJob.phase} ${activeJob.kind} job`,
    );
  }
}

function sameCoordinatorIdentity(left: CoordinatorRecord, right: CoordinatorRecord): boolean {
  return (
    left.repoPath === right.repoPath &&
    left.endpoint.sessionId === right.endpoint.sessionId &&
    left.endpoint.workspaceId === right.endpoint.workspaceId &&
    left.endpoint.tabId === right.endpoint.tabId &&
    left.endpoint.paneId === right.endpoint.paneId &&
    left.worktree.root === right.worktree.root &&
    left.worktree.path === right.worktree.path &&
    left.worktree.name === right.worktree.name &&
    left.worktree.baseHead === right.worktree.baseHead &&
    left.worktree.branch === right.worktree.branch &&
    left.worktree.leaseId === right.worktree.leaseId &&
    left.worktree.leaseHolder === right.worktree.leaseHolder &&
    left.worktree.leasedAt === right.worktree.leasedAt &&
    left.harness === right.harness &&
    harnessFor(left.harness).sameCommand(left.command, right.command)
  );
}

async function assertIdleResetCoordinator(
  terminal: TerminalBackend,
  panes: readonly SessionPane[],
  record: CoordinatorRecord,
): Promise<void> {
  const inspection = await terminal.inspect({
    endpoint: record.endpoint,
    cwd: record.worktree.path,
  });
  if (inspection.activeWorker) {
    if (
      inspection.processInfo.foregroundProcesses.filter((process) =>
        harnessFor(record.harness).sameCommand(process.argv, record.command),
      ).length !== 1
    ) {
      throw ownershipFailure("coordinator foreground process changed before reset");
    }
    assertIdleCoordinatorPane(panes, record);
  } else {
    assertStoppedCoordinatorShell(inspection);
    if (
      inspection.pane.foregroundCwd === undefined ||
      (await canonicalPath(inspection.pane.foregroundCwd, "foreground cwd")) !==
        record.worktree.path
    ) {
      throw ownershipFailure("stopped coordinator pane no longer occupies its recorded worktree");
    }
  }
}

function assertNoLiveSelectedEndpoint(
  endpoint: Endpoint,
  sessionId: string,
  panes: readonly SessionPane[] | undefined,
  description: string,
): void {
  if (endpoint.sessionId !== sessionId) return;
  if (panes === undefined) {
    throw new Error(
      `could not prove that selected ${description} endpoint ${JSON.stringify(endpoint.paneId)} is no longer live`,
    );
  }
  const pane = snapshotPaneForEndpoint(panes, endpoint, description);
  if (pane !== undefined) {
    throw new Error(
      `selected ${description} endpoint ${JSON.stringify(endpoint.paneId)} is still live`,
    );
  }
}

type ForceEndpoint = Readonly<{
  readonly endpoint: Endpoint;
  readonly cwd: string;
  readonly job?: DurableJob;
  readonly kind: "task" | "presentation";
}>;

function endpointKey(endpoint: Endpoint): string {
  return [endpoint.sessionId, endpoint.workspaceId, endpoint.tabId, endpoint.paneId].join("\0");
}

function activeJobEndpoint(
  endpoint: Endpoint | undefined,
  job: DurableJob,
  sessionId: string,
  description: string,
): Endpoint {
  if (endpoint === undefined) {
    throw ownershipFailure(
      `active ${description} job ${JSON.stringify(job.id)} has no durable endpoint identity`,
    );
  }
  if (endpoint.sessionId !== sessionId) {
    throw ownershipFailure(
      `active ${description} endpoint ${JSON.stringify(endpoint.paneId)} belongs to session ${JSON.stringify(endpoint.sessionId)}`,
    );
  }
  return endpoint;
}

async function proveForceEndpoint(
  terminal: TerminalBackend,
  entry: ForceEndpoint,
): Promise<boolean> {
  let inspection: EndpointInspection;
  try {
    inspection = await terminal.inspect({ endpoint: entry.endpoint, cwd: entry.cwd });
  } catch (error) {
    if (terminal.isPaneGone(error)) return false;
    throw error;
  }
  if (
    inspection.pane.foregroundCwd === undefined ||
    (await canonicalPath(inspection.pane.foregroundCwd, "pane cwd")) !==
      (await canonicalPath(entry.cwd, "job cwd"))
  ) {
    throw ownershipFailure(
      `pane ${JSON.stringify(entry.endpoint.paneId)} no longer has its recorded working directory`,
    );
  }
  if (!inspection.activeWorker) return true;
  const job = entry.job;
  if (job === undefined) {
    throw ownershipFailure(
      `live ${entry.kind} endpoint ${JSON.stringify(entry.endpoint.paneId)} has no matching durable job`,
    );
  }
  if (job.role === "validation") {
    const ownsProcess = inspection.processInfo.foregroundProcesses.some(
      (process) =>
        basename(process.argv[0] ?? "") === "bun" &&
        process.argv[1] === fileURLToPath(new URL("../validation-worker.ts", import.meta.url)) &&
        process.argv[2] === job.jobPath,
    );
    if (!ownsProcess) {
      throw ownershipFailure(
        `live validation endpoint ${JSON.stringify(entry.endpoint.paneId)} does not identify durable job ${JSON.stringify(job.id)}`,
      );
    }
    return true;
  }
  try {
    const terminal = await liveWorkerTerminal(inspection, job);
    if (terminal === undefined) {
      throw new Error("interactive worker terminal identity is unavailable");
    }
  } catch (error) {
    throw ownershipFailure(
      `live ${entry.kind} endpoint ${JSON.stringify(entry.endpoint.paneId)} could not prove worker identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return true;
}

async function forceCloseEndpoint(terminal: TerminalBackend, entry: ForceEndpoint): Promise<void> {
  if (!(await proveForceEndpoint(terminal, entry))) return;
  if (entry.job?.kind === "validation") {
    // The validation runner owns detached command groups and reaps them on interrupt.
    await terminal.interrupt({ endpoint: entry.endpoint, cwd: entry.cwd });
  }
  try {
    await terminal.closeOwned({ endpoint: entry.endpoint, cwd: entry.cwd });
  } catch (error) {
    if (!terminal.isPaneGone(error)) throw error;
  }
}

function markForceTaskRuntime(
  state: RuntimeState,
  task: TaskRecord,
  stoppedEndpointKeys: ReadonlySet<string>,
  clock: () => string,
): RuntimeState {
  return replaceRuntimeTask(state, task.id, (current) => {
    const jobs = current.jobs.map((job) => {
      if (!activeRuntimeJob(job)) return job;
      const endpoint = job.endpoint;
      if (endpoint !== undefined && !stoppedEndpointKeys.has(endpointKey(endpoint))) return job;
      return { ...job, phase: "failed" as const, error: "cancelled by force reset" };
    });
    const endpoints = current.endpoints.filter(
      (endpoint) => !stoppedEndpointKeys.has(endpointKey(endpoint)),
    );
    const reservation =
      current.reservation === undefined
        ? undefined
        : {
            ...current.reservation,
            phase: "released" as const,
            releasedAt: clock(),
          };
    const {
      endpointLaunch: _endpointLaunch,
      stopRequest: _stopRequest,
      reservation: _currentReservation,
      poolAdmissionKey: _poolAdmissionKey,
      poolNotice: _poolNotice,
      ...withoutTransient
    } = current;
    return {
      ...withoutTransient,
      ...(reservation === undefined ? {} : { reservation }),
      endpoints,
      jobs,
      lastError: "cancelled by force reset",
    };
  });
}

type ResetScope = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly repoPaths: readonly string[];
}>;

/** Durable task and runtime state read once under the task store lock, with the tasks being reset. */
type ResetSelection = Readonly<{
  readonly tasks: readonly TaskRecord[];
  readonly tasksById: ReadonlyMap<string, TaskRecord>;
  readonly selectedTaskIds: ReadonlySet<string>;
  readonly runtimeByTaskId: ReadonlyMap<string, RuntimeTaskState>;
  readonly state: RuntimeState;
}>;

type ForceResetPlan = Readonly<{
  readonly presentations: readonly RuntimePresentation[];
  readonly liveRecords: readonly CoordinatorRecord[];
  readonly endpoints: ReadonlyMap<string, ForceEndpoint>;
  readonly taskIdsToCancel: ReadonlySet<string>;
}>;

/** What a force reset has already changed, reported if a later step fails. */
type ForceResetProgress = {
  readonly stoppedEndpointKeys: Set<string>;
  readonly cancelledTaskIds: string[];
  readonly stopped: RetiredCoordinator[];
};

function selectedTasks(selection: ResetSelection): readonly TaskRecord[] {
  return selection.tasks.filter((task) => selection.selectedTaskIds.has(task.id));
}

async function findLiveCoordinators(
  run: CommandRunner,
  terminal: TerminalBackend,
  scope: ResetScope,
): Promise<CoordinatorRecord[]> {
  const records: CoordinatorRecord[] = [];
  for (const repoPath of scope.repoPaths) {
    const record = await findResetCoordinator(run, terminal, {
      home: scope.home,
      sessionId: scope.sessionId,
      repoPath,
    });
    if (record !== undefined) records.push(record);
  }
  return records;
}

async function assertCleanCoordinatorSource(
  run: CommandRunner,
  record: CoordinatorRecord,
): Promise<void> {
  const checkpoint = await readCheckpoint(run, { repo: record.worktree.path });
  if (checkpoint.dirty || checkpoint.unmerged) {
    throw new Error(
      `coordinator source worktree ${JSON.stringify(record.worktree.path)} is not clean`,
    );
  }
  if (checkpoint.head !== record.worktree.baseHead) {
    throw new Error(
      `coordinator source worktree ${JSON.stringify(record.worktree.path)} HEAD ${JSON.stringify(
        checkpoint.head,
      )} does not match lease base HEAD ${JSON.stringify(record.worktree.baseHead)}`,
    );
  }
}

async function readResetSelection(
  scope: ResetScope,
  transaction: TaskStoreTransaction,
): Promise<ResetSelection> {
  await listCoordinatorRecords(scope.home, scope.sessionId);
  const tasks = await transaction.list();
  const state: RuntimeState = await readRuntimeState(runtimeFile(scope.home));
  const selectedRoots = new Set(scope.repoPaths);
  const repositoryByPath = new Map<string, Promise<string>>();
  const tasksById = new Map<string, TaskRecord>();
  const selectedTaskIds = new Set<string>();
  for (const task of tasks) {
    tasksById.set(task.id, task);
    let repository = repositoryByPath.get(task.repoPath);
    if (repository === undefined) {
      repository = canonicalPath(task.repoPath, "task.repoPath");
      repositoryByPath.set(task.repoPath, repository);
    }
    if (selectedRoots.has(await repository)) selectedTaskIds.add(task.id);
  }
  const runtimeByTaskId = new Map<string, RuntimeTaskState>();
  for (const runtime of state.tasks) {
    runtimeByTaskId.set(runtime.taskId, runtime);
    if (!tasksById.has(runtime.taskId) && runtimeTaskHasActiveState(runtime, scope.sessionId)) {
      throw ownershipFailure(
        `active runtime task ${JSON.stringify(runtime.taskId)} has no matching durable task record`,
      );
    }
  }
  return { tasks, tasksById, selectedTaskIds, runtimeByTaskId, state };
}

function forceCancelsTask(task: TaskRecord, runtime: RuntimeTaskState | undefined): boolean {
  if (task.stage === "cancelled" || task.stage === "completed" || task.stage === "merged") {
    return false;
  }
  return (
    RESET_ACTIVE_TASK_STAGES.includes(task.stage) ||
    (runtime !== undefined &&
      (runtime.jobs.some(activeRuntimeJob) ||
        unreleasedReservation(runtime.reservation) ||
        runtime.endpointLaunch !== undefined ||
        runtime.stopRequest !== undefined))
  );
}

async function selectForcePresentations(
  selection: ResetSelection,
  sessionId: string,
  lockedPresentationPaths: ReadonlySet<string>,
): Promise<RuntimePresentation[]> {
  const selected: RuntimePresentation[] = [];
  for (const presentation of selection.state.presentations) {
    const task = selection.tasksById.get(presentation.taskId);
    if (task === undefined) {
      if (runtimePresentationHasActiveState(presentation, sessionId)) {
        throw ownershipFailure(
          `active presentation ${JSON.stringify(presentation.id)} has no durable task`,
        );
      }
      continue;
    }
    if (!selection.selectedTaskIds.has(task.id)) continue;
    if (!lockedPresentationPaths.has(presentation.recordPath)) {
      throw new Error("selected presentations changed while acquiring reset locks; retry reset");
    }
    const record = await readPresentationRecord(presentation.recordPath);
    if (record.id !== presentation.id || record.taskId !== task.id) {
      throw ownershipFailure(
        `presentation ${JSON.stringify(presentation.id)} record identity changed`,
      );
    }
    if (
      presentation.reservation !== undefined &&
      presentation.reservation.phase !== "released" &&
      presentation.reservation.ownerSessionId !== sessionId
    ) {
      throw ownershipFailure(
        `presentation ${JSON.stringify(presentation.id)} reservation belongs to another session`,
      );
    }
    selected.push(presentation);
  }
  return selected;
}

function addForceEndpoint(
  entries: Map<string, ForceEndpoint>,
  sessionId: string,
  entry: ForceEndpoint,
): void {
  if (entry.endpoint.sessionId !== sessionId) {
    throw ownershipFailure(
      `${entry.kind} endpoint ${JSON.stringify(entry.endpoint.paneId)} belongs to session ${JSON.stringify(entry.endpoint.sessionId)}`,
    );
  }
  entries.set(endpointKey(entry.endpoint), entry);
}

/** Collects every endpoint a force reset must close, recovering endpoints of pending launches. */
async function collectForceEndpoints(
  terminal: TerminalBackend,
  sessionId: string,
  selection: ResetSelection,
  presentations: readonly RuntimePresentation[],
): Promise<Map<string, ForceEndpoint>> {
  const entries = new Map<string, ForceEndpoint>();
  const add = (
    endpoint: Endpoint,
    cwd: string,
    job: DurableJob | undefined,
    kind: ForceEndpoint["kind"],
  ) =>
    addForceEndpoint(entries, sessionId, {
      endpoint,
      cwd,
      ...(job === undefined ? {} : { job }),
      kind,
    });
  for (const task of selectedTasks(selection)) {
    const runtime = selection.runtimeByTaskId.get(task.id);
    if (runtime === undefined) {
      for (const endpoint of task.endpoints ?? []) {
        add(endpoint, task.worktree?.path ?? task.repoPath, undefined, "task");
      }
      continue;
    }
    const cwd = runtime.worktree?.path ?? task.worktree?.path ?? task.repoPath;
    let launchEndpoint: Endpoint | undefined;
    if (runtime.endpointLaunch !== undefined) {
      if (runtime.reservation !== undefined && runtime.reservation.ownerSessionId !== sessionId) {
        throw ownershipFailure(`task ${JSON.stringify(task.id)} has a foreign endpoint launch`);
      }
      const recovered = await recoverEndpointFromLaunch(terminal, runtime.endpointLaunch);
      if (recovered.status !== "recovered") {
        throw ownershipFailure(
          `task ${JSON.stringify(task.id)} endpoint launch could not be recovered: ${recovered.detail}`,
        );
      }
      launchEndpoint = recovered.endpoint;
      add(launchEndpoint, cwd, undefined, "task");
    }
    for (const endpoint of [...runtime.endpoints, ...(task.endpoints ?? [])]) {
      add(endpoint, cwd, workerJobForEndpoint(runtime.jobs, endpoint), "task");
    }
    for (const job of runtime.jobs) {
      if (!activeRuntimeJob(job) && job.endpoint === undefined) continue;
      const endpoint = activeJobEndpoint(job.endpoint ?? launchEndpoint, job, sessionId, "worker");
      add(endpoint, job.cwd, job, "task");
    }
    if (
      runtime.reservation !== undefined &&
      runtime.reservation.phase !== "released" &&
      runtime.reservation.ownerSessionId !== sessionId
    ) {
      throw ownershipFailure(
        `task ${JSON.stringify(task.id)} reservation belongs to another session`,
      );
    }
  }
  for (const presentation of presentations) {
    // Only the retired presentation worker had a pane of its own.
    const job = presentation.job;
    if (job === undefined) continue;
    const endpoint = presentation.endpoint ?? job.endpoint;
    if (endpoint !== undefined) {
      add(endpoint, job.cwd, job, "presentation");
    }
    if (presentation.endpoint === undefined && presentation.endpointLaunch !== undefined) {
      const recovered = await recoverEndpointFromLaunch(terminal, presentation.endpointLaunch);
      if (recovered.status !== "recovered") {
        throw ownershipFailure(
          `presentation ${JSON.stringify(presentation.id)} endpoint launch could not be recovered: ${recovered.detail}`,
        );
      }
      add(recovered.endpoint, job.cwd, job, "presentation");
    }
  }
  return entries;
}

/** Proves ownership of everything a force reset will touch before it changes anything. */
async function planForceReset(
  run: CommandRunner,
  terminal: TerminalBackend,
  scope: ResetScope,
  selection: ResetSelection,
  lockedPresentationPaths: ReadonlySet<string>,
): Promise<ForceResetPlan> {
  const presentations = await selectForcePresentations(
    selection,
    scope.sessionId,
    lockedPresentationPaths,
  );
  const liveRecords = await findLiveCoordinators(run, terminal, scope);
  for (const record of liveRecords) await assertCleanCoordinatorSource(run, record);
  const endpoints = await collectForceEndpoints(
    terminal,
    scope.sessionId,
    selection,
    presentations,
  );
  const taskIdsToCancel = new Set(
    selectedTasks(selection)
      .filter((task) => forceCancelsTask(task, selection.runtimeByTaskId.get(task.id)))
      .map((task) => task.id),
  );
  for (const entry of endpoints.values()) await proveForceEndpoint(terminal, entry);
  return { presentations, liveRecords, endpoints, taskIdsToCancel };
}

function requestForceCancellation(
  selection: ResetSelection,
  taskIdsToCancel: ReadonlySet<string>,
  requestedAt: string,
): RuntimeState {
  return {
    ...selection.state,
    tasks: selection.state.tasks.map((runtime) => {
      const task = selection.tasksById.get(runtime.taskId);
      if (task === undefined || !taskIdsToCancel.has(task.id)) return runtime;
      return {
        ...runtime,
        stopRequest: {
          schemaVersion: 1 as const,
          action: "cancel" as const,
          generation: task.generation,
          requestedAt,
        },
        lastError: "force reset requested",
      };
    }),
  };
}

function detachStoppedTaskEndpoint(state: RuntimeState, taskId: string, key: string): RuntimeState {
  return replaceRuntimeTask(state, taskId, (current) => ({
    ...current,
    endpoints: current.endpoints.filter((endpoint) => endpointKey(endpoint) !== key),
    jobs: current.jobs.map((job) =>
      activeRuntimeJob(job) && job.endpoint !== undefined && endpointKey(job.endpoint) === key
        ? { ...job, phase: "failed" as const, error: "cancelled by force reset" }
        : job,
    ),
  }));
}

function detachStoppedPresentationEndpoint(state: RuntimeState, id: string): RuntimeState {
  return replaceRuntimePresentation(state, id, (current) => {
    const { endpoint: _endpoint, ...withoutEndpoint } = current;
    if (current.job === undefined) {
      return { ...withoutEndpoint, lastError: "cancelled by force reset" };
    }
    const { endpoint: _jobEndpoint, ...withoutJobEndpoint } = current.job;
    return {
      ...withoutEndpoint,
      job: { ...withoutJobEndpoint, phase: "failed" as const, error: "cancelled by force reset" },
      lastError: "cancelled by force reset",
    };
  });
}

function markForcePresentationRuntime(
  state: RuntimeState,
  id: string,
  clock: () => string,
): RuntimeState {
  return replaceRuntimePresentation(state, id, (current) => {
    const { endpoint: _endpoint, endpointLaunch: _endpointLaunch, ...withoutTransient } = current;
    const reservation =
      current.reservation === undefined
        ? undefined
        : { ...current.reservation, phase: "released" as const, releasedAt: clock() };
    let job = current.job;
    if (job !== undefined && activeRuntimeJob(job)) {
      const { endpoint: _jobEndpoint, ...withoutEndpoint } = job;
      job = { ...withoutEndpoint, phase: "failed" as const, error: "cancelled by force reset" };
    }
    return {
      ...withoutTransient,
      ...(reservation === undefined ? {} : { reservation }),
      ...(job === undefined ? {} : { job }),
      lastError: "cancelled by force reset",
    };
  });
}

async function failPresentationRecord(recordPath: string, clock: () => string): Promise<void> {
  const record = await readPresentationRecord(recordPath);
  if (record.status === "ended" || record.status === "failed") return;
  await writeJsonAtomically(recordPath, {
    ...record,
    status: "failed",
    error: "cancelled by force reset",
    updatedAt: clock(),
  });
}

/** Closes each planned endpoint, saving runtime state after every close. */
async function closeForceEndpoints(
  terminal: TerminalBackend,
  home: string,
  selection: ResetSelection,
  plan: ForceResetPlan,
  initialState: RuntimeState,
  progress: ForceResetProgress,
): Promise<RuntimeState> {
  let state = initialState;
  for (const entry of plan.endpoints.values()) {
    await forceCloseEndpoint(terminal, entry);
    const key = endpointKey(entry.endpoint);
    progress.stoppedEndpointKeys.add(key);
    const taskId = entry.job?.taskId;
    if (taskId !== undefined && selection.tasksById.has(taskId)) {
      state = detachStoppedTaskEndpoint(state, taskId, key);
    }
    const presentation = plan.presentations.find(
      (candidate) => candidate.job !== undefined && candidate.job.id === entry.job?.id,
    );
    if (presentation !== undefined) {
      state = detachStoppedPresentationEndpoint(state, presentation.id);
      await failPresentationRecord(presentation.recordPath, () => new Date().toISOString());
    }
    await writeRuntimeState(runtimeFile(home), state);
  }
  return state;
}

async function settleForceResetRecords(
  transaction: TaskStoreTransaction,
  home: string,
  selection: ResetSelection,
  plan: ForceResetPlan,
  initialState: RuntimeState,
  progress: ForceResetProgress,
): Promise<void> {
  const clock = () => new Date().toISOString();
  let state = initialState;
  for (const task of selectedTasks(selection)) {
    if (plan.taskIdsToCancel.has(task.id)) {
      const nextTask = transitionTask(
        task,
        { type: "cancel", reason: "force reset" },
        { now: clock(), notificationId: randomUUID() },
      );
      await transaction.update(task.id, task.revision, () => nextTask);
      progress.cancelledTaskIds.push(task.id);
    }
    if (selection.runtimeByTaskId.has(task.id)) {
      state = markForceTaskRuntime(state, task, progress.stoppedEndpointKeys, clock);
    }
  }
  for (const presentation of plan.presentations) {
    state = markForcePresentationRuntime(state, presentation.id, clock);
    await failPresentationRecord(presentation.recordPath, clock);
  }
  await writeRuntimeState(runtimeFile(home), state);
}

async function closeForceCoordinators(
  run: CommandRunner,
  terminal: TerminalBackend,
  scope: ResetScope,
  liveRecords: readonly CoordinatorRecord[],
  stopped: RetiredCoordinator[],
): Promise<void> {
  for (const record of liveRecords) {
    const latest = await findResetCoordinator(run, terminal, {
      home: scope.home,
      sessionId: scope.sessionId,
      repoPath: record.repoPath,
    });
    if (latest === undefined) {
      const snapshot = await terminal.snapshot({
        sessionId: scope.sessionId,
        cwd: record.worktree.path,
      });
      if (snapshotPaneForEndpoint(snapshot, record.endpoint, "coordinator") !== undefined) {
        throw ownershipFailure(
          `coordinator ${JSON.stringify(record.repoPath)} lost its recorded identity`,
        );
      }
      continue;
    }
    if (!sameCoordinatorIdentity(latest, record)) {
      throw ownershipFailure(
        `coordinator record for ${JSON.stringify(record.repoPath)} changed before force reset`,
      );
    }
    await terminal.closeOwned({ endpoint: latest.endpoint, cwd: latest.worktree.path });
    const workspaceRetirement = await retireCoordinatorWorkspace(terminal, scope.home, latest);
    stopped.push({ ...latest, workspaceRetirement });
  }
}

function forcePartialFailure(
  error: unknown,
  plan: ForceResetPlan,
  progress: ForceResetProgress,
): unknown {
  if (
    progress.stoppedEndpointKeys.size === 0 &&
    progress.stopped.length === 0 &&
    progress.cancelledTaskIds.length === 0
  )
    return error;
  const endpoints = [...progress.stoppedEndpointKeys].map(
    (key) => plan.endpoints.get(key)?.endpoint.paneId,
  );
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(
    `force reset partially completed: cancelled tasks ${JSON.stringify(progress.cancelledTaskIds)}, stopped worker/presentation panes ${JSON.stringify(endpoints)}, closed coordinators ${JSON.stringify(progress.stopped.map((record) => record.repoPath))}; ${cause}`,
    { cause: error },
  );
}

async function forceResetCoordinators(
  run: CommandRunner,
  terminal: TerminalBackend,
  scope: ResetScope,
  store: TaskStore,
  selection: ResetSelection,
  lockedPresentationPaths: ReadonlySet<string>,
): Promise<readonly RetiredCoordinator[]> {
  const plan = await planForceReset(run, terminal, scope, selection, lockedPresentationPaths);
  const cancelRequested = requestForceCancellation(
    selection,
    plan.taskIdsToCancel,
    new Date().toISOString(),
  );
  await writeRuntimeState(runtimeFile(scope.home), cancelRequested);

  const progress: ForceResetProgress = {
    stoppedEndpointKeys: new Set(),
    cancelledTaskIds: [],
    stopped: [],
  };
  try {
    const endpointsClosed = await closeForceEndpoints(
      terminal,
      scope.home,
      selection,
      plan,
      cancelRequested,
      progress,
    );
    await store.exclusive((transaction) =>
      settleForceResetRecords(transaction, scope.home, selection, plan, endpointsClosed, progress),
    );
    await closeForceCoordinators(run, terminal, scope, plan.liveRecords, progress.stopped);
  } catch (error) {
    throw forcePartialFailure(error, plan, progress);
  }
  return progress.stopped;
}

function selectIdlePresentations(
  selection: ResetSelection,
  sessionId: string,
): RuntimePresentation[] {
  const selected: RuntimePresentation[] = [];
  for (const presentation of selection.state.presentations) {
    const task = selection.tasksById.get(presentation.taskId);
    if (task === undefined) {
      if (runtimePresentationHasActiveState(presentation, sessionId)) {
        throw ownershipFailure(
          `active runtime presentation ${JSON.stringify(presentation.id)} has no matching durable task record`,
        );
      }
      continue;
    }
    if (!selection.selectedTaskIds.has(task.id)) continue;
    if (presentation.endpointLaunch !== undefined) {
      throw new Error(
        `selected presentation ${JSON.stringify(presentation.id)} has a pending endpoint launch`,
      );
    }
    if (unreleasedReservation(presentation.reservation)) {
      throw new Error(
        `selected presentation ${JSON.stringify(presentation.id)} has an unreleased reservation`,
      );
    }
    if (presentation.job !== undefined && activeRuntimeJob(presentation.job)) {
      throw new Error(
        `selected presentation ${JSON.stringify(presentation.id)} has a ${presentation.job.phase} job`,
      );
    }
    selected.push(presentation);
  }
  return selected;
}

function selectedWorkerEndpoints(selection: ResetSelection): Endpoint[] {
  const endpoints = new Map<string, Endpoint>();
  const add = (endpoint: Endpoint): void => {
    endpoints.set(`${endpoint.sessionId}\0${endpoint.paneId}`, endpoint);
  };
  for (const task of selectedTasks(selection)) {
    for (const endpoint of task.endpoints ?? []) add(endpoint);
    const runtime = selection.runtimeByTaskId.get(task.id);
    for (const endpoint of runtime?.endpoints ?? []) add(endpoint);
    for (const job of runtime?.jobs ?? []) {
      if (job.endpoint !== undefined) add(job.endpoint);
    }
  }
  return [...endpoints.values()];
}

/** Proves each live coordinator is idle with a clean source, returning the snapshot used. */
async function readIdleCoordinatorSnapshot(
  run: CommandRunner,
  terminal: TerminalBackend,
  sessionId: string,
  liveRecords: readonly CoordinatorRecord[],
): Promise<readonly SessionPane[] | undefined> {
  const first = liveRecords[0];
  if (first === undefined) return undefined;
  const snapshot = await terminal.snapshot({ sessionId, cwd: first.worktree.path });
  for (const record of liveRecords) {
    await assertIdleResetCoordinator(terminal, snapshot, record);
    await assertCleanCoordinatorSource(run, record);
  }
  return snapshot;
}

async function closeIdleCoordinators(
  run: CommandRunner,
  terminal: TerminalBackend,
  scope: ResetScope,
  liveRecords: readonly CoordinatorRecord[],
): Promise<readonly RetiredCoordinator[]> {
  const stopped: RetiredCoordinator[] = [];
  for (const record of liveRecords) {
    try {
      const latest = await findResetCoordinator(run, terminal, {
        home: scope.home,
        sessionId: scope.sessionId,
        repoPath: record.repoPath,
      });
      if (latest === undefined) {
        const latestSnapshot = await terminal.snapshot({
          sessionId: scope.sessionId,
          cwd: record.worktree.path,
        });
        const pane = snapshotPaneForEndpoint(latestSnapshot, record.endpoint, "coordinator");
        if (pane === undefined) continue;
        throw ownershipFailure(
          `coordinator pane ${JSON.stringify(record.endpoint.paneId)} no longer proves recorded ownership`,
        );
      }
      if (!sameCoordinatorIdentity(latest, record)) {
        throw ownershipFailure(
          `coordinator record for ${JSON.stringify(record.repoPath)} changed before reset`,
        );
      }
      const latestSnapshot = await terminal.snapshot({
        sessionId: scope.sessionId,
        cwd: latest.worktree.path,
      });
      await assertIdleResetCoordinator(terminal, latestSnapshot, latest);
      await terminal.closeOwned({ endpoint: latest.endpoint, cwd: latest.worktree.path });
      const workspaceRetirement = await retireCoordinatorWorkspace(terminal, scope.home, latest);
      stopped.push({ ...latest, workspaceRetirement });
    } catch (error) {
      if (stopped.length === 0) throw error;
      const stoppedRepos = stopped.map((entry) => entry.repoPath).join(", ");
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `reset closed ${stopped.length} coordinator(s) (${stoppedRepos}) before failing on ${JSON.stringify(
          record.repoPath,
        )}: ${cause}`,
        { cause: error },
      );
    }
  }
  return stopped;
}

async function resetIdleCoordinators(
  run: CommandRunner,
  terminal: TerminalBackend,
  scope: ResetScope,
  selection: ResetSelection,
): Promise<readonly RetiredCoordinator[]> {
  for (const task of selectedTasks(selection)) {
    assertSafeTaskState(task, selection.runtimeByTaskId.get(task.id));
  }
  const presentations = selectIdlePresentations(selection, scope.sessionId);
  const liveRecords = await findLiveCoordinators(run, terminal, scope);
  let snapshot = await readIdleCoordinatorSnapshot(run, terminal, scope.sessionId, liveRecords);

  const workerEndpoints = selectedWorkerEndpoints(selection);
  const presentationEndpoints = presentations
    .map((presentation) => presentation.endpoint ?? presentation.job?.endpoint)
    .filter((endpoint): endpoint is Endpoint => endpoint !== undefined);
  if (
    snapshot === undefined &&
    [...workerEndpoints, ...presentationEndpoints].some(
      (endpoint) => endpoint.sessionId === scope.sessionId,
    )
  ) {
    snapshot = await terminal.snapshot({
      sessionId: scope.sessionId,
      cwd: scope.repoPaths[0] ?? scope.home,
      allowMissingSession: true,
    });
  }
  for (const endpoint of workerEndpoints) {
    assertNoLiveSelectedEndpoint(endpoint, scope.sessionId, snapshot, "worker");
  }
  for (const endpoint of presentationEndpoints) {
    assertNoLiveSelectedEndpoint(endpoint, scope.sessionId, snapshot, "presentation");
  }
  return closeIdleCoordinators(run, terminal, scope, liveRecords);
}

async function withForcePresentationLocks<Result>(
  home: string,
  repoPaths: readonly string[],
  store: TaskStore,
  operation: (paths: ReadonlySet<string>) => Promise<Result>,
): Promise<Result> {
  const paths = await store.serialized(async (transaction) => {
    const selected = new Set<string>();
    for (const task of await transaction.list()) {
      if (repoPaths.includes(await canonicalPath(task.repoPath, "task.repoPath")))
        selected.add(task.id);
    }
    const state = await readRuntimeState(runtimeFile(home));
    return [
      ...new Set(
        state.presentations
          .filter((presentation) => selected.has(presentation.taskId))
          .map((presentation) => presentation.recordPath),
      ),
    ].sort();
  });
  const lockedPaths = new Set(paths);
  const acquire = (index: number): Promise<Result> => {
    const path = paths[index];
    return path === undefined
      ? operation(lockedPaths)
      : withPresentationLock(path, undefined, () => acquire(index + 1));
  };
  // Presentation workflows acquire this lock before the task store lock.
  return acquire(0);
}

export async function resetCoordinators(
  run: CommandRunner,
  terminal: TerminalBackend,
  input: Readonly<{
    readonly home: string;
    readonly sessionId: string;
    readonly repoPaths: readonly string[];
    readonly force?: boolean;
  }>,
): Promise<readonly RetiredCoordinator[]> {
  if (typeof run !== "function") throw new TypeError("run must be an argv command runner");
  if (!input || typeof input !== "object") throw new TypeError("reset input must be an object");
  if (!Array.isArray(input.repoPaths)) throw new TypeError("repoPaths must be an array");
  const home = await canonicalHome(input.home);
  if (input.force !== undefined && typeof input.force !== "boolean") {
    throw new TypeError("force must be boolean when provided");
  }
  const sessionId = sessionText(input.sessionId);
  const repoPaths: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of input.repoPaths.entries()) {
    const repoPath = await canonicalPath(value, `repoPaths[${index}]`);
    if (pathIsWithin(repoPath, home)) {
      throw new Error("Tandem home must remain outside the target repository");
    }
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);
    repoPaths.push(repoPath);
  }
  const scope: ResetScope = { home, sessionId, repoPaths };
  return withCoordinatorLaunchLock(home, sessionId, async () => {
    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => new Date().toISOString(),
      idFactory: randomUUID,
    });
    if (input.force === true) {
      return withForcePresentationLocks(home, repoPaths, store, (paths) =>
        store.serialized(async (transaction) =>
          forceResetCoordinators(
            run,
            terminal,
            scope,
            store,
            await readResetSelection(scope, transaction),
            paths,
          ),
        ),
      );
    }
    return store.serialized(async (transaction) =>
      resetIdleCoordinators(run, terminal, scope, await readResetSelection(scope, transaction)),
    );
  });
}
