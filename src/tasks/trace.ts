import type { IsoTimestamp } from "../contracts.ts";
import {
  type AdditionalCharges,
  type RequestUsageReadout,
  usageCharges,
} from "../runtime/usage-receipt.ts";
import { isSafeTaskId } from "./lifecycle.ts";
import type { AdmissionWaitReason, StoredTimelineEvent, TimelineEvent } from "./timeline.ts";
import type { TimelineReadout } from "./timeline-store.ts";

/** The quality figures one task's timeline adds up to, computed when read. */
export type TaskRollup = Readonly<{
  readonly taskId: string;
  /** Whether the first review verdict passed; absent until a review has ruled. */
  readonly firstPassReview?: boolean;
  readonly fixRounds: number;
  readonly blockedMs: number;
  /** Absent when no usage was recorded for the task's own work. */
  readonly cost?: AdditionalCharges;
}>;

export type TaskTrace = TimelineReadout & Readonly<{ readonly rollup: TaskRollup }>;

/** A task trace excerpt; `omittedEvents` counts readable events excluded by either output bound. */
export type BoundedTaskTrace = TaskTrace & Readonly<{ readonly omittedEvents: number }>;

/** Maximum task ID length accepted by coordinator trace requests. */
export const MAX_TRACE_TASK_ID_CHARS = 256;

/** Only path-safe task identifiers within the trace output budget fit this boundary. */
export function isTraceTaskId(value: unknown): value is string {
  return isSafeTaskId(value) && value.length <= MAX_TRACE_TASK_ID_CHARS;
}

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

/**
 * What the task's own work cost, from the readout that holds it (its request's, or its own task
 * scope without one): other tasks' samples are left out. Undefined when nothing was recorded for
 * the task, so an unmeasured task never reads as free.
 */
export function taskCost(
  readout: RequestUsageReadout,
  taskId: string,
): AdditionalCharges | undefined {
  const own = readout.events.filter(
    (event) =>
      event.identity.taskId === taskId &&
      (event.kind === "work" || event.kind === "provider-sample"),
  );
  return own.length === 0 ? undefined : usageCharges(own);
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

/**
 * Keeps a contiguous newest suffix that fits in the structured result, without trimming timeline
 * data. The complete rollup always takes priority over event payloads.
 */
export function boundTaskTrace(
  trace: TaskTrace,
  limits: Readonly<{ readonly maxEvents: number; readonly maxSerializedChars: number }>,
): BoundedTaskTrace {
  if (
    !Number.isSafeInteger(limits.maxEvents) ||
    limits.maxEvents < 0 ||
    !Number.isSafeInteger(limits.maxSerializedChars) ||
    limits.maxSerializedChars < 1
  ) {
    throw new RangeError("Invalid task trace output limits");
  }
  const candidates = trace.events.slice(Math.max(0, trace.events.length - limits.maxEvents));
  const newestFirst: StoredTimelineEvent[] = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const event = candidates[index];
    if (event === undefined) break;
    const events = [...newestFirst, event].reverse();
    const candidate: BoundedTaskTrace = {
      ...trace,
      events,
      omittedEvents: trace.events.length - events.length,
    };
    const details = { action: "trace", value: candidate };
    if (serializedJsonLength(details, limits.maxSerializedChars) <= limits.maxSerializedChars) {
      newestFirst.push(event);
    } else {
      break;
    }
  }
  const events = newestFirst.reverse();
  const bounded: BoundedTaskTrace = {
    ...trace,
    events,
    omittedEvents: trace.events.length - events.length,
  };
  const details = { action: "trace", value: bounded };
  if (serializedJsonLength(details, limits.maxSerializedChars) > limits.maxSerializedChars) {
    throw new RangeError("Task trace rollup exceeds the structured output limit");
  }
  return bounded;
}

const MAX_TRACE_TEXT_TASK_ID_CHARS = 160;

