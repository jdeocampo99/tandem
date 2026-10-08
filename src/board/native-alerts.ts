import { join } from "node:path";
import type { TaskRecord } from "../contracts.ts";
import { type AlertObservation, deliverNewAlerts } from "../native/store.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import { defaultIdFactory } from "../runtime/persistence.ts";
import { QUICK_SCOPE_TITLE } from "../tasks/quick-scope.ts";
import { createTaskStore } from "../tasks/store.ts";
import type { StoredTimelineEvent } from "../tasks/timeline.ts";
import { readTimeline } from "../tasks/timeline-store.ts";
import type { NativeReadDependencies } from "./native-read.ts";
import type { BoardSnapshot } from "./snapshot.ts";
import { notifiesUser } from "./view.ts";

/** `title` replaces the kind's title for a question that names its own, like a quick task's. */
export type NativeAlert = { kind: "needs-you" | "done" | "stuck"; body: string; title?: string };
export function nativeTaskAlert(
  task: TaskRecord,
  event: StoredTimelineEvent,
): NativeAlert | undefined {
  const body = task.title ?? task.objective;
  // A quick task's scope question is a question, not a stuck task: it alerts once, as input needed.
  const scopeQuestion = task.communication?.question?.scope !== undefined;
  if (event.type === "blocked") return scopeQuestion ? undefined : { kind: "stuck", body };
  if (event.type === "question-asked" && scopeQuestion)
    return { kind: "needs-you", title: "Input needed", body: `${task.id} · ${QUICK_SCOPE_TITLE}` };
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
    const deps = this.#deps;
    await deliverNewAlerts(deps.home, project, () => this.#observation(snapshot, project), {
      send: (alert) =>
        deps.terminal.notify({
          sessionId,
          cwd: project,
          title: alert.title ?? titles[alert.kind],
          body: alert.body,
        }),
      failed: (alert, error) =>
        appendDiagnosticEvent(
          deps.home,
          {
            event: "native-alert-delivery-failed",
            details: {
              kind: alert.kind,
              errorClass: error instanceof Error ? error.name : typeof error,
            },
          },
          deps.clock,
        ),
    });
  }

  async #observation(
    snapshot: BoardSnapshot,
    project: string,
  ): Promise<AlertObservation<NativeAlert>> {
    const deps = this.#deps;
    const tasks = (
      await createTaskStore({
        directory: join(deps.home, "tasks"),
        clock: deps.clock,
        idFactory: defaultIdFactory(),
      }).list()
    ).filter((task) => task.repoPath === project);
    const observed: AlertObservation<NativeAlert>["tasks"][number][] = [];
    for (const task of tasks) {
      const timeline = await readTimeline(deps.home, task.id);
      if (timeline.unreadableEvents > 0)
        throw new Error("Native alerts cannot advance across unreadable task events");
      observed.push({
        taskId: task.id,
        events: timeline.events.map((event) => ({
          seq: event.seq,
          alert: nativeTaskAlert(task, event),
        })),
        ...(task.pullRequest?.state === "draft"
          ? {
              draft: {
                identity: `${task.pullRequest.repository}#${task.pullRequest.number}`,
                alert: { kind: "done" as const, body: task.title ?? task.objective },
              },
            }
          : {}),
      });
    }
    // Brief revisions and failing PR watch rows have board identities, rather than task events.
    const needsYou: AlertObservation<NativeAlert>["needsYou"][number][] = [];
    for (const row of snapshot.board.needsYou) {
      if (row.repoPath !== project || !notifiesUser(row)) continue;
      const alert: NativeAlert = { kind: "needs-you", body: row.name };
      // Routing timeline waits have no decision id. The board row is the authoritative
      // projection of that id, so claim it once here even when it also has task events.
      if (row.cause === "model-question")
        needsYou.push({ claim: "routing", identity: row.key, alert });
      else if (row.taskId === undefined || row.cause === "pull-request")
        needsYou.push({ claim: "row", identity: JSON.stringify([row.key, row.text]), alert });
    }
    return { tasks: observed, needsYou };
  }
}
