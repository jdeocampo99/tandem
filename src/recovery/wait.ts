import type { IsoTimestamp, TaskStage } from "../contracts.ts";
import type { RecoveryEvidence } from "./decision.ts";

/** A confirmed temporary availability block never holds work longer than five minutes. */
export const AVAILABILITY_WAIT_CEILING_MS = 5 * 60 * 1_000;

/** How a wait ended: it is still holding, it continued the decision rules, it asked, or it lapsed. */
export type AvailabilityWaitDisposition = "waiting" | "continued" | "asked" | "abandoned";

/**
 * One bounded wait, tied to the request and task that started it and to the incident that caused
 * it. It is durable so a restart reconstructs it rather than starting a second wait or a second
 * piece of work.
 */
export type RecoveryAvailabilityWait = Readonly<{
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly generation: number;
  readonly requestId?: string;
  readonly evidenceIdentity: string;
  readonly evidenceSummary: string;
  /** The coordinator session that armed this wait; another session inherits it as overdue. */
  readonly ownerSessionId: string;
  readonly startedAt: IsoTimestamp;
  readonly deadlineAt: IsoTimestamp;
  readonly knownAvailableAt?: IsoTimestamp;
  /** Set the one time this wait re-inspected durable state; a second wake asks instead. */
  readonly reinspectedAt?: IsoTimestamp;
  readonly disposition: AvailabilityWaitDisposition;
  readonly dispositionReason?: string;
}>;

/** What a wake should do now, decided from durable state and the injected current time alone. */
export type AvailabilityWaitDecision =
  | Readonly<{ readonly kind: "ask-now"; readonly reason: string }>
  | Readonly<{
      readonly kind: "start-wait";
      readonly deadlineAt: IsoTimestamp;
      readonly reason: string;
    }>
  | Readonly<{
      readonly kind: "hold-wait";
      readonly deadlineAt: IsoTimestamp;
      readonly reason: string;
    }>
  | Readonly<{ readonly kind: "reinspect-once"; readonly reason: string }>
  | Readonly<{ readonly kind: "settled"; readonly reason: string }>;

export type AvailabilityWaitInput = Readonly<{
  readonly now: IsoTimestamp;
  /** The session observing the wait; a wait armed elsewhere was reconstructed after a restart. */
  readonly observerSessionId: string;
  readonly evidence: RecoveryEvidence;
  /** The durable wait already recorded for this exact evidence identity, when one exists. */
  readonly existing?: RecoveryAvailabilityWait;
  readonly ceilingMs: number;
}>;

const TERMINAL_TASK_STAGES: readonly TaskStage[] = ["cancelled", "completed", "merged"];

/** Milliseconds since the epoch, or undefined when a recorded timestamp cannot be read. */
export function millisecondsAt(timestamp: IsoTimestamp | undefined): number | undefined {
  if (timestamp === undefined) return undefined;
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? undefined : value;
}

/** The earlier of the known availability time and the five-minute ceiling above the start. */
export function availabilityWaitDeadline(
  input: Readonly<{
    readonly startedAt: IsoTimestamp;
    readonly knownAvailableAt?: IsoTimestamp;
    readonly ceilingMs: number;
  }>,
): IsoTimestamp | undefined {
  const startedMs = millisecondsAt(input.startedAt);
  if (startedMs === undefined) return undefined;
  const ceilingAt = startedMs + input.ceilingMs;
  const knownMs = millisecondsAt(input.knownAvailableAt);
  return new Date(knownMs === undefined ? ceilingAt : Math.min(knownMs, ceilingAt)).toISOString();
}

/** Why an old timer may not resume this task, or undefined when the wait still describes it. */
export function supersededWaitReason(
  wait: RecoveryAvailabilityWait,
  task: Readonly<{ readonly stage: TaskStage; readonly generation: number }> | undefined,
): string | undefined {
  if (task === undefined) return "the task the wait was started for no longer exists";
  if (TERMINAL_TASK_STAGES.includes(task.stage)) return `the task is ${task.stage}`;
  if (task.generation !== wait.generation) {
    return `the task advanced to generation ${task.generation} after the wait was started at generation ${wait.generation}`;
  }
  return undefined;
}

/**
 * The bounded wait rules, applied literally: durable evidence of a delay beyond the ceiling asks
 * immediately, a new incident starts one wait, a repeated signal for the same unresolved incident
 * keeps the original deadline, the deadline buys exactly one re-inspection, and a wait that was
 * already overdue when another session reconstructed it asks instead of acting on a stale timer.
 */
export function decideAvailabilityWait(input: AvailabilityWaitInput): AvailabilityWaitDecision {
  const nowMs = millisecondsAt(input.now);
  if (nowMs === undefined) return { kind: "ask-now", reason: "the current time could not be read" };
  const existing = input.existing;
  if (existing === undefined) return firstWaitDecision(input, nowMs);
  if (existing.disposition !== "waiting") {
    return { kind: "settled", reason: `the wait already ${existing.disposition}` };
  }
  const deadlineMs = millisecondsAt(existing.deadlineAt);
  if (deadlineMs === undefined) {
    return { kind: "ask-now", reason: "the recorded wait deadline could not be read" };
  }
  if (nowMs < deadlineMs) {
    return {
      kind: "hold-wait",
      deadlineAt: existing.deadlineAt,
      reason: `a repeated signal for the same unresolved incident keeps the original deadline of ${existing.deadlineAt}`,
    };
  }
  if (existing.ownerSessionId !== input.observerSessionId) {
    return {
      kind: "ask-now",
      reason: `the wait was already overdue at ${existing.deadlineAt} when durable state was reconstructed`,
    };
  }
  if (existing.reinspectedAt !== undefined) {
    return {
      kind: "ask-now",
      reason: `the single re-inspection for this wait was already spent at ${existing.reinspectedAt}`,
    };
  }
  return {
    kind: "reinspect-once",
    reason: `the wait reached ${existing.deadlineAt}, the earlier of the known availability time and the five-minute ceiling`,
  };
}

function firstWaitDecision(input: AvailabilityWaitInput, nowMs: number): AvailabilityWaitDecision {
  const knownMs = millisecondsAt(input.evidence.knownAvailableAt);
  if (knownMs !== undefined && knownMs - nowMs > input.ceilingMs) {
    return {
      kind: "ask-now",
      reason: `durable evidence already shows availability only at ${String(input.evidence.knownAvailableAt)}, longer than the five-minute ceiling`,
    };
  }
  const deadlineAt = availabilityWaitDeadline({
    startedAt: input.now,
    ...(input.evidence.knownAvailableAt === undefined
      ? {}
      : { knownAvailableAt: input.evidence.knownAvailableAt }),
    ceilingMs: input.ceilingMs,
  });
  if (deadlineAt === undefined) {
    return { kind: "ask-now", reason: "the wait deadline could not be computed" };
  }
  return {
    kind: "start-wait",
    deadlineAt,
    reason: `waiting until ${deadlineAt} for ${input.evidence.summary}`,
  };
}
