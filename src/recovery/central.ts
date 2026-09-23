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
 * re-entry without spending another round. Before spending a restart on `implementing` (including a
 * fix round), `recoverStuckWorker` checks whether the dead worker already finished and adopts its
 * committed HEAD instead (`adoptImplementerCommit`) — see `recoverBlockedTask` for how a `blocked`
 * task with a recoverable cause reaches any of this without a person asking.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readCheckpoint } from "../adapters/git.ts";
import { closeEndpoint, inspectEndpoint, interruptEndpoint } from "../adapters/herdr.ts";
import { EndpointOwnershipError } from "../adapters/primitives.ts";
import type {
  BlockCause,
  BlockCauseKind,
  Clock,
  CommandRunner,
  Endpoint,
  IdFactory,
  IsoTimestamp,
  Notification,
  TaskQuestion,
  TaskRecord,
  TaskStage,
} from "../contracts.ts";
import { activeRuntimeJob, taskRuntime, unreleasedReservation } from "../runtime/activity.ts";
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
import { readWorkerTerminal, type WorkerTerminalJob } from "../workers/terminal.ts";
import { pauseWorkerTerminal } from "../workers/terminal-control.ts";
import { isQuarantinedReviewFailure, unresolvedReviewFailure } from "./central-review.ts";

/** What one central recovery pass did for a task. */
export type CentralRecoveryAction =
  | "relaunched"
  | "adopted"
  | "resumed"
  | "asked"
  | "blocked"
  | "skipped";

export type CentralRecoveryOutcome = Readonly<{
  readonly taskId: string;
  readonly action: CentralRecoveryAction;
  readonly reason: string;
}>;

/** Prefix shared by every recovery question id, so an answer path can recognize one. */
export const RECOVERY_QUESTION_ID_PREFIX = "recovery-";

/** One budget for every validation retry, automatic or answered. */
export const MAX_VALIDATION_RETRIES = 3;

/** Phrases that mark a provider-side quota or availability block rather than a defect in the work. */
const TEMPORARY_AVAILABILITY_PATTERNS: readonly RegExp[] = [
  /\brate[ -]?limit/iu,
  /\bquota\b/iu,
  /\bover capacity\b/iu,
  /\boverloaded\b/iu,
  /\bthrottled\b/iu,
  /\b429\b/u,
  /\b503\b/u,
  /\bservice unavailable\b/iu,
  /\btemporarily unavailable\b/iu,
  /\btry again later\b/iu,
];

/** Block-cause kinds within `unusable-result` central recovery may still retry automatically for a
 *  blocked task: each still reflects an infrastructure-shaped failure (a worker or review pane
 *  vanishing, or a result invalidated by a stale instruction revision), never a lens that ran to
 *  completion and reported its own failure (`review-lens-failed` is deliberately excluded). */
const RECOVERABLE_UNUSABLE_RESULT_KINDS: ReadonlySet<BlockCauseKind> = new Set([
  "worker-failed",
  "stale-review-state",
  "no-clean-checkpoint",
]);

/**
 * Whether a blocked task's typed cause is one central recovery may re-enter automatically: any
 * `lost-resource` cause (nothing about the task's own work is in question), or an `unusable-result`
 * cause whose kind is still infrastructure-shaped. A `user-decision` or `safety-stop` cause is never
 * recoverable automatically; only a person resolves those.
 */
function isRecoverableBlockCause(cause: BlockCause): boolean {
  if (cause.group === "lost-resource") return true;
  return cause.group === "unusable-result" && RECOVERABLE_UNUSABLE_RESULT_KINDS.has(cause.kind);
}

/** Legacy free-text worker-death shapes recorded before every block site carried a typed
 *  `BlockCause`. Central recovery's blocked-task re-entry recognizes only these shapes for a task
 *  whose block predates the typed-cause migration; anything else with no typed cause is left alone. */
const LEGACY_WORKER_DEATH_TEXT_PATTERNS: readonly RegExp[] = [
  /\bstale worker instruction\b/iu,
  /\bworker stopped without a durable result\b/iu,
  /\bworker launch (?:could not be proven|was not proven|not proven)\b/iu,
  /\bendpoint (?:is )?missing\b/iu,
];

