import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readCheckpoint } from "../adapters/git.ts";
import { AdapterCommandError } from "../adapters/primitives.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  TaskRecord,
} from "../contracts.ts";
import { activeRuntimeJob, unreleasedReservation } from "../runtime/activity.ts";
import { readRuntimeState, runtimeFile } from "../runtime/persistence.ts";
import type { RuntimePresentation, RuntimeState, RuntimeTaskState } from "../runtime/schema.ts";
import { createTaskStore, type TaskStoreTransaction } from "../tasks/store.ts";
import { withCoordinatorLaunchLock } from "./lock.ts";
import type { SnapshotPane } from "./ownership.ts";
import {
  assertIdleCoordinatorPane,
  commandErrorCode,
  findRunningCoordinator,
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

async function resetCoordinatorsUnlocked(
  run: CommandRunner,
  home: string,
  sessionId: string,
  repoPaths: readonly string[],
  store: TaskStoreTransaction,
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
  for (const task of tasks) {
    if (selectedTaskIds.has(task.id)) {
      assertSafeTaskState(task, runtimeByTaskId.get(task.id));
    }
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
    const record = await findRunningCoordinator(run, { home, sessionId, repoPath });
    if (record !== undefined) liveRecords.push(record);
  }

  let snapshot: readonly SnapshotPane[] | undefined;
  if (liveRecords.length > 0) {
    const first = liveRecords[0];
    if (first === undefined) throw new Error("reset discovered an invalid coordinator record set");
    snapshot = await readSessionSnapshot(run, sessionId, first.worktree.path);
    for (const record of liveRecords) {
      assertIdleCoordinatorPane(snapshot, record);
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
      const latest = await findRunningCoordinator(run, {
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
      assertIdleCoordinatorPane(latestSnapshot, latest);
      await closeCoordinatorPane(run, latest);
      stopped.push(latest);
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

export async function resetCoordinators(
  run: CommandRunner,
  input: Readonly<{
    readonly home: string;
    readonly sessionId: string;
    readonly repoPaths: readonly string[];
  }>,
): Promise<readonly CoordinatorRecord[]> {
  if (typeof run !== "function") throw new TypeError("run must be an argv command runner");
  if (!input || typeof input !== "object") throw new TypeError("reset input must be an object");
  if (!Array.isArray(input.repoPaths)) throw new TypeError("repoPaths must be an array");
  const home = await canonicalHome(input.home);
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
    return store.exclusive((transaction) =>
      resetCoordinatorsUnlocked(run, home, sessionId, repoPaths, transaction),
    );
  });
}
