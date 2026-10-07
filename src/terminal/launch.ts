import type { TandemEnvironmentSource } from "../config/environment.ts";
import type { CommandRunner } from "../contracts.ts";
import type { CoordinatorResourceOutcome } from "../coordinator/resources.ts";
import type { CoordinatorWorkspaceRetirement } from "../coordinator/workspace.ts";
import type { TandemService } from "../service/controller.ts";
import { terminalContextFor } from "../terminal-backend/compose.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";
import type { TerminalInvocation } from "./arguments.ts";
import {
  type CliApplication,
  type CliDependencies,
  createCliApplication,
} from "./cli-application.ts";
import { parseCliArgs } from "./cli-arguments.ts";
import { defaultRunInteractive } from "./cli-process.ts";
import type { TerminalEnvironment } from "./environment.ts";
import { streamIsTTY } from "./process.ts";

export function launchProcessEnvironment(source: TandemEnvironmentSource): TandemEnvironmentSource {
  const sanitized: Record<string, string | undefined> = { ...source };
  delete sanitized.TANDEM_SOURCE_REPO;
  delete sanitized.TANDEM_PARENT_WORKSPACE;
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workspaceIdFromLaunch(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.workspaceId === "string" && value.workspaceId.trim().length > 0
    ? value.workspaceId
    : undefined;
}

/** A notice when the Tandem panel could not open beside a coordinator; it never stops a launch. */
export function panelFailureNotice(repoPath: string, launch: unknown): string | undefined {
  if (!isRecord(launch) || typeof launch.panelFailure !== "string") return undefined;
  return `Tandem's panel did not open beside ${repoPath} (${launch.panelFailure}); tandem panel --popup shows it anywhere.\n`;
}

/** Catch-up is optional; report its warning separately from a panel opening failure. */
export function catchUpWarningNotice(repoPath: string, launch: unknown): string | undefined {
  if (!isRecord(launch) || typeof launch.catchUpWarning !== "string") return undefined;
  return `${repoPath}: ${launch.catchUpWarning}\n`;
}

/** Reads a coordinator launch result's workspace retirement report, if it carried one. */
export function workspaceRetirementFromLaunch(
  value: unknown,
): CoordinatorWorkspaceRetirement | undefined {
  if (!isRecord(value)) return undefined;
  const retirement = value.workspaceRetirement;
  if (!isRecord(retirement) || typeof retirement.outcome !== "string") return undefined;
  return retirement as CoordinatorWorkspaceRetirement;
}

/**
 * Formats a user-facing notice for a retained or quarantined coordinator workspace. Returns
 * undefined for the silent, default outcomes (closed, already-clear).
 */
export function workspaceRetirementNotice(
  repoPath: string,
  retirement: CoordinatorWorkspaceRetirement,
): string | undefined {
  if (retirement.outcome === "closed" || retirement.outcome === "already-clear") return undefined;
  const reason = retirement.reason === undefined ? "" : `: ${retirement.reason}`;
  const leftOpen =
    retirement.extraPaneIds === undefined || retirement.extraPaneIds.length === 0
      ? ""
      : ` Left open: ${retirement.extraPaneIds.join(", ")}.`;
  return retirement.outcome === "retained"
    ? `Tandem retained the previous coordinator workspace for ${repoPath}${reason}.${leftOpen}\n`
    : `Tandem left an ambiguous previous coordinator pane or workspace untouched for ${repoPath}${reason}.\n`;
}

/** Reads a coordinator launch result's previous-resource report, if it carried one. */
export function previousResourcesFromLaunch(
  value: unknown,
): CoordinatorResourceOutcome | undefined {
  if (!isRecord(value)) return undefined;
  const resources = value.previousResources;
  if (!isRecord(resources) || typeof resources.outcome !== "string") return undefined;
  return resources as CoordinatorResourceOutcome;
}

/**
 * Formats a user-facing notice for a previous coordinator worktree lease Tandem kept or
 * quarantined. Returns undefined for the silent outcomes, where nothing accumulated.
 */
export function previousResourcesNotice(
  repoPath: string,
  resources: CoordinatorResourceOutcome,
): string | undefined {
  if (resources.outcome === "retained") {
    return `Tandem kept the previous coordinator worktree for ${repoPath}: ${resources.reason}.\n`;
  }
  if (resources.outcome !== "quarantined") return undefined;
  const where =
    resources.quarantinePath === undefined ? "" : ` Recorded at ${resources.quarantinePath}.`;
  return `Tandem quarantined the previous coordinator worktree lease for ${repoPath}: ${resources.reason}.${where}\n`;
}

/**
 * Formats one notice per stopped coordinator a launch settled for another Tandem session, so a
 * cross-session release, retention, or quarantine is never silent.
 */
export function otherSessionReconciliationNotices(
  repoPath: string,
  value: unknown,
): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value.otherSessionReconciliations)) return [];
  const notices: string[] = [];
  for (const entry of value.otherSessionReconciliations) {
    if (!isRecord(entry) || typeof entry.sessionId !== "string") continue;
    const resources = entry.resources;
    if (!isRecord(resources) || typeof resources.outcome !== "string") continue;
    const reason = typeof resources.reason === "string" ? `: ${resources.reason}` : "";
    const where =
      typeof resources.quarantinePath === "string"
        ? ` Recorded at ${resources.quarantinePath}.`
        : "";
    notices.push(
      `Tandem settled a stopped coordinator for ${repoPath} from Herdr session ${entry.sessionId} (${resources.outcome})${reason}.${where}\n`,
    );
  }
  return notices;
}

