import { realpath } from "node:fs/promises";
import { EndpointOwnershipError } from "../adapters/primitives.ts";
import { harnessFor } from "../harness/resolve.ts";
import type { EndpointInspection, TerminalBackend } from "../terminal-backend/contract.ts";
import {
  type CoordinatorLaunchDependencies,
  type CoordinatorLaunchRequest,
  type CoordinatorLaunchResult,
  checkNewCoordinator,
  launchCoordinatorUnlocked,
  withClaimedCoordinatorRepository,
} from "./launch.ts";
import {
  assertStoppedCoordinatorShell,
  findRestartCoordinator,
  findRunningCoordinator,
} from "./ownership.ts";
import type { CoordinatorRecord } from "./record.ts";
import { startCoordinatorSourceHead } from "./source.ts";

export type CoordinatorRestartResult = CoordinatorLaunchResult &
  Readonly<{
    restarted: boolean;
    previousPaneId?: string;
    /** Why task workspaces could not all be put back under this coordinator, one line each. */
    renestWarnings?: readonly string[];
  }>;

async function closeSupersededPane(
  terminal: TerminalBackend,
  prior: CoordinatorRecord,
): Promise<void> {
  const { endpoint } = prior;
  const cwd = prior.worktree.path;
  let inspection: EndpointInspection;
  try {
    inspection = await terminal.inspect({ endpoint, cwd });
  } catch (error) {
    if (error instanceof EndpointOwnershipError && error.reason === "missing") return;
    throw error;
  }
  if (inspection.pane.foregroundCwd === undefined) {
    throw new Error(`coordinator pane ${JSON.stringify(endpoint.paneId)} has no foreground cwd`);
  }
  const foregroundCwd = await realpath(inspection.pane.foregroundCwd).catch(
    () => inspection.pane.foregroundCwd,
  );
  const expectedCwd = await realpath(cwd).catch(() => cwd);
  if (foregroundCwd !== expectedCwd) {
    throw new Error(
      `coordinator pane ${JSON.stringify(endpoint.paneId)} cwd changed before restart`,
    );
  }
  const matches = inspection.processInfo.foregroundProcesses.filter((process) =>
    harnessFor(prior.harness).sameCommand(process.argv, prior.command),
  );
  if (inspection.activeWorker) {
    if (matches.length !== 1) {
      throw new Error(
        `coordinator pane ${JSON.stringify(endpoint.paneId)} no longer proves recorded ownership`,
      );
    }
  } else {
    assertStoppedCoordinatorShell(inspection);
  }
  await terminal.closeOwned({ endpoint, cwd, strictProof: true });
}

/** The coordinator a restart replaces: the running one, else the last one that stopped. */
async function findPriorCoordinator(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
): Promise<CoordinatorRecord | undefined> {
  const where = { home: request.home, sessionId: request.sessionId, repoPath: request.repo };
  return (
    (await findRunningCoordinator(dependencies.run, dependencies.terminal, where)) ??
    (await findRestartCoordinator(dependencies.run, dependencies.terminal, where))
  );
}

/** Replaces an owned coordinator without touching managed worker panes or task state. */
export async function restartCoordinator(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
): Promise<CoordinatorRestartResult> {
  return withClaimedCoordinatorRepository(request, dependencies, async (reconciliations) => {
    // The fetch needs neither the running coordinator nor the model check, so it runs beside them.
    // Nothing is closed until it and the checks have all succeeded.
    const pendingSourceHead = startCoordinatorSourceHead(dependencies.run, request.repo);
    let prior: CoordinatorRecord | undefined;
    try {
      prior = await findPriorCoordinator(request, dependencies);
      await checkNewCoordinator(request, dependencies);
    } catch (error) {
      await pendingSourceHead.catch(() => undefined);
      throw error;
    }
    const sourceHead = await pendingSourceHead;
    if (prior !== undefined) {
      await closeSupersededPane(dependencies.terminal, prior);
    }
    const launch = await launchCoordinatorUnlocked(
      {
        ...request,
        sourceHead: sourceHead.head,
        headless: true,
        noAttach: true,
        restart: true,
      },
      dependencies,
    );
    const renestWarnings =
      launch.workspaceId !== undefined && dependencies.rehomeTaskWorkspaces !== undefined
        ? await dependencies.rehomeTaskWorkspaces({
            home: request.home,
            cwd: request.cwd,
            sessionId: request.sessionId,
            parentWorkspaceId: launch.workspaceId,
          })
        : [];
    return {
      ...launch,
      ...(renestWarnings.length === 0 ? {} : { renestWarnings }),
      restarted: prior !== undefined,
      ...(prior === undefined ? {} : { previousPaneId: prior.endpoint.paneId }),
      ...(reconciliations.length === 0 ? {} : { otherSessionReconciliations: reconciliations }),
    };
  });
}
