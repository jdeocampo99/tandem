import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { endPresentation, listenPresentation, openPresentation } from "../adapters/lavish.ts";
import type { OmpModelRecord } from "../adapters/omp.ts";
import type { HomeSettings, SelfImprovementMode } from "../config/home-settings.ts";
import type { ModelSettings } from "../config/models.ts";
import type { Clock, CommandResult, CommandRunner, IdFactory, RepoPolicy } from "../contracts.ts";
import { describeLavishFailure, type LavishOpenFailure } from "../report/publish.ts";
import { expandHome, findCheckoutsByName, listCheckouts } from "../repos/locate.ts";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import {
  checkSetupAnswer,
  parseSetupAnswer,
  parseSetupChooseFolderRequest,
  parseSetupSearchRequest,
  readSetupAnswerText,
  readSetupChooseFolderText,
  readSetupCommentText,
  readSetupSearchText,
  type SetupAnswer,
  type SetupAnswerRepo,
  type SetupPageDraft,
  type SetupRepoCheck,
  setupProviders,
} from "./setup-answer.ts";
import { renderSetupHtml } from "./setup-render.ts";
import {
  buildSetupView,
  type SetupRepoDetails,
  type SetupRepoFacts,
  type SetupSearchStatus,
} from "./setup-view.ts";

/**
 * The setup page's effects: gathering what the page shows, writing it under the Tandem home and
 * opening it in Lavish, listening for its one answer, and applying that answer after the page's
 * tagged Save event. The decisions (the view and the answer's checks) are pure and live beside
 * this file.
 */
export type SetupPageDependencies = Readonly<{
  home: string;
  /** The user's home folder, shown as `~` on the page. */
  homeFolder: string;
  run: CommandRunner;
  clock: Clock;
  idFactory: IdFactory;
  models: (
    repoPath: string,
  ) => Promise<
    Readonly<{ availableModels: readonly OmpModelRecord[]; modelSettings: ModelSettings }>
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
  openProject: (path: string) => Promise<unknown>;
}>;

/**
 * `unavailable`: Lavish is not installed, so setup runs in the chat. `ready`: the page can be
 * opened. `open`: it is open and its answer is awaited. `done`: it was answered, closed, or failed
 * to open in this session, so the rest of setup runs in the chat.
 */
export type SetupPageStatus = "unavailable" | "ready" | "open" | "done";

export type SetupPageOpened = Readonly<{ path: string; url?: string }>;

/** What one wait on the open page ended with. */
export type SetupPageEvent =
  | Readonly<{ kind: "answer"; answerId: string; ended: boolean }>
  | Readonly<{ kind: "invalid"; problems: readonly string[]; ended: boolean }>
  | Readonly<{ kind: "search"; reply: string; ended: boolean }>
  | Readonly<{ kind: "comment"; text: string; ended: boolean }>
  | Readonly<{ kind: "other"; ended: boolean }>
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "stopped" }>;
export type SetupApplyResult = Readonly<{ message: string; complete: boolean }>;

type StoredAnswer = Readonly<{
  answerId: string;
  receivedAt: string;
  text: string;
  explicitRoots: readonly string[];
}>;

/** Everything the page and the answer checks read, in one pass. */
type SetupFacts = Readonly<{
  catalogue: readonly OmpModelRecord[];
  modelSettings: ModelSettings;
  settings: HomeSettings;
  roots: readonly string[];
  checkouts: readonly Readonly<{ path: string; repo?: string }>[];
  registered: ReadonlySet<string>;
}>;

export class SetupPageWorkflow {
  readonly #deps: SetupPageDependencies;
  #status: "ready" | "open" | "done" = "ready";
  #lavish: Promise<boolean> | undefined;
  #explicitRoots: string[] = [];
  #draft: SetupPageDraft | undefined;
  readonly #repoDetails = new Map<string, SetupRepoDetails>();
  #lastFacts: SetupFacts | undefined;

  constructor(deps: SetupPageDependencies) {
    this.#deps = deps;
  }

