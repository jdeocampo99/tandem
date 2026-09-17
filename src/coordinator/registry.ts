import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePrivateDirectoryTree } from "./lock.ts";
import type { CoordinatorRecord } from "./record.ts";
import {
  canonicalHome,
  canonicalizeRecord,
  isMissing,
  ownershipFailure,
  parseStoredRecord,
  pathIsWithin,
  RECORD_SUFFIX,
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
