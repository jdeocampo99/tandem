import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type HerdrPaneInspection, inspectEndpoint } from "../adapters/herdr.ts";
import { AdapterCommandError, EndpointOwnershipError } from "../adapters/primitives.ts";
import type { CommandRequest, CommandRunner, Endpoint } from "../contracts.ts";
import type { CoordinatorRecord } from "./record.ts";
import {
  canonicalHome,
  canonicalPath,
  digest,
  isMissing,
  isRecord,
  ownershipFailure,
  pathIsWithin,
  recordPath,
  sessionText,
  text,
} from "./record.ts";
import { readCoordinatorRecord } from "./registry.ts";

const LEGACY_COORDINATOR_SESSION_DIRECTORY = "coordinator-sessions";
const LEGACY_COORDINATOR_REPOSITORY_KEY_LENGTH = 24;
const COORDINATOR_EXTENSION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "extension.ts",
);

export type SnapshotPane = Readonly<{
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly agentStatus?: string;
}>;
export type FindRunningCoordinatorInput = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly repoPath: string;
}>;
export function sameCommand(left: readonly string[], right: readonly string[]): boolean {
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

export function commandErrorCode(stdout: string, stderr: string): string | undefined {
  return nativeErrorCode(stdout) ?? nativeErrorCode(stderr);
}

export function isMissingEndpointError(error: unknown): boolean {
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

export function parseJson(value: string, operation: string): unknown {
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
  return findOwnedCoordinator(run, input, false);
}

export async function findResetCoordinator(
  run: CommandRunner,
  input: FindRunningCoordinatorInput,
): Promise<CoordinatorRecord | undefined> {
  return findOwnedCoordinator(run, input, true);
}

async function findOwnedCoordinator(
  run: CommandRunner,
  input: FindRunningCoordinatorInput,
  includeStopped: boolean,
): Promise<CoordinatorRecord | undefined> {
  if (typeof run !== "function") throw new TypeError("run must be an argv command runner");
  const home = await canonicalHome(input.home);
  const sessionId = sessionText(input.sessionId);
  const repoPath = await canonicalPath(input.repoPath, "repoPath");
  if (pathIsWithin(repoPath, home)) {
    throw new Error("Tandem home must remain outside the target repository");
  }
  const path = recordPath(home, sessionId, repoPath);
  const record = await readCoordinatorRecord(path);
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
    if (inspection.activeWorker) {
      throw ownershipFailure(
        `foreground process in pane ${record.endpoint.paneId} does not match recorded OMP command (${describeFailure(record.command)})`,
      );
    }
    await findUnrecordedCoordinator(run, home, sessionId, repoPath);
    if (!includeStopped) return undefined;
    assertStoppedCoordinatorShell(inspection);
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

export function assertStoppedCoordinatorShell(inspection: HerdrPaneInspection): void {
  const { shellPid, foregroundProcesses } = inspection.processInfo;
  if (
    inspection.activeWorker ||
    shellPid === undefined ||
    foregroundProcesses.length !== 1 ||
    foregroundProcesses[0]?.pid !== shellPid
  ) {
    throw ownershipFailure("stopped coordinator pane does not prove its original terminal shell");
  }
}

export async function readSessionSnapshot(
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

export function snapshotPaneForEndpoint(
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

export function assertIdleCoordinatorPane(
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
