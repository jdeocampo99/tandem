import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { endPresentation, listenPresentation, openPresentation } from "../adapters/lavish.ts";
import type { OmpModelRecord } from "../adapters/omp.ts";
import type { HomeSettings, SelfImprovementMode } from "../config/home-settings.ts";
import type { ModelSettings } from "../config/models.ts";
import type { SkillCatalogEntry } from "../config/skills.ts";
import type { Clock, CommandRunner, IdFactory, RepoPolicy } from "../contracts.ts";
import { describeLavishFailure, type LavishOpenFailure } from "../report/publish.ts";
import { expandHome, findCheckoutsByName, listCheckouts } from "../repos/locate.ts";
import { writeJsonAtomically } from "../runtime/persistence.ts";
import {
  checkSetupAnswer,
  parseSetupAnswer,
  readSetupAnswerText,
  type SetupAnswer,
  type SetupAnswerRepo,
  type SetupRepoCheck,
  setupRecap,
} from "./setup-answer.ts";
import { renderSetupHtml } from "./setup-render.ts";
import { buildSetupView, type SetupRepoDetails, type SetupRepoFacts } from "./setup-view.ts";

/**
 * The setup page's effects: gathering what the page shows, writing it under the Tandem home and
 * opening it in Lavish, listening for its one answer, and saving that answer once approved. The
 * decisions (the view, the answer's checks, the recap) are pure and live beside this file.
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
  mcpServers: (path: string) => Promise<readonly string[]>;
  skills: () => Promise<readonly SkillCatalogEntry[]>;
  saveModels: (
    input: Readonly<{
      repoPath: string;
      models: RepoPolicy["models"];
      enabledProviders: readonly string[];
    }>,
  ) => Promise<unknown>;
  saveWorkerSkills: (skills: readonly string[]) => Promise<unknown>;
  saveSelfImprovement: (mode: SelfImprovementMode) => Promise<unknown>;
  saveCodeFolders: (folders: readonly string[]) => Promise<unknown>;
  setupRepo: (
    path: string,
    repo: Readonly<{
      validationCommands?: readonly string[] | undefined;
      setupCommands?: readonly string[] | undefined;
      coordinatorMcpServers: readonly string[];
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
  | Readonly<{ kind: "answer"; answerId: string; recap: readonly string[]; ended: boolean }>
  | Readonly<{ kind: "invalid"; problems: readonly string[]; ended: boolean }>
  /** Nothing to act on: a comment that is not an answer (`comment`), or a wait that returned early. */
  | Readonly<{ kind: "other"; comment: boolean; ended: boolean }>
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "stopped" }>;

type StoredAnswer = Readonly<{ answerId: string; receivedAt: string; text: string }>;

/** Everything the page and the answer checks read, in one pass. */
type SetupFacts = Readonly<{
  catalogue: readonly OmpModelRecord[];
  modelSettings: ModelSettings;
  settings: HomeSettings;
  roots: readonly string[];
  checkouts: readonly Readonly<{ path: string; repo?: string }>[];
  registered: ReadonlySet<string>;
  skills: readonly SkillCatalogEntry[];
}>;

export class SetupPageWorkflow {
  readonly #deps: SetupPageDependencies;
  #status: "ready" | "open" | "done" = "ready";
  #lavish: Promise<boolean> | undefined;

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

