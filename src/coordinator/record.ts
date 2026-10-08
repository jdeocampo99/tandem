import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Endpoint, TerminalPaneLocation, WorktreeLease } from "../contracts.ts";
import {
  DEFAULT_HARNESS,
  HARNESS_EXECUTABLES,
  type HarnessName,
  type KnownHarness,
  parseHarnessName,
} from "../harness/contract.ts";
import { storedEndpointTerminal } from "../terminal-backend/identity.ts";

export const REGISTRY_DIRECTORY = "coordinator-registry";
/** Prefix of every Treehouse lease holder Tandem uses for a coordinator, and for nothing else. */
export const COORDINATOR_LEASE_HOLDER_PREFIX = "coordinator:";
export const RECORD_SUFFIX = ".json";
export const SCHEMA_VERSION = 1 as const;

type JsonRecord = Record<string, unknown>;
type ErrorWithCode = Error & { readonly code?: string };
export type PendingSourceRefresh = Readonly<{
  readonly leaseId: string;
  readonly leaseHolder: string;
  readonly fromHead: string;
  readonly toHead: string;
}>;
export type CoordinatorRecord = Readonly<{
  readonly schemaVersion: 1;
  readonly repoPath: string;
  readonly endpoint: Endpoint;
  readonly worktree: WorktreeLease;
  /** The harness the coordinator runs on. Records saved before this field ran on OMP. */
  readonly harness: HarnessName;
  readonly command: readonly string[];
  readonly pendingSourceRefresh?: PendingSourceRefresh;
}>;
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as ErrorWithCode).code === "string"
    ? (error as ErrorWithCode).code
    : undefined;
}

