import type {
  BlockCauseKind,
  FindingCatchStage,
  FindingCategory,
  FindingLedgerEntry,
  FindingSeverity,
  FindingStatus,
  IsoTimestamp,
  StoredReviewLens,
  TaskRecord,
  TaskStage,
} from "../contracts.ts";

/**
 * A task's timeline: one small append-only event per meaningful change, written in the same
 * database transaction as the change. Events hold references to the detail (transcript entries,
 * commits, report paths), never copies of it.
 */
export const TIMELINE_EVENT_TYPES = [
  "created",
  "stage-changed",
  "blocked",
  "unblocked",
  "restarted",
  "fix-round",
  "finding-raised",
  "finding-settled",
  "question-asked",
  "question-answered",
  "steered",
  "admission-waiting",
  "quick-approved",
  "quick-scope-extended",
] as const;

export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

/**
 * Why a queued task is not admitted yet. `worktree-disk-space`: the pool's free space is below the
 * minimum for a new worktree. `worktree-capacity-unknown`: free space could not be checked, or pool
 * maintenance failed. `routing-question`: a model routing question is waiting for an answer.
 */
export const ADMISSION_WAIT_REASONS = [
  "worktree-disk-space",
  "worktree-capacity-unknown",
  "routing-question",
] as const;

export type AdmissionWaitReason = (typeof ADMISSION_WAIT_REASONS)[number];

/** One entry in an OMP conversation file. */
export type TranscriptRef = Readonly<{
  readonly file: string;
  readonly entryId: string;
}>;

/** Where the detail behind an event lives. */
export type TimelineRefs = Readonly<{
  readonly transcript?: TranscriptRef;
  readonly commit?: string;
  readonly report?: string;
  readonly job?: string;
}>;

/** What a caller knows about a change that the task record alone does not say. */
export type TimelineNote = Readonly<{
  readonly cause?: string;
  readonly refs?: TimelineRefs;
  /** A queued task started waiting for admission for this reason (see `admissionWaitToRecord`). */
  readonly admissionWait?: AdmissionWaitReason;
}>;

type TimelineFacts =
  | Readonly<{ readonly type: "created"; readonly stage: TaskStage }>
  | Readonly<{ readonly type: "stage-changed"; readonly from: TaskStage; readonly to: TaskStage }>
  | Readonly<{
      readonly type: "blocked";
      readonly from: TaskStage;
      /** Absent when the site that blocked the task gave free text only. */
      readonly blockKind?: BlockCauseKind;
    }>
  | Readonly<{ readonly type: "unblocked"; readonly to: TaskStage }>
  | Readonly<{
      readonly type: "restarted";
      /** `worker` covers implementer, scout, and reviewer restarts, which share one budget. */
      readonly role: "worker" | "validation";
      readonly attempt: number;
    }>
  | Readonly<{
      readonly type: "fix-round";
      readonly round: number;
      readonly generation: number;
      readonly findingIds: readonly string[];
    }>
  | Readonly<{ readonly type: "finding-raised"; readonly finding: TimelineFinding }>
  | Readonly<{ readonly type: "finding-settled"; readonly findingId: string }>
  | Readonly<{ readonly type: "question-asked"; readonly questionId: string }>
  | Readonly<{
      readonly type: "question-answered";
      readonly questionId: string;
      /** Absent when the question was cleared without a stored answer message. */
      readonly messageId?: string;
    }>
  | Readonly<{ readonly type: "steered"; readonly messageId: string }>
  | Readonly<{ readonly type: "admission-waiting"; readonly reason: AdmissionWaitReason }>
  /** The user approved a quick task's typed text as its scope; `textDigest` names those bytes. */
  | Readonly<{ readonly type: "quick-approved"; readonly textDigest: string }>
  /** The user answered Proceed to the quick task's scope question. */
  | Readonly<{ readonly type: "quick-scope-extended"; readonly questionId: string }>;

/** A finding's identity and tags, without its description. */
export type TimelineFinding = Readonly<{
  readonly id: string;
  readonly lens: StoredReviewLens;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly category?: FindingCategory;
  readonly catchStage?: FindingCatchStage;
}>;

export type TimelineEvent = TimelineFacts &
  Readonly<{
    readonly taskId: string;
    readonly at: IsoTimestamp;
    readonly cause?: string;
    readonly refs?: TimelineRefs;
  }>;

/** An event as read back, numbered in the order it was written. */
export type StoredTimelineEvent = TimelineEvent & Readonly<{ readonly seq: number }>;

/** Longest cause kept on an event; a cause is a reason, not a copy of a report. */
export const MAX_TIMELINE_CAUSE_CHARS = 200;

/**
 * The events one task write amounts to, derived by comparing the record before and after it. Every
 * write goes through the task store, so deriving here records every change without each call site
 * remembering to. `note` adds what only the caller knows: why, and where the detail lives.
 */
export function timelineEventsForChange(
  before: TaskRecord | undefined,
  after: TaskRecord,
  note: TimelineNote = {},
): readonly TimelineEvent[] {
  const facts =
    before === undefined
      ? [{ fact: { type: "created", stage: after.stage } as const }, ...quickFacts(before, after)]
      : [
          ...stageFacts(before, after),
          ...fixRoundFacts(before, after),
          ...findingFacts(before.findingLedger ?? [], after.findingLedger ?? []),
          ...communicationFacts(before, after),
          ...admissionFacts(after, note.admissionWait),
          ...quickFacts(before, after),
        ];
  return facts.map(({ fact, cause }) => {
    const chosenCause = note.cause ?? cause;
    return {
      ...fact,
      taskId: after.id,
      at: after.updatedAt,
      ...(chosenCause === undefined ? {} : { cause: boundedCause(chosenCause) }),
      ...(note.refs === undefined ? {} : { refs: note.refs }),
    };
  });
}

