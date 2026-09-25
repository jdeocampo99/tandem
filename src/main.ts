#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./adapters/commands.ts";
import type { HerdrAdapterOptions } from "./adapters/herdr.ts";
import { listOmpMcpServers } from "./adapters/omp.ts";
import type { TandemEnvironmentSource } from "./config/environment.ts";
import type { CommandRunner } from "./contracts.ts";
import { type ReconcileReport, reconcileTandemResources } from "./coordinator/reconcile.ts";
import { listCoordinatorRecords } from "./coordinator/registry.ts";
import { type RenestReport, renestWorkspaces } from "./coordinator/renest.ts";
import { resetCoordinators } from "./coordinator/reset.ts";
import { renderPrWatchView } from "./pr-watch/view.ts";
import { diagnosticsPath, readPromptRoutingLog } from "./runtime/diagnostics.ts";
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
  fixCleanupCount,
  NO_FIX_DETAILS,
  readFixDetails,
  renderFixReport,
  renderFixReportVerbose,
  renderRenest,
} from "./terminal/fix-report.ts";
import { applyHardReset, planHardReset, renderHardResetPlan } from "./terminal/hard-reset.ts";
import {
  hasActiveHerdrContext,
  launchProjects,
  otherSessionReconciliationNotices,
  previousResourcesFromLaunch,
  previousResourcesNotice,
  renestWarningsFromLaunch,
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
import { readTandemStatus, renderTandemStatus, tandemCodeVersion } from "./terminal/status.ts";

/** The checkout the `tandem` command runs from; coordinators load their extension from it. */
const TANDEM_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELP_TEXT = `Tandem

Usage:
  tandem [PATH ...]        Open your projects; resumes coordinator chats (--fresh starts new ones)
  tandem status [TASK_ID]  What's running and what needs you; --logs shows prompt routing
  tandem watch [PR]        Your watched pull requests; with a PR link or number, watch it
                           --stop PR stops watching it
  tandem update            Load your latest local Tandem code into every coordinator
                           Keeps chats and tasks; --fresh starts new chats
  tandem fix               Find stale Tandem resources and offer the repair
  tandem reset             Cancel all in-progress tasks and reopen fresh coordinators
                           Keeps onboarding, settings, task history, and your files
  tandem reset --hard      Delete all Tandem state and worktrees; next run onboards from scratch
  tandem configure [PATH]  Inspect or save repository settings
  tandem config [PATH]     Open the project's settings file in $VISUAL/$EDITOR

Options:
  --yes                    Skip the confirmation (fix, reset)
  --json                   Machine-readable output (status, watch, fix)
  --verbose                Full paths and reasons (fix)
  --free-superseded        With --yes, also free worktrees whose work is in other tasks (fix)
  --home PATH              Use a different Tandem home
`;

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
  /** Lists a project's MCP servers for onboarding; tests inject one so they never read real config. */
  readonly listMcpServers?: (repoPath: string) => Promise<readonly string[]>;
  /** Sends Herdr's `workspace.move`; tests inject one so they never reach a live socket. */
  readonly moveWorkspace?: HerdrAdapterOptions["moveWorkspace"];
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

/**
 * Update and reset close coordinator panes, so they must not run inside one: the command
 * would close the pane it is running in. Any other Herdr pane is fine.
 */
async function assertNotInCoordinatorPane(
  invocation: TerminalInvocation,
  environment: TerminalEnvironment,
): Promise<void> {
  if (invocation.command !== "update" && invocation.command !== "reset") return;
  if (!hasActiveHerdrContext(environment.source)) return;
  const paneId = environment.source.HERDR_PANE_ID;
  const records = await listCoordinatorRecords(environment.home, environment.sessionId);
  if (records.some((record) => record.endpoint.paneId === paneId)) {
    throw new Error(
      `tandem ${invocation.command} would close the coordinator pane it is running in; run it from another pane or terminal`,
    );
  }
}

/**
 * Asks a yes/no question. `--yes` answers it, unless the question needs its own flag too: then
 * `--yes` alone answers no, so one consent never stands in for another.
 */
async function confirm(
  question: string,
  invocation: TerminalInvocation,
  interaction: TerminalInteraction,
  extraFlag?: Readonly<{ readonly given: boolean; readonly spelling: string }>,
): Promise<boolean> {
  if (invocation.yes) return extraFlag === undefined || extraFlag.given;
  if (!interaction.interactive || interaction.prompter === undefined) {
    const flags = extraFlag === undefined ? "--yes" : `--yes ${extraFlag.spelling}`;
    throw new Error(`${question} Rerun with ${flags} to confirm without a terminal prompt.`);
  }
  const answer = await interaction.prompter.ask(question, {
    choices: [
      { name: "No", value: "no" },
      { name: "Yes", value: "yes" },
    ],
    default: "no",
  });
  return answer.trim().toLowerCase() === "yes";
}

async function handleStatus({
  invocation,
  environment,
  dependencies,
  run,
  stdout,
}: Readonly<{
  readonly invocation: TerminalInvocation;
  readonly environment: TerminalEnvironment;
  readonly dependencies: TerminalMainDependencies;
  readonly run: CommandRunner;
  readonly stdout: (text: string) => void;
}>): Promise<TerminalRunResult> {
  const result: TerminalRunResult = { exitCode: 0, status: "status" };
  if (invocation.logs) {
    const lines = await readPromptRoutingLog(environment.home);
    if (invocation.json) {
      stdout(`${JSON.stringify(lines.map((line) => JSON.parse(line)))}\n`);
    } else {
      stdout(`Tandem prompt-routing log: ${diagnosticsPath(environment.home)}\n`);
      stdout(lines.length === 0 ? "No prompt-routing events recorded.\n" : `${lines.join("\n")}\n`);
    }
    return result;
  }
  const service = createServiceFor(environment, run, dependencies);
  try {
    const [taskId] = invocation.paths;
    if (taskId !== undefined) {
      const details = await service.inspect(taskId);
      stdout(`${invocation.json ? JSON.stringify(details) : JSON.stringify(details, null, 2)}\n`);
      return result;
    }
    const status = await readTandemStatus({
      run,
      tandemRoot: TANDEM_ROOT,
      home: environment.home,
      sessionId: environment.sessionId,
      service,
    });
    stdout(invocation.json ? `${JSON.stringify(status)}\n` : renderTandemStatus(status));
    return result;
  } finally {
    await service.shutdown();
  }
}

/**
 * `tandem watch` shows the PR watch view after reading GitHub; with a pull request it starts
 * watching it, or with --stop stops. `#N` means a pull request in the current directory's repo.
 */
async function handleWatch({
  invocation,
  environment,
  dependencies,
  run,
  stdout,
}: Readonly<{
  readonly invocation: TerminalInvocation;
  readonly environment: TerminalEnvironment;
  readonly dependencies: TerminalMainDependencies;
  readonly run: CommandRunner;
  readonly stdout: (text: string) => void;
}>): Promise<TerminalRunResult> {
  const [pullRequest] = invocation.paths;
  if (invocation.stop && pullRequest === undefined) {
    throw new Error("tandem watch --stop needs the pull request to stop watching");
  }
  const service = createServiceFor(environment, run, dependencies);
  try {
    const input = { pullRequest: pullRequest ?? "", repoPath: environment.cwd };
    const view =
      pullRequest === undefined
        ? await service.prWatch()
        : invocation.stop
          ? await service.prWatchStop(input)
          : await service.prWatchStart(input);
    stdout(invocation.json ? `${JSON.stringify(view)}\n` : renderPrWatchView(view));
    return { exitCode: 0, status: "watch" };
  } finally {
    await service.shutdown();
  }
}

/**
 * One place to go when something is wrong: reconciles stale resources. Each step shows its plan
 * and changes nothing until confirmed. A resource Tandem deliberately retained or quarantined is
 * a reported outcome, not a failure, so only a scan or apply that could not finish exits non-zero.
 */
/** Re-nests task workspaces under their coordinators; display-only, so it needs no consent. */
function renest(
  run: CommandRunner,
  environment: TerminalEnvironment,
  dependencies: TerminalMainDependencies,
): Promise<RenestReport> {
  return renestWorkspaces(
    run,
    {
      home: environment.home,
      sessionId: environment.sessionId,
      cwd: environment.cwd,
      apply: true,
    },
    dependencies.moveWorkspace === undefined ? {} : { moveWorkspace: dependencies.moveWorkspace },
  );
}

async function handleFix({
  invocation,
  environment,
  dependencies,
  run,
  interaction,
  stdout,
}: Readonly<{
  readonly invocation: TerminalInvocation;
  readonly environment: TerminalEnvironment;
  readonly dependencies: TerminalMainDependencies;
  readonly run: CommandRunner;
  readonly interaction: TerminalInteraction;
  readonly stdout: (text: string) => void;
}>): Promise<TerminalRunResult> {
  const reconcile = (apply: boolean, freeSuperseded: boolean) =>
    readRegisteredProjects(environment.home).then((repoPaths) =>
      reconcileTandemResources({
        run,
        home: environment.home,
        poolRoot: environment.poolRoot,
        repoPaths,
        apply,
        discard: false,
        freeSuperseded,
      }),
    );
  const details = invocation.json ? NO_FIX_DETAILS : await readFixDetails(environment.home);
  const show = (shown: ReconcileReport) => {
    if (invocation.json) return;
    stdout(invocation.verbose ? renderFixReportVerbose(shown) : renderFixReport(shown, details));
  };
  // Re-nesting only reorders Tandem's own workspaces in the sidebar, so it runs before any question.
  const renested = await renest(run, environment, dependencies);
  let report = await reconcile(invocation.yes, invocation.yes && invocation.freeSuperseded);
  show(report);
  if (!invocation.json) stdout(renderRenest(renested, details));
  if (report.mode === "dry-run") {
    const count = fixCleanupCount(report, details);
    const clean =
      report.cleaned.length === 0 ||
      (await confirm(`Clean up ${count} thing${count === 1 ? "" : "s"}?`, invocation, interaction));
    const freeable = report.freeable.length;
    // Freeing is its own consent: asked separately, and never implied by approving cleanup.
    const free =
      clean &&
      freeable > 0 &&
      (await confirm(
        `Also free ${freeable} worktree${freeable === 1 ? "" : "s"} whose work is in other tasks?`,
        invocation,
        interaction,
        { given: invocation.freeSuperseded, spelling: "--free-superseded" },
      ));
    if (clean && (report.cleaned.length > 0 || free)) {
      report = await reconcile(true, free);
      show(report);
    }
  }
  if (invocation.json) stdout(`${JSON.stringify({ ...report, renest: renested })}\n`);
  return {
    exitCode: report.failed.length === 0 ? 0 : 1,
    status: "fixed",
    reconciliation: report,
  };
}

async function handleHardReset({
  invocation,
  environment,
  dependencies,
  run,
  interaction,
  stdout,
}: Readonly<{
  readonly invocation: TerminalInvocation;
  readonly environment: TerminalEnvironment;
  readonly dependencies: TerminalMainDependencies;
  readonly run: CommandRunner;
  readonly interaction: TerminalInteraction;
  readonly stdout: (text: string) => void;
}>): Promise<TerminalRunResult> {
  const plan = await planHardReset(environment);
  stdout(renderHardResetPlan(plan));
  if (!(await confirm("Delete all of it?", invocation, interaction))) {
    stdout("Tandem reset cancelled; nothing was deleted.\n");
    return { exitCode: 0, status: "cancelled" };
  }
  await applyHardReset(plan, environment, run, stdout, dependencies.resetCoordinators);
  return { exitCode: 0, status: "reset" };
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
  const prepared = await prepareProjects(
    states,
    environment,
    service,
    prompter,
    interactive,
    dependencies.listMcpServers ?? listOmpMcpServers,
  );
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
  if (invocation.command === "reset") {
    const stopped = await (dependencies.resetCoordinators ?? resetCoordinators)(run, {
      home: environment.home,
      sessionId: environment.sessionId,
      repoPaths: roots,
      force: true,
    });
    stdout(
      `Tandem reset stopped ${stopped.length} coordinator${stopped.length === 1 ? "" : "s"} and cancelled in-progress tasks.\n`,
    );
    for (const record of stopped) {
      const notice = workspaceRetirementNotice(record.repoPath, record.workspaceRetirement);
      if (notice !== undefined) stdout(notice);
    }
  }
  // A new coordinator workspace lands at the end of the sidebar, so put each project's tasks back
  // under it, and say why whenever that could not happen. This runs before Herdr is attached.
  const renestAfterLaunches = async (launched: readonly unknown[]) => {
    const final = await renest(run, environment, dependencies);
    const warnings = new Set([...launched.flatMap(renestWarningsFromLaunch), ...final.warnings]);
    for (const warning of warnings) {
      stdout(`Tandem left some task workspaces where they were: ${warning}\n`);
    }
  };
  const launches = await launchProjects(
    roots,
    invocation,
    environment,
    dependencies,
    service,
    run,
    renestAfterLaunches,
  );
  stdout(
    `Tandem prepared ${roots.length} project${roots.length === 1 ? "" : "s"} in shared Herdr session ${environment.sessionId}.\n`,
  );
  if (invocation.command === "update") {
    stdout(`Coordinators now run ${await tandemCodeVersion(run, TANDEM_ROOT)}.\n`);
  }
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
    const run = dependencies.run ?? runCommand;
    if (invocation.command === "status") {
      return await handleStatus({ invocation, environment, dependencies, run, stdout });
    }
    if (invocation.command === "watch") {
      return await handleWatch({ invocation, environment, dependencies, run, stdout });
    }
    await assertNotInCoordinatorPane(invocation, environment);
    const interaction = createTerminalInteraction(dependencies, stdout);
    try {
      if (invocation.command === "fix") {
        return await handleFix({
          invocation,
          environment,
          dependencies,
          run,
          interaction,
          stdout,
        });
      }
      if (invocation.command === "reset" && invocation.hard) {
        return await handleHardReset({
          invocation,
          environment,
          dependencies,
          run,
          interaction,
          stdout,
        });
      }
      if (
        invocation.command === "reset" &&
        !(await confirm(
          "Cancel every in-progress task and reopen fresh coordinators?",
          invocation,
          interaction,
        ))
      ) {
        stdout("Tandem reset cancelled; nothing was changed.\n");
        return { exitCode: 0, status: "cancelled" };
      }
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
