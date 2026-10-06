import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { repositoryKey } from "../config/repositories.ts";
import type { IsoTimestamp, TerminalName } from "../contracts.ts";
import {
  type NativeProjectSummary,
  type NativeViewsPublication,
  nativeViewText,
} from "./native-views.ts";
import { type BoardView, isBoardView } from "./view.ts";

/** A project's open coordinator chat, so the panel can focus it. */
export type PanelCoordinator = Readonly<{
  readonly terminal?: TerminalName;
  readonly repoPath: string;
  readonly project: string;
  readonly workspaceId: string;
  readonly paneId: string;
}>;

/**
 * The board as a coordinator last read it, for panels to draw without taking the state lock. Each
 * coordinator rewrites the whole file on every reconcile.
 */
export type BoardSnapshot = Readonly<{
  readonly version: 1;
  readonly writtenAt: IsoTimestamp;
  readonly board: BoardView;
  readonly coordinators: readonly PanelCoordinator[];
}>;

export function boardSnapshotPath(home: string): string {
  return join(home, "board-snapshot.json");
}

/** The snapshot in `text`, or undefined when it is not one this version of Tandem reads. */
export function parseBoardSnapshot(text: string): BoardSnapshot | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const snapshot = value as Record<string, unknown>;
  const valid =
    snapshot.version === 1 &&
    typeof snapshot.writtenAt === "string" &&
    isBoardView(snapshot.board) &&
    Array.isArray(snapshot.coordinators) &&
    snapshot.coordinators.every(isPanelCoordinator);
  return valid ? (snapshot as BoardSnapshot) : undefined;
}

/** Replaces the snapshot atomically, so a panel never reads half a file. */
export async function writeBoardSnapshot(home: string, snapshot: BoardSnapshot): Promise<void> {
  const path = boardSnapshotPath(home);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The last snapshot written, or undefined when none has been; throws when it cannot be read. */
export async function readBoardSnapshot(home: string): Promise<BoardSnapshot | undefined> {
  const path = boardSnapshotPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
  const snapshot = parseBoardSnapshot(text);
  if (snapshot === undefined) throw new Error(`${path} is not a board snapshot Tandem can read`);
  return snapshot;
}

function isPanelCoordinator(value: unknown): value is PanelCoordinator {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.terminal === undefined || entry.terminal === "herdr" || entry.terminal === "tern") &&
    typeof entry.repoPath === "string" &&
    typeof entry.project === "string" &&
    typeof entry.workspaceId === "string" &&
    typeof entry.paneId === "string"
  );
}

/** Full path is keyed by the original repository identity, never a basename or a Tern title. */
export function nativeViewsPath(home: string, repoPath: string): string {
  return join(home, "native-views", `${repositoryKey(repoPath)}.json`);
}

/** Detail references are filenames within this project's directory, never paths into another project. */
export function nativeDetailPath(home: string, repoPath: string, file: string): string {
  if (!/^(task-|brief-|pr-)[^/\\\0]+\.json$/.test(file))
    throw new TypeError("Native detail must be a task, brief or PR filename");
  return join(home, "native-views", repositoryKey(repoPath), file);
}

/** The coordinator writes its own details first, then its small pollable index. Other files are read-only. */
export async function writeNativeViews(
  home: string,
  publication: NativeViewsPublication,
): Promise<void> {
  const { bundle, details } = publication;
  const retained = new Set([
    ...details.map((detail) => detail.file),
    ...Object.values(bundle.tasks).map((task) => task.detailFile),
    ...Object.values(bundle.briefs).map((brief) => brief.detailFile),
    ...Object.values(bundle.pullRequests).map((pr) => pr.detailFile),
    ...(publication.retainedDetailFiles ?? []),
  ]);
  for (const file of retained) nativeDetailPath(home, bundle.project, file);
  for (const detail of details) {
    if (detail.view.project !== bundle.project)
      throw new TypeError("A coordinator cannot publish another project's detail");
    nativeDetailPath(home, bundle.project, detail.file);
  }
  await mkdir(join(home, "native-views"), { recursive: true, mode: 0o700 });
  if (details.length > 0)
    await mkdir(join(home, "native-views", repositoryKey(bundle.project)), {
      recursive: true,
      mode: 0o700,
    });
  for (const detail of details)
    await writeNativeFile(
      nativeDetailPath(home, bundle.project, detail.file),
      nativeViewText(detail.view.kind, detail.view.data),
    );
  await writeNativeFile(nativeViewsPath(home, bundle.project), nativeViewText("panel", bundle));
  const directory = join(home, "native-views", repositoryKey(bundle.project));
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (
      entry.isFile() &&
      /^(task-|brief-|pr-)[^/\\\0]+\.json$/.test(entry.name) &&
      !retained.has(entry.name)
    )
      await rm(nativeDetailPath(home, bundle.project, entry.name), { force: true });
  }
}

async function writeNativeFile(path: string, text: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === text) return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

const projectSummaryModelSchema = z.object({
  project: z.string().min(1),
  writtenAt: z.string().datetime(),
  summary: z.object({
    terminal: z.literal("tern"),
    repoPath: z.string().min(1),
    name: z.string(),
    writtenAt: z.string().datetime(),
    running: z.number().int().nonnegative(),
    needsYou: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    sessionId: z.string().optional(),
  }),
});
const projectSummarySchema = z.object({
  version: z.literal(1),
  kind: z.literal("panel"),
  revision: z.string().min(1),
  model: projectSummaryModelSchema,
});

/** Read only summaries already published by their owners. No task store or coordinator state is consulted. */
export async function readNativeProjectSummaries(
  home: string,
  project: string,
): Promise<Readonly<{ summaries: readonly NativeProjectSummary[]; warnings: readonly string[] }>> {
  const directory = join(home, "native-views");
  const summaries: NativeProjectSummary[] = [];
  const warnings: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { summaries, warnings };
    throw error;
  }
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const file = entry.name;
    if (!/^[a-f0-9]{24}\.json$/.test(file) || file === `${repositoryKey(project)}.json`) continue;
    try {
      if (!entry.isFile()) throw new TypeError("Native summary must be a regular file");
      const parsed = projectSummarySchema.parse(
        JSON.parse(await readFile(join(directory, file), "utf8")),
      ).model;
      if (
        parsed.project !== parsed.summary.repoPath ||
        parsed.writtenAt !== parsed.summary.writtenAt ||
        file !== `${repositoryKey(parsed.project)}.json`
      )
        throw new TypeError("Native project summary identity mismatch");
      const { sessionId, ...summary } = parsed.summary;
      summaries.push({ ...summary, ...(sessionId === undefined ? {} : { sessionId }) });
    } catch (error) {
      if (!isMissing(error)) warnings.push(`Native project summary unavailable: ${file}`);
    }
  }
  return { summaries, warnings };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
