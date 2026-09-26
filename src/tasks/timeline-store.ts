import {
  insertTaskEventPayload,
  readTaskEventPayloads,
  type StateDatabase,
  withStateTransaction,
} from "../runtime/database.ts";
import {
  ADMISSION_WAIT_REASONS,
  type AdmissionWaitReason,
  type StoredTimelineEvent,
  TIMELINE_EVENT_TYPES,
  type TimelineEvent,
  type TimelineEventType,
} from "./timeline.ts";

/** A task's recorded events, plus how many stored rows could not be read. */
export type TimelineReadout = Readonly<{
  readonly events: readonly StoredTimelineEvent[];
  readonly unreadableEvents: number;
}>;

/** Appends inside the caller's transaction, so the events commit or roll back with the change. */
export function appendTimelineEvents(db: StateDatabase, events: readonly TimelineEvent[]): void {
  for (const event of events) {
    insertTaskEventPayload(db, {
      taskId: event.taskId,
      at: event.at,
      type: event.type,
      payload: event,
    });
  }
}

/** Appends in its own transaction, or joins the one already open for `home`. */
export async function recordTimelineEvents(
  home: string,
  events: readonly TimelineEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await withStateTransaction(home, (db) => appendTimelineEvents(db, events));
}

export async function readTimeline(home: string, taskId: string): Promise<TimelineReadout> {
  const rows = await withStateTransaction(home, (db) => readTaskEventPayloads(db, taskId));
  const events: StoredTimelineEvent[] = [];
  for (const row of rows) {
    const event = storedEvent(row.seq, row.payload, taskId);
    if (event !== undefined) events.push(event);
  }
  return { events, unreadableEvents: rows.length - events.length };
}

/** Checks only what a reader relies on; the rest of the shape was fixed by the writer's types. */
function storedEvent(
  seq: number,
  payload: unknown,
  taskId: string,
): StoredTimelineEvent | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Readonly<Record<string, unknown>>;
  if (record.taskId !== taskId || typeof record.at !== "string") return undefined;
  if (!TIMELINE_EVENT_TYPES.includes(record.type as TimelineEventType)) return undefined;
  if (
    record.type === "admission-waiting" &&
    !ADMISSION_WAIT_REASONS.includes(record.reason as AdmissionWaitReason)
  ) {
    return undefined;
  }
  return { ...(record as TimelineEvent), seq };
}
