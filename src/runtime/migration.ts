import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CommandRunner, Endpoint, TaskRecord } from "../contracts.ts";
import {
  findRunningCoordinator,
  readSessionSnapshot,
  snapshotPaneForEndpoint,
} from "../coordinator/ownership.ts";
import { readCoordinatorRecord } from "../coordinator/registry.ts";
import { parseTaskRecord } from "../tasks/store-codec.ts";
import { acquireDarwinFileLock } from "../tasks/store-lock.ts";
import {
  importLegacyState,
  readMigrationStatus,
  setMigrationStatus,
  withStateLock,
} from "./database.ts";
import { emptyRuntimeState, parseRuntimeState, type RuntimeState } from "./schema.ts";

const MANIFEST_DIRECTORY = ".tandem-migration";
const MANIFEST_FILE = "manifest.json";
const FENCE_FILE = "fence.json";
const ARCHIVE_DIRECTORY = "archive";
type MigrationPhase = "prepared" | "archived" | "imported" | "fenced" | "complete";

export type MigrationSource = Readonly<{
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}>;

export type MigrationManifest = Readonly<{
  readonly schemaVersion: 1;
  readonly id: string;
  readonly home: string;
  readonly createdAt: string;
  readonly phase: MigrationPhase;
  readonly sources: readonly MigrationSource[];
  readonly archivePath: string;
}>;

export type MigrationStatus = "empty" | "ready" | "blocked" | "pending" | "complete";

export type MigrationPlan = Readonly<{
  readonly status: MigrationStatus;
  readonly home: string;
  readonly taskCount: number;
  readonly hasRuntime: boolean;
  readonly sources: readonly MigrationSource[];
  readonly diagnostics: readonly string[];
  readonly quarantinedReservations: readonly string[];
  readonly manifest?: MigrationManifest;
}>;

export type MigrationAuthorityInspection = Readonly<{
  readonly live: boolean;
  readonly ambiguous: boolean;
  readonly evidence?: readonly string[];
}>;

export type MigrationDependencies = Readonly<{
  readonly clock?: () => string;
  readonly run?: CommandRunner;
  readonly inspectAuthority?: (
    home: string,
    runtime: RuntimeState,
  ) => Promise<MigrationAuthorityInspection>;
}>;

export class MigrationError extends Error {
  override name = "MigrationError";
}

function canonicalHome(home: string): string {
  return resolve(home);
}