/** Reads the re-nest warnings a coordinator restart reported, if any. */
export function renestWarningsFromLaunch(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value.renestWarnings)) return [];
  return value.renestWarnings.filter((warning): warning is string => typeof warning === "string");
}

/**
 * Launches each project's coordinator, then runs `afterLaunches` before attaching: attaching blocks
 * until the person leaves Herdr, so anything that should change what they see must happen first.
 */
export async function launchProjects(
  roots: readonly string[],
  invocation: TerminalInvocation,
  environment: TerminalEnvironment,
  dependencies: Readonly<{
    readonly application?: CliApplication;
    readonly createApplication?: (dependencies: CliDependencies) => CliApplication;
    readonly runInteractive?: CliDependencies["runInteractive"];
    readonly stdout?: (text: string) => void;
    readonly stderr?: (text: string) => void;
    readonly input?: NodeJS.ReadableStream;
    readonly output?: NodeJS.WritableStream;
    readonly isTTY?: boolean;
  }>,
  service: TandemService,
  run: CommandRunner,
  terminal: TerminalBackend,
  afterLaunches: (launches: readonly unknown[]) => Promise<void> = async () => undefined,
): Promise<readonly unknown[]> {
  const applicationDependencies: CliDependencies = {
    cwd: environment.cwd,
    processEnvironment: launchProcessEnvironment(environment.source),
    run,
    terminal,
    service,
    runInteractive: dependencies.runInteractive ?? defaultRunInteractive,
    ...(dependencies.stdout === undefined ? {} : { stdout: dependencies.stdout }),
    ...(dependencies.stderr === undefined ? {} : { stderr: dependencies.stderr }),
  };
  const application =
    dependencies.application ??
    (dependencies.createApplication ?? createCliApplication)(applicationDependencies);
  const launches: unknown[] = [];
  try {
    for (const repoPath of roots) {
      const args = [
        "launch",
        "--repo",
        repoPath,
        "--home",
        environment.home,
        "--pool-root",
        environment.poolRoot,
        "--session",
        environment.sessionId,
        "--headless",
        "--no-attach",
        ...(invocation.command === "update" ? ["--restart"] : []),
        // A reset always starts fresh chats; otherwise chats resume unless --fresh.
        ...(invocation.fresh || invocation.command === "reset" ? [] : ["--continue"]),
      ];
      const result = await application.invoke(parseCliArgs(args));
      launches.push(result.value);
    }
  } finally {
    await application.shutdown();
  }
  await afterLaunches(launches);

  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  const interactive = dependencies.isTTY ?? (streamIsTTY(input) && streamIsTTY(output));
  const shouldAttach = !invocation.headless && !invocation.noAttach && interactive;
  if (shouldAttach) {
    const first = roots[0];
    if (first === undefined) throw new Error("no project was prepared for Herdr attachment");
    const workspaceId = workspaceIdFromLaunch(launches[0]);
    if (workspaceId === undefined) {
      throw new Error(
        "coordinator launch returned no workspace identity; refusing to attach an unrelated Herdr workspace",
      );
    }
    const tandemEnvironment = {
      TANDEM_HOME: environment.home,
      TANDEM_POOL_ROOT: environment.poolRoot,
      TANDEM_SESSION: environment.sessionId,
    };
    const focus = await terminal.focusWorkspace({
      sessionId: environment.sessionId,
      cwd: first,
      workspaceId,
      env: tandemEnvironment,
    });
    if (!focus.focused) {
      throw new Error(
        `Herdr workspace focus failed with code ${focus.code}${focus.detail.length === 0 ? "" : `: ${focus.detail}`}`,
      );
    }
    // Focus already showed the coordinator in this window; a client would open a second one.
    if (!terminalContextFor(terminal.name).inWindow(environment.source)) {
      const attach = await (dependencies.runInteractive ?? defaultRunInteractive)({
        argv: terminal.clientCommand(environment.sessionId),
        cwd: first,
        env: tandemEnvironment,
      });
      if (attach !== 0) throw new Error(`Herdr attachment exited with code ${attach}`);
    }
  }
  return launches;
}
