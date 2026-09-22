import { access, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readCheckpoint } from "../adapters/git.ts";
import { closeEndpoint, inspectEndpoint } from "../adapters/herdr.ts";
import { EndpointOwnershipError } from "../adapters/primitives.ts";
import type {
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  ReviewMode,
  TaskRecord,
  ValidationEvidence,
} from "../contracts.ts";
import { activeRuntimeJob, taskRuntime } from "../runtime/activity.ts";
import { withStateLock } from "../runtime/database.ts";
import {
  readRuntimeState,
  taskJobsDirectory,
  writeJsonAtomically,
  writeRuntimeState,
} from "../runtime/persistence.ts";
import type {
  DurableJob,
  DurableReservation,
  RuntimeJobPhase,
  RuntimeState,
  RuntimeTaskState,
} from "../runtime/schema.ts";
import {
  describeError,
  isRecord,
  isTerminalTask,
  jobDirectoryFor,
  jobPaths,
  replaceRuntimeTask,
  reportPathFor,
} from "../service/records.ts";
import {
  FINAL_REVIEW_LENSES,
  finalAcceptanceContract,
  ValidationConfigurationError,
} from "../tasks/acceptance.ts";
import { type TaskEvent, transitionTask } from "../tasks/lifecycle.ts";
import type { TaskStore } from "../tasks/store.ts";
import type { ValidationJob, ValidationResult } from "../validation-worker.ts";
import { runValidation } from "../workers/validation.ts";
import {
  classifyEndpointOwnership,
  classifyPriorOutcome,
  RECOVERY_ACTION_REQUIRED_PROOFS,
  type RecoveryDecisionReceipt,
  type RecoveryOwnership,
  type RecoveryPriorOutcome,
  type RecoveryProof,
  type RecoveryProvenFacts,
} from "./decision.ts";
import type { RecoveryAvailabilityWait } from "./wait.ts";

const MAX_RECOVERY_ATTEMPTS = 3;
/** Shared with central recovery's validating re-entry: one budget for every validation retry,
 *  whether spent by the explicit `validation-retry` action or by an automatic infra-loss re-entry. */
export const MAX_VALIDATION_RETRIES = 3;
const MAX_EVIDENCE_REPAIRS = 3;
const REQUIRED_REVIEW_LENSES = FINAL_REVIEW_LENSES;
const LOCK_RETRY_COUNT = 3;

export type RecoveryWorkflowDependencies = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly getTask: (taskId: string) => Promise<TaskRecord>;
  readonly taskInScope: (task: TaskRecord) => Promise<boolean>;
  readonly wake?: (task: TaskRecord) => Promise<void>;
}>;

export type RecoveryEndpointState = "alive" | "stopped" | "missing" | "foreign" | "unknown";
export type RecoveryOwnershipState = "owned" | "foreign" | "unknown";
export type RecoveryJobState = Readonly<{
  readonly id: string;
  readonly role: DurableJob["role"];
  readonly kind: DurableJob["kind"];
  readonly phase: RuntimeJobPhase;
  readonly generation: number;
  readonly head?: string;
  readonly contract?: DurableJob["contract"];
  readonly escalation?: DurableJob["escalation"];
  readonly endpointPaneId?: string;
  readonly jobPath: string;
  readonly resultPath: string;
  readonly resultExists: boolean;
  readonly terminal: boolean;
  readonly active: boolean;
  readonly error?: string;
}>;
export type RecoveryInspection = Readonly<{
  readonly taskId: string;
  /** The request this task belongs to, preserved through every recovery action and wait. */
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
    readonly state: RecoveryEndpointState;
    readonly ownership: RecoveryOwnershipState;
    readonly detail?: string;
  }>[];
  readonly jobs: readonly RecoveryJobState[];
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
  /** Durable receipts of conversational recovery decisions, oldest first. */
  readonly recoveryDecisions: readonly RecoveryDecisionReceipt[];
  /** Durable bounded availability waits, including the ones already settled. */
  readonly availabilityWaits: readonly RecoveryAvailabilityWait[];
  readonly blocked: boolean;
  readonly safetyReasons: readonly string[];
  readonly recommendations: readonly string[];
}>;

export type RecoveryPlan = Readonly<{
  readonly taskId: string;
  readonly dryRun: true;
  readonly blocked: boolean;
  readonly reasons: readonly string[];
  readonly checkpoint: Readonly<{
    readonly safeToReuse: boolean;
    readonly reviewedHead?: string;
    readonly currentHead?: string;
    readonly clean: boolean;
    readonly unmerged: boolean;
  }>;
  readonly staleResources: Readonly<{
    readonly endpointPanes: readonly string[];
    readonly reservationIds: readonly string[];
    readonly jobs: readonly string[];
  }>;
  readonly operation: Readonly<{
    readonly name:
      | "none"
      | "reconcile"
      | "review-existing"
      | "validation-retry"
      | "evidence-repair";
    readonly effect: string;
  }>;
  readonly budget: Readonly<{
    readonly recoveryUsed: number;
    readonly recoveryRemaining: number;
    readonly validationRetriesUsed: number;
    readonly validationRetriesRemaining: number;
    readonly evidenceRepairsUsed: number;
    readonly evidenceRepairsRemaining: number;
  }>;
  readonly refusals: readonly string[];
  readonly recommendedActions: readonly string[];
  /** Ownership and prior-outcome classifications, so a caller never re-derives them from inspection. */
  readonly ownership: RecoveryOwnership;
  readonly priorOutcome: RecoveryPriorOutcome;
  /** Every proof this plan could itself determine; `request-approval-current` is always `true` here
   *  because only a request-aware caller (conversational recovery) can prove it, and it must
   *  overwrite this placeholder before treating an action as preapproved. */
  readonly facts: RecoveryProvenFacts;
}>;

export type ReconciliationResult = Readonly<{
  readonly taskId: string;
  readonly changed: boolean;
  readonly repairedBranch?: string;
  readonly clearedEndpoints: readonly string[];
  readonly settledJobs: readonly string[];
  readonly releasedReservations: readonly string[];
  readonly blocked: boolean;
  readonly reasons: readonly string[];
  readonly worktreePreserved: true;
  readonly recoveryAttempts: number;
}>;

export type ValidationRetryResult = Readonly<{
  readonly taskId: string;
  readonly changed: boolean;
  readonly status: ValidationResult["status"] | "refused";
  readonly failureClass?: "infrastructure" | "validation" | "task-code";
  readonly resultPath?: string;
  readonly head?: string;
  readonly retriesUsed: number;
  readonly retriesRemaining: number;
  readonly reason?: string;
}>;

export type ReviewExistingResult = Readonly<{
  readonly taskId: string;
  readonly changed: boolean;
  readonly status: "started" | "already-started" | "refused";
  readonly head: string;
  readonly mode: "review_existing_head";
  readonly provenancePath?: string;
  readonly reason?: string;
}>;

export type EvidenceRepairResult = Readonly<{
  readonly taskId: string;
  readonly changed: boolean;
  readonly repairedPaths: readonly string[];
  readonly reviewedHead?: string;
  readonly repairsUsed: number;
  readonly repairsRemaining: number;
  readonly reason?: string;
}>;

