/**
 * The single central recovery mechanism: the same three moves get a stuck task back into its core
 * loop from its current stage, whatever stage that is.
 *
 *   1. Stop  - prove whatever Tandem owns that is still running for the task is dead.
 *   2. Save  - preserve the worktree and snapshot any uncommitted diff as durable evidence.
 *   3. Re-enter - hand the task back to its stage's single re-entry action.
 *
 * Wired re-entries: `implementing`/`scouting` relaunch a dead worker through
 * `WorkerWorkflow.relaunchWorker` within a per-generation restart budget; `validating` reruns
 * validation within the validation retry budget (`recoverStuckValidation`); `reviewing` relaunches
 * only the quarantined lens at the exact reviewed HEAD (`recoverStuckReviewer`), sharing the restart
 * budget. `awaiting-fixes` needs no branch: `beginFixes` moves the task to `implementing` and spends
 * the review round before touching a pane, so a missing pane is picked up by the implementing
 * re-entry without spending another round.
 */
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
} from "../contracts.ts";
import { activeRuntimeJob, taskRuntime, unreleasedReservation } from "../runtime/activity.ts";
import {
  readRuntimeState,
  taskJobsDirectory,
  updateRuntimeState,
  writeTextAtomically,
} from "../runtime/persistence.ts";
import type { DurableJob, RuntimeRecoveryState, RuntimeTaskState } from "../runtime/schema.ts";
import { isTerminalTask, replaceRuntimeTask, workerRoleForTask } from "../service/records.ts";
import { transitionTask } from "../tasks/lifecycle.ts";
import { formatDecisionQuestion } from "../tasks/question.ts";
import type { TaskStore } from "../tasks/store.ts";
import { readWorkerTerminal, type WorkerTerminalJob } from "../workers/terminal.ts";
import { pauseWorkerTerminal } from "../workers/terminal-control.ts";
import { isQuarantinedReviewFailure, unresolvedReviewFailure } from "./central-review.ts";
import { taskAsking } from "./conversation.ts";
import {
  classifyRestartFailure,
  RECOVERY_QUESTION_ID_PREFIX,
  type RecoveryDecisionReceipt,
  type RecoveryEvidence,
  restartIncidentIdentity,
} from "./decision.ts";
import { MAX_VALIDATION_RETRIES } from "./workflow.ts";

/** The two-restart budget every task generation gets before central recovery has to ask. */
export const MAX_AUTOMATIC_RESTARTS_PER_GENERATION = 2;
/** How long the interrupt step waits to observe the pane go quiet before escalating. */
const INTERRUPT_PROOF_TIMEOUT_MS = 2_000;
const INTERRUPT_PROOF_POLL_MS = 100;
/** How long the pid-signal step waits to observe the pane go quiet. */
const KILL_PROOF_TIMEOUT_MS = 5_000;
const KILL_PROOF_POLL_MS = 100;
/** A dead job that failed inside this window of its own launch is treated as an immediate failure
 *  for the same-failure-class guard, e.g. a provider outage that rejects every attempt at once. */
const IMMEDIATE_FAILURE_WINDOW_MS = 15 * 1_000;
/** Bounds the durable decision receipt list the same way conversational recovery does. */
const MAX_RECOVERY_DECISION_RECEIPTS = 10;
/** Every restart question's id starts with this, so an answer path can route to this module alone. */
export const RESTART_QUESTION_ID_PREFIX = `${RECOVERY_QUESTION_ID_PREFIX}restart-`;

export type RelaunchWorker = (
  task: TaskRecord,
  extraInstructions: readonly string[],
) => Promise<
  Readonly<{
    readonly relaunched: boolean;
    readonly reason?: string;
    /** Plain-English note when the source repository moved since the task started; never a refusal. */
    readonly sourceDriftNote?: string;
  }>
>;

/** Central recovery's re-entry for `validating`: rerun validation at the exact same reviewed HEAD
 *  as a new durable job, through the stage's own normal entry point (`WorkerWorkflow.startValidation`).
 *  Never mutates the dead job or its result. */
export type RevalidateWorker = (
  task: TaskRecord,
) => Promise<Readonly<{ readonly started: boolean; readonly reason?: string }>>;

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

export type CentralRecoveryAction = "relaunched" | "asked" | "blocked" | "skipped";

