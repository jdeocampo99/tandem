import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdapterCommandError,
  EndpointOwnershipError,
  type HerdrPaneInspection,
  inspectEndpoint,
  readCheckpoint,
} from "./adapters.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  TaskRecord,
  WorktreeLease,
} from "./contracts.ts";
import {
  type RuntimePresentation,
  type RuntimeState,
  type RuntimeTaskState,
  readRuntimeState,
  runtimeFile,
} from "./runtime.ts";
import { acquireDarwinFileLock, createTaskStore, type TaskStoreTransaction } from "./store.ts";

const REGISTRY_DIRECTORY = "coordinator-registry";
const RECORD_SUFFIX = ".json";
const SCHEMA_VERSION = 1 as const;
const LEGACY_COORDINATOR_SESSION_DIRECTORY = "coordinator-sessions";
const LEGACY_COORDINATOR_REPOSITORY_KEY_LENGTH = 24;
const COORDINATOR_EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "extension.ts");

const COORDINATOR_LOCK_TIMEOUT_MS = 5_000;
const COORDINATOR_LOCK_POLL_MS = 20;
const RESET_ACTIVE_TASK_STAGES: readonly TaskRecord["stage"][] = [
  "queued",
  "scouting",
  "implementing",
  "validating",
  "reviewing",
  "awaiting-fixes",
];
const RESET_ACTIVE_JOB_PHASES: Readonly<Record<string, true>> = {
  reserved: true,
  launching: true,
  running: true,
};

type JsonRecord = Record<string, unknown>;
type ErrorWithCode = Error & { readonly code?: string };

type SnapshotPane = Readonly<{
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly agentStatus?: string;
}>;

export type CoordinatorRecord = Readonly<{
  readonly schemaVersion: 1;
  readonly repoPath: string;
  readonly endpoint: Endpoint;
  readonly worktree: WorktreeLease;
  readonly command: readonly string[];
}>;

type FindRunningCoordinatorInput = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly repoPath: string;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as ErrorWithCode).code === "string"
    ? (error as ErrorWithCode).code
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function sessionText(value: unknown): string {
  return text(value, "sessionId");
}

function absolutePath(value: unknown, field: string): string {
  const valueText = text(value, field);
  if (!isAbsolute(valueText)) throw new TypeError(`${field} must be absolute`);
  const path = resolve(valueText);
  if (path === sep) throw new TypeError(`${field} must not be the filesystem root`);
  return path;
}

