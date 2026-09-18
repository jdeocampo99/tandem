import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCheckpoint } from "../adapters/git.ts";
import { type HerdrPaneInspection, inspectEndpoint, interruptEndpoint } from "../adapters/herdr.ts";
import { AdapterCommandError, EndpointOwnershipError } from "../adapters/primitives.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  TaskRecord,
} from "../contracts.ts";
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
import { recoverEndpointFromLaunch } from "../tasks/control.ts";
import { type TaskTransitionContext, transitionTask } from "../tasks/lifecycle.ts";
import { createTaskStore, type TaskStore, type TaskStoreTransaction } from "../tasks/store.ts";
import { liveWorkerTerminal } from "../workers/terminal.ts";
import { workerJobForEndpoint } from "../workers/terminal-control.ts";
import { withCoordinatorLaunchLock } from "./lock.ts";
import type { SnapshotPane } from "./ownership.ts";
import {
  assertIdleCoordinatorPane,
  assertStoppedCoordinatorShell,
  commandErrorCode,
  findResetCoordinator,
  parseJson,
  readSessionSnapshot,
  sameCommand,
  snapshotPaneForEndpoint,
} from "./ownership.ts";
import type { CoordinatorRecord } from "./record.ts";
import {
  canonicalHome,
  canonicalPath,
  isRecord,
  ownershipFailure,
  pathIsWithin,
  sessionText,
} from "./record.ts";
import { listCoordinatorRecords } from "./registry.ts";
import { retireCoordinatorWorkspace } from "./workspace.ts";

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

