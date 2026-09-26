import { basename } from "node:path";
import type { FindingCategory, IsoTimestamp, TaskRecord, TaskStage } from "../contracts.ts";
import type { RequestUsageEvent, RequestWorkKind } from "../runtime/usage.ts";
import type { RequestUsageReadout } from "../runtime/usage-receipt.ts";
import type { StoredTimelineEvent, TimelineFinding } from "../tasks/timeline.ts";
import type { TimelineReadout } from "../tasks/timeline-store.ts";
import { taskCost } from "../tasks/trace.ts";
import {
  REPORT_LANES,
  REPORT_VIEW_SCHEMA_VERSION,
  type ReportAgentRun,
  type ReportBucket,
  type ReportChoke,
  type ReportLane,
  type ReportLaneTotal,
  type ReportSegment,
  type ReportTask,
  type ReportTaskStatus,
  type ReportView,
} from "./model.ts";

/**
 * Builds the `tandem report` view model from a task's record, timeline, and the usage events that
 * hold its own work. Pure: the caller supplies `now` and every record.
 */
export type TaskReportInput = Readonly<{
  task: TaskRecord;
  timeline: TimelineReadout;
  /**
   * The readout holding the task's work: its request's, or its own task scope when no request
   * governs it. Undefined when none was read.
   */
  usage: RequestUsageReadout | undefined;
  now: IsoTimestamp;
}>;

export type ReportViewInput = Readonly<{
  tasks: readonly ReportTask[];
  generatedAt: IsoTimestamp;
  since?: IsoTimestamp;
  scopeLabel: string;
  unreadableEvents: number;
}>;

/**
 * A stuck, waiting, or queued stretch shorter than this is ordinary friction, not a choke. A review
 * loop qualifies by its round count instead.
 */
export const CHOKE_THRESHOLD_MS = 5 * 60_000;

/** A review loop is named once review has sent the task back for fixes this many times. */
export const REVIEW_LOOP_MIN_ROUNDS = 2;

export const MAX_TITLE_CHARS = 80;

/** Reaching any of these ends the task's wall window: later time is a human merging, not Tandem. */
const WINDOW_END_STAGES: ReadonlySet<TaskStage> = new Set([
  "ready",
  "completed",
  "merged",
  "cancelled",
]);

const STAGE_LANES: Readonly<Partial<Record<TaskStage, ReportLane>>> = {
  scouting: "research",
  implementing: "implement",
  "awaiting-fixes": "implement",
  validating: "validate",
  reviewing: "review",
  queued: "queued",
  "awaiting-approval": "waiting-on-you",
  paused: "waiting-on-you",
  blocked: "stuck",
};

const LANE_BUCKETS: Readonly<Record<ReportLane, ReportBucket>> = {
  research: "working",
  implement: "working",
  validate: "working",
  review: "working",
  queued: "held-up",
  "waiting-on-you": "waiting-on-you",
  stuck: "held-up",
};

/** Coordinator and legacy verification work belongs to no lane. */
const WORK_KIND_LANES: Readonly<Partial<Record<RequestWorkKind, ReportLane>>> = {
  research: "research",
  presentation: "research",
  implementation: "implement",
  validation: "validate",
  review: "review",
};

/** How a working lane reads in a sentence. */
const LANE_WORDS: Readonly<Partial<Record<ReportLane, string>>> = {
  research: "research",
  implement: "implementation",
  validate: "validation",
  review: "review",
};

const STAGE_WORDS: Readonly<Partial<Record<TaskStage, string>>> = {
  scouting: "research",
  implementing: "implementation",
  validating: "validation",
  reviewing: "review",
};