export function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export function ownershipFailure(message: string): Error {
  return new Error(`coordinator ownership could not be proved: ${message}`);
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be a non-empty string without NUL bytes`);
  }
  return value;
}

export function sessionText(value: unknown): string {
  return text(value, "sessionId");
}

function absolutePath(value: unknown, field: string): string {
  const valueText = text(value, field);
  if (!isAbsolute(valueText)) throw new TypeError(`${field} must be absolute`);
  const path = resolve(valueText);
  if (path === sep) throw new TypeError(`${field} must not be the filesystem root`);
  return path;
}

export async function canonicalPath(value: unknown, field: string): Promise<string> {
  const valueText = text(value, field);
  const path = resolve(valueText);
  if (path === sep) throw new TypeError(`${field} must not be the filesystem root`);
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissing(error)) return path;
    throw error;
  }
}

export async function canonicalHome(value: unknown): Promise<string> {
  const path = await canonicalPath(value, "home");
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissing(error)) return path;
    throw error;
  }
}

function ensureExactKeys(value: JsonRecord, keys: readonly string[], field: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new TypeError(`${field} contains unknown key ${JSON.stringify(key)}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key))
      throw new TypeError(`${field} is missing ${JSON.stringify(key)}`);
  }
}
function ensureCoordinatorRecordKeys(value: JsonRecord, field: string): void {
  const required = ["schemaVersion", "repoPath", "endpoint", "worktree", "command"];
  const allowed = new Set([...required, "harness", "pendingSourceRefresh"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${field} contains unknown key ${JSON.stringify(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${field} is missing ${JSON.stringify(key)}`);
    }
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseNotificationPane(value: unknown, field: string): TerminalPaneLocation {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  ensureExactKeys(value, ["workspaceId", "tabId", "paneId"], field);
  return {
    workspaceId: text(value.workspaceId, `${field}.workspaceId`),
    tabId: text(value.tabId, `${field}.tabId`),
    paneId: text(value.paneId, `${field}.paneId`),
  };
}

export function parseEndpoint(value: unknown, field: string): Endpoint {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  ensureExactKeys(
    value,
    [
      "sessionId",
      "workspaceId",
      "tabId",
      "paneId",
      "role",
      "generation",
      ...(Object.hasOwn(value, "terminal") ? ["terminal"] : []),
      ...(Object.hasOwn(value, "terminalSessionId") ? ["terminalSessionId"] : []),
      ...(Object.hasOwn(value, "notificationPane") ? ["notificationPane"] : []),
    ],
    field,
  );
  const sessionId = sessionText(value.sessionId);
  const workspaceId = text(value.workspaceId, `${field}.workspaceId`);
  const tabId = text(value.tabId, `${field}.tabId`);
  const paneId = text(value.paneId, `${field}.paneId`);
  if (value.role !== "coordinator") throw new TypeError(`${field}.role must be "coordinator"`);
  const generation = positiveInteger(value.generation, `${field}.generation`);
  if (generation !== 0) throw new TypeError(`${field}.generation must be 0 for a coordinator`);
  return {
    terminal: storedEndpointTerminal(value.terminal, field),
    sessionId,
    ...(value.notificationPane === undefined
      ? {}
      : {
          notificationPane: parseNotificationPane(
            value.notificationPane,
            `${field}.notificationPane`,
          ),
        }),
    ...(value.terminalSessionId === undefined
      ? {}
      : { terminalSessionId: text(value.terminalSessionId, `${field}.terminalSessionId`) }),
    workspaceId,
    tabId,
    paneId,
    role: "coordinator",
    generation,
  };
}

export function parseWorktree(value: unknown, field: string): WorktreeLease {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  ensureExactKeys(
    value,
    ["root", "path", "name", "baseHead", "branch", "leaseId", "leaseHolder", "leasedAt"],
    field,
  );
  return {
    root: absolutePath(value.root, `${field}.root`),
    path: absolutePath(value.path, `${field}.path`),
    name: text(value.name, `${field}.name`),
    baseHead: text(value.baseHead, `${field}.baseHead`),
    branch: text(value.branch, `${field}.branch`),
    leaseId: text(value.leaseId, `${field}.leaseId`),
    leaseHolder: text(value.leaseHolder, `${field}.leaseHolder`),
    leasedAt: text(value.leasedAt, `${field}.leasedAt`),
  };
}

function parsePendingSourceRefresh(value: unknown, field: string): PendingSourceRefresh {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  ensureExactKeys(value, ["leaseId", "leaseHolder", "fromHead", "toHead"], field);
  return {
    leaseId: text(value.leaseId, `${field}.leaseId`),
    leaseHolder: text(value.leaseHolder, `${field}.leaseHolder`),
    fromHead: text(value.fromHead, `${field}.fromHead`),
    toHead: text(value.toHead, `${field}.toHead`),
  };
}

function parseRecordedHarness(value: unknown, field: string): HarnessName {
  return value === undefined ? DEFAULT_HARNESS : parseHarnessName(value, field);
}

function parseCommand(value: unknown, field: string, harness: HarnessName): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty array`);
  }
  const command = value.map((entry, index) => text(entry, `${field}[${index}]`));
  const known: KnownHarness = harness;
  const executable = HARNESS_EXECUTABLES[known];
  if (command[0] !== executable) {
    throw new TypeError(`${field}[0] must be ${JSON.stringify(executable)}`);
  }
  return command;
}

export function pathIsWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep))
  );
}
export async function canonicalizeRecord(record: CoordinatorRecord): Promise<CoordinatorRecord> {
  if (!isRecord(record)) throw new TypeError("coordinator record must be an object");
  ensureCoordinatorRecordKeys(record, "record");
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(`record.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const endpoint = parseEndpoint(record.endpoint, "record.endpoint");
  const worktree = parseWorktree(record.worktree, "record.worktree");
  const harness = parseRecordedHarness(record.harness, "record.harness");
  const pendingSourceRefresh =
    record.pendingSourceRefresh === undefined
      ? undefined
      : parsePendingSourceRefresh(record.pendingSourceRefresh, "record.pendingSourceRefresh");
  const repoPath = await canonicalPath(record.repoPath, "record.repoPath");
  const root = await canonicalPath(worktree.root, "record.worktree.root");
  const worktreePath = await canonicalPath(worktree.path, "record.worktree.path");
  if (!pathIsWithin(root, worktreePath)) {
    throw new TypeError("record.worktree.path must be inside record.worktree.root");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    repoPath,
    endpoint: { ...endpoint, sessionId: endpoint.sessionId },
    worktree: { ...worktree, root, path: worktreePath },
    harness,
    command: parseCommand(record.command, "record.command", harness),
    ...(pendingSourceRefresh === undefined ? {} : { pendingSourceRefresh }),
  };
}

export function parseStoredRecord(value: unknown, source: string): CoordinatorRecord {
  if (!isRecord(value)) throw new TypeError(`${source} must contain an object`);
  ensureCoordinatorRecordKeys(value, source);
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(`${source}.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const repoPath = absolutePath(value.repoPath, `${source}.repoPath`);
  const endpoint = parseEndpoint(value.endpoint, `${source}.endpoint`);
  const worktree = parseWorktree(value.worktree, `${source}.worktree`);
  const harness = parseRecordedHarness(value.harness, `${source}.harness`);
  const pendingSourceRefresh =
    value.pendingSourceRefresh === undefined
      ? undefined
      : parsePendingSourceRefresh(value.pendingSourceRefresh, `${source}.pendingSourceRefresh`);
  if (!pathIsWithin(worktree.root, worktree.path)) {
    throw new TypeError(`${source}.worktree.path must be inside ${source}.worktree.root`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    repoPath,
    endpoint,
    worktree,
    harness,
    command: parseCommand(value.command, `${source}.command`, harness),
    ...(pendingSourceRefresh === undefined ? {} : { pendingSourceRefresh }),
  };
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function registrySessionDirectory(home: string, sessionId: string): string {
  return join(home, REGISTRY_DIRECTORY, digest(sessionId));
}

export function recordPath(home: string, sessionId: string, repoPath: string): string {
  return join(registrySessionDirectory(home, sessionId), `${digest(repoPath)}${RECORD_SUFFIX}`);
}
