import type { TandemEnvironmentSource } from "../config/environment.ts";
import type { CommandRunner } from "../contracts.ts";
import type { TandemService } from "../service/controller.ts";
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

export function hasActiveHerdrContext(source: TandemEnvironmentSource): boolean {
  const session = source.HERDR_SESSION ?? source.HERDR_SESSION_NAME;
  return (
    (source.HERDR_ENV === "1" || source.HERDR_ENV === "true") &&
    session !== undefined &&
    source.HERDR_WORKSPACE_ID !== undefined &&
    source.HERDR_PANE_ID !== undefined
  );
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
): Promise<readonly unknown[]> {
  const applicationDependencies: CliDependencies = {
    cwd: environment.cwd,
    processEnvironment: launchProcessEnvironment(environment.source),
    run,
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
        ...(invocation.continueSession ? ["--continue"] : []),
      ];
      const result = await application.invoke(parseCliArgs(args));
      launches.push(result.value);
    }
  } finally {
    await application.shutdown();
  }

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
    const herdrEnvironment = {
      TANDEM_HOME: environment.home,
      TANDEM_POOL_ROOT: environment.poolRoot,
      TANDEM_SESSION: environment.sessionId,
    };
    const focus = await run({
      argv: ["herdr", "--session", environment.sessionId, "workspace", "focus", workspaceId],
      cwd: first,
      env: herdrEnvironment,
    });
    if (focus.code !== 0) {
      const detail = focus.stderr.trim() || focus.stdout.trim();
      throw new Error(
        `Herdr workspace focus failed with code ${focus.code}${detail.length === 0 ? "" : `: ${detail}`}`,
      );
    }
    if (!hasActiveHerdrContext(environment.source)) {
      const attach = await (dependencies.runInteractive ?? defaultRunInteractive)({
        argv: ["herdr", "--session", environment.sessionId],
        cwd: first,
        env: herdrEnvironment,
      });
      if (attach !== 0) throw new Error(`Herdr attachment exited with code ${attach}`);
    }
  }
  return launches;
}
