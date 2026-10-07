import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type NativeProjectSummary,
  type NativeViewsPublication,
  nativeBriefFile,
} from "../board/native-views.ts";
import { repositoryKey } from "../config/repositories.ts";
import { ensurePrivateDirectoryTree } from "../coordinator/lock.ts";
import { SETUP_MODES, type SetupView } from "../onboarding/setup-view.ts";
import type { BriefView } from "../requests/native-view.ts";
import type { QuickTaskView } from "../tasks/quick.ts";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";
import {
  QUICK_TASK_FILE,
  setupFile,
  VIEW_MODELS,
  ViewFile,
  type ViewFileKind,
} from "./contract.ts";

/*
 * `<home>/tern/<projectKey>/` holds everything Tandem keeps for one project's native views:
 * `views/` (the index and detail files the screens watch), `state.json` (alert cursors, the
 * visit record, what the last publication decided, the store's `epoch` and `seq`) and `open/`
 * (staged open tickets and receipts). One lock serializes `views/` and `state.json`.
 */

/**
 * The details a full publication keeps and prunes. Setup details and the quick task composer's
 * model are written on their own and never pruned.
 */
const DETAIL_FILE = /^(task-|brief-|pr-)[^/\\\0]+\.json$/u;
const SETUP_FILE = new RegExp(`^setup-(${SETUP_MODES.join("|")})\\.json$`, "u");
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function storeRoot(home: string): string {
  return join(home, "tern");
}

/** Keyed by the original repository identity, never a basename or a Tern title. */
export function projectStoreDirectory(home: string, project: string): string {
  return join(storeRoot(home), repositoryKey(project));
}

export function viewIndexPath(home: string, project: string): string {
  return join(projectStoreDirectory(home, project), "views", "index.json");
}

/** Detail references are filenames within this project's views, never paths into another project. */
export function viewDetailPath(home: string, project: string, file: string): string {
  if (!DETAIL_FILE.test(file) && !SETUP_FILE.test(file) && file !== QUICK_TASK_FILE)
    throw new TypeError("Native detail must be a task, brief, PR, setup or quick task filename");
  return join(projectStoreDirectory(home, project), "views", file);
}

export function openDirectory(home: string, project: string): string {
  return join(projectStoreDirectory(home, project), "open");
}

/** Every project's `open/` directory that exists. */
export async function openDirectories(home: string): Promise<string[]> {
  const projects = await entries(storeRoot(home));
  const found: string[] = [];
  for (const entry of projects.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(storeRoot(home), entry.name, "open");
    if ((await lstat(directory).catch(() => undefined))?.isDirectory()) found.push(directory);
  }
  return found;
}

const Count = z.number().int().nonnegative().safe();

export const AlertCursors = z
  .object({
    cursors: z.record(Count),
    drafts: z.record(z.string()),
    rows: z.array(z.string()),
    routing: z.array(z.string()),
    delivered: Count,
    read: Count,
  })
  .strict()
  .refine((alerts) => alerts.read <= alerts.delivered, {
    message: "Invalid native alert read cursor",
  });
export type AlertCursors = z.infer<typeof AlertCursors>;

export const Visit = z
  .object({
    lastOpenedAt: z.string().datetime(),
    lastVisibleAt: z.string().datetime().optional(),
    previousSignature: z.string().min(1).optional(),
    dismissedSignature: z.string().optional(),
  })
  .strict();
export type Visit = z.infer<typeof Visit>;

const Summary = z
  .object({
    repoPath: z.string().min(1),
    name: z.string(),
    writtenAt: z.string().datetime(),
    running: Count,
    needsYou: Count,
    ready: Count,
    done: Count,
    sessionId: z.string().optional(),
  })
  .strict();

/**
 * What the last full publication showed, kept so clicks decide from the store's own record
 * rather than by parsing the files written for Luau.
 */
const Published = z
  .object({
    summary: Summary,
    changeSignature: z.string().min(1),
    projects: z.array(
      z
        .object({
          repoPath: z.string(),
          current: z.boolean(),
          offline: z.boolean(),
          sessionId: z.string().optional(),
        })
        .strict(),
    ),
    boardLinks: z.record(z.string().url()),
    merged: z.array(z.string().url()),
    tasks: z.array(z.string()),
    pullRequests: z.array(
      z
        .object({
          repo: z.string(),
          number: z.number().int().positive(),
          taskId: z.string().optional(),
        })
        .strict(),
    ),
    needsYou: z.array(
      z.object({ key: z.string(), cause: z.string(), taskId: z.string().optional() }).strict(),
    ),
  })
  .strict();
export type Published = z.infer<typeof Published>;