export function buildTaskReport(input: TaskReportInput): ReportTask {
  const { task } = input;
  const origin = Date.parse(task.createdAt);
  const offset = (at: IsoTimestamp): number => {
    const elapsed = Date.parse(at) - origin;
    return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  };
  const events = [...input.timeline.events].sort((left, right) => left.seq - right.seq);
  const walk = walkStages(events, offset, offset(input.now), task);
  const segments = walk.stretches.map((stretch) => stretch.segment);
  const runs = agentRuns(input.usage, task.id, offset);
  const buckets = bucketTotals(segments);
  const choke = chooseChoke(walk);
  const cost = input.usage === undefined ? undefined : taskCost(input.usage, task.id);
  return {
    id: task.id,
    title: reportTitle(task.objective, task.id),
    kind: task.kind,
    stage: task.stage,
    status: reportStatus(task.stage),
    createdAt: task.createdAt,
    wallMs: walk.endMs,
    buckets,
    segments,
    lanes: laneTotals(segments, runs),
    runs,
    ...(cost === undefined ? {} : { costMicros: cost.amountMicros }),
    unpricedSamples: cost?.unavailableSamples ?? 0,
    ...(choke === undefined ? {} : { choke: choke.choke }),
    lostMs:
      buckets["waiting-on-you"] +
      buckets["held-up"] +
      (choke?.choke.kind === "review-loop" ? choke.spanMs : 0),
  };
}

/** Largest `lostMs` first; ties keep the newest task first. Filtering is the caller's. */
export function buildReportView(input: ReportViewInput): ReportView {
  const tasks = [...input.tasks].sort(
    (left, right) => right.lostMs - left.lostMs || right.createdAt.localeCompare(left.createdAt),
  );
  return {
    schemaVersion: REPORT_VIEW_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    ...(input.since === undefined ? {} : { since: input.since }),
    scopeLabel: input.scopeLabel,
    tasks,
    unreadableEvents: input.unreadableEvents,
  };
}

