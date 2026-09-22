#!/usr/bin/env bun
import { runCommand } from "./adapters/commands.ts";
import type { TandemEnvironmentSource } from "./config/environment.ts";
import type { CommandRunner } from "./contracts.ts";
import {
  type ReconcileReport,
  type ReconcileReportEntry,
  reconcileTandemResources,
} from "./coordinator/reconcile.ts";
import { resetCoordinators } from "./coordinator/reset.ts";
import { diagnosticsPath, readPromptRoutingLog } from "./runtime/diagnostics.ts";
import { migrateState, planMigration } from "./runtime/migration.ts";
import type { TandemService, TandemServiceOptions } from "./service/controller.ts";
import {
  parseTerminalArgs,
  type TerminalInvocation,
  type TerminalRunResult,
} from "./terminal/arguments.ts";
import type { CliApplication, CliDependencies } from "./terminal/cli-application.ts";
import { defaultRunInteractive, type RunInteractive } from "./terminal/cli-process.ts";
import { resolveTerminalEnvironment, type TerminalEnvironment } from "./terminal/environment.ts";
import {
  hasActiveHerdrContext,
  launchProjects,
  otherSessionReconciliationNotices,
  previousResourcesFromLaunch,
  previousResourcesNotice,
  workspaceRetirementFromLaunch,
  workspaceRetirementNotice,
} from "./terminal/launch.ts";
import type { TerminalPrompt, TerminalPrompter } from "./terminal/onboarding.ts";
import {
  createServiceFor,
  prepareProjects,
  readProjectStates,
  runConfigure,
  runOpenConfig,
} from "./terminal/preparation.ts";
import { createReadlineResources, type ReadlineResources, writeText } from "./terminal/process.ts";
import {
  interactiveFor,
  noTtyError,
  readRegisteredProjects,
  selectProjects,
} from "./terminal/projects.ts";

const HELP_TEXT = `Tandem\n\nUsage:\n  tandem [PATH ...]              Open or reconnect project coordinators\n  tandem logs [--home PATH] [--json]\n                                 Show recent prompt-routing events\n  tandem migrate-state [--home PATH] [--yes] [--json]\n                                 Inspect legacy JSON or apply offline SQLite migration\n  tandem reconcile-resources [--home PATH] [--yes] [--discard] [--json]\n                                 Inspect stale resources; apply with --yes; discard cancelled implementation worktrees with --discard\n  tandem restart [PATH ...]      Replace owned coordinators without cancelling work\n  tandem --restart [PATH ...]    Compatibility spelling for restart\n  tandem --reset [PATH ...]      Stop idle Tandem coordinators, then reopen them\n  tandem --reset --force [PATH ...]\n                                 Explicitly discard selected idle coordinator resources\n  tandem configure [PATH]        Inspect or save repository settings\n  tandem config [PATH]           Open the project's settings file in $VISUAL/$EDITOR\n  tandem --help                  Show this help\n`;

export type TerminalMainDependencies = Readonly<{
  readonly cwd?: string;
  readonly processEnvironment?: TandemEnvironmentSource;
  readonly run?: CommandRunner;
  readonly service?: TandemService;
  readonly createService?: (options: TandemServiceOptions) => TandemService;
  readonly application?: CliApplication;
  readonly createApplication?: (dependencies: CliDependencies) => CliApplication;
  readonly runInteractive?: RunInteractive;
  readonly prompt?: TerminalPrompt;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly errorOutput?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly resetCoordinators?: typeof resetCoordinators;
}>;

type TerminalOutput = Readonly<{
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}>;

type TerminalInteraction = Readonly<{
  readonly interactive: boolean;
  readonly prompter: TerminalPrompter | undefined;
  readonly close: () => void;
}>;

type ProjectFlowInputs = Readonly<{
  readonly invocation: TerminalInvocation;
  readonly environment: TerminalEnvironment;
  readonly dependencies: TerminalMainDependencies;
  readonly run: CommandRunner;
  readonly interactive: boolean;
  readonly prompter: TerminalPrompter | undefined;
  readonly stdout: (text: string) => void;
  readonly closeInteraction: () => void;
}>;
type MigrationInputs = Readonly<{
  readonly invocation: TerminalInvocation;
  readonly home: string;
  readonly run: CommandRunner;
  readonly stdout: (text: string) => void;
}>;

function createTerminalOutput(dependencies: TerminalMainDependencies): TerminalOutput {
  const outputStream = dependencies.output ?? process.stdout;
  const errorStream = dependencies.errorOutput ?? process.stderr;
  return {
    stdout: dependencies.stdout ?? ((text: string) => writeText(outputStream, text)),
    stderr: dependencies.stderr ?? ((text: string) => writeText(errorStream, text)),
  };
}