  get pagePath(): string {
    return join(this.#deps.home, "setup", "tandem-setup.html");
  }

  private get answerPath(): string {
    return join(this.#deps.home, "setup", "answer.json");
  }

  async status(): Promise<SetupPageStatus> {
    if (this.#status !== "ready") return this.#status;
    return (await this.lavishInstalled()) ? "ready" : "unavailable";
  }

  /** Probed once per session; a missing or failing `lavish-axi` means setup stays in the chat. */
  private lavishInstalled(): Promise<boolean> {
    this.#lavish ??= this.#deps
      .run({ argv: ["lavish-axi", "--version"], cwd: this.#deps.home, timeoutMs: 15_000 })
      .then((result) => result.code === 0)
      .catch(() => false);
    return this.#lavish;
  }
  private async facts(
    repoPath: string,
    extraRoots: readonly string[] = this.#explicitRoots,
  ): Promise<SetupFacts> {
    const [models, settings, roots, registered] = await Promise.all([
      this.#deps.models(repoPath),
      this.#deps.homeSettings(),
      this.#deps.roots(),
      this.#deps.registeredProjects(),
    ]);
    const searchedRoots = [...new Set([...roots, ...extraRoots])];
    return {
      catalogue: models.availableModels,
      modelSettings: models.modelSettings,
      settings,
      roots: searchedRoots,
      checkouts: await listCheckouts(searchedRoots, this.#deps.run),
      registered: new Set(registered),
    };
  }

  private async renderPage(
    repoPath: string,
    options: Readonly<{ draft?: SetupPageDraft; searchStatus?: SetupSearchStatus }> = {},
    facts?: SetupFacts,
  ): Promise<void> {
    const data = facts ?? (await this.facts(repoPath));
    const repos: SetupRepoFacts[] = await Promise.all(
      data.checkouts.map(async (checkout) => {
        const setUp = data.registered.has(checkout.path);
        let details = this.#repoDetails.get(checkout.path);
        let inspectionError: string | undefined;
        if (!setUp && details === undefined) {
          try {
            details = await this.#deps.inspectRepo(checkout.path);
            this.#repoDetails.set(checkout.path, details);
          } catch (error) {
            inspectionError = error instanceof Error ? error.message : String(error);
          }
        }
        return {
          ...checkout,
          setUp,
          ...(details === undefined ? {} : { details }),
          ...(inspectionError === undefined ? {} : { inspectionError }),
        };
      }),
    );
    const saved = data.modelSettings;
    const view = buildSetupView({
      generatedAt: this.#deps.clock(),
      homeFolder: this.#deps.homeFolder,
      catalogue: data.catalogue,
      ...(saved.configured && saved.models !== undefined ? { savedModels: saved.models } : {}),
      searchedFolders: data.roots,
      pendingFolders: this.#explicitRoots,
      repos,
      ...(data.settings.selfImprovementChosen
        ? { selfImprovement: data.settings.selfImprovement }
        : {}),
      ...(options.draft === undefined ? {} : { draft: options.draft }),
      ...(options.searchStatus === undefined ? {} : { searchStatus: options.searchStatus }),
    });
    const path = this.pagePath;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, renderSetupHtml(view), { mode: 0o600 });
    this.#lastFacts = data;
  }

  /** Builds the page from saved state and discovery, writes it, and opens it in Lavish. */
  async open(repoPath: string): Promise<SetupPageOpened> {
    this.#explicitRoots = [];
    this.#lastFacts = undefined;
    this.#repoDetails.clear();
    this.#draft = undefined;
    await this.renderPage(repoPath);
    const path = this.pagePath;
    let failure: LavishOpenFailure;
    try {
      // The user asked for the page, so a session they ended earlier opens again.
      const observation = await openPresentation(this.#deps.run, path, dirname(path), {
        reopen: true,
      });
      if (observation.status !== "error" && observation.status !== "missing") {
        this.#status = "open";
        return {
          path,
          ...(observation.sessionUrl === undefined ? {} : { url: observation.sessionUrl }),
        };
      }
      failure = { kind: "reported", observation };
    } catch (error) {
      failure = { kind: "threw", error };
    }
    this.#status = "done";
    const { message, detail } = describeLavishFailure(failure);
    throw new Error(
      `${message}${detail === undefined ? "" : ` (${detail})`} Continue setup in the chat.`,
    );
  }

  /**
   * Waits for the page's next feedback. `reply` is shown in the browser first. A valid answer is
   * stored for `apply` under a new id; an invalid one comes back with every problem.
   */
  async listen(repoPath: string, signal: AbortSignal, reply?: string): Promise<SetupPageEvent> {
    if (this.#status !== "open") return { kind: "closed" };
    const path = this.pagePath;
    let observation: Awaited<ReturnType<typeof listenPresentation>>;
    try {
      observation = await listenPresentation(
        async (request) => {
          if (signal.aborted) throw new Error("setup page listener stopped");
          return this.#deps.run({ ...request, signal });
        },
        path,
        dirname(path),
        { agentReply: reply },
      );
    } catch (error) {
      if (signal.aborted) return { kind: "stopped" };
      this.#status = "done";
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    const ended = observation.terminal;
    if (observation.status !== "feedback") {
      if (
        !ended &&
        observation.status !== "browser_disconnected" &&
        observation.status !== "error"
      ) {
        return { kind: "other", ended: false };
      }
      this.#status = "done";
      return { kind: "closed" };
    }
    const text = readSetupAnswerText(observation.rawFeedback);
    if (text !== undefined) {
      const checked = await this.check(repoPath, text);
      if (!checked.ok) return { kind: "invalid", problems: checked.problems, ended };
      const answerId = this.#deps.idFactory();
      const stored: StoredAnswer = {
        answerId,
        receivedAt: this.#deps.clock(),
        text,
        explicitRoots: [...this.#explicitRoots],
      };
      await writeJsonAtomically(this.answerPath, stored);
      return { kind: "answer", answerId, ended };
    }
    const comment = readSetupCommentText(observation.rawFeedback);
    const chooseText = readSetupChooseFolderText(observation.rawFeedback);
    const searchText = readSetupSearchText(observation.rawFeedback);
    let actionResult: Extract<SetupPageEvent, { kind: "search" }> | undefined;
    if (chooseText !== undefined) {
      const result = await this.handleChooseFolder(repoPath, chooseText, ended, signal);
      if (result.kind === "stopped") return result;
      actionResult = result;
    }
    if (searchText !== undefined) {
      actionResult = await this.handleSearch(repoPath, searchText, ended);
    }
    if (actionResult !== undefined) {
      return comment !== undefined ? { kind: "comment", text: comment, ended } : actionResult;
    }
    return comment === undefined
      ? { kind: "other", ended }
      : { kind: "comment", text: comment, ended };
  }
  private async handleSearch(
    repoPath: string,
    text: string,
    ended: boolean,
  ): Promise<Extract<SetupPageEvent, { kind: "search" }>> {
    const parsed = parseSetupSearchRequest(text);
    if (!parsed.ok) {
      if (parsed.draft !== undefined) this.#draft = parsed.draft;
      return this.searchError(repoPath, parsed.problems.join(" "), ended);
    }
    this.#draft = parsed.request.draft;
    const root = await this.searchRoot(parsed.request.folder);
    if (!root.ok) return this.searchError(repoPath, root.problem, ended);
    return this.searchFolder(repoPath, root.path, ended);
  }

  private async handleChooseFolder(
    repoPath: string,
    text: string,
    ended: boolean,
    signal: AbortSignal,
  ): Promise<Extract<SetupPageEvent, { kind: "search" | "stopped" }>> {
    const parsed = parseSetupChooseFolderRequest(text);
    if (!parsed.ok) {
      if (parsed.draft !== undefined) this.#draft = parsed.draft;
      return this.searchError(repoPath, parsed.problems.join(" "), ended);
    }
    this.#draft = parsed.draft;
    let chosen: CommandResult;
    try {
      chosen = await this.#deps.run({
        argv: [
          "osascript",
          "-e",
          'POSIX path of (choose folder with prompt "Choose a code folder for Tandem")',
        ],
        cwd: this.#deps.homeFolder,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return { kind: "stopped" };
      return this.searchError(
        repoPath,
        `macOS could not open the folder chooser: ${error instanceof Error ? error.message : String(error)}. Enter its path instead.`,
        ended,
      );
    }
    if (chosen.code !== 0) {
      if (/\(-128\)/u.test(chosen.stderr)) {
        const reply = "No folder selected.";
        await this.renderPage(
          repoPath,
          { draft: this.#draft, searchStatus: { kind: "ok", message: reply } },
          this.#lastFacts,
        );
        return { kind: "search", reply, ended };
      }
      return this.searchError(
        repoPath,
        "macOS could not open the folder chooser. Enter its path instead.",
        ended,
      );
    }
    const path = chosen.stdout.replace(/\r?\n$/u, "");
    const root = await this.searchRoot(path);
    if (!root.ok) return this.searchError(repoPath, root.problem, ended);
    return this.searchFolder(repoPath, root.path, ended);
  }

  private async searchError(
    repoPath: string,
    problem: string,
    ended: boolean,
  ): Promise<Extract<SetupPageEvent, { kind: "search" }>> {
    const reply = `Couldn't search that folder: ${problem}`;
    await this.renderPage(
      repoPath,
      {
        ...(this.#draft === undefined ? {} : { draft: this.#draft }),
        searchStatus: { kind: "error", message: reply },
      },
      this.#lastFacts,
    );
    return { kind: "search", reply, ended };
  }

  private async searchFolder(
    repoPath: string,
    path: string,
    ended: boolean,
  ): Promise<Extract<SetupPageEvent, { kind: "search" }>> {
    const roots = this.#explicitRoots.includes(path)
      ? this.#explicitRoots
      : [...this.#explicitRoots, path];
    let facts: SetupFacts;
    try {
      facts = await this.facts(repoPath, roots);
    } catch (error) {
      return this.searchError(
        repoPath,
        `scan failed: ${error instanceof Error ? error.message : String(error)}`,
        ended,
      );
    }
    this.#explicitRoots = [...roots];
    const count = facts.checkouts.filter(
      (checkout) => checkout.path === path || checkout.path.startsWith(`${path}/`),
    ).length;
    const reply = `Searched ${path}: found ${count === 1 ? "1 repo" : `${count} repos`}.`;
    await this.renderPage(
      repoPath,
      {
        ...(this.#draft === undefined ? {} : { draft: this.#draft }),
        searchStatus: { kind: "ok", message: reply },
      },
      facts,
    );
    return { kind: "search", reply, ended };
  }

  private async searchRoot(
    folder: string,
  ): Promise<Readonly<{ ok: true; path: string }> | Readonly<{ ok: false; problem: string }>> {
    const expanded = folder.replace(/^~(?=\/|$)/u, this.#deps.homeFolder);
    if (!isAbsolute(expanded)) return { ok: false, problem: "use an absolute path or ~/..." };
    let path: string;
    try {
      path = await realpath(resolve(expanded));
    } catch {
      return { ok: false, problem: `${folder} does not exist.` };
    }
    const home = await realpath(this.#deps.homeFolder).catch(() => resolve(this.#deps.homeFolder));
    if (path === "/" || path === home || path === dirname(home)) {
      return { ok: false, problem: "that folder is too broad; choose a code subfolder." };
    }
    try {
      if (!(await stat(path)).isDirectory()) {
        return { ok: false, problem: `${folder} is not a directory.` };
      }
    } catch {
      return { ok: false, problem: `${folder} is not readable.` };
    }
    return { ok: true, path };
  }

  private async check(
    repoPath: string,
    text: string,
    explicitRoots: readonly string[] = this.#explicitRoots,
  ): Promise<
    | Readonly<{
        ok: true;
        answer: SetupAnswer;
        facts: SetupFacts;
        codeFolders: readonly string[];
      }>
    | Readonly<{ ok: false; problems: readonly string[] }>
  > {
    const parsed = parseSetupAnswer(text);
    if (!parsed.ok) return parsed;
    const facts = await this.facts(repoPath, explicitRoots);
    const repositories = new Map<string, SetupRepoCheck>();
    for (const repo of parsed.answer.repositories) {
      repositories.set(repo.path, await this.checkRepo(repo.path, facts.registered));
    }
    const problems = checkSetupAnswer(parsed.answer, {
      catalogue: facts.catalogue,
      repositories,
    });
    if (problems.length > 0) return { ok: false, problems };
    const codeFolders = await this.codeFoldersToSave(
      facts,
      parsed.answer.repositories,
      repositories,
      explicitRoots,
    );
    return {
      ok: true,
      answer: parsed.answer,
      facts,
      codeFolders,
    };
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
   * Save explicitly searched folders plus any selected checkout's parent. Default discovered
   * folders are recorded on first setup; an approved search appends to existing saved roots.
   */
  private async codeFoldersToSave(
    facts: SetupFacts,
    selected: readonly SetupAnswerRepo[],
    checked: ReadonlyMap<string, SetupRepoCheck>,
    explicitRoots: readonly string[],
  ): Promise<readonly string[]> {
    if (facts.settings.projectRoots.length > 0 && explicitRoots.length === 0) return [];
    const folders: string[] = [...facts.settings.projectRoots];
    if (facts.settings.projectRoots.length === 0) {
      for (const root of facts.roots) {
        const real = await realpath(resolve(expandHome(root))).catch(() => undefined);
        if (real === undefined) continue;
        const holds = facts.checkouts.some((checkout) => checkout.path.startsWith(`${real}/`));
        if (holds && !folders.includes(real)) folders.push(real);
      }
    }
    for (const root of explicitRoots) {
      if (!folders.includes(root)) folders.push(root);
    }
    if (facts.settings.projectRoots.length === 0) {
      for (const repo of selected) {
        const match = checked.get(repo.path);
        if (match?.kind !== "root") continue;
        if (folders.some((folder) => match.root.startsWith(`${folder}/`))) continue;
        const parent = dirname(match.root);
        if (!folders.includes(parent)) folders.push(parent);
      }
    }
    return folders;
  }

  private async stored(answerId: string): Promise<StoredAnswer> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.answerPath, "utf8"));
    } catch {
      throw new Error("No setup page answer is waiting. Open the setup page and save again.");
    }
    const record: Partial<Record<keyof StoredAnswer, unknown>> =
      typeof value === "object" && value !== null ? value : {};
    if (
      typeof record.answerId !== "string" ||
      typeof record.text !== "string" ||
      typeof record.receivedAt !== "string"
    ) {
      throw new Error("The saved setup page answer is unreadable. Open the setup page again.");
    }
    if (record.answerId !== answerId) {
      throw new Error(
        `Setup page answer ${answerId} was replaced by a newer one; use the latest answer.`,
      );
    }
    const explicitRoots = record.explicitRoots ?? [];
    if (
      !Array.isArray(explicitRoots) ||
      !explicitRoots.every((root: unknown) => typeof root === "string" && isAbsolute(root))
    ) {
      throw new Error(
        "The saved setup page answer has unreadable search folders. Open the setup page again.",
      );
    }
    return {
      answerId: record.answerId,
      receivedAt: record.receivedAt,
      text: record.text,
      explicitRoots,
    };
  }

  /**
   * Revalidates and applies the one stored answer, consuming it on completion. A failed step is
   * reported and never undoes the ones before it; a repository whose settings failed is not opened.
   */
  async apply(repoPath: string, answerId: string): Promise<SetupApplyResult> {
    const stored = await this.stored(answerId);
    const checked = await this.check(repoPath, stored.text, stored.explicitRoots);
    if (!checked.ok) {
      throw new Error(`The setup answer can't be saved: ${checked.problems.join(" ")}`);
    }
    const { answer, codeFolders, facts } = checked;
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
    for (const repo of answer.repositories) {
      await this.applyRepo(repo, facts, step);
    }
    await rm(this.answerPath, { force: true });
    this.#status = "done";
    await endPresentation(this.#deps.run, this.pagePath, dirname(this.pagePath)).catch(
      () => undefined,
    );
    return { message: lines.join("\n"), complete };
  }

  private async applyRepo(
    repo: SetupAnswerRepo,
    facts: SetupFacts,
    step: (done: string, failed: string, save: () => Promise<unknown>) => Promise<boolean>,
  ): Promise<void> {
    const check = await this.checkRepo(repo.path, facts.registered);
    const root = check.kind === "root" ? check.root : repo.path;
    const name = `${basename(root)} (${root})`;
    const saved = await step(`${name}: settings saved.`, `${name}: not set up`, () =>
      this.#deps.setupRepo(root, {
        validationCommands: repo.validationCommands,
        setupCommands: repo.setupCommands,
      }),
    );
    if (!saved) return;
    await step(`${name}: its chat is open.`, `${name}: its chat didn't open`, () =>
      this.#deps.openProject(root),
    );
  }
}