async function canonicalPath(value: unknown, field: string): Promise<string> {
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

async function canonicalHome(value: unknown): Promise<string> {
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

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseEndpoint(value: unknown, field: string): Endpoint {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  ensureExactKeys(
    value,
    ["sessionId", "workspaceId", "tabId", "paneId", "role", "generation"],
    field,
  );
  const sessionId = sessionText(value.sessionId);
  const workspaceId = text(value.workspaceId, `${field}.workspaceId`);
  const tabId = text(value.tabId, `${field}.tabId`);
  const paneId = text(value.paneId, `${field}.paneId`);
  if (value.role !== "coordinator") throw new TypeError(`${field}.role must be "coordinator"`);
  const generation = positiveInteger(value.generation, `${field}.generation`);
  if (generation !== 0) throw new TypeError(`${field}.generation must be 0 for a coordinator`);
  return { sessionId, workspaceId, tabId, paneId, role: "coordinator", generation };
}

function parseWorktree(value: unknown, field: string): WorktreeLease {
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

function parseCommand(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty array`);
  }
  const command = value.map((entry, index) => text(entry, `${field}[${index}]`));
  if (command[0] !== "omp") throw new TypeError(`${field}[0] must be "omp"`);
  return command;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep))
  );
}

async function canonicalizeRecord(record: CoordinatorRecord): Promise<CoordinatorRecord> {
  if (!isRecord(record)) throw new TypeError("coordinator record must be an object");
  ensureExactKeys(
    record,
    ["schemaVersion", "repoPath", "endpoint", "worktree", "command"],
    "record",
  );
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(`record.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const endpoint = parseEndpoint(record.endpoint, "record.endpoint");
  const worktree = parseWorktree(record.worktree, "record.worktree");
  const repoPath = await canonicalPath(record.repoPath, "record.repoPath");
  const root = await canonicalPath(worktree.root, "record.worktree.root");
  const worktreePath = await canonicalPath(worktree.path, "record.worktree.path");
  if (!pathIsWithin(root, worktreePath)) {
    throw new TypeError("record.worktree.path must be inside record.worktree.root");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    repoPath,
    endpoint: {
      ...endpoint,
      sessionId: endpoint.sessionId,
    },
    worktree: {
      ...worktree,
      root,
      path: worktreePath,
    },
    command: parseCommand(record.command, "record.command"),
  };
}

function parseStoredRecord(value: unknown, source: string): CoordinatorRecord {
  if (!isRecord(value)) throw new TypeError(`${source} must contain an object`);
  ensureExactKeys(value, ["schemaVersion", "repoPath", "endpoint", "worktree", "command"], source);
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(`${source}.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const repoPath = absolutePath(value.repoPath, `${source}.repoPath`);
  const endpoint = parseEndpoint(value.endpoint, `${source}.endpoint`);
  const worktree = parseWorktree(value.worktree, `${source}.worktree`);
  if (!pathIsWithin(worktree.root, worktree.path)) {
    throw new TypeError(`${source}.worktree.path must be inside ${source}.worktree.root`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    repoPath,
    endpoint,
    worktree,
    command: parseCommand(value.command, `${source}.command`),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function registrySessionDirectory(home: string, sessionId: string): string {
  return join(home, REGISTRY_DIRECTORY, digest(sessionId));
}

function recordPath(home: string, sessionId: string, repoPath: string): string {
  return join(registrySessionDirectory(home, sessionId), `${digest(repoPath)}${RECORD_SUFFIX}`);
}

async function ensurePrivateDirectoryTree(directory: string, field: string): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`${field} must be a private directory`);
      }
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(parent === sep ? current.slice(1) : current.slice(parent.length + 1));
      current = parent;
    }
  }
  for (const component of missing) {
    const next = join(current, component);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const details = await lstat(next);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`${field} must be a private directory`);
    }
    current = next;
  }
}

async function readRecordFile(path: string): Promise<CoordinatorRecord | undefined> {
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

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = normalizeOmpCommand(left);
  const normalizedRight = normalizeOmpCommand(right);
  return (
    normalizedLeft !== undefined &&
    normalizedRight !== undefined &&
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nativeErrorCode(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !isRecord(parsed.error) || typeof parsed.error.code !== "string") {
      return undefined;
    }
    return parsed.error.code;
  } catch {
    return undefined;
  }
}

function commandErrorCode(stdout: string, stderr: string): string | undefined {
  return nativeErrorCode(stdout) ?? nativeErrorCode(stderr);
}

function isMissingEndpointError(error: unknown): boolean {
  if (error instanceof EndpointOwnershipError) return error.reason === "missing";
  if (!(error instanceof AdapterCommandError)) return false;
  const code = commandErrorCode(error.result.stdout, error.result.stderr);
  if (
    code === "server_not_running" ||
    code === "session_not_found" ||
    code === "workspace_not_found" ||
    code === "tab_not_found" ||
    code === "pane_not_found"
  ) {
    return true;
  }
  const output = `${error.result.stdout}\n${error.result.stderr}`.toLowerCase();
  return (
    /(?:pane|session)[-_ ]?(?:not|does not exist|could not be found|unknown)[-_ ]?found/.test(
      output,
    ) ||
    /no such (?:pane|session)/.test(output) ||
    /(?:pane|session).*(?:not found|does not exist|missing)/.test(output)
  );
}

function ownershipFailure(message: string): Error {
  return new Error(`coordinator ownership could not be proved: ${message}`);
}
function parseJson(value: string, operation: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `${operation} returned invalid JSON: ${error instanceof Error ? error.message : "parse failure"}`,
    );
  }
}

function parseSnapshotPanes(value: string): readonly SnapshotPane[] {
  const root = parseJson(value, "herdr api snapshot");
  if (!isRecord(root) || !isRecord(root.result) || root.result.type !== "session_snapshot") {
    throw new Error("herdr api snapshot returned an unknown session snapshot protocol");
  }
  const snapshot = root.result.snapshot;
  if (!isRecord(snapshot) || !Array.isArray(snapshot.panes)) {
    throw new Error("herdr api snapshot omitted the session panes");
  }
  return snapshot.panes.map((value, index) => {
    if (!isRecord(value)) throw new Error(`herdr api snapshot pane ${index} is malformed`);
    const agentStatus =
      value.agent_status === undefined
        ? undefined
        : text(value.agent_status, `snapshot.panes[${index}].agent_status`);
    return {
      workspaceId: text(value.workspace_id, `snapshot.panes[${index}].workspace_id`),
      tabId: text(value.tab_id, `snapshot.panes[${index}].tab_id`),
      paneId: text(value.pane_id, `snapshot.panes[${index}].pane_id`),
      ...(agentStatus === undefined ? {} : { agentStatus }),
    };
  });
}

type CommandOption = Readonly<{
  readonly present: boolean;
  readonly value: string | undefined;
}>;

function commandOption(argv: readonly string[], option: string): CommandOption {
  let value: string | undefined;
  let present = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== option) continue;
    if (present || index + 1 >= argv.length || argv[index + 1]?.startsWith("--") === true) {
      return { present: true, value: undefined };
    }
    present = true;
    value = argv[index + 1];
    index += 1;
  }
  return { present, value };
}
function basename(value: string): string {
  const slash = value.lastIndexOf("/");
  return (slash === -1 ? value : value.slice(slash + 1)).replace(/^-/, "").toLowerCase();
}

function ompLauncherIndex(argv: readonly string[]): number | undefined {
  if (basename(argv[0] ?? "") === "omp") return 0;
  if (basename(argv[0] ?? "") !== "bun") return undefined;
  if (basename(argv[1] ?? "") === "omp") return 1;
  if (basename(argv[1] ?? "") === "bun" && basename(argv[2] ?? "") === "omp") return 2;
  return undefined;
}

function normalizeOmpCommand(argv: readonly string[]): readonly string[] | undefined {
  const launcherIndex = ompLauncherIndex(argv);
  return launcherIndex === undefined ? undefined : ["omp", ...argv.slice(launcherIndex + 1)];
}

function processLooksLikeOmp(process: {
  readonly name: string;
  readonly argv: readonly string[];
  readonly argv0: string | undefined;
}): boolean {
  return (
    normalizeOmpCommand(process.argv) !== undefined ||
    [process.name, process.argv0]
      .filter((value): value is string => value !== undefined)
      .some((value) => basename(value) === "omp")
  );
}

async function legacyInvocationMatch(
  argv: readonly string[],
  repoPath: string,
  sessionDirectory: string,
  extensionPath: string,
): Promise<"match" | "no-match" | "unknown"> {
  const normalized = normalizeOmpCommand(argv);
  if (normalized === undefined) return "unknown";
  const extension = commandOption(normalized, "--extension");
  if (!extension.present) return "no-match";
  if (extension.value === undefined) return "unknown";
  const actualExtension = await canonicalPath(extension.value, "coordinator extension");
  if (actualExtension !== extensionPath) return "no-match";

  const cwd = commandOption(normalized, "--cwd");
  const session = commandOption(normalized, "--session-dir");
  if (
    (cwd.present && cwd.value === undefined) ||
    (session.present && session.value === undefined)
  ) {
    return "unknown";
  }
  if (!cwd.present && !session.present) return "no-match";
  if (cwd.value !== undefined && (await canonicalPath(cwd.value, "coordinator cwd")) === repoPath) {
    return "match";
  }
  if (
    session.value !== undefined &&
    (await canonicalPath(session.value, "coordinator session directory")) === sessionDirectory
  ) {
    return "match";
  }
  return "no-match";
}

function legacySessionDirectory(home: string, repoPath: string): string {
  return join(
    home,
    LEGACY_COORDINATOR_SESSION_DIRECTORY,
    digest(repoPath).slice(0, LEGACY_COORDINATOR_REPOSITORY_KEY_LENGTH),
  );
}

function missingSessionResult(
  result: Readonly<{ readonly code: number; readonly stdout: string; readonly stderr: string }>,
): boolean {
  if (result.code === 0) return false;
  const code = commandErrorCode(result.stdout, result.stderr);
  if (code === "server_not_running" || code === "session_not_found") return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    /no such session/.test(output) ||
    /session.*(?:not found|does not exist|not running|missing)/.test(output) ||
    /server[_ -]?(?:not[_ -]?running|unavailable|not[_ -]?found)/.test(output) ||
    /no herdr server is running/.test(output)
  );
}

function legacyCoordinatorGuidance(sessionId: string, repoPath: string, paneId: string): Error {
  return new Error(
    `A pre-registry Tandem coordinator for ${JSON.stringify(repoPath)} is active in Herdr session ${JSON.stringify(sessionId)} (pane ${JSON.stringify(paneId)}), but no clean coordinator lease record proves ownership. Stop that coordinator manually, confirm its pane has exited, and relaunch tandem; Tandem will not adopt or duplicate it.`,
  );
}

async function findUnrecordedCoordinator(
  run: CommandRunner,
  home: string,
  sessionId: string,
  repoPath: string,
): Promise<CoordinatorRecord | undefined> {
  const snapshot = await run({
    argv: ["herdr", "--session", sessionId, "api", "snapshot"],
    cwd: repoPath,
  });
  if (snapshot.code !== 0) {
    if (missingSessionResult(snapshot)) return undefined;
    throw new Error(
      `could not inspect Herdr session ${JSON.stringify(sessionId)} before coordinator launch: ${snapshot.stderr.trim() || snapshot.stdout.trim() || `exit code ${snapshot.code}`}`,
    );
  }
  const panes = parseSnapshotPanes(snapshot.stdout);
  const extensionPath = await canonicalPath(COORDINATOR_EXTENSION_PATH, "coordinator extension");
  const sessionDirectory = await canonicalPath(
    legacySessionDirectory(home, repoPath),
    "coordinator session directory",
  );
  for (const pane of panes) {
    const endpoint: Endpoint = {
      sessionId,
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      paneId: pane.paneId,
      role: "coordinator",
      generation: 0,
    };
    let inspection: HerdrPaneInspection;
    try {
      inspection = await inspectEndpoint(run, { endpoint, cwd: repoPath });
    } catch (error) {
      if (isMissingEndpointError(error)) continue;
      throw error;
    }
    if (!inspection.activeWorker) continue;
    for (const process of inspection.processInfo.foregroundProcesses) {
      if (!processLooksLikeOmp(process)) continue;
      if (process.argv.length === 0) {
        throw ownershipFailure(
          `active OMP process in pane ${JSON.stringify(pane.paneId)} did not expose argv for legacy identity proof`,
        );
      }
      const match = await legacyInvocationMatch(
        process.argv,
        repoPath,
        sessionDirectory,
        extensionPath,
      );
      if (match === "unknown") {
        throw ownershipFailure(
          `active OMP process in pane ${JSON.stringify(pane.paneId)} exposed an unverifiable Tandem invocation`,
        );
      }
      if (match === "match") throw legacyCoordinatorGuidance(sessionId, repoPath, pane.paneId);
    }
  }
  return undefined;
}

/**
 * Finds a coordinator only when the recorded Herdr pane and native OMP process
 * still prove ownership of the recorded clean worktree.
 */
export async function findRunningCoordinator(
  run: CommandRunner,
  input: FindRunningCoordinatorInput,
): Promise<CoordinatorRecord | undefined> {
  if (typeof run !== "function") throw new TypeError("run must be an argv command runner");
  const home = await canonicalHome(input.home);
  const sessionId = sessionText(input.sessionId);
  const repoPath = await canonicalPath(input.repoPath, "repoPath");
  if (pathIsWithin(repoPath, home)) {
    throw new Error("Tandem home must remain outside the target repository");
  }
  const path = recordPath(home, sessionId, repoPath);
  const record = await readRecordFile(path);
  if (record === undefined) return findUnrecordedCoordinator(run, home, sessionId, repoPath);
  if (record.repoPath !== repoPath) {
    throw ownershipFailure(`record ${path} belongs to ${JSON.stringify(record.repoPath)}`);
  }
  if (record.endpoint.sessionId !== sessionId) {
    throw ownershipFailure(
      `record ${path} belongs to Herdr session ${JSON.stringify(record.endpoint.sessionId)}`,
    );
  }

  try {
    const worktreeDetails = await lstat(record.worktree.path);
    if (!worktreeDetails.isDirectory()) {
      throw ownershipFailure(
        `recorded lease path ${JSON.stringify(record.worktree.path)} is not a directory`,
      );
    }
  } catch (error) {
    if (isMissing(error)) {
      return findUnrecordedCoordinator(run, home, sessionId, repoPath);
    }
    throw error;
  }

  let inspection: HerdrPaneInspection;
  try {
    inspection = await inspectEndpoint(run, {
      endpoint: record.endpoint,
      cwd: record.worktree.path,
    });
  } catch (error) {
    if (isMissingEndpointError(error)) {
      return findUnrecordedCoordinator(run, home, sessionId, repoPath);
    }
    throw error;
  }

  const matchingProcesses = inspection.processInfo.foregroundProcesses.filter((process) =>
    sameCommand(process.argv, record.command),
  );
  if (matchingProcesses.length > 1) {
    throw ownershipFailure(
      `multiple foreground processes match recorded command in pane ${record.endpoint.paneId}`,
    );
  }
  if (matchingProcesses.length === 0) {
    if (!inspection.activeWorker) {
      return findUnrecordedCoordinator(run, home, sessionId, repoPath);
    }
    throw ownershipFailure(
      `foreground process in pane ${record.endpoint.paneId} does not match recorded OMP command (${describeFailure(record.command)})`,
    );
  }

  const foregroundCwd = inspection.pane.foregroundCwd;
  if (foregroundCwd === undefined) {
    throw ownershipFailure("Herdr did not report the coordinator pane foreground cwd");
  }
  const canonicalForegroundCwd = await canonicalPath(foregroundCwd, "foreground cwd");
  if (canonicalForegroundCwd !== record.worktree.path) {
    throw ownershipFailure(
      `coordinator pane cwd ${JSON.stringify(canonicalForegroundCwd)} does not match lease ${JSON.stringify(record.worktree.path)}`,
    );
  }
  return record;
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
    const record = await readRecordFile(path);
    if (record === undefined) continue;
    if (record.endpoint.sessionId !== sessionId) {
      throw ownershipFailure(`record ${path} belongs to another Herdr session`);
    }
    records.push(record);
  }
  return records;
}
export async function withCoordinatorLaunchLock<Result>(
  homeInput: string,
  sessionInput: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function");
  }
  const home = await canonicalHome(homeInput);
  const sessionId = sessionText(sessionInput);
  const registryDirectory = join(home, REGISTRY_DIRECTORY);
  await ensurePrivateDirectoryTree(registryDirectory, "coordinator registry directory");
  const release = await acquireDarwinFileLock(
    join(registryDirectory, `${digest(sessionId).slice(0, 16)}.lock`),
    COORDINATOR_LOCK_TIMEOUT_MS,
    COORDINATOR_LOCK_POLL_MS,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function readSessionSnapshot(
  run: CommandRunner,
  sessionId: string,
  cwd: string,
  allowMissingSession = false,
): Promise<readonly SnapshotPane[]> {
  const request: CommandRequest = {
    argv: ["herdr", "--session", sessionId, "api", "snapshot"],
    cwd,
  };
  const result = await run(request);
  if (result.code !== 0) {
    if (allowMissingSession && missingSessionResult(result)) return [];
    throw new AdapterCommandError("herdr api snapshot", request, result);
  }
  return parseSnapshotPanes(result.stdout);
}

function snapshotPaneForEndpoint(
  panes: readonly SnapshotPane[],
  endpoint: Endpoint,
  description: string,
): SnapshotPane | undefined {
  const matches = panes.filter((pane) => pane.paneId === endpoint.paneId);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw ownershipFailure(
      `${description} pane ${JSON.stringify(endpoint.paneId)} appeared ${matches.length} times in the native session snapshot`,
    );
  }
  const pane = matches[0];
  if (pane === undefined) return undefined;
  if (pane.workspaceId !== endpoint.workspaceId || pane.tabId !== endpoint.tabId) {
    throw ownershipFailure(
      `${description} pane ${JSON.stringify(endpoint.paneId)} has native identity workspace=${JSON.stringify(
        pane.workspaceId,
      )}, tab=${JSON.stringify(pane.tabId)}`,
    );
  }
  return pane;
}

function assertIdleCoordinatorPane(
  panes: readonly SnapshotPane[],
  record: CoordinatorRecord,
): void {
  const pane = snapshotPaneForEndpoint(panes, record.endpoint, "coordinator");
  if (pane === undefined) {
    throw ownershipFailure(
      `recorded coordinator pane ${JSON.stringify(record.endpoint.paneId)} is not present in the native session snapshot`,
    );
  }
  if (pane.agentStatus !== "idle" && pane.agentStatus !== "done") {
    throw new Error(
      `coordinator pane ${JSON.stringify(record.endpoint.paneId)} cannot be reset because its native agent status is ${
        pane.agentStatus === undefined ? "missing" : JSON.stringify(pane.agentStatus)
      }, not ready ("idle" or "done")`,
    );
  }
}

function activeRuntimeJob(phase: string): boolean {
  return RESET_ACTIVE_JOB_PHASES[phase] === true;
}

function unreleasedReservation(
  reservation: RuntimeTaskState["reservation"] | RuntimePresentation["reservation"],
): boolean {
  return reservation !== undefined && reservation.phase !== "released";
}

function runtimeTaskHasActiveState(runtime: RuntimeTaskState, sessionId: string): boolean {
  return (
    runtime.endpoints.some((endpoint) => endpoint.sessionId === sessionId) ||
    runtime.endpointLaunch !== undefined ||
    runtime.stopRequest !== undefined ||
    unreleasedReservation(runtime.reservation) ||
    runtime.jobs.some((job) => job.endpoint?.sessionId === sessionId || activeRuntimeJob(job.phase))
  );
}

function runtimePresentationHasActiveState(
  runtime: RuntimePresentation,
  sessionId: string,
): boolean {
  return (
    runtime.endpoint?.sessionId === sessionId ||
    runtime.job.endpoint?.sessionId === sessionId ||
    runtime.endpointLaunch !== undefined ||
    unreleasedReservation(runtime.reservation) ||
    activeRuntimeJob(runtime.job.phase)
  );
}

function assertSafeTaskState(task: TaskRecord, runtime: RuntimeTaskState | undefined): void {
  if (RESET_ACTIVE_TASK_STAGES.includes(task.stage)) {
    throw new Error(`selected task ${JSON.stringify(task.id)} is active at stage ${task.stage}`);
  }
  if (runtime === undefined) return;
  if (runtime.endpointLaunch !== undefined) {
    throw new Error(`selected task ${JSON.stringify(task.id)} has a pending endpoint launch`);
  }
  if (runtime.stopRequest !== undefined) {
    throw new Error(`selected task ${JSON.stringify(task.id)} has a pending stop intent`);
  }
  if (unreleasedReservation(runtime.reservation)) {
    throw new Error(`selected task ${JSON.stringify(task.id)} has an unreleased reservation`);
  }
  const activeJob = runtime.jobs.find((job) => activeRuntimeJob(job.phase));
  if (activeJob !== undefined) {
    throw new Error(
      `selected task ${JSON.stringify(task.id)} has a ${activeJob.phase} ${activeJob.kind} job`,
    );
  }
}

function isMissingPaneResult(result: CommandResult): boolean {
  if (result.code === 0) return false;
  if (commandErrorCode(result.stdout, result.stderr) === "pane_not_found") return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return /no such pane/.test(output) || /pane.*(?:not found|does not exist|missing)/.test(output);
}

function sameCoordinatorIdentity(left: CoordinatorRecord, right: CoordinatorRecord): boolean {
  return (
    left.repoPath === right.repoPath &&
    left.endpoint.sessionId === right.endpoint.sessionId &&
    left.endpoint.workspaceId === right.endpoint.workspaceId &&
    left.endpoint.tabId === right.endpoint.tabId &&
    left.endpoint.paneId === right.endpoint.paneId &&
    left.worktree.root === right.worktree.root &&
    left.worktree.path === right.worktree.path &&
    left.worktree.name === right.worktree.name &&
    left.worktree.baseHead === right.worktree.baseHead &&
    left.worktree.branch === right.worktree.branch &&
    left.worktree.leaseId === right.worktree.leaseId &&
    left.worktree.leaseHolder === right.worktree.leaseHolder &&
    left.worktree.leasedAt === right.worktree.leasedAt &&
    sameCommand(left.command, right.command)
  );
}

function assertCloseAcknowledgement(result: CommandResult): void {
  const output = result.stdout.trim();
  if (output.length === 0) {
    throw new Error("herdr pane close returned an unknown acknowledgement");
  }
  const value = parseJson(output, "herdr pane close");
  if (!isRecord(value) || !isRecord(value.result) || value.result.type !== "ok") {
    throw new Error("herdr pane close returned an unknown acknowledgement");
  }
}

async function closeCoordinatorPane(run: CommandRunner, record: CoordinatorRecord): Promise<void> {
  const closeRequest: CommandRequest = {
    argv: [
      "herdr",
      "--session",
      record.endpoint.sessionId,
      "pane",
      "close",
      record.endpoint.paneId,
    ],
    cwd: record.worktree.path,
  };
  const closeResult = await run(closeRequest);
  if (closeResult.code !== 0) {
    throw new AdapterCommandError("herdr pane close", closeRequest, closeResult);
  }
  assertCloseAcknowledgement(closeResult);
  const verifyRequest: CommandRequest = {
    argv: ["herdr", "--session", record.endpoint.sessionId, "pane", "get", record.endpoint.paneId],
    cwd: record.worktree.path,
  };
  const verifyResult = await run(verifyRequest);
  if (verifyResult.code === 0) {
    throw new Error(
      `Herdr pane close returned success but coordinator pane ${JSON.stringify(record.endpoint.paneId)} remains present`,
    );
  }
  if (!isMissingPaneResult(verifyResult)) {
    throw new AdapterCommandError("herdr pane close verification", verifyRequest, verifyResult);
  }
}

function assertNoLiveSelectedEndpoint(
  endpoint: Endpoint,
  sessionId: string,
  panes: readonly SnapshotPane[] | undefined,
  description: string,
): void {
  if (endpoint.sessionId !== sessionId) return;
  if (panes === undefined) {
    throw new Error(
      `could not prove that selected ${description} endpoint ${JSON.stringify(endpoint.paneId)} is no longer live`,
    );
  }
  const pane = snapshotPaneForEndpoint(panes, endpoint, description);
  if (pane !== undefined) {
    throw new Error(
      `selected ${description} endpoint ${JSON.stringify(endpoint.paneId)} is still live`,
    );
  }
}

async function resetCoordinatorsUnlocked(
  run: CommandRunner,
  home: string,
  sessionId: string,
  repoPaths: readonly string[],
  store: TaskStoreTransaction,
): Promise<readonly CoordinatorRecord[]> {
  await listCoordinatorRecords(home, sessionId);
  const tasks = await store.list();
  const state: RuntimeState = await readRuntimeState(runtimeFile(home));
  const tasksById = new Map<string, TaskRecord>();
  const repositoryCache = new Map<string, Promise<string>>();
  const canonicalTaskRepository = (path: string): Promise<string> => {
    const cached = repositoryCache.get(path);
    if (cached !== undefined) return cached;
    const pending = canonicalPath(path, "task.repoPath");
    repositoryCache.set(path, pending);
    return pending;
  };
  const selectedRoots = new Set(repoPaths);
  const selectedTaskIds = new Set<string>();
  for (const task of tasks) {
    tasksById.set(task.id, task);
    const repository = await canonicalTaskRepository(task.repoPath);
    if (selectedRoots.has(repository)) selectedTaskIds.add(task.id);
  }
  const runtimeByTaskId = new Map<string, RuntimeTaskState>();
  for (const runtime of state.tasks) {
    runtimeByTaskId.set(runtime.taskId, runtime);
    const task = tasksById.get(runtime.taskId);
    if (task === undefined && runtimeTaskHasActiveState(runtime, sessionId)) {
      throw ownershipFailure(
        `active runtime task ${JSON.stringify(runtime.taskId)} has no matching durable task record`,
      );
    }
  }
  for (const task of tasks) {
    if (selectedTaskIds.has(task.id)) {
      assertSafeTaskState(task, runtimeByTaskId.get(task.id));
    }
  }

  const selectedPresentations: RuntimePresentation[] = [];
  for (const presentation of state.presentations) {
    const task = tasksById.get(presentation.taskId);
    if (task === undefined) {
      if (runtimePresentationHasActiveState(presentation, sessionId)) {
        throw ownershipFailure(
          `active runtime presentation ${JSON.stringify(presentation.id)} has no matching durable task record`,
        );
      }
      continue;
    }
    if (!selectedTaskIds.has(task.id)) continue;
    if (presentation.endpointLaunch !== undefined) {
      throw new Error(
        `selected presentation ${JSON.stringify(presentation.id)} has a pending endpoint launch`,
      );
    }
    if (unreleasedReservation(presentation.reservation)) {
      throw new Error(
        `selected presentation ${JSON.stringify(presentation.id)} has an unreleased reservation`,
      );
    }
    if (activeRuntimeJob(presentation.job.phase)) {
      throw new Error(
        `selected presentation ${JSON.stringify(presentation.id)} has a ${presentation.job.phase} job`,
      );
    }
    selectedPresentations.push(presentation);
  }

  const liveRecords: CoordinatorRecord[] = [];
  for (const repoPath of repoPaths) {
    const record = await findRunningCoordinator(run, { home, sessionId, repoPath });
    if (record !== undefined) liveRecords.push(record);
  }

  let snapshot: readonly SnapshotPane[] | undefined;
  if (liveRecords.length > 0) {
    const first = liveRecords[0];
    if (first === undefined) throw new Error("reset discovered an invalid coordinator record set");
    snapshot = await readSessionSnapshot(run, sessionId, first.worktree.path);
    for (const record of liveRecords) {
      assertIdleCoordinatorPane(snapshot, record);
      const checkpoint = await readCheckpoint(run, { repo: record.worktree.path });
      if (checkpoint.dirty || checkpoint.unmerged) {
        throw new Error(
          `coordinator source worktree ${JSON.stringify(record.worktree.path)} is not clean`,
        );
      }
      if (checkpoint.head !== record.worktree.baseHead) {
        throw new Error(
          `coordinator source worktree ${JSON.stringify(record.worktree.path)} HEAD ${JSON.stringify(
            checkpoint.head,
          )} does not match lease base HEAD ${JSON.stringify(record.worktree.baseHead)}`,
        );
      }
    }
  }

  const selectedEndpoints = new Map<string, Endpoint>();
  for (const task of tasks) {
    if (!selectedTaskIds.has(task.id)) continue;
    for (const endpoint of task.endpoints ?? []) {
      selectedEndpoints.set(`${endpoint.sessionId}\0${endpoint.paneId}`, endpoint);
    }
    const runtime = runtimeByTaskId.get(task.id);
    for (const endpoint of runtime?.endpoints ?? []) {
      selectedEndpoints.set(`${endpoint.sessionId}\0${endpoint.paneId}`, endpoint);
    }
    for (const job of runtime?.jobs ?? []) {
      if (job.endpoint !== undefined) {
        selectedEndpoints.set(`${job.endpoint.sessionId}\0${job.endpoint.paneId}`, job.endpoint);
      }
    }
  }
  const selectedPresentationEndpoints = selectedPresentations
    .map((presentation) => presentation.endpoint ?? presentation.job.endpoint)
    .filter((endpoint): endpoint is Endpoint => endpoint !== undefined);
  if (
    snapshot === undefined &&
    ([...selectedEndpoints.values()].some((endpoint) => endpoint.sessionId === sessionId) ||
      selectedPresentationEndpoints.some((endpoint) => endpoint.sessionId === sessionId))
  ) {
    snapshot = await readSessionSnapshot(run, sessionId, repoPaths[0] ?? home, true);
  }
  for (const endpoint of selectedEndpoints.values()) {
    assertNoLiveSelectedEndpoint(endpoint, sessionId, snapshot, "worker");
  }
  for (const endpoint of selectedPresentationEndpoints) {
    assertNoLiveSelectedEndpoint(endpoint, sessionId, snapshot, "presentation");
  }

  const stopped: CoordinatorRecord[] = [];
  for (const record of liveRecords) {
    try {
      const latest = await findRunningCoordinator(run, {
        home,
        sessionId,
        repoPath: record.repoPath,
      });
      if (latest === undefined) {
        const latestSnapshot = await readSessionSnapshot(run, sessionId, record.worktree.path);
        const pane = snapshotPaneForEndpoint(latestSnapshot, record.endpoint, "coordinator");
        if (pane === undefined) continue;
        throw ownershipFailure(
          `coordinator pane ${JSON.stringify(record.endpoint.paneId)} no longer proves recorded ownership`,
        );
      }
      if (!sameCoordinatorIdentity(latest, record)) {
        throw ownershipFailure(
          `coordinator record for ${JSON.stringify(record.repoPath)} changed before reset`,
        );
      }
      const latestSnapshot = await readSessionSnapshot(run, sessionId, latest.worktree.path);
      assertIdleCoordinatorPane(latestSnapshot, latest);
      await closeCoordinatorPane(run, latest);
      stopped.push(latest);
    } catch (error) {
      if (stopped.length === 0) throw error;
      const stoppedRepos = stopped.map((entry) => entry.repoPath).join(", ");
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `reset closed ${stopped.length} coordinator(s) (${stoppedRepos}) before failing on ${JSON.stringify(
          record.repoPath,
        )}: ${cause}`,
        { cause: error },
      );
    }
  }
  return stopped;
}

export async function resetCoordinators(
  run: CommandRunner,
  input: Readonly<{
    readonly home: string;
    readonly sessionId: string;
    readonly repoPaths: readonly string[];
  }>,
): Promise<readonly CoordinatorRecord[]> {
  if (typeof run !== "function") throw new TypeError("run must be an argv command runner");
  if (!input || typeof input !== "object") throw new TypeError("reset input must be an object");
  if (!Array.isArray(input.repoPaths)) throw new TypeError("repoPaths must be an array");
  const home = await canonicalHome(input.home);
  const sessionId = sessionText(input.sessionId);
  const repoPaths: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of input.repoPaths.entries()) {
    const repoPath = await canonicalPath(value, `repoPaths[${index}]`);
    if (pathIsWithin(repoPath, home)) {
      throw new Error("Tandem home must remain outside the target repository");
    }
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);
    repoPaths.push(repoPath);
  }
  return withCoordinatorLaunchLock(home, sessionId, async () => {
    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => new Date().toISOString(),
      idFactory: randomUUID,
    });
    return store.exclusive((transaction) =>
      resetCoordinatorsUnlocked(run, home, sessionId, repoPaths, transaction),
    );
  });
}
