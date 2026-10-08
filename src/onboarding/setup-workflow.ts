import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { HomeSettings, SelfImprovementMode } from "../config/home-settings.ts";
import type { ModelSettings } from "../config/models.ts";
import type { Clock, CommandRunner, RepoPolicy } from "../contracts.ts";
import type { ClaudeCodeAvailability } from "../harness/claude-code/availability.ts";
import type { ModelRecord } from "../harness/contract.ts";
import { expandHome, findCheckoutsByName, listCheckouts } from "../repos/locate.ts";
import {
  checkSetupAnswer,
  type SetupAnswer,
  type SetupAnswerRepo,
  type SetupRepoCheck,
  setupProviders,
} from "./setup-answer.ts";
import {
  buildSetupView,
  type SetupMode,
  type SetupRepoDetails,
  type SetupRepoFacts,
  type SetupView,
  setupCatalogue,
} from "./setup-view.ts";

/**
 * The setup block's effects: gathering what the view shows and applying one validated answer. The
 * decisions (the view and the answer's checks) are pure and live beside this file.
 */
export type SetupWorkflowDependencies = Readonly<{
  /** The user's home folder, shown as `~`. */
  homeFolder: string;
  run: CommandRunner;
  clock: Clock;
  models: (repoPath: string) => Promise<
    Readonly<{
      availableModels: readonly ModelRecord[];
      modelSettings: ModelSettings;
      claudeCode: ClaudeCodeAvailability;
    }>
  >;
  roots: () => Promise<readonly string[]>;
  homeSettings: () => Promise<HomeSettings>;
  registeredProjects: () => Promise<readonly string[]>;
  /** Read-only discovery for one checkout not yet set up. */
  inspectRepo: (path: string) => Promise<SetupRepoDetails>;
  saveModels: (
    input: Readonly<{
      repoPath: string;
      models: RepoPolicy["models"];
      enabledProviders: readonly string[];
    }>,
  ) => Promise<unknown>;
  saveSelfImprovement: (mode: SelfImprovementMode) => Promise<unknown>;
  saveCodeFolders: (folders: readonly string[]) => Promise<unknown>;
  setupRepo: (
    path: string,
    repo: Readonly<{
      validationCommands?: readonly string[] | undefined;
      setupCommands?: readonly string[] | undefined;
      noChecks: boolean;
    }>,
  ) => Promise<unknown>;
  /**
   * Replaces the commands of a repository that is already set up, and sets or clears its "no
   * checks"; a setup list left undefined stays.
   */
  updateRepoCommands: (
    path: string,
    commands: Readonly<{
      validationCommands: readonly string[];
      setupCommands?: readonly string[] | undefined;
      noChecks: boolean;
    }>,
  ) => Promise<unknown>;
  openProject: (path: string) => Promise<unknown>;
}>;

/** `opened` names the repositories whose chats are open after the save. */
export type SetupApplyResult = Readonly<{
  message: string;
  complete: boolean;
  opened: readonly string[];
}>;

/** What the coordinator is told, in fixed words, after the setup block saved an answer. */
export function setupSavedMessage(mode: SetupMode, result: SetupApplyResult): string {
  if (!result.complete) return `Setup was saved with problems:\n${result.message}`;
  if (mode === "settings") return "Settings saved. New tasks will use them.";
  const opened = listNames(result.opened);
  return `Setup saved. ${opened === "" ? "" : `Chats for ${opened} are open in the sidebar.`}`.trim();
}