export type CentralRecoveryOutcome = Readonly<{
  readonly taskId: string;
  readonly action: CentralRecoveryAction;
  readonly reason: string;
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

function defaultRecovery(runtime: RuntimeTaskState | undefined): RuntimeRecoveryState {
  return (
    runtime?.recovery ?? {
      schemaVersion: 1,
      recoveryAttempts: 0,
      validationRetries: 0,
      evidenceRepairs: 0,
    }
  );
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

type DeathProof = Readonly<{
  readonly proven: boolean;
  readonly deadJobId: string;
  readonly reasonSummary: string;
  readonly elapsedMs?: number;
}>;

/** Which pane role and job role/kind `proveDeath`/`lastJobFor` look for. Defaults to the
 *  implementing/scouting worker target; validating's reviewer pane and "validation" job pass their
 *  own so the same stop ladder and job lookup serve both without duplicating either. */
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

/** The only two answers a restart question accepts; anything else is refused. */
type RestartChoice = "restart" | "stop";

/** Exact-match only: a restart question is never approved by a loose "ok"/"yes"/"sure". */
function parseRestartChoice(text: string): RestartChoice | undefined {
  const normalized = text.trim().toLowerCase();
  return normalized === "restart" || normalized === "stop" ? normalized : undefined;
}

/** What answering "restart" actually proved and did, so the decision receipt records reality. */
type ForcedRestartOutcome = Readonly<{
  readonly relaunched: boolean;
  readonly proven: boolean;
  readonly reasonSummary: string;
}>;

const RESTART_QUESTION_WANT =
  'Reply "restart" to start a fresh worker in the same worktree and keep every edit, or "stop" to leave it blocked so you can look at it yourself.';

/** Every validation-retry question's id starts with this, so an answer path can route to this
 *  module's validating handler alone; distinct from `RESTART_QUESTION_ID_PREFIX` so the two never
 *  collide or misroute into each other's stage-specific re-entry. */
export const VALIDATION_RETRY_QUESTION_ID_PREFIX = `${RECOVERY_QUESTION_ID_PREFIX}validation-retry-`;

/** The only two answers a validation-retry question accepts; anything else is refused. */
type ValidationRetryChoice = "retry" | "stop";

/** Exact-match only: a validation-retry question is never approved by a loose "ok"/"yes"/"sure". */
function parseValidationRetryChoice(text: string): ValidationRetryChoice | undefined {
  const normalized = text.trim().toLowerCase();
  return normalized === "retry" || normalized === "stop" ? normalized : undefined;
}

/** What answering "retry" actually proved and did, so the decision receipt records reality. */
type ForcedValidationRetryOutcome = Readonly<{
  readonly started: boolean;
  readonly proven: boolean;
  readonly reasonSummary: string;
}>;

const VALIDATION_RETRY_QUESTION_WANT =
  'Reply "retry" to rerun validation at the same reviewed commit, or "stop" to leave it blocked so you can look at it yourself.';

/**
 * Central recovery: stop, save, re-enter. The `implementing`/`scouting` and `validating` stages'
 * re-entry are wired; every other stage is reported as `skipped` so a caller falls back to whatever
 * it did before.
 */
export class CentralRecoveryWorkflow {
  readonly #deps: CentralRecoveryDependencies;

  public constructor(deps: CentralRecoveryDependencies) {
    this.#deps = deps;
  }

  /**
   * Gets a task whose worker pane is proven gone back into its core loop from `implementing` or
   * `scouting`. The caller (the coordinator's reconcile loop) is expected to have already confirmed
   * there is no active durable job and no unreleased reservation; this defends the same invariant.
   */
  public async recoverStuckWorker(task: TaskRecord): Promise<CentralRecoveryOutcome> {
    if (task.stage === "validating") return this.recoverStuckValidation(task);
    if (task.stage === "reviewing") return this.recoverStuckReviewer(task);
    if (task.stage !== "implementing" && task.stage !== "scouting") {
      return {
        taskId: task.id,
        action: "skipped",
        reason: `stage ${task.stage} has no wired re-entry yet`,
      };
    }
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined) {
      const reason = "durable runtime metadata is missing; no re-entry is possible";
      await this.#deps.blockTask(task.id, reason);
      return { taskId: task.id, action: "blocked", reason };
    }
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) {
      return {
        taskId: task.id,
        action: "skipped",
        reason: "an active job or an unreleased reservation already owns this task",
      };
    }

    // --- Move 1: stop. Prove the prior worker is dead before anything else runs. ---
    const proof = await this.proveDeath(task, runtime);
    const now = this.#deps.clock();
    const incidentIdentity = restartIncidentIdentity({
      taskId: task.id,
      generation: task.generation,
      deadJobId: proof.deadJobId,
    });
    if (!proof.proven) {
      return this.askRestart(task, incidentIdentity, proof.deadJobId, now, {
        what: `The worker stopped, but I could not prove it is actually gone (${proof.reasonSummary}).`,
        risk: "If you choose restart, Tandem checks again first and will not run two workers on the same worktree at once. Nothing has changed yet either way; your worktree and history are preserved.",
      });
    }

    const recovery = defaultRecovery(runtime);
    const restartsUsed =
      recovery.restartGeneration === task.generation ? (recovery.restarts ?? 0) : 0;
    if (restartsUsed >= MAX_AUTOMATIC_RESTARTS_PER_GENERATION) {
      return this.askRestart(task, incidentIdentity, proof.deadJobId, now, {
        what: `The worker stopped again (${proof.reasonSummary}); I already restarted it automatically ${restartsUsed} time(s) this generation.`,
        risk: "Restarting again may just repeat the same failure if it is not a one-off. Nothing is discarded either way; your worktree, reports, and history are preserved.",
      });
    }

    const failureClass = classifyRestartFailure(proof.reasonSummary);
    const withinImmediateWindow =
      proof.elapsedMs !== undefined && proof.elapsedMs < IMMEDIATE_FAILURE_WINDOW_MS;
    const sameClassAsLastRestart =
      restartsUsed > 0 && recovery.lastRestartFailureClass === failureClass;
    if (withinImmediateWindow && sameClassAsLastRestart) {
      return this.askRestart(task, incidentIdentity, proof.deadJobId, now, {
        what: `The worker failed again within ${Math.round((proof.elapsedMs ?? 0) / 1000)}s of starting, the same way (${proof.reasonSummary}) as the restart before it.`,
        risk: "Nothing has changed; your worktree, reports, and history are preserved either way.",
      });
    }

    // --- Move 2: save. Snapshot uncommitted work before the next worker can touch it. ---
    await this.snapshotWorktree(task, runtime, restartsUsed + 1);

    // --- Move 3: re-enter. ---
    await this.settleProvenQuarantine(task.id);
    const extraInstructions = [
      `This is an automatic restart after the previous worker stopped without finishing (${proof.reasonSummary}). Uncommitted or partially applied changes from the previous attempt may already exist in this worktree. Run \`git status\` and \`git diff\` first, inspect any partial edits, and repair or complete them before continuing. This is restart ${restartsUsed + 1} of ${MAX_AUTOMATIC_RESTARTS_PER_GENERATION} for this generation.`,
    ];
    const relaunch = await this.#deps.relaunchWorker(task, extraInstructions);
    if (!relaunch.relaunched) {
      const reason = relaunch.reason ?? "relaunch was refused";
      await this.#deps.blockTask(
        task.id,
        `automatic restart could not launch a new worker: ${reason}`,
      );
      return { taskId: task.id, action: "blocked", reason };
    }

    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, task.id, (entry) => ({
        ...entry,
        recovery: {
          ...defaultRecovery(entry),
          restarts: restartsUsed + 1,
          restartGeneration: task.generation,
          lastRestartFailureClass: failureClass,
          lastRestartAt: now,
          lastOperation: "relaunch",
          lastAt: now,
        },
      })),
    );
    const notice = `The worker stopped (${proof.reasonSummary}). I restarted it; your edits are kept. (Restart ${restartsUsed + 1} of ${MAX_AUTOMATIC_RESTARTS_PER_GENERATION}.)${relaunch.sourceDriftNote === undefined ? "" : ` Note: ${relaunch.sourceDriftNote}.`}`;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined) return;
      const notification: Notification = {
        id: this.#deps.idFactory(),
        message: notice,
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
    await this.saveDecision(task.id, {
      taskId: task.id,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence: this.evidenceFor(incidentIdentity, proof.reasonSummary, now),
      ownership: "proven-owned",
      priorOutcome: "known",
      approval: "preapproved",
      unmetProofs: [],
      consequences: notice,
      disposition: "applied",
      dispositionReason: notice,
    });
    return { taskId: task.id, action: "relaunched", reason: notice };
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
   * reaches this method at all. Bounded by `MAX_VALIDATION_RETRIES`, the exact same budget the
   * explicit `validation-retry` recovery action spends from — central recovery never adds a second
   * counter for it.
   */
  private async recoverStuckValidation(task: TaskRecord): Promise<CentralRecoveryOutcome> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined) {
      const reason = "durable runtime metadata is missing; no re-entry is possible";
      await this.#deps.blockTask(task.id, reason);
      return { taskId: task.id, action: "blocked", reason };
    }
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) {
      return {
        taskId: task.id,
        action: "skipped",
        reason: "an active job or an unreleased reservation already owns this task",
      };
    }
    const lastJob = this.lastJobFor(runtime, task, "validation", "validation");
    if (lastJob === undefined || lastJob.phase !== "failed") {
      return {
        taskId: task.id,
        action: "skipped",
        reason: "no dead validation job needs recovery",
      };
    }

    // --- Move 1: stop. Prove the prior validation run is dead before anything else runs. ---
    const proof = await this.proveDeath(task, runtime, VALIDATION_PROVE_DEATH_TARGET);
    const now = this.#deps.clock();
    const incidentIdentity = restartIncidentIdentity({
      taskId: task.id,
      generation: task.generation,
      deadJobId: proof.deadJobId,
    });
    if (!proof.proven) {
      return this.askValidationRetry(task, incidentIdentity, proof.deadJobId, now, {
        what: `Validation stopped, but I could not prove it is actually gone (${proof.reasonSummary}).`,
        risk: "If you choose retry, Tandem checks again first and will not run two validation runs on the same worktree at once. Nothing has changed yet either way; your worktree and history are preserved.",
      });
    }

    const recovery = defaultRecovery(runtime);
    const retriesUsed = recovery.validationRetries;
    if (retriesUsed >= MAX_VALIDATION_RETRIES) {
      return this.askValidationRetry(task, incidentIdentity, proof.deadJobId, now, {
        what: `Validation stopped again (${proof.reasonSummary}); the validation retry budget (${retriesUsed} of ${MAX_VALIDATION_RETRIES}) is already spent.`,
        risk: "Retrying again may just repeat the same failure if it is not a one-off. Nothing is discarded either way; your worktree, reports, and history are preserved.",
      });
    }

    // --- Move 2: save. Snapshot uncommitted work before the next validation run can touch it. ---
    await this.snapshotWorktree(task, runtime, retriesUsed + 1);

    // --- Move 3: re-enter. ---
    const revalidated = await this.#deps.revalidate(task);
    if (!revalidated.started) {
      const reason = revalidated.reason ?? "validation could not be restarted";
      await this.#deps.blockTask(
        task.id,
        `automatic validation retry could not restart validation: ${reason}`,
      );
      return { taskId: task.id, action: "blocked", reason };
    }

    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, task.id, (entry) => ({
        ...entry,
        recovery: {
          ...defaultRecovery(entry),
          validationRetries: retriesUsed + 1,
          lastOperation: "validation-retry",
          lastAt: now,
        },
      })),
    );
    const notice = `Validation stopped (${proof.reasonSummary}). I reran it at the same reviewed commit. (Retry ${retriesUsed + 1} of ${MAX_VALIDATION_RETRIES}.)`;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined) return;
      const notification: Notification = {
        id: this.#deps.idFactory(),
        message: notice,
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
    await this.saveDecision(task.id, {
      taskId: task.id,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence: this.evidenceFor(incidentIdentity, proof.reasonSummary, now),
      ownership: "proven-owned",
      priorOutcome: "known",
      approval: "preapproved",
      unmetProofs: [],
      consequences: notice,
      disposition: "applied",
      dispositionReason: notice,
    });
    return { taskId: task.id, action: "relaunched", reason: notice };
  }

  /**
   * Gets a `reviewing` task back into its core loop when its current reviewer/verifier lens was
   * quarantined: a durable job proven dead only by its pane or result disappearing, never a lens that
   * ran to completion and reported its own failure. The caller (the coordinator's reconcile loop) is
   * expected to call this before `WorkerWorkflow.advanceReview`; a "skipped" outcome means nothing is
   * wrong and the caller should proceed to `advanceReview` as normal, and a "relaunched" outcome means
   * this already stopped and saved the dead lens and the caller's very next `advanceReview` call will
   * relaunch it (its own instruction-revision and quarantine checks let it proceed once this has
   * cleared the stale endpoint). Only the dead lens is ever touched: completed lenses already recorded
   * in `task.reviews` are left exactly as they are, and a moved or dirty worktree is never relaunched
   * against — it is asked about instead, since review evidence is pinned to the exact reviewed HEAD.
   */
  private async recoverStuckReviewer(task: TaskRecord): Promise<CentralRecoveryOutcome> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined) {
      return {
        taskId: task.id,
        action: "skipped",
        reason: "durable runtime metadata is missing",
      };
    }
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) {
      return {
        taskId: task.id,
        action: "skipped",
        reason: "an active job or an unreleased reservation already owns this task",
      };
    }
    const deadReview = unresolvedReviewFailure(task, runtime);
    if (deadReview === undefined || !isQuarantinedReviewFailure(deadReview)) {
      return {
        taskId: task.id,
        action: "skipped",
        reason: "no unresolved reviewer/verifier failure eligible for automatic recovery",
      };
    }
    if (task.worktree === undefined || task.reviewHead === undefined) {
      return {
        taskId: task.id,
        action: "skipped",
        reason: "review requires a task worktree and reviewed HEAD",
      };
    }

    const now = this.#deps.clock();
    const lensLabel = deadReview.reviewLens ?? "review";
    const incidentIdentity = restartIncidentIdentity({
      taskId: task.id,
      generation: task.generation,
      deadJobId: deadReview.id,
    });

    // --- Move 1: stop. Prove any pane the dead lens owned is actually gone before touching it. ---
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
      if (!stopped) {
        return this.askRestart(task, incidentIdentity, deadReview.id, now, {
          what: `The ${lensLabel} reviewer stopped, but I could not prove it is actually gone.`,
          risk: "If you choose restart, Tandem checks again first and will not run two reviewers on the same worktree at once. Nothing has changed yet either way; your worktree and history are preserved.",
        });
      }
      await this.#deps.removeEndpoint(task.id, endpoint.paneId);
    }

    // Review evidence is pinned to the exact reviewed HEAD; never relaunch across drift or a dirty
    // worktree, since that would review the wrong changes.
    const checkout = await readCheckpoint(this.#deps.run, {
      repo: task.worktree.path,
      baseRef: task.worktree.baseHead,
    });
    if (checkout.head !== task.reviewHead || checkout.dirty || checkout.unmerged) {
      return this.askRestart(task, incidentIdentity, deadReview.id, now, {
        what: `The ${lensLabel} reviewer stopped, and the worktree no longer matches the exact commit this review was checking.`,
        risk: "Relaunching now would review the wrong changes. Nothing has changed yet either way; your worktree and history are preserved.",
      });
    }

    const recovery = defaultRecovery(runtime);
    const restartsUsed =
      recovery.restartGeneration === task.generation ? (recovery.restarts ?? 0) : 0;
    if (restartsUsed >= MAX_AUTOMATIC_RESTARTS_PER_GENERATION) {
      return this.askRestart(task, incidentIdentity, deadReview.id, now, {
        what: `The ${lensLabel} reviewer stopped again; I already restarted review work automatically ${restartsUsed} time(s) this generation.`,
        risk: "Restarting again may just repeat the same failure if it is not a one-off. Nothing is discarded either way; your worktree, reports, and history are preserved.",
      });
    }

    // --- Move 2: save. Snapshot uncommitted work before the next reviewer can touch it. ---
    await this.snapshotWorktree(task, runtime, restartsUsed + 1);

    // --- Move 3: re-enter. Nothing here launches a worker directly: clearing the dead endpoint,
    // spending one restart, and settling the stale quarantined operation (this stop ladder's own
    // proof is what turns its previously-uncertain outcome into a known-safe one) is enough for the
    // caller's very next `advanceReview` call to relaunch exactly this lens through its own normal
    // launch path, as a new fenced operation. Without settling the operation, the replacement
    // attempt's own routing would re-read the same quarantined phase and pause again for approval,
    // undoing the proof this stop ladder just established. ---
    const failureClass = classifyRestartFailure(
      deadReview.error ?? "reviewer stopped without a durable result",
    );
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, task.id, (entry) => ({
        ...entry,
        ...(entry.operation?.phase === "quarantined"
          ? { operation: { ...entry.operation, phase: "failed" as const } }
          : {}),
        recovery: {
          ...defaultRecovery(entry),
          restarts: restartsUsed + 1,
          restartGeneration: task.generation,
          lastRestartFailureClass: failureClass,
          lastRestartAt: now,
          lastOperation: "relaunch",
          lastAt: now,
        },
      })),
    );
    const notice = `The ${lensLabel} reviewer stopped (${deadReview.error ?? "no durable result arrived"}). I am restarting just that review pass; completed reviews are kept. (Restart ${restartsUsed + 1} of ${MAX_AUTOMATIC_RESTARTS_PER_GENERATION}.)`;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined) return;
      const notification: Notification = {
        id: this.#deps.idFactory(),
        message: notice,
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
    await this.saveDecision(task.id, {
      taskId: task.id,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence: this.evidenceFor(
        incidentIdentity,
        deadReview.error ?? "reviewer stopped without a durable result",
        now,
      ),
      ownership: "proven-owned",
      priorOutcome: "known",
      approval: "preapproved",
      unmetProofs: [],
      consequences: notice,
      disposition: "applied",
      dispositionReason: notice,
    });
    const refreshed = await this.#deps.getTask(task.id);
    await this.#deps.relaunchReviewer(refreshed);
    return { taskId: task.id, action: "relaunched", reason: notice };
  }

  /**
   * Death was just proven, so a quarantined operation's uncertain outcome is now a known-safe
   * failure. Settling it keeps the relaunch's routing from pausing on the same uncertainty.
   */
  private async settleProvenQuarantine(taskId: string): Promise<void> {
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, taskId, (entry) =>
        entry.operation?.phase === "quarantined"
          ? { ...entry, operation: { ...entry.operation, phase: "failed" as const } }
          : entry,
      ),
    );
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
    const now = this.#deps.clock();
    let cleared: TaskRecord | undefined;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined || current.communication?.question?.id !== questionId) return;
      const { question: _question, ...withoutQuestion } = current.communication ?? {
        revision: 0,
        messages: [],
      };
      cleared = await store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: now,
        communication: withoutQuestion,
      }));
    });
    const evidenceIdentity = questionId.slice(RESTART_QUESTION_ID_PREFIX.length);
    if (choice === "stop") {
      await this.saveDecision(taskId, {
        taskId,
        generation: task.generation,
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        evidence: this.evidenceFor(evidenceIdentity, "user answered the restart question", now),
        ownership: "unknown",
        priorOutcome: "uncertain",
        approval: "user-approval",
        unmetProofs: [],
        consequences: "the user chose to leave the task blocked",
        disposition: "refused",
        dispositionReason: 'user answered "stop"',
        questionId,
      });
      return { handled: true };
    }
    // choice === "restart": reuse the same three-move path, treating this approval as spending one
    // more restart, but never as proof by itself — forceOneMoreRestart/forceOneMoreReviewRestart
    // re-prove death first.
    const resumed = cleared === undefined ? undefined : await this.resumeFromAsk(cleared);
    const outcome: ForcedRestartOutcome =
      resumed === undefined
        ? {
            relaunched: false,
            proven: false,
            reasonSummary: "the task could not be resumed from blocked",
          }
        : resumed.stage === "reviewing"
          ? await this.forceOneMoreReviewRestart(resumed)
          : await this.forceOneMoreRestart(resumed);
    await this.saveDecision(taskId, {
      taskId,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence: this.evidenceFor(evidenceIdentity, outcome.reasonSummary, now),
      ownership: outcome.proven ? "proven-owned" : "unknown",
      priorOutcome: outcome.proven ? "known" : "uncertain",
      approval: "user-approval",
      unmetProofs: [],
      consequences: outcome.relaunched
        ? "the user chose to restart; the prior worker was re-proven dead and a new one was launched"
        : `the user chose to restart, but ${outcome.reasonSummary}`,
      disposition: outcome.relaunched ? "applied" : "refused",
      dispositionReason: outcome.relaunched
        ? 'user answered "restart"; relaunched after re-proving the prior worker was dead'
        : `user answered "restart" but ${outcome.reasonSummary}`,
      questionId,
    });
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
    const now = this.#deps.clock();
    let cleared: TaskRecord | undefined;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(taskId);
      if (current === undefined || current.communication?.question?.id !== questionId) return;
      const { question: _question, ...withoutQuestion } = current.communication ?? {
        revision: 0,
        messages: [],
      };
      cleared = await store.update(current.id, current.revision, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        updatedAt: now,
        communication: withoutQuestion,
      }));
    });
    const evidenceIdentity = questionId.slice(VALIDATION_RETRY_QUESTION_ID_PREFIX.length);
    if (choice === "stop") {
      await this.saveDecision(taskId, {
        taskId,
        generation: task.generation,
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        evidence: this.evidenceFor(
          evidenceIdentity,
          "user answered the validation-retry question",
          now,
        ),
        ownership: "unknown",
        priorOutcome: "uncertain",
        approval: "user-approval",
        unmetProofs: [],
        consequences: "the user chose to leave the task blocked",
        disposition: "refused",
        dispositionReason: 'user answered "stop"',
        questionId,
      });
      return { handled: true };
    }
    // choice === "retry": reuse the same three-move path, treating this approval as spending one
    // more validation retry, but never as proof by itself — forceOneMoreValidationRetry re-proves
    // death first.
    const resumed = cleared === undefined ? undefined : await this.resumeFromValidationAsk(cleared);
    const outcome: ForcedValidationRetryOutcome =
      resumed === undefined
        ? {
            started: false,
            proven: false,
            reasonSummary: "the task could not be resumed from blocked",
          }
        : await this.forceOneMoreValidationRetry(resumed);
    await this.saveDecision(taskId, {
      taskId,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence: this.evidenceFor(evidenceIdentity, outcome.reasonSummary, now),
      ownership: outcome.proven ? "proven-owned" : "unknown",
      priorOutcome: outcome.proven ? "known" : "uncertain",
      approval: "user-approval",
      unmetProofs: [],
      consequences: outcome.started
        ? "the user chose to retry; the prior validation run was re-proven dead and a new one was started"
        : `the user chose to retry, but ${outcome.reasonSummary}`,
      disposition: outcome.started ? "applied" : "refused",
      dispositionReason: outcome.started
        ? 'user answered "retry"; restarted validation after re-proving the prior run was dead'
        : `user answered "retry" but ${outcome.reasonSummary}`,
      questionId,
    });
    return { handled: true };
  }

  /** Undoes the block that asking the validation-retry question applied, so revalidation can
   *  proceed. */
  private async resumeFromValidationAsk(task: TaskRecord): Promise<TaskRecord | undefined> {
    if (task.stage !== "blocked") return task.stage === "validating" ? task : undefined;
    if (task.previousStage !== "validating") return undefined;
    return this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
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
   * After an explicit user approval, re-proves death and reruns validation once more without
   * re-asking the same question. Returns what was actually proven and done so the caller's decision
   * receipt never has to guess.
   */
  private async forceOneMoreValidationRetry(
    task: TaskRecord,
  ): Promise<ForcedValidationRetryOutcome> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined || task.stage !== "validating") {
      return {
        started: false,
        proven: false,
        reasonSummary: "the task is no longer validating",
      };
    }
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) {
      return {
        started: false,
        proven: false,
        reasonSummary: "an active job or reservation already owns this task",
      };
    }
    const proof = await this.proveDeath(task, runtime, VALIDATION_PROVE_DEATH_TARGET);
    if (!proof.proven) {
      await this.#deps.blockTask(
        task.id,
        `the approved validation retry could not proceed: ${proof.reasonSummary}`,
      );
      return { started: false, proven: false, reasonSummary: proof.reasonSummary };
    }
    const recovery = defaultRecovery(runtime);
    const retriesUsed = recovery.validationRetries;
    await this.snapshotWorktree(task, runtime, retriesUsed + 1);
    const revalidated = await this.#deps.revalidate(task);
    if (!revalidated.started) {
      await this.#deps.blockTask(
        task.id,
        `the approved validation retry could not restart validation: ${revalidated.reason ?? "revalidation was refused"}`,
      );
      return { started: false, proven: true, reasonSummary: proof.reasonSummary };
    }
    const now = this.#deps.clock();
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, task.id, (entry) => ({
        ...entry,
        recovery: {
          ...defaultRecovery(entry),
          validationRetries: retriesUsed + 1,
          lastOperation: "validation-retry",
          lastAt: now,
        },
      })),
    );
    const notice = `Validation stopped (${proof.reasonSummary}). You approved another retry; I reran it at the same reviewed commit.`;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined) return;
      const notification: Notification = {
        id: this.#deps.idFactory(),
        message: notice,
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
    return { started: true, proven: true, reasonSummary: proof.reasonSummary };
  }

  /** Undoes the block that asking the restart question applied, so relaunch can proceed. */
  private async resumeFromAsk(task: TaskRecord): Promise<TaskRecord | undefined> {
    if (task.stage !== "blocked") {
      return task.stage === "implementing" ||
        task.stage === "scouting" ||
        task.stage === "reviewing"
        ? task
        : undefined;
    }
    if (
      task.previousStage !== "implementing" &&
      task.previousStage !== "scouting" &&
      task.previousStage !== "reviewing"
    ) {
      return undefined;
    }
    return this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
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
   * After an explicit user approval, re-proves death and relaunches once more without re-asking the
   * same question. Returns what was actually proven and done so the caller's decision receipt never
   * has to guess.
   */
  private async forceOneMoreRestart(task: TaskRecord): Promise<ForcedRestartOutcome> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined || (task.stage !== "implementing" && task.stage !== "scouting")) {
      return {
        relaunched: false,
        proven: false,
        reasonSummary: "the task is no longer implementing or scouting",
      };
    }
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) {
      return {
        relaunched: false,
        proven: false,
        reasonSummary: "an active job or reservation already owns this task",
      };
    }
    const proof = await this.proveDeath(task, runtime);
    if (!proof.proven) {
      await this.#deps.blockTask(
        task.id,
        `the approved restart could not proceed: ${proof.reasonSummary}`,
      );
      return { relaunched: false, proven: false, reasonSummary: proof.reasonSummary };
    }
    const recovery = defaultRecovery(runtime);
    const restartsUsed =
      recovery.restartGeneration === task.generation ? (recovery.restarts ?? 0) : 0;
    await this.snapshotWorktree(task, runtime, restartsUsed + 1);
    await this.settleProvenQuarantine(task.id);
    const extraInstructions = [
      `This is a restart the user explicitly approved after the automatic restart budget was reached (${proof.reasonSummary}). Uncommitted or partially applied changes from the previous attempt may already exist in this worktree. Run \`git status\` and \`git diff\` first, inspect any partial edits, and repair or complete them before continuing.`,
    ];
    const relaunch = await this.#deps.relaunchWorker(task, extraInstructions);
    if (!relaunch.relaunched) {
      await this.#deps.blockTask(
        task.id,
        `the approved restart could not launch a new worker: ${relaunch.reason ?? "relaunch was refused"}`,
      );
      return { relaunched: false, proven: true, reasonSummary: proof.reasonSummary };
    }
    const now = this.#deps.clock();
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, task.id, (entry) => ({
        ...entry,
        recovery: {
          ...defaultRecovery(entry),
          restarts: restartsUsed + 1,
          restartGeneration: task.generation,
          lastRestartFailureClass: classifyRestartFailure(proof.reasonSummary),
          lastRestartAt: now,
          lastOperation: "relaunch",
          lastAt: now,
        },
      })),
    );
    const notice = `The worker stopped (${proof.reasonSummary}). You approved another restart; I restarted it and your edits are kept.${relaunch.sourceDriftNote === undefined ? "" : ` Note: ${relaunch.sourceDriftNote}.`}`;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined) return;
      const notification: Notification = {
        id: this.#deps.idFactory(),
        message: notice,
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
    return { relaunched: true, proven: true, reasonSummary: proof.reasonSummary };
  }

  /**
   * The `reviewing` stage's equivalent of `forceOneMoreRestart`: after an explicit user approval,
   * re-proves the dead lens's death and relaunches once more without re-asking. A proof failure (an
   * unproven pane, or a worktree that has since moved off the reviewed HEAD) is refused outright, not
   * re-asked; the caller records that refusal as the decision.
   */
  private async forceOneMoreReviewRestart(task: TaskRecord): Promise<ForcedRestartOutcome> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined || task.stage !== "reviewing") {
      return { relaunched: false, proven: false, reasonSummary: "the task is no longer reviewing" };
    }
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) {
      return {
        relaunched: false,
        proven: false,
        reasonSummary: "an active job or reservation already owns this task",
      };
    }
    const deadReview = unresolvedReviewFailure(task, runtime);
    if (deadReview === undefined || !isQuarantinedReviewFailure(deadReview)) {
      return {
        relaunched: false,
        proven: false,
        reasonSummary: "no unresolved reviewer/verifier failure remains",
      };
    }
    if (task.worktree === undefined || task.reviewHead === undefined) {
      return {
        relaunched: false,
        proven: false,
        reasonSummary: "review has no worktree or reviewed HEAD",
      };
    }
    const lensLabel = deadReview.reviewLens ?? "review";
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
      if (!stopped) {
        return {
          relaunched: false,
          proven: false,
          reasonSummary: `the ${lensLabel} reviewer's pane could not be proven stopped`,
        };
      }
      await this.#deps.removeEndpoint(task.id, endpoint.paneId);
    }
    const checkout = await readCheckpoint(this.#deps.run, {
      repo: task.worktree.path,
      baseRef: task.worktree.baseHead,
    });
    if (checkout.head !== task.reviewHead || checkout.dirty || checkout.unmerged) {
      return {
        relaunched: false,
        proven: true,
        reasonSummary: "the worktree no longer matches the exact reviewed commit",
      };
    }
    const recovery = defaultRecovery(runtime);
    const restartsUsed =
      recovery.restartGeneration === task.generation ? (recovery.restarts ?? 0) : 0;
    await this.snapshotWorktree(task, runtime, restartsUsed + 1);
    const reasonSummary = deadReview.error ?? "reviewer stopped without a durable result";
    const now = this.#deps.clock();
    // Settle the stale quarantined operation the same way the automatic path does: this approval's
    // own re-proof is what turns its previously-uncertain outcome into a known-safe one, so the
    // replacement attempt's routing decision must not re-read the same quarantined phase and pause.
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, task.id, (entry) => ({
        ...entry,
        ...(entry.operation?.phase === "quarantined"
          ? { operation: { ...entry.operation, phase: "failed" as const } }
          : {}),
        recovery: {
          ...defaultRecovery(entry),
          restarts: restartsUsed + 1,
          restartGeneration: task.generation,
          lastRestartFailureClass: classifyRestartFailure(reasonSummary),
          lastRestartAt: now,
          lastOperation: "relaunch",
          lastAt: now,
        },
      })),
    );
    const notice = `The ${lensLabel} reviewer stopped (${reasonSummary}). You approved another restart; I restarted just that review pass and completed reviews are kept.`;
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined) return;
      const notification: Notification = {
        id: this.#deps.idFactory(),
        message: notice,
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
    const refreshed = await this.#deps.getTask(task.id);
    await this.#deps.relaunchReviewer(refreshed);
    return { relaunched: true, proven: true, reasonSummary };
  }

  private evidenceFor(
    identity: string,
    summary: string,
    observedAt: IsoTimestamp,
  ): RecoveryEvidence {
    return { kind: "durable-blocker", identity, summary, observedAt };
  }

  /**
   * Asks the one question central recovery ever asks, in plain English with no identifiers in the
   * what/want/risk text: task, generation, and dead-job identity go only in the recommendation's
   * details, which is already a separate line wherever a question is displayed.
   */
  private async askRestart(
    task: TaskRecord,
    incidentIdentity: string,
    deadJobId: string,
    now: IsoTimestamp,
    parts: Readonly<{ readonly what: string; readonly risk: string }>,
  ): Promise<CentralRecoveryOutcome> {
    const questionId = `${RESTART_QUESTION_ID_PREFIX}${incidentIdentity}`;
    const text = formatDecisionQuestion({
      what: parts.what,
      recommendation: RESTART_QUESTION_WANT,
      risk: parts.risk,
    });
    const details = `Details: task ${task.id}${task.requestId === undefined ? "" : `, request ${task.requestId}`}, generation ${task.generation}, dead job ${deadJobId}.`;
    const question: TaskQuestion = {
      id: questionId,
      text,
      recommendation: `${RESTART_QUESTION_WANT} ${details}`,
    };
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined || isTerminalTask(current)) return;
      if (current.communication?.question?.id === question.id) return;
      const asked = taskAsking(current, question, this.#deps.idFactory(), this.#deps.clock());
      await store.update(current.id, current.revision, () => asked);
    });
    await this.saveDecision(task.id, {
      taskId: task.id,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence: this.evidenceFor(incidentIdentity, parts.what, now),
      ownership: "unknown",
      priorOutcome: "uncertain",
      approval: "user-approval",
      unmetProofs: [],
      consequences: RESTART_QUESTION_WANT,
      disposition: "asked",
      dispositionReason: RESTART_QUESTION_WANT,
      questionId,
    });
    return { taskId: task.id, action: "asked", reason: text };
  }

  /**
   * Asks the one question the validating re-entry ever asks, in the same plain-English shape as
   * `askRestart`: what happened, what Tandem wants to do, what is risked either way, with no
   * identifiers in that text (task, generation, and dead-job identity go only in the
   * recommendation's details).
   */
  private async askValidationRetry(
    task: TaskRecord,
    incidentIdentity: string,
    deadJobId: string,
    now: IsoTimestamp,
    parts: Readonly<{ readonly what: string; readonly risk: string }>,
  ): Promise<CentralRecoveryOutcome> {
    const questionId = `${VALIDATION_RETRY_QUESTION_ID_PREFIX}${incidentIdentity}`;
    const text = formatRecoveryQuestion({
      what: parts.what,
      want: VALIDATION_RETRY_QUESTION_WANT,
      risk: parts.risk,
    });
    const details = `Details: task ${task.id}${task.requestId === undefined ? "" : `, request ${task.requestId}`}, generation ${task.generation}, dead job ${deadJobId}.`;
    const question: TaskQuestion = {
      id: questionId,
      text,
      recommendation: `${VALIDATION_RETRY_QUESTION_WANT} ${details}`,
    };
    await this.#deps.store.exclusive(async (store) => {
      const current = await store.read(task.id);
      if (current === undefined || isTerminalTask(current)) return;
      if (current.communication?.question?.id === question.id) return;
      const asked = taskAsking(current, question, this.#deps.idFactory(), this.#deps.clock());
      await store.update(current.id, current.revision, () => asked);
    });
    await this.saveDecision(task.id, {
      taskId: task.id,
      generation: task.generation,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      evidence: this.evidenceFor(incidentIdentity, parts.what, now),
      ownership: "unknown",
      priorOutcome: "uncertain",
      approval: "user-approval",
      unmetProofs: [],
      consequences: VALIDATION_RETRY_QUESTION_WANT,
      disposition: "asked",
      dispositionReason: VALIDATION_RETRY_QUESTION_WANT,
      questionId,
    });
    return { taskId: task.id, action: "asked", reason: text };
  }

  private async saveDecision(
    taskId: string,
    draft: Omit<RecoveryDecisionReceipt, "schemaVersion" | "id" | "decidedAt">,
  ): Promise<void> {
    const receipt: RecoveryDecisionReceipt = {
      schemaVersion: 1,
      id: `${RESTART_QUESTION_ID_PREFIX}${draft.evidence.identity}-${draft.disposition}`,
      ...draft,
      decidedAt: this.#deps.clock(),
    };
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (state) =>
      replaceRuntimeTask(state, taskId, (entry) => ({
        ...entry,
        recoveryDecisions: [
          ...(entry.recoveryDecisions ?? []).filter((existing) => existing.id !== receipt.id),
          receipt,
        ].slice(-MAX_RECOVERY_DECISION_RECEIPTS),
      })),
    );
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
   * nothing owned is left running is the prior job's outcome read. Defaults to the implementing/
   * scouting worker target when `target` is omitted.
   */
  private async proveDeath(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    target?: ProveDeathTarget,
  ): Promise<DeathProof> {
    const resolved: ProveDeathTarget =
      target ??
      (() => {
        const role = workerRoleForTask(task);
        return { endpointRole: role, jobRole: role, jobKind: "worker" };
      })();
    const staleEndpoint = (task.endpoints ?? []).find(
      (endpoint) =>
        endpoint.role === resolved.endpointRole &&
        endpoint.generation === task.generation &&
        !runtime.endpoints.some((owned) => owned.paneId === endpoint.paneId),
    );
    const lastJob = this.lastJobFor(runtime, task, resolved.jobRole, resolved.jobKind);
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

  private lastJobFor(
    runtime: RuntimeTaskState,
    task: TaskRecord,
    role: DurableJob["role"],
    kind: DurableJob["kind"] = "worker",
  ): DurableJob | undefined {
    const candidates = runtime.jobs.filter(
      (job) => job.kind === kind && job.role === role && job.generation === task.generation,
    );
    return candidates.at(-1);
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
    const observe = async (): Promise<"alive" | "gone" | "foreign" | "unknown"> => {
      try {
        const inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
        return inspection.activeWorker ? "alive" : "gone";
      } catch (error) {
        if (error instanceof EndpointOwnershipError) {
          return error.reason === "missing" ? "gone" : "foreign";
        }
        return "unknown";
      }
    };
    const closeIfOwned = async (): Promise<boolean> => {
      try {
        await closeEndpoint(this.#deps.run, { endpoint, cwd });
        return true;
      } catch (error) {
        return error instanceof EndpointOwnershipError && error.reason === "missing";
      }
    };
    let state = await observe();
    if (state === "foreign" || state === "unknown") return false;
    if (state === "gone") return closeIfOwned();
    try {
      await pauseWorkerTerminal(this.#deps.run, {
        endpoint,
        cwd,
        ...(terminalJob === undefined ? {} : { job: terminalJob }),
      });
    } catch {
      // Best effort; the interrupt and pid-signal steps below can still finish the job.
    }
    state = await observe();
    if (state === "foreign" || state === "unknown") return false;
    if (state === "gone") return closeIfOwned();
    try {
      await interruptEndpoint(this.#deps.run, {
        endpoint,
        cwd,
        timeoutMs: INTERRUPT_PROOF_TIMEOUT_MS,
        pollIntervalMs: INTERRUPT_PROOF_POLL_MS,
      });
      return closeIfOwned();
    } catch {
      // Interrupt could not prove the pane stopped within its own bound; fall through to a direct
      // signal, but only once the recorded pid is proven to be this pane's own foreground process.
    }
    if (terminalJob !== undefined) {
      const terminal = await readWorkerTerminal(terminalJob).catch(() => undefined);
      if (terminal !== undefined) {
        let inspection: Awaited<ReturnType<typeof inspectEndpoint>> | undefined;
        try {
          inspection = await inspectEndpoint(this.#deps.run, { endpoint, cwd });
        } catch {
          inspection = undefined;
        }
        const foreground =
          inspection?.processInfo.foregroundProcesses.some(
            (process) => process.pid === terminal.pid,
          ) === true;
        if (foreground) {
          try {
            await this.#deps.run({ argv: ["kill", "-TERM", String(terminal.pid)], cwd });
          } catch {
            // Best effort; the exit-proof poll below decides the outcome either way.
          }
          const deadline = Date.now() + KILL_PROOF_TIMEOUT_MS;
          while (Date.now() < deadline) {
            state = await observe();
            if (state === "gone") return closeIfOwned();
            if (state === "foreign" || state === "unknown") return false;
            await sleep(KILL_PROOF_POLL_MS);
          }
        }
      }
    }
    return false;
  }
}
