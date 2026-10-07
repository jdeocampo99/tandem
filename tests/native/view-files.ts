import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type NativePrIndex,
  type NativeViews,
  nativePrFile,
} from "../../src/board/native-views.ts";
import type { NativeProjectRow } from "../../src/board/panel.ts";
import { ViewFile, type ViewFileKind } from "../../src/native/contract.ts";
import {
  openDirectories,
  projectStoreDirectory,
  publishViews,
  viewIndexPath,
} from "../../src/native/store.ts";
import { nativeScreensFixture } from "../tern-view/screens-fixture.ts";

let seq = 0;

/**
 * A view file as `store.ts` writes it, for fixtures that hand a screen a model directly. Every
 * call takes the next `seq` of one test store, so a rewritten file is always newer.
 */
export function viewFileText(kind: ViewFileKind, model: unknown): string {
  seq += 1;
  return `${JSON.stringify({ v: 1, kind, epoch: "test-store", seq, model })}\n`;
}

/**
 * Publishes a complete project view through the real store writer: the screens fixture moved to
 * `project`, with `change` applied on top.
 */
export async function publishFixture(
  home: string,
  project: string,
  change: Partial<NativeViews> = {},
): Promise<void> {
  const base = nativeScreensFixture();
  const writtenAt = change.writtenAt ?? new Date().toISOString();
  const bundle: NativeViews = {
    ...base,
    project,
    writtenAt,
    summary: { ...base.summary, repoPath: project, writtenAt },
    catchup: { ...base.catchup, project },
    ...change,
  };
  await publishViews(home, project, async () => ({ bundle, details: [] }));
}

/** Republishes the index this project last published through the store, edited by `change`. */
export async function republishIndex(
  home: string,
  project: string,
  change: (bundle: NativeViews) => NativeViews,
): Promise<void> {
  const file = ViewFile.parse(JSON.parse(await readFile(viewIndexPath(home, project), "utf8")));
  const bundle = change(file.model as NativeViews);
  await publishViews(home, project, async () => ({ bundle, details: [] }));
}

/** The names of every staged open file in every project's `open/` directory. */
export async function openFiles(home: string): Promise<string[]> {
  const names: string[] = [];
  for (const directory of await openDirectories(home)) names.push(...(await readdir(directory)));
  return names;
}

/** The path of a staged open file listed by `openFiles`. */
export async function openPath(home: string, name: string): Promise<string> {
  for (const directory of await openDirectories(home))
    if ((await readdir(directory)).includes(name)) return join(directory, name);
  throw new Error(`No staged open file is named ${name}`);
}

/** A project switcher row as the publisher writes it. */
export function projectRow(
  repoPath: string,
  row: Readonly<{ current?: boolean; offline?: boolean; sessionId?: string }> = {},
): NativeProjectRow {
  return {
    repoPath,
    name: repoPath.split("/").at(-1) ?? repoPath,
    current: row.current ?? false,
    offline: row.offline ?? false,
    running: 0,
    needsYou: 0,
    status: row.offline ? "offline" : "all quiet",
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
  };
}

/** One cached pull request in a published index. */
export function prIndexEntry(
  repo: string,
  number: number,
  taskId?: string,
): Readonly<Record<string, NativePrIndex>> {
  return {
    [`${repo}#${number}`]: {
      header: {
        repo,
        number,
        title: `PR ${number}`,
        url: `https://github.com/${repo}/pull/${number}`,
        head: "abc123",
        draft: false,
        next: "Review",
        commits: 1,
        additions: 1,
        deletions: 0,
        unresolved: 0,
        ...(taskId === undefined ? {} : { taskId }),
      },
      readAt: "2030-01-01T00:00:00.000Z",
      detailFile: nativePrFile(repo, number),
    },
  };
}

/** The on-disk `state.json` contract; tests read it to assert what a store call committed. */
const SavedState = z
  .object({
    v: z.literal(1),
    project: z.string(),
    epoch: z.string(),
    seq: z.number(),
    alerts: z.record(z.unknown()).optional(),
    visit: z
      .object({
        lastOpenedAt: z.string(),
        lastVisibleAt: z.string().optional(),
        previousSignature: z.string().optional(),
        dismissedSignature: z.string().optional(),
      })
      .strict()
      .optional(),
    published: z.record(z.unknown()).optional(),
  })
  .strict();

/** The project's committed `state.json`, or undefined before the store wrote one. */
export async function savedState(
  home: string,
  project: string,
): Promise<z.infer<typeof SavedState> | undefined> {
  try {
    const text = await readFile(join(projectStoreDirectory(home, project), "state.json"), "utf8");
    return SavedState.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
