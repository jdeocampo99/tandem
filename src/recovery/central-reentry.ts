/**
 * Central recovery's pure decisions: which stages re-enter and how, whether a blocked task may be
 * re-entered without a person, and whether a proven-dead worker, validation run, or review lens is
 * restarted or asked about. Nothing here reads or writes state; `central.ts` gathers the facts,
 * applies these decisions, and performs every effect.
 */
import type {
  BlockCause,
  BlockCauseKind,
  IsoTimestamp,
  TaskRecord,
  TaskStage,
} from "../contracts.ts";
import { activeRuntimeJob, unreleasedReservation } from "../runtime/activity.ts";
import type { RuntimeRecoveryState, RuntimeTaskState } from "../runtime/schema.ts";
import type { ReservationRefusal } from "../workers/admission.ts";

/** Prefix shared by every recovery question id, so an answer path can recognize one. */
export const RECOVERY_QUESTION_ID_PREFIX = "recovery-";

/** The two-restart budget every task generation gets before central recovery has to ask. */
export const MAX_AUTOMATIC_RESTARTS_PER_GENERATION = 2;

/** One budget for every validation retry, automatic or answered. */
export const MAX_VALIDATION_RETRIES = 3;

/** A dead job that failed inside this window of its own launch is treated as an immediate failure
 *  for the same-failure-class guard, e.g. a provider outage that rejects every attempt at once. */
const IMMEDIATE_FAILURE_WINDOW_MS = 15 * 1_000;

/**
 * Each stage's single re-entry action. `awaiting-fixes` only resumes: its own next reconcile pass
 * carries it into `implementing` through `beginFixes`, which spends the review round before touching
 * a pane, so the implementing re-entry picks up a missing pane without spending another round.
 */
export type StageReentry =
  | "relaunch-worker"
  | "rerun-validation"
  | "restart-review"
  | "resume-only";

const STAGE_REENTRY: Readonly<Partial<Record<TaskStage, StageReentry>>> = {
  implementing: "relaunch-worker",
  scouting: "relaunch-worker",
  validating: "rerun-validation",
  reviewing: "restart-review",
  "awaiting-fixes": "resume-only",
};

export function stageReentry(stage: TaskStage | undefined): StageReentry | undefined {
  return stage === undefined ? undefined : STAGE_REENTRY[stage];
}

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

