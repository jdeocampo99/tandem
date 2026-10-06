import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { repositoryKey } from "../config/repositories.ts";
import type { TaskRecord } from "../contracts.ts";
import { ensurePrivateDirectoryTree } from "../coordinator/lock.ts";
import { appendDiagnosticEvent } from "../runtime/diagnostics.ts";
import { defaultIdFactory } from "../runtime/persistence.ts";
import { createTaskStore } from "../tasks/store.ts";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";
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
  routing: z.array(z.string()).default([]),
  delivered: z.number().int().nonnegative().safe().default(0),
  read: z.number().int().nonnegative().safe().default(0),
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
    const directory = join(this.#deps.home, "native-alerts");
    await ensurePrivateDirectoryTree(directory, "native alert cursor directory");
    const release = await acquireDarwinFileLock(
      join(directory, `${repositoryKey(project)}.lock`),
      5000,
      20,
    );
    try {
      await this.#observe(snapshot, project, sessionId, directory);
    } finally {
      await release();
    }
  }
  async #observe(
    snapshot: BoardSnapshot,
    project: string,
    sessionId: string,
    directory: string,
  ): Promise<void> {
    const deps = this.#deps;
    const path = join(directory, `${repositoryKey(project)}.json`);
    const previous = await readAlertState(path);
    const tasks = (
      await createTaskStore({
        directory: join(deps.home, "tasks"),
        clock: deps.clock,
        idFactory: defaultIdFactory(),
      }).list()
    ).filter((task) => task.repoPath === project);
    const next: AlertState = {
      version: 1,
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
    await writeAlertState(path, next);
    for (const alert of alerts) {
      try {
        await deps.terminal.notify({
          sessionId,
          cwd: project,
          title: titles[alert.kind],
          body: alert.body,
        });
        next.delivered++;
        await writeAlertState(path, next);
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

async function readAlertState(path: string): Promise<AlertState | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
      throw new Error("Invalid native alert cursor file");
    const saved = State.parse(JSON.parse(await readFile(path, "utf8")));
    if (saved.read > saved.delivered) throw new Error("Invalid native alert read cursor");
    return saved;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return undefined;
  }
}
async function writeAlertState(path: string, state: AlertState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** User-visible deliveries only. Coordinator notification acknowledgement never changes this cursor. */
export async function nativeAlertCounts(home: string, project: string) {
  const saved = await readAlertState(join(home, "native-alerts", `${repositoryKey(project)}.json`));
  const delivered = saved?.delivered ?? 0;
  return { delivered, unread: delivered - (saved?.read ?? 0) };
}

/** Read exactly the deliveries captured before navigation, preserving alerts arriving meanwhile. */
export async function markNativeAlertsRead(
  home: string,
  project: string,
  through: number,
): Promise<void> {
  if (!Number.isSafeInteger(through) || through < 0) throw new Error("Invalid alert read cursor");
  const directory = join(home, "native-alerts");
  await ensurePrivateDirectoryTree(directory, "native alert cursor directory");
  const release = await acquireDarwinFileLock(
    join(directory, `${repositoryKey(project)}.lock`),
    5000,
    20,
  );
  try {
    const path = join(directory, `${repositoryKey(project)}.json`);
    const saved = await readAlertState(path);
    if (saved !== undefined && through > saved.read)
      await writeAlertState(path, { ...saved, read: Math.min(through, saved.delivered) });
  } finally {
    await release();
  }
}