function migrationDirectory(home: string): string {
  return join(home, MANIFEST_DIRECTORY);
}
function manifestPath(home: string): string {
  return join(migrationDirectory(home), MANIFEST_FILE);
}
function archivePath(home: string): string {
  return join(migrationDirectory(home), ARCHIVE_DIRECTORY);
}
function fencePath(home: string): string {
  return join(migrationDirectory(home), FENCE_FILE);
}
function runtimePath(home: string): string {
  return join(home, "runtime.json");
}
function tasksPath(home: string): string {
  return join(home, "tasks");
}
function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT"
  );
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new MigrationError(`migration path must be a real directory: ${path}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}
async function migrationLockDirectory(home: string): Promise<string | undefined> {
  const candidates = [tasksPath(home), join(archivePath(home), "tasks")];
  for (const candidate of candidates) {
    try {
      const details = await lstat(candidate);
      if (details.isDirectory() && (details.mode & 0o200) !== 0) return candidate;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return undefined;
}
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function assertNoDroppedFields(raw: unknown, parsed: unknown, field: string): void {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed) || raw.length !== parsed.length) {
      throw new MigrationError(`${field} changed during validation`);
    }
    for (let index = 0; index < raw.length; index += 1) {
      assertNoDroppedFields(raw[index], parsed[index], `${field}[${index}]`);
    }
    return;
  }
  if (raw !== null && typeof raw === "object") {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MigrationError(`${field} changed during validation`);
    }
    const parsedRecord = parsed as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      if (!Object.hasOwn(parsedRecord, key)) {
        throw new MigrationError(`${field}.${key} would be lost during migration`);
      }
      assertNoDroppedFields(value, parsedRecord[key], `${field}.${key}`);
    }
  } else if (raw !== parsed) {
    throw new MigrationError(`${field} changed during validation`);
  }
}

async function source(path: string): Promise<MigrationSource | undefined> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new MigrationError(`legacy source is not a regular file: ${path}`);
  }
  const bytes = await readFile(path);
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function taskSources(
  home: string,
  directory = tasksPath(home),
): Promise<readonly MigrationSource[]> {
  let directoryStat: Stats;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new MigrationError(`legacy task directory must be a real directory: ${directory}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name))
    .sort();
  const output: MigrationSource[] = [];
  for (const path of paths) {
    const item = await source(path);
    if (item !== undefined) output.push(item);
  }
  return output;
}
async function readSnapshot(
  home: string,
  archive: MigrationManifest | undefined = undefined,
): Promise<{
  readonly tasks: readonly TaskRecord[];
  readonly runtime: RuntimeState;
  readonly sources: readonly MigrationSource[];
  readonly hasRuntime: boolean;
  readonly quarantinedReservations: readonly string[];
}> {
  const runtimeFile =
    archive === undefined ? runtimePath(home) : join(archive.archivePath, "runtime.json");
  const runtimeSource = await source(runtimeFile);
  let runtime = emptyRuntimeState();
  if (runtimeSource !== undefined) {
    try {
      const parsed: unknown = JSON.parse(await readFile(runtimeFile, "utf8"));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).some(
          (key) => !["schemaVersion", "tasks", "presentations"].includes(key),
        )
      ) {
        throw new Error("runtime snapshot contains unknown top-level fields");
      }
      runtime = parseRuntimeState(parsed, runtimeFile);
      assertNoDroppedFields(parsed, runtime, runtimeFile);
    } catch (error) {
      throw new MigrationError(
        `malformed legacy runtime snapshot ${runtimeFile}: ${describe(error)}`,
      );
    }
  }
  const taskFiles = await taskSources(
    home,
    archive === undefined ? tasksPath(home) : join(archive.archivePath, "tasks"),
  );
  const tasks: TaskRecord[] = [];
  for (const item of taskFiles) {
    try {
      const rawTask: unknown = JSON.parse(await readFile(item.path, "utf8"));
      const parsedTask = parseTaskRecord(rawTask, item.path);
      assertNoDroppedFields(rawTask, parsedTask, item.path);
      tasks.push(parsedTask);
    } catch (error) {
      throw new MigrationError(`malformed legacy task record ${item.path}: ${describe(error)}`);
    }
  }
  const taskIds = new Set(tasks.map((task) => task.id));
  const quarantinedReservations: string[] = [];
  for (const task of runtime.tasks) {
    const reservation = task.reservation;
    if (
      reservation !== undefined &&
      (!taskIds.has(reservation.taskId) ||
        reservation.phase !== "released" ||
        reservation.operationId === undefined)
    ) {
      quarantinedReservations.push(`${task.taskId}:${reservation.id}`);
    }
  }
  for (const presentation of runtime.presentations) {
    const reservation = presentation.reservation;
    if (
      reservation !== undefined &&
      (!taskIds.has(reservation.taskId) ||
        reservation.phase !== "released" ||
        reservation.operationId === undefined)
    ) {
      quarantinedReservations.push(`${presentation.id}:${reservation.id}`);
    }
  }
  return {
    tasks,
    runtime,
    sources:
      archive === undefined
        ? [...(runtimeSource === undefined ? [] : [runtimeSource]), ...taskFiles]
        : archive.sources,
    hasRuntime: runtimeSource !== undefined,
    quarantinedReservations,
  };
}

