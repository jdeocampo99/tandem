import { basename } from "node:path";
import type { SelfImprovementMode } from "../config/home-settings.ts";
import {
  type BalancedProfileProposal,
  discoveredProviders,
  resolveBalancedProfile,
} from "../config/operating-profile.ts";
import {
  type AgentRole,
  type IsoTimestamp,
  MODEL_ROLE_ORDER,
  type ModelSpec,
  type RepoPolicy,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../contracts.ts";
import { type ClaudeCodeAvailability, modsOffReason } from "../harness/claude-code/availability.ts";
import { CLAUDE_CODE_MODELS } from "../harness/claude-code/models.ts";
import { harnessOfSelector, type KnownHarness, type ModelRecord } from "../harness/contract.ts";

/**
 * The setup block's view model: everything it shows and every choice it offers, assembled from
 * saved state and read-only discovery. Pure; src/onboarding/setup-workflow.ts gathers the facts.
 */
export const SETUP_MODES = ["setup", "settings"] as const;
export type SetupMode = (typeof SETUP_MODES)[number];

/**
 * The Settings tab to show first, set only by a publication that opens Settings at one; an
 * absent section leaves the block where it is.
 */
export const SETUP_SECTIONS = ["models", "repositories", "bug-reports"] as const;
export type SetupSection = (typeof SETUP_SECTIONS)[number];

export type SetupView = Readonly<{
  schemaVersion: 1;
  mode: SetupMode;
  generatedAt: IsoTimestamp;
  /** Claude Code's models first, then OMP's, so each harness is one run in the pickers. */
  models: readonly SetupModel[];
  harnesses: readonly SetupHarness[];
  roles: readonly SetupRole[];
  /** What each thinking level means, in a word or two, from the lightest level to the heaviest. */
  thinkingLevels: readonly Readonly<{ level: ThinkingLevel; note: string }>[];
  /** Checkouts already set up, which the user may edit or remove. */
  repos: readonly SetupRepo[];
  /** Discovered checkouts not set up yet, which "Add repository" offers. */
  candidates: readonly SetupRepo[];
  selfImprovement: SelfImprovementMode;
  section?: SetupSection;
}>;

/** One harness's group in the model pickers; `unavailable` says why it offers no models. */
export type SetupHarness = Readonly<{
  id: KnownHarness;
  name: string;
  note: string;
  unavailable?: string;
}>;

export type PriceLevel = "$" | "$$" | "$$$";

export type SetupModel = Readonly<{
  selector: string;
  harness: KnownHarness;
  name: string;
  provider: string;
  /** Supported thinking levels, in THINKING_LEVELS order. */
  thinking: readonly ThinkingLevel[];
  context?: number;
  /** Catalogue price per million tokens, descriptive only. */
  cost?: Readonly<{ input: number; output: number }>;
  /** Where `cost` falls on {@link PRICE_LEVEL_CEILINGS}; absent when the catalogue has no price. */
  priceLevel?: PriceLevel;
}>;

export type SetupRole = Readonly<{
  id: AgentRole;
  name: string;
  what: string;
  /** A CSS color token, such as `--tandem`. */
  color: string;
  /** One short phrase on what to look for in this role's model. */
  hint: string;
  /** The thinking level a new pick starts at, moved to the nearest one the model supports. */
  thinking: ThinkingLevel;
  /** The saved choice, when it is still in the catalogue. */
  pick?: ModelSpec;
  /** The Balanced profile's choice for this role, with its reason; absent when none fits. */
  recommended?: Recommendation;
}>;

export type SetupRepo = Readonly<{
  name: string;
  path: string;
  shownPath: string;
  repo?: string;
  setUp: boolean;
  validationCommands: readonly string[];
  setupCommands: readonly string[];
  /** Checks package.json offers that `validationCommands` does not run yet. */
  suggestions: readonly string[];
  /** What the commands were found in, such as "package.json scripts and bun.lock". */
  detectedFrom?: string;
  inspectionError?: string;
}>;
export type SetupRepoDetails = Readonly<{
  validationCommands: readonly string[];
  /** The commands that run the package.json check scripts, whether or not they are validated. */
  scriptCommands: readonly string[];
  setupCommands: readonly string[];
  /** The lockfile behind `setupCommands`. */
  lockfile?: string;
}>;
export type SetupRepoFacts = Readonly<{
  path: string;
  repo?: string;
  setUp: boolean;
  details?: SetupRepoDetails;
  inspectionError?: string;
}>;

export type SetupViewInput = Readonly<{
  mode: SetupMode;
  generatedAt: IsoTimestamp;
  /** The user's home folder, shown as `~`. */
  homeFolder: string;
  /** OMP's listing; the Claude Code catalogue is added when Claude Code is ready. */
  ompCatalogue: readonly ModelRecord[];
  claudeCode: ClaudeCodeAvailability;
  savedModels?: RepoPolicy["models"];
  repos: readonly SetupRepoFacts[];
  /** Saved mode; absent when the user never chose, so setup starts at fix. */
  selfImprovement?: SelfImprovementMode;
}>;

type RoleCopy = Omit<SetupRole, "id" | "pick" | "recommended">;

export const SETUP_ROLE_COPY: Readonly<Record<AgentRole, RoleCopy>> = {
  coordinator: {
    name: "Planning",
    what: "Plans work and talks with you",
    color: "--tandem",
    hint: "your smartest model",
    thinking: "high",
  },
  scout: {
    name: "Research",
    what: "Reads code and answers questions",
    color: "--research",
    hint: "cheap and fast",
    thinking: "medium",
  },
  implementer: {
    name: "Coding",
    what: "Writes the changes",
    color: "--implement",
    hint: "strong at code, high effort",
    thinking: "high",
  },
  reviewer: {
    name: "Review",
    what: "Checks the changes",
    color: "--review",
    hint: "smart, and different from Coding",
    thinking: "high",
  },
  presentation: {
    name: "Mockups",
    what: "Draws mockups and diagrams",
    color: "--merged",
    hint: "cheap and fast",
    thinking: "low",
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

type Recommendation = Readonly<{ model: ModelSpec; reason: string }>;

const RECOMMENDATION_REASONS: Readonly<Record<AgentRole, string>> = {
  coordinator: "Its plans steer every other role.",
  scout: "Research is mostly reading, so speed matters more than depth.",
  implementer: "Most of the time and cost is here.",
  reviewer: "A second model catches mistakes the first one misses.",
  presentation: "Drawing a page needs little reasoning.",
};

/**
 * What each role runs on when Claude Code is ready. Coding comes from the Balanced profile when it
 * resolves, a different model family than Review; without it Coding runs on Opus and Review moves
 * to Fable so the two still differ.
 */
const CLAUDE_CODE_PICKS = {
  coordinator: { model: "claude-code/fable", thinking: "high" },
  scout: { model: "claude-code/sonnet", thinking: "medium" },
  reviewer: { model: "claude-code/opus", thinking: "high" },
  presentation: { model: "claude-code/sonnet", thinking: "low" },
  implementerWithoutBalanced: { model: "claude-code/opus", thinking: "high" },
  reviewerWithoutBalanced: { model: "claude-code/fable", thinking: "high" },
} as const satisfies Readonly<Record<string, ModelSpec>>;

/** The supported level closest to `wanted`; a lighter one wins a tie. */
function nearestThinking(
  wanted: ThinkingLevel,
  supported: readonly ThinkingLevel[],
): ThinkingLevel {
  const position = (level: ThinkingLevel) => THINKING_LEVELS.indexOf(level);
  let best = wanted;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of supported) {
    const distance = Math.abs(position(level) - position(wanted));
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

/** One recommendation per role; a role is absent when neither Claude Code nor Balanced fills it. */
export function recommend(
  claudeCodeReady: boolean,
  balanced: BalancedProfileProposal,
  models: readonly SetupModel[],
): Readonly<Partial<Record<AgentRole, Recommendation>>> {
  const fromBalanced = (role: AgentRole): ModelSpec | undefined => balanced.roles[role]?.model;
  const picks: Partial<Record<AgentRole, ModelSpec>> = {};
  if (claudeCodeReady) {
    const coding = fromBalanced("implementer");
    picks.coordinator = CLAUDE_CODE_PICKS.coordinator;
    picks.scout = CLAUDE_CODE_PICKS.scout;
    picks.implementer = coding ?? CLAUDE_CODE_PICKS.implementerWithoutBalanced;
    picks.reviewer =
      coding === undefined ? CLAUDE_CODE_PICKS.reviewerWithoutBalanced : CLAUDE_CODE_PICKS.reviewer;
    picks.presentation = CLAUDE_CODE_PICKS.presentation;
  } else {
    for (const role of MODEL_ROLE_ORDER) {
      const pick = fromBalanced(role);
      if (pick !== undefined) picks[role] = pick;
    }
  }
  const recommended: Partial<Record<AgentRole, Recommendation>> = {};
  for (const role of MODEL_ROLE_ORDER) {
    const pick = picks[role];
    if (pick === undefined) continue;
    const supported = models.find((model) => model.selector === pick.model)?.thinking;
    recommended[role] = {
      model: {
        model: pick.model,
        thinking:
          supported === undefined || supported.includes(pick.thinking)
            ? pick.thinking
            : nearestThinking(pick.thinking, supported),
      },
      reason: RECOMMENDATION_REASONS[role],
    };
  }
  return recommended;
}

/**
 * The dearest output price, in dollars per million tokens, that still earns each level; anything
 * above the last ceiling is `$$$`. Output tokens are what an agent writing code mostly pays for.
 */
const PRICE_LEVEL_CEILINGS: readonly Readonly<{ level: PriceLevel; maxOutput: number }>[] = [
  { level: "$", maxOutput: 20 },
  { level: "$$", maxOutput: 60 },
];

export function priceLevel(cost: Readonly<{ output: number }>): PriceLevel {
  return PRICE_LEVEL_CEILINGS.find((ceiling) => cost.output <= ceiling.maxOutput)?.level ?? "$$$";
}

function claudeCodeUnavailable(claudeCode: Exclude<ClaudeCodeAvailability, "ready">): string {
  return claudeCode === "not-installed"
    ? "Not installed on this computer."
    : modsOffReason(claudeCode);
}

/** The models a role may be set to on this computer: OMP's listing, plus Claude Code's when ready. */
export function setupCatalogue(
  ompCatalogue: readonly ModelRecord[],
  claudeCode: ClaudeCodeAvailability,
): readonly ModelRecord[] {
  return claudeCode === "ready" ? [...CLAUDE_CODE_MODELS, ...ompCatalogue] : ompCatalogue;
}

export function buildSetupView(input: SetupViewInput): SetupView {
  const models = setupCatalogue(input.ompCatalogue, input.claudeCode).map(setupModel);
  // Claude Code never spends on its own, so the Balanced profile reads OMP's providers alone.
  const balanced = resolveBalancedProfile({
    catalogue: input.ompCatalogue,
    enabledProviders: new Set(discoveredProviders(input.ompCatalogue)),
  });
  const recommendations = recommend(input.claudeCode === "ready", balanced, models);
  const repos = [...input.repos]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((repo) => setupRepo(repo, input.homeFolder));
  return {
    schemaVersion: 1,
    mode: input.mode,
    generatedAt: input.generatedAt,
    models,
    harnesses: [
      {
        id: "claude-code",
        name: "Claude Code",
        note: "Uses your Claude subscription.",
        ...(input.claudeCode === "ready"
          ? {}
          : { unavailable: claudeCodeUnavailable(input.claudeCode) }),
      },
      {
        id: "omp",
        name: "OMP",
        note: "Models from OMP's catalogue, billed by each provider.",
        ...(input.ompCatalogue.length === 0
          ? { unavailable: "No models yet. Configure a provider in OMP, then reopen setup." }
          : {}),
      },
    ],
    roles: MODEL_ROLE_ORDER.map((id) => {
      const pick = savedPick(input.savedModels?.[id], models);
      const recommended = recommendations[id];
      return {
        id,
        ...SETUP_ROLE_COPY[id],
        ...(pick === undefined ? {} : { pick }),
        ...(recommended === undefined ? {} : { recommended }),
      };
    }),
    thinkingLevels: THINKING_LEVELS.map((level) => ({ level, note: THINKING_NOTES[level] })),
    repos: repos.filter((repo) => repo.setUp),
    candidates: repos.filter((repo) => !repo.setUp),
    selfImprovement: input.selfImprovement ?? "fix",
  };
}

function setupModel(record: ModelRecord): SetupModel {
  return {
    selector: record.selector,
    harness: harnessOfSelector(record.selector),
    name: record.name ?? record.id,
    provider: record.provider,
    thinking: THINKING_LEVELS.filter((level) => record.thinking.includes(level)),
    ...(record.contextWindow === undefined ? {} : { context: record.contextWindow }),
    ...(record.cost === undefined
      ? {}
      : { cost: record.cost, priceLevel: priceLevel(record.cost) }),
  };
}

function savedPick(
  saved: ModelSpec | undefined,
  models: readonly SetupModel[],
): ModelSpec | undefined {
  if (saved === undefined) return undefined;
  const model = models.find((candidate) => candidate.selector === saved.model);
  if (model === undefined) return undefined;
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
    ...(repo.inspectionError === undefined ? {} : { inspectionError: repo.inspectionError }),
  };
  if (details === undefined) {
    return { ...base, validationCommands: [], setupCommands: [], suggestions: [] };
  }
  const sources = [
    ...(details.scriptCommands.length > 0 ? ["package.json scripts"] : []),
    ...(details.lockfile === undefined ? [] : [details.lockfile]),
  ];
  return {
    ...base,
    validationCommands: details.validationCommands,
    setupCommands: details.setupCommands,
    suggestions: details.scriptCommands.filter(
      (command) => !details.validationCommands.includes(command),
    ),
    ...(sources.length === 0 ? {} : { detectedFrom: sources.join(" and ") }),
  };
}

/** `~/code/api` for a path under the home folder; any other path unchanged. */
export function shownPath(path: string, homeFolder: string): string {
  if (path === homeFolder) return "~";
  return path.startsWith(`${homeFolder}/`) ? `~${path.slice(homeFolder.length)}` : path;
}
