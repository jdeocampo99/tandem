import type { IsoTimestamp } from "../contracts.ts";
import {
  type AdditionalCharges,
  buildRequestUsageReceipt,
  type RequestUsageReadout,
} from "../runtime/usage-receipt.ts";
import type { AdmissionWaitReason, StoredTimelineEvent, TimelineEvent } from "./timeline.ts";
import type { TimelineReadout } from "./timeline-store.ts";

/** The quality figures one task's timeline adds up to, computed when read. */
export type TaskRollup = Readonly<{
  readonly taskId: string;
  /** Whether the first review verdict passed; absent until a review has ruled. */
  readonly firstPassReview?: boolean;
  readonly fixRounds: number;
  readonly blockedMs: number;
  /** Absent when the task belongs to no request, so no usage was recorded for it. */
  readonly cost?: AdditionalCharges;
}>;

export type TaskTrace = TimelineReadout & Readonly<{ readonly rollup: TaskRollup }>;

/** The same figures across many tasks. */
export type TraceSummary = Readonly<{
  readonly tasks: number;
  readonly reviewedTasks: number;
  readonly firstPassReviews: number;
  readonly fixRounds: number;
  readonly blockedMs: number;
  readonly costMicros: number;
  /** Usage samples no price covered; their cost is unknown, not zero. */
  readonly unpricedSamples: number;
  readonly rollups: readonly TaskRollup[];
}>;

export function taskRollup(
  taskId: string,
  events: readonly TimelineEvent[],
  now: IsoTimestamp,
  cost: AdditionalCharges | undefined,
): TaskRollup {
  const verdict = firstReviewVerdict(events);
  return {
    taskId,
    ...(verdict === undefined ? {} : { firstPassReview: verdict }),
    fixRounds: events.filter((event) => event.type === "fix-round").length,
    blockedMs: blockedMillis(events, now),
    ...(cost === undefined ? {} : { cost }),
  };
}

/** What the task's own work cost, from its request's ledger: other tasks' samples are left out. */
export function taskCost(
  readout: RequestUsageReadout,
  requestId: string,
  taskId: string,
): AdditionalCharges {
  const own = readout.events.filter((event) => event.identity.taskId === taskId);
  return buildRequestUsageReceipt(requestId, { events: own, malformedEvents: 0 }).charges;
}

export function summarizeRollups(rollups: readonly TaskRollup[]): TraceSummary {
  const reviewed = rollups.filter((rollup) => rollup.firstPassReview !== undefined);
  return {
    tasks: rollups.length,
    reviewedTasks: reviewed.length,
    firstPassReviews: reviewed.filter((rollup) => rollup.firstPassReview === true).length,
    fixRounds: sum(rollups.map((rollup) => rollup.fixRounds)),
    blockedMs: sum(rollups.map((rollup) => rollup.blockedMs)),
    costMicros: sum(rollups.map((rollup) => rollup.cost?.amountMicros ?? 0)),
    unpricedSamples: sum(rollups.map((rollup) => rollup.cost?.unavailableSamples ?? 0)),
    rollups,
  };
}

