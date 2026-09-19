#!/usr/bin/env bun
import { runCommand } from "./adapters/commands.ts";
import type { TandemEnvironmentSource } from "./config/environment.ts";
import type { CommandRunner } from "./contracts.ts";
import { resetCoordinators } from "./coordinator/reset.ts";
import type { TandemService, TandemServiceOptions } from "./service/controller.ts";
import { parseTerminalArgs, type TerminalRunResult } from "./terminal/arguments.ts";
import type { CliApplication, CliDependencies } from "./terminal/cli-application.ts";
import type { RunInteractive } from "./terminal/cli-process.ts";
import { resolveTerminalEnvironment } from "./terminal/environment.ts";
import { hasActiveHerdrContext, launchProjects } from "./terminal/launch.ts";
import type { TerminalPrompt, TerminalPrompter } from "./terminal/onboarding.ts";
import {
  createServiceFor,
  prepareProjects,
  readProjectStates,
  runConfigure,
} from "./terminal/preparation.ts";
import { createReadlineResources, type ReadlineResources, writeText } from "./terminal/process.ts";
import { interactiveFor, noTtyError, selectProjects } from "./terminal/projects.ts";

const HELP_TEXT = `Tandem\n\nUsage:\n  tandem [PATH ...]              Open or reconnect project coordinators\n  tandem --restart [PATH ...]    Replace owned coordinators without cancelling managed work\n  tandem --reset [PATH ...]      Stop idle Tandem coordinators, then reopen them\n  tandem --reset --force [PATH ...]  Cancel selected active work, then reopen coordinators\n  tandem configure [PATH]        Choose and save all six global role models\n  tandem --help                  Show this help\n\nWith no PATH for a launch, Tandem opens all saved projects under ~/.tandem/repositories. If no projects\nare saved, it opens the current Git project; outside a Git project it offers registered projects or an\nexplicit path. Explicit PATH values override the saved registry and select only those projects. Multiple\nPATH values share one Herdr session and are attached once after every coordinator is ready.\n\n--restart replaces selected owned coordinators in a fresh owned pane while retaining the saved coordinator\nconversation, task IDs and generations, worker/presentation panes, worktrees, reports, messages, and pending\nquestions. Ownership is proven before any old pane is closed; ambiguous or foreign panes are refused.\nRestart does not resurrect cancelled or completed tasks. Run it from a separate normal terminal. The\ncoordinator's /tandem restart TASK_ID action restarts one managed worker through its durable bridge.\n\n--reset applies only to the selected Tandem coordinators: with no PATH it selects all saved projects,\nand explicit PATH values select only that subset. It stops and reopens idle owned coordinators while\nretaining settings, conversation history, task records, worktrees, and repository files. Preflight refuses\nbusy, unknown, foreign, or unsafe coordinators before any pane closes. A later race or native close failure\ncan leave a partial reset; errors identify already-stopped projects. Reset never recovers tasks or wipes data.\n--reset --force additionally cancels selected active owned work and terminates its workers, validation,\npresentations, and coordinators before reopening them. It preserves settings, conversation history, task\nrecords, worktrees, and repository files; it never deletes projects or data. Force reset still refuses\nunknown, foreign, or unsafe ownership and must run from a separate normal terminal, not from inside Herdr.\nRun it from a separate normal terminal, not from inside Herdr. Add --continue only to resume each saved\nconversation; without it, the reopened coordinators start fresh conversations.\n\nThe configure command always uses one project as its catalogue anchor; with no PATH it keeps the\ncurrent-Git or interactive one-project flow and never expands to all saved projects.\n\nOptions:\n  --reset                       Reopen only selected idle Tandem coordinators (launch only)\n  --restart                     Replace selected owned coordinators without cancelling work\n  --force                       Cancel selected active owned work during --reset (launch only)\n  --home PATH                    Tandem durable home (default: TANDEM_HOME or ~/.tandem)\n  --session ID                  Shared Herdr/OMP session (default: TANDEM_SESSION or tandem)\n  --pool-root PATH               Private Treehouse pool (default: <home>/pool)\n  --continue                    Resume each project's coordinator conversation\n  --headless                    Prepare coordinators without attaching Herdr\n  --no-attach                   Do not attach Herdr after preparing coordinators\n\nThe first setup asks explicitly for a catalogue-backed model and thinking level for each of the six\nroles. Blank answers, cancellation, or declining the recap never chooses a default and never launches.\nGlobal choices are saved only in <home>/models.json; project settings are saved only in\n<home>/repositories/<key>/config.json. Neither operation changes application files.\n`;

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

/** Runs the shared-session terminal front door and returns a process-style result. */
export async function runTerminal(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: TerminalMainDependencies = {},
): Promise<TerminalRunResult> {
  const outputStream = dependencies.output ?? process.stdout;
  const errorStream = dependencies.errorOutput ?? process.stderr;
  const stdout = dependencies.stdout ?? ((text: string) => writeText(outputStream, text));
  const stderr = dependencies.stderr ?? ((text: string) => writeText(errorStream, text));
  try {
    const invocation = parseTerminalArgs(argv);
    if (invocation.help) {
      stdout(HELP_TEXT);
      return { exitCode: 0, status: "help" };
    }
    const environment = resolveTerminalEnvironment(invocation, dependencies);
    if ((invocation.reset || invocation.restart) && hasActiveHerdrContext(environment.source)) {
      const command = invocation.restart ? "--restart" : "--reset";
      throw new Error(
        `tandem ${command} cannot run from inside Herdr; rerun it from a separate normal terminal`,
      );
    }
    const run = dependencies.run ?? runCommand;
    const input = dependencies.input ?? process.stdin;
    const output = dependencies.output ?? process.stdout;
    const interactive = interactiveFor(dependencies, input, output);
    let resources: ReadlineResources | undefined;
    let prompter: TerminalPrompter | undefined;
    if (dependencies.prompt !== undefined) {
      prompter = { ask: dependencies.prompt, write: stdout };
    } else if (interactive) {
      resources = createReadlineResources(input, output);
      prompter = resources.prompter;
    }
    try {
      const roots = await selectProjects(invocation, environment, run, interactive, prompter);
      if (roots === undefined) {
        stdout("Tandem cancelled; no settings were changed and no coordinator was launched.\n");
        return { exitCode: 0, status: "cancelled" };
      }
      if (roots.length === 0) throw new Error("no projects were selected");
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
      resources?.close();
      resources = undefined;
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
      }
      const launches = await launchProjects(
        roots,
        invocation,
        environment,
        dependencies,
        service,
        run,
      );
      stdout(
        `Tandem prepared ${roots.length} project${roots.length === 1 ? "" : "s"} in shared Herdr session ${environment.sessionId}.\n`,
      );
      return {
        exitCode: 0,
        status: "launched",
        projects: roots,
        sessionId: environment.sessionId,
        launches,
      };
    } finally {
      resources?.close();
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