function createTerminalInteraction(
  dependencies: TerminalMainDependencies,
  stdout: (text: string) => void,
): TerminalInteraction {
  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  const interactive = interactiveFor(dependencies, input, output);
  if (dependencies.prompt !== undefined) {
    return {
      interactive,
      prompter: { ask: dependencies.prompt, write: stdout },
      close: () => {},
    };
  }
  if (!interactive) {
    return { interactive, prompter: undefined, close: () => {} };
  }
  let resources: ReadlineResources | undefined = createReadlineResources(input, output);
  return {
    interactive,
    prompter: resources.prompter,
    close: () => {
      resources?.close();
      resources = undefined;
    },
  };
}

function assertSafeTerminalCommand(
  invocation: TerminalInvocation,
  source: TandemEnvironmentSource,
): void {
  if (!(invocation.reset || invocation.restart) || !hasActiveHerdrContext(source)) return;
  const command = invocation.restart ? "--restart" : "--reset";
  throw new Error(
    `tandem ${command} cannot run from inside Herdr; rerun it from a separate normal terminal`,
  );
}

async function handleMigration({
  invocation,
  home,
  run,
  stdout,
}: MigrationInputs): Promise<TerminalRunResult | undefined> {
  if (invocation.command !== "migrate-state") return undefined;
  const migration = invocation.yes
    ? await migrateState(home, { run })
    : await planMigration(home, { run });
  const rendered = invocation.json
    ? JSON.stringify(migration)
    : `${JSON.stringify(migration, null, 2)}\n`;
  stdout(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
  return { exitCode: 0, status: "migrated", migration };
}
async function handlePromptRoutingLogs({
  invocation,
  home,
  stdout,
}: Readonly<{
  readonly invocation: TerminalInvocation;
  readonly home: string;
  readonly stdout: (text: string) => void;
}>): Promise<TerminalRunResult | undefined> {
  if (invocation.command !== "logs") return undefined;
  const lines = await readPromptRoutingLog(home);
  if (invocation.json) {
    stdout(`${JSON.stringify(lines.map((line) => JSON.parse(line)))}\n`);
  } else {
    stdout(`Tandem prompt-routing log: ${diagnosticsPath(home)}\n`);
    stdout(lines.length === 0 ? "No prompt-routing events recorded.\n" : `${lines.join("\n")}\n`);
  }
  return { exitCode: 0, status: "logs" };
}

function reconcileSection(
  title: string,
  entries: readonly ReconcileReportEntry[],
): readonly string[] {
  if (entries.length === 0) return [];
  return [
    `${title} ${entries.length} resource${entries.length === 1 ? "" : "s"}:`,
    ...entries.map((entry) => {
      const where = entry.path ?? entry.repoPath;
      return `  - ${entry.kind} ${entry.id}${where === undefined ? "" : ` (${where})`}: ${entry.reason}`;
    }),
  ];
}

function renderReconcileReport(report: ReconcileReport): string {
  const dryRun = report.mode === "dry-run";
  const lines = [
    dryRun
      ? `Tandem reconcile inspected ${report.home} and changed nothing; rerun with --yes to apply.`
      : `Tandem reconcile applied its plan for ${report.home}.`,
    ...reconcileSection(dryRun ? "Would clean" : "Cleaned", report.cleaned),
    ...reconcileSection("Retained", report.retained),
    ...reconcileSection("Quarantined", report.quarantined),
    ...reconcileSection("Failed", report.failed),
  ];
  if (lines.length === 1) lines.push("Nothing to reconcile.");
  return `${lines.join("\n")}\n`;
}

/**
 * Inspects every Tandem resource under the home, and settles them only when `--yes` says so.
 * A resource Tandem deliberately retained or quarantined is a reported outcome, not a failure,
 * so only a scan or apply that could not finish makes the command exit non-zero.
 */
async function handleReconcile({
  invocation,
  environment,
  run,
  stdout,
}: Readonly<{
  readonly invocation: TerminalInvocation;
  readonly environment: TerminalEnvironment;
  readonly run: CommandRunner;
  readonly stdout: (text: string) => void;
}>): Promise<TerminalRunResult | undefined> {
  if (invocation.command !== "reconcile-resources") return undefined;
  const report = await reconcileTandemResources({
    run,
    home: environment.home,
    poolRoot: environment.poolRoot,
    repoPaths: await readRegisteredProjects(environment.home),
    apply: invocation.yes,
    discard: invocation.discard,
  });
  stdout(invocation.json ? `${JSON.stringify(report)}\n` : renderReconcileReport(report));
  return {
    exitCode: report.failed.length === 0 ? 0 : 1,
    status: "reconciled",
    reconciliation: report,
  };
}

async function runProjectFlow({
  invocation,
  environment,
  dependencies,
  run,
  interactive,
  prompter,
  stdout,
  closeInteraction,
}: ProjectFlowInputs): Promise<TerminalRunResult> {
  const roots = await selectProjects(invocation, environment, run, interactive, prompter);
  if (roots === undefined) {
    stdout("Tandem cancelled; no settings were changed and no coordinator was launched.\n");
    return { exitCode: 0, status: "cancelled" };
  }
  if (roots.length === 0) throw new Error("no projects were selected");
  if (invocation.command === "config") {
    const [root] = roots;
    if (root === undefined || roots.length !== 1) {
      throw new Error("tandem config needs exactly one project");
    }
    closeInteraction();
    return await runOpenConfig(
      root,
      environment,
      dependencies.runInteractive ?? defaultRunInteractive,
      stdout,
    );
  }
  if (invocation.command === "configure" && roots.length !== 1) {
    throw new Error("tandem configure needs exactly one project to validate the OMP catalogue");
  }
  const service = createServiceFor(environment, run, {
    ...(dependencies.service === undefined ? {} : { service: dependencies.service }),
    ...(dependencies.createService === undefined
      ? {}
      : { createService: dependencies.createService }),
  });
  if (invocation.command === "configure") {
    if (!interactive || prompter === undefined) throw noTtyError("tandem configure");
    return await runConfigure(roots, environment, service, prompter, stdout);
  }
  const states = await readProjectStates(roots, service);
  const prepared = await prepareProjects(states, environment, service, prompter, interactive);
  if (prepared === undefined) {
    stdout("Tandem cancelled; no coordinator was launched.\n");
    return {
      exitCode: 0,
      status: "cancelled",
      projects: roots,
      sessionId: environment.sessionId,
    };
  }
  closeInteraction();
  if (invocation.reset) {
    const stopped = await (dependencies.resetCoordinators ?? resetCoordinators)(run, {
      home: environment.home,
      sessionId: environment.sessionId,
      repoPaths: roots,
      force: invocation.force,
    });
    stdout(
      invocation.force
        ? `Tandem force reset stopped ${stopped.length} coordinator${stopped.length === 1 ? "" : "s"}; selected active work was cancelled where present.\n`
        : `Tandem reset stopped ${stopped.length} coordinator${stopped.length === 1 ? "" : "s"}.\n`,
    );
    for (const record of stopped) {
      const notice = workspaceRetirementNotice(record.repoPath, record.workspaceRetirement);
      if (notice !== undefined) stdout(notice);
    }
  }
  const launches = await launchProjects(roots, invocation, environment, dependencies, service, run);
  stdout(
    `Tandem prepared ${roots.length} project${roots.length === 1 ? "" : "s"} in shared Herdr session ${environment.sessionId}.\n`,
  );
  for (const [index, launch] of launches.entries()) {
    const repoPath = roots[index];
    if (repoPath === undefined) continue;
    const retirement = workspaceRetirementFromLaunch(launch);
    const retirementNotice =
      retirement === undefined ? undefined : workspaceRetirementNotice(repoPath, retirement);
    if (retirementNotice !== undefined) stdout(retirementNotice);
    const resources = previousResourcesFromLaunch(launch);
    const resourceNotice =
      resources === undefined ? undefined : previousResourcesNotice(repoPath, resources);
    if (resourceNotice !== undefined) stdout(resourceNotice);
    for (const notice of otherSessionReconciliationNotices(repoPath, launch)) stdout(notice);
  }
  return {
    exitCode: 0,
    status: "launched",
    projects: roots,
    sessionId: environment.sessionId,
    launches,
  };
}

/** Runs the shared-session terminal front door and returns a process-style result. */
export async function runTerminal(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: TerminalMainDependencies = {},
): Promise<TerminalRunResult> {
  const { stdout, stderr } = createTerminalOutput(dependencies);
  try {
    const invocation = parseTerminalArgs(argv);
    if (invocation.help) {
      stdout(HELP_TEXT);
      return { exitCode: 0, status: "help" };
    }
    const environment = resolveTerminalEnvironment(invocation, dependencies);
    assertSafeTerminalCommand(invocation, environment.source);
    const run = dependencies.run ?? runCommand;
    const migration = await handleMigration({
      invocation,
      home: environment.home,
      run,
      stdout,
    });
    if (migration !== undefined) return migration;
    const promptRoutingLogs = await handlePromptRoutingLogs({
      invocation,
      home: environment.home,
      stdout,
    });
    if (promptRoutingLogs !== undefined) return promptRoutingLogs;
    const reconciliation = await handleReconcile({ invocation, environment, run, stdout });
    if (reconciliation !== undefined) return reconciliation;
    const interaction = createTerminalInteraction(dependencies, stdout);
    try {
      return await runProjectFlow({
        invocation,
        environment,
        dependencies,
        run,
        interactive: interaction.interactive,
        prompter: interaction.prompter,
        stdout,
        closeInteraction: interaction.close,
      });
    } finally {
      interaction.close();
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    stderr(`tandem: ${message}\n`);
    return { exitCode: 1, status: "error", error: { name, message } };
  }
}

if (import.meta.main) {
  const result = await runTerminal();
  process.exitCode = result.exitCode;
}