function isLegacyWorkerDeathBlockText(value: string): boolean {
  return LEGACY_WORKER_DEATH_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Whether a `blocked` task is one central recovery may re-enter automatically, without a person
 * choosing to. Every condition here is a refusal, never a discovery: an ineligible task is left
 * exactly as blocked as it already was.
 *
 *  - The task must actually be blocked, with a `previousStage` that has a re-entry.
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
  if (stageReentry(task.previousStage) === undefined) return false;
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

/** Whether an active job or an unreleased reservation already owns the task, so recovery must not
 *  start anything for it. */
export function hasLiveOwner(runtime: RuntimeTaskState): boolean {
  return runtime.jobs.some(activeRuntimeJob) || unreleasedReservation(runtime.reservation);
}

/**
 * Refusals only a changing fact clears: a slot or worker freeing, a question being answered, a
 * stop settling. Blocking on one would only be resumed and refused again on the next pass, so
 * recovery waits instead and simply tries again then.
 */
const WAITING_REFUSALS: ReadonlySet<ReservationRefusal["refusal"]> = new Set([
  "slot-held",
  "job-running",
  "worker-limit",
  "routing-question",
  "stop-requested",
]);

export function waitsOnFact(refusal: ReservationRefusal["refusal"] | undefined): boolean {
  return refusal !== undefined && WAITING_REFUSALS.has(refusal);
}

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

type RestartFailureClass = NonNullable<RuntimeRecoveryState["lastRestartFailureClass"]>;

/** Classifies a dead worker's failure text for the restart same-failure-class guard: a
 *  provider-side quota or availability block, or anything else. */
export function classifyRestartFailure(text: string): RestartFailureClass {
  return TEMPORARY_AVAILABILITY_PATTERNS.some((pattern) => pattern.test(text))
    ? "provider-unavailable"
    : "unknown";
}

/** What the stop move proved about the prior worker or validation run. */
export type DeathProof = Readonly<{
  readonly proven: boolean;
  readonly deadJobId: string;
  readonly reasonSummary: string;
  readonly elapsedMs?: number;
}>;

export function recoveryCounters(runtime: RuntimeTaskState | undefined): RuntimeRecoveryState {
  return runtime?.recovery ?? { schemaVersion: 1, validationRetries: 0 };
}

/** Restarts already spent this generation; a new generation starts from zero. */
export function restartsUsedThisGeneration(
  recovery: RuntimeRecoveryState,
  generation: number,
): number {
  return recovery.restartGeneration === generation ? (recovery.restarts ?? 0) : 0;
}

/** Either ask a person (with the one-line question), or restart as attempt `attempt`. */
export type RestartDecision =
  | Readonly<{ readonly kind: "ask"; readonly ask: string }>
  | Readonly<{
      readonly kind: "restart";
      readonly attempt: number;
      readonly failureClass: RestartFailureClass;
    }>;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The implementing/scouting restart decision: ask when death is unproven, when the generation's
 * restart budget is spent, or when the job died right after launch the same way the last restart
 * did; otherwise restart.
 */
export function decideWorkerRestart(
  input: Readonly<{
    readonly proof: DeathProof;
    readonly recovery: RuntimeRecoveryState;
    readonly generation: number;
  }>,
): RestartDecision {
  const { proof, recovery } = input;
  if (!proof.proven) {
    return { kind: "ask", ask: "The worker stopped but may still be running. Restart it?" };
  }
  const restartsUsed = restartsUsedThisGeneration(recovery, input.generation);
  if (restartsUsed >= MAX_AUTOMATIC_RESTARTS_PER_GENERATION) {
    return {
      kind: "ask",
      ask: `The worker stopped again after ${restartsUsed} restart${plural(restartsUsed, "", "s")}. Restart once more?`,
    };
  }
  const failureClass = classifyRestartFailure(proof.reasonSummary);
  const withinImmediateWindow =
    proof.elapsedMs !== undefined && proof.elapsedMs < IMMEDIATE_FAILURE_WINDOW_MS;
  const sameClassAsLastRestart =
    restartsUsed > 0 && recovery.lastRestartFailureClass === failureClass;
  if (withinImmediateWindow && sameClassAsLastRestart) {
    return {
      kind: "ask",
      ask: "The worker failed the same way right after restarting. Restart again?",
    };
  }
  return { kind: "restart", attempt: restartsUsed + 1, failureClass };
}

export type ValidationRetryDecision =
  | Readonly<{ readonly kind: "ask"; readonly ask: string }>
  | Readonly<{ readonly kind: "retry"; readonly attempt: number }>;

/** The validating retry decision: ask when death is unproven or the retry budget is spent. */
export function decideValidationRetry(
  proof: DeathProof,
  recovery: RuntimeRecoveryState,
): ValidationRetryDecision {
  if (!proof.proven) {
    return { kind: "ask", ask: "Checks stopped but may still be running. Retry them?" };
  }
  const retriesUsed = recovery.validationRetries;
  if (retriesUsed >= MAX_VALIDATION_RETRIES) {
    return {
      kind: "ask",
      ask: `Checks stopped again after ${retriesUsed} retr${plural(retriesUsed, "y", "ies")}. Retry once more?`,
    };
  }
  return { kind: "retry", attempt: retriesUsed + 1 };
}

/** What stopping a dead review lens found: its pane may still run, the worktree moved off the
 *  reviewed HEAD, or the lens is proven stopped at the exact reviewed HEAD. */
export type ReviewLensStop = "still-running" | "code-moved" | "stopped";

/** The failure text a dead review lens is classified and reported by. */
export function reviewFailureSummary(error: string | undefined): string {
  return error ?? "reviewer stopped without a durable result";
}

/**
 * The reviewing restart decision. Review evidence is pinned to the exact reviewed HEAD, so a lens
 * that may still run or whose worktree moved is asked about, never relaunched.
 */
export function decideReviewRestart(
  input: Readonly<{
    readonly stop: ReviewLensStop;
    readonly lensLabel: string;
    readonly error: string | undefined;
    readonly recovery: RuntimeRecoveryState;
    readonly generation: number;
  }>,
): RestartDecision {
  const { lensLabel } = input;
  if (input.stop === "still-running") {
    return {
      kind: "ask",
      ask: `The ${lensLabel} reviewer stopped but may still be running. Restart it?`,
    };
  }
  if (input.stop === "code-moved") {
    return {
      kind: "ask",
      ask: `The ${lensLabel} reviewer stopped, and the code changed since review began. Restart review anyway?`,
    };
  }
  const restartsUsed = restartsUsedThisGeneration(input.recovery, input.generation);
  if (restartsUsed >= MAX_AUTOMATIC_RESTARTS_PER_GENERATION) {
    return {
      kind: "ask",
      ask: `The ${lensLabel} reviewer stopped again after ${restartsUsed} restart${plural(restartsUsed, "", "s")}. Restart once more?`,
    };
  }
  return {
    kind: "restart",
    attempt: restartsUsed + 1,
    failureClass: classifyRestartFailure(reviewFailureSummary(input.error)),
  };
}

/**
 * Death was just proven, so a quarantined operation's uncertain outcome is now a known-safe
 * failure. Settling it keeps the relaunch's routing from pausing on the same uncertainty.
 */
export function withQuarantineSettled(entry: RuntimeTaskState): RuntimeTaskState {
  return entry.operation?.phase === "quarantined"
    ? { ...entry, operation: { ...entry.operation, phase: "failed" as const } }
    : entry;
}

export function withRestartRecorded(
  entry: RuntimeTaskState,
  restart: Readonly<{
    readonly attempt: number;
    readonly generation: number;
    readonly failureClass: RestartFailureClass;
    readonly at: IsoTimestamp;
  }>,
): RuntimeTaskState {
  return {
    ...entry,
    recovery: {
      ...recoveryCounters(entry),
      restarts: restart.attempt,
      restartGeneration: restart.generation,
      lastRestartFailureClass: restart.failureClass,
      lastRestartAt: restart.at,
    },
  };
}

export function withValidationRetryRecorded(
  entry: RuntimeTaskState,
  attempt: number,
): RuntimeTaskState {
  return { ...entry, recovery: { ...recoveryCounters(entry), validationRetries: attempt } };
}
