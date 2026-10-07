import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { HomeSettings, SelfImprovementMode } from "../config/home-settings.ts";
import type { ModelSettings } from "../config/models.ts";
import type { Clock, CommandRunner, RepoPolicy, TaskRecord } from "../contracts.ts";
import type { ClaudeCodeAvailability } from "../harness/claude-code/availability.ts";
import type { ModelRecord } from "../harness/contract.ts";
import { expandHome, findCheckoutsByName, listCheckouts } from "../repos/locate.ts";
import type { CreateTaskRequest } from "../service/controller.ts";
import type { SpecialistChange } from "../specialists/home-files.ts";
import {
  RESERVED_SPECIALIST_NAME,
  type SpecialistRegistry,
  specialistFileRevision,
} from "../specialists/registry.ts";
import { teamSpecialistTask } from "../specialists/share.ts";
import { specialistMarkdown } from "../specialists/specialist.ts";
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
  type SetupSection,
  type SetupView,
  type SpecialistChatDraft,
  setupCatalogue,
  shownPath,
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
    }>,
  ) => Promise<unknown>;
  /** Replaces the commands of a repository that is already set up; a list left undefined stays. */
  updateRepoCommands: (
    path: string,
    commands: Readonly<{
      validationCommands: readonly string[];
      setupCommands?: readonly string[] | undefined;
    }>,
  ) => Promise<unknown>;
  openProject: (path: string) => Promise<unknown>;
  /** The project's specialists, read from its clean checkout and the Tandem home. */
  specialists: (repoPath: string) => Promise<SpecialistRegistry>;
  /** Writes or removes one Just-me file; changeHomeSpecialist bound to the Tandem home. */
  changeSpecialist: (change: SpecialistChange) => Promise<Readonly<{ path: string }>>;
  /** Creates a task that never joins an open request; for sharing a specialist with the team. */
  createTask: (input: CreateTaskRequest) => Promise<TaskRecord>;
  /** Why Settings can't open for this project yet (the Tandem checkout before onboarding), or undefined. */
  settingsRefusal: (repoPath: string) => Promise<string | undefined>;
  /**
   * Present only where the terminal draws native views: publishes `view` and opens Settings beside
   * the project's coordinator. Its presence alone decides where a chat draft goes.
   */
  openSettings?: (repoPath: string, view: SetupView) => Promise<void>;
}>;

/** What a Settings publication opens at; both are settings only. */
export type SetupFocus = Readonly<{ section?: SetupSection; chatDraft?: SpecialistChatDraft }>;
/** `target` is a registered repository's path; the project's own path shares with its own team. */
export type SpecialistShare = Readonly<{ name: string; revision: string; target: string }>;
/** What Herdr's approval dialog shows before a chat draft is written. */
export type SpecialistDraftPreview = Readonly<{
  path: string;
  text: string;
  hiddenByTeam: boolean;
}>;
export type SpecialistDraftResult =
  | Readonly<{ surface: "settings"; replaces: boolean }>
  | Readonly<{ surface: "file"; path: string }>;