  private async facts(repoPath: string): Promise<SetupFacts> {
    const [models, settings, roots, registered, skills] = await Promise.all([
      this.#deps.models(repoPath),
      this.#deps.homeSettings(),
      this.#deps.roots(),
      this.#deps.registeredProjects(),
      this.#deps.skills(),
    ]);
    return {
      catalogue: models.availableModels,
      modelSettings: models.modelSettings,
      settings,
      roots,
      checkouts: await listCheckouts(roots, this.#deps.run),
      registered: new Set(registered),
      skills,
    };
  }

  /** Builds the page from saved state and discovery, writes it, and opens it in Lavish. */
  async open(repoPath: string): Promise<SetupPageOpened> {
    const facts = await this.facts(repoPath);
    const repos: SetupRepoFacts[] = await Promise.all(
      facts.checkouts.map(async (checkout) => {
        const setUp = facts.registered.has(checkout.path);
        const details = setUp
          ? undefined
          : await this.#deps.inspectRepo(checkout.path).catch(() => undefined);
        return {
          ...checkout,
          setUp,
          ...(details === undefined ? {} : { details }),
        };
      }),
    );
    const saved = facts.modelSettings;
    const view = buildSetupView({
      generatedAt: this.#deps.clock(),
      homeFolder: this.#deps.homeFolder,
      catalogue: facts.catalogue,
      enabledProviders: saved.enabledProviders,
      ...(saved.configured && saved.models !== undefined ? { savedModels: saved.models } : {}),
      searchedFolders: facts.roots,
      repos,
      skills: facts.skills,
      ...(facts.settings.workerSkillsChosen ? { savedSkills: facts.settings.workerSkills } : {}),
      ...(facts.settings.selfImprovementChosen
        ? { selfImprovement: facts.settings.selfImprovement }
        : {}),
    });
    const path = this.pagePath;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, renderSetupHtml(view), { mode: 0o600 });
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
        return { kind: "other", comment: false, ended: false };
      }
      this.#status = "done";
      return { kind: "closed" };
    }
    if (ended) this.#status = "done";
    const text = readSetupAnswerText(observation.rawFeedback);
    if (text === undefined) return { kind: "other", comment: true, ended };
    const checked = await this.check(repoPath, text);
    if (!checked.ok) return { kind: "invalid", problems: checked.problems, ended };
    const answerId = this.#deps.idFactory();
    const stored: StoredAnswer = { answerId, receivedAt: this.#deps.clock(), text };
    await writeJsonAtomically(this.answerPath, stored);
    return { kind: "answer", answerId, recap: checked.recap, ended };
  }

  private async check(
    repoPath: string,
    text: string,
  ): Promise<
    | Readonly<{
        ok: true;
        answer: SetupAnswer;
        recap: readonly string[];
        facts: SetupFacts;
        codeFolders: readonly string[];
      }>
    | Readonly<{ ok: false; problems: readonly string[] }>
  > {
    const parsed = parseSetupAnswer(text);
    if (!parsed.ok) return parsed;
    const facts = await this.facts(repoPath);
    const repositories = new Map<string, SetupRepoCheck>();
    for (const repo of parsed.answer.repositories) {
      repositories.set(repo.path, await this.checkRepo(repo.path, facts.registered));
    }
    const problems = checkSetupAnswer(parsed.answer, {
      catalogue: facts.catalogue,
      skills: facts.skills.map((skill) => skill.name),
      repositories,
    });
    if (problems.length > 0) return { ok: false, problems };
    const codeFolders = await this.codeFoldersToSave(facts);
    return {
      ok: true,
      answer: parsed.answer,
      recap: setupRecap(parsed.answer, facts.catalogue, codeFolders),
      facts,
      codeFolders,
    };
  }

  private async checkRepo(path: string, registered: ReadonlySet<string>): Promise<SetupRepoCheck> {
    const [found] = await findCheckoutsByName(path, [], this.#deps.run).catch(() => []);
    if (found === undefined) return { kind: "not-a-repo" };
    const named = await realpath(resolve(expandHome(path))).catch(() => undefined);
    if (named !== found.path) return { kind: "inside", root: found.path };
    const mcpServers = await this.#deps.mcpServers(found.path).catch(() => undefined);
    return {
      kind: "root",
      root: found.path,
      setUp: registered.has(found.path),
      ...(mcpServers === undefined ? {} : { mcpServers }),
    };
  }

  /**
   * With no code folders saved yet, the searched folders that hold a repository become the saved
   * ones, so finding a repository by name later looks where this page found them.
   */
  private async codeFoldersToSave(facts: SetupFacts): Promise<readonly string[]> {
    if (facts.settings.projectRoots.length > 0) return [];
    const folders: string[] = [];
    for (const root of facts.roots) {
      const real = await realpath(resolve(expandHome(root))).catch(() => undefined);
      if (real === undefined) continue;
      const holds = facts.checkouts.some((checkout) => checkout.path.startsWith(`${real}/`));
      if (holds && !folders.includes(real)) folders.push(real);
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
    return { answerId: record.answerId, receivedAt: record.receivedAt, text: record.text };
  }

  /** The stored answer as the one approval dialog shows it, checked again against this machine. */
  async recap(repoPath: string, answerId: string): Promise<readonly string[]> {
    const checked = await this.check(repoPath, (await this.stored(answerId)).text);
    if (!checked.ok)
      throw new Error(`The setup answer can't be saved: ${checked.problems.join(" ")}`);
    return checked.recap;
  }

  /**
   * Saves an approved answer in order: models and providers, worker skills, the self-improvement
   * mode, code folders, then each repository's settings followed by its chat. A failed step is
   * reported and never undoes the ones before it; a repository whose settings failed is not opened.
   */
  async apply(repoPath: string, answerId: string): Promise<string> {
    const checked = await this.check(repoPath, (await this.stored(answerId)).text);
    if (!checked.ok) {
      throw new Error(`The setup answer can't be saved: ${checked.problems.join(" ")}`);
    }
    const { answer, codeFolders, facts } = checked;
    const lines: string[] = [];
    const step = async (done: string, failed: string, save: () => Promise<unknown>) => {
      try {
        await save();
        lines.push(done);
        return true;
      } catch (error) {
        lines.push(`${failed}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    await step("Saved the model choices and providers.", "Model choices were not saved", () =>
      this.#deps.saveModels({
        repoPath,
        models: answer.models,
        enabledProviders: answer.enabledProviders,
      }),
    );
    await step("Saved the skills every task gets.", "Skills were not saved", () =>
      this.#deps.saveWorkerSkills(answer.workerSkills),
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
    return lines.join("\n");
  }

  private async applyRepo(
    repo: SetupAnswerRepo,
    facts: SetupFacts,
    step: (done: string, failed: string, save: () => Promise<unknown>) => Promise<boolean>,
  ): Promise<void> {
    const check = await this.checkRepo(repo.path, facts.registered);
    const root = check.kind === "root" ? check.root : repo.path;
    const name = `${basename(root)} (${root})`;
    const servers =
      repo.coordinatorMcpServers ?? (check.kind === "root" ? (check.mcpServers ?? []) : []);
    const saved = await step(`${name}: settings saved.`, `${name}: not set up`, () =>
      this.#deps.setupRepo(root, {
        validationCommands: repo.validationCommands,
        setupCommands: repo.setupCommands,
        coordinatorMcpServers: servers,
      }),
    );
    if (!saved) return;
    await step(`${name}: its chat is open.`, `${name}: its chat didn't open`, () =>
      this.#deps.openProject(root),
    );
  }
}
