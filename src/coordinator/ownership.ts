import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdapterCommandError } from "../adapters/primitives.ts";
import type { CommandRequest, CommandRunner, Endpoint } from "../contracts.ts";
import { coordinatorHarnesses, harnessFor } from "../harness/resolve.ts";
import type {
  EndpointInspection,
  SessionPane,
  TerminalBackend,
} from "../terminal-backend/contract.ts";
import { assertTerminalEndpoint } from "../terminal-backend/identity.ts";
import { assertCoordinatorEffectsSettled } from "./quarantine.ts";
import type { CoordinatorRecord } from "./record.ts";
import {
  canonicalHome,
  canonicalPath,
  digest,
  isMissing,
  ownershipFailure,
  pathIsWithin,
  recordPath,
  sessionText,
} from "./record.ts";
import { readCoordinatorRecord } from "./registry.ts";

const LEGACY_COORDINATOR_SESSION_DIRECTORY = "coordinator-sessions";
export const COORDINATOR_SCRIPT_DIRECTORY = "coordinator-scripts";
const LEGACY_COORDINATOR_REPOSITORY_KEY_LENGTH = 24;
export type FindRunningCoordinatorInput = Readonly<{
  readonly home: string;
  readonly sessionId: string;
  readonly repoPath: string;
}>;
function basename(value: string): string {
  const slash = value.lastIndexOf("/");
  return (slash === -1 ? value : value.slice(slash + 1)).replace(/^-/, "").toLowerCase();
}

/** The launch script Tandem writes, which waits in the pane after its coordinator exits. */
function isCoordinatorBootstrap(argv: readonly string[]): boolean {
  const script = argv[1] ?? "";
  return (
    argv.length === 2 &&
    basename(argv[0] ?? "") === "sh" &&
    basename(dirname(script)) === COORDINATOR_SCRIPT_DIRECTORY &&
    /^coordinator-[0-9a-f]{16}-[0-9a-f]{16}-[0-9a-f]{16}\.sh$/u.test(basename(script))
  );
}

function legacySessionDirectory(home: string, repoPath: string): string {
  return join(
    home,
    LEGACY_COORDINATOR_SESSION_DIRECTORY,
    digest(repoPath).slice(0, LEGACY_COORDINATOR_REPOSITORY_KEY_LENGTH),
  );
}

function legacyCoordinatorGuidance(sessionId: string, repoPath: string, paneId: string): Error {
  return new Error(
    `A pre-registry Tandem coordinator for ${JSON.stringify(repoPath)} is active in Herdr session ${JSON.stringify(sessionId)} (pane ${JSON.stringify(paneId)}), but no clean coordinator lease record proves ownership. Stop that coordinator manually, confirm its pane has exited, and relaunch tandem; Tandem will not adopt or duplicate it.`,
  );
}