/** Whether legacy free-text (no typed `BlockCause`) reads as a worker-death shape central recovery
 *  may still re-enter automatically. */
function isLegacyWorkerDeathBlockText(value: string): boolean {
  return LEGACY_WORKER_DEATH_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

/** The two failure classes the central recovery module distinguishes for the same-class guard. */
const RESTART_FAILURE_CLASSES = ["provider-unavailable", "unknown"] as const;

type RestartFailureClass = (typeof RESTART_FAILURE_CLASSES)[number];

/** Classifies a dead worker's failure text for the restart same-failure-class guard: a
 *  provider-side quota or availability block, or anything else. */
function classifyRestartFailure(text: string): RestartFailureClass {
  return TEMPORARY_AVAILABILITY_PATTERNS.some((pattern) => pattern.test(text))
    ? "provider-unavailable"
    : "unknown";
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

function defaultRecovery(
  runtime: RuntimeTaskState | undefined,
): NonNullable<RuntimeTaskState["recovery"]> {
  return (
    runtime?.recovery ?? {
      schemaVersion: 1,
      validationRetries: 0,
    }
  );
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
    const ancestor = await deps.run({
      argv: ["git", "-C", path, "merge-base", "--is-ancestor", branchHead, targetHead],
      cwd: path,
    });
    if (ancestor.code !== 0) {
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
/** Every restart question's id starts with this, so an answer path can route to this module alone. */
export const RESTART_QUESTION_ID_PREFIX = `${RECOVERY_QUESTION_ID_PREFIX}restart-`;

export type RelaunchWorker = (
  task: TaskRecord,
  extraInstructions: readonly string[],
) => Promise<
  Readonly<{
    readonly relaunched: boolean;
    /** One plain sentence saying why nothing started; the specifics go in `detail`. */
    readonly reason?: string;
    readonly detail?: string;
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
    ...(deadJobId === "none" ? {} : { jobId: deadJobId }),
  };
}

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

/** The `previousStage` values a blocked task's re-entry knows how to carry forward. `awaiting-fixes`
 *  resumes there and stops: the next reconcile pass's own `beginFixes` call carries it into
 *  `implementing`, whose re-entry is wired below, so nothing here needs to duplicate that hand-off. */
const BLOCKED_TASK_REENTRY_STAGES: ReadonlySet<TaskStage> = new Set([
  "implementing",
  "scouting",
  "validating",
  "reviewing",
  "awaiting-fixes",
]);

/**
 * Whether a `blocked` task is one central recovery may re-enter automatically, without a person
 * choosing to. Every condition here is a refusal, never a discovery: an ineligible task is left
 * exactly as blocked as it already was.
 *
 *  - The task must actually be blocked, with a `previousStage` this module knows how to resume into.
 *  - Its cause must be recoverable: a typed `lost-resource`/`unusable-result` cause
 *    (`isRecoverableBlockCause`), or — for a block recorded before every site carried a typed cause —
 *    free text matching a known worker-death shape (`isLegacyWorkerDeathBlockText`). A
 *    `user-decision` or `safety-stop` cause, and any other free text, is never eligible: only a
 *    person resolves those.
 *  - An unanswered question that is not itself a recovery question means a person is already being
 *    asked something else; central recovery never barges in ahead of that.
 *  - A pending stop request means a person already asked to stop the task; central recovery never
 *    restarts work underneath a stop.
 */
export function canCentralRecoverBlockedTask(
  task: TaskRecord,
  runtime: RuntimeTaskState | undefined,
): boolean {
  if (task.stage !== "blocked") return false;
  if (task.previousStage === undefined || !BLOCKED_TASK_REENTRY_STAGES.has(task.previousStage)) {
    return false;
  }
  const recoverable =
    task.blockCause !== undefined
      ? isRecoverableBlockCause(task.blockCause)
      : isLegacyWorkerDeathBlockText(task.blockReason ?? "");
  if (!recoverable) return false;
  const question = task.communication?.question;
  if (question !== undefined && !question.id.startsWith(RECOVERY_QUESTION_ID_PREFIX)) return false;
  if (runtime?.stopRequest !== undefined) return false;
  return true;
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

const RESTART_REPLY = 'Reply "restart" or "stop".';
const VALIDATION_RETRY_REPLY = 'Reply "retry" or "stop".';

const VALIDATION_RETRY_QUESTION_WANT =
  'Reply "retry" to rerun validation at the same reviewed commit, or "stop" to leave it blocked so you can look at it yourself.';

/**
 * Central recovery: stop, save, re-enter. The `implementing`/`scouting`, `validating`, and
 * `reviewing` stages' re-entry are wired via `recoverStuckWorker`; a `blocked` task with a
 * recoverable cause reaches the same re-entry through `recoverBlockedTask` without a person asking.
 * Every other stage is reported as `skipped` so a caller falls back to whatever it did before.
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
      const cause: BlockCause = {
        group: "safety-stop",
        kind: "runtime-metadata-missing",
        summary:
          "Tandem lost its saved record for this task, so it can't restart it automatically.",
        detail: "durable runtime metadata is missing; no re-entry is possible",
      };
      await reportBlock(this.#deps.blockTask, task.id, cause);
      return { taskId: task.id, action: "blocked", reason: cause.summary };
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
      return this.askRestart(task, incidentIdentity, proof.deadJobId, {
        ask: "The worker stopped but may still be running. Restart it?",
        cause: proof.reasonSummary,
      });
    }

    // A dead implementer (including a fix-round implementer) may have already finished: adopt its
    // committed HEAD instead of spending a restart on rerunning work that already happened. Never for
    // `scouting`, which has no comparable finished-commit shape.
    if (task.kind === "implementation" && task.stage === "implementing") {
      const adoption = await this.adoptableImplementerCommit(task);
      if (adoption.head !== undefined) {
        const adoptedOutcome = await this.adoptImplementerCommit(
          task,
          adoption.head,
          adoption.detached ?? false,
          proof,
        );
        // `undefined` means adoption turned out not to be safe after all (the branch-pointing step
        // could not proceed without forcing something away); fall through to the ordinary relaunch
        // path below rather than treating that as ineligibility to restart at all.
        if (adoptedOutcome !== undefined) return adoptedOutcome;
      }
    }

    const recovery = defaultRecovery(runtime);
    const restartsUsed =
      recovery.restartGeneration === task.generation ? (recovery.restarts ?? 0) : 0;
    if (restartsUsed >= MAX_AUTOMATIC_RESTARTS_PER_GENERATION) {
      return this.askRestart(task, incidentIdentity, proof.deadJobId, {
        ask: `The worker stopped again after ${restartsUsed} restart${restartsUsed === 1 ? "" : "s"}. Restart once more?`,
        cause: proof.reasonSummary,
      });
    }

    const failureClass = classifyRestartFailure(proof.reasonSummary);
    const withinImmediateWindow =
      proof.elapsedMs !== undefined && proof.elapsedMs < IMMEDIATE_FAILURE_WINDOW_MS;
    const sameClassAsLastRestart =
      restartsUsed > 0 && recovery.lastRestartFailureClass === failureClass;
    if (withinImmediateWindow && sameClassAsLastRestart) {
      return this.askRestart(task, incidentIdentity, proof.deadJobId, {
        ask: "The worker failed the same way right after restarting. Restart again?",
        cause: proof.reasonSummary,
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
      const cause = refusedRelaunchCause(relaunch, proof.deadJobId, "automatic restart");
      await reportBlock(this.#deps.blockTask, task.id, cause);
      return { taskId: task.id, action: "blocked", reason: cause.summary };
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
    return { taskId: task.id, action: "relaunched", reason: notice };
  }

  /**
   * The scheduler tick's entry point for a `blocked` task:
   * when `canCentralRecoverBlockedTask` says the block is automatically recoverable, resumes the
   * task to its previous stage and runs that stage's own stop/save/re-entry (`recoverStuckWorker`,
   * which already dispatches `implementing`/`scouting`/`validating`/`reviewing`) exactly as if the
   * task had never blocked. `awaiting-fixes` resumes and stops there: its own next reconcile pass
   * carries it into `implementing` through the ordinary `beginFixes` hand-off, so nothing here
   * duplicates that. Anything not eligible is reported `skipped` and left blocked.
   */
  public async recoverBlockedTask(task: TaskRecord): Promise<CentralRecoveryOutcome> {
    if (task.stage !== "blocked") {
      return { taskId: task.id, action: "skipped", reason: "task is not blocked" };
    }
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (!canCentralRecoverBlockedTask(task, runtime)) {
      return {
        taskId: task.id,
        action: "skipped",
        reason: "block is not eligible for automatic recovery",
      };
    }
    const resumed = await this.#deps.store.exclusive(async (store) => {
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
    if (resumed === undefined || resumed.stage === "blocked") {
      return { taskId: task.id, action: "skipped", reason: "task could not be resumed" };
    }
    if (
      resumed.stage !== "implementing" &&
      resumed.stage !== "scouting" &&
      resumed.stage !== "validating" &&
      resumed.stage !== "reviewing"
    ) {
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
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined) {
      const cause: BlockCause = {
        group: "safety-stop",
        kind: "runtime-metadata-missing",
        summary:
          "Tandem lost its saved record for this task, so it can't restart it automatically.",
        detail: "durable runtime metadata is missing; no re-entry is possible",
      };
      await reportBlock(this.#deps.blockTask, task.id, cause);
      return { taskId: task.id, action: "blocked", reason: cause.summary };
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
    const incidentIdentity = restartIncidentIdentity({
      taskId: task.id,
      generation: task.generation,
      deadJobId: proof.deadJobId,
    });
    if (!proof.proven) {
      return this.askValidationRetry(task, incidentIdentity, proof.deadJobId, {
        ask: "Checks stopped but may still be running. Retry them?",
        cause: proof.reasonSummary,
      });
    }

    const recovery = defaultRecovery(runtime);
    const retriesUsed = recovery.validationRetries;
    if (retriesUsed >= MAX_VALIDATION_RETRIES) {
      return this.askValidationRetry(task, incidentIdentity, proof.deadJobId, {
        ask: `Checks stopped again after ${retriesUsed} retr${retriesUsed === 1 ? "y" : "ies"}. Retry once more?`,
        cause: proof.reasonSummary,
      });
    }

    // --- Moves 2 & 3: save then re-enter, through the shared save/revalidate/notify tail. ---
    const notice = `Validation stopped (${proof.reasonSummary}). I reran it at the same reviewed commit. (Retry ${retriesUsed + 1} of ${MAX_VALIDATION_RETRIES}.)`;
    const revalidated = await this.snapshotAndRevalidate(task, runtime, retriesUsed, notice, {
      summary: "Tandem tried to rerun the checks automatically, but they couldn't start.",
      detail: "automatic validation retry could not restart validation",
      deadJobId: proof.deadJobId,
    });
    if (!revalidated.started) {
      return { taskId: task.id, action: "blocked", reason: revalidated.reason as string };
    }
    return { taskId: task.id, action: "relaunched", reason: notice };
  }

  /**
   * The shared save/re-enter tail for `recoverStuckValidation` and `forceOneMoreValidationRetry`:
   * snapshot the worktree, relaunch validation through the stage's normal entry
   * point, and — only on success — bump the shared `validationRetries` counter and notify.
   */
  private async snapshotAndRevalidate(
    task: TaskRecord,
    runtime: RuntimeTaskState,
    retriesUsed: number,
    notice: string,
    refusal: Readonly<{
      readonly summary: string;
      readonly detail: string;
      readonly deadJobId: string;
    }>,
  ): Promise<Readonly<{ readonly started: boolean; readonly reason?: string }>> {
    await this.snapshotWorktree(task, runtime, retriesUsed + 1);
    const revalidated = await this.#deps.revalidate(task);
    if (!revalidated.started) {
      const reason = revalidated.reason ?? "validation could not be restarted";
      await reportBlock(this.#deps.blockTask, task.id, {
        group: "lost-resource",
        kind: "allocation-failed",
        summary: refusal.summary,
        detail: `${refusal.detail}: ${reason}`,
        ...(refusal.deadJobId === "none" ? {} : { jobId: refusal.deadJobId }),
      });
      return { started: false, reason };
    }
    const now = this.#deps.clock();
    await updateRuntimeState(this.#deps.store, this.#deps.runtimePath, (current) =>
      replaceRuntimeTask(current, task.id, (entry) => ({
        ...entry,
        recovery: {
          ...defaultRecovery(entry),
          validationRetries: retriesUsed + 1,
        },
      })),
    );
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
    return { started: true };
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
        return this.askRestart(task, incidentIdentity, deadReview.id, {
          ask: `The ${lensLabel} reviewer stopped but may still be running. Restart it?`,
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
      return this.askRestart(task, incidentIdentity, deadReview.id, {
        ask: `The ${lensLabel} reviewer stopped, and the code changed since review began. Restart review anyway?`,
      });
    }

    const recovery = defaultRecovery(runtime);
    const restartsUsed =
      recovery.restartGeneration === task.generation ? (recovery.restarts ?? 0) : 0;
    if (restartsUsed >= MAX_AUTOMATIC_RESTARTS_PER_GENERATION) {
      return this.askRestart(task, incidentIdentity, deadReview.id, {
        ask: `The ${lensLabel} reviewer stopped again after ${restartsUsed} restart${restartsUsed === 1 ? "" : "s"}. Restart once more?`,
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
    if (choice === "stop") {
      return { handled: true };
    }
    // choice === "restart": reuse the same three-move path, treating this approval as spending one
    // more restart, but never as proof by itself — forceOneMoreRestart/forceOneMoreReviewRestart
    // re-prove death first.
    const resumed = cleared === undefined ? undefined : await this.resumeFromAsk(cleared);
    if (resumed?.stage === "reviewing") await this.forceOneMoreReviewRestart(resumed);
    else if (resumed !== undefined) await this.forceOneMoreRestart(resumed);
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
    if (choice === "stop") {
      return { handled: true };
    }
    // choice === "retry": reuse the same three-move path, treating this approval as spending one
    // more validation retry, but never as proof by itself — forceOneMoreValidationRetry re-proves
    // death first.
    const resumed = cleared === undefined ? undefined : await this.resumeFromValidationAsk(cleared);
    if (resumed !== undefined) await this.forceOneMoreValidationRetry(resumed);
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
   * re-asking the same question.
   */
  private async forceOneMoreValidationRetry(task: TaskRecord): Promise<void> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined || task.stage !== "validating") {
      return;
    }
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) {
      return;
    }
    const proof = await this.proveDeath(task, runtime, VALIDATION_PROVE_DEATH_TARGET);
    if (!proof.proven) {
      await reportBlock(this.#deps.blockTask, task.id, {
        group: "safety-stop",
        kind: "ownership-unprovable",
        summary: `You approved rerunning the checks, but Tandem couldn't confirm the old run stopped.`,
        detail: `the approved validation retry could not proceed: ${proof.reasonSummary}`,
        ...(proof.deadJobId === "none" ? {} : { jobId: proof.deadJobId }),
      });
      return;
    }
    const recovery = defaultRecovery(runtime);
    const retriesUsed = recovery.validationRetries;
    const notice = `Validation stopped (${proof.reasonSummary}). You approved another retry; I reran it at the same reviewed commit.`;
    await this.snapshotAndRevalidate(task, runtime, retriesUsed, notice, {
      summary: "You approved rerunning the checks, but they couldn't start.",
      detail: "the approved validation retry could not restart validation",
      deadJobId: proof.deadJobId,
    });
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
   * same question.
   */
  private async forceOneMoreRestart(task: TaskRecord): Promise<void> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined || (task.stage !== "implementing" && task.stage !== "scouting")) {
      return;
    }
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) {
      return;
    }
    const proof = await this.proveDeath(task, runtime);
    if (!proof.proven) {
      await reportBlock(this.#deps.blockTask, task.id, {
        group: "safety-stop",
        kind: "ownership-unprovable",
        summary: `You approved a restart, but Tandem couldn't confirm the old worker stopped.`,
        detail: `the approved restart could not proceed: ${proof.reasonSummary}`,
        ...(proof.deadJobId === "none" ? {} : { jobId: proof.deadJobId }),
      });
      return;
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
      await reportBlock(
        this.#deps.blockTask,
        task.id,
        refusedRelaunchCause(relaunch, proof.deadJobId, "approved restart"),
      );
      return;
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
  }

  /**
   * The `reviewing` stage's equivalent of `forceOneMoreRestart`: after an explicit user approval,
   * re-proves the dead lens's death and relaunches once more without re-asking. A proof failure (an
   * unproven pane, or a worktree that has since moved off the reviewed HEAD) is refused outright, not
   * re-asked; the caller records that refusal as the decision.
   */
  private async forceOneMoreReviewRestart(task: TaskRecord): Promise<void> {
    const state = await readRuntimeState(this.#deps.runtimePath);
    const runtime = taskRuntime(state, task.id);
    if (runtime === undefined || task.stage !== "reviewing") {
      return;
    }
    if (runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation)) {
      return;
    }
    const deadReview = unresolvedReviewFailure(task, runtime);
    if (deadReview === undefined || !isQuarantinedReviewFailure(deadReview)) {
      return;
    }
    if (task.worktree === undefined || task.reviewHead === undefined) {
      return;
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
      if (!stopped) return;
      await this.#deps.removeEndpoint(task.id, endpoint.paneId);
    }
    const checkout = await readCheckpoint(this.#deps.run, {
      repo: task.worktree.path,
      baseRef: task.worktree.baseHead,
    });
    if (checkout.head !== task.reviewHead || checkout.dirty || checkout.unmerged) {
      return;
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
  }

  /**
   * Asks the one question central recovery ever asks, as one short plain-English question with no
   * identifiers: task, generation, dead-job identity, and the technical cause go only in the
   * recommendation's details.
   */
  private async askRestart(
    task: TaskRecord,
    incidentIdentity: string,
    deadJobId: string,
    parts: Readonly<{ readonly ask: string; readonly cause?: string }>,
  ): Promise<CentralRecoveryOutcome> {
    const questionId = `${RESTART_QUESTION_ID_PREFIX}${incidentIdentity}`;
    const text = formatDecisionQuestion({ ask: parts.ask, note: RESTART_REPLY });
    const details = `Details: task ${task.id}${task.requestId === undefined ? "" : `, request ${task.requestId}`}, generation ${task.generation}, dead job ${deadJobId}${parts.cause === undefined ? "" : `, cause: ${parts.cause}`}.`;
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
    return { taskId: task.id, action: "asked", reason: text };
  }

  /**
   * Asks the one question the validating re-entry ever asks, in the same short shape as
   * `askRestart`.
   */
  private async askValidationRetry(
    task: TaskRecord,
    incidentIdentity: string,
    deadJobId: string,
    parts: Readonly<{ readonly ask: string; readonly cause?: string }>,
  ): Promise<CentralRecoveryOutcome> {
    const questionId = `${VALIDATION_RETRY_QUESTION_ID_PREFIX}${incidentIdentity}`;
    const text = formatDecisionQuestion({ ask: parts.ask, note: VALIDATION_RETRY_REPLY });
    const details = `Details: task ${task.id}${task.requestId === undefined ? "" : `, request ${task.requestId}`}, generation ${task.generation}, dead job ${deadJobId}${parts.cause === undefined ? "" : `, cause: ${parts.cause}`}.`;
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
    return { taskId: task.id, action: "asked", reason: text };
  }

  /**
   * Whether a dead implementer (including a fix-round implementer) already finished: the task
   * worktree is clean, not unmerged, checked out on the task's own branch, and HEAD is a new commit
   * strictly ahead of the task's base — and that HEAD is not something already reviewed. Review
   * evidence is pinned to an exact HEAD the same way `recoverStuckReviewer` treats it, so a HEAD that
   * already has a review result attached is never re-adopted as if it were new.
   */
  /**
   * A worker that committed and then died is exactly as likely to have left the worktree detached
   * (it never switched back to the task branch) as still on the task branch, and the live incident
   * this feature exists for was detached. Detached and on-the-task's-own-branch are both adoptable;
   * a checkout on some *other* named branch is someone else's work and is never adopted. When
   * detached, this also checks (read-only) that the task branch, if it already exists, is an
   * ancestor of the adopted commit — `adoptImplementerCommit`'s later `pointTaskBranchAtCommit` call
   * must never force the branch away from real work, so an eligible-looking-but-diverged branch is
   * screened out here rather than discovered mid-mutation.
   */
  private async adoptableImplementerCommit(
    task: TaskRecord,
  ): Promise<Readonly<{ readonly head?: string; readonly detached?: boolean }>> {
    if (task.worktree === undefined) return {};
    const { path, baseHead, branch } = task.worktree;
    try {
      const checkout = await readCheckpoint(this.#deps.run, { repo: path, baseRef: baseHead });
      if (checkout.dirty || checkout.unmerged || checkout.head === baseHead) return {};
      if (task.reviewHead === checkout.head) return {};
      if (task.reviews.some((review) => review.head === checkout.head)) return {};
      const onBranch = await this.#deps.run({
        argv: ["git", "-C", path, "branch", "--show-current"],
        cwd: path,
      });
      if (onBranch.code !== 0) return {};
      const currentBranch = onBranch.stdout.trim();
      const detached = currentBranch.length === 0;
      if (!detached && currentBranch !== branch) return {};
      const ancestor = await this.#deps.run({
        argv: ["git", "-C", path, "merge-base", "--is-ancestor", baseHead, checkout.head],
        cwd: path,
      });
      if (ancestor.code !== 0) return {};
      if (detached) {
        const branchHead = await this.#deps.run({
          argv: ["git", "-C", path, "rev-parse", "--verify", `refs/heads/${branch}`],
          cwd: path,
        });
        if (branchHead.code === 0) {
          const branchAncestor = await this.#deps.run({
            argv: [
              "git",
              "-C",
              path,
              "merge-base",
              "--is-ancestor",
              branchHead.stdout.trim(),
              checkout.head,
            ],
            cwd: path,
          });
          // The task branch already exists and is not an ancestor of the adopted commit: it holds
          // real work the adoption would otherwise force away. Never adopted; falls back to relaunch.
          if (branchAncestor.code !== 0) return {};
        }
      }
      return { head: checkout.head, detached };
    } catch {
      // An unreadable checkout is never treated as an adoptable commit; the caller falls back to
      // the ordinary relaunch path, which re-derives its own proof from the same worktree.
      return {};
    }
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
    head: string,
    detached: boolean,
    proof: DeathProof,
  ): Promise<CentralRecoveryOutcome | undefined> {
    const branch = task.worktree?.branch;
    const path = task.worktree?.path;
    if (branch === undefined || path === undefined) return undefined;
    if (detached) {
      try {
        await pointTaskBranchAtCommit(this.#deps, path, branch, head);
      } catch {
        return undefined;
      }
    }
    await this.settleProvenQuarantine(task.id);
    const reportPath = join(
      taskJobsDirectory(this.#deps.home, task.id),
      String(task.generation),
      "recovery-adopt-commit",
      "report.txt",
    );
    await writeTextAtomically(
      reportPath,
      [
        "Central recovery adopted this commit after the worker stopped mid-task.",
        "",
        `The worker stopped (${proof.reasonSummary}) after committing its work and exited without`,
        "reporting a result. Recovery confirmed the worktree was clean and at a new commit strictly",
        "ahead of the task's base, and sent that commit to validation and review instead of rerunning",
        "the worker.",
        "",
        `Adopted commit: ${head}`,
        detached
          ? `The worktree was left detached at that commit; recovery pointed branch ${branch} at it.`
          : `Worktree branch: ${branch}.`,
      ].join("\n"),
    );
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
        updatedAt: this.#deps.clock(),
        notifications: [...entry.notifications, notification],
      }));
    });
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