/** `opened` names the repositories whose chats are open after the save. */
export type SetupApplyResult = Readonly<{
  message: string;
  complete: boolean;
  opened: readonly string[];
}>;

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

  /** "settings" exactly when Settings can be opened natively; the one source of the draft surface. */
  get draftSurface(): "settings" | "file" {
    return this.#deps.openSettings === undefined ? "file" : "settings";
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

  /** Settings refuses with settingsRefusal's reason, and adds the specialists and `focus`. */
  async view(repoPath: string, mode: SetupMode, focus: SetupFocus = {}): Promise<SetupView> {
    if (mode === "settings") {
      const refusal = await this.#deps.settingsRefusal(repoPath);
      if (refusal !== undefined) throw new Error(refusal);
    }
    const [facts, specialists] = await Promise.all([
      this.facts(repoPath),
      mode === "settings" ? this.#deps.specialists(repoPath) : undefined,
    ]);
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
    const view = buildSetupView({
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
      ...(specialists === undefined
        ? {}
        : { specialists: { registry: specialists, project: basename(repoPath) } }),
    });
    if (mode !== "settings") return view;
    return {
      ...view,
      ...(focus.section === undefined ? {} : { section: focus.section }),
      ...(focus.chatDraft === undefined ? {} : { chatDraft: focus.chatDraft }),
    };
  }

  /**
   * Starts the task that proposes one Just-me specialist to a repository's team. The file is read
   * again and must still hash to the revision Settings showed, so the task carries exactly what
   * the user looked at. The task waits for approval like any other.
   */
  async shareSpecialist(repoPath: string, share: SpecialistShare): Promise<TaskRecord> {
    const { name, revision, target } = share;
    const registry = await this.#deps.specialists(repoPath);
    const file = registry.files.find((entry) => entry.origin === "home" && entry.name === name);
    if (file === undefined) throw new Error(`Just me has no ${name} any more. Reopen Settings.`);
    if (!file.result.valid) throw new Error(`${name} can't be shared: ${file.result.defect}`);
    const bytes = file.revision === revision ? await readFile(file.path) : undefined;
    if (bytes === undefined || specialistFileRevision(bytes) !== revision) {
      throw new Error(`${name} changed on disk since Settings showed it. Reopen Settings.`);
    }
    return this.#deps.createTask(
      teamSpecialistTask({
        projectRepoPath: repoPath,
        name,
        text: bytes.toString("utf8"),
        target: await this.shareTarget(repoPath, target),
      }),
    );
  }

  /** The project itself, or another registered checkout with a GitHub remote. */
  private async shareTarget(
    repoPath: string,
    target: string,
  ): Promise<"project" | Readonly<{ path: string; repo: string }>> {
    const [project, path] = await Promise.all([
      realpath(repoPath),
      realpath(target).catch(() => target),
    ]);
    if (path === project) return "project";
    if (!(await this.#deps.registeredProjects()).includes(path)) {
      throw new Error(`${target} is not a repository Tandem works in. Add it in Settings first.`);
    }
    const checkouts = await listCheckouts(await this.#deps.roots(), this.#deps.run);
    const repo = checkouts.find((checkout) => checkout.path === path)?.repo;
    if (repo === undefined) {
      throw new Error(
        `${basename(path)} has no GitHub remote, so its team can't review a pull request.`,
      );
    }
    return { path, repo };
  }

  /**
   * The file a chat draft would become in Just me, for Herdr's approval dialog. Refuses a draft
   * the parser would refuse and a name Just me already has, before anyone is asked.
   */
  async previewSpecialistDraft(
    repoPath: string,
    draft: SpecialistChatDraft,
  ): Promise<SpecialistDraftPreview> {
    const text = draftText(draft);
    const registry = await this.#deps.specialists(repoPath);
    const path = join(registry.folders.home, `${draft.name}.md`);
    if (registry.files.some((file) => file.origin === "home" && file.name === draft.name)) {
      throw new Error(
        `Just me already has ${draft.name} (${shownPath(path, this.#deps.homeFolder)}). Pick another name, or edit that specialist in Settings on Tern.`,
      );
    }
    const hiddenByTeam = registry.files.some(
      (file) => file.origin === "repository" && file.name === draft.name,
    );
    return { path, text, hiddenByTeam };
  }

  /**
   * Tern: opens Settings at Specialists with the draft unsaved, and writes nothing. Elsewhere the
   * caller has already shown previewSpecialistDraft and the user approved, so it creates the file;
   * a create never replaces one.
   */
  async draftSpecialist(
    repoPath: string,
    draft: SpecialistChatDraft,
  ): Promise<SpecialistDraftResult> {
    const openSettings = this.#deps.openSettings;
    if (openSettings === undefined) {
      await this.previewSpecialistDraft(repoPath, draft);
      const { path } = await this.#deps.changeSpecialist({
        op: "create",
        name: draft.name,
        fields: draft.fields,
      });
      return { surface: "file", path };
    }
    draftText(draft);
    const view = await this.view(repoPath, "settings", {
      section: "specialists",
      chatDraft: draft,
    });
    await openSettings(repoPath, view);
    const replaces =
      view.specialists?.rows.some((row) => row.origin === "home" && row.name === draft.name) ??
      false;
    return { surface: "settings", replaces };
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
    const homeSpecialists = new Map<string, Readonly<{ revision?: string }>>();
    if (answer.specialists.length > 0) {
      for (const file of (await this.#deps.specialists(repoPath)).files) {
        if (file.origin !== "home") continue;
        homeSpecialists.set(
          file.name,
          file.revision === undefined ? {} : { revision: file.revision },
        );
      }
    }
    const problems = checkSetupAnswer(answer, {
      catalogue: facts.catalogue,
      repositories,
      homeSpecialists,
    });
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
    // Each change re-checks its own file as it writes, so one that changed since the check above
    // fails alone and the rest still save.
    for (const change of answer.specialists) {
      const removing = change.op === "remove";
      await step(
        removing
          ? `Removed your specialist ${change.name}.`
          : `Saved your specialist ${change.name}.`,
        removing ? `${change.name} was not removed` : `${change.name} was not saved`,
        () => this.#deps.changeSpecialist(change),
      );
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

/** The text a draft would be saved as; a draft that can't be saved is refused with the reason. */
function draftText(draft: SpecialistChatDraft): string {
  if (draft.name === RESERVED_SPECIALIST_NAME) {
    throw new Error(`${draft.name} is Tandem's own fix-round checklist; pick another name.`);
  }
  const written = specialistMarkdown(draft.name, draft.fields);
  if (!written.ok) throw new Error(`${draft.name}: ${written.problem}`);
  return written.text;
}
