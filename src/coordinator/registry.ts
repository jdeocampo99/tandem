import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { chmod, lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePrivateDirectoryTree } from "./lock.ts";
import type { CoordinatorRecord } from "./record.ts";
import {
  canonicalHome,
  canonicalizeRecord,
  canonicalPath,
  digest,
  isMissing,
  ownershipFailure,
  parseStoredRecord,
  pathIsWithin,
  RECORD_SUFFIX,
  REGISTRY_DIRECTORY,
  recordPath,
  registrySessionDirectory,
  sessionText,
} from "./record.ts";

export async function readCoordinatorRecord(path: string): Promise<CoordinatorRecord | undefined> {
  let details: Stats;
  try {
    details = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new TypeError(`coordinator record path must be a regular file: ${path}`);
  }
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`could not read coordinator record ${path}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new TypeError(
      `coordinator record ${path} is not valid JSON: ${error instanceof Error ? error.message : "parse failure"}`,
    );
  }
  return canonicalizeRecord(parseStoredRecord(parsed, path));
}

async function writeRecordFile(path: string, record: CoordinatorRecord): Promise<void> {
  await ensurePrivateDirectoryTree(dirname(path), "coordinator registry directory");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Saves one canonical coordinator record with private atomic replacement. */
export async function saveCoordinatorRecord(
  homeInput: string,
  record: CoordinatorRecord,
): Promise<void> {
  const canonical = await canonicalizeRecord(record);
  const home = await canonicalHome(homeInput);
  if (pathIsWithin(canonical.repoPath, home)) {
    throw new Error("Tandem home must remain outside the target repository");
  }
  await writeRecordFile(
    recordPath(home, canonical.endpoint.sessionId, canonical.repoPath),
    canonical,
  );
}

/**
 * Removes the stored record for one session and repository. Callers use this only after the
 * resources it named have been released or durably quarantined, so no lease loses its last
 * durable pointer.
 */
export async function removeCoordinatorRecord(
  homeInput: string,
  sessionInput: string,
  repoPathInput: string,
): Promise<void> {
  const home = await canonicalHome(homeInput);
  const sessionId = sessionText(sessionInput);
  const repoPath = await canonicalPath(repoPathInput, "repoPath");
  await rm(recordPath(home, sessionId, repoPath), { force: true });
}

/** Whether a stored record sits in the registry directory of the session its endpoint names. */
export type CoordinatorRecordPlacement = "session-directory" | "foreign-directory";

/** One stored coordinator record, with the session it came from and where it was found. */
export type DiscoveredCoordinatorRecord = Readonly<{
  readonly path: string;
  /** Session of origin, taken from the record's own endpoint. */
  readonly sessionId: string;
  readonly placement: CoordinatorRecordPlacement;
  readonly record: CoordinatorRecord;
}>;

/** A registry entry Tandem could not read or parse, reported rather than guessed at. */
export type UnreadableCoordinatorRecord = Readonly<{
  readonly path: string;
  readonly reason: string;
}>;

export type CoordinatorRecordDiscovery = Readonly<{
  readonly records: readonly DiscoveredCoordinatorRecord[];
  readonly unreadable: readonly UnreadableCoordinatorRecord[];
}>;

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Finds coordinator records across every session directory of one Tandem home, so a launch sees
 * records written under other sessions, including by earlier builds. Discovery reads only: it
 * never moves, rewrites, or removes a record, and an entry it cannot parse is reported instead of
 * being skipped silently.
 *
 * With a `repoPath`, records are matched on their own canonical repository path rather than on
 * their file name, so records stored under an older spelling of the same repository are still
 * found; unreadable entries are then limited to the file name this repository's record uses.
 */
export async function discoverCoordinatorRecords(
  input: Readonly<{ readonly home: string; readonly repoPath?: string }>,
): Promise<CoordinatorRecordDiscovery> {
  const home = await canonicalHome(input.home);
  const repoPath =
    input.repoPath === undefined ? undefined : await canonicalPath(input.repoPath, "repoPath");
  const repositoryFileName =
    repoPath === undefined ? undefined : `${digest(repoPath)}${RECORD_SUFFIX}`;
  const registryDirectory = join(home, REGISTRY_DIRECTORY);
  let sessionEntries: Dirent[];
  try {
    sessionEntries = await readdir(registryDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { records: [], unreadable: [] };
    throw error;
  }
  const records: DiscoveredCoordinatorRecord[] = [];
  const unreadable: UnreadableCoordinatorRecord[] = [];
  for (const sessionEntry of sessionEntries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!sessionEntry.isDirectory()) continue;
    const directory = join(registryDirectory, sessionEntry.name);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(RECORD_SUFFIX)) continue;
      const path = join(directory, entry.name);
      let record: CoordinatorRecord | undefined;
      try {
        record = await readCoordinatorRecord(path);
      } catch (error) {
        if (repositoryFileName === undefined || entry.name === repositoryFileName) {
          unreadable.push({ path, reason: describeFailure(error) });
        }
        continue;
      }
      if (record === undefined) continue;
      if (repoPath !== undefined && record.repoPath !== repoPath) continue;
      records.push({
        path,
        sessionId: record.endpoint.sessionId,
        placement:
          digest(record.endpoint.sessionId) === sessionEntry.name
            ? "session-directory"
            : "foreign-directory",
        record,
      });
    }
  }
  return { records, unreadable };
}

/** Lists stored records for one session without probing panes or processes. */
export async function listCoordinatorRecords(
  homeInput: string,
  sessionInput: string,
): Promise<readonly CoordinatorRecord[]> {
  const home = await canonicalHome(homeInput);
  const sessionId = sessionText(sessionInput);
  const directory = registrySessionDirectory(home, sessionId);
  let details: Stats;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new TypeError(`coordinator session registry must be a private directory: ${directory}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const records: CoordinatorRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith(RECORD_SUFFIX)) continue;
    const path = join(directory, entry.name);
    const record = await readCoordinatorRecord(path);
    if (record === undefined) continue;
    if (record.endpoint.sessionId !== sessionId) {
      throw ownershipFailure(`record ${path} belongs to another Herdr session`);
    }
    records.push(record);
  }
  return records;
}