export type DeliveryPreflightResult = Readonly<{
  readonly taskId: string;
  readonly ready: boolean;
  readonly reviewedHead?: string;
  readonly currentHead?: string;
  readonly branch?: string;
  readonly repository: string;
  readonly base: string;
  readonly checks: readonly Readonly<{
    readonly name: string;
    readonly passed: boolean;
    readonly detail: string;
  }>[];
  readonly refusals: readonly string[];
  readonly duplicatePullRequest?: TaskRecord["pullRequest"];
  /** The task's own draft, which final publication updates in place rather than duplicating. */
  readonly draftPullRequest?: TaskRecord["pullRequest"];
}>;

type EndpointObservation = RecoveryInspection["endpoints"][number];

type GitObservation = Readonly<{
  readonly head?: string;
  readonly base?: string;
  readonly diff?: string;
  readonly dirty?: boolean;
  readonly unmerged?: boolean;
}>;

function timestamp(deps: RecoveryWorkflowDependencies): string {
  return deps.clock();
}

function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function isLockFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /lock|busy|EAGAIN|EWOULDBLOCK/iu.test(`${error.name} ${error.message}`);
}

async function withBoundedLock<Result>(
  deps: RecoveryWorkflowDependencies,
  operation: () => Promise<Result>,
): Promise<Result> {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      return await withStateLock(deps.home, operation, 1_500, 10);
    } catch (error) {
      lastError = error;
      if (!isLockFailure(error) || attempt + 1 === LOCK_RETRY_COUNT) throw error;
      await sleep(25 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

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
  deps: RecoveryWorkflowDependencies,
  path: string,
): Promise<string | undefined> {
  const root = await gitText(deps.run, path, ["rev-parse", "--show-toplevel"]);
  const common = await gitText(deps.run, path, ["rev-parse", "--git-common-dir"]);
  if (root === undefined || common === undefined) return undefined;
  return canonical(resolve(root, common));
}

async function sharesGitRepository(
  deps: RecoveryWorkflowDependencies,
  first: string,
  second: string,
): Promise<boolean> {
  const [firstCommon, secondCommon] = await Promise.all([
    gitCommonDirectory(deps, first),
    gitCommonDirectory(deps, second),
  ]);
  return firstCommon !== undefined && firstCommon === secondCommon;
}

async function repositoryIdentityProven(
  deps: RecoveryWorkflowDependencies,
  recordedPath: string,
  sourcePath: string | undefined,
): Promise<boolean> {
  const recordedCanonical = await canonical(recordedPath);
  if (recordedCanonical === undefined || sourcePath === undefined) {
    return recordedCanonical !== undefined;
  }
  const sourceCanonical = await canonical(sourcePath);
  return (
    sourceCanonical !== undefined &&
    (sourceCanonical === recordedCanonical ||
      (await sharesGitRepository(deps, recordedCanonical, sourceCanonical)))
  );
}

async function runGitChecked(
  deps: RecoveryWorkflowDependencies,
  cwd: string,
  args: readonly string[],
  operation: string,
): Promise<void> {
  const result = await deps.run({ argv: ["git", "-C", cwd, ...args], cwd });
  if (result.code === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(
    `${operation} failed with exit code ${result.code}${detail.length === 0 ? "" : `: ${detail}`}`,
  );
}

async function repairDetachedTaskBranch(
  deps: RecoveryWorkflowDependencies,
  task: TaskRecord,
  inspection: RecoveryInspection,
): Promise<string | undefined> {
  if (
    task.stage !== "blocked" ||
    task.reviewHead === undefined ||
    task.worktree === undefined ||
    inspection.branch !== undefined ||
    !inspection.review.exactHead ||
    !inspection.review.clean ||
    inspection.review.unmerged
  )
    return undefined;
  const path = inspection.worktree.path;
  if (path === undefined) return undefined;
  const branch = task.worktree.branch;
  const branchHead = await gitText(deps.run, path, [
    "rev-parse",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (branchHead !== undefined && branchHead !== task.reviewHead) {
    const ancestor = await deps.run({
      argv: ["git", "-C", path, "merge-base", "--is-ancestor", branchHead, task.reviewHead],
      cwd: path,
    });
    if (ancestor.code !== 0) {
      throw new Error(
        `task branch ${JSON.stringify(branch)} is not an ancestor of reviewed HEAD ${task.reviewHead}`,
      );
    }
    await runGitChecked(
      deps,
      path,
      ["branch", "--force", branch, task.reviewHead],
      "task branch repair",
    );
    await runGitChecked(deps, path, ["switch", "--no-guess", branch], "task branch checkout");
  } else if (branchHead === undefined) {
    await runGitChecked(
      deps,
      path,
      ["switch", "--no-guess", "--create", branch, task.reviewHead],
      "task branch creation",
    );
  } else {
    await runGitChecked(deps, path, ["switch", "--no-guess", branch], "task branch checkout");
  }
  const repairedBranch = await gitText(deps.run, path, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const repairedHead = await gitText(deps.run, path, ["rev-parse", "HEAD"]);
  if (repairedBranch !== branch || repairedHead !== task.reviewHead) {
    throw new Error(
      `task branch repair ended at ${JSON.stringify(repairedBranch)} and ${String(repairedHead)}`,
    );
  }
  return branch;
}

async function checkpoint(
  deps: RecoveryWorkflowDependencies,
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

function repositoryFromRemote(remote: string): string | undefined {
  const value = remote.trim().replace(/\.git$/u, "");
  if (value.startsWith("git@github.com:")) return value.slice("git@github.com:".length);
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    return parsed.pathname.replace(/^\/+/u, "").replace(/\/+$/u, "");
  } catch {
    return /^[^\s/]+\/[^\s/]+$/u.test(value) ? value : undefined;
  }
}

function defaultRecovery(
  runtime: RuntimeTaskState | undefined,
): NonNullable<RuntimeTaskState["recovery"]> {
  return (
    runtime?.recovery ?? {
      schemaVersion: 1,
      recoveryAttempts: 0,
      validationRetries: 0,
      evidenceRepairs: 0,
    }
  );
}

function jobForEndpoint(runtime: RuntimeTaskState, endpoint: Endpoint): DurableJob | undefined {
  const byPane = runtime.jobs.find((job) => job.endpoint?.paneId === endpoint.paneId);
  return byPane ?? runtime.jobs.find((job) => job.endpoint?.tabId === endpoint.tabId);
}

function jobState(job: DurableJob, resultExists: boolean): RecoveryJobState {
  return {
    id: job.id,
    role: job.role,
    kind: job.kind,
    phase: job.phase,
    generation: job.generation,
    ...(job.head === undefined ? {} : { head: job.head }),
    ...(job.contract === undefined ? {} : { contract: job.contract }),
    ...(job.escalation === undefined ? {} : { escalation: job.escalation }),
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
  deps: RecoveryWorkflowDependencies,
  endpoint: Endpoint,
  cwd: string | undefined,
  job: DurableJob | undefined,
): Promise<EndpointObservation> {
  if (cwd === undefined) {
    return { endpoint, state: "unknown", ownership: "unknown", detail: "no worktree path" };
  }
  try {
    const inspection = await inspectEndpoint(deps.run, { endpoint, cwd });
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

function recoveryRecommendations(
  task: TaskRecord,
  runtime: RuntimeTaskState | undefined,
  endpoints: readonly EndpointObservation[],
  jobs: readonly RecoveryJobState[],
  current: GitObservation,
): readonly string[] {
  const recommendations: string[] = [];
  if (endpoints.some((entry) => entry.ownership === "foreign" || entry.ownership === "unknown")) {
    recommendations.push(
      "block and investigate endpoint ownership; do not close or reuse the pane",
    );
  }
  if (endpoints.some((entry) => entry.state === "missing" || entry.state === "stopped")) {
    recommendations.push(
      "reconcile proven missing or stopped endpoints without releasing the worktree",
    );
  }
  if (jobs.some((entry) => entry.active && !entry.resultExists)) {
    recommendations.push(
      "inspect the durable job and use a bounded validation retry or quarantine the operation",
    );
  }
  if (
    task.kind === "implementation" &&
    task.reviewHead !== undefined &&
    current.head === task.reviewHead &&
    current.dirty === false &&
    current.unmerged === false &&
    task.stage === "blocked"
  ) {
    recommendations.push(
      "use review-existing at the exact clean reviewed HEAD; no implementer is needed",
    );
  }
  if (runtime?.reservation !== undefined && runtime.reservation.phase !== "released") {
    recommendations.push(
      "release the reservation only after the operation and all effects are terminal",
    );
  }
  if (recommendations.length === 0)
    recommendations.push("no safe automatic recovery action is currently proven");
  return recommendations;
}

export class RecoveryWorkflow {
  readonly #deps: RecoveryWorkflowDependencies;

  public constructor(deps: RecoveryWorkflowDependencies) {
    this.#deps = deps;
  }

  public async inspect(taskId: string): Promise<RecoveryInspection> {
    const task = await this.#deps.getTask(taskId);
    if (!(await this.#deps.taskInScope(task)))
      throw new Error(`task ${taskId} is outside the repository scope`);
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    const worktreePath = runtime?.worktree?.path ?? task.worktree?.path;
    const current = await checkpoint(
      this.#deps,
      worktreePath,
      runtime?.worktree?.baseHead ?? task.worktree?.baseHead,
    );
    const canonicalPath = await canonical(task.repoPath);
    const configuredSourcePath = runtime?.sourceRepoPath;
    const sourcePath =
      configuredSourcePath === undefined ? undefined : await canonical(configuredSourcePath);
    let identity: RecoveryInspection["repository"]["identity"];
    if (canonicalPath === undefined) {
      identity = "missing";
    } else if (configuredSourcePath === undefined) {
      identity = "proven";
    } else if (sourcePath === undefined) {
      identity = "ambiguous";
    } else if (
      sourcePath === canonicalPath ||
      (await sharesGitRepository(this.#deps, canonicalPath, sourcePath))
    ) {
      identity = "proven";
    } else {
      identity = "ambiguous";
    }
    const endpointEntries = await Promise.all(
      (runtime?.endpoints ?? task.endpoints ?? []).map((endpoint) =>
        endpointObservation(
          this.#deps,
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
    const maxFixRounds = task.policy.config.maxFixRounds;
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
      endpointEntries.some(
        (entry) => entry.ownership === "foreign" || entry.ownership === "unknown",
      )
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
    const branch = await gitText(this.#deps.run, worktreePath ?? task.repoPath, [
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
      recoveryDecisions: runtime?.recoveryDecisions ?? [],
      availabilityWaits: runtime?.recoveryWaits ?? [],
      blocked,
      safetyReasons,
      recommendations: recoveryRecommendations(task, runtime, endpointEntries, jobs, current),
    };
  }

  /**
   * The single planner: an action is proposed only once its own `RecoveryProvenFacts` all hold.
   * There is no second planner layered above this — a caller such as conversational recovery reads
   * `ownership`, `priorOutcome`, and `facts` back from this plan rather than reclassifying them, and
   * may only replace the one fact this plan cannot itself prove (`request-approval-current`).
   */
  public async plan(taskId: string): Promise<RecoveryPlan> {
    const task = await this.#deps.getTask(taskId);
    const inspection = await this.inspect(taskId);
    const runtime = await this.runtime(taskId);
    const recovery = defaultRecovery(runtime);
    const reasons = [...inspection.safetyReasons];
    const refusals: string[] = [];
    const budget = {
      recoveryUsed: recovery.recoveryAttempts,
      recoveryRemaining: Math.max(0, MAX_RECOVERY_ATTEMPTS - recovery.recoveryAttempts),
      validationRetriesUsed: recovery.validationRetries,
      validationRetriesRemaining: Math.max(0, MAX_VALIDATION_RETRIES - recovery.validationRetries),
      evidenceRepairsUsed: recovery.evidenceRepairs,
      evidenceRepairsRemaining: Math.max(0, MAX_EVIDENCE_REPAIRS - recovery.evidenceRepairs),
    };
    const ownership = classifyEndpointOwnership(inspection.endpoints);
    const priorOutcome = classifyPriorOutcome({
      jobs: inspection.jobs,
      operations: inspection.operations,
    });
    const facts: RecoveryProvenFacts = {
      "task-in-scope": true,
      "task-scope-approved": task.scopeApproved,
      // Only a request-aware caller can prove this; conversational recovery overwrites it.
      "request-approval-current": true,
      "repository-identity-proven": inspection.repository.identity === "proven",
      "endpoint-ownership-proven": ownership === "proven-owned",
      "prior-outcome-known": priorOutcome === "known",
      "no-active-durable-job": !inspection.jobs.some((job) => job.active),
      "no-pending-stop-request": runtime?.stopRequest === undefined,
      "reviewed-head-exact-and-clean":
        inspection.review.exactHead && inspection.review.clean && !inspection.review.unmerged,
      "recovery-attempt-budget-remaining": budget.recoveryRemaining > 0,
      "evidence-repair-budget-remaining": budget.evidenceRepairsRemaining > 0,
    };
    let name: RecoveryPlan["operation"]["name"] = "none";
    let effect = "no state change";
    const proposeIfProven = (
      candidate: Exclude<RecoveryPlan["operation"]["name"], "none">,
      candidateEffect: string,
    ): void => {
      const unmet = RECOVERY_ACTION_REQUIRED_PROOFS[candidate].filter(
        (proof: RecoveryProof) => !facts[proof],
      );
      if (unmet.length === 0) {
        name = candidate;
        effect = candidateEffect;
        return;
      }
      reasons.push(`${candidate} is not proposed: unmet proof(s) ${unmet.join(", ")}`);
    };
    if (ownership === "foreign" || ownership === "unknown") {
      refusals.push("endpoint ownership is unknown or foreign; no resource mutation is safe");
    } else if (
      inspection.endpoints.some((entry) => entry.state === "missing" || entry.state === "stopped")
    ) {
      proposeIfProven(
        "reconcile",
        "clear only proven stale endpoint records, repair a detached exact reviewed branch, and preserve worktree",
      );
    } else if (inspection.stage === "blocked" && facts["reviewed-head-exact-and-clean"]) {
      proposeIfProven(
        "review-existing",
        "run validation and launch bounded reviews at the exact existing HEAD without an implementer",
      );
    } else if (inspection.jobs.some((job) => job.kind === "validation" && !job.resultExists)) {
      proposeIfProven(
        "validation-retry",
        "rerun validation in a durable worker-free job, bounded by validation retry budget",
      );
    } else if (inspection.artifacts.some((artifact) => !artifact.exists)) {
      proposeIfProven(
        "evidence-repair",
        "repair durable reports and provenance from existing state without a pane",
      );
    }
    const safeToReuse =
      inspection.review.exactHead &&
      inspection.review.clean &&
      !inspection.review.unmerged &&
      refusals.length === 0;
    return {
      taskId,
      dryRun: true,
      blocked: inspection.blocked || refusals.length > 0,
      reasons,
      checkpoint: {
        safeToReuse,
        ...(inspection.review.reviewedHead === undefined
          ? {}
          : { reviewedHead: inspection.review.reviewedHead }),
        ...(inspection.review.currentHead === undefined
          ? {}
          : { currentHead: inspection.review.currentHead }),
        clean: inspection.review.clean,
        unmerged: inspection.review.unmerged,
      },
      staleResources: {
        endpointPanes: inspection.endpoints
          .filter((entry) => entry.state === "missing" || entry.state === "stopped")
          .map((entry) => entry.endpoint.paneId),
        reservationIds: inspection.reservations
          .filter((entry) => entry.stale)
          .map((entry) => entry.id),
        jobs: inspection.jobs
          .filter((entry) => entry.active && !entry.resultExists)
          .map((entry) => entry.id),
      },
      operation: { name, effect },
      budget,
      refusals,
      recommendedActions: inspection.recommendations,
      ownership,
      priorOutcome,
      facts,
    };
  }

  public async reconcile(taskId: string, approved: boolean): Promise<ReconciliationResult> {
    if (!approved) throw new Error("reconciliation requires explicit approval");
    const inspection = await this.inspect(taskId);
    const task = await this.#deps.getTask(taskId);
    const runtime = await this.runtime(taskId);
    if (runtime === undefined) throw new Error(`runtime task ${taskId} is missing`);
    const foreign = inspection.endpoints.filter(
      (entry) => entry.ownership === "foreign" || entry.ownership === "unknown",
    );
    const recovery = defaultRecovery(runtime);
    if (inspection.repository.identity !== "proven") {
      const reason = "reconciliation refused: canonical repository identity is not proven";
      const blockedChanged =
        !isTerminalTask(task) && task.stage !== "paused" && task.stage !== "blocked";
      await this.block(task, reason);
      return {
        taskId,
        changed: blockedChanged,
        clearedEndpoints: [],
        settledJobs: [],
        releasedReservations: [],
        blocked: true,
        reasons: [reason],
        worktreePreserved: true,
        recoveryAttempts: recovery.recoveryAttempts,
      };
    }
    if (foreign.length > 0) {
      const reason = `reconciliation refused: endpoint ownership is not proven for ${foreign.map((entry) => entry.endpoint.paneId).join(", ")}`;
      const blockedChanged =
        !isTerminalTask(task) && task.stage !== "paused" && task.stage !== "blocked";
      await this.block(task, reason);
      return {
        taskId,
        changed: blockedChanged,
        clearedEndpoints: [],
        settledJobs: [],
        releasedReservations: [],
        blocked: true,
        reasons: [reason],
        worktreePreserved: true,
        recoveryAttempts: recovery.recoveryAttempts,
      };
    }
    if (recovery.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      return {
        taskId,
        changed: false,
        clearedEndpoints: [],
        settledJobs: [],
        releasedReservations: [],
        blocked: true,
        reasons: ["recovery attempt budget is exhausted"],
        worktreePreserved: true,
        recoveryAttempts: recovery.recoveryAttempts,
      };
    }
    let repairedBranch: string | undefined;
    try {
      repairedBranch = await repairDetachedTaskBranch(this.#deps, task, inspection);
    } catch (error) {
      return {
        taskId,
        changed: false,
        clearedEndpoints: [],
        settledJobs: [],
        releasedReservations: [],
        blocked: true,
        reasons: [`task branch repair refused: ${describeError(error)}`],
        worktreePreserved: true,
        recoveryAttempts: recovery.recoveryAttempts,
      };
    }
    const clearedEndpoints: string[] = [];
    const settledJobs: string[] = [];
    const releasedReservations: string[] = [];
    const reasons: string[] =
      repairedBranch === undefined
        ? []
        : [`repaired task branch ${repairedBranch} at reviewed HEAD ${task.reviewHead}`];
    for (const endpointEntry of inspection.endpoints) {
      if (endpointEntry.state !== "missing" && endpointEntry.state !== "stopped") continue;
      const endpoint = endpointEntry.endpoint;
      const job = jobForEndpoint(runtime, endpoint);
      if (endpointEntry.state === "stopped" && runtime.worktree?.path !== undefined) {
        try {
          await closeEndpoint(this.#deps.run, { endpoint, cwd: runtime.worktree.path });
        } catch (error) {
          reasons.push(
            `pane ${endpoint.paneId} could not be closed safely: ${describeError(error)}`,
          );
          continue;
        }
      }
      clearedEndpoints.push(endpoint.paneId);
      if (job !== undefined && activeRuntimeJob(job)) {
        settledJobs.push(job.id);
        reasons.push(`job ${job.id} was quarantined after endpoint ${endpoint.paneId} disappeared`);
      }
    }
    const clearedEndpointPanes = new Set(clearedEndpoints);
    const recordedEndpointPanes = new Set(runtime.endpoints.map((entry) => entry.paneId));
    for (const job of runtime.jobs) {
      if (!activeRuntimeJob(job) || settledJobs.includes(job.id)) continue;
      const paneId = job.endpoint?.paneId;
      if (
        paneId === undefined ||
        (!clearedEndpointPanes.has(paneId) &&
          (runtime.operation?.phase !== "quarantined" || recordedEndpointPanes.has(paneId)))
      )
        continue;
      settledJobs.push(job.id);
      reasons.push(`job ${job.id} was quarantined after endpoint ${paneId} disappeared`);
    }
    const canReleaseReservation =
      runtime.reservation !== undefined &&
      runtime.reservation.phase !== "released" &&
      !runtime.jobs.some(activeRuntimeJob) &&
      (runtime.operation === undefined ||
        ["completed", "failed", "cancelled"].includes(runtime.operation.phase));
    if (canReleaseReservation && runtime.reservation !== undefined)
      releasedReservations.push(runtime.reservation.id);
    const changed =
      repairedBranch !== undefined ||
      clearedEndpoints.length > 0 ||
      settledJobs.length > 0 ||
      releasedReservations.length > 0;
    if (!changed) {
      return {
        taskId,
        changed: false,
        clearedEndpoints: [],
        settledJobs: [],
        releasedReservations: [],
        blocked: task.stage === "blocked",
        reasons: reasons.length === 0 ? ["no proven stale resource was found"] : reasons,
        worktreePreserved: true,
        recoveryAttempts: defaultRecovery(runtime).recoveryAttempts,
      };
    }
    const next = await withBoundedLock(this.#deps, async () =>
      this.#deps.store.exclusive(async (store) => {
        const currentTask = await store.read(taskId);
        if (currentTask === undefined) throw new Error(`task ${taskId} is missing`);
        const state = await readRuntimeState(this.#deps.runtimePath);
        const current = taskRuntime(state, taskId);
        if (current === undefined) throw new Error(`runtime task ${taskId} is missing`);
        const recovery = defaultRecovery(current);
        const updatedRuntime = replaceRuntimeTask(state, taskId, (entry) => {
          let nextEntry = entry;
          if (clearedEndpoints.length > 0) {
            nextEntry = {
              ...nextEntry,
              endpoints: nextEntry.endpoints.filter(
                (entry) => !clearedEndpoints.includes(entry.paneId),
              ),
            };
          }
          if (settledJobs.length > 0) {
            nextEntry = {
              ...nextEntry,
              jobs: nextEntry.jobs.map((job) =>
                settledJobs.includes(job.id)
                  ? { ...job, phase: "failed", error: "endpoint disappeared during recovery" }
                  : job,
              ),
            };
          }
          if (releasedReservations.length > 0 && nextEntry.reservation !== undefined) {
            nextEntry = {
              ...nextEntry,
              reservation: {
                ...nextEntry.reservation,
                phase: "released",
                releasedAt: timestamp(this.#deps),
              },
            };
          }
          return {
            ...nextEntry,
            recovery: {
              ...recovery,
              recoveryAttempts: recovery.recoveryAttempts + 1,
              lastOperation: "reconcile",
              lastAt: timestamp(this.#deps),
            },
          };
        });
        await writeRuntimeState(this.#deps.runtimePath, updatedRuntime);
        const updatedTask =
          currentTask.endpoints === undefined
            ? currentTask
            : await store.update(currentTask.id, currentTask.revision, (entry) => ({
                ...entry,
                revision: entry.revision + 1,
                updatedAt: timestamp(this.#deps),
                ...(entry.endpoints === undefined
                  ? {}
                  : {
                      endpoints: entry.endpoints.filter(
                        (entry) => !clearedEndpoints.includes(entry.paneId),
                      ),
                    }),
              }));
        return { task: updatedTask, runtime: taskRuntime(updatedRuntime, taskId) };
      }),
    );
    return {
      taskId,
      changed: true,
      ...(repairedBranch === undefined ? {} : { repairedBranch }),
      clearedEndpoints,
      settledJobs,
      releasedReservations,
      blocked: next.task.stage === "blocked",
      reasons,
      worktreePreserved: true,
      recoveryAttempts: defaultRecovery(next.runtime).recoveryAttempts,
    };
  }

  public async reviewExisting(
    taskId: string,
    head: string,
    approved: boolean,
  ): Promise<ReviewExistingResult> {
    if (!approved) throw new Error("review-existing requires explicit approval");
    const task = await this.#deps.getTask(taskId);
    const runtime = await this.runtime(taskId);
    if (task.kind !== "implementation")
      return {
        taskId,
        changed: false,
        status: "refused",
        head,
        mode: "review_existing_head",
        reason: "only implementation tasks can use review-existing",
      };
    if (task.reviewHead !== head)
      return {
        taskId,
        changed: false,
        status: "refused",
        head,
        mode: "review_existing_head",
        reason: `requested HEAD ${head} does not match durable reviewed HEAD ${String(task.reviewHead)}`,
      };
    const recovery = defaultRecovery(runtime);
    if (recovery.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      return {
        taskId,
        changed: false,
        status: "refused",
        head,
        mode: "review_existing_head",
        reason: "recovery attempt budget is exhausted",
      };
    }
    const path = runtime?.worktree?.path ?? task.worktree?.path;
    const current = await checkpoint(
      this.#deps,
      path,
      runtime?.worktree?.baseHead ?? task.worktree?.baseHead,
    );
    if (
      path === undefined ||
      current.head !== head ||
      current.dirty !== false ||
      current.unmerged !== false
    )
      return {
        taskId,
        changed: false,
        status: "refused",
        head,
        mode: "review_existing_head",
        reason: "review-existing requires the exact clean, unmerged HEAD",
      };
    if ((runtime?.jobs ?? []).some(activeRuntimeJob)) {
      return {
        taskId,
        changed: false,
        status: "refused",
        head,
        mode: "review_existing_head",
        reason: "an active durable job must be reconciled before review-existing",
      };
    }
    if (runtime === undefined) {
      return {
        taskId,
        changed: false,
        status: "refused",
        head,
        mode: "review_existing_head",
        reason: "durable runtime task is missing",
      };
    }
    if (!(await repositoryIdentityProven(this.#deps, task.repoPath, runtime.sourceRepoPath))) {
      return {
        taskId,
        changed: false,
        status: "refused",
        head,
        mode: "review_existing_head",
        reason: "review-existing could not prove canonical repository identity",
      };
    }
    const provenancePath = join(
      taskJobsDirectory(this.#deps.home, task.id),
      String(task.generation),
      "review-existing.json",
    );
    await writeJsonAtomically(provenancePath, {
      schemaVersion: 1,
      mode: "review_existing_head",
      taskId,
      generation: task.generation,
      head,
      diffEmpty: current.diff === "",
      subject: "full implementation at exact HEAD",
      worktree: path,
    });
    const began = await withBoundedLock(this.#deps, async () =>
      this.#deps.store.exclusive(async (store) => {
        const currentTask = await store.read(taskId);
        if (currentTask === undefined) throw new Error(`task ${taskId} is missing`);
        const state = await readRuntimeState(this.#deps.runtimePath);
        const currentRuntime = taskRuntime(state, taskId);
        if (currentRuntime === undefined) throw new Error(`runtime task ${taskId} is missing`);
        const reviewsComplete =
          currentTask.reviews.filter(
            (review) =>
              review.head === head && review.generation === currentTask.generation && review.pass,
          ).length >= REQUIRED_REVIEW_LENSES.length &&
          REQUIRED_REVIEW_LENSES.every((lens) =>
            currentTask.reviews.some(
              (review) =>
                review.lens === lens &&
                review.head === head &&
                review.generation === currentTask.generation &&
                review.pass,
            ),
          );
        if (
          (currentTask.stage === "validating" ||
            currentTask.stage === "reviewing" ||
            (currentTask.stage === "ready" && reviewsComplete)) &&
          currentRuntime.reviewMode === "review_existing_head"
        )
          return { task: currentTask, runtime: currentRuntime, changed: false };
        const transitioned = transitionTask(
          currentTask,
          { type: "begin-existing-review", head, generation: currentTask.generation },
          { now: timestamp(this.#deps), notificationId: this.#deps.idFactory() },
        );
        const updatedRuntime: RuntimeState = replaceRuntimeTask(state, taskId, (entry) => {
          const recovery = defaultRecovery(entry);
          return {
            ...entry,
            reviewMode: "review_existing_head",
            reviewProvenancePath: provenancePath,
            recovery: {
              ...recovery,
              recoveryAttempts: recovery.recoveryAttempts + 1,
              lastOperation: "review-existing",
              lastAt: timestamp(this.#deps),
            },
          };
        });
        await writeRuntimeState(this.#deps.runtimePath, updatedRuntime);
        const saved = await store.update(currentTask.id, currentTask.revision, () => transitioned);
        return { task: saved, runtime: taskRuntime(updatedRuntime, taskId), changed: true };
      }),
    );
    if (!began.changed) {
      return {
        taskId,
        changed: false,
        status: "already-started",
        head,
        mode: "review_existing_head",
        provenancePath,
      };
    }
    const validation = await this.runValidationFor(
      began.task,
      began.runtime as RuntimeTaskState,
      "review-existing",
    );
    if (validation.result.status === "completed" && this.#deps.wake !== undefined) {
      await this.#deps.wake(validation.task);
    }
    return {
      taskId,
      changed: began.changed || validation.changed,
      status: began.changed ? "started" : "already-started",
      head,
      mode: "review_existing_head",
      provenancePath,
    };
  }

  public async validationRetry(taskId: string, approved: boolean): Promise<ValidationRetryResult> {
    if (!approved) throw new Error("validation retry requires explicit approval");
    const task = await this.#deps.getTask(taskId);
    const runtime = await this.runtime(taskId);
    const recovery = defaultRecovery(runtime);
    const remaining = Math.max(0, MAX_VALIDATION_RETRIES - recovery.validationRetries);
    if (remaining === 0)
      return {
        taskId,
        changed: false,
        status: "refused",
        retriesUsed: recovery.validationRetries,
        retriesRemaining: 0,
        reason: "validation retry budget is exhausted",
      };
    if (runtime === undefined || task.reviewHead === undefined)
      return {
        taskId,
        changed: false,
        status: "refused",
        retriesUsed: recovery.validationRetries,
        retriesRemaining: remaining,
        reason: "validation retry requires a durable worktree and reviewed HEAD",
      };
    const path = runtime.worktree?.path ?? task.worktree?.path;
    const current = await checkpoint(
      this.#deps,
      path,
      runtime.worktree?.baseHead ?? task.worktree?.baseHead,
    );
    if (
      path === undefined ||
      current.head !== task.reviewHead ||
      current.dirty !== false ||
      current.unmerged !== false
    )
      return {
        taskId,
        changed: false,
        status: "refused",
        retriesUsed: recovery.validationRetries,
        retriesRemaining: remaining,
        reason: "validation retry requires the exact clean reviewed HEAD",
      };
    const began = await withBoundedLock(this.#deps, async () =>
      this.#deps.store.exclusive(async (store) => {
        const currentTask = await store.read(taskId);
        if (currentTask === undefined) throw new Error(`task ${taskId} is missing`);
        const state = await readRuntimeState(this.#deps.runtimePath);
        const currentRuntime = taskRuntime(state, taskId);
        if (currentRuntime === undefined) throw new Error(`runtime task ${taskId} is missing`);
        if (currentRuntime.jobs.some(activeRuntimeJob))
          return { task: currentTask, runtime: currentRuntime, changed: false };
        const transitioned = transitionTask(
          currentTask,
          {
            type: "retry-validation",
            head: task.reviewHead as string,
            generation: currentTask.generation,
          },
          { now: timestamp(this.#deps), notificationId: this.#deps.idFactory() },
        );
        const updatedRuntime = replaceRuntimeTask(state, taskId, (entry) => ({
          ...entry,
          recovery: {
            ...defaultRecovery(entry),
            validationRetries: defaultRecovery(entry).validationRetries + 1,
            lastOperation: "validation-retry",
            lastAt: timestamp(this.#deps),
          },
        }));
        await writeRuntimeState(this.#deps.runtimePath, updatedRuntime);
        const saved = await store.update(currentTask.id, currentTask.revision, () => transitioned);
        return { task: saved, runtime: taskRuntime(updatedRuntime, taskId), changed: true };
      }),
    );
    if (!began.changed)
      return {
        taskId,
        changed: false,
        status: "refused",
        retriesUsed: recovery.validationRetries,
        retriesRemaining: remaining,
        reason: "an active durable job already owns validation",
      };
    const result = await this.runValidationFor(
      began.task,
      began.runtime as RuntimeTaskState,
      "validation-retry",
    );
    return {
      taskId,
      changed: true,
      status: result.result.status,
      ...(result.failureClass === undefined ? {} : { failureClass: result.failureClass }),
      resultPath: result.resultPath,
      head: task.reviewHead,
      retriesUsed: recovery.validationRetries + 1,
      retriesRemaining: Math.max(0, remaining - 1),
    };
  }
  public async repairEvidence(taskId: string, approved: boolean): Promise<EvidenceRepairResult> {
    if (!approved) throw new Error("evidence repair requires explicit approval");
    const task = await this.#deps.getTask(taskId);
    const runtime = await this.runtime(taskId);
    const recovery = defaultRecovery(runtime);
    const remaining = Math.max(0, MAX_EVIDENCE_REPAIRS - recovery.evidenceRepairs);
    if (remaining === 0) {
      return {
        taskId,
        changed: false,
        repairedPaths: [],
        ...(task.reviewHead === undefined ? {} : { reviewedHead: task.reviewHead }),
        repairsUsed: recovery.evidenceRepairs,
        repairsRemaining: 0,
        reason: "evidence repair budget is exhausted",
      };
    }
    const repairedPaths: string[] = [];
    if (runtime === undefined) {
      return {
        taskId,
        changed: false,
        repairedPaths,
        ...(task.reviewHead === undefined ? {} : { reviewedHead: task.reviewHead }),
        repairsUsed: recovery.evidenceRepairs,
        repairsRemaining: remaining,
        reason: "durable runtime task is missing",
      };
    }
    const taskHasReport = task.reportPath === undefined ? false : await exists(task.reportPath);
    if (task.reviewHead === undefined) {
      return {
        taskId,
        changed: false,
        repairedPaths: [],
        repairsUsed: recovery.evidenceRepairs,
        repairsRemaining: remaining,
        reason: "evidence repair requires a durable reviewed HEAD",
      };
    }
    for (const job of runtime.jobs) {
      if (
        job.phase !== "consumed" ||
        (job.role !== "scout" && job.role !== "implementer") ||
        job.head !== task.reviewHead
      )
        continue;
      const report = reportPathFor(job.jobPath);
      if ((await exists(report)) && !taskHasReport) repairedPaths.push(report);
    }
    if (task.reportPath !== undefined && !taskHasReport) {
      for (const job of runtime.jobs) {
        if (
          job.phase !== "consumed" ||
          (job.role !== "scout" && job.role !== "implementer") ||
          job.head !== task.reviewHead
        )
          continue;
        const candidate = reportPathFor(job.jobPath);
        if (candidate !== task.reportPath && (await exists(candidate))) {
          repairedPaths.push(candidate);
          break;
        }
      }
    }
    if (repairedPaths.length === 0) {
      return {
        taskId,
        changed: false,
        repairedPaths: [],
        ...(task.reviewHead === undefined ? {} : { reviewedHead: task.reviewHead }),
        repairsUsed: recovery.evidenceRepairs,
        repairsRemaining: remaining,
        reason: "no durable evidence repair is proven",
      };
    }
    const saved = await withBoundedLock(this.#deps, async () =>
      this.#deps.store.exclusive(async (store) => {
        const currentTask = await store.read(taskId);
        if (currentTask === undefined) throw new Error(`task ${taskId} is missing`);
        const state = await readRuntimeState(this.#deps.runtimePath);
        const report = repairedPaths[0];
        if (report === undefined) throw new Error("evidence repair produced no report path");
        const reportExists =
          currentTask.reportPath === undefined ? false : await exists(currentTask.reportPath);
        const updatedRuntime = replaceRuntimeTask(state, taskId, (entry) => ({
          ...entry,
          recovery: {
            ...defaultRecovery(entry),
            evidenceRepairs: defaultRecovery(entry).evidenceRepairs + 1,
            lastOperation: "evidence-repair",
            lastAt: timestamp(this.#deps),
          },
        }));
        await writeRuntimeState(this.#deps.runtimePath, updatedRuntime);
        const updatedTask = await store.update(currentTask.id, currentTask.revision, (entry) => ({
          ...entry,
          revision: entry.revision + 1,
          updatedAt: timestamp(this.#deps),
          ...(reportExists ? {} : { reportPath: report }),
        }));
        return { task: updatedTask };
      }),
    );
    return {
      taskId,
      changed: true,
      repairedPaths,
      ...(saved.task.reviewHead === undefined ? {} : { reviewedHead: saved.task.reviewHead }),
      repairsUsed: recovery.evidenceRepairs + 1,
      repairsRemaining: remaining - 1,
    };
  }
  public async deliveryPreflight(
    taskId: string,
    repository: string,
    base: string,
  ): Promise<DeliveryPreflightResult> {
    const task = await this.#deps.getTask(taskId);
    const runtime = await this.runtime(taskId);
    const cwd = task.worktree?.path ?? runtime?.worktree?.path;
    const checks: Array<{
      readonly name: string;
      readonly passed: boolean;
      readonly detail: string;
    }> = [];
    const refusals: string[] = [];
    if (task.stage !== "ready") refusals.push(`task stage ${task.stage} is not ready for delivery`);
    const worktree = task.worktree;
    if (cwd === undefined || task.reviewHead === undefined || worktree === undefined) {
      refusals.push("delivery requires a durable worktree and reviewed HEAD");
      return {
        taskId,
        ready: false,
        ...(task.reviewHead === undefined ? {} : { reviewedHead: task.reviewHead }),
        repository,
        base,
        checks,
        refusals,
      };
    }
    const current = await checkpoint(this.#deps, cwd, worktree.baseHead);
    const clean = current.dirty === false && current.unmerged === false;
    checks.push({
      name: "clean-worktree",
      passed: clean,
      detail: clean ? "clean" : "worktree is dirty or unmerged",
    });
    checks.push({
      name: "reviewed-head",
      passed: current.head === task.reviewHead,
      detail: `reviewed=${task.reviewHead}; current=${String(current.head)}`,
    });
    const branch = await gitText(this.#deps.run, cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    checks.push({
      name: "branch",
      passed: branch === worktree.branch,
      detail: `expected=${worktree.branch}; current=${String(branch)}`,
    });
    const remote = await gitText(this.#deps.run, cwd, ["remote", "get-url", "origin"]);
    const remoteMatches = remote !== undefined && repositoryFromRemote(remote) === repository;
    checks.push({
      name: "remote",
      passed: remoteMatches,
      detail: remote === undefined ? "origin unavailable" : remote,
    });
    const qualityChecks = [
      { name: "generated-database-types", argv: ["bun", "run", "db:types:check"] as const },
      { name: "format", argv: ["bunx", "biome", "format", "--check", "."] as const },
      { name: "pre-push", argv: ["bun", "run", "lint"] as const },
      { name: "git-diff-check", argv: ["git", "-C", cwd, "diff", "--check"] as const },
    ] as const;
    for (const check of qualityChecks) {
      try {
        const result = await this.#deps.run({ argv: check.argv, cwd });
        checks.push({
          name: check.name,
          passed: result.code === 0,
          detail: result.code === 0 ? "passed" : result.stderr || result.stdout,
        });
      } catch (error) {
        checks.push({ name: check.name, passed: false, detail: describeError(error) });
      }
    }
    let duplicatePullRequest: TaskRecord["pullRequest"];
    let draftPullRequest: TaskRecord["pullRequest"];
    const ownDraft =
      task.pullRequest !== undefined &&
      task.pullRequest.state === "draft" &&
      task.pullRequest.repository === repository &&
      task.pullRequest.base === base;
    if (task.pullRequest !== undefined && !ownDraft) {
      refusals.push(
        `task already has pull request #${task.pullRequest.number}; duplicate publication is refused`,
      );
      duplicatePullRequest = task.pullRequest;
    } else {
      if (task.pullRequest !== undefined) draftPullRequest = task.pullRequest;
      try {
        const lookup = await this.#deps.run({
          argv: [
            "gh",
            "pr",
            "list",
            "--repo",
            repository,
            "--head",
            worktree.branch,
            "--state",
            "open",
            "--json",
            "number,headRefOid,baseRefName,url,title,isDraft",
          ],
          cwd,
        });
        if (lookup.code !== 0) {
          refusals.push(`duplicate pull-request lookup failed: ${lookup.stderr || lookup.stdout}`);
        } else {
          const payload: unknown = JSON.parse(lookup.stdout || "[]");
          if (Array.isArray(payload) && payload.length > 0 && isRecord(payload[0])) {
            const entry = payload[0];
            if (
              Number.isSafeInteger(entry.number) &&
              typeof entry.headRefOid === "string" &&
              typeof entry.baseRefName === "string"
            ) {
              const observed: NonNullable<TaskRecord["pullRequest"]> = {
                repository,
                number: entry.number as number,
                state: entry.isDraft === true ? "draft" : "open",
                head: entry.headRefOid,
                base: entry.baseRefName,
                ...(typeof entry.url === "string" ? { url: entry.url } : {}),
                ...(typeof entry.title === "string" ? { title: entry.title } : {}),
              };
              if (draftPullRequest?.number === observed.number) {
                draftPullRequest = observed;
              } else {
                duplicatePullRequest = observed;
                refusals.push(
                  `open pull request #${entry.number} already exists for ${worktree.branch}`,
                );
              }
            } else {
              refusals.push("duplicate pull-request lookup returned malformed metadata");
            }
          }
        }
      } catch (error) {
        refusals.push(`duplicate pull-request lookup unavailable: ${describeError(error)}`);
      }
    }
    for (const check of checks) {
      if (!check.passed) refusals.push(`${check.name}: ${check.detail}`);
    }
    return {
      taskId,
      ready: refusals.length === 0,
      reviewedHead: task.reviewHead,
      ...(current.head === undefined ? {} : { currentHead: current.head }),
      ...(branch === undefined ? {} : { branch }),
      repository,
      base,
      checks,
      refusals,
      ...(duplicatePullRequest === undefined ? {} : { duplicatePullRequest }),
      ...(draftPullRequest === undefined ? {} : { draftPullRequest }),
    };
  }

  private async runtime(taskId: string): Promise<RuntimeTaskState | undefined> {
    return taskRuntime(await readRuntimeState(this.#deps.runtimePath), taskId);
  }

  private async block(task: TaskRecord, reason: string): Promise<void> {
    if (isTerminalTask(task) || task.stage === "paused" || task.stage === "blocked") return;
    await withBoundedLock(this.#deps, async () =>
      this.#deps.store.exclusive(async (store) => {
        const current = await store.read(task.id);
        if (
          current === undefined ||
          isTerminalTask(current) ||
          current.stage === "blocked" ||
          current.stage === "paused"
        )
          return;
        await store.update(current.id, current.revision, (entry) =>
          transitionTask(
            entry,
            { type: "block", reason },
            { now: timestamp(this.#deps), notificationId: this.#deps.idFactory() },
          ),
        );
      }),
    );
  }

  private async runValidationFor(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    operationName: "review-existing" | "validation-retry",
  ): Promise<{
    readonly task: TaskRecord;
    readonly result: ValidationResult;
    readonly resultPath: string;
    readonly changed: boolean;
    readonly failureClass?: "infrastructure" | "validation" | "task-code";
  }> {
    const head = task.reviewHead ?? runtime.worktree?.baseHead;
    if (head === undefined) throw new Error("validation has no reviewed HEAD");
    const manifest = finalAcceptanceContract(task, head);
    const jobId = `${operationName}-${this.#deps.idFactory()}`;
    const directory = jobDirectoryFor(this.#deps.home, task.id, task.generation, jobId);
    const paths = jobPaths(directory);
    const validationJob: ValidationJob = {
      schemaVersion: 1,
      id: jobId,
      taskId: task.id,
      generation: task.generation,
      repoPath: runtime.worktree?.path ?? task.repoPath,
      head,
      contract: manifest.contract,
      policyDigest: manifest.identity.policyDigest,
      surfaces: manifest.surfaces,
      commands: manifest.commands,
      resultPath: paths.resultPath,
    };
    await writeJsonAtomically(paths.jobPath, validationJob);
    const durableJob: DurableJob = {
      schemaVersion: 1,
      id: jobId,
      taskId: task.id,
      generation: task.generation,
      role: "validation",
      kind: "validation",
      cwd: validationJob.repoPath,
      jobPath: paths.jobPath,
      resultPath: paths.resultPath,
      attempt: 1,
      phase: "running",
      launchAttempted: true,
      createdAt: timestamp(this.#deps),
      head,
    };
    await withBoundedLock(this.#deps, async () =>
      this.#deps.store.exclusive(async (store) => {
        const current = await store.read(task.id);
        if (current === undefined) throw new Error(`task ${task.id} is missing`);
        const state = await readRuntimeState(this.#deps.runtimePath);
        const runtimeNow = taskRuntime(state, task.id);
        if (runtimeNow === undefined) throw new Error(`runtime task ${task.id} is missing`);
        await writeRuntimeState(
          this.#deps.runtimePath,
          replaceRuntimeTask(state, task.id, (entry) => ({
            ...entry,
            jobs: [...entry.jobs, durableJob],
          })),
        );
        return undefined;
      }),
    );
    let result: ValidationResult;
    let failureClass: "infrastructure" | "validation" | "task-code" | undefined;
    try {
      const evidence = await runValidation({
        repoPath: validationJob.repoPath,
        contract: manifest.contract,
        identity: manifest.identity,
        commands: manifest.commands,
        run: this.#deps.run,
      });
      const failed = evidence.some((entry) => entry.exitCode !== 0);
      result = {
        schemaVersion: 1,
        id: jobId,
        taskId: task.id,
        generation: task.generation,
        head,
        contract: manifest.contract,
        policyDigest: manifest.identity.policyDigest,
        status: failed ? "failed" : "completed",
        evidence,
        finishedAt: timestamp(this.#deps),
        ...(failed ? { error: "validation command failed" } : {}),
      };
      failureClass = failed ? "task-code" : undefined;
    } catch (error) {
      failureClass =
        error instanceof ValidationConfigurationError ? "validation" : "infrastructure";
      const evidence: readonly ValidationEvidence[] = [
        {
          name: "validation-worker",
          argv: [],
          exitCode: 78,
          stdout: "",
          stderr: describeError(error),
          head,
          contract: manifest.contract,
          origin: "local",
          policyDigest: manifest.identity.policyDigest,
        },
      ];
      result = {
        schemaVersion: 1,
        id: jobId,
        taskId: task.id,
        generation: task.generation,
        head,
        contract: manifest.contract,
        policyDigest: manifest.identity.policyDigest,
        status: "failed",
        evidence,
        finishedAt: timestamp(this.#deps),
        error: describeError(error),
      };
    }
    await writeJsonAtomically(paths.resultPath, result);
    const saved = await withBoundedLock(this.#deps, async () =>
      this.#deps.store.exclusive(async (store) => {
        const current = await store.read(task.id);
        if (current === undefined) throw new Error(`task ${task.id} is missing`);
        const state = await readRuntimeState(this.#deps.runtimePath);
        const runtimeNow = taskRuntime(state, task.id);
        if (runtimeNow === undefined) throw new Error(`runtime task ${task.id} is missing`);
        const event: TaskEvent =
          result.status === "completed"
            ? {
                type: "validation-succeeded",
                head,
                generation: current.generation,
                contract: result.contract,
                policyDigest: result.policyDigest,
                evidence: result.evidence,
              }
            : {
                type: "validation-failed",
                head,
                generation: current.generation,
                contract: result.contract,
                policyDigest: result.policyDigest,
                evidence: result.evidence,
              };
        const transitioned =
          current.stage === "validating"
            ? transitionTask(current, event, {
                now: timestamp(this.#deps),
                notificationId: this.#deps.idFactory(),
              })
            : current;
        const updatedRuntime = replaceRuntimeTask(state, task.id, (entry) => ({
          ...entry,
          jobs: entry.jobs.map((job) =>
            job.id !== jobId
              ? job
              : {
                  ...job,
                  phase: result.status === "completed" ? "consumed" : "failed",
                  consumedAt: timestamp(this.#deps),
                  ...(result.error === undefined ? {} : { error: result.error }),
                },
          ),
        }));
        await writeRuntimeState(this.#deps.runtimePath, updatedRuntime);
        const updatedTask =
          transitioned === current
            ? current
            : await store.update(current.id, current.revision, () => transitioned);
        return { task: updatedTask };
      }),
    );
    return {
      task: saved.task,
      result,
      resultPath: paths.resultPath,
      changed: true,
      ...(failureClass === undefined ? {} : { failureClass }),
    };
  }
}
