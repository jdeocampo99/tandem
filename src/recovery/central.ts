/**
 * The single central recovery mechanism: the same three moves get a stuck task back into its core
 * loop from its current stage, whatever stage that is.
 *
 *   1. Stop  - prove whatever Tandem owns that is still running for the task is dead.
 *   2. Save  - preserve the worktree and snapshot any uncommitted diff as durable evidence.
 *   3. Re-enter - hand the task back to its stage's single re-entry action.
 *
 * The stage re-entry table and every restart/ask decision are pure and live in `central-reentry.ts`;
 * this module gathers facts, applies those decisions, and performs the effects. `implementing`/
 * `scouting` relaunch a dead worker through `WorkerWorkflow.relaunchWorker` within a per-generation
 * restart budget; `validating` reruns validation within the validation retry budget
 * (`recoverStuckValidation`); `reviewing` relaunches only the quarantined lens at the exact reviewed
 * HEAD (`recoverStuckReviewer`), sharing the restart budget. Before spending a restart on
 * `implementing` (including a fix round), `recoverStuckWorker` checks whether the dead worker already
 * finished and adopts its committed HEAD instead (`adoptImplementerCommit`) — see
 * `recoverBlockedTask` for how a `blocked` task with a recoverable cause reaches any of this without
 * a person asking.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readCheckpoint } from "../adapters/git.ts";
import { closeEndpoint, inspectEndpoint, interruptEndpoint } from "../adapters/herdr.ts";
import { EndpointOwnershipError } from "../adapters/primitives.ts";
import type {
  BlockCause,
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  IsoTimestamp,
  Notification,
  TaskQuestion,
  TaskRecord,
  WorktreeLease,
} from "../contracts.ts";
import { activeRuntimeJob, taskRuntime } from "../runtime/activity.ts";
import {
  readRuntimeState,
  taskJobsDirectory,
  updateRuntimeState,
  writeTextAtomically,
} from "../runtime/persistence.ts";
import type { DurableJob, RuntimeTaskState } from "../runtime/schema.ts";
import { isTerminalTask, replaceRuntimeTask, workerRoleForTask } from "../service/records.ts";
import { transitionTask } from "../tasks/lifecycle.ts";
import { formatDecisionQuestion } from "../tasks/question.ts";
import type { TaskStore } from "../tasks/store.ts";
import type { ReservationRefusal } from "../workers/admission.ts";
import { readWorkerTerminal, type WorkerTerminalJob } from "../workers/terminal.ts";
import { pauseWorkerTerminal } from "../workers/terminal-control.ts";
import {
  canCentralRecoverBlockedTask,
  classifyRestartFailure,
  type DeathProof,
  decideReviewRestart,
  decideValidationRetry,
  decideWorkerRestart,
  hasLiveOwner,
  MAX_AUTOMATIC_RESTARTS_PER_GENERATION,
  MAX_VALIDATION_RETRIES,
  RECOVERY_QUESTION_ID_PREFIX,
  type ReviewLensStop,
  recoveryCounters,
  restartsUsedThisGeneration,
  reviewFailureSummary,
  type StageReentry,
  stageReentry,
  waitsOnFact,
  withQuarantineSettled,
  withRestartRecorded,
  withValidationRetryRecorded,
} from "./central-reentry.ts";
import { isQuarantinedReviewFailure, unresolvedReviewFailure } from "./central-review.ts";

/** What one central recovery pass did for a task. */
export type CentralRecoveryAction =
  | "relaunched"
  | "adopted"
  | "resumed"
  | "asked"
  | "blocked"
  | "waiting"
  | "skipped";

export type CentralRecoveryOutcome = Readonly<{
  readonly taskId: string;
  readonly action: CentralRecoveryAction;
  readonly reason: string;
}>;

/** Every restart question's id starts with this, so an answer path can route to this module alone. */
export const RESTART_QUESTION_ID_PREFIX = `${RECOVERY_QUESTION_ID_PREFIX}restart-`;

/** Every validation-retry question's id starts with this, so an answer path can route to this
 *  module's validating handler alone; distinct from `RESTART_QUESTION_ID_PREFIX` so the two never
 *  collide or misroute into each other's stage-specific re-entry. */
export const VALIDATION_RETRY_QUESTION_ID_PREFIX = `${RECOVERY_QUESTION_ID_PREFIX}validation-retry-`;

export type RelaunchWorker = (
  task: TaskRecord,
  extraInstructions: readonly string[],
) => Promise<
  Readonly<{
    readonly relaunched: boolean;
    /** One plain sentence saying why nothing started; the specifics go in `detail`. */
    readonly reason?: string;
    readonly detail?: string;
    /** Why the reservation gate admitted nothing, when that is what stopped it. */
    readonly refusal?: ReservationRefusal["refusal"];
    /** Plain-English note when the source repository moved since the task started; never a refusal. */
    readonly sourceDriftNote?: string;
  }>
>;

/** Central recovery's re-entry for `validating`: rerun validation at the exact same reviewed HEAD
 *  as a new durable job, through the stage's own normal entry point (`WorkerWorkflow.startValidation`).
 *  Never mutates the dead job or its result. */
export type RevalidateWorker = (task: TaskRecord) => Promise<
  Readonly<{
    readonly started: boolean;
    readonly reason?: string;
    readonly refusal?: ReservationRefusal["refusal"];
  }>
>;

export type CentralRecoveryDependencies = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly run: CommandRunner;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly store: TaskStore;
  readonly runtimePath: string;
  readonly getTask: (taskId: string) => Promise<TaskRecord>;
  /** Central recovery's only mutation for the implementing/scouting re-entry: a new operation, a
   *  new pane when one is not already owned, and a normal `launchAgent` launch. */
  readonly relaunchWorker: RelaunchWorker;
  /** Central recovery's only mutation for the validating re-entry. */
  readonly revalidate: RevalidateWorker;
  readonly blockTask: (taskId: string, reason: string, cause?: BlockCause) => Promise<void>;
  /** Clears a proven-stopped owned pane from durable state; reused by the `reviewing` re-entry to
   *  drop a dead reviewer/verifier endpoint before relaunch creates its replacement. */
  readonly removeEndpoint: (taskId: string, paneId: string) => Promise<void>;
  /** The reviewing stage's single re-entry action: `WorkerWorkflow.advanceReview`. Central recovery
   *  never launches a review worker itself; once it has stopped, saved, and cleared the dead lens,
   *  this is what actually relaunches it, exactly as it would for any other next-lens advancement. */
  readonly relaunchReviewer: (task: TaskRecord) => Promise<void>;
}>;

/** The shared shape every `blockTask` dependency across the codebase already has, widened only to
 *  accept the optional typed cause `reportBlock` forwards through it. */
export type BlockTaskEffect = (
  taskId: string,
  reason: string,
  cause?: BlockCause,
) => Promise<unknown>;

/**
 * Recovery's single entry point for reporting why a task is blocked. A call site that already holds
 * a `blockTask`-shaped effect (however it reaches storage) routes its typed cause through here instead
 * of composing the reason text and cause by hand at the call site. For this PR it behaves exactly
 * like today's block: the cause is recorded on the task record and the task is blocked, same as
 * always; nothing here triggers automatic recovery yet. A future PR can change only this function's
 * body to start routing `lost-resource`/`unusable-result` causes into automatic re-entry without
 * touching any of its callers.
 */
