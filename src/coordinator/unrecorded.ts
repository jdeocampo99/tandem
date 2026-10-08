import { join } from "node:path";
import { AdapterCommandError } from "../adapters/primitives.ts";
import type { Endpoint } from "../contracts.ts";
import { coordinatorHarnesses } from "../harness/resolve.ts";
import type {
  EndpointInspection,
  SessionPane,
  TerminalBackend,
} from "../terminal-backend/contract.ts";
import { canonicalPath, digest, ownershipFailure } from "./record.ts";

type CoordinatorLocation = Readonly<{ home: string; sessionId: string; repoPath: string }>;
type LegacyPaneIdentity = Pick<CoordinatorLocation, "sessionId" | "repoPath"> &
  Readonly<{ sessionDirectory: string; paneId: string }>;

async function inspectUnrecordedPane(
  terminal: TerminalBackend,
  location: CoordinatorLocation,
  pane: SessionPane,
): Promise<EndpointInspection | undefined> {
  const endpoint: Endpoint = {
    terminal: terminal.name,
    sessionId: location.sessionId,
    workspaceId: pane.workspaceId,
    tabId: pane.tabId,
    paneId: pane.paneId,
    role: "coordinator",
    generation: 0,
  };
  try {
    return await terminal.inspect({ endpoint, cwd: location.repoPath });
  } catch (error) {
    if (terminal.isEndpointGone(error)) return undefined;
    throw error;
  }
}

async function assertNoLegacyProcesses(
  inspection: EndpointInspection,
  harnesses: ReturnType<typeof coordinatorHarnesses>,
  identity: LegacyPaneIdentity,
): Promise<void> {
  const { sessionId, repoPath, sessionDirectory, paneId } = identity;
  for (const foregroundProcess of inspection.processInfo.foregroundProcesses) {
    const harness = harnesses.find((candidate) => candidate.looksLikeAgent(foregroundProcess));
    if (harness === undefined) continue;
    if (foregroundProcess.argv.length === 0) {
      throw ownershipFailure(
        `active ${harness.executable} process in pane ${JSON.stringify(paneId)} did not expose argv for legacy identity proof`,
      );
    }
    const match = await harness.matchUnrecordedCoordinator(foregroundProcess.argv, {
      repoPath,
      sessionDirectory,
    });
    if (match === "unknown") {
      throw ownershipFailure(
        `active ${harness.executable} process in pane ${JSON.stringify(paneId)} exposed an unverifiable Tandem invocation`,
      );
    }
    if (match === "match") {
      throw new Error(
        `A pre-registry Tandem coordinator for ${JSON.stringify(repoPath)} is active in Herdr session ${JSON.stringify(sessionId)} (pane ${JSON.stringify(paneId)}), but no clean coordinator lease record proves ownership. Stop that coordinator manually, confirm its pane has exited, and relaunch tandem; Tandem will not adopt or duplicate it.`,
      );
    }
  }
}

/** Refuses a legacy coordinator whose running process has no recorded clean lease. */
export async function findUnrecordedCoordinator(
  terminal: TerminalBackend,
  location: CoordinatorLocation,
): Promise<undefined> {
  const { home, sessionId, repoPath } = location;
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
    join(home, "coordinator-sessions", digest(repoPath).slice(0, 24)),
    "coordinator session directory",
  );
  const harnesses = coordinatorHarnesses();
  for (const pane of panes) {
    const inspection = await inspectUnrecordedPane(terminal, location, pane);
    if (inspection === undefined || !inspection.activeWorker) continue;
    await assertNoLegacyProcesses(inspection, harnesses, {
      sessionId,
      repoPath,
      sessionDirectory,
      paneId: pane.paneId,
    });
  }
}
