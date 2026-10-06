import { join } from "node:path";
import type { TaskRecord } from "../contracts.ts";
import {
  type AlertCursors,
  type LockedStore,
  readProjectState,
  withProjectLock,
} from "../native/store.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import { defaultIdFactory } from "../runtime/persistence.ts";
import { createTaskStore } from "../tasks/store.ts";
import type { StoredTimelineEvent } from "../tasks/timeline.ts";
import { readTimeline } from "../tasks/timeline-store.ts";
import type { NativeReadDependencies } from "./native-read.ts";
import type { BoardSnapshot } from "./snapshot.ts";
import { notifiesUser } from "./view.ts";

export type NativeAlert = { kind: "needs-you" | "done" | "stuck"; body: string };
export function nativeTaskAlert(
  task: TaskRecord,
  event: StoredTimelineEvent,
): NativeAlert | undefined {
  const body = task.title ?? task.objective;
  if (event.type === "blocked") return { kind: "stuck", body };
  if (
    event.type === "question-asked" ||
    (event.type === "stage-changed" && event.to === "awaiting-approval")
  )
    return { kind: "needs-you", body };
  return undefined;
}
const titles = { "needs-you": "Tandem: Needs you", done: "Tandem: Done", stuck: "Tandem: Stuck" };

/** Serialized by the native publisher. Claim transitions before sending so unknown effects never retry. */
export class NativeAlerts {
  readonly #deps: NativeReadDependencies;
  constructor(deps: NativeReadDependencies) {
    this.#deps = deps;
  }
  async observe(snapshot: BoardSnapshot, project: string, sessionId: string): Promise<void> {
    await withProjectLock(this.#deps.home, project, (store) =>
      this.#observe(snapshot, project, sessionId, store),
    );
  }
  async #observe(
    snapshot: BoardSnapshot,
    project: string,
    sessionId: string,
    store: LockedStore,
  ): Promise<void> {
    const deps = this.#deps;
    const state = await store.read();
    const previous = state.alerts;
    const tasks = (
      await createTaskStore({
        directory: join(deps.home, "tasks"),
        clock: deps.clock,
        idFactory: defaultIdFactory(),
      }).list()
    ).filter((task) => task.repoPath === project);
    const next: AlertCursors = {
      cursors: {},
      drafts: { ...previous?.drafts },
      rows: [],
      routing: [...(previous?.routing ?? [])],
      delivered: previous?.delivered ?? 0,
      read: previous?.read ?? 0,
    };
    const alerts: NativeAlert[] = [];
    for (const task of tasks) {
      const timeline = await readTimeline(deps.home, task.id);
      if (timeline.unreadableEvents > 0)
        throw new Error("Native alerts cannot advance across unreadable task events");
      next.cursors[task.id] = Math.max(0, ...timeline.events.map((event) => event.seq));
      if (previous) {
        for (const event of timeline.events) {
          if (event.seq > (previous.cursors[task.id] ?? 0)) {
            const alert = nativeTaskAlert(task, event);
            if (alert) alerts.push(alert);
          }
        }
      }
      if (task.pullRequest?.state === "draft") {
        const identity = `${task.pullRequest.repository}#${task.pullRequest.number}`;
        next.drafts[task.id] = identity;
        if (previous && previous.drafts[task.id] !== identity)
          alerts.push({ kind: "done", body: task.title ?? task.objective });
      }
    }
    // Brief revisions and failing PR watch rows have board identities, rather than task events.
    for (const row of snapshot.board.needsYou) {
      if (row.repoPath !== project || !notifiesUser(row)) continue;
      // Routing timeline waits have no decision id. The board row is the authoritative
      // projection of that id, so claim it once here even when it also has task events.
      if (row.cause === "model-question") {
        if (!next.routing.includes(row.key)) {
          next.routing.push(row.key);
          if (previous) alerts.push({ kind: "needs-you", body: row.name });
        }
        continue;
      }
      if (row.taskId !== undefined && row.cause !== "pull-request") continue;
      const signature = JSON.stringify([row.key, row.text]);
      next.rows.push(signature);
      if (previous && !previous.rows.includes(signature))
        alerts.push({ kind: "needs-you", body: row.name });
    }
    await store.write({ ...state, alerts: next });
    for (const alert of alerts) {
      try {
        await deps.terminal.notify({
          sessionId,
          cwd: project,
          title: titles[alert.kind],
          body: alert.body,
        });
        next.delivered++;
        await store.write({ ...state, alerts: next });
      } catch (error) {
        await appendDiagnosticEvent(
          deps.home,
          {
            event: "native-alert-delivery-failed",
            details: {
              kind: alert.kind,
              errorClass: error instanceof Error ? error.name : typeof error,
            },
          },
          deps.clock,
        );
      }
    }
  }
}

/** User-visible deliveries only. Coordinator notification acknowledgement never changes this cursor. */
export async function nativeAlertCounts(home: string, project: string) {
  const alerts = (await readProjectState(home, project))?.alerts;
  const delivered = alerts?.delivered ?? 0;
  return { delivered, unread: delivered - (alerts?.read ?? 0) };
}

/** Read exactly the deliveries captured before navigation, preserving alerts arriving meanwhile. */
export async function markNativeAlertsRead(
  home: string,
  project: string,
  through: number,
): Promise<void> {
  if (!Number.isSafeInteger(through) || through < 0) throw new Error("Invalid alert read cursor");
  await withProjectLock(home, project, async (store) => {
    const state = await store.read();
    const alerts = state.alerts;
    if (alerts !== undefined && through > alerts.read)
      await store.write({
        ...state,
        alerts: { ...alerts, read: Math.min(through, alerts.delivered) },
      });
  });
}
