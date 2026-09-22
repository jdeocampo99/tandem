/**
 * Reviewing-stage eligibility for central recovery: which reviewer/verifier failure, if any, is a
 * proven-unowned (quarantined) death central recovery's stop/save/re-enter should pick up, as
 * opposed to a genuine content failure (a completed run that reported its own failure, a stale
 * instruction, or a malformed result) that must keep blocking untouched.
 *
 * `advanceReview` (src/workers/workflow.ts) and `CentralRecoveryWorkflow.recoverStuckReviewer`
 * (src/recovery/central.ts) both read this same scoping so a lens a newer job already completed is
 * never mistaken for still being dead, and a genuine content failure is never silently relaunched.
 */
import type { TaskRecord } from "../contracts.ts";
import type { DurableJob, RuntimeTaskState } from "../runtime/schema.ts";

/** The most recent job per review lens for this generation; worker jobs for this exact review only. */
function latestReviewJobsByLens(
  runtime: RuntimeTaskState,
  generation: number,
): ReadonlyMap<string, DurableJob> {
  const byLens = new Map<string, DurableJob>();
  for (const job of runtime.jobs) {
    if (job.kind !== "worker") continue;
    if (job.role !== "reviewer" && job.role !== "verifier") continue;
    if (job.generation !== generation) continue;
    if (job.reviewLens === undefined) continue;
    byLens.set(job.reviewLens, job);
  }
  return byLens;
}

/**
 * The one reviewer/verifier lens, if any, whose most recent job for this generation failed and has
 * not since been recorded as reviewed at the exact reviewed HEAD. A lens a newer job already
 * completed is never returned, even when an older job for that same lens once failed.
 */
export function unresolvedReviewFailure(
  task: TaskRecord,
  runtime: RuntimeTaskState,
): DurableJob | undefined {
  for (const job of latestReviewJobsByLens(runtime, task.generation).values()) {
    if (job.phase !== "failed") continue;
    const recorded = task.reviews.some(
      (review) =>
        review.lens === job.reviewLens &&
        review.head === task.reviewHead &&
        review.generation === task.generation,
    );
    if (!recorded) return job;
  }
  return undefined;
}

/**
 * The exact reason prefixes `failJob`'s quarantine=true call sites write in workflow.ts
 * (`reconcileJob`/`reconcileMissingEndpoint`): an unowned/dead worker proven only by its pane or
 * result disappearing, never a completed run that reported its own failure, a stale canonical
 * instruction, or a malformed result. Keep these in sync with those literal reason strings.
 */
export const QUARANTINED_JOB_REASON_PREFIXES = [
  "worker job has no durable endpoint identity",
  "worker stopped without a durable result",
  "owned endpoint disappeared",
] as const;

/**
 * True only for the durable-quarantine shape central recovery may relaunch automatically. Read from
 * the dead job's own recorded reason rather than the runtime's live `operation.phase`: central
 * recovery settles that phase to `"failed"` as part of re-entry (so the replacement attempt's own
 * routing decision reads a known-safe prior outcome, not a still-quarantined one), and this check
 * must keep agreeing with itself across that exact settling.
 */
export function isQuarantinedReviewFailure(job: DurableJob): boolean {
  const reason = job.error;
  return (
    reason !== undefined &&
    QUARANTINED_JOB_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix))
  );
}