const ProjectState = z
  .object({
    v: z.literal(1),
    project: z.string().min(1),
    epoch: z.string().min(1),
    seq: Count,
    alerts: AlertCursors.optional(),
    visit: Visit.optional(),
    published: Published.optional(),
  })
  .strict();
export type ProjectState = z.infer<typeof ProjectState>;

/** `published` is a cache the next publication rebuilds, so an older shape must not wedge it. */
const StoredProjectState = ProjectState.extend({ published: z.unknown().optional() });

async function readBounded(path: string, what: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES)
      throw new Error(`${what} must be a bounded regular file`);
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** The project's state as last committed, or undefined before anything was stored. */
export async function readProjectState(
  home: string,
  project: string,
): Promise<ProjectState | undefined> {
  const text = await readBounded(
    join(projectStoreDirectory(home, project), "state.json"),
    "Native project state",
  );
  if (text === undefined) return undefined;
  const { published, ...stored } = StoredProjectState.parse(JSON.parse(text));
  const cached = Published.safeParse(published);
  const state: ProjectState = cached.success ? { ...stored, published: cached.data } : stored;
  if (state.project !== project) throw new Error("Native project state belongs to another project");
  return state;
}

export type LockedStore = Readonly<{
  /** The committed state; a store without one starts a new epoch. */
  read(): Promise<ProjectState>;
  write(state: ProjectState): Promise<void>;
}>;

/** One writer per project across coordinator ticks and CLI processes. */
export async function withProjectLock<T>(
  home: string,
  project: string,
  body: (store: LockedStore) => Promise<T>,
): Promise<T> {
  const directory = projectStoreDirectory(home, project);
  await ensurePrivateDirectoryTree(directory, "native project store");
  const release = await acquireDarwinFileLock(join(directory, "state.lock"), 60_000, 20);
  try {
    return await body({
      read: async () =>
        (await readProjectState(home, project)) ?? {
          v: 1,
          project,
          epoch: randomUUID(),
          seq: 0,
        },
      write: async (state) =>
        writeAtomic(
          join(directory, "state.json"),
          `${JSON.stringify(ProjectState.parse(state))}\n`,
        ),
    });
  } finally {
    await release();
  }
}

type ViewWrite = Readonly<{ path: string; kind: ViewFileKind; model: unknown }>;

/**
 * Builds from fresh state only after taking the project lock and holds it through every write,
 * so an older tick finishes before a newer build reads. Only files whose model changed are
 * rewritten; each takes the next `seq`, details before the index. The sequence numbers are
 * committed to `state.json` before any file carries them, so a crash only skips numbers.
 */
export async function publishViews<
  Publication extends
    | NativeViewsPublication
    | Readonly<{ brief: BriefView }>
    | Readonly<{ setup: SetupView }>
    | Readonly<{ quickTask: QuickTaskView }>,
