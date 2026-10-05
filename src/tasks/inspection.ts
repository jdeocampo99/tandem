import { access, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { readCheckpoint } from "../adapters/git.ts";
import { EndpointOwnershipError } from "../adapters/primitives.ts";
import type { BlockCause, CommandRunner, Endpoint, ReviewMode, TaskRecord } from "../contracts.ts";
import { activeRuntimeJob, taskRuntime } from "../runtime/activity.ts";
import { readRuntimeState } from "../runtime/persistence.ts";
import type {
  DurableJob,
  DurableReservation,
  RuntimeJobPhase,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import { describeError, reportPathFor } from "../service/records.ts";
import { taskCheckoutPath } from "../service/source.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import { fixRoundBudget } from "./findings.ts";

export type InspectionDependencies = Readonly<{
  readonly run: CommandRunner;
  readonly terminal: TerminalBackend;
  readonly runtimePath: string;
}>;

export type TaskEndpointState = "alive" | "stopped" | "missing" | "foreign" | "unknown";
export type TaskOwnershipState = "owned" | "foreign" | "unknown";
export type TaskJobState = Readonly<{
  readonly id: string;
  readonly role: DurableJob["role"];
  readonly kind: DurableJob["kind"];
  readonly phase: RuntimeJobPhase;
  readonly generation: number;
  readonly head?: string;
  readonly contract?: DurableJob["contract"];
  readonly endpointPaneId?: string;
  readonly jobPath: string;
  readonly resultPath: string;
  readonly resultExists: boolean;
  readonly terminal: boolean;
  readonly active: boolean;
  readonly error?: string;
}>;
export type TaskInspection = Readonly<{
  readonly taskId: string;
  /** The request this task belongs to. */
  readonly requestId?: string;
  readonly stage: TaskRecord["stage"];
  readonly generation: number;
  readonly reviewRound: number;
  readonly codeFixRounds: Readonly<{
    readonly used: number;
    readonly remaining: number;
    readonly max: number;
  }>;
  readonly review: Readonly<{
    readonly reviewedHead?: string;
    readonly currentHead?: string;
    readonly mode?: ReviewMode;
    readonly exactHead: boolean;
    readonly clean: boolean;
    readonly unmerged: boolean;
  }>;
  readonly repository: Readonly<{
    readonly recordedPath: string;
    readonly canonicalPath?: string;
    readonly sourcePath?: string;
    readonly identity: "proven" | "missing" | "ambiguous";
  }>;
  readonly branch?: string;
  readonly worktree: Readonly<{
    readonly path?: string;
    readonly head?: string;
    readonly clean?: boolean;
    readonly unmerged?: boolean;
    readonly preserved: true;
  }>;
  readonly lease: Readonly<{
    readonly state: "none" | "recorded" | "released" | "unknown";
    readonly id?: string;
    readonly holder?: string;
    readonly path?: string;
  }>;
  readonly endpoints: readonly Readonly<{
    readonly endpoint: Endpoint;
    readonly state: TaskEndpointState;
    readonly ownership: TaskOwnershipState;
    readonly detail?: string;
  }>[];
  readonly jobs: readonly TaskJobState[];
  readonly artifacts: readonly Readonly<{
    readonly path: string;
    readonly kind: "job" | "result" | "report" | "validation" | "provenance";
    readonly exists: boolean;
  }>[];
  readonly reservations: readonly Readonly<{
    readonly id: string;
    readonly phase: DurableReservation["phase"];
    readonly ownerSessionId: string;
    readonly operationId?: string;
    readonly stale: boolean;
  }>[];
  readonly operations: readonly Readonly<{
    readonly id: string;
    readonly phase: string;
    readonly kind: string;
    readonly jobId: string;
    readonly error?: string;
  }>[];
  readonly pullRequest?: TaskRecord["pullRequest"];
  /** The typed cause behind the task's current block, when the blocking site recorded one. */
  readonly blockCause?: BlockCause;
  readonly blocked: boolean;
  readonly safetyReasons: readonly string[];
}>;

type EndpointObservation = TaskInspection["endpoints"][number];

type GitObservation = Readonly<{
  readonly head?: string;
  readonly base?: string;
  readonly diff?: string;
  readonly dirty?: boolean;
  readonly unmerged?: boolean;
}>;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function canonical(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
async function gitCommonDirectory(
  deps: InspectionDependencies,
  path: string,
): Promise<string | undefined> {
  const root = await gitText(deps.run, path, ["rev-parse", "--show-toplevel"]);
  const common = await gitText(deps.run, path, ["rev-parse", "--git-common-dir"]);
  if (root === undefined || common === undefined) return undefined;
  return canonical(resolve(root, common));
}

async function sharesGitRepository(
  deps: InspectionDependencies,
  first: string,
  second: string,
): Promise<boolean> {
  const [firstCommon, secondCommon] = await Promise.all([
    gitCommonDirectory(deps, first),
    gitCommonDirectory(deps, second),
  ]);
  return firstCommon !== undefined && firstCommon === secondCommon;
}

/** The worktree's checkpoint, or nothing when it cannot be read. */
async function checkpoint(
  deps: Pick<InspectionDependencies, "run">,
  path: string | undefined,
  baseRef: string | undefined,
): Promise<GitObservation> {
  if (path === undefined) return {};
  try {
    const value = await readCheckpoint(deps.run, {
      repo: path,
      ...(baseRef === undefined ? {} : { baseRef }),
    });
    return value;
  } catch {
    return {};
  }
}

async function gitText(
  run: CommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await run({ argv: ["git", "-C", cwd, ...args], cwd });
    if (result.code !== 0) return undefined;
    const value = result.stdout.trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function jobForEndpoint(runtime: RuntimeTaskState, endpoint: Endpoint): DurableJob | undefined {
  const byPane = runtime.jobs.find(
    (job) =>
      job.endpoint?.terminal === endpoint.terminal && job.endpoint?.paneId === endpoint.paneId,
  );
  return (
    byPane ??
    runtime.jobs.find(
      (job) =>
        job.endpoint?.terminal === endpoint.terminal && job.endpoint?.tabId === endpoint.tabId,
    )
  );
}

function jobState(job: DurableJob, resultExists: boolean): TaskJobState {
  return {
    id: job.id,
    role: job.role,
    kind: job.kind,
    phase: job.phase,
    generation: job.generation,
    ...(job.head === undefined ? {} : { head: job.head }),
    ...(job.contract === undefined ? {} : { contract: job.contract }),
    ...(job.endpoint?.paneId === undefined ? {} : { endpointPaneId: job.endpoint.paneId }),
    jobPath: job.jobPath,
    resultPath: job.resultPath,
    resultExists,
    terminal: !activeRuntimeJob(job),
    active: activeRuntimeJob(job),
    ...(job.error === undefined ? {} : { error: job.error }),
  };
}

function artifactPaths(
  task: TaskRecord,
  runtime: RuntimeTaskState | undefined,
): readonly Readonly<{
  path: string;
  kind: "job" | "result" | "report" | "validation" | "provenance";
}>[] {
  const values: {
    path: string;
    kind: "job" | "result" | "report" | "validation" | "provenance";
  }[] = [];
  if (task.reportPath !== undefined) values.push({ path: task.reportPath, kind: "report" });
  if (runtime?.reviewProvenancePath !== undefined) {
    values.push({ path: runtime.reviewProvenancePath, kind: "provenance" });
  }
  for (const job of runtime?.jobs ?? []) {
    values.push({ path: job.jobPath, kind: job.kind === "validation" ? "validation" : "job" });
    values.push({ path: job.resultPath, kind: "result" });
    values.push({ path: reportPathFor(job.jobPath), kind: "report" });
  }
  const seen = new Set<string>();
  return values.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

async function endpointObservation(
  deps: InspectionDependencies,
  endpoint: Endpoint,
  cwd: string | undefined,
  job: DurableJob | undefined,
): Promise<EndpointObservation> {
  if (cwd === undefined) {
    return { endpoint, state: "unknown", ownership: "unknown", detail: "no worktree path" };
  }
  try {
    const inspection = await deps.terminal.inspect({ endpoint, cwd });
    return {
      endpoint,
      state: inspection.activeWorker ? "alive" : "stopped",
      ownership: "owned",
      detail: job === undefined ? "endpoint has no durable job" : `job ${job.id}`,
    };
  } catch (error) {
    if (error instanceof EndpointOwnershipError) {
      return {
        endpoint,
        state: error.reason === "missing" ? "missing" : "foreign",
        ownership: error.reason === "missing" ? "owned" : "foreign",
        detail: describeError(error),
      };
    }
    return { endpoint, state: "unknown", ownership: "unknown", detail: describeError(error) };
  }
}

/**
 * A read-only view of one task's durable state and the live facts behind it: what `tandem status
 * TASK_ID` prints. It changes nothing.
 */
export async function inspectTask(
  deps: InspectionDependencies,
  task: TaskRecord,
): Promise<TaskInspection> {
  const state = await readRuntimeState(deps.runtimePath);
  const runtime = taskRuntime(state, task.id);
  const worktreePath = runtime?.worktree?.path ?? task.worktree?.path;
  const current = await checkpoint(
    deps,
    worktreePath,
    runtime?.worktree?.baseHead ?? task.worktree?.baseHead,
  );
  const canonicalPath = await canonical(taskCheckoutPath(task));
  const configuredSourcePath = runtime?.sourceRepoPath;
  const sourcePath =
    configuredSourcePath === undefined ? undefined : await canonical(configuredSourcePath);
  let identity: TaskInspection["repository"]["identity"];
  if (canonicalPath === undefined) {
    identity = "missing";
  } else if (configuredSourcePath === undefined) {
    identity = "proven";
  } else if (sourcePath === undefined) {
    identity = "ambiguous";
  } else if (
    sourcePath === canonicalPath ||
    (await sharesGitRepository(deps, canonicalPath, sourcePath))
  ) {
    identity = "proven";
  } else {
    identity = "ambiguous";
  }
  const endpointEntries = await Promise.all(
    (runtime?.endpoints ?? task.endpoints ?? []).map((endpoint) =>
      endpointObservation(
        deps,
        endpoint,
        worktreePath,
        runtime?.jobs === undefined ? undefined : jobForEndpoint(runtime, endpoint),
      ),
    ),
  );
  const jobs = await Promise.all(
    (runtime?.jobs ?? []).map(async (job) => jobState(job, await exists(job.resultPath))),
  );
  const artifacts = await Promise.all(
    artifactPaths(task, runtime).map(async (entry) => ({
      ...entry,
      exists: await exists(entry.path),
    })),
  );
  const maxFixRounds = fixRoundBudget(task);
  const safetyReasons: string[] = [];
  if (identity === "ambiguous")
    safetyReasons.push("recorded repository and source repository identities differ");
  if (task.stage === "blocked" && task.blockReason === undefined)
    safetyReasons.push("task is blocked");
  if (task.blockReason !== undefined) safetyReasons.push(`task is blocked: ${task.blockReason}`);
  if (
    current.head !== undefined &&
    task.reviewHead !== undefined &&
    current.head !== task.reviewHead
  ) {
    safetyReasons.push(
      `current HEAD ${current.head} does not match reviewed HEAD ${task.reviewHead}`,
    );
  }
  if (
    endpointEntries.some((entry) => entry.ownership === "foreign" || entry.ownership === "unknown")
  ) {
    safetyReasons.push("one or more endpoint identities are not proven owned");
  }
  const reservations =
    runtime?.reservation === undefined
      ? []
      : [
          {
            id: runtime.reservation.id,
            phase: runtime.reservation.phase,
            ownerSessionId: runtime.reservation.ownerSessionId,
            ...(runtime.reservation.operationId === undefined
              ? {}
              : { operationId: runtime.reservation.operationId }),
            stale:
              runtime.reservation.phase !== "released" &&
              !(runtime?.jobs ?? []).some(activeRuntimeJob),
          },
        ];
  const operations =
    runtime?.operation === undefined
      ? []
      : [
          {
            id: runtime.operation.id,
            phase: runtime.operation.phase,
            kind: runtime.operation.kind,
            jobId: runtime.operation.jobId,
            ...(runtime.operation.error === undefined ? {} : { error: runtime.operation.error }),
          },
        ];
  const blocked = task.stage === "blocked" || safetyReasons.length > 0;
  const branch = await gitText(deps.run, worktreePath ?? taskCheckoutPath(task), [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  return {
    taskId: task.id,
    ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
    stage: task.stage,
    generation: task.generation,
    reviewRound: task.reviewRound,
    codeFixRounds: {
      used: task.reviewRound,
      remaining: Math.max(0, maxFixRounds - task.reviewRound),
      max: maxFixRounds,
    },
    review: {
      ...(task.reviewHead === undefined ? {} : { reviewedHead: task.reviewHead }),
      ...(current.head === undefined ? {} : { currentHead: current.head }),
      ...(runtime?.reviewMode === undefined ? {} : { mode: runtime.reviewMode }),
      exactHead: task.reviewHead !== undefined && current.head === task.reviewHead,
      clean: current.dirty === false,
      unmerged: current.unmerged === true,
    },
    repository: {
      recordedPath: task.repoPath,
      ...(canonicalPath === undefined ? {} : { canonicalPath }),
      ...(sourcePath === undefined ? {} : { sourcePath }),
      identity,
    },
    ...(branch === undefined ? {} : { branch }),
    worktree: {
      ...(worktreePath === undefined ? {} : { path: worktreePath }),
      ...(current.head === undefined ? {} : { head: current.head }),
      ...(current.dirty === undefined ? {} : { clean: !current.dirty }),
      ...(current.unmerged === undefined ? {} : { unmerged: current.unmerged }),
      preserved: true,
    },
    lease:
      runtime?.worktree === undefined
        ? { state: "none" as const }
        : {
            state: runtime.reservation?.phase === "released" ? "released" : "recorded",
            ...(runtime.reservation?.id === undefined ? {} : { id: runtime.reservation.id }),
            holder: runtime.worktree.leaseHolder,
            path: runtime.worktree.path,
          },
    endpoints: endpointEntries,
    jobs,
    artifacts,
    reservations,
    operations,
    ...(task.pullRequest === undefined ? {} : { pullRequest: task.pullRequest }),
    ...(task.blockCause === undefined ? {} : { blockCause: task.blockCause }),
    blocked,
    safetyReasons,
  };
}
