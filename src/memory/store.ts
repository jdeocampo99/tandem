import { mkdir, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { centralConfigPath } from "../config/repositories.ts";
import { isNotFoundError } from "../config/storage.ts";
import { type IsoTimestamp, WORKSTREAM_NAME_PATTERN } from "../contracts.ts";
import { writeTextAtomically } from "../runtime/persistence.ts";
import {
  calendarDate,
  datedHandoff,
  emptyMemory,
  handoffDate,
  parseMemory,
  replaceSections,
  type SectionChanges,
  type WorkstreamMemory,
  workstreamName,
} from "./workstream.ts";

/** Older handoffs kept in `handoffs/`; the oldest beyond this are deleted on save. */
export const HANDOFFS_KEPT = 10;
const MEMORY_FILE = "MEMORY.md";
const HANDOFFS_DIRECTORY = "handoffs";
/** Finished workstreams; the leading underscore keeps it from ever matching a workstream name. */
const ARCHIVE_DIRECTORY = "_archive";

export type SavedWorkstream = Readonly<{
  readonly memory: WorkstreamMemory;
  /** When MEMORY.md was last written, by Tandem or by the user's editor. */
  readonly savedAt: IsoTimestamp;
}>;

export type SaveResult =
  | Readonly<{ kind: "saved"; saved: SavedWorkstream; path: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * Where a project's workstream notes live: beside its settings.toml in the Tandem home, so they
 * are never inside the repository or committed. One coordinator runs per repository, so the
 * files need no lock.
 */
export async function memoryRoot(repoPath: string, home: string): Promise<string> {
  return join(dirname(await centralConfigPath(repoPath, home)), "memory");
}

/** Every workstream with notes, by name; finished ones are left out. */
export async function listWorkstreams(root: string): Promise<readonly SavedWorkstream[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  const saved: SavedWorkstream[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !WORKSTREAM_NAME_PATTERN.test(entry.name)) continue;
    const workstream = await readWorkstream(root, entry.name);
    if (workstream !== undefined) saved.push(workstream);
  }
  return saved;
}

export async function readWorkstream(
  root: string,
  name: string,
): Promise<SavedWorkstream | undefined> {
  const path = memoryPath(root, name);
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { memory: parseMemory(name, text), savedAt: info.mtime.toISOString() };
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

/**
 * Replaces the named sections and writes the file at once. A new last handoff moves the one it
 * replaces into `handoffs/<its date>.md`, keeping the newest {@link HANDOFFS_KEPT}.
 */
export async function saveWorkstream(
  root: string,
  name: string,
  changes: SectionChanges,
  now: IsoTimestamp,
): Promise<SaveResult> {
  const workstream = workstreamName(name);
  const current = (await readWorkstream(root, workstream))?.memory ?? emptyMemory(workstream);
  const handoff = changes["last-handoff"];
  const result = replaceSections(
    current,
    handoff === undefined ? changes : { ...changes, "last-handoff": datedHandoff(handoff, now) },
  );
  if (result.kind === "refused") return result;
  const previous = current.sections["last-handoff"];
  if (
    handoff !== undefined &&
    previous !== undefined &&
    previous !== result.memory.sections["last-handoff"]
  ) {
    await archiveHandoff(root, workstream, previous, handoffDate(current) ?? calendarDate(now));
  }
  const path = memoryPath(root, workstream);
  await writeTextAtomically(path, result.text);
  // The file's time is when the notes were saved, so their age reads from Tandem's clock.
  await utimes(path, new Date(now), new Date(now));
  return { kind: "saved", saved: { memory: result.memory, savedAt: now }, path };
}

/** Moves a finished workstream out of the list; its notes and handoffs are kept. */
export async function archiveWorkstream(
  root: string,
  name: string,
  now: IsoTimestamp,
): Promise<string> {
  const workstream = workstreamName(name);
  const source = join(root, workstream);
  if ((await readWorkstream(root, workstream)) === undefined) {
    throw new Error(`there is no workstream named ${workstream}`);
  }
  const archive = join(root, ARCHIVE_DIRECTORY);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const base = `${workstream}-${calendarDate(now)}`;
  for (let attempt = 1; ; attempt += 1) {
    const destination = join(archive, attempt === 1 ? base : `${base}-${attempt}`);
    if (await exists(destination)) continue;
    await rename(source, destination);
    return destination;
  }
}

function memoryPath(root: string, name: string): string {
  return join(root, workstreamName(name), MEMORY_FILE);
}

async function archiveHandoff(
  root: string,
  workstream: string,
  handoff: string,
  date: string,
): Promise<void> {
  const directory = join(root, workstream, HANDOFFS_DIRECTORY);
  const path = join(directory, `${date}.md`);
  // Two handoffs on one day share the file, newest last.
  const earlier = await readFile(path, "utf8").catch((error: unknown) => {
    if (isNotFoundError(error)) return undefined;
    throw error;
  });
  await writeTextAtomically(
    path,
    earlier === undefined ? `${handoff}\n` : `${earlier.trimEnd()}\n\n---\n\n${handoff}\n`,
  );
  const files = (await readdir(directory))
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(file))
    .toSorted();
  for (const file of files.slice(0, Math.max(0, files.length - HANDOFFS_KEPT))) {
    await rm(join(directory, file), { force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: unknown) => {
      if (isNotFoundError(error)) return false;
      throw error;
    },
  );
}
