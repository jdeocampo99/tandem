import { basename } from "node:path";
import type { OmpModelRecord } from "../adapters/omp.ts";
import type { SelfImprovementMode } from "../config/home-settings.ts";
import type { SkillCatalogEntry } from "../config/skills.ts";
import {
  type AgentRole,
  type IsoTimestamp,
  MODEL_ROLE_ORDER,
  type ModelSpec,
  type RepoPolicy,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../contracts.ts";

/**
 * The setup page's view model: everything the page shows and every choice it offers, assembled
 * from saved state and read-only discovery. Pure; src/onboarding/setup-page.ts gathers the facts.
 */
export type SetupView = Readonly<{
  schemaVersion: 1;
  generatedAt: IsoTimestamp;
  providers: readonly SetupProvider[];
  models: readonly SetupModel[];
  roles: readonly SetupRole[];
  /** What each thinking level means, in a word or two. */
  thinkingNotes: Readonly<Record<ThinkingLevel, string>>;
  /** The folders crawled for repositories, with the home folder shown as `~`. */
  searchedFolders: readonly string[];
  repos: readonly SetupRepo[];
  skills: readonly SkillCatalogEntry[];
  /** Skills picked when the page opens: the saved `workerSkills` still on this machine. */
  pickedSkills: readonly string[];
  selfImprovement: SelfImprovementMode;
}>;

export type SetupProvider = Readonly<{ id: string; models: number; enabled: boolean }>;

export type SetupModel = Readonly<{
  selector: string;
  name: string;
  provider: string;
  /** Supported thinking levels, in THINKING_LEVELS order. */
  thinking: readonly ThinkingLevel[];
  context?: number;
  /** Catalogue price per million tokens, descriptive only. */
  cost?: Readonly<{ input: number; output: number }>;
}>;

export type SetupRole = Readonly<{
  id: AgentRole;
  name: string;
  what: string;
  /** A CSS color token, such as `--tandem`. */
  color: string;
  hintLead: string;
  hintRest: string;
  /** The thinking level a new pick starts at, moved to the nearest one the model supports. */
  thinking: ThinkingLevel;
  /** An example setup, plain text only; never a choice or a recommendation. */
  example: string;
  /** The saved choice, when it is still in the catalogue under an enabled provider. */
  pick?: ModelSpec;
}>;

export type SetupRepo = Readonly<{
  name: string;
  path: string;
  shownPath: string;
  repo?: string;
  setUp: boolean;
  validationCommands: readonly string[];
  /** Where the validation commands came from, for the line under them. */
  validationSource: string;
  install: string;
  installSource: string;
  /** The repository's MCP servers; all are allowed to its chat unless the user unticks them. */
  mcpServers: readonly string[];
}>;

/** What discovery found in one checkout; absent for a checkout already set up. */
export type SetupRepoDetails = Readonly<{
  validationCommands: readonly string[];
  /** The package.json scripts behind `validationCommands`. */
  scripts: readonly string[];
  setupCommands: readonly string[];
  /** The lockfile behind `setupCommands`. */
  lockfile?: string;
  mcpServers: readonly string[];
}>;

export type SetupRepoFacts = Readonly<{
  path: string;
  repo?: string;
  setUp: boolean;
  details?: SetupRepoDetails;
}>;

export type SetupViewInput = Readonly<{
  generatedAt: IsoTimestamp;
  /** The user's home folder, shown as `~`. */
  homeFolder: string;
  catalogue: readonly OmpModelRecord[];
  enabledProviders: readonly string[];
  savedModels?: RepoPolicy["models"];
  searchedFolders: readonly string[];
  repos: readonly SetupRepoFacts[];
  skills: readonly SkillCatalogEntry[];
  /** Saved `workerSkills`; absent when the user never chose. */
  savedSkills?: readonly string[];
  /** Saved mode; absent when the user never chose, so the page starts at fix. */
  selfImprovement?: SelfImprovementMode;
}>;

type RoleCopy = Omit<SetupRole, "id" | "pick">;

export const SETUP_ROLE_COPY: Readonly<Record<AgentRole, RoleCopy>> = {
  coordinator: {
    name: "Planning",
    what: "talks with you, plans, decides",
    color: "--tandem",
    hintLead: "Use your smartest model.",
    hintRest: "Its mistakes spread to everything else.",
    thinking: "high",
    example: "Claude Fable 5.1 on high",
  },
  scout: {
    name: "Research",
    what: "reads code and answers questions",
    color: "--research",
    hintLead: "Mid-tier is plenty.",
    hintRest: "Speed matters more than depth.",
    thinking: "medium",
    example: "GPT-6 Luna on high",
  },
  implementer: {
    name: "Coding",
    what: "writes the changes",
    color: "--implement",
    hintLead: "A model good at code, at high or max effort.",
    hintRest: "Most of the time and cost is here.",
    thinking: "high",
    example: "GPT-6 Luna on max",
  },
  reviewer: {
    name: "Review",
    what: "checks the work",
    color: "--review",
    hintLead: "A smart model, ideally not the one that coded.",
    hintRest: "A second model catches different mistakes.",
    thinking: "high",
    example: "Claude Opus 5.5 on high",
  },
  presentation: {
    name: "Visual mockups",
    what: "draws mockups and diagrams",
    color: "--merged",
    hintLead: "Fast and cheap is fine.",
    hintRest: "Drawing a page needs little reasoning.",
    thinking: "low",
    example: "Claude Sonnet 5 on low",
  },
};

export const THINKING_NOTES: Readonly<Record<ThinkingLevel, string>> = {
  off: "no thinking",
  minimal: "barely",
  low: "quick",
  medium: "everyday",
  high: "careful",
  xhigh: "very careful",
  max: "hardest, slow",
  auto: "model decides",
};

export function buildSetupView(input: SetupViewInput): SetupView {
  const providers = [...new Set(input.catalogue.map((model) => model.provider))].sort();
  const enabled = new Set(input.enabledProviders.filter((id) => providers.includes(id)));
  const models = input.catalogue.map(setupModel);
  const skillNames = new Set(input.skills.map((skill) => skill.name));
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    providers: providers.map((id) => ({
      id,
      models: models.filter((model) => model.provider === id).length,
      enabled: enabled.has(id),
    })),
    models,
    roles: MODEL_ROLE_ORDER.map((id) => {
      const pick = savedPick(input.savedModels?.[id], models, enabled);
      return { id, ...SETUP_ROLE_COPY[id], ...(pick === undefined ? {} : { pick }) };
    }),
    thinkingNotes: THINKING_NOTES,
    searchedFolders: input.searchedFolders.map((folder) => shownPath(folder, input.homeFolder)),
    repos: [...input.repos]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((repo) => setupRepo(repo, input.homeFolder)),
    skills: input.skills,
    pickedSkills: (input.savedSkills ?? []).filter((name) => skillNames.has(name)),
    selfImprovement: input.selfImprovement ?? "fix",
  };
}

