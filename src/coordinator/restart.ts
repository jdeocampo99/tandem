import { realpath } from "node:fs/promises";
import { type HerdrPaneInspection, inspectEndpoint } from "../adapters/herdr.ts";
import { AdapterCommandError, EndpointOwnershipError } from "../adapters/primitives.ts";
import type { CommandRequest, CommandRunner } from "../contracts.ts";
import { harnessFor } from "../harness/resolve.ts";
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
  commandErrorCode,
  findRestartCoordinator,
  findRunningCoordinator,
  parseJson,
} from "./ownership.ts";
import type { CoordinatorRecord } from "./record.ts";
import { resolveCoordinatorSourceHead } from "./source.ts";

export type CoordinatorRestartResult = CoordinatorLaunchResult &
  Readonly<{
    restarted: boolean;
    previousPaneId?: string;
    /** Why task workspaces could not all be put back under this coordinator, one line each. */
    renestWarnings?: readonly string[];
  }>;

async function closeSupersededPane(run: CommandRunner, prior: CoordinatorRecord): Promise<void> {
  const { endpoint } = prior;
  const cwd = prior.worktree.path;
  let inspection: HerdrPaneInspection;
  try {
    inspection = await inspectEndpoint(run, { endpoint, cwd });
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
  const request: CommandRequest = {
    argv: ["herdr", "--session", endpoint.sessionId, "pane", "close", endpoint.paneId],
    cwd,
  };
  const result = await run(request);
  if (result.code !== 0)
    throw new AdapterCommandError("herdr coordinator restart close", request, result);
  const acknowledgement = parseJson(result.stdout, "herdr coordinator restart close");
  if (
    typeof acknowledgement !== "object" ||
    acknowledgement === null ||
    Array.isArray(acknowledgement) ||
    typeof (acknowledgement as Record<string, unknown>).result !== "object" ||
    ((acknowledgement as Record<string, unknown>).result as Record<string, unknown> | null)
      ?.type !== "ok"
  ) {
    throw new Error("herdr coordinator restart close returned an unknown acknowledgement");
  }
  const verifyRequest: CommandRequest = {
    argv: ["herdr", "--session", endpoint.sessionId, "pane", "get", endpoint.paneId],
    cwd,
  };
  const verification = await run(verifyRequest);
  if (verification.code === 0) {
    throw new Error(
      `coordinator pane ${JSON.stringify(endpoint.paneId)} remains present after restart close`,
    );
  }
  if (commandErrorCode(verification.stdout, verification.stderr) !== "pane_not_found") {
    throw new AdapterCommandError(
      "herdr coordinator restart close verification",
      verifyRequest,
      verification,
    );
  }
}

/** Replaces an owned coordinator without touching managed worker panes or task state. */
export async function restartCoordinator(
  request: CoordinatorLaunchRequest,
  dependencies: CoordinatorLaunchDependencies,
): Promise<CoordinatorRestartResult> {
  return withClaimedCoordinatorRepository(request, dependencies, async (reconciliations) => {
    const previous = await findRunningCoordinator(dependencies.run, {
      home: request.home,
      sessionId: request.sessionId,
      repoPath: request.repo,
    });
    const stopped =
      previous === undefined
        ? await findRestartCoordinator(dependencies.run, {
            home: request.home,
            sessionId: request.sessionId,
            repoPath: request.repo,
          })
        : undefined;
    const prior = previous ?? stopped;
    await checkNewCoordinator(request, dependencies);
    const sourceHead = await resolveCoordinatorSourceHead(dependencies.run, request.repo);
    if (prior !== undefined) {
      await closeSupersededPane(dependencies.run, prior);
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
