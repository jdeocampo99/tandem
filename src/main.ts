#!/usr/bin/env bun
import { basename, join } from "node:path";
import { runCommand } from "./adapters/commands.ts";
import type { HerdrAdapterOptions } from "./adapters/herdr.ts";
import type { HerdrFocus } from "./board/panel.ts";
import { readBoard, runLiveBoard } from "./board/read.ts";
import { readBoardSnapshot } from "./board/snapshot.ts";
import { renderStatus, renderStatusLine, type StatusStyle } from "./board/terminal.ts";
import type { TandemEnvironmentSource } from "./config/environment.ts";
import type { CommandRunner } from "./contracts.ts";
import { PANEL_ENTRYPOINT } from "./coordinator/panel.ts";
import { type ReconcileReport, reconcileTandemResources } from "./coordinator/reconcile.ts";
import { listCoordinatorRecords } from "./coordinator/registry.ts";
import { type RenestReport, renestWorkspaces } from "./coordinator/renest.ts";
import { resetCoordinators } from "./coordinator/reset.ts";
import { isTandemCheckout, TANDEM_CHECKOUT } from "./coordinator/tandem-checkout.ts";
import { terminalOpensLinks } from "./harness/omp/terminal.ts";
import { renderCatchUpCard, renderWorkstreamList } from "./memory/view.ts";
import { renderPrWatchView } from "./pr-watch/view.ts";
import { type PublishedReport, publishReport } from "./report/publish.ts";
import { diagnosticsPath, readPromptRoutingLog } from "./runtime/diagnostics.ts";
import type { TandemService, TandemServiceOptions } from "./service/controller.ts";
import { renderTaskTrace, renderTraceSummary } from "./tasks/trace.ts";
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
  panelFailureNotice,
  previousResourcesFromLaunch,
  previousResourcesNotice,
  renestWarningsFromLaunch,
  workspaceRetirementFromLaunch,
  workspaceRetirementNotice,
} from "./terminal/launch.ts";
import type { TerminalPrompt, TerminalPrompter } from "./terminal/onboarding.ts";
import { type PanelAction, runPanel, runPanelAction } from "./terminal/panel.ts";
import {
  createServiceFor,
  prepareProjects,
  readProjectStates,
  runConfigure,
  runOpenConfig,
} from "./terminal/preparation.ts";
import {
  createReadlineResources,
  type ReadlineResources,
  streamIsTTY,
  watchCloseKeys,
  writeText,
} from "./terminal/process.ts";
import {
  gitRootForPath,
  interactiveFor,
  noTtyError,
  readRegisteredProjects,
  selectProjects,
} from "./terminal/projects.ts";
import { readTandemStatus, tandemCodeVersion } from "./terminal/status.ts";
import { runWelcome } from "./terminal/welcome.ts";