function runtimePresentationHasActiveState(
  runtime: RuntimePresentation,
  sessionId: string,
): boolean {
  return (
    runtime.endpoint?.sessionId === sessionId ||
    runtime.job.endpoint?.sessionId === sessionId ||
    runtime.endpointLaunch !== undefined ||
    unreleasedReservation(runtime.reservation) ||
    activeRuntimeJob(runtime.job)
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
  if (runtime.stopRequest !== undefined) {
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

function isMissingPaneResult(result: CommandResult): boolean {
  if (result.code === 0) return false;
  if (commandErrorCode(result.stdout, result.stderr) === "pane_not_found") return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return /no such pane/.test(output) || /pane.*(?:not found|does not exist|missing)/.test(output);
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
    sameCommand(left.command, right.command)
  );
}

function assertCloseAcknowledgement(result: CommandResult): void {
  const output = result.stdout.trim();
  if (output.length === 0) {
    throw new Error("herdr pane close returned an unknown acknowledgement");
  }
  const value = parseJson(output, "herdr pane close");
  if (!isRecord(value) || !isRecord(value.result) || value.result.type !== "ok") {
    throw new Error("herdr pane close returned an unknown acknowledgement");
  }
}

async function assertIdleResetCoordinator(
  run: CommandRunner,
  panes: readonly SnapshotPane[],
  record: CoordinatorRecord,
): Promise<void> {
  const inspection = await inspectEndpoint(run, {
    endpoint: record.endpoint,
    cwd: record.worktree.path,
  });
  if (inspection.activeWorker) {
    if (
      inspection.processInfo.foregroundProcesses.filter((process) =>
        sameCommand(process.argv, record.command),
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

async function closeCoordinatorPane(run: CommandRunner, record: CoordinatorRecord): Promise<void> {
  const closeRequest: CommandRequest = {
    argv: [
      "herdr",
      "--session",
      record.endpoint.sessionId,
      "pane",
      "close",
      record.endpoint.paneId,
    ],
    cwd: record.worktree.path,
  };
  const closeResult = await run(closeRequest);
  if (closeResult.code !== 0) {
    throw new AdapterCommandError("herdr pane close", closeRequest, closeResult);
  }
  assertCloseAcknowledgement(closeResult);
  const verifyRequest: CommandRequest = {
    argv: ["herdr", "--session", record.endpoint.sessionId, "pane", "get", record.endpoint.paneId],
    cwd: record.worktree.path,
  };
  const verifyResult = await run(verifyRequest);
  if (verifyResult.code === 0) {
    throw new Error(
      `Herdr pane close returned success but coordinator pane ${JSON.stringify(record.endpoint.paneId)} remains present`,
    );
  }
  if (!isMissingPaneResult(verifyResult)) {
    throw new AdapterCommandError("herdr pane close verification", verifyRequest, verifyResult);
  }
}

function assertNoLiveSelectedEndpoint(
  endpoint: Endpoint,
  sessionId: string,
  panes: readonly SnapshotPane[] | undefined,
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

function forceTaskContext(): TaskTransitionContext {
  return {
    now: new Date().toISOString(),
    notificationId: randomUUID(),
  };
}

async function proveForceEndpoint(run: CommandRunner, entry: ForceEndpoint): Promise<boolean> {
  let inspection: HerdrPaneInspection;
  try {
    inspection = await inspectEndpoint(run, { endpoint: entry.endpoint, cwd: entry.cwd });
  } catch (error) {
    if (
      (error instanceof EndpointOwnershipError && error.reason === "missing") ||
      (error instanceof AdapterCommandError && isMissingPaneResult(error.result))
    )
      return false;
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

async function forceCloseEndpoint(run: CommandRunner, entry: ForceEndpoint): Promise<void> {
  if (!(await proveForceEndpoint(run, entry))) return;
  if (entry.job?.kind === "validation") {
    // The validation runner owns detached command groups and reaps them on interrupt.
    await interruptEndpoint(run, { endpoint: entry.endpoint, cwd: entry.cwd });
  }
  const request: CommandRequest = {
    argv: ["herdr", "--session", entry.endpoint.sessionId, "pane", "close", entry.endpoint.paneId],
    cwd: entry.cwd,
  };
  const result = await run(request);
  if (isMissingPaneResult(result)) return;
  if (result.code !== 0) throw new AdapterCommandError("herdr pane close", request, result);
  assertCloseAcknowledgement(result);
  const verify: CommandRequest = {
    argv: ["herdr", "--session", entry.endpoint.sessionId, "pane", "get", entry.endpoint.paneId],
    cwd: entry.cwd,
  };
  const verification = await run(verify);
  if (verification.code === 0) {
    throw new Error(
      `force reset closed pane ${JSON.stringify(entry.endpoint.paneId)} but it remains present`,
    );
  }
  if (!isMissingPaneResult(verification)) {
    throw new AdapterCommandError("herdr pane close verification", verify, verification);
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

async function forceResetCoordinators(
  run: CommandRunner,
  home: string,
  sessionId: string,
  repoPaths: readonly string[],
  store: TaskStoreTransaction,
  tasks: readonly TaskRecord[],
  runtimeByTaskId: ReadonlyMap<string, RuntimeTaskState>,
  selectedTaskIds: ReadonlySet<string>,
  state: RuntimeState,
  lockedPresentationPaths: ReadonlySet<string> | undefined,
): Promise<readonly CoordinatorRecord[]> {
  const selectedPresentations: RuntimePresentation[] = [];
  for (const presentation of state.presentations) {
    const task = tasks.find((entry) => entry.id === presentation.taskId);
    if (task === undefined) {
      if (runtimePresentationHasActiveState(presentation, sessionId)) {
        throw ownershipFailure(
          `active presentation ${JSON.stringify(presentation.id)} has no durable task`,
        );
      }
      continue;
    }
    if (!selectedTaskIds.has(task.id)) continue;
    if (!lockedPresentationPaths?.has(presentation.recordPath)) {
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
    selectedPresentations.push(presentation);
  }

  const liveRecords: CoordinatorRecord[] = [];
  for (const repoPath of repoPaths) {
    const record = await findResetCoordinator(run, { home, sessionId, repoPath });
    if (record !== undefined) liveRecords.push(record);
  }
  for (const record of liveRecords) {
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

  const endpointEntries = new Map<string, ForceEndpoint>();
  const taskIdsToCancel = new Set<string>();
  const addEndpoint = (
    endpoint: Endpoint,
    cwd: string,
    job: DurableJob | undefined,
    kind: ForceEndpoint["kind"],
  ): void => {
    if (endpoint.sessionId !== sessionId) {
      throw ownershipFailure(
        `${kind} endpoint ${JSON.stringify(endpoint.paneId)} belongs to session ${JSON.stringify(endpoint.sessionId)}`,
      );
    }
    endpointEntries.set(endpointKey(endpoint), {
      endpoint,
      cwd,
      ...(job === undefined ? {} : { job }),
      kind,
    });
  };
  for (const task of tasks) {
    if (!selectedTaskIds.has(task.id)) continue;
    const runtime = runtimeByTaskId.get(task.id);
    if (
      task.stage !== "cancelled" &&
      task.stage !== "completed" &&
      task.stage !== "merged" &&
      (RESET_ACTIVE_TASK_STAGES.includes(task.stage) ||
        (runtime !== undefined &&
          (runtime.jobs.some(activeRuntimeJob) ||
            unreleasedReservation(runtime.reservation) ||
            runtime.endpointLaunch !== undefined ||
            runtime.stopRequest !== undefined)))
    )
      taskIdsToCancel.add(task.id);
    if (runtime === undefined) {
      for (const endpoint of task.endpoints ?? []) {
        addEndpoint(endpoint, task.worktree?.path ?? task.repoPath, undefined, "task");
      }
      continue;
    }
    const cwd = runtime.worktree?.path ?? task.worktree?.path ?? task.repoPath;
    let launchEndpoint: Endpoint | undefined;
    if (runtime.endpointLaunch !== undefined) {
      if (runtime.reservation !== undefined && runtime.reservation.ownerSessionId !== sessionId) {
        throw ownershipFailure(`task ${JSON.stringify(task.id)} has a foreign endpoint launch`);
      }
      const recovered = await recoverEndpointFromLaunch(run, runtime.endpointLaunch);
      if (recovered.status !== "recovered") {
        throw ownershipFailure(
          `task ${JSON.stringify(task.id)} endpoint launch could not be recovered: ${recovered.detail}`,
        );
      }
      launchEndpoint = recovered.endpoint;
      addEndpoint(launchEndpoint, cwd, undefined, "task");
    }
    for (const endpoint of runtime.endpoints) {
      addEndpoint(endpoint, cwd, workerJobForEndpoint(runtime.jobs, endpoint), "task");
    }
    for (const endpoint of task.endpoints ?? []) {
      addEndpoint(endpoint, cwd, workerJobForEndpoint(runtime.jobs, endpoint), "task");
    }
    for (const job of runtime.jobs) {
      if (!activeRuntimeJob(job) && job.endpoint === undefined) continue;
      const endpoint = activeJobEndpoint(job.endpoint ?? launchEndpoint, job, sessionId, "worker");
      addEndpoint(endpoint, job.cwd, job, "task");
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
  for (const presentation of selectedPresentations) {
    const endpoint = presentation.endpoint ?? presentation.job.endpoint;
    if (endpoint !== undefined) {
      addEndpoint(endpoint, presentation.job.cwd, presentation.job, "presentation");
    }
    if (presentation.endpoint === undefined && presentation.endpointLaunch !== undefined) {
      const recovered = await recoverEndpointFromLaunch(run, presentation.endpointLaunch);
      if (recovered.status !== "recovered") {
        throw ownershipFailure(
          `presentation ${JSON.stringify(presentation.id)} endpoint launch could not be recovered: ${recovered.detail}`,
        );
      }
      addEndpoint(recovered.endpoint, presentation.job.cwd, presentation.job, "presentation");
    }
  }

  for (const entry of endpointEntries.values()) await proveForceEndpoint(run, entry);

  let currentState: RuntimeState = {
    ...state,
    tasks: state.tasks.map((runtime) => {
      const task = tasks.find((entry) => entry.id === runtime.taskId);
      if (task === undefined || !taskIdsToCancel.has(task.id)) return runtime;
      return {
        ...runtime,
        stopRequest: {
          schemaVersion: 1 as const,
          action: "cancel" as const,
          generation: task.generation,
          requestedAt: new Date().toISOString(),
        },
        lastError: "force reset requested",
      };
    }),
  };
  await writeRuntimeState(runtimeFile(home), currentState);

  const stoppedEndpointKeys = new Set<string>();
  const stopped: CoordinatorRecord[] = [];
  const cancelledTaskIds: string[] = [];
  try {
    for (const entry of endpointEntries.values()) {
      await forceCloseEndpoint(run, entry);
      const key = endpointKey(entry.endpoint);
      stoppedEndpointKeys.add(key);
      const task = tasks.find((candidate) => candidate.id === entry.job?.taskId);
      if (task !== undefined) {
        currentState = replaceRuntimeTask(currentState, task.id, (current) => ({
          ...current,
          endpoints: current.endpoints.filter((endpoint) => endpointKey(endpoint) !== key),
          jobs: current.jobs.map((job) =>
            activeRuntimeJob(job) && job.endpoint !== undefined && endpointKey(job.endpoint) === key
              ? { ...job, phase: "failed" as const, error: "cancelled by force reset" }
              : job,
          ),
        }));
      }
      const presentation = selectedPresentations.find(
        (candidate) => candidate.job.id === entry.job?.id,
      );
      if (presentation !== undefined) {
        currentState = replaceRuntimePresentation(currentState, presentation.id, (current) => {
          const { endpoint: _endpoint, ...withoutEndpoint } = current;
          const { endpoint: _jobEndpoint, ...withoutJobEndpoint } = current.job;
          return {
            ...withoutEndpoint,
            job: {
              ...withoutJobEndpoint,
              phase: "failed" as const,
              error: "cancelled by force reset",
            },
            lastError: "cancelled by force reset",
          };
        });
        const record = await readPresentationRecord(presentation.recordPath);
        if (record.status !== "ended" && record.status !== "failed") {
          await writeJsonAtomically(presentation.recordPath, {
            ...record,
            status: "failed",
            error: "cancelled by force reset",
            updatedAt: new Date().toISOString(),
          });
        }
      }
      await writeRuntimeState(runtimeFile(home), currentState);
    }

    const clock = () => new Date().toISOString();
    for (const task of tasks) {
      if (!selectedTaskIds.has(task.id)) continue;
      const runtime = runtimeByTaskId.get(task.id);
      if (taskIdsToCancel.has(task.id)) {
        const nextTask = transitionTask(
          task,
          { type: "cancel", reason: "force reset" },
          forceTaskContext(),
        );
        await store.update(task.id, task.revision, () => nextTask);
        cancelledTaskIds.push(task.id);
      }
      if (runtime !== undefined) {
        currentState = markForceTaskRuntime(currentState, task, stoppedEndpointKeys, clock);
      }
    }
    for (const presentation of selectedPresentations) {
      currentState = replaceRuntimePresentation(currentState, presentation.id, (current) => {
        const {
          endpoint: _endpoint,
          endpointLaunch: _endpointLaunch,
          ...withoutTransient
        } = current;
        const reservation =
          current.reservation === undefined
            ? undefined
            : { ...current.reservation, phase: "released" as const, releasedAt: clock() };
        const job =
          current.job.phase === "reserved" ||
          current.job.phase === "launching" ||
          current.job.phase === "running"
            ? (() => {
                const { endpoint: _jobEndpoint, ...withoutEndpoint } = current.job;
                return {
                  ...withoutEndpoint,
                  phase: "failed" as const,
                  error: "cancelled by force reset",
                };
              })()
            : current.job;
        return {
          ...withoutTransient,
          ...(reservation === undefined ? {} : { reservation }),
          job,
          lastError: "cancelled by force reset",
        };
      });
      const record = await readPresentationRecord(presentation.recordPath);
      if (record.status !== "ended" && record.status !== "failed") {
        await writeJsonAtomically(presentation.recordPath, {
          ...record,
          status: "failed",
          error: "cancelled by force reset",
          updatedAt: clock(),
        });
      }
    }
    await writeRuntimeState(runtimeFile(home), currentState);

    for (const record of liveRecords) {
      const latest = await findResetCoordinator(run, {
        home,
        sessionId,
        repoPath: record.repoPath,
      });
      if (latest === undefined) {
        const snapshot = await readSessionSnapshot(run, sessionId, record.worktree.path);
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
      await closeCoordinatorPane(run, latest);
      stopped.push(latest);
      await retireCoordinatorWorkspace(run, latest);
    }
  } catch (error) {
    if (stoppedEndpointKeys.size === 0 && stopped.length === 0 && cancelledTaskIds.length === 0)
      throw error;
    const endpoints = [...stoppedEndpointKeys].map(
      (key) => endpointEntries.get(key)?.endpoint.paneId,
    );
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `force reset partially completed: cancelled tasks ${JSON.stringify(cancelledTaskIds)}, stopped worker/presentation panes ${JSON.stringify(endpoints)}, closed coordinators ${JSON.stringify(stopped.map((record) => record.repoPath))}; ${cause}`,
      { cause: error },
    );
  }
  return stopped;
}

async function resetCoordinatorsUnlocked(
  run: CommandRunner,
  home: string,
  sessionId: string,
  repoPaths: readonly string[],
  store: TaskStoreTransaction,
  force: boolean,
  lockedPresentationPaths?: ReadonlySet<string>,
): Promise<readonly CoordinatorRecord[]> {
  await listCoordinatorRecords(home, sessionId);
  const tasks = await store.list();
  const state: RuntimeState = await readRuntimeState(runtimeFile(home));
  const tasksById = new Map<string, TaskRecord>();
  const repositoryCache = new Map<string, Promise<string>>();
  const canonicalTaskRepository = (path: string): Promise<string> => {
    const cached = repositoryCache.get(path);
    if (cached !== undefined) return cached;
    const pending = canonicalPath(path, "task.repoPath");
    repositoryCache.set(path, pending);
    return pending;
  };
  const selectedRoots = new Set(repoPaths);
  const selectedTaskIds = new Set<string>();
  for (const task of tasks) {
    tasksById.set(task.id, task);
    const repository = await canonicalTaskRepository(task.repoPath);
    if (selectedRoots.has(repository)) selectedTaskIds.add(task.id);
  }
  const runtimeByTaskId = new Map<string, RuntimeTaskState>();
  for (const runtime of state.tasks) {
    runtimeByTaskId.set(runtime.taskId, runtime);
    const task = tasksById.get(runtime.taskId);
    if (task === undefined && runtimeTaskHasActiveState(runtime, sessionId)) {
      throw ownershipFailure(
        `active runtime task ${JSON.stringify(runtime.taskId)} has no matching durable task record`,
      );
    }
  }
  if (!force) {
    for (const task of tasks) {
      if (selectedTaskIds.has(task.id)) {
        assertSafeTaskState(task, runtimeByTaskId.get(task.id));
      }
    }
  }
  if (force) {
    return forceResetCoordinators(
      run,
      home,
      sessionId,
      repoPaths,
      store,
      tasks,
      runtimeByTaskId,
      selectedTaskIds,
      state,
      lockedPresentationPaths,
    );
  }

  const selectedPresentations: RuntimePresentation[] = [];
  for (const presentation of state.presentations) {
    const task = tasksById.get(presentation.taskId);
    if (task === undefined) {
      if (runtimePresentationHasActiveState(presentation, sessionId)) {
        throw ownershipFailure(
          `active runtime presentation ${JSON.stringify(presentation.id)} has no matching durable task record`,
        );
      }
      continue;
    }
    if (!selectedTaskIds.has(task.id)) continue;
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
    if (activeRuntimeJob(presentation.job)) {
      throw new Error(
        `selected presentation ${JSON.stringify(presentation.id)} has a ${presentation.job.phase} job`,
      );
    }
    selectedPresentations.push(presentation);
  }

  const liveRecords: CoordinatorRecord[] = [];
  for (const repoPath of repoPaths) {
    const record = await findResetCoordinator(run, { home, sessionId, repoPath });
    if (record !== undefined) liveRecords.push(record);
  }

  let snapshot: readonly SnapshotPane[] | undefined;
  if (liveRecords.length > 0) {
    const first = liveRecords[0];
    if (first === undefined) throw new Error("reset discovered an invalid coordinator record set");
    snapshot = await readSessionSnapshot(run, sessionId, first.worktree.path);
    for (const record of liveRecords) {
      await assertIdleResetCoordinator(run, snapshot, record);
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
  }

  const selectedEndpoints = new Map<string, Endpoint>();
  for (const task of tasks) {
    if (!selectedTaskIds.has(task.id)) continue;
    for (const endpoint of task.endpoints ?? []) {
      selectedEndpoints.set(`${endpoint.sessionId}\0${endpoint.paneId}`, endpoint);
    }
    const runtime = runtimeByTaskId.get(task.id);
    for (const endpoint of runtime?.endpoints ?? []) {
      selectedEndpoints.set(`${endpoint.sessionId}\0${endpoint.paneId}`, endpoint);
    }
    for (const job of runtime?.jobs ?? []) {
      if (job.endpoint !== undefined) {
        selectedEndpoints.set(`${job.endpoint.sessionId}\0${job.endpoint.paneId}`, job.endpoint);
      }
    }
  }
  const selectedPresentationEndpoints = selectedPresentations
    .map((presentation) => presentation.endpoint ?? presentation.job.endpoint)
    .filter((endpoint): endpoint is Endpoint => endpoint !== undefined);
  if (
    snapshot === undefined &&
    ([...selectedEndpoints.values()].some((endpoint) => endpoint.sessionId === sessionId) ||
      selectedPresentationEndpoints.some((endpoint) => endpoint.sessionId === sessionId))
  ) {
    snapshot = await readSessionSnapshot(run, sessionId, repoPaths[0] ?? home, true);
  }
  for (const endpoint of selectedEndpoints.values()) {
    assertNoLiveSelectedEndpoint(endpoint, sessionId, snapshot, "worker");
  }
  for (const endpoint of selectedPresentationEndpoints) {
    assertNoLiveSelectedEndpoint(endpoint, sessionId, snapshot, "presentation");
  }

  const stopped: CoordinatorRecord[] = [];
  for (const record of liveRecords) {
    try {
      const latest = await findResetCoordinator(run, {
        home,
        sessionId,
        repoPath: record.repoPath,
      });
      if (latest === undefined) {
        const latestSnapshot = await readSessionSnapshot(run, sessionId, record.worktree.path);
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
      const latestSnapshot = await readSessionSnapshot(run, sessionId, latest.worktree.path);
      await assertIdleResetCoordinator(run, latestSnapshot, latest);
      await closeCoordinatorPane(run, latest);
      stopped.push(latest);
      await retireCoordinatorWorkspace(run, latest);
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

async function withForcePresentationLocks<Result>(
  home: string,
  repoPaths: readonly string[],
  store: TaskStore,
  operation: (paths: ReadonlySet<string>) => Promise<Result>,
): Promise<Result> {
  const paths = await store.exclusive(async (transaction) => {
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
  input: Readonly<{
    readonly home: string;
    readonly sessionId: string;
    readonly repoPaths: readonly string[];
    readonly force?: boolean;
  }>,
): Promise<readonly CoordinatorRecord[]> {
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
  return withCoordinatorLaunchLock(home, sessionId, async () => {
    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => new Date().toISOString(),
      idFactory: randomUUID,
    });
    if (input.force === true) {
      return withForcePresentationLocks(home, repoPaths, store, (paths) =>
        store.exclusive((transaction) =>
          resetCoordinatorsUnlocked(run, home, sessionId, repoPaths, transaction, true, paths),
        ),
      );
    }
    return store.exclusive((transaction) =>
      resetCoordinatorsUnlocked(run, home, sessionId, repoPaths, transaction, false),
    );
  });
}
