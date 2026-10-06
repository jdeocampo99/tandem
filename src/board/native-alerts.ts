import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { repositoryKey } from "../config/repositories.ts";
import type { TaskRecord } from "../contracts.ts";
import { ensurePrivateDirectoryTree } from "../coordinator/lock.ts";
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
const State = z.object({
  version: z.literal(1),
  cursors: z.record(z.number().int().nonnegative()),
  drafts: z.record(z.string()),
  rows: z.array(z.string()),
});
type AlertState = z.infer<typeof State>;
const titles = { "needs-you": "Tandem: Needs you", done: "Tandem: Done", stuck: "Tandem: Stuck" };

/** Serialized by the native publisher. Claim transitions before sending so unknown effects never retry. */
export class NativeAlerts {
  readonly #deps: NativeReadDependencies;
  constructor(deps: NativeReadDependencies) {
    this.#deps = deps;
  }
  async observe(snapshot: BoardSnapshot, project: string, sessionId: string): Promise<void> {
    const deps = this.#deps;
    const directory = join(deps.home, "native-alerts");
    const path = join(directory, `${repositoryKey(project)}.json`);
    let previous: AlertState | undefined;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
        throw new Error("Invalid native alert cursor file");
      previous = State.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const tasks = (
      await createTaskStore({
        directory: join(deps.home, "tasks"),
        clock: deps.clock,
        idFactory: defaultIdFactory(),
      }).list()
    ).filter((task) => task.repoPath === project);
    const next: AlertState = { version: 1, cursors: {}, drafts: { ...previous?.drafts }, rows: [] };
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
      if (row.repoPath !== project || row.taskId !== undefined || !notifiesUser(row)) continue;
      const signature = JSON.stringify([row.key, row.text]);
      next.rows.push(signature);
      if (previous && !previous.rows.includes(signature))
        alerts.push({ kind: "needs-you", body: row.name });
    }
    await ensurePrivateDirectoryTree(directory, "native alert cursor directory");
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    for (const alert of alerts) {
      try {
        await deps.terminal.notify({
          sessionId,
          cwd: project,
          title: titles[alert.kind],
          body: alert.body,
        });
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