/** `{m}m` under an hour, else `{h}h {mm}m`, rounded to whole minutes. */
export function formatDuration(milliseconds: number): string {
  const minutes = Math.round(Math.max(0, milliseconds) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The objective's first non-empty line, whitespace-collapsed and bounded; the id when empty. */
export function reportTitle(objective: string, fallback: string): string {
  const line =
    objective
      .split(/\r?\n/u)
      .map((candidate) => candidate.replace(/\s+/gu, " ").trim())
      .find((candidate) => candidate.length > 0) ?? fallback;
  return line.length <= MAX_TITLE_CHARS ? line : `${line.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

function reportStatus(stage: TaskStage): ReportTaskStatus {
  if (stage === "merged" || stage === "completed" || stage === "cancelled") return stage;
  return "in-progress";
}

/** A drawn segment plus the event that opened it, which says why the task entered the stage. */
type Stretch = Readonly<{ segment: ReportSegment; opener: StoredTimelineEvent | undefined }>;

type StageWalk = Readonly<{
  stretches: readonly Stretch[];
  /** Events up to and including the one that ended the window. */
  events: readonly StoredTimelineEvent[];
  endMs: number;
  offset: (at: IsoTimestamp) => number;
}>;

/**
 * Splits the task's window into one stretch per stage. With no recorded events the task has no
 * segments, and its window ends at `updatedAt` when its current stage ends the window (the last
 * write is the best record of when it got there), else at `now`.
 */
function walkStages(
  events: readonly StoredTimelineEvent[],
  offset: (at: IsoTimestamp) => number,
  nowMs: number,
  task: TaskRecord,
): StageWalk {
  if (events.length === 0) {
    const endMs = WINDOW_END_STAGES.has(task.stage) ? offset(task.updatedAt) : nowMs;
    return { stretches: [], events, endMs, offset };
  }
  const stretches: Stretch[] = [];
  const windowEvents: StoredTimelineEvent[] = [];
  let open: { stage: TaskStage; startMs: number; opener: StoredTimelineEvent } | undefined;
  let windowEndMs: number | undefined;
  const close = (endMs: number): void => {
    if (open === undefined) return;
    const lane = STAGE_LANES[open.stage];
    const startMs = Math.min(open.startMs, endMs);
    if (lane !== undefined && endMs > startMs) {
      stretches.push({
        segment: { lane, stage: open.stage, startMs, endMs },
        opener: open.opener,
      });
    }
    open = undefined;
  };
  for (const event of events) {
    windowEvents.push(event);
    const next = enteredStage(event);
    if (next === undefined) continue;
    const at = Math.max(offset(event.at), open?.startMs ?? 0);
    close(at);
    if (WINDOW_END_STAGES.has(next)) {
      windowEndMs = at;
      break;
    }
    open = { stage: next, startMs: at, opener: event };
  }
  const endMs = Math.max(windowEndMs ?? nowMs, open?.startMs ?? 0);
  close(endMs);
  return { stretches, events: windowEvents, endMs, offset };
}

function enteredStage(event: StoredTimelineEvent): TaskStage | undefined {
  switch (event.type) {
    case "created":
      return event.stage;
    case "stage-changed":
      return event.to;
    case "blocked":
      return "blocked";
    case "unblocked":
      return event.to;
    default:
      return undefined;
  }
}

function bucketTotals(segments: readonly ReportSegment[]): Readonly<Record<ReportBucket, number>> {
  const totals: Record<ReportBucket, number> = { working: 0, "waiting-on-you": 0, "held-up": 0 };
  for (const segment of segments) {
    totals[LANE_BUCKETS[segment.lane]] += segment.endMs - segment.startMs;
  }
  return totals;
}

/** Lanes the task spent time in; a lane's cost sums its priced runs, absent when none were. */
function laneTotals(
  segments: readonly ReportSegment[],
  runs: readonly ReportAgentRun[],
): readonly ReportLaneTotal[] {
  const totals: ReportLaneTotal[] = [];
  for (const lane of REPORT_LANES) {
    const durationMs = segments
      .filter((segment) => segment.lane === lane)
      .reduce((total, segment) => total + segment.endMs - segment.startMs, 0);
    if (durationMs === 0) continue;
    const priced = runs.filter(
      (run) => WORK_KIND_LANES[run.workKind] === lane && run.costMicros !== undefined,
    );
    totals.push({
      lane,
      durationMs,
      ...(priced.length === 0
        ? {}
        : { costMicros: priced.reduce((total, run) => total + (run.costMicros ?? 0), 0) }),
    });
  }
  return totals;
}

function agentRuns(
  usage: RequestUsageReadout | undefined,
  taskId: string,
  offset: (at: IsoTimestamp) => number,
): readonly ReportAgentRun[] {
  if (usage === undefined) return [];
  return usage.events
    .filter((event) => event.kind === "work" && event.identity.taskId === taskId)
    .map((event) => agentRun(event, offset))
    .sort((left, right) => left.startMs - right.startMs);
}

function agentRun(event: RequestUsageEvent, offset: (at: IsoTimestamp) => number): ReportAgentRun {
  const { identity, charge } = event;
  const startMs = offset(event.startedAt);
  return {
    workKind: event.workKind,
    ...(identity.role === undefined ? {} : { role: identity.role }),
    ...(identity.model === undefined ? {} : { model: identity.model }),
    ...(identity.generation === undefined ? {} : { generation: identity.generation }),
    ...(identity.attempt === undefined ? {} : { attempt: identity.attempt }),
    startMs,
    endMs: Math.max(startMs, offset(event.endedAt)),
    status: event.status,
    ...(charge.provenance === "unavailable" ? {} : { costMicros: charge.amountMicros }),
  };
}

/** A choke candidate and the duration it is compared by. */
type ChokeCandidate = Readonly<{ choke: ReportChoke; spanMs: number }>;

/**
 * The fixed choke rules: the longest stuck, waiting, or queued stretch of at least
 * CHOKE_THRESHOLD_MS, or a review loop of REVIEW_LOOP_MIN_ROUNDS or more fix rounds compared by its
 * span. Ties go to the earlier rule in that order, then the earlier stretch.
 */
function chooseChoke(walk: StageWalk): ChokeCandidate | undefined {
  const candidates = [
    ...stuckCandidates(walk),
    ...waitingCandidates(walk),
    ...queuedCandidates(walk),
  ].filter((candidate) => candidate.spanMs >= CHOKE_THRESHOLD_MS);
  const loop = reviewLoopCandidate(walk);
  if (loop !== undefined) candidates.push(loop);
  let chosen: ChokeCandidate | undefined;
  for (const candidate of candidates) {
    if (chosen === undefined || candidate.spanMs > chosen.spanMs) chosen = candidate;
  }
  return chosen;
}

function stuckCandidates(walk: StageWalk): readonly ChokeCandidate[] {
  return walk.stretches
    .filter((stretch) => stretch.segment.lane === "stuck")
    .map(({ segment, opener }) => {
      const spanMs = segment.endMs - segment.startMs;
      const from = opener?.type === "blocked" ? opener.from : undefined;
      const restarted = walk.events.some((event) => {
        if (event.type !== "restarted") return false;
        const at = walk.offset(event.at);
        return at >= segment.startMs && at <= segment.endMs;
      });
      const explanation = [
        opener?.cause === undefined ? undefined : sentence(opener.cause),
        restarted ? "Resumed after a restart." : undefined,
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" ");
      return {
        spanMs,
        choke: {
          kind: "stuck",
          startMs: segment.startMs,
          endMs: segment.endMs,
          headline: `Stuck ${formatDuration(spanMs)} in ${from === undefined ? "a block" : (STAGE_WORDS[from] ?? from)}`,
          ...(explanation.length === 0 ? {} : { explanation }),
        },
      };
    });
}

type WaitSource = "question" | "approval";
type WaitInterval = { startMs: number; endMs: number; bySource: Record<WaitSource, number> };

/** Unanswered questions and approval or pause stretches, merged where they overlap. */
function waitingCandidates(walk: StageWalk): readonly ChokeCandidate[] {
  const raw: { startMs: number; endMs: number; source: WaitSource }[] = [];
  const asked = new Map<string, number>();
  for (const event of walk.events) {
    if (event.type === "question-asked" && !asked.has(event.questionId)) {
      asked.set(event.questionId, walk.offset(event.at));
    }
    if (event.type === "question-answered") {
      const startMs = asked.get(event.questionId);
      if (startMs === undefined) continue;
      asked.delete(event.questionId);
      raw.push({ startMs, endMs: Math.min(walk.offset(event.at), walk.endMs), source: "question" });
    }
  }
  for (const startMs of asked.values())
    raw.push({ startMs, endMs: walk.endMs, source: "question" });
  for (const { segment } of walk.stretches) {
    if (segment.lane === "waiting-on-you") {
      raw.push({ startMs: segment.startMs, endMs: segment.endMs, source: "approval" });
    }
  }
  raw.sort((left, right) => left.startMs - right.startMs);
  const merged: WaitInterval[] = [];
  for (const interval of raw) {
    if (interval.endMs <= interval.startMs) continue;
    const last = merged.at(-1);
    if (last !== undefined && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
      last.bySource[interval.source] += interval.endMs - interval.startMs;
      continue;
    }
    const bySource: Record<WaitSource, number> = { question: 0, approval: 0 };
    bySource[interval.source] = interval.endMs - interval.startMs;
    merged.push({ startMs: interval.startMs, endMs: interval.endMs, bySource });
  }
  return merged.map((interval) => {
    const spanMs = interval.endMs - interval.startMs;
    const waited =
      interval.bySource.question >= interval.bySource.approval
        ? `waited ${formatDuration(spanMs)} for your answer`
        : `waited ${formatDuration(spanMs)} for your approval`;
    const headline =
      interval.bySource.question >= interval.bySource.approval
        ? `Waited ${formatDuration(spanMs)} on your answer`
        : `Waited ${formatDuration(spanMs)} for your approval`;
    const before = workBefore(walk, interval.startMs);
    return {
      spanMs,
      choke: {
        kind: "waiting-on-you",
        startMs: interval.startMs,
        endMs: interval.endMs,
        headline,
        ...(before === undefined
          ? {}
          : {
              explanation: `${capitalize(before.words)} took ${formatDuration(before.durationMs)}, then ${waited}.`,
            }),
      },
    };
  });
}

/** The working stretch the task was in, or had just left, when a wait began. */
function workBefore(
  walk: StageWalk,
  startMs: number,
): { words: string; durationMs: number } | undefined {
  const previous = walk.stretches.filter((stretch) => stretch.segment.startMs < startMs).at(-1);
  if (previous === undefined) return undefined;
  const words = LANE_WORDS[previous.segment.lane];
  if (words === undefined) return undefined;
  const durationMs = Math.min(previous.segment.endMs, startMs) - previous.segment.startMs;
  return durationMs > 0 ? { words, durationMs } : undefined;
}

function queuedCandidates(walk: StageWalk): readonly ChokeCandidate[] {
  return walk.stretches.flatMap(({ segment }, index) => {
    if (segment.lane !== "queued") return [];
    const spanMs = segment.endMs - segment.startMs;
    const next = walk.stretches
      .slice(index + 1)
      .find((stretch) => LANE_WORDS[stretch.segment.lane] !== undefined);
    const nextWords = next === undefined ? undefined : LANE_WORDS[next.segment.lane];
    return [
      {
        spanMs,
        choke: {
          kind: "queued",
          startMs: segment.startMs,
          endMs: segment.endMs,
          headline: `Queued ${formatDuration(spanMs)}`,
          ...(next === undefined || nextWords === undefined
            ? {}
            : {
                explanation: `Queued ${formatDuration(spanMs)}. The ${nextWords} then took ${formatDuration(next.segment.endMs - next.segment.startMs)}.`,
              }),
        },
      },
    ];
  });
}

/**
 * Review sent the task back at least REVIEW_LOOP_MIN_ROUNDS times. The loop spans from the review
 * exit that led to the first fix round (or that fix round itself) to the window's end; `n` is the
 * number of fix rounds, matching `tandem trace`.
 */
function reviewLoopCandidate(walk: StageWalk): ChokeCandidate | undefined {
  const rounds = walk.events.filter((event) => event.type === "fix-round");
  const first = rounds[0];
  if (first === undefined || rounds.length < REVIEW_LOOP_MIN_ROUNDS) return undefined;
  const reviewExit = walk.events
    .filter(
      (event) =>
        event.type === "stage-changed" && event.from === "reviewing" && event.seq <= first.seq,
    )
    .at(-1);
  const startMs = Math.min(walk.offset((reviewExit ?? first).at), walk.endMs);
  const spanMs = walk.endMs - startMs;
  const findings = raisedFindings(walk.events);
  const categories = [
    ...new Set(
      findings
        .map((finding) => finding.category)
        .filter((category): category is FindingCategory => category !== undefined),
    ),
  ];
  const shared =
    categories.length === 1 && findings.every((finding) => finding.category !== undefined);
  const planning = findings.filter((finding) => finding.catchStage === "planning").length;
  const raised =
    categories.length === 0 ? "findings" : `${listWords(categories.map(categoryWords))} findings`;
  return {
    spanMs,
    choke: {
      kind: "review-loop",
      startMs,
      endMs: walk.endMs,
      headline: `Review loop: ${rounds.length} fix rounds${shared ? " on one finding category" : ""}`,
      explanation: `Review raised ${raised} across ${rounds.length} fix rounds.${planning === 0 ? "" : ` ${planning} traced back to the brief.`}`,
    },
  };
}

/** Each raised finding once, with the tags it was last raised with. */
function raisedFindings(events: readonly StoredTimelineEvent[]): readonly TimelineFinding[] {
  const findings = new Map<string, TimelineFinding>();
  for (const event of events) {
    if (event.type !== "finding-raised") continue;
    findings.set(`${event.finding.lens}:${event.finding.id}`, event.finding);
  }
  return [...findings.values()];
}

function categoryWords(category: FindingCategory): string {
  return category.replace(/-/gu, " ");
}

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  const capitalized = capitalize(trimmed);
  return /[.!?…]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

/**
 * What the report covers: the scoped repository's folder name, the one project every task
 * belongs to, or "All projects" when tasks span several or there are none.
 */
export function reportScopeLabel(
  scopePath: string | undefined,
  taskRepoPaths: readonly string[],
): string {
  if (scopePath !== undefined) return basename(scopePath);
  const names = new Set(taskRepoPaths.map((path) => basename(path)));
  const [only] = names;
  return names.size === 1 && only !== undefined ? only : "All projects";
}