export function renderBoundedTaskTrace(trace: BoundedTaskTrace, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new RangeError("Trace text limit must be a positive safe integer");
  }
  const { rollup } = trace;
  const cost = rollup.cost;
  const totalEvents = trace.events.length + trace.omittedEvents;
  const rollupLines = [
    `First review: ${firstReviewText(rollup.firstPassReview)}`,
    `Fix rounds: ${rollup.fixRounds}`,
    `Time blocked: ${durationText(rollup.blockedMs)} (${rollup.blockedMs} ms)`,
    `Cost: ${
      cost === undefined
        ? "not recorded"
        : `${dollars(cost.amountMicros)} (${cost.actualSamples} actual, ${cost.estimatedSamples} estimated, ${cost.unavailableSamples} unpriced)`
    }`,
  ];
  const eventCountLine = (shown: number): string =>
    `Events: ${totalEvents} readable; showing ${shown} newest; ${totalEvents - shown} omitted; ${trace.unreadableEvents} unreadable.`;
  let maxEventCountLineChars = 0;
  for (let shown = 0; shown <= trace.events.length; shown += 1) {
    maxEventCountLineChars = Math.max(maxEventCountLineChars, eventCountLine(shown).length);
  }
  const taskIdChars = Math.min(
    MAX_TRACE_TEXT_TASK_ID_CHARS,
    maxChars -
      "Task ".length -
      1 -
      rollupLines.join("\n").length -
      1 -
      maxEventCountLineChars,
  );
  if (taskIdChars < 0) {
    throw new RangeError("Task trace summary exceeds the readable output limit");
  }
  const taskId =
    rollup.taskId.length <= taskIdChars
      ? rollup.taskId
      : taskIdChars === 0
        ? ""
        : `${rollup.taskId.slice(0, taskIdChars - 1)}…`;
  const header = [`Task ${taskId}`, ...rollupLines];
  const render = (events: readonly string[]): string =>
    [...header, eventCountLine(events.length), ...events].join("\n");
  const newestFirst: string[] = [];
  for (let index = trace.events.length - 1; index >= 0; index -= 1) {
    const event = trace.events[index];
    if (event === undefined) break;
    const line = eventLine(event);
    const boundedLine = line.length <= 360 ? line : `${line.slice(0, 359)}…`;
    if (render([boundedLine, ...newestFirst].reverse()).length > maxChars) break;
    newestFirst.push(boundedLine);
  }
  return render(newestFirst.reverse());
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
  if (cost === undefined) return "not recorded";
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

function serializedJsonLength(value: unknown, maxChars: number): number {
  if (value === null) return 4;
  if (typeof value === "string") return serializedStringLength(value, maxChars);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") {
    return Math.min(JSON.stringify(value)?.length ?? 4, maxChars + 1);
  }
  if (Array.isArray(value)) {
    let length = 2;
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) length += 1;
      if (length > maxChars) return maxChars + 1;
      const entry = value[index];
      length +=
        entry === undefined || typeof entry === "function" || typeof entry === "symbol"
          ? 4
          : serializedJsonLength(entry, maxChars - length);
      if (length > maxChars) return maxChars + 1;
    }
    return length;
  }
  if (typeof value === "object") {
    let length = 2;
    let hasEntry = false;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
      if (hasEntry) length += 1;
      if (length > maxChars) return maxChars + 1;
      length += serializedStringLength(key, maxChars - length) + 1;
      if (length > maxChars) return maxChars + 1;
      length += serializedJsonLength(entry, maxChars - length);
      if (length > maxChars) return maxChars + 1;
      hasEntry = true;
    }
    return length;
  }
  return 0;
}

function serializedStringLength(value: string, maxChars: number): number {
  let length = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      length += 2;
    } else if (code <= 0x1f) {
      length += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 2;
        index += 1;
      } else {
        length += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      length += 6;
    } else {
      length += 1;
    }
    if (length > maxChars) return maxChars + 1;
  }
  return length;
}
