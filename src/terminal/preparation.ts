import { access } from "node:fs/promises";
import { centralConfigPath, resolveRepoPolicy } from "../config/repositories.ts";
import type { CommandRunner, RepoPolicy } from "../contracts.ts";
import {
  createTandemService,
  type TandemService,
  type TandemServiceOptions,
} from "../service/controller.ts";
import type { TerminalRunResult } from "./arguments.ts";
import type { RunInteractive } from "./cli-process.ts";
import type { TerminalEnvironment } from "./environment.ts";
import {
  askCoordinatorMcpServers,
  askProjectSettingsApproval,
  runModelOnboarding,
  type TerminalPrompter,
} from "./onboarding.ts";
import { noTtyError } from "./projects.ts";

export type ProjectState = Readonly<{
  readonly repoPath: string;
  readonly existingConfig: boolean;
  readonly configPath: string;
  readonly modelSettings: Readonly<{
    readonly configured: boolean;
    readonly models?: RepoPolicy["models"];
  }>;
}>;

export function createServiceFor(
  environment: TerminalEnvironment,
  run: CommandRunner,
  dependencies: Readonly<{
    readonly service?: TandemService;
    readonly createService?: (options: TandemServiceOptions) => TandemService;
  }>,
): TandemService {
  if (dependencies.service !== undefined) return dependencies.service;
  return (dependencies.createService ?? createTandemService)({
    home: environment.home,
    sessionId: environment.sessionId,
    poolRoot: environment.poolRoot,
    run,
  });
}

export async function readProjectStates(
  roots: readonly string[],
  service: TandemService,
): Promise<readonly ProjectState[]> {
  const states: ProjectState[] = [];
  for (const repoPath of roots) {
    const onboarding = await service.onboard(repoPath, false);
    states.push({
      repoPath,
      existingConfig: onboarding.existingConfig,
      configPath: onboarding.configPath,
      modelSettings: onboarding.modelSettings,
    });
  }
  return states;
}

function firstModelSettings(
  states: readonly ProjectState[],
): Readonly<{ configured: boolean; models?: RepoPolicy["models"] }> {
  const settings = states[0]?.modelSettings;
  if (settings === undefined) throw new Error("Tandem could not inspect the selected project");
  return settings;
}

export async function runConfigure(
  roots: readonly string[],
  environment: TerminalEnvironment,
  service: TandemService,
  prompter: TerminalPrompter,
  output: (text: string) => void,
): Promise<TerminalRunResult> {
  const anchor = roots[0];
  if (anchor === undefined)
    throw new Error("configure needs a project path or one registered project");
  const modelOptions = await service.models(anchor);
  const modelSettings = modelOptions.modelSettings;
  const decision = await runModelOnboarding({
    mode: modelSettings.configured ? "saved" : "first",
    availableModels: modelOptions.availableModels,
    ...(modelSettings.models === undefined ? {} : { currentModels: modelSettings.models }),
    enabledProviders: modelSettings.enabledProviders,
    jev: modelSettings.jev,
    environment: environment.source,
    prompter,
    home: environment.home,
  });
  if (decision.status === "cancelled" || decision.models === undefined) {
    return {
      exitCode: 0,
      status: "cancelled",
      projects: roots,
      sessionId: environment.sessionId,
    };
  }
  if (
    decision.action === "save" ||
    decision.action === "change" ||
    decision.jev !== modelSettings.jev
  ) {
    await service.configureModels({
      repoPath: anchor,
      models: decision.models,
      ...(decision.enabledProviders === undefined
        ? {}
        : { enabledProviders: decision.enabledProviders }),
      ...(decision.jev === undefined ? {} : { jev: decision.jev }),
    });
  }
  output(
    decision.action === "keep"
      ? "Saved role choices kept; no coordinator was launched.\n"
      : `Saved role choices in ${environment.home}/models.json; no coordinator was launched.\n`,
  );
  return {
    exitCode: 0,
    status: "configured",
    projects: roots,
    sessionId: environment.sessionId,
  };
}

