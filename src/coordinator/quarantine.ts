import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Endpoint, WorktreeLease } from "../contracts.ts";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import { isRecord } from "../runtime/schema.ts";
import { ensurePrivateDirectoryTree } from "./lock.ts";
import {
  canonicalHome,
  canonicalPath,
  isMissing,
  parseEndpoint,
  parseWorktree,
  sessionText,
  text,
} from "./record.ts";

/** Directory under the Tandem home holding coordinator resources Tandem refused to release. */
export const COORDINATOR_QUARANTINE_DIRECTORY = "coordinator-quarantine";
const QUARANTINE_SUFFIX = ".json";
const QUARANTINE_SCHEMA_VERSION = 1 as const;

/**
 * Where a quarantine came from: replacing a previous coordinator, rolling a new one back, or
 * refusing a repository claim whose ownership could not be proved.
 */
export type CoordinatorQuarantineStage = "replacement" | "rollback" | "exclusivity";

/** A durable note that one exact coordinator lease was left in place and why. */
export type CoordinatorQuarantineRecord = Readonly<{
  readonly schemaVersion: 1;
  readonly quarantineId: string;
  readonly quarantinedAt: string;
  readonly stage: CoordinatorQuarantineStage;
  readonly repoPath: string;
  readonly sessionId: string;
  readonly reason: string;
  readonly lease: WorktreeLease;
  readonly endpoint?: Endpoint;
}>;

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function quarantineFileName(quarantineId: string): string {
  const id = text(quarantineId, "quarantineId");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)) {
    throw new TypeError("quarantineId must be a filename-safe identifier");
  }
  return `${id}${QUARANTINE_SUFFIX}`;
}

export function coordinatorQuarantineDirectory(home: string): string {
  return join(home, COORDINATOR_QUARANTINE_DIRECTORY);
}

/** Writes one quarantine note privately and atomically, returning its path. */
export async function writeCoordinatorQuarantineRecord(
  homeInput: string,
  record: CoordinatorQuarantineRecord,
): Promise<string> {
  const home = await canonicalHome(homeInput);
  const directory = coordinatorQuarantineDirectory(home);
  await ensurePrivateDirectoryTree(directory, "coordinator quarantine directory");
  const path = join(directory, quarantineFileName(record.quarantineId));
  await writeJsonAtomically(path, record);
  return path;
}

function parseQuarantineRecord(value: unknown, source: string): CoordinatorQuarantineRecord {
  if (!isRecord(value)) throw new TypeError(`${source} must contain an object`);
  if (value.schemaVersion !== QUARANTINE_SCHEMA_VERSION) {
    throw new TypeError(`${source}.schemaVersion must be ${QUARANTINE_SCHEMA_VERSION}`);
  }
  const stage = value.stage;
  if (stage !== "replacement" && stage !== "rollback" && stage !== "exclusivity") {
    throw new TypeError(`${source}.stage must be "replacement", "rollback", or "exclusivity"`);
  }
  const endpoint =
    value.endpoint === undefined ? undefined : parseEndpoint(value.endpoint, `${source}.endpoint`);
  return {
    schemaVersion: QUARANTINE_SCHEMA_VERSION,
    quarantineId: text(value.quarantineId, `${source}.quarantineId`),
    quarantinedAt: text(value.quarantinedAt, `${source}.quarantinedAt`),
    stage,
    repoPath: text(value.repoPath, `${source}.repoPath`),
    sessionId: sessionText(value.sessionId),
    reason: text(value.reason, `${source}.reason`),
    lease: parseWorktree(value.lease, `${source}.lease`),
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

/** Lists every durable coordinator quarantine note in one Tandem home, oldest name first. */
export async function listCoordinatorQuarantineRecords(
  homeInput: string,
): Promise<readonly CoordinatorQuarantineRecord[]> {
  const home = await canonicalHome(homeInput);
  const directory = coordinatorQuarantineDirectory(home);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const records: CoordinatorQuarantineRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(QUARANTINE_SUFFIX)) continue;
    const path = join(directory, entry.name);
    const contents = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (error) {
      throw new TypeError(`${path} is not valid JSON: ${describeFailure(error)}`);
    }
    records.push(parseQuarantineRecord(parsed, path));
  }
  return records;
}

/** Tern endpoint notes protect uncertain native effects even after their pane disappears. */
export function isCoordinatorEffectQuarantine(record: CoordinatorQuarantineRecord): boolean {
  return record.endpoint?.terminal === "tern";
}

/** Single durable fence for coordinator lease and ownership mutations, across every session. */
export async function assertCoordinatorEffectsSettled(
  home: string,
  repoPath: string,
): Promise<void> {
  const repo = await canonicalPath(repoPath, "repoPath");
  const note = (await listCoordinatorQuarantineRecords(home)).find(
    (record) => isCoordinatorEffectQuarantine(record) && record.repoPath === repo,
  );
  if (note === undefined) return;
  const path = join(
    coordinatorQuarantineDirectory(await canonicalHome(home)),
    quarantineFileName(note.quarantineId),
  );
  throw new Error(
    `Tandem refuses to replace a coordinator for ${JSON.stringify(repo)}: ${note.reason}. ` +
      `Its native effect is quarantined; lease ${note.lease.leaseId} and recorded ownership are retained. ` +
      `Run tandem fix to inspect quarantine record ${path}.`,
  );
}