type DerivedFact = Readonly<{ readonly fact: TimelineFacts; readonly cause?: string }>;

function stageFacts(before: TaskRecord, after: TaskRecord): readonly DerivedFact[] {
  if (before.stage === after.stage) return [];
  if (after.stage === "blocked") {
    return [
      {
        fact: {
          type: "blocked",
          from: before.stage,
          ...(after.blockCause === undefined ? {} : { blockKind: after.blockCause.kind }),
        },
        ...(after.blockReason === undefined ? {} : { cause: after.blockReason }),
      },
    ];
  }
  if (before.stage === "blocked") return [{ fact: { type: "unblocked", to: after.stage } }];
  return [{ fact: { type: "stage-changed", from: before.stage, to: after.stage } }];
}

function fixRoundFacts(before: TaskRecord, after: TaskRecord): readonly DerivedFact[] {
  if (after.reviewRound <= before.reviewRound) return [];
  return [
    {
      fact: {
        type: "fix-round",
        round: after.reviewRound,
        generation: after.generation,
        findingIds: after.iterationScope?.findingIds ?? [],
      },
    },
  ];
}

function findingFacts(
  before: readonly FindingLedgerEntry[],
  after: readonly FindingLedgerEntry[],
): readonly DerivedFact[] {
  const previous = new Map(before.map((entry) => [`${entry.lens}:${entry.id}`, entry]));
  const facts: DerivedFact[] = [];
  for (const entry of after) {
    const earlier = previous.get(`${entry.lens}:${entry.id}`);
    if (earlier?.status === entry.status) continue;
    facts.push(
      entry.status === "addressed"
        ? { fact: { type: "finding-settled", findingId: entry.id } }
        : { fact: { type: "finding-raised", finding: timelineFinding(entry) } },
    );
  }
  return facts;
}

function timelineFinding(entry: FindingLedgerEntry): TimelineFinding {
  return {
    id: entry.id,
    lens: entry.lens,
    severity: entry.severity,
    status: entry.status,
    ...(entry.category === undefined ? {} : { category: entry.category }),
    ...(entry.catchStage === undefined ? {} : { catchStage: entry.catchStage }),
  };
}

function communicationFacts(before: TaskRecord, after: TaskRecord): readonly DerivedFact[] {
  const known = new Set(before.communication?.messages.map((message) => message.id) ?? []);
  const added = (after.communication?.messages ?? []).filter((message) => !known.has(message.id));
  const facts: DerivedFact[] = [];
  const askedBefore = before.communication?.question;
  const askedAfter = after.communication?.question;
  if (askedBefore !== undefined && askedBefore.id !== askedAfter?.id) {
    const answer = added.find((message) => message.replyTo === askedBefore.id);
    facts.push({
      fact: {
        type: "question-answered",
        questionId: askedBefore.id,
        ...(answer === undefined ? {} : { messageId: answer.id }),
      },
    });
  }
  if (askedAfter !== undefined && askedAfter.id !== askedBefore?.id) {
    facts.push({ fact: { type: "question-asked", questionId: askedAfter.id } });
  }
  for (const message of added) {
    if (message.kind === "instruction") {
      facts.push({ fact: { type: "steered", messageId: message.id } });
    }
  }
  return facts;
}

/**
 * The admission wait to record, or undefined when there is none or it repeats the latest one
 * recorded. Only a queued task waits for admission; leaving `queued` is the admission itself.
 */
export function admissionWaitToRecord(
  stage: TaskStage,
  latest: AdmissionWaitReason | undefined,
  next: AdmissionWaitReason | undefined,
): AdmissionWaitReason | undefined {
  if (stage !== "queued" || next === undefined || next === latest) return undefined;
  return next;
}

function admissionFacts(
  after: TaskRecord,
  reason: AdmissionWaitReason | undefined,
): readonly DerivedFact[] {
  if (reason === undefined || after.stage !== "queued") return [];
  return [{ fact: { type: "admission-waiting", reason } }];
}

/** The user's quick-task approval when the task is created, and their Proceed when it is given. */
function quickFacts(before: TaskRecord | undefined, after: TaskRecord): readonly DerivedFact[] {
  const quick = after.quick;
  if (quick === undefined) return [];
  if (before?.quick === undefined)
    return [{ fact: { type: "quick-approved", textDigest: quick.textDigest } }];
  if (
    before.quick.scopeExtendedAt === undefined &&
    quick.scopeExtendedAt !== undefined &&
    quick.scopeQuestionId !== undefined
  )
    return [{ fact: { type: "quick-scope-extended", questionId: quick.scopeQuestionId } }];
  return [];
}

function boundedCause(cause: string): string {
  const line = cause.replace(/\s+/gu, " ").trim();
  return line.length <= MAX_TIMELINE_CAUSE_CHARS
    ? line
    : `${line.slice(0, MAX_TIMELINE_CAUSE_CHARS - 1).trimEnd()}…`;
}