>(home: string, project: string, build: () => Promise<Publication>): Promise<Publication> {
  return withProjectLock(home, project, async (store) => {
    const publication = await build();
    const full = "bundle" in publication ? (publication as NativeViewsPublication) : undefined;
    const writes: ViewWrite[] = [];
    let retained: ReadonlySet<string> | undefined;
    if (full === undefined && "quickTask" in publication) {
      writes.push({
        path: viewDetailPath(home, project, QUICK_TASK_FILE),
        kind: "quick-task",
        model: (publication as Readonly<{ quickTask: QuickTaskView }>).quickTask,
      });
    } else if (full === undefined && "setup" in publication) {
      const setup = (publication as Readonly<{ setup: SetupView }>).setup;
      writes.push({
        path: viewDetailPath(home, project, setupFile(setup.mode)),
        kind: "setup",
        model: setup,
      });
    } else if (full === undefined) {
      const brief = (publication as Readonly<{ brief: BriefView }>).brief;
      writes.push({
        path: viewDetailPath(home, project, nativeBriefFile(brief.requestId)),
        kind: "brief",
        model: brief,
      });
    } else {
      const { bundle, details } = full;
      if (bundle.project !== project)
        throw new TypeError("A coordinator cannot publish another project's views");
      retained = new Set([
        ...details.map((detail) => detail.file),
        ...Object.values(bundle.tasks).map((task) => task.detailFile),
        ...Object.values(bundle.briefs).map((brief) => brief.detailFile),
        ...Object.values(bundle.pullRequests).map((pr) => pr.detailFile),
        ...(full.retainedDetailFiles ?? []),
      ]);
      for (const file of retained) viewDetailPath(home, project, file);
      for (const detail of details) {
        if (detail.view.project !== project)
          throw new TypeError("A coordinator cannot publish another project's detail");
        writes.push({
          path: viewDetailPath(home, project, detail.file),
          kind: detail.view.kind,
          model: detail.view.data,
        });
      }
      writes.push({ path: viewIndexPath(home, project), kind: "index", model: bundle });
    }
    for (const write of writes) {
      const checked = VIEW_MODELS[write.kind].safeParse(write.model);
      if (!checked.success)
        throw new TypeError(
          `Native ${write.kind} model is invalid: ${checked.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        );
    }
    const state = await store.read();
    const changed: (ViewWrite & { json: string })[] = [];
    for (const write of writes) {
      const json = canonicalJson(write.model);
      if ((await publishedModel(write.path, write.kind, state.epoch)) !== json)
        changed.push({ ...write, json });
    }
    await store.write({
      ...state,
      seq: state.seq + changed.length,
      ...(full === undefined ? {} : { published: published(full) }),
    });
    const views = join(projectStoreDirectory(home, project), "views");
    await ensurePrivateDirectoryTree(views, "native views directory");
    for (const [index, write] of changed.entries())
      await writeAtomic(
        write.path,
        `{"v":1,"kind":${JSON.stringify(write.kind)},"epoch":${JSON.stringify(state.epoch)},"seq":${state.seq + index + 1},"model":${write.json}}\n`,
      );
    if (retained !== undefined)
      for (const entry of await entries(views))
        if (entry.isFile() && DETAIL_FILE.test(entry.name) && !retained.has(entry.name))
          await rm(join(views, entry.name), { force: true });
    return publication;
  });
}

function published(publication: NativeViewsPublication): Published {
  const { bundle } = publication;
  return {
    summary: bundle.summary,
    changeSignature: bundle.changeSignature,
    projects: bundle.projects.map((row) => ({
      repoPath: row.repoPath,
      current: row.current,
      offline: row.offline,
      ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    })),
    boardLinks: Object.fromEntries(
      bundle.board.lanes.flatMap((lane) =>
        lane.cards.flatMap((card) =>
          card.pullRequest === undefined ? [] : [[card.key, card.pullRequest.url] as const],
        ),
      ),
    ),
    merged: bundle.catchup.merged.map((pr) => pr.url),
    tasks: Object.keys(bundle.tasks),
    pullRequests: Object.values(bundle.pullRequests).map((pr) => ({
      repo: pr.header.repo,
      number: pr.header.number,
      ...(pr.header.taskId === undefined ? {} : { taskId: pr.header.taskId }),
    })),
    needsYou: bundle.catchup.needsYou.map((row) => ({
      key: row.key,
      cause: row.cause,
      ...(row.taskId === undefined ? {} : { taskId: row.taskId }),
    })),
  };
}

/** The canonical model JSON of a file this epoch wrote, or undefined when it must be rewritten. */
async function publishedModel(
  path: string,
  kind: ViewFileKind,
  epoch: string,
): Promise<string | undefined> {
  try {
    const text = await readBounded(path, "Native view file");
    if (text === undefined) return undefined;
    const file = ViewFile.parse(JSON.parse(text));
    return file.kind === kind && file.epoch === epoch ? canonicalJson(file.model) : undefined;
  } catch {
    return undefined;
  }
}

/** Other projects' summaries, from what each one's coordinator last published. */
export async function readProjectSummaries(
  home: string,
  project: string,
): Promise<Readonly<{ summaries: readonly NativeProjectSummary[]; warnings: readonly string[] }>> {
  const summaries: NativeProjectSummary[] = [];
  const warnings: string[] = [];
  for (const entry of (await entries(storeRoot(home))).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!/^[a-f0-9]{24}$/u.test(entry.name) || entry.name === repositoryKey(project)) continue;
    try {
      if (!entry.isDirectory()) throw new TypeError("Native project store must be a directory");
      const text = await readBounded(
        join(storeRoot(home), entry.name, "state.json"),
        "Native project state",
      );
      if (text === undefined) continue;
      const state = ProjectState.parse(JSON.parse(text));
      if (state.published === undefined) continue;
      const { sessionId, ...summary } = state.published.summary;
      if (state.project !== summary.repoPath || entry.name !== repositoryKey(state.project))
        throw new TypeError("Native project summary identity mismatch");
      summaries.push({ ...summary, ...(sessionId === undefined ? {} : { sessionId }) });
    } catch {
      warnings.push(`Native project summary unavailable: ${entry.name}`);
    }
  }
  return { summaries, warnings };
}

/** Canonical JSON keeps identical models stable across object construction order and restarts. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("Native view models must contain plain JSON values");
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Native view models must contain finite JSON values");
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function entries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
