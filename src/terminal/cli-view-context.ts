import { isAbsolute } from "node:path";
import type { TandemBoundaryEnvironment } from "../config/environment.ts";
import { canonicalPath, pathIsWithin } from "../coordinator/record.ts";
import { discoverCoordinatorRecords } from "../coordinator/registry.ts";
import type { PaneListing, TerminalBackend, ViewOrigin } from "../terminal-backend/contract.ts";
import { type CliInvocation, CliUsageError } from "./cli-arguments.ts";

/** Native plugin opens require the exact pane and cwd, never inherited process context. */
export function validateNativeOpenContext(invocation: CliInvocation): void {
  if (invocation.options.help) return;
  const { viewPaneId, viewCwd } = invocation.options;
  if (
    viewPaneId === undefined ||
    !/^(?:0|[1-9][0-9]*)$/u.test(viewPaneId) ||
    !Number.isSafeInteger(Number(viewPaneId))
  ) {
    throw new CliUsageError("native open requires --pane with an exact decimal integer pane ID");
  }
  if (viewCwd === undefined || !isAbsolute(viewCwd)) {
    throw new CliUsageError("native open requires --cwd with the absolute originating pane cwd");
  }
}

export function viewOriginFrom(invocation: CliInvocation): ViewOrigin | undefined {
  const { viewPaneId, viewWindowId, viewCwd } = invocation.options;
  if (viewPaneId === undefined && viewWindowId === undefined && viewCwd === undefined)
    return undefined;
  return {
    ...(viewPaneId === undefined ? {} : { paneId: viewPaneId }),
    ...(viewWindowId === undefined ? {} : { windowId: viewWindowId }),
    ...(viewCwd === undefined ? {} : { cwd: viewCwd }),
  };
}

/** Selects the project/session from explicit plugin context before creating a scoped service.
 * Context only locates a record. Action handlers still prove its coordinator process ownership.
 */
export async function resolveViewActionEnvironment(
  environment: TandemBoundaryEnvironment,
  invocation: CliInvocation,
  terminal: TerminalBackend,
): Promise<TandemBoundaryEnvironment> {
  const origin = viewOriginFrom(invocation);
  if (origin === undefined) return environment;
  const discovery = await discoverCoordinatorRecords({ home: environment.home });
  if (discovery.unreadable.length > 0)
    throw new Error(
      "Native action cannot select a project while coordinator records are unreadable",
    );
  let records = discovery.records
    .filter((entry) => entry.placement === "session-directory")
    .map((entry) => entry.record);
  if (invocation.options.sessionId !== undefined)
    records = records.filter(
      (record) => record.endpoint.sessionId === invocation.options.sessionId,
    );
  if (origin.cwd !== undefined) {
    const cwd = await canonicalPath(origin.cwd, "native view cwd");
    const matches = records.filter(
      (record) => pathIsWithin(record.repoPath, cwd) || pathIsWithin(record.worktree.path, cwd),
    );
    // A worker's own checkout may be elsewhere in the pool. Its exact pane can still select the
    // project session; an explicit cwd that does identify a project must agree with that pane.
    if (matches.length > 0 || origin.paneId === undefined) records = matches;
  } else if (origin.paneId === undefined) {
    const repo = await canonicalPath(environment.repo, "repoPath");
    records = records.filter((record) => record.repoPath === repo || record.worktree.path === repo);
  }
  if (origin.paneId !== undefined) {
    const sessions = new Map<string, Promise<readonly PaneListing[]>>();
    for (const record of records) {
      if (!sessions.has(record.endpoint.sessionId)) {
        sessions.set(
          record.endpoint.sessionId,
          terminal.listPanes({
            sessionId: record.endpoint.sessionId,
            cwd: record.worktree.path,
            complete: true,
          }),
        );
      }
    }
    const observed = await Promise.all(
      records.map(async (record) => ({
        record,
        panes: await sessions.get(record.endpoint.sessionId),
      })),
    );
    records = observed
      .filter(({ panes }) => panes?.some((pane) => pane.paneId === origin.paneId))
      .map(({ record }) => record);
  }
  const record = records[0];
  if (records.length !== 1 || record === undefined) {
    throw new Error(
      "Native action context does not identify exactly one Tandem project; supply its pane and cwd",
    );
  }
  return {
    ...environment,
    repo: record.repoPath,
    sourceRepo: record.worktree.path,
    sessionId: record.endpoint.sessionId,
    parentWorkspaceId: record.endpoint.workspaceId,
    coordinatorPaneId: record.endpoint.paneId,
  };
}