function setupModel(record: OmpModelRecord): SetupModel {
  return {
    selector: record.selector,
    name: record.name ?? record.id,
    provider: record.provider,
    thinking: THINKING_LEVELS.filter((level) => record.thinking.includes(level)),
    ...(record.contextWindow === undefined ? {} : { context: record.contextWindow }),
    ...(record.cost === undefined ? {} : { cost: record.cost }),
  };
}

function savedPick(
  saved: ModelSpec | undefined,
  models: readonly SetupModel[],
  enabled: ReadonlySet<string>,
): ModelSpec | undefined {
  if (saved === undefined) return undefined;
  const model = models.find((candidate) => candidate.selector === saved.model);
  if (model === undefined || !enabled.has(model.provider)) return undefined;
  return model.thinking.includes(saved.thinking) ? saved : undefined;
}

function setupRepo(repo: SetupRepoFacts, homeFolder: string): SetupRepo {
  const details = repo.details;
  const base = {
    name: basename(repo.path),
    path: repo.path,
    shownPath: shownPath(repo.path, homeFolder),
    ...(repo.repo === undefined ? {} : { repo: repo.repo }),
    setUp: repo.setUp,
  };
  if (details === undefined) {
    return {
      ...base,
      validationCommands: [],
      validationSource: "",
      install: "",
      installSource: "",
      mcpServers: [],
    };
  }
  const install = details.setupCommands[0] ?? "";
  return {
    ...base,
    validationCommands: details.validationCommands,
    validationSource:
      details.validationCommands.length > 0
        ? `Found in package.json scripts: ${details.scripts.join(", ")}. Edit if these aren't what you run before merging.`
        : "None found in package.json. Add the commands you run before merging.",
    install,
    installSource:
      install.length > 0 && details.lockfile !== undefined
        ? `Picked from ${details.lockfile}.`
        : "No lockfile found, so nothing is installed. Add one if the repo needs it.",
    mcpServers: details.mcpServers,
  };
}

/** `~/code/api` for a path under the home folder; any other path unchanged. */
export function shownPath(path: string, homeFolder: string): string {
  if (path === homeFolder) return "~";
  return path.startsWith(`${homeFolder}/`) ? `~${path.slice(homeFolder.length)}` : path;
}