async function findUnrecordedCoordinator(
  terminal: TerminalBackend,
  home: string,
  sessionId: string,
  repoPath: string,
): Promise<CoordinatorRecord | undefined> {
  let panes: readonly SessionPane[];
  try {
    panes = await terminal.snapshot({ sessionId, cwd: repoPath, allowMissingSession: true });
  } catch (error) {
    if (!(error instanceof AdapterCommandError)) throw error;
    const { result } = error;
    throw new Error(
      `could not inspect Herdr session ${JSON.stringify(sessionId)} before coordinator launch: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}`,
    );
  }
  const sessionDirectory = await canonicalPath(
    legacySessionDirectory(home, repoPath),
    "coordinator session directory",
  );
  const harnesses = coordinatorHarnesses();
  for (const pane of panes) {
    const endpoint: Endpoint = {
      terminal: terminal.name,
      sessionId,
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      paneId: pane.paneId,
      role: "coordinator",
      generation: 0,
    };
    let inspection: EndpointInspection;
    try {
      inspection = await terminal.inspect({ endpoint, cwd: repoPath });
    } catch (error) {
      if (terminal.isEndpointGone(error)) continue;
      throw error;
    }
    if (!inspection.activeWorker) continue;
    for (const process of inspection.processInfo.foregroundProcesses) {
      const harness = harnesses.find((candidate) => candidate.looksLikeAgent(process));
      if (harness === undefined) continue;
      if (process.argv.length === 0) {
        throw ownershipFailure(
          `active ${harness.executable} process in pane ${JSON.stringify(pane.paneId)} did not expose argv for legacy identity proof`,
        );
      }
      const match = await harness.matchUnrecordedCoordinator(process.argv, {
        repoPath,
        sessionDirectory,
      });
      if (match === "unknown") {
        throw ownershipFailure(
          `active ${harness.executable} process in pane ${JSON.stringify(pane.paneId)} exposed an unverifiable Tandem invocation`,
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
  terminal: TerminalBackend,
  input: FindRunningCoordinatorInput,
): Promise<CoordinatorRecord | undefined> {
  return findOwnedCoordinator(run, terminal, input, false, true);
}

/** Finds a running or cleanly stopped coordinator whose pane reset may close. */
export async function findResetCoordinator(
  run: CommandRunner,
  terminal: TerminalBackend,
  input: FindRunningCoordinatorInput,
): Promise<CoordinatorRecord | undefined> {
  return findOwnedCoordinator(run, terminal, input, true, false);
}

/**
 * Like reset, but a coordinator that exited and left its pane to another process is simply
 * stopped: restart relaunches beside that pane instead of refusing.
 */
export async function findRestartCoordinator(
  run: CommandRunner,
  terminal: TerminalBackend,
  input: FindRunningCoordinatorInput,
): Promise<CoordinatorRecord | undefined> {
  return findOwnedCoordinator(run, terminal, input, true, true);
}

/**
 * Returns the pid of any process on this machine still running the recorded coordinator's
 * session directory, "unknown" when the record predates that flag, or undefined when none runs.
 */
async function liveCoordinatorProcess(
  run: CommandRunner,
  record: CoordinatorRecord,
): Promise<string | undefined> {
  const needle = harnessFor(record.harness).processNeedle(record.command);
  if (needle === undefined) return "unknown";
  const request: CommandRequest = {
    argv: ["ps", "-axww", "-o", "pid=,command="],
    cwd: record.worktree.path,
  };
  const result = await run(request);
  if (result.code !== 0) throw new AdapterCommandError("ps", request, result);
  // ponytail: substring match on the joined command line; over-matching only fails closed.
  const line = result.stdout.split("\n").find((entry) => entry.includes(needle));
  return line?.trim().split(/\s+/u)[0];
}

async function findOwnedCoordinator(
  run: CommandRunner,
  terminal: TerminalBackend,
  input: FindRunningCoordinatorInput,
  includeStopped: boolean,
  includeAbandoned: boolean,
): Promise<CoordinatorRecord | undefined> {
  if (typeof run !== "function") throw new TypeError("run must be an argv command runner");
  const home = await canonicalHome(input.home);
  const sessionId = sessionText(input.sessionId);
  const repoPath = await canonicalPath(input.repoPath, "repoPath");
  if (pathIsWithin(repoPath, home)) {
    throw new Error("Tandem home must remain outside the target repository");
  }
  await assertCoordinatorEffectsSettled(home, repoPath);
  const path = recordPath(home, sessionId, repoPath);
  const record = await readCoordinatorRecord(path);
  if (record === undefined) return findUnrecordedCoordinator(terminal, home, sessionId, repoPath);
  assertTerminalEndpoint(terminal.name, record.endpoint);
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
      return findUnrecordedCoordinator(terminal, home, sessionId, repoPath);
    }
    throw error;
  }

  let inspection: EndpointInspection;
  try {
    inspection = await terminal.inspect({
      endpoint: record.endpoint,
      cwd: record.worktree.path,
    });
  } catch (error) {
    if (terminal.isEndpointGone(error)) {
      return findUnrecordedCoordinator(terminal, home, sessionId, repoPath);
    }
    throw error;
  }

  const matchingProcesses = inspection.processInfo.foregroundProcesses.filter((process) =>
    harnessFor(record.harness).sameCommand(process.argv, record.command),
  );
  if (matchingProcesses.length > 1) {
    throw ownershipFailure(
      `multiple foreground processes match recorded command in pane ${record.endpoint.paneId}`,
    );
  }
  if (matchingProcesses.length === 0) {
    const foreground = inspection.processInfo.foregroundProcesses;
    const stoppedBootstrap =
      foreground.length === 1 && isCoordinatorBootstrap(foreground[0]?.argv ?? []);
    if (inspection.activeWorker && !stoppedBootstrap) {
      const livePid = await liveCoordinatorProcess(run, record);
      if (livePid !== undefined) {
        throw ownershipFailure(
          livePid === "unknown"
            ? `pane ${record.endpoint.paneId} runs something other than the coordinator, and this record is too old to tell whether the coordinator is still running elsewhere. Close whatever runs in that pane, then run \`tandem update\`.`
            : `pane ${record.endpoint.paneId} runs something other than the coordinator, but the coordinator is still running elsewhere (process ${livePid}). Stop that process, then run \`tandem update\`.`,
        );
      }
      // The coordinator exited and the pane now runs something else. That pane is no longer
      // ours to close, so it counts as stopped and a relaunch opens a fresh pane beside it.
      if (!includeAbandoned) {
        throw ownershipFailure(
          `the coordinator isn't running in pane ${record.endpoint.paneId} any more, and something else is running there now. Run \`tandem update\` to start it again in a new window.`,
        );
      }
      return undefined;
    }
    await findUnrecordedCoordinator(terminal, home, sessionId, repoPath);
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

/**
 * Proves the pane holds only its own terminal shell, or Tandem's launch script waiting to
 * start the coordinator again after it exited.
 */
export function assertStoppedCoordinatorShell(inspection: EndpointInspection): void {
  const { shellPid, foregroundProcesses } = inspection.processInfo;
  const only = foregroundProcesses.length === 1 ? foregroundProcesses[0] : undefined;
  if (
    (inspection.activeWorker && !isCoordinatorBootstrap(only?.argv ?? [])) ||
    shellPid === undefined ||
    only === undefined ||
    (only.pid !== shellPid && !isCoordinatorBootstrap(only.argv))
  ) {
    throw ownershipFailure("stopped coordinator pane does not prove its original terminal shell");
  }
}

export function snapshotPaneForEndpoint(
  panes: readonly SessionPane[],
  endpoint: Endpoint,
  description: string,
): SessionPane | undefined {
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
  panes: readonly SessionPane[],
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
