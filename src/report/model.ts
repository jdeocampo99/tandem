import type { IsoTimestamp, TaskKind, TaskStage } from "../contracts.ts";
import type { RequestWorkKind, RequestWorkStatus } from "../runtime/usage.ts";

/**
 * The view model `tandem report` renders: where each task's time went, built from timeline and
 * usage records alone. Offsets are milliseconds from the task's creation so the page needs no
 * clock. Cost is integer USD micro-dollars; an absent cost means no priced usage was recorded,
 * never zero.
 */
export const REPORT_VIEW_SCHEMA_VERSION = 1;

/** Work stages first, then the three kinds of waiting, in the order the page draws them. */
export const REPORT_LANES = [
  "research",
  "implement",
  "validate",
  "review",
  "queued",
  "waiting-on-you",
  "stuck",
] as const;

export type ReportLane = (typeof REPORT_LANES)[number];

/** Agents working, waiting on the user, or held up by Tandem (queued or stuck). */
export type ReportBucket = "working" | "waiting-on-you" | "held-up";

/** One stretch the task spent in a single stage. */
export type ReportSegment = Readonly<{
  readonly lane: ReportLane;
  readonly stage: TaskStage;
  readonly startMs: number;
  readonly endMs: number;
}>;

export type ReportLaneTotal = Readonly<{
  readonly lane: ReportLane;
  readonly durationMs: number;
  /** Absent for lanes no priced agent work ran in. */
  readonly costMicros?: number;
}>;

/** One settled unit of agent work, from a usage `work` event. */
export type ReportAgentRun = Readonly<{
  readonly workKind: RequestWorkKind;
  readonly role?: string;
  readonly model?: string;
  readonly generation?: number;
  readonly attempt?: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly status: RequestWorkStatus;
  /** Absent when the run's charge was unavailable, such as a model-free validation run. */
  readonly costMicros?: number;
}>;

type ReportChokeKind = "stuck" | "waiting-on-you" | "queued" | "review-loop";

/** The one stretch that cost the task the most time, named by a fixed rule. */
export type ReportChoke = Readonly<{
  readonly kind: ReportChokeKind;
  readonly startMs: number;
  readonly endMs: number;
  /** Short line under the task title, e.g. "Stuck 1h 37m in validation". */
  readonly headline: string;
  /** One plain sentence shown when the task is open; absent when the records say nothing more. */
  readonly explanation?: string;
}>;

/** `pr-open` is a task at ready: its draft pull request is open and waiting on a person. */
export type ReportTaskStatus = "merged" | "completed" | "cancelled" | "pr-open" | "in-progress";

export type ReportTask = Readonly<{
  readonly id: string;
  /** The objective's first line, bounded. */
  readonly title: string;
  readonly kind: TaskKind;
  readonly stage: TaskStage;
  readonly status: ReportTaskStatus;
  readonly createdAt: IsoTimestamp;
  /** Creation until the task first reached ready, completed, merged, or cancelled; or until now. */
  readonly wallMs: number;
  readonly buckets: Readonly<Record<ReportBucket, number>>;
  readonly segments: readonly ReportSegment[];
  /** Only lanes the task spent time in, in REPORT_LANES order. */
  readonly lanes: readonly ReportLaneTotal[];
  readonly runs: readonly ReportAgentRun[];
  /** Absent when the task belongs to no request, so no usage was recorded for it. */
  readonly costMicros?: number;
  /** Usage samples no price covered; their cost is unknown, not zero. */
  readonly unpricedSamples: number;
  readonly choke?: ReportChoke;
  /** Time waiting on the user or held up, plus a review loop's span; the list sorts by it. */
  readonly lostMs: number;
}>;

export type ReportView = Readonly<{
  readonly schemaVersion: typeof REPORT_VIEW_SCHEMA_VERSION;
  readonly generatedAt: IsoTimestamp;
  /** Inclusive lower bound on task creation; absent means every task in scope. */
  readonly since?: IsoTimestamp;
  /** What the report covers, e.g. the repository name. */
  readonly scopeLabel: string;
  /** Sorted by `lostMs`, largest first. */
  readonly tasks: readonly ReportTask[];
  /** Timeline rows that could not be decoded, across all tasks. */
  readonly unreadableEvents: number;
}>;