export function renderTaskTrace(trace: TaskTrace): string {
  const lines = [
    `Task ${trace.rollup.taskId}`,
    "",
    ...(trace.events.length === 0 ? ["No events recorded."] : trace.events.map(eventLine)),
    ...(trace.unreadableEvents === 0
      ? []
      : [`${trace.unreadableEvents} events could not be read.`]),
    "",
    `First review: ${firstReviewText(trace.rollup.firstPassReview)}`,
    `Fix rounds: ${trace.rollup.fixRounds}`,
    `Time blocked: ${durationText(trace.rollup.blockedMs)}`,
    `Cost: ${costText(trace.rollup.cost)}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderTraceSummary(summary: TraceSummary): string {
  const rate =
    summary.reviewedTasks === 0
      ? "no reviews yet"
      : `${Math.round((summary.firstPassReviews / summary.reviewedTasks) * 100)}% (${summary.firstPassReviews} of ${summary.reviewedTasks})`;
  const perTask = summary.tasks === 0 ? 0 : summary.fixRounds / summary.tasks;
  const lines = [
    `Tasks: ${summary.tasks}`,
    `First-pass review rate: ${rate}`,
    `Fix rounds per task: ${perTask.toFixed(1)} (${summary.fixRounds} total)`,
    `Time blocked: ${durationText(summary.blockedMs)}`,
    `Cost: ${dollars(summary.costMicros)}${summary.tasks === 0 ? "" : ` (${dollars(Math.round(summary.costMicros / summary.tasks))} per task)`}${summary.unpricedSamples === 0 ? "" : `, ${summary.unpricedSamples} samples unpriced`}`,
    "",
    "One task's timeline: tandem trace TASK_ID",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The first time review ruled: leaving `reviewing` for `awaiting-fixes` failed it, and leaving for
 * `ready` or `completed` passed it. Any other exit, such as a pause, is not a verdict.
 */
function firstReviewVerdict(events: readonly TimelineEvent[]): boolean | undefined {
  for (const event of events) {
    if (event.type !== "stage-changed" || event.from !== "reviewing") continue;
    if (event.to === "awaiting-fixes") return false;
    if (event.to === "ready" || event.to === "completed") return true;
  }
  return undefined;
}

/** A block still open at `now` counts up to `now`. */
function blockedMillis(events: readonly TimelineEvent[], now: IsoTimestamp): number {
  let total = 0;
  let blockedAt: number | undefined;
  for (const event of events) {
    if (event.type === "blocked" && blockedAt === undefined) blockedAt = Date.parse(event.at);
    if (event.type === "unblocked" && blockedAt !== undefined) {
      total += Math.max(0, Date.parse(event.at) - blockedAt);
      blockedAt = undefined;
    }
  }
  return blockedAt === undefined ? total : total + Math.max(0, Date.parse(now) - blockedAt);
}

function eventLine(event: StoredTimelineEvent): string {
  const refs = event.refs;
  const references = [
    refs?.commit === undefined ? undefined : `commit ${refs.commit.slice(0, 12)}`,
    refs?.report === undefined ? undefined : `report ${refs.report}`,
    refs?.transcript === undefined
      ? undefined
      : `transcript ${refs.transcript.file}#${refs.transcript.entryId}`,
  ].filter((entry): entry is string => entry !== undefined);
  return [
    `${event.at}  ${eventText(event)}`,
    ...(event.cause === undefined ? [] : [`    ${event.cause}`]),
    ...references.map((reference) => `    ${reference}`),
  ].join("\n");
}

function eventText(event: TimelineEvent): string {
  switch (event.type) {
    case "created":
      return `created at ${event.stage}`;
    case "stage-changed":
      return `${event.from} -> ${event.to}`;
    case "blocked":
      return `blocked from ${event.from}${event.blockKind === undefined ? "" : ` (${event.blockKind})`}`;
    case "unblocked":
      return `unblocked -> ${event.to}`;
    case "restarted":
      return `${event.role} restarted (attempt ${event.attempt})`;
    case "fix-round":
      return `fix round ${event.round}${event.findingIds.length === 0 ? "" : ` for ${event.findingIds.join(", ")}`}`;
    case "finding-raised": {
      const { finding } = event;
      const tags = [
        finding.category,
        finding.catchStage && `should have been caught in ${finding.catchStage}`,
      ]
        .filter((tag) => tag !== undefined)
        .join(", ");
      return `finding ${finding.id} ${finding.status} (${finding.severity}${tags.length === 0 ? "" : `, ${tags}`})`;
    }
    case "finding-settled":
      return `finding ${event.findingId} addressed`;
    case "question-asked":
      return `asked question ${event.questionId}`;
    case "question-answered":
      return `question ${event.questionId} answered`;
    case "steered":
      return `steered (message ${event.messageId})`;
    case "admission-waiting":
      return `waiting for admission (${ADMISSION_WAIT_WORDS[event.reason]})`;
  }
}

const ADMISSION_WAIT_WORDS: Readonly<Record<AdmissionWaitReason, string>> = {
  "worktree-disk-space": "worktree disk space",
  "worktree-capacity-unknown": "worktree capacity unknown",
  "routing-question": "routing question",
};

function firstReviewText(verdict: boolean | undefined): string {
  if (verdict === undefined) return "not reviewed yet";
  return verdict ? "passed" : "needed fixes";
}

function costText(cost: AdditionalCharges | undefined): string {
  if (cost === undefined) return "not recorded (no request)";
  return `${dollars(cost.amountMicros)}${cost.unavailableSamples === 0 ? "" : `, ${cost.unavailableSamples} samples unpriced`}`;
}

export function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function durationText(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