export async function reportBlock(
  blockTask: BlockTaskEffect,
  taskId: string,
  cause: BlockCause,
): Promise<void> {
  await blockTask(taskId, cause.summary, cause);
}

/**
 * A stable identity for one dead-worker incident, keyed to the task, its generation, and the exact
 * job that died, so the same dead job always resolves to the same question.
 */
function restartIncidentIdentity(
  input: Readonly<{
    readonly taskId: string;
    readonly generation: number;
    readonly deadJobId: string;
  }>,
): string {
  return createHash("sha256")
    .update(`${input.taskId} ${input.generation} ${input.deadJobId}`)
    .digest("hex")
    .slice(0, 32);
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

async function runGitChecked(
  deps: Readonly<{ readonly run: CommandRunner }>,
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

/**
 * Points a task branch at a specific commit in its own worktree: fast-forwards the branch there if
 * it already exists and the commit is a descendant of it, creates the branch there if it does not
 * exist yet, or just checks it out if it is already there. Never forces the branch away from work it
 * does not descend from: throws instead, so a caller can fall back rather than discard something.
 * Used by the adopt-commit re-entry to point the branch at a freshly adopted commit.
 */
async function pointTaskBranchAtCommit(
  deps: Readonly<{ readonly run: CommandRunner }>,
  path: string,
  branch: string,
  targetHead: string,
): Promise<void> {
  const branchHead = await gitText(deps.run, path, [
    "rev-parse",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (branchHead !== undefined && branchHead !== targetHead) {
    if (!(await isAncestor(deps.run, path, branchHead, targetHead))) {
      throw new Error(
        `task branch ${JSON.stringify(branch)} is not an ancestor of target commit ${targetHead}`,
      );
    }
    await runGitChecked(
      deps,
      path,
      ["branch", "--force", branch, targetHead],
      "task branch repair",
    );
    await runGitChecked(deps, path, ["switch", "--no-guess", branch], "task branch checkout");
  } else if (branchHead === undefined) {
    await runGitChecked(
      deps,
      path,
      ["switch", "--no-guess", "--create", branch, targetHead],
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
  if (repairedBranch !== branch || repairedHead !== targetHead) {
    throw new Error(
      `task branch repair ended at ${JSON.stringify(repairedBranch)} and ${String(repairedHead)}`,
    );
  }
}

/**
 * Blocks a task on a durable question without appending a worker-instruction message, so answering
 * it never bumps `task.communication.revision`.
 */
function taskAsking(
  task: TaskRecord,
  question: TaskQuestion,
  notificationId: string,
  now: IsoTimestamp,
): TaskRecord {
  const blocked = ["cancelled", "completed", "merged", "paused", "blocked"].includes(task.stage)
    ? task
    : transitionTask(task, { type: "block", reason: question.text }, { now, notificationId });
  const notification: Notification = {
    id: notificationId,
    message: question.text,
    acknowledged: false,
    kind: "coordinator",
  };
  const notifications =
    blocked === task
      ? [...task.notifications, notification]
      : blocked.notifications.map((entry) =>
          entry.id === notificationId ? { ...entry, kind: "coordinator" as const } : entry,
        );
  return {
    ...blocked,
    revision: task.revision + 1,
    updatedAt: now,
    notifications,
    communication: { ...(blocked.communication ?? { revision: 0, messages: [] }), question },
  };
}

async function isAncestor(
  run: CommandRunner,
  path: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await run({
    argv: ["git", "-C", path, "merge-base", "--is-ancestor", ancestor, descendant],
    cwd: path,
  });
  return result.code === 0;
}

/** How long the interrupt step waits to observe the pane go quiet before escalating. */
const INTERRUPT_PROOF_TIMEOUT_MS = 2_000;
const INTERRUPT_PROOF_POLL_MS = 100;
/** How long the pid-signal step waits to observe the pane go quiet. */
const KILL_PROOF_TIMEOUT_MS = 5_000;
const KILL_PROOF_POLL_MS = 100;

const LIVE_OWNER_REASON = "an active job or an unreleased reservation already owns this task";

const RUNTIME_METADATA_MISSING: BlockCause = {
  group: "safety-stop",
  kind: "runtime-metadata-missing",
  summary: "Tandem lost its saved record for this task, so it can't restart it automatically.",
  detail: "durable runtime metadata is missing; no re-entry is possible",
};

function skipped(taskId: string, reason: string): CentralRecoveryOutcome {
  return { taskId, action: "skipped", reason };
}

/** The `jobId` a block cause names, omitted when no job had run yet. */
function deadJobReference(deadJobId: string): Readonly<{ readonly jobId?: string }> {
  return deadJobId === "none" ? {} : { jobId: deadJobId };
}

/** The block cause for a relaunch that started nothing: its own plain reason, never a generic one. */
function refusedRelaunchCause(
  relaunch: Awaited<ReturnType<RelaunchWorker>>,
  deadJobId: string,
  attempt: string,
): BlockCause {
  const summary = relaunch.reason ?? "The worker couldn't start.";
  return {
    group: "lost-resource",
    kind: "allocation-failed",
    summary,
    detail: `${attempt} could not launch a new worker: ${relaunch.detail ?? summary}`,
    ...deadJobReference(deadJobId),
  };
}

/** The block cause when a person approved another attempt but the old run could not be proven
 *  stopped: the approval is never proof by itself. */
function unprovenApprovalCause(summary: string, attempt: string, proof: DeathProof): BlockCause {
  return {
    group: "safety-stop",
    kind: "ownership-unprovable",
    summary,
    detail: `${attempt} could not proceed: ${proof.reasonSummary}`,
    ...deadJobReference(proof.deadJobId),
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function terminalJobFor(job: DurableJob | undefined): WorkerTerminalJob | undefined {
  if (job === undefined || job.kind !== "worker") return undefined;
  return {
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: job.role,
    cwd: job.cwd,
    jobPath: job.jobPath,
  };
}

function elapsedMillis(job: DurableJob): number | undefined {
  const end = job.consumedAt ?? job.createdAt;
  const startMs = Date.parse(job.launchedAt ?? job.createdAt);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, endMs - startMs)
    : undefined;
}

function lastJobFor(
  runtime: RuntimeTaskState,
  generation: number,
  role: DurableJob["role"],
  kind: DurableJob["kind"],
): DurableJob | undefined {
  return runtime.jobs
    .filter((job) => job.kind === kind && job.role === role && job.generation === generation)
    .at(-1);
}

/** Which pane role and job role/kind `proveDeath` looks for. Defaults to the implementing/scouting
 *  worker target; validating's reviewer pane and "validation" job pass their own so the same stop
 *  ladder and job lookup serve both without duplicating either. */
type ProveDeathTarget = Readonly<{
  readonly endpointRole: Endpoint["role"];
  readonly jobRole: DurableJob["role"];
  readonly jobKind: DurableJob["kind"];
}>;

const VALIDATION_PROVE_DEATH_TARGET: ProveDeathTarget = {
  endpointRole: "reviewer",
  jobRole: "validation",
  jobKind: "validation",
};

function workerProveDeathTarget(task: TaskRecord): ProveDeathTarget {
  const role = workerRoleForTask(task);
  return { endpointRole: role, jobRole: role, jobKind: "worker" };
}

type PaneState = "alive" | "gone" | "foreign" | "unknown";

async function observePane(
  run: CommandRunner,
  endpoint: Endpoint,
  cwd: string,
): Promise<PaneState> {
  try {
    const inspection = await inspectEndpoint(run, { endpoint, cwd });
    return inspection.activeWorker ? "alive" : "gone";
  } catch (error) {
    if (error instanceof EndpointOwnershipError) {
      return error.reason === "missing" ? "gone" : "foreign";
    }
    return "unknown";
  }
}

/** Closes a pane proven stopped; a pane already missing counts as closed. */
async function closeStoppedPane(
  run: CommandRunner,
  endpoint: Endpoint,
  cwd: string,
): Promise<boolean> {
  try {
    await closeEndpoint(run, { endpoint, cwd });
    return true;
  } catch (error) {
    return error instanceof EndpointOwnershipError && error.reason === "missing";
  }
}

/** A task whose review evidence can be pinned: it has a worktree and a reviewed HEAD. */
type ReviewableTask = TaskRecord &
  Readonly<{ readonly worktree: WorktreeLease; readonly reviewHead: string }>;

function isReviewable(task: TaskRecord): task is ReviewableTask {
  return task.worktree !== undefined && task.reviewHead !== undefined;
}

/** A dead implementer's finished commit that is safe to adopt instead of relaunching. */
type AdoptableCommit = Readonly<{
  readonly worktree: WorktreeLease;
  readonly head: string;
  readonly detached: boolean;
}>;

function adoptionReport(proof: DeathProof, commit: AdoptableCommit): string {
  return [
    "Central recovery adopted this commit after the worker stopped mid-task.",
    "",
    `The worker stopped (${proof.reasonSummary}) after committing its work and exited without`,
    "reporting a result. Recovery confirmed the worktree was clean and at a new commit strictly",
    "ahead of the task's base, and sent that commit to validation and review instead of rerunning",
    "the worker.",
    "",
    `Adopted commit: ${commit.head}`,
    commit.detached
      ? `The worktree was left detached at that commit; recovery pointed branch ${commit.worktree.branch} at it.`
      : `Worktree branch: ${commit.worktree.branch}.`,
  ].join("\n");
}

/** One kind of recovery question: its id prefix, the exact reply it accepts, and what each reply
 *  does. */
type RecoveryQuestionKind = Readonly<{
  readonly idPrefix: string;
  readonly reply: string;
  readonly want: string;
}>;

const RESTART_QUESTION: RecoveryQuestionKind = {
  idPrefix: RESTART_QUESTION_ID_PREFIX,
  reply: 'Reply "restart" or "stop".',
  want: 'Reply "restart" to start a fresh worker in the same worktree and keep every edit, or "stop" to leave it blocked so you can look at it yourself.',
};

const VALIDATION_RETRY_QUESTION: RecoveryQuestionKind = {
  idPrefix: VALIDATION_RETRY_QUESTION_ID_PREFIX,
  reply: 'Reply "retry" or "stop".',
  want: 'Reply "retry" to rerun validation at the same reviewed commit, or "stop" to leave it blocked so you can look at it yourself.',
};

/** Stages whose restart question an answered "restart" re-enters. */
const RESTART_REENTRIES: ReadonlySet<StageReentry> = new Set(["relaunch-worker", "restart-review"]);
const VALIDATION_RETRY_REENTRIES: ReadonlySet<StageReentry> = new Set(["rerun-validation"]);

/** Exact-match only: a restart question is never approved by a loose "ok"/"yes"/"sure". */
function parseRestartChoice(text: string): "restart" | "stop" | undefined {
  const normalized = text.trim().toLowerCase();
  return normalized === "restart" || normalized === "stop" ? normalized : undefined;
}

/** Exact-match only: a validation-retry question is never approved by a loose "ok"/"yes"/"sure". */
function parseValidationRetryChoice(text: string): "retry" | "stop" | undefined {
  const normalized = text.trim().toLowerCase();
  return normalized === "retry" || normalized === "stop" ? normalized : undefined;
}

/**
 * Central recovery: stop, save, re-enter. `recoverStuckWorker` dispatches each stage to its
 * re-entry from the table in `central-reentry.ts`; a `blocked` task with a recoverable cause reaches
 * the same re-entry through `recoverBlockedTask` without a person asking. Every other stage is
 * reported as `skipped` so a caller falls back to whatever it did before.
 */
export class CentralRecoveryWorkflow {
  readonly #deps: CentralRecoveryDependencies;

  public constructor(deps: CentralRecoveryDependencies) {
    this.#deps = deps;
  }

  /**
   * Gets a task whose worker pane is proven gone back into its core loop from its current stage.
   * The caller (the coordinator's reconcile loop) is expected to have already confirmed there is no
   * active durable job and no unreleased reservation; this defends the same invariant.
   */
  public async recoverStuckWorker(task: TaskRecord): Promise<CentralRecoveryOutcome> {
    const reentry = stageReentry(task.stage);
    if (reentry === "rerun-validation") return this.recoverStuckValidation(task);
    if (reentry === "restart-review") return this.recoverStuckReviewer(task);
    if (reentry !== "relaunch-worker") {
      return skipped(task.id, `stage ${task.stage} has no wired re-entry yet`);
    }
    const runtime = await this.readTaskRuntime(task.id);
    if (runtime === undefined) return this.block(task.id, RUNTIME_METADATA_MISSING);
    if (hasLiveOwner(runtime)) return skipped(task.id, LIVE_OWNER_REASON);

    const proof = await this.proveDeath(task, runtime, workerProveDeathTarget(task));
    const now = this.#deps.clock();
    if (proof.proven) {
      const adopted = await this.adoptFinishedCommit(task, proof);
      if (adopted !== undefined) return adopted;
    }
    const decision = decideWorkerRestart({
      proof,
      recovery: recoveryCounters(runtime),
      generation: task.generation,
    });
    if (decision.kind === "ask") {
      return this.askRecoveryQuestion(task, RESTART_QUESTION, proof.deadJobId, {
        ask: decision.ask,
        cause: proof.reasonSummary,
      });
    }

    const relaunch = await this.relaunchInSameWorktree(task, runtime, decision.attempt, [
      `This is an automatic restart after the previous worker stopped without finishing (${proof.reasonSummary}). Uncommitted or partially applied changes from the previous attempt may already exist in this worktree. Run \`git status\` and \`git diff\` first, inspect any partial edits, and repair or complete them before continuing. This is restart ${decision.attempt} of ${MAX_AUTOMATIC_RESTARTS_PER_GENERATION} for this generation.`,
    ]);
    if (!relaunch.relaunched) {
      if (waitsOnFact(relaunch.refusal)) return this.waitToRetry(task.id, relaunch.reason);
      return this.block(
        task.id,
        refusedRelaunchCause(relaunch, proof.deadJobId, "automatic restart"),
      );
    }
    await this.updateTaskRuntime(task.id, (entry) =>
      withRestartRecorded(entry, {
        attempt: decision.attempt,
        generation: task.generation,
        failureClass: decision.failureClass,
        at: now,
      }),
    );
    const notice = `The worker stopped (${proof.reasonSummary}). I restarted it; your edits are kept. (Restart ${decision.attempt} of ${MAX_AUTOMATIC_RESTARTS_PER_GENERATION}.)${relaunch.sourceDriftNote === undefined ? "" : ` Note: ${relaunch.sourceDriftNote}.`}`;
    await this.notifyCoordinator(task.id, notice, now);
    return { taskId: task.id, action: "relaunched", reason: notice };
  }

  /**
   * The scheduler tick's entry point for a `blocked` task:
   * when `canCentralRecoverBlockedTask` says the block is automatically recoverable, resumes the
   * task to its previous stage and runs that stage's own stop/save/re-entry (`recoverStuckWorker`)
   * exactly as if the task had never blocked. A `resume-only` stage (`awaiting-fixes`) resumes and
   * stops there: its own next reconcile pass carries it forward. Anything not eligible is reported
   * `skipped` and left blocked.
   */
  public async recoverBlockedTask(task: TaskRecord): Promise<CentralRecoveryOutcome> {
    if (task.stage !== "blocked") return skipped(task.id, "task is not blocked");
    const runtime = await this.readTaskRuntime(task.id);
    if (!canCentralRecoverBlockedTask(task, runtime)) {
      return skipped(task.id, "block is not eligible for automatic recovery");
    }
    const resumed = await this.resumeBlocked(task.id);
    if (resumed === undefined || resumed.stage === "blocked") {
      return skipped(task.id, "task could not be resumed");
    }
    const reentry = stageReentry(resumed.stage);
    if (reentry === undefined || reentry === "resume-only") {
      return {
        taskId: task.id,
        action: "resumed",
        reason: `resumed to ${resumed.stage}; its own next reconcile pass carries the recovery forward`,
      };
    }
    return this.recoverStuckWorker(resumed);
  }

  /**
   * Central recovery's `validating` re-entry. A validation job that dies for an infrastructure
   * reason (its pane disappears, or it stops without writing durable evidence) is settled as failed
   * without blocking the task (see `WorkerWorkflow.reconcileJob`'s validation branches), so the task
   * stays at `validating` with no active job or reservation and a terminal failed job behind it —
   * exactly the shape this method looks for. A task with no such dead job (a fresh entry into
   * validating, or a job that settled through the normal result path, which always moves the task to
   * `awaiting-fixes`/`reviewing` instead) is reported `skipped` so the caller falls back to the
   * normal `startValidation` entry point unchanged; a genuine task-code validation failure never
   * reaches this method at all. Bounded by `MAX_VALIDATION_RETRIES`, the one budget answered retries
   * also spend from.
   */
  private async recoverStuckValidation(task: TaskRecord): Promise<CentralRecoveryOutcome> {
    const runtime = await this.readTaskRuntime(task.id);
    if (runtime === undefined) return this.block(task.id, RUNTIME_METADATA_MISSING);
    if (hasLiveOwner(runtime)) return skipped(task.id, LIVE_OWNER_REASON);
    const lastJob = lastJobFor(runtime, task.generation, "validation", "validation");
    if (lastJob === undefined || lastJob.phase !== "failed") {
      return skipped(task.id, "no dead validation job needs recovery");
    }

    const proof = await this.proveDeath(task, runtime, VALIDATION_PROVE_DEATH_TARGET);
    const decision = decideValidationRetry(proof, recoveryCounters(runtime));
    if (decision.kind === "ask") {
      return this.askRecoveryQuestion(task, VALIDATION_RETRY_QUESTION, proof.deadJobId, {
        ask: decision.ask,
        cause: proof.reasonSummary,
      });
    }

    const notice = `Validation stopped (${proof.reasonSummary}). I reran it at the same reviewed commit. (Retry ${decision.attempt} of ${MAX_VALIDATION_RETRIES}.)`;
    const revalidated = await this.snapshotAndRevalidate(task, runtime, decision.attempt, notice, {
      summary: "Tandem tried to rerun the checks automatically, but they couldn't start.",
      detail: "automatic validation retry could not restart validation",
      deadJobId: proof.deadJobId,
    });
    if (revalidated.waiting) return this.waitToRetry(task.id, revalidated.reason);
    if (!revalidated.started) {
      return { taskId: task.id, action: "blocked", reason: revalidated.reason as string };
    }
    return { taskId: task.id, action: "relaunched", reason: notice };
  }

  /**
   * The shared save/re-enter tail for `recoverStuckValidation` and `forceOneMoreValidationRetry`:
   * snapshot the worktree, relaunch validation through the stage's normal entry
   * point, and — only on success — record retry `attempt` in the shared counter and notify.
   */
  private async snapshotAndRevalidate(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    attempt: number,
    notice: string,
    refusal: Readonly<{
      readonly summary: string;
      readonly detail: string;
      readonly deadJobId: string;
    }>,
  ): Promise<
    Readonly<{ readonly started: boolean; readonly waiting?: boolean; readonly reason?: string }>
  > {
    await this.snapshotWorktree(task, runtime, attempt);
    const revalidated = await this.#deps.revalidate(task);
    if (waitsOnFact(revalidated.refusal)) {
      return {
        started: false,
        waiting: true,
        ...(revalidated.reason === undefined ? {} : { reason: revalidated.reason }),
      };
    }
    if (!revalidated.started) {
      const reason = revalidated.reason ?? "validation could not be restarted";
      await reportBlock(this.#deps.blockTask, task.id, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: refusal.summary,
        detail: `${refusal.detail}: ${reason}`,
        ...deadJobReference(refusal.deadJobId),
      });
      return { started: false, reason };
    }
    const now = this.#deps.clock();
    await this.updateTaskRuntime(task.id, (entry) => withValidationRetryRecorded(entry, attempt));
    await this.notifyCoordinator(task.id, notice, now);
    return { started: true };
  }

  /**
   * Gets a `reviewing` task back into its core loop when its current reviewer/verifier lens was
   * quarantined: a durable job proven dead only by its pane or result disappearing, never a lens that
   * ran to completion and reported its own failure. The caller (the coordinator's reconcile loop) is
   * expected to call this before `WorkerWorkflow.advanceReview`; a "skipped" outcome means nothing is
   * wrong and the caller should proceed to `advanceReview` as normal, and a "relaunched" outcome means
   * this already stopped and saved the dead lens and relaunched it through `relaunchReviewer`. Only
   * the dead lens is ever touched: completed lenses already recorded in `task.reviews` are left
   * exactly as they are, and a moved or dirty worktree is never relaunched against — it is asked
   * about instead, since review evidence is pinned to the exact reviewed HEAD.
   */
  private async recoverStuckReviewer(task: TaskRecord): Promise<CentralRecoveryOutcome> {
    const runtime = await this.readTaskRuntime(task.id);
    if (runtime === undefined) return skipped(task.id, "durable runtime metadata is missing");
    if (hasLiveOwner(runtime)) return skipped(task.id, LIVE_OWNER_REASON);
    const deadReview = unresolvedReviewFailure(task, runtime);
    if (deadReview === undefined || !isQuarantinedReviewFailure(deadReview)) {
      return skipped(
        task.id,
        "no unresolved reviewer/verifier failure eligible for automatic recovery",
      );
    }
    if (!isReviewable(task)) {
      return skipped(task.id, "review requires a task worktree and reviewed HEAD");
    }

    const now = this.#deps.clock();
    const lensLabel = deadReview.reviewLens ?? "review";
    const stop = await this.stopDeadReviewLens(task, runtime, deadReview);
    const decision = decideReviewRestart({
      stop,
      lensLabel,
      error: deadReview.error,
      recovery: recoveryCounters(runtime),
      generation: task.generation,
    });
    if (decision.kind === "ask") {
      return this.askRecoveryQuestion(task, RESTART_QUESTION, deadReview.id, {
        ask: decision.ask,
      });
    }
    const notice = `The ${lensLabel} reviewer stopped (${deadReview.error ?? "no durable result arrived"}). I am restarting just that review pass; completed reviews are kept. (Restart ${decision.attempt} of ${MAX_AUTOMATIC_RESTARTS_PER_GENERATION}.)`;
    await this.restartReviewLens(task, runtime, { ...decision, at: now, notice });
    return { taskId: task.id, action: "relaunched", reason: notice };
  }

  /**
   * Leaves the task where it is so the next pass retries, and tells the coordinator once: the
   * notice is added only when it is not already the task's latest one, so waiting across many
   * passes never repeats it.
   */
  private async waitToRetry(
    taskId: string,
    reason: string | undefined,
  ): Promise<CentralRecoveryOutcome> {
    const notice = `${reason ?? "Tandem can't start the worker yet."} It will retry on its own once that changes.`;
    await this.notifyCoordinator(taskId, notice, this.#deps.clock(), { skipIfLatest: true });
    return { taskId, action: "waiting", reason: notice };
  }

  /**
   * Answers the one question central recovery ever asks (the 3rd-restart, unproven-death, or
   * same-failure-class question). Only an exact "restart" or "stop" is accepted; anything else is
   * refused with a plain-English error and the question stays open untouched. The reply is stored as
   * a recovery decision, never as a worker instruction: it clears the question directly and never
   * calls `appendTaskMessage`, so `task.communication.revision` is left exactly as it was. Choosing
   * "restart" never trusts the answer as proof by itself: it re-proves death the same way an
   * automatic restart does, and the decision records what was actually proven, not what the user
   * wished for.
   */
  public async answerRestartQuestion(
    taskId: string,
    questionId: string,
    text: string,
  ): Promise<Readonly<{ readonly handled: boolean }>> {
    if (!questionId.startsWith(RESTART_QUESTION_ID_PREFIX)) return { handled: false };
    const task = await this.#deps.getTask(taskId);
    if (task.communication?.question?.id !== questionId) return { handled: false };
    const choice = parseRestartChoice(text);
    if (choice === undefined) {
      throw new Error(
        `a recovery restart question only accepts "restart" or "stop"; received ${JSON.stringify(text.trim())}. The question is still open.`,
      );
    }
    const cleared = await this.clearAnsweredQuestion(taskId, questionId);
    if (choice === "stop") return { handled: true };
    const resumed =
      cleared === undefined ? undefined : await this.resumeForReentry(cleared, RESTART_REENTRIES);
    if (resumed === undefined) return { handled: true };
    if (stageReentry(resumed.stage) === "restart-review") {
      await this.forceOneMoreReviewRestart(resumed);
    } else {
      await this.forceOneMoreRestart(resumed);
    }
    return { handled: true };
  }

  /**
   * Answers the one question the validating re-entry ever asks (unproven-death, or validation-retry
   * budget exhausted). Only an exact "retry" or "stop" is accepted; anything else is refused with a
   * plain-English error and the question stays open untouched. The reply is stored as a recovery
   * decision, never as a worker instruction: it clears the question directly and never bumps
   * `task.communication.revision`. Choosing "retry" never trusts the answer as proof by itself: it
   * re-proves death the same way an automatic retry does.
   */
  public async answerValidationRetryQuestion(
    taskId: string,
    questionId: string,
    text: string,
  ): Promise<Readonly<{ readonly handled: boolean }>> {
    if (!questionId.startsWith(VALIDATION_RETRY_QUESTION_ID_PREFIX)) return { handled: false };
    const task = await this.#deps.getTask(taskId);
    if (task.communication?.question?.id !== questionId) return { handled: false };
    const choice = parseValidationRetryChoice(text);
    if (choice === undefined) {
      throw new Error(
        `a recovery validation-retry question only accepts "retry" or "stop"; received ${JSON.stringify(text.trim())}. The question is still open.`,
      );
    }
    const cleared = await this.clearAnsweredQuestion(taskId, questionId);
    if (choice === "stop") return { handled: true };
    const resumed =
      cleared === undefined
        ? undefined
        : await this.resumeForReentry(cleared, VALIDATION_RETRY_REENTRIES);
    if (resumed !== undefined) await this.forceOneMoreValidationRetry(resumed);
    return { handled: true };
  }

  /**
   * After an explicit user approval, re-proves death and reruns validation once more without
   * re-asking the same question.
   */
  private async forceOneMoreValidationRetry(task: TaskRecord): Promise<void> {
    const runtime = await this.readTaskRuntime(task.id);
    if (runtime === undefined || task.stage !== "validating" || hasLiveOwner(runtime)) return;
    const proof = await this.proveDeath(task, runtime, VALIDATION_PROVE_DEATH_TARGET);
    if (!proof.proven) {
      await reportBlock(
        this.#deps.blockTask,
        task.id,
        unprovenApprovalCause(
          "You approved rerunning the checks, but Tandem couldn't confirm the old run stopped.",
          "the approved validation retry",
          proof,
        ),
      );
      return;
    }
    const notice = `Validation stopped (${proof.reasonSummary}). You approved another retry; I reran it at the same reviewed commit.`;
    await this.snapshotAndRevalidate(
      task,
      runtime,
      recoveryCounters(runtime).validationRetries + 1,
      notice,
      {
        summary: "You approved rerunning the checks, but they couldn't start.",
        detail: "the approved validation retry could not restart validation",
        deadJobId: proof.deadJobId,
      },
    );
  }

  /**
   * After an explicit user approval, re-proves death and relaunches once more without re-asking the
   * same question.
   */
  private async forceOneMoreRestart(task: TaskRecord): Promise<void> {
    const runtime = await this.readTaskRuntime(task.id);
    if (
      runtime === undefined ||
      stageReentry(task.stage) !== "relaunch-worker" ||
      hasLiveOwner(runtime)
    ) {
      return;
    }
    const proof = await this.proveDeath(task, runtime, workerProveDeathTarget(task));
    if (!proof.proven) {
      await reportBlock(
        this.#deps.blockTask,
        task.id,
        unprovenApprovalCause(
          "You approved a restart, but Tandem couldn't confirm the old worker stopped.",
          "the approved restart",
          proof,
        ),
      );
      return;
    }
    const attempt = restartsUsedThisGeneration(recoveryCounters(runtime), task.generation) + 1;
    const relaunch = await this.relaunchInSameWorktree(task, runtime, attempt, [
      `This is a restart the user explicitly approved after the automatic restart budget was reached (${proof.reasonSummary}). Uncommitted or partially applied changes from the previous attempt may already exist in this worktree. Run \`git status\` and \`git diff\` first, inspect any partial edits, and repair or complete them before continuing.`,
    ]);
    if (!relaunch.relaunched) {
      await reportBlock(
        this.#deps.blockTask,
        task.id,
        refusedRelaunchCause(relaunch, proof.deadJobId, "approved restart"),
      );
      return;
    }
    const now = this.#deps.clock();
    await this.updateTaskRuntime(task.id, (entry) =>
      withRestartRecorded(entry, {
        attempt,
        generation: task.generation,
        failureClass: classifyRestartFailure(proof.reasonSummary),
        at: now,
      }),
    );
    const notice = `The worker stopped (${proof.reasonSummary}). You approved another restart; I restarted it and your edits are kept.${relaunch.sourceDriftNote === undefined ? "" : ` Note: ${relaunch.sourceDriftNote}.`}`;
    await this.notifyCoordinator(task.id, notice, now);
  }

  /**
   * The `reviewing` stage's equivalent of `forceOneMoreRestart`: after an explicit user approval,
   * re-proves the dead lens's death and relaunches once more without re-asking. A proof failure (an
   * unproven pane, or a worktree that has since moved off the reviewed HEAD) is refused outright, not
   * re-asked; the caller records that refusal as the decision.
   */
  private async forceOneMoreReviewRestart(task: TaskRecord): Promise<void> {
    const runtime = await this.readTaskRuntime(task.id);
    if (runtime === undefined || task.stage !== "reviewing" || hasLiveOwner(runtime)) return;
    const deadReview = unresolvedReviewFailure(task, runtime);
    if (deadReview === undefined || !isQuarantinedReviewFailure(deadReview)) return;
    if (!isReviewable(task)) return;
    if ((await this.stopDeadReviewLens(task, runtime, deadReview)) !== "stopped") return;
    const reasonSummary = reviewFailureSummary(deadReview.error);
    await this.restartReviewLens(task, runtime, {
      attempt: restartsUsedThisGeneration(recoveryCounters(runtime), task.generation) + 1,
      failureClass: classifyRestartFailure(reasonSummary),
      at: this.#deps.clock(),
      notice: `The ${deadReview.reviewLens ?? "review"} reviewer stopped (${reasonSummary}). You approved another restart; I restarted just that review pass and completed reviews are kept.`,
    });
  }

  /**
   * Stops the dead lens's pane, if it owned one, and checks the worktree is still exactly at the
   * reviewed HEAD. A pane not proven stopped is left alone; a proven-stopped one is cleared from
   * durable state so the relaunch creates its replacement.
   */
  private async stopDeadReviewLens(
    task: ReviewableTask,
    runtime: RuntimeTaskState,
    deadReview: DurableJob,
  ): Promise<ReviewLensStop> {
    const endpoint =
      deadReview.endpoint ??
      runtime.endpoints.find(
        (candidate) =>
          candidate.role === deadReview.role && candidate.generation === task.generation,
      );
    if (endpoint !== undefined) {
      const stopped = await this.stopLadder(
        endpoint,
        task.worktree.path,
        terminalJobFor(deadReview),
      );
      if (!stopped) return "still-running";
      await this.#deps.removeEndpoint(task.id, endpoint.paneId);
    }
    const checkout = await readCheckpoint(this.#deps.run, {
      repo: task.worktree.path,
      baseRef: task.worktree.baseHead,
    });
    return checkout.head !== task.reviewHead || checkout.dirty || checkout.unmerged
      ? "code-moved"
      : "stopped";
  }

  /**
   * Saves the worktree, spends one restart, and settles the stale quarantined operation in the same
   * write (the stop ladder's proof is what turns its uncertain outcome into a known-safe one, so the
   * replacement's routing must not re-read it and pause again), then relaunches exactly this lens
   * through the stage's normal launch path as a new fenced operation.
   */
  private async restartReviewLens(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    restart: Readonly<{
      readonly attempt: number;
      readonly failureClass: ReturnType<typeof classifyRestartFailure>;
      readonly at: IsoTimestamp;
      readonly notice: string;
    }>,
  ): Promise<void> {
    await this.snapshotWorktree(task, runtime, restart.attempt);
    await this.updateTaskRuntime(task.id, (entry) =>
      withRestartRecorded(withQuarantineSettled(entry), {
        attempt: restart.attempt,
        generation: task.generation,
        failureClass: restart.failureClass,
        at: restart.at,
      }),
    );
    await this.notifyCoordinator(task.id, restart.notice, restart.at);
    const refreshed = await this.#deps.getTask(task.id);
    await this.#deps.relaunchReviewer(refreshed);
  }

  /** Saves the worktree, settles the proven-dead operation, and relaunches the worker through the
   *  normal launch path with `extraInstructions`. */
  private async relaunchInSameWorktree(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    attempt: number,
    extraInstructions: readonly string[],
  ): ReturnType<RelaunchWorker> {
    await this.snapshotWorktree(task, runtime, attempt);
    await this.updateTaskRuntime(task.id, withQuarantineSettled);
    return this.#deps.relaunchWorker(task, extraInstructions);
  }

  /**
   * Asks a recovery question as one short plain-English question with no identifiers: task,
   * generation, dead-job identity, and the technical cause go only in the recommendation's details.
   */
  private async askRecoveryQuestion(
    task: TaskRecord,
    kind: RecoveryQuestionKind,
    deadJobId: string,
    parts: Readonly<{ readonly ask: string; readonly cause?: string }>,
  ): Promise<CentralRecoveryOutcome> {
    const incidentIdentity = restartIncidentIdentity({
      taskId: task.id,
      generation: task.generation,
      deadJobId,
    });
    const text = formatDecisionQuestion({ ask: parts.ask, note: kind.reply });
    const details = `Details: task ${task.id}${task.requestId === undefined ? "" : `, request ${task.requestId}`}, generation ${task.generation}, dead job ${deadJobId}${parts.cause === undefined ? "" : `, cause: ${parts.cause}`}.`;
    const question: TaskQuestion = {
      id: `${kind.idPrefix}${incidentIdentity}`,
      text,
      recommendation: `${kind.want} ${details}`,
    };
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined || isTerminalTask(current)) return;
      if (current.communication?.question?.id === question.id) return;
      const asked = taskAsking(current, question, this.#deps.idFactory(), this.#deps.clock());
      await store.update(current.id, current.revision, () => asked);
    });
    return { taskId: task.id, action: "asked", reason: text };
  }

  /** Clears an answered recovery question without touching `task.communication.revision`. */
  private async clearAnsweredQuestion(
    taskId: string,
    questionId: string,
  ): Promise<TaskRecord | undefined> {
    const now = this.#deps.clock();
    return this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined || current.communication?.question?.id !== questionId) {
        return undefined;
      }
      const { question: _question, ...withoutQuestion } = current.communication ?? {
        revision: 0,
        messages: [],
      };
      return store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: now,
        communication: withoutQuestion,
      }));
    });
  }

  /** Undoes the block that asking a recovery question applied, when the task's stage (or, while
   *  blocked, its previous stage) has one of the `accepted` re-entries. */
  private async resumeForReentry(
    task: TaskRecord,
    accepted: ReadonlySet<StageReentry>,
  ): Promise<TaskRecord | undefined> {
    const accepts = (stage: TaskRecord["stage"] | undefined): boolean => {
      const reentry = stageReentry(stage);
      return reentry !== undefined && accepted.has(reentry);
    };
    if (task.stage !== "blocked") return accepts(task.stage) ? task : undefined;
    if (!accepts(task.previousStage)) return undefined;
    return this.resumeBlocked(task.id);
  }

  private async resumeBlocked(taskId: string): Promise<TaskRecord | undefined> {
    return this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined || current.stage !== "blocked") return current;
      return store.update(current.id, current.revision, (entry) =>
        transitionTask(
          entry,
          { type: "resume" },
          { now: this.#deps.clock(), notificationId: this.#deps.idFactory() },
        ),
      );
    });
  }

  /**
   * Whether a dead implementer (including a fix-round implementer) already finished: the task
   * worktree is clean, not unmerged, and HEAD is a new commit strictly ahead of the task's base that
   * is not already reviewed. Review evidence is pinned to an exact HEAD the same way
   * `recoverStuckReviewer` treats it, so a HEAD that already has a review result attached is never
   * re-adopted as if it were new.
   *
   * A worker that committed and then died is exactly as likely to have left the worktree detached
   * (it never switched back to the task branch) as still on the task branch, and the live incident
   * this feature exists for was detached. Detached and on-the-task's-own-branch are both adoptable;
   * a checkout on some *other* named branch is someone else's work and is never adopted. When
   * detached, this also checks (read-only) that the task branch, if it already exists, is an
   * ancestor of the adopted commit — `adoptImplementerCommit`'s later `pointTaskBranchAtCommit` call
   * must never force the branch away from real work, so an eligible-looking-but-diverged branch is
   * screened out here rather than discovered mid-mutation.
   */
  private async adoptableImplementerCommit(task: TaskRecord): Promise<AdoptableCommit | undefined> {
    const worktree = task.worktree;
    if (worktree === undefined) return undefined;
    const { path, baseHead, branch } = worktree;
    const run = this.#deps.run;
    try {
      const checkout = await readCheckpoint(run, { repo: path, baseRef: baseHead });
      if (checkout.dirty || checkout.unmerged || checkout.head === baseHead) return undefined;
      if (task.reviewHead === checkout.head) return undefined;
      if (task.reviews.some((review) => review.head === checkout.head)) return undefined;
      const onBranch = await run({
        argv: ["git", "-C", path, "branch", "--show-current"],
        cwd: path,
      });
      if (onBranch.code !== 0) return undefined;
      const currentBranch = onBranch.stdout.trim();
      const detached = currentBranch.length === 0;
      if (!detached && currentBranch !== branch) return undefined;
      if (!(await isAncestor(run, path, baseHead, checkout.head))) return undefined;
      if (detached) {
        const branchHead = await run({
          argv: ["git", "-C", path, "rev-parse", "--verify", `refs/heads/${branch}`],
          cwd: path,
        });
        // An existing task branch that is not an ancestor of the adopted commit holds real work the
        // adoption would otherwise force away, so it falls back to relaunch.
        if (
          branchHead.code === 0 &&
          !(await isAncestor(run, path, branchHead.stdout.trim(), checkout.head))
        ) {
          return undefined;
        }
      }
      return { worktree, head: checkout.head, detached };
    } catch {
      // An unreadable checkout is never treated as an adoptable commit; the caller falls back to
      // the ordinary relaunch path, which re-derives its own proof from the same worktree.
      return undefined;
    }
  }

  /** A dead implementer's already-finished commit, adopted instead of spending a restart. Never for
   *  `scouting`, which has no comparable finished-commit shape. */
  private async adoptFinishedCommit(
    task: TaskRecord,
    proof: DeathProof,
  ): Promise<CentralRecoveryOutcome | undefined> {
    if (task.kind !== "implementation" || task.stage !== "implementing") return undefined;
    const commit = await this.adoptableImplementerCommit(task);
    return commit === undefined ? undefined : this.adoptImplementerCommit(task, commit, proof);
  }

  /**
   * Records a dead implementer's already-committed HEAD exactly as a successful implementer result
   * would: the same `implementation-complete` lifecycle event `WorkerWorkflow` applies when a worker
   * completes with a clean committed checkpoint (see `src/workers/workflow.ts`'s implementer result
   * handling), setting `reviewHead` and advancing the task to `validating` → `reviewing`. Validation
   * and a fresh review still gate quality from there, so no user approval is needed to send an
   * already-finished commit through them instead of paying for a worker to redo the same work.
   *
   * When the worktree was left detached (the worker never switched back to the task branch — the
   * shape the live incident this exists for actually had), the task branch is pointed at the adopted
   * commit first, via `pointTaskBranchAtCommit`. `adoptableImplementerCommit` already proved, read-only, that
   * doing so is safe (the branch does not exist yet, or is an ancestor of the adopted commit); a
   * failure here despite that is treated as ineligibility, not a block: returns `undefined` so the
   * caller falls back to the ordinary relaunch path instead of discarding anything.
   */
  private async adoptImplementerCommit(
    task: TaskRecord,
    commit: AdoptableCommit,
    proof: DeathProof,
  ): Promise<CentralRecoveryOutcome | undefined> {
    const { head } = commit;
    if (commit.detached) {
      try {
        await pointTaskBranchAtCommit(
          this.#deps,
          commit.worktree.path,
          commit.worktree.branch,
          head,
        );
      } catch {
        return undefined;
      }
    }
    await this.updateTaskRuntime(task.id, withQuarantineSettled);
    const reportPath = join(
      taskJobsDirectory(this.#deps.home, task.id),
      String(task.generation),
      "recovery-adopt-commit",
      "report.txt",
    );
    await writeTextAtomically(reportPath, adoptionReport(proof, commit));
    const adopted = await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined || current.stage !== "implementing") return undefined;
      return store.update(current.id, current.revision, (entry) =>
        transitionTask(
          entry,
          { type: "implementation-complete", head, generation: entry.generation, reportPath },
          { now: this.#deps.clock(), notificationId: this.#deps.idFactory() },
        ),
      );
    });
    if (adopted === undefined || adopted.reviewHead !== head) {
      const reason = "the task could not be moved to validating with the adopted commit";
      await reportBlock(this.#deps.blockTask, task.id, {
        group: "lost-resource",
        kind: "transition-failed",
        summary: "Tandem found the worker's finished commit, but couldn't record it.",
        detail: reason,
      });
      return { taskId: task.id, action: "blocked", reason };
    }
    const notice =
      "The worker stopped after committing its work. I'm sending that commit to checks and review instead of redoing it.";
    await this.notifyCoordinator(task.id, notice, this.#deps.clock());
    return { taskId: task.id, action: "adopted", reason: notice };
  }

  /** Snapshots the worktree's uncommitted diff and untracked files as durable evidence before relaunch. */
  private async snapshotWorktree(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    attempt: number,
  ): Promise<void> {
    const path = runtime.worktree?.path;
    if (path === undefined) return;
    const directory = join(
      taskJobsDirectory(this.#deps.home, task.id),
      String(task.generation),
      `recovery-restart-${attempt}`,
    );
    try {
      const diff = await this.#deps.run({ argv: ["git", "-C", path, "diff"], cwd: path });
      await writeTextAtomically(join(directory, "uncommitted.diff"), diff.stdout);
    } catch {
      // Best-effort evidence; a snapshot failure never blocks recovery.
    }
    try {
      const untracked = await this.#deps.run({
        argv: ["git", "-C", path, "ls-files", "--others", "--exclude-standard"],
        cwd: path,
      });
      await writeTextAtomically(join(directory, "untracked-files.txt"), untracked.stdout);
    } catch {
      // Best-effort evidence; a snapshot failure never blocks recovery.
    }
  }

  /**
   * Proof of death for a stage's re-entry. A candidate stale endpoint (one the task record still
   * names but the durable runtime no longer owns) is run through the stop ladder first; only once
   * nothing owned is left running is the prior job's outcome read.
   */
  private async proveDeath(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    target: ProveDeathTarget,
  ): Promise<DeathProof> {
    const staleEndpoint = (task.endpoints ?? []).find(
      (endpoint) =>
        endpoint.role === target.endpointRole &&
        endpoint.generation === task.generation &&
        !runtime.endpoints.some((owned) => owned.paneId === endpoint.paneId),
    );
    const lastJob = lastJobFor(runtime, task.generation, target.jobRole, target.jobKind);
    if (staleEndpoint !== undefined) {
      const cwd = runtime.worktree?.path;
      if (cwd === undefined) {
        return {
          proven: false,
          deadJobId: lastJob?.id ?? "none",
          reasonSummary: "the worker pane's working directory is unknown",
        };
      }
      const stopped = await this.stopLadder(staleEndpoint, cwd, terminalJobFor(lastJob));
      if (!stopped) {
        return {
          proven: false,
          deadJobId: lastJob?.id ?? "none",
          reasonSummary: `pane ${staleEndpoint.paneId} could not be proven stopped`,
        };
      }
      await this.clearTaskEndpoint(task.id, staleEndpoint.paneId);
    }
    if (lastJob === undefined) {
      return {
        proven: true,
        deadJobId: "none",
        reasonSummary: "no worker has run yet for this attempt",
      };
    }
    if (activeRuntimeJob(lastJob)) {
      return {
        proven: false,
        deadJobId: lastJob.id,
        reasonSummary: `job ${lastJob.id} is still recorded as ${lastJob.phase}`,
      };
    }
    const elapsedMs = elapsedMillis(lastJob);
    return {
      proven: true,
      deadJobId: lastJob.id,
      reasonSummary:
        lastJob.error ?? task.blockReason ?? `worker ${lastJob.phase} without completing`,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    };
  }

  /** Removes a proven-closed stale endpoint from the task's own durable record. */
  private async clearTaskEndpoint(taskId: string, paneId: string): Promise<void> {
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined || current.endpoints === undefined) return;
      if (!current.endpoints.some((entry) => entry.paneId === paneId)) return;
      await store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: this.#deps.clock(),
        ...(entry.endpoints === undefined
          ? {}
          : { endpoints: entry.endpoints.filter((candidate) => candidate.paneId !== paneId) }),
      }));
    });
  }

  /**
   * The stop ladder: control-file pause, then interrupt, then (only once the recorded pid is proven
   * to be the pane's own foreground process) a direct signal, then proof of exit, then closing the
   * pane Tandem now owns proven-stopped. Any step that cannot prove the pane is gone leaves it
   * alone and reports death unproven; nothing here ever touches a pane whose ownership is unproven.
   */
  private async stopLadder(
    endpoint: Endpoint,
    cwd: string,
    terminalJob: WorkerTerminalJob | undefined,
  ): Promise<boolean> {
    const run = this.#deps.run;
    let state = await observePane(run, endpoint, cwd);
    if (state === "foreign" || state === "unknown") return false;
    if (state === "gone") return closeStoppedPane(run, endpoint, cwd);
    try {
      await pauseWorkerTerminal(run, {
        endpoint,
        cwd,
        ...(terminalJob === undefined ? {} : { job: terminalJob }),
      });
    } catch {
      // Best effort; the interrupt and pid-signal steps below can still finish the job.
    }
    state = await observePane(run, endpoint, cwd);
    if (state === "foreign" || state === "unknown") return false;
    if (state === "gone") return closeStoppedPane(run, endpoint, cwd);
    try {
      await interruptEndpoint(run, {
        endpoint,
        cwd,
        timeoutMs: INTERRUPT_PROOF_TIMEOUT_MS,
        pollIntervalMs: INTERRUPT_PROOF_POLL_MS,
      });
      return closeStoppedPane(run, endpoint, cwd);
    } catch {
      // Interrupt could not prove the pane stopped within its own bound; fall through to a direct
      // signal, but only once the recorded pid is proven to be this pane's own foreground process.
    }
    if (terminalJob === undefined) return false;
    return this.signalForegroundWorker(endpoint, cwd, terminalJob);
  }

  /** The stop ladder's last step: signal the recorded pid only when it is proven to be this pane's
   *  foreground process, then poll for proof of exit. */
  private async signalForegroundWorker(
    endpoint: Endpoint,
    cwd: string,
    terminalJob: WorkerTerminalJob,
  ): Promise<boolean> {
    const run = this.#deps.run;
    const terminal = await readWorkerTerminal(terminalJob).catch(() => undefined);
    if (terminal === undefined) return false;
    const inspection = await inspectEndpoint(run, { endpoint, cwd }).catch(() => undefined);
    const foreground =
      inspection?.processInfo.foregroundProcesses.some(
        (process) => process.pid === terminal.pid,
      ) === true;
    if (!foreground) return false;
    try {
      await run({ argv: ["kill", "-TERM", String(terminal.pid)], cwd });
    } catch {
      // Best effort; the exit-proof poll below decides the outcome either way.
    }
    const deadline = Date.now() + KILL_PROOF_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await observePane(run, endpoint, cwd);
      if (state === "gone") return closeStoppedPane(run, endpoint, cwd);
      if (state === "foreign" || state === "unknown") return false;
      await sleep(KILL_PROOF_POLL_MS);
    }
    return false;
  }

  private async readTaskRuntime(taskId: string): Promise<RuntimeTaskState | undefined> {
    return taskRuntime(await readRuntimeState(this.#deps.runtimePath), taskId);
  }

  private async updateTaskRuntime(
    taskId: string,
    update: (entry: RuntimeTaskState) => RuntimeTaskState,
  ): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, taskId, update),
    );
  }

  private async block(taskId: string, cause: BlockCause): Promise<CentralRecoveryOutcome> {
    await reportBlock(this.#deps.blockTask, taskId, cause);
    return { taskId, action: "blocked", reason: cause.summary };
  }

  /** Posts one coordinator notice; `skipIfLatest` keeps a repeated wait from posting it twice. */
  private async notifyCoordinator(
    taskId: string,
    message: string,
    now: IsoTimestamp,
    options: Readonly<{ readonly skipIfLatest?: boolean }> = {},
  ): Promise<void> {
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined) return;
      if (options.skipIfLatest === true && current.notifications.at(-1)?.message === message) {
        return;
      }
      const notification: Notification = {
        id: this.#deps.idFactory(),
        message,
        acknowledged: false,
        kind: "coordinator",
      };
      await store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: now,
        notifications: [...entry.notifications, notification],
      }));
    });
  }
}