/**
 * Opens a project's central settings file in $VISUAL/$EDITOR, then re-reads it so a typo is
 * reported now rather than at the next launch. Without an editor it falls back to macOS `open -t`,
 * which returns before the file is saved, so there is nothing to re-read.
 */
export async function runOpenConfig(
  root: string,
  environment: TerminalEnvironment,
  runInteractive: RunInteractive,
  output: (text: string) => void,
): Promise<TerminalRunResult> {
  const configPath = await centralConfigPath(root, environment.home);
  try {
    await access(configPath);
  } catch {
    throw new Error(
      `${root} has no Tandem settings yet; run \`tandem ${root}\` to set it up first`,
    );
  }
  output(`Tandem settings for ${root}: ${configPath}\n`);
  const editor = (environment.source.VISUAL ?? environment.source.EDITOR ?? "").trim();
  if (editor.length === 0) {
    await runInteractive({ argv: ["open", "-t", configPath], cwd: root });
    return { exitCode: 0, status: "configured", projects: [root] };
  }
  // The editor value may carry its own arguments (e.g. "code --wait"), so the shell splits it.
  const exit = await runInteractive({
    argv: ["/bin/sh", "-c", `${editor} "$1"`, "sh", configPath],
    cwd: root,
  });
  if (exit !== 0) throw new Error(`editor exited with code ${exit}`);
  try {
    await resolveRepoPolicy({ repoPath: root, home: environment.home });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`the settings file has a problem: ${message}. Run \`tandem config\` to fix it`);
  }
  output(
    "Settings are valid. New tasks use them; running tasks keep the settings they started with.\n",
  );
  return { exitCode: 0, status: "configured", projects: [root] };
}

/**
 * Asks for model choices and each new project's settings before launch. The Tandem checkout opens
 * without saved settings, so its coordinator can onboard the other projects in chat.
 */
export async function prepareProjects(
  states: readonly ProjectState[],
  environment: TerminalEnvironment,
  service: TandemService,
  prompter: TerminalPrompter | undefined,
  interactive: boolean,
  listMcpServers: (repoPath: string) => Promise<readonly string[]>,
  tandemProject: string | undefined,
): Promise<readonly ProjectState[] | undefined> {
  const settings = firstModelSettings(states);
  const needsSettings = (state: ProjectState) =>
    !state.existingConfig && state.repoPath !== tandemProject;
  const needsNewProjectChoice = states.some(needsSettings);
  if (!settings.configured || needsNewProjectChoice) {
    if (!interactive || prompter === undefined) throw noTtyError("Tandem onboarding");
    const anchor = states[0];
    if (anchor === undefined) throw new Error("Tandem could not inspect the selected project");
    const modelOptions = await service.models(anchor.repoPath);
    const decision = await runModelOnboarding({
      mode: settings.configured ? "saved" : "first",
      availableModels: modelOptions.availableModels,
      ...(settings.models === undefined ? {} : { currentModels: settings.models }),
      enabledProviders: modelOptions.modelSettings.enabledProviders,
      jev: modelOptions.modelSettings.jev,
      environment: environment.source,
      prompter,
      home: environment.home,
    });
    if (decision.status === "cancelled" || decision.models === undefined) return undefined;
    if (
      decision.action === "save" ||
      decision.action === "change" ||
      decision.jev !== modelOptions.modelSettings.jev
    ) {
      await service.configureModels({
        repoPath: anchor.repoPath,
        models: decision.models,
        ...(decision.enabledProviders === undefined
          ? {}
          : { enabledProviders: decision.enabledProviders }),
        ...(decision.jev === undefined ? {} : { jev: decision.jev }),
      });
    }
  }

  for (const state of states) {
    if (!needsSettings(state)) continue;
    if (!interactive || prompter === undefined) throw noTtyError("project settings approval");
    const approved = await askProjectSettingsApproval(prompter, state.repoPath, state.configPath);
    if (!approved) return undefined;
    const servers = await askCoordinatorMcpServers(prompter, await listMcpServers(state.repoPath));
    if (servers === undefined) return undefined;
    await service.onboard(state.repoPath, true, servers);
  }
  return states;
}