const HELP_TEXT = `Tandem

Usage:
  tandem [PATH ...]        Open your projects and Tandem's own chat, where you add more projects
                           Resumes coordinator chats (--fresh starts new ones)
  tandem status [TASK_ID]  What needs you, what's running, and your PRs across projects
                           --watch keeps it live (Esc or q closes it); --line is a
                           one-line summary for Herdr's tab bar; --logs shows prompt routing
  tandem trace [TASK_ID]   What happened to a task and why; without one, quality across tasks
  tandem report            A page showing where each task's time went, opened in Lavish
                           --since DATE only tasks created since then; --no-open just writes it
  tandem watch [PR]        Your watched pull requests; with a PR link or number, watch it
                           --stop PR stops watching it
  tandem memory [NAME]     This project's workstreams; with a name, its catch-up and notes file
  tandem update            Load your latest local Tandem code into every coordinator
                           Keeps chats and tasks; --fresh starts new chats
  tandem fix               Find stale Tandem resources and offer the repair
  tandem reset             Cancel all in-progress tasks and reopen fresh coordinators
                           Keeps onboarding, settings, task history, and your files
  tandem reset --hard      Delete all Tandem state and worktrees; next run onboards from scratch
  tandem configure [PATH]  Inspect or save repository settings
  tandem config [PATH]     Open the project's settings file in $VISUAL/$EDITOR
  tandem panel             What every agent is doing, and one key to get to it
                           --popup closes on Esc or after going somewhere
  tandem panel home|prev|next
                           Go to this project's chat, or the previous or next project
  tandem welcome           Show the welcome message again

Options:
  --yes                    Skip the confirmation (fix, reset)
  --json                   Machine-readable output (status, trace, report, watch, memory, fix)
  --watch                  Redraw every 2 seconds until Esc, q, or Ctrl-C (status)
  --line                   One line: what needs you, what's running, PRs (status)
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
  /** The Tandem checkout, whose coordinator always opens; tests inject a temporary one. */
  readonly tandemCheckout?: string;
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
  if (invocation.watch) {
    await watchStatus(environment, run, stdout, dependencies);
    return result;
  }
  if (invocation.line) {
    const board = await readBoard(environment.home, () => new Date().toISOString());
    stdout(`${renderStatusLine(board)}\n`);
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
      code: await tandemCodeVersion(run, TANDEM_CHECKOUT),
      home: environment.home,
      sessionId: environment.sessionId,
    });
    stdout(
      invocation.json
        ? `${JSON.stringify({ ...status, tasks: await service.list() })}\n`
        : renderStatus(status.board, status, statusStyle(environment, dependencies)),
    );
    return result;
  } finally {
    await service.shutdown();
  }
}

/** `tandem trace` prints one task's timeline and rollup, or the rollup across every task. */
async function handleTrace({
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
  const service = createServiceFor(environment, run, dependencies);
  try {
    const [taskId] = invocation.paths;
    if (taskId !== undefined) {
      const trace = await service.trace(taskId);
      stdout(invocation.json ? `${JSON.stringify(trace)}\n` : renderTaskTrace(trace));
    } else {
      const summary = await service.traceSummary();
      stdout(invocation.json ? `${JSON.stringify(summary)}\n` : renderTraceSummary(summary));
    }
    return { exitCode: 0, status: "trace" };
  } finally {
    await service.shutdown();
  }
}

/**
 * `tandem report` writes the time report page under the Tandem home and opens it in Lavish;
 * `--json` prints the view model instead and writes nothing.
 */
async function handleReport({
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
  const service = createServiceFor(environment, run, dependencies);
  try {
    const view = await service.report(
      invocation.since === undefined ? {} : { since: invocation.since },
    );
    if (invocation.json) {
      stdout(`${JSON.stringify(view)}\n`);
    } else {
      const published = await publishReport({
        home: environment.home,
        run,
        view,
        open: !invocation.noOpen,
      });
      stdout(renderPublishedReport(published, invocation.noOpen));
    }
    return { exitCode: 0, status: "report" };
  } finally {
    await service.shutdown();
  }
}

function renderPublishedReport(published: PublishedReport, noOpen: boolean): string {
  if (published.opened) {
    const link = published.url === undefined ? "" : ` (${published.url})`;
    return `Report opened in Lavish${link}: ${published.path}\n`;
  }
  if (noOpen) return `Report written: ${published.path}\n`;
  const reason = published.openError ?? "Lavish couldn't open the page.";
  const details =
    published.openErrorDetail === undefined ? "" : `Details: ${published.openErrorDetail}\n`;
  return `Report written: ${published.path}\n${reason} Open that file in a browser.\n${details}`;
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
 * `tandem memory` lists the workstreams of the project the current directory is in; with a name it
 * shows that workstream's catch-up card and where its notes file is. It only reads.
 */
async function handleMemory({
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
  const project = await gitRootForPath(".", environment.cwd, run);
  if (project === undefined) {
    throw new Error("tandem memory runs inside a project; cd into one of your repositories");
  }
  const service = createServiceFor(environment, run, dependencies);
  try {
    const [workstream] = invocation.paths;
    const colors = statusStyle(environment, dependencies);
    // Links only where colors are on (a terminal, no NO_COLOR), and only if it opens OSC 8 links.
    const style = { ...colors, links: colors.color && terminalOpensLinks() };
    if (workstream === undefined) {
      const lines = await service.memoryList(project);
      stdout(
        invocation.json
          ? `${JSON.stringify(lines)}\n`
          : renderWorkstreamList(basename(project), lines, style),
      );
    } else {
      const shown = await service.memoryShow(project, workstream);
      stdout(
        invocation.json
          ? `${JSON.stringify(shown)}\n`
          : shown.kind === "notes"
            ? renderCatchUpCard(shown.view, style, { showPath: true })
            : `${shown.name} has no notes yet. Name it to the coordinator to start one.\n`,
      );
    }
    return { exitCode: 0, status: "memory" };
  } finally {
    await service.shutdown();
  }
}

/**
 * Colors only for a terminal that shows them: not when output is captured or piped, or `NO_COLOR`
 * is set. The width is read each time, so `--watch` follows a resized pane.
 */
function statusStyle(
  environment: TerminalEnvironment,
  dependencies: TerminalMainDependencies,
): StatusStyle {
  const output = dependencies.output ?? process.stdout;
  if (dependencies.stdout !== undefined || !streamIsTTY(output)) return { color: false };
  const columns = (output as { readonly columns?: unknown }).columns;
  return {
    color: (environment.source.NO_COLOR ?? "").length === 0,
    ...(typeof columns === "number" && columns > 0 ? { columns } : {}),
  };
}

/**
 * `tandem status --watch` redraws the status until Esc, q, or Ctrl-C, which also closes it in a
 * Herdr popup. It only reads saved state; pull requests show what PR watch last read.
 */
async function watchStatus(
  environment: TerminalEnvironment,
  run: CommandRunner,
  stdout: (text: string) => void,
  dependencies: TerminalMainDependencies,
): Promise<void> {
  const code = await tandemCodeVersion(run, TANDEM_CHECKOUT);
  const style = () => statusStyle(environment, dependencies);
  const keys = watchCloseKeys(dependencies.input ?? process.stdin);
  try {
    await runLiveBoard({
      render: async () => {
        const status = await readTandemStatus({
          code,
          home: environment.home,
          sessionId: environment.sessionId,
        });
        return renderStatus(status.board, status, style());
      },
      draw: (text) => stdout(`\x1b[H\x1b[2J${text}`),
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
      closed: keys.closed,
    });
  } finally {
    keys.release();
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

async function tandemProjectAmong(
  roots: readonly string[],
  tandemCheckout: string,
): Promise<string | undefined> {
  for (const root of roots) {
    if (await isTandemCheckout(root, tandemCheckout)) return root;
  }
  return undefined;
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
  const tandemCheckout = dependencies.tandemCheckout ?? TANDEM_CHECKOUT;
  const roots = await selectProjects(
    invocation,
    environment,
    run,
    interactive,
    prompter,
    tandemCheckout,
  );
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
    await tandemProjectAmong(roots, tandemCheckout),
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
    stdout(`Coordinators now run ${await tandemCodeVersion(run, TANDEM_CHECKOUT)}.\n`);
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
    const panelNotice = panelFailureNotice(repoPath, launch);
    if (panelNotice !== undefined) stdout(panelNotice);
  }
  return {
    exitCode: 0,
    status: "launched",
    projects: roots,
    sessionId: environment.sessionId,
    launches,
  };
}

function isPanelAction(value: string): value is PanelAction {
  return value === "home" || value === "prev" || value === "next";
}

/**
 * Where Herdr's focus is, from what Herdr hands a plugin pane, plugin action, or popup command.
 * `TANDEM_PANEL_PROJECT` names the project a coordinator opened its panel for. `TANDEM_REPO` and
 * `HERDR_WORKSPACE_ID` are not used: the Herdr server inherits the first coordinator's.
 */
function herdrFocus(environment: TerminalEnvironment): HerdrFocus {
  const source = environment.source;
  let context: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(source.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
    if (typeof parsed === "object" && parsed !== null) context = parsed as Record<string, unknown>;
  } catch {
    // No context; the active-pane variables or the directory decide.
  }
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const workspaceId = source.HERDR_ACTIVE_WORKSPACE_ID ?? text(context.workspace_id);
  return {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    cwd:
      source.TANDEM_PANEL_PROJECT ??
      text(context.focused_pane_cwd) ??
      source.HERDR_ACTIVE_PANE_CWD ??
      environment.cwd,
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
    if (invocation.command === "trace") {
      return await handleTrace({ invocation, environment, dependencies, run, stdout });
    }
    if (invocation.command === "report") {
      return await handleReport({ invocation, environment, dependencies, run, stdout });
    }
    if (invocation.command === "watch") {
      return await handleWatch({ invocation, environment, dependencies, run, stdout });
    }
    if (invocation.command === "memory") {
      return await handleMemory({ invocation, environment, dependencies, run, stdout });
    }
    if (invocation.command === "panel") {
      // Panels read only the snapshot coordinators write, never the state, so they take no lock.
      const [action] = invocation.paths;
      if (action !== undefined) {
        if (!isPanelAction(action)) {
          throw new Error(`tandem panel takes home, prev, or next; received ${action}`);
        }
        const failure = await runPanelAction(action, {
          readSnapshot: () => readBoardSnapshot(environment.home),
          run,
          sessionId: environment.sessionId,
          focus: herdrFocus(environment),
          cwd: environment.cwd,
        });
        if (failure !== undefined) stderr(`${failure}\n`);
        return { exitCode: failure === undefined ? 0 : 1, status: "panel" };
      }
      const output = dependencies.output ?? process.stdout;
      const keysSeen = join(environment.home, "panel-keys-seen");
      await runPanel({
        input: dependencies.input ?? process.stdin,
        write: stdout,
        size: () => output as { columns?: number; rows?: number },
        color: streamIsTTY(output) && (environment.source.NO_COLOR ?? "").length === 0,
        clock: () => new Date(),
        readSnapshot: () => readBoardSnapshot(environment.home),
        run,
        sessionId: environment.sessionId,
        cwd: environment.cwd,
        focus: herdrFocus(environment),
        popup: invocation.popup,
        helpUnseen: !(await Bun.file(keysSeen).exists()),
        rememberHelpSeen: () => Bun.write(keysSeen, "").then(() => undefined),
        onExitSignal: (stop) => {
          process.once("SIGTERM", stop);
          process.once("SIGHUP", stop);
          return () => {
            process.off("SIGTERM", stop);
            process.off("SIGHUP", stop);
          };
        },
        paneId:
          !invocation.popup && environment.source.HERDR_PLUGIN_ENTRYPOINT_ID === PANEL_ENTRYPOINT
            ? environment.source.HERDR_PANE_ID
            : undefined,
        onResize: (resized) => {
          output.on("resize", resized);
          return () => output.off("resize", resized);
        },
      });
      return { exitCode: 0, status: "panel" };
    }
    if (invocation.command === "welcome") {
      await runWelcome({
        input: dependencies.input ?? process.stdin,
        stdout,
        run,
        environment: environment.source,
        cwd: environment.cwd,
      });
      return { exitCode: 0, status: "welcome" };
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