function listNames(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

type SetupFacts = Readonly<{
  ompCatalogue: readonly ModelRecord[];
  claudeCode: ClaudeCodeAvailability;
  /** Every model a role may be set to here, which the answer is checked against. */
  catalogue: readonly ModelRecord[];
  modelSettings: ModelSettings;
  settings: HomeSettings;
  roots: readonly string[];
  checkouts: readonly Readonly<{ path: string; repo?: string }>[];
  registered: ReadonlySet<string>;
}>;

export class SetupWorkflow {
  readonly #deps: SetupWorkflowDependencies;

  constructor(deps: SetupWorkflowDependencies) {
    this.#deps = deps;
  }

  private async facts(repoPath: string): Promise<SetupFacts> {
    const [models, settings, roots, registered] = await Promise.all([
      this.#deps.models(repoPath),
      this.#deps.homeSettings(),
      this.#deps.roots(),
      this.#deps.registeredProjects(),
    ]);
    return {
      ompCatalogue: models.availableModels,
      claudeCode: models.claudeCode,
      catalogue: setupCatalogue(models.availableModels, models.claudeCode),
      modelSettings: models.modelSettings,
      settings,
      roots,
      checkouts: await listCheckouts(roots, this.#deps.run),
      registered: new Set(registered),
    };
  }

  async view(repoPath: string, mode: SetupMode): Promise<SetupView> {
    const facts = await this.facts(repoPath);
    const repos: SetupRepoFacts[] = await Promise.all(
      facts.checkouts.map(async (checkout) => {
        const setUp = facts.registered.has(checkout.path);
        try {
          return { ...checkout, setUp, details: await this.#deps.inspectRepo(checkout.path) };
        } catch (error) {
          const inspectionError = error instanceof Error ? error.message : String(error);
          return { ...checkout, setUp, inspectionError };
        }
      }),
    );
    const saved = facts.modelSettings;
    return buildSetupView({
      mode,
      generatedAt: this.#deps.clock(),
      homeFolder: this.#deps.homeFolder,
      ompCatalogue: facts.ompCatalogue,
      claudeCode: facts.claudeCode,
      ...(saved.configured && saved.models !== undefined ? { savedModels: saved.models } : {}),
      repos,
      ...(facts.settings.selfImprovementChosen
        ? { selfImprovement: facts.settings.selfImprovement }
        : {}),
    });
  }

  private async checkRepo(path: string, registered: ReadonlySet<string>): Promise<SetupRepoCheck> {
    const [found] = await findCheckoutsByName(path, [], this.#deps.run).catch(() => []);
    if (found === undefined) return { kind: "not-a-repo" };
    const named = await realpath(resolve(expandHome(path))).catch(() => undefined);
    if (named !== found.path) return { kind: "inside", root: found.path };
    return {
      kind: "root",
      root: found.path,
      setUp: registered.has(found.path),
    };
  }

  /**
   * Record the folders holding the discovered checkouts, and any selected checkout's parent, on
   * first setup. Once roots are saved, setup leaves them alone.
   */
  private async codeFoldersToSave(
    facts: SetupFacts,
    selected: readonly SetupAnswerRepo[],
    checked: ReadonlyMap<string, SetupRepoCheck>,
  ): Promise<readonly string[]> {
    if (facts.settings.projectRoots.length > 0) return [];
    const folders: string[] = [];
    for (const root of facts.roots) {
      const real = await realpath(resolve(expandHome(root))).catch(() => undefined);
      if (real === undefined) continue;
      const holds = facts.checkouts.some((checkout) => checkout.path.startsWith(`${real}/`));
      if (holds && !folders.includes(real)) folders.push(real);
    }
    for (const repo of selected) {
      const match = checked.get(repo.path);
      if (match?.kind !== "root") continue;
      if (folders.some((folder) => match.root.startsWith(`${folder}/`))) continue;
      const parent = dirname(match.root);
      if (!folders.includes(parent)) folders.push(parent);
    }
    return folders;
  }

  /**
   * Revalidates and applies one answer. A failed step is reported and never undoes the ones before
   * it; a repository whose settings failed is not opened.
   */
  async apply(repoPath: string, answer: SetupAnswer): Promise<SetupApplyResult> {
    const facts = await this.facts(repoPath);
    const repositories = new Map<string, SetupRepoCheck>();
    for (const repo of answer.repositories) {
      repositories.set(repo.path, await this.checkRepo(repo.path, facts.registered));
    }
    const problems = checkSetupAnswer(answer, { catalogue: facts.catalogue, repositories });
    if (problems.length > 0) {
      throw new Error(`The setup answer can't be saved: ${problems.join(" ")}`);
    }
    const codeFolders = await this.codeFoldersToSave(facts, answer.repositories, repositories);
    const lines: string[] = [];
    let complete = true;
    const step = async (done: string, failed: string, save: () => Promise<unknown>) => {
      try {
        await save();
        lines.push(done);
        return true;
      } catch (error) {
        complete = false;
        lines.push(`${failed}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    await step("Saved the model choices and providers.", "Model choices were not saved", () =>
      this.#deps.saveModels({
        repoPath,
        models: answer.models,
        enabledProviders: setupProviders(answer, facts.catalogue),
      }),
    );
    await step(
      `Saved what Tandem does when it runs into an issue: ${answer.selfImprovement}.`,
      "The issue setting was not saved",
      () => this.#deps.saveSelfImprovement(answer.selfImprovement),
    );
    if (codeFolders.length > 0) {
      await step(
        `Saved where to look for repos: ${codeFolders.join(", ")}.`,
        "Code folders were not saved",
        () => this.#deps.saveCodeFolders(codeFolders),
      );
    }
    const opened: string[] = [];
    for (const repo of answer.repositories) {
      const name = await this.applyRepo(repo, answer.mode, facts, step);
      if (name !== undefined) opened.push(name);
    }
    return { message: lines.join("\n"), complete, opened };
  }

  /** The repository's folder name once its chat is open, or undefined when it was not opened. */
  private async applyRepo(
    repo: SetupAnswerRepo,
    mode: SetupMode,
    facts: SetupFacts,
    step: (done: string, failed: string, save: () => Promise<unknown>) => Promise<boolean>,
  ): Promise<string | undefined> {
    const check = await this.checkRepo(repo.path, facts.registered);
    const root = check.kind === "root" ? check.root : repo.path;
    const name = `${basename(root)} (${root})`;
    const commands = {
      validationCommands: repo.validationCommands,
      setupCommands: repo.setupCommands,
      noChecks: repo.noChecks === true,
    };
    const existing = check.kind === "root" && check.setUp;
    const saved = existing
      ? await step(`${name}: settings saved.`, `${name}: settings were not saved`, () =>
          this.#deps.updateRepoCommands(root, commands),
        )
      : await step(`${name}: settings saved.`, `${name}: not set up`, () =>
          this.#deps.setupRepo(root, commands),
        );
    // Settings edits an open chat's repository in place; only setup opens every chat.
    if (!saved || (existing && mode === "settings")) return undefined;
    const open = await step(`${name}: its chat is open.`, `${name}: its chat didn't open`, () =>
      this.#deps.openProject(root),
    );
    return open ? basename(root) : undefined;
  }
}