async function readManifest(home: string): Promise<MigrationManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath(home), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("manifest must be an object");
    }
    const value = parsed as Record<string, unknown>;
    const phase = value.phase;
    const phases: readonly MigrationPhase[] = [
      "prepared",
      "archived",
      "imported",
      "fenced",
      "complete",
    ];
    if (
      value.schemaVersion !== 1 ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      value.home !== home ||
      value.archivePath !== archivePath(home) ||
      typeof value.createdAt !== "string" ||
      !phases.includes(phase as MigrationPhase) ||
      !Array.isArray(value.sources)
    ) {
      throw new Error("manifest has invalid identity, phase, archive, or source list");
    }
    const sources: MigrationSource[] = [];
    const tasks = tasksPath(home);
    for (const entry of value.sources) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("manifest source must be an object");
      }
      const sourceEntry = entry as Record<string, unknown>;
      const path = sourceEntry.path;
      const sha256 = sourceEntry.sha256;
      const bytes = sourceEntry.bytes;
      if (
        typeof path !== "string" ||
        (path !== runtimePath(home) && !path.startsWith(`${tasks}/`)) ||
        typeof sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(sha256) ||
        !Number.isSafeInteger(bytes) ||
        (bytes as number) < 0
      ) {
        throw new Error("manifest contains an invalid source identity or hash");
      }
      sources.push({ path, sha256, bytes: bytes as number });
    }
    return {
      schemaVersion: 1,
      id: value.id as string,
      home,
      createdAt: value.createdAt as string,
      phase: phase as MigrationPhase,
      sources,
      archivePath: archivePath(home),
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new MigrationError(`malformed migration manifest: ${describe(error)}`);
  }
}
async function inspectLegacyAuthority(
  home: string,
  runtime: RuntimeState,
  dependencies: MigrationDependencies,
): Promise<MigrationAuthorityInspection> {
  if (dependencies.inspectAuthority !== undefined) {
    return dependencies.inspectAuthority(home, runtime);
  }
  const activeEvidence: string[] = [];
  const inspectEndpoint = async (
    endpoint: Endpoint,
    cwd: string,
    description: string,
  ): Promise<void> => {
    if (dependencies.run === undefined) {
      activeEvidence.push(`${description} cannot be probed without a native runner`);
      return;
    }
    try {
      const panes = await readSessionSnapshot(dependencies.run, endpoint.sessionId, cwd, true);
      if (snapshotPaneForEndpoint(panes, endpoint, description) !== undefined) {
        activeEvidence.push(`${description} still owns a native pane`);
      }
    } catch (error) {
      activeEvidence.push(`${description} liveness is ambiguous: ${describe(error)}`);
    }
  };
  for (const task of runtime.tasks) {
    if (task.endpointLaunch !== undefined) {
      activeEvidence.push(`task ${task.taskId} has an unresolved endpoint launch`);
    }
    for (const endpoint of task.endpoints) {
      await inspectEndpoint(endpoint, home, `task ${task.taskId} endpoint`);
    }
    for (const job of task.jobs) {
      if (job.phase === "reserved" || job.phase === "launching" || job.phase === "running") {
        activeEvidence.push(`task ${task.taskId} has active worker job ${job.id}`);
      }
    }
  }
  for (const presentation of runtime.presentations) {
    if (presentation.endpointLaunch !== undefined) {
      activeEvidence.push(`presentation ${presentation.id} has an unresolved endpoint launch`);
    }
    if (presentation.endpoint !== undefined) {
      await inspectEndpoint(
        presentation.endpoint,
        home,
        `presentation ${presentation.id} endpoint`,
      );
    }
    if (
      presentation.job.phase === "reserved" ||
      presentation.job.phase === "launching" ||
      presentation.job.phase === "running"
    ) {
      activeEvidence.push(`presentation ${presentation.id} has active job ${presentation.job.id}`);
    }
  }
  if (activeEvidence.length > 0) {
    return { live: false, ambiguous: true, evidence: activeEvidence };
  }
  const registry = join(home, "coordinator-registry");
  let sessions: readonly Dirent[];
  try {
    sessions = await readdir(registry, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { live: false, ambiguous: false };
    throw error;
  }
  const records: Array<{
    readonly repoPath: string;
    readonly sessionId: string;
    readonly endpoint: Endpoint;
  }> = [];
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const files = await readdir(join(registry, session.name), { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      try {
        const record = await readCoordinatorRecord(join(registry, session.name, file.name));
        if (record !== undefined) {
          records.push({
            repoPath: record.repoPath,
            sessionId: record.endpoint.sessionId,
            endpoint: record.endpoint,
          });
        }
      } catch (error) {
        return {
          live: false,
          ambiguous: true,
          evidence: [`cannot validate ${file.name}: ${describe(error)}`],
        };
      }
    }
  }
  if (dependencies.run === undefined) {
    return {
      live: false,
      ambiguous: true,
      evidence: ["coordinator records exist but no native liveness probe was supplied"],
    };
  }
  for (const record of records) {
    try {
      const running = await findRunningCoordinator(dependencies.run, {
        home,
        sessionId: record.sessionId,
        repoPath: record.repoPath,
      });
      if (running !== undefined)
        return {
          live: true,
          ambiguous: false,
          evidence: [`live coordinator for ${record.repoPath}`],
        };
    } catch (error) {
      return {
        live: false,
        ambiguous: true,
        evidence: [`cannot establish coordinator liveness: ${describe(error)}`],
      };
    }
    try {
      const panes = await readSessionSnapshot(
        dependencies.run,
        record.sessionId,
        record.repoPath,
        true,
      );
      if (snapshotPaneForEndpoint(panes, record.endpoint, "legacy coordinator") !== undefined) {
        return {
          live: false,
          ambiguous: true,
          evidence: [
            `coordinator pane remains for ${record.repoPath}; queued native state is unverified`,
          ],
        };
      }
    } catch (error) {
      return {
        live: false,
        ambiguous: true,
        evidence: [`cannot establish coordinator pane state: ${describe(error)}`],
      };
    }
  }
  return { live: false, ambiguous: false };
}
export async function planMigration(
  homeInput: string,
  dependencies: MigrationDependencies = {},
): Promise<MigrationPlan> {
  const home = canonicalHome(homeInput);
  const status = await readMigrationStatus(home);
  const manifest = await readManifest(home);
  if (
    status === "complete" &&
    manifest !== undefined &&
    manifest.phase !== "complete" &&
    (await pathExists(fencePath(home)))
  ) {
    return {
      status: "pending",
      home,
      taskCount: manifest.sources.filter((item) => item.path.includes("/tasks/")).length,
      hasRuntime: manifest.sources.some((item) => item.path === runtimePath(home)),
      sources: manifest.sources,
      diagnostics: ["database import completed; only final migration manifest publication remains"],
      quarantinedReservations: [],
      manifest,
    };
  }
  if (status === "complete" && manifest?.phase === "complete") {
    return {
      status: "complete",
      home,
      taskCount: manifest.sources.filter((item) => item.path.includes("/tasks/")).length,
      hasRuntime: manifest.sources.some((item) => item.path === runtimePath(home)),
      sources: manifest.sources,
      diagnostics: ["migration is complete; canonical SQLite state is authoritative"],
      quarantinedReservations: [],
      manifest,
    };
  }
  const archivedSnapshot =
    manifest !== undefined && (await archiveComplete(manifest)) ? manifest : undefined;
  const snapshot = await readSnapshot(home, archivedSnapshot);
  if (snapshot.sources.length === 0) {
    return {
      status: status === "pending" ? "pending" : "empty",
      home,
      taskCount: 0,
      hasRuntime: false,
      sources: [],
      diagnostics:
        status === "pending"
          ? ["migration is interrupted; rerun migrate-state --yes to resume"]
          : ["no legacy JSON state found; no migration is needed"],
      quarantinedReservations: [],
      ...(manifest === undefined ? {} : { manifest }),
    };
  }
  const authority = await inspectLegacyAuthority(home, snapshot.runtime, dependencies);
  const diagnostics: string[] = [];
  if (authority.live)
    diagnostics.push(...(authority.evidence ?? ["legacy controller or worker is live"]));
  if (authority.ambiguous)
    diagnostics.push(
      ...(authority.evidence ?? ["legacy controller or worker liveness is ambiguous"]),
    );
  if (snapshot.quarantinedReservations.length > 0) {
    diagnostics.push(
      `${snapshot.quarantinedReservations.length} incomplete reservation intent(s) will be quarantined; none will be guessed or resumed`,
    );
  }
  return {
    status:
      authority.live || authority.ambiguous
        ? "blocked"
        : status === "pending"
          ? "pending"
          : "ready",
    home,
    taskCount: snapshot.tasks.length,
    hasRuntime: snapshot.hasRuntime,
    sources: snapshot.sources,
    diagnostics,
    quarantinedReservations: snapshot.quarantinedReservations,
    ...(manifest === undefined ? {} : { manifest }),
  };
}

async function assertSourcesUnchanged(manifest: MigrationManifest): Promise<void> {
  for (const expected of manifest.sources) {
    const actual =
      (await source(archiveSourcePath(manifest, expected.path))) ?? (await source(expected.path));
    if (
      actual === undefined ||
      actual.sha256 !== expected.sha256 ||
      actual.bytes !== expected.bytes
    ) {
      throw new MigrationError(
        `legacy source changed after planning: ${expected.path}; rerun migrate-state`,
      );
    }
  }
}

async function writeManifest(manifest: MigrationManifest): Promise<void> {
  await ensureRealDirectory(migrationDirectory(manifest.home));
  try {
    const details = await lstat(manifestPath(manifest.home));
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new MigrationError(
        `migration manifest path must be a regular file: ${manifestPath(manifest.home)}`,
      );
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = `${manifestPath(manifest.home)}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, manifestPath(manifest.home));
}
async function archiveComplete(manifest: MigrationManifest): Promise<boolean> {
  for (const item of manifest.sources) {
    const archived = await source(archiveSourcePath(manifest, item.path));
    if (archived === undefined || archived.sha256 !== item.sha256 || archived.bytes !== item.bytes)
      return false;
  }
  return true;
}
function archiveSourcePath(manifest: MigrationManifest, path: string): string {
  return join(manifest.archivePath, path.slice(manifest.home.length + 1));
}

async function archiveSources(manifest: MigrationManifest): Promise<void> {
  await ensureRealDirectory(migrationDirectory(manifest.home));
  await ensureRealDirectory(manifest.archivePath);
  const runtime = runtimePath(manifest.home);
  const tasks = tasksPath(manifest.home);
  const hasRuntime = manifest.sources.some((item) => item.path === runtime);
  const hasTasks =
    manifest.sources.some((item) => item.path.startsWith(`${tasks}/`)) || (await pathExists(tasks));
  if (hasRuntime && !(await pathExists(join(manifest.archivePath, "runtime.json")))) {
    if (!(await pathExists(runtime)))
      throw new MigrationError(`legacy runtime disappeared before archive: ${runtime}`);
    await rename(runtime, join(manifest.archivePath, "runtime.json"));
  }
  if (hasTasks && !(await pathExists(join(manifest.archivePath, "tasks")))) {
    const currentTasks = await taskSources(manifest.home);
    const expectedTasks = manifest.sources.filter((item) => item.path.startsWith(`${tasks}/`));
    if (
      currentTasks.length !== expectedTasks.length ||
      expectedTasks.some((expected) => {
        const actual = currentTasks.find((item) => item.path === expected.path);
        return (
          actual === undefined ||
          actual.sha256 !== expected.sha256 ||
          actual.bytes !== expected.bytes
        );
      })
    ) {
      throw new MigrationError(
        "legacy task directory changed after manifest preparation; rerun migrate-state",
      );
    }
    if (!(await pathExists(tasks)))
      throw new MigrationError(`legacy tasks directory disappeared before archive: ${tasks}`);
    await rename(tasks, join(manifest.archivePath, "tasks"));
  }
  for (const item of manifest.sources) {
    const archived = archiveSourcePath(manifest, item.path);
    const actual = await source(archived);
    if (actual === undefined || actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) {
      throw new MigrationError(`archived legacy source does not match manifest: ${item.path}`);
    }
  }
}

async function fenceLegacyPaths(home: string, manifest: MigrationManifest): Promise<void> {
  const runtime = runtimePath(home);
  const tasks = tasksPath(home);
  const ensureFenceDirectory = async (path: string): Promise<void> => {
    try {
      const details = await lstat(path);
      if (!details.isDirectory())
        throw new MigrationError(`legacy writer recreated fenced path: ${path}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(path, { mode: 0o500 });
    }
    await chmod(path, 0o500);
  };
  const ensureFenceFile = async (path: string): Promise<void> => {
    try {
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new MigrationError(`legacy writer recreated fenced path: ${path}`);
      }
      const contents = await readFile(path, "utf8");
      if (!contents.includes('"fencedPath":"tasks"')) {
        throw new MigrationError(`unexpected data exists at fenced path: ${path}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await writeFile(path, `${JSON.stringify({ schemaVersion: 1, fencedPath: "tasks" })}\n`, {
        encoding: "utf8",
        mode: 0o400,
      });
    }
  };
  await ensureFenceDirectory(runtime);
  await ensureFenceFile(tasks);
  const fenceTemporary = `${fencePath(home)}.${randomUUID()}.tmp`;
  await writeFile(
    fenceTemporary,
    `${JSON.stringify({ schemaVersion: 1, home, archivePath: manifest.archivePath, fencedAt: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o400 },
  );
  await rename(fenceTemporary, fencePath(home));
}

export async function migrateState(
  homeInput: string,
  dependencies: MigrationDependencies = {},
): Promise<MigrationPlan> {
  const home = canonicalHome(homeInput);
  const plan = await planMigration(home, dependencies);
  if (plan.status === "empty" || plan.status === "complete") return plan;
  if (plan.status === "blocked") {
    throw new MigrationError(`migration refused: ${plan.diagnostics.join("; ")}`);
  }
  return withStateLock(home, async () => {
    const lockDirectory = await migrationLockDirectory(home);
    const legacyLockPath = lockDirectory === undefined ? undefined : join(lockDirectory, ".lock");
    const releaseLegacyLock =
      legacyLockPath === undefined
        ? undefined
        : await acquireDarwinFileLock(legacyLockPath, 5_000, 20);
    try {
      let snapshot = await readSnapshot(
        home,
        plan.manifest !== undefined && (await archiveComplete(plan.manifest))
          ? plan.manifest
          : undefined,
      );
      const authority = await inspectLegacyAuthority(home, snapshot.runtime, dependencies);
      if (authority.live || authority.ambiguous) {
        throw new MigrationError(
          `migration refused after lock acquisition: ${(authority.evidence ?? ["native authority is not proven stopped"]).join("; ")}`,
        );
      }
      const now = dependencies.clock ?? (() => new Date().toISOString());
      const manifest: MigrationManifest = plan.manifest ?? {
        schemaVersion: 1,
        id: randomUUID(),
        home,
        createdAt: now(),
        phase: "prepared",
        sources: snapshot.sources,
        archivePath: archivePath(home),
      };
      await assertSourcesUnchanged(manifest);
      await writeManifest(manifest);
      await archiveSources(manifest);
      snapshot = await readSnapshot(home, manifest);
      const archivedManifest = { ...manifest, phase: "archived" as const };
      await writeManifest(archivedManifest);
      const currentStatus = await readMigrationStatus(home);
      let importedManifest: MigrationManifest = archivedManifest;
      if (
        currentStatus !== "complete" &&
        manifest.phase !== "imported" &&
        manifest.phase !== "fenced"
      ) {
        await setMigrationStatus(home, "pending");
        try {
          await importLegacyState(home, {
            tasks: snapshot.tasks,
            runtime: snapshot.runtime,
            manifest: {
              ...manifest,
              sourceHash: manifest.sources
                .map((source) => `${source.path}:${source.sha256}:${source.bytes}`)
                .join("|"),
            },
          });
          await setMigrationStatus(home, "pending");
        } catch (error) {
          await setMigrationStatus(home, "failed").catch(() => undefined);
          throw new MigrationError(`legacy state import was not completed: ${describe(error)}`);
        }
        importedManifest = { ...manifest, phase: "imported" };
        await writeManifest(importedManifest);
      } else if (manifest.phase === "imported" || manifest.phase === "fenced") {
        importedManifest = manifest;
      }
      await fenceLegacyPaths(home, importedManifest);
      await writeManifest({ ...importedManifest, phase: "fenced" });
      const completed = { ...importedManifest, phase: "complete" as const };
      await writeManifest(completed);
      await setMigrationStatus(home, "complete");
      return {
        ...plan,
        status: "complete",
        diagnostics: [
          "legacy JSON archived and fenced; SQLite is now authoritative",
          ...plan.diagnostics,
        ],
        manifest: completed,
      };
    } finally {
      if (releaseLegacyLock !== undefined) {
        const relocatedLockPath = join(archivePath(home), "tasks", ".lock");
        await releaseLegacyLock(
          (await pathExists(relocatedLockPath)) ? relocatedLockPath : legacyLockPath,
        );
      }
    }
  });
}
