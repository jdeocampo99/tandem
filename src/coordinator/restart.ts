import { realpath } from "node:fs/promises";
import { type HerdrPaneInspection, inspectEndpoint } from "../adapters/herdr.ts";
import { AdapterCommandError, EndpointOwnershipError } from "../adapters/primitives.ts";
import type { CommandRequest, CommandRunner, Endpoint } from "../contracts.ts";
import {
  type CoordinatorLaunchDependencies,
  type CoordinatorLaunchRequest,
  type CoordinatorLaunchResult,
  launchCoordinatorUnlocked,
} from "./launch.ts";
import { withCoordinatorLaunchLock } from "./lock.ts";
import {
  assertStoppedCoordinatorShell,
  commandErrorCode,
  findResetCoordinator,
  findRunningCoordinator,
  parseJson,
  sameCommand,
} from "./ownership.ts";

export type CoordinatorRestartResult = CoordinatorLaunchResult &
  Readonly<{ restarted: boolean; previousPaneId?: string }>;

async function closeSupersededPane(
  run: CommandRunner,
  endpoint: Endpoint,
  cwd: string,
  command: readonly string[],
): Promise<void> {
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
    sameCommand(process.argv, command),
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
  return withCoordinatorLaunchLock(request.home, request.sessionId, async () => {
    const previous = await findRunningCoordinator(dependencies.run, {
      home: request.home,
      sessionId: request.sessionId,
      repoPath: request.repo,
    });
    const stopped =
      previous === undefined
        ? await findResetCoordinator(dependencies.run, {
            home: request.home,
            sessionId: request.sessionId,
            repoPath: request.repo,
          })
        : undefined;
    const prior = previous ?? stopped;
    if (prior !== undefined) {
      await closeSupersededPane(
        dependencies.run,
        prior.endpoint,
        prior.worktree.path,
        prior.command,
      );
    }
    const launch = await launchCoordinatorUnlocked(
      {
        ...request,
        continueSession: true,
        headless: true,
        noAttach: true,
        restart: true,
      },
      dependencies,
    );
    return {
      ...launch,
      restarted: prior !== undefined,
      ...(prior === undefined ? {} : { previousPaneId: prior.endpoint.paneId }),
    };
  });
}
