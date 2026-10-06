import type { SelfImprovementMode } from "../config/home-settings.ts";
import {
  type AgentRole,
  MODEL_ROLE_ORDER,
  type ModelSpec,
  type TerminalName,
  THINKING_LEVELS,
} from "../contracts.ts";
import { CLAUDE_CODE_PROVIDER } from "../harness/claude-code/models.ts";
import type { ModelRecord } from "../harness/contract.ts";
import { SETUP_ROLE_COPY } from "./setup-view.ts";

/**
 * The setup answer, and the checks it must pass before anything is saved. Pure: the caller reads
 * the catalogue and each repository's Git root, then passes them in.
 */
export type SetupAnswer = Readonly<{
  models: Readonly<Record<AgentRole, ModelSpec>>;
  repositories: readonly SetupAnswerRepo[];
  selfImprovement: SelfImprovementMode;
  terminal: TerminalName;
}>;

/** One repository to set up. Omitted command lists are discovered when Tandem saves. */
export type SetupAnswerRepo = Readonly<{
  path: string;
  validationCommands?: readonly string[];
  setupCommands?: readonly string[];
}>;

/** What one answer path turned out to be on disk, read by the caller. */
export type SetupRepoCheck =
  | Readonly<{
      kind: "root";
      /** The canonical Git root, which is what gets saved. */
      root: string;
      setUp: boolean;
    }>
  | Readonly<{ kind: "inside"; root: string }>
  | Readonly<{ kind: "not-a-repo" }>;

export type SetupAnswerFacts = Readonly<{
  /** OMP's listing, plus the Claude Code catalogue when Claude Code is ready. */
  catalogue: readonly ModelRecord[];
  /** Keyed by the answer's own path spelling. */
  repositories: ReadonlyMap<string, SetupRepoCheck>;
}>;

export type ParsedSetupAnswer =
  | Readonly<{ ok: true; answer: SetupAnswer }>
  | Readonly<{ ok: false; problems: readonly string[] }>;

const SELF_IMPROVEMENT_MODES: readonly SelfImprovementMode[] = ["off", "fix", "report"];
const ANSWER_KEYS = [
  "tandemSetup",
  "models",
  "repositories",
  "selfImprovement",
  "terminal",
] as const;
const REPO_KEYS = ["path", "validationCommands", "setupCommands"];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, field: string, problems: string[]): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    problems.push(`${field} must be a list of text.`);
    return [];
  }
  const entries = value.map((entry: string) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) problems.push(`${field} has an empty entry.`);
  if (new Set(entries).size !== entries.length) problems.push(`${field} lists something twice.`);
  return entries;
}

function unknownKeys(
  value: Readonly<Record<string, unknown>>,
  known: readonly string[],
  where: string,
  problems: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) problems.push(`${where} has an unknown field ${key}.`);
  }
}

/** Checks the answer's shape strictly; nothing about this machine is looked at here. */
export function parseSetupAnswer(text: string): ParsedSetupAnswer {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["The answer is not valid JSON."] };
  }
  if (!isRecord(value) || value.tandemSetup !== 1) {
    return { ok: false, problems: ["The answer is not a Tandem setup answer (tandemSetup: 1)."] };
  }
  const problems: string[] = [];
  unknownKeys(value, ANSWER_KEYS, "The answer", problems);
  const models = parseModels(value.models, problems);
  const repositories = parseRepositories(value.repositories, problems);
  const terminal =
    value.terminal === "herdr" || value.terminal === "tern" ? value.terminal : undefined;
  if (terminal === undefined) problems.push('terminal must be "herdr" or "tern".');
  const selfImprovement = SELF_IMPROVEMENT_MODES.find((mode) => mode === value.selfImprovement);
  if (selfImprovement === undefined) {
    problems.push('selfImprovement must be "off", "fix", or "report".');
  }
  if (
    problems.length > 0 ||
    models === undefined ||
    selfImprovement === undefined ||
    terminal === undefined
  ) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    answer: { models, repositories, selfImprovement, terminal },
  };
}

function parseModels(
  value: unknown,
  problems: string[],
): Readonly<Record<AgentRole, ModelSpec>> | undefined {
  if (!isRecord(value)) {
    problems.push("models must name a model for every job.");
    return undefined;
  }
  unknownKeys(value, MODEL_ROLE_ORDER, "models", problems);
  const models: Partial<Record<AgentRole, ModelSpec>> = {};
  for (const role of MODEL_ROLE_ORDER) {
    const spec = value[role];
    const name = SETUP_ROLE_COPY[role].name;
    const thinking = isRecord(spec)
      ? THINKING_LEVELS.find((level) => level === spec.thinking)
      : undefined;
    if (!isRecord(spec) || typeof spec.model !== "string" || spec.model.length === 0) {
      problems.push(`${name} has no model.`);
    } else if (thinking === undefined) {
      problems.push(`${name} has no valid thinking level.`);
    } else {
      unknownKeys(spec, ["model", "thinking"], `models.${role}`, problems);
      models[role] = { model: spec.model, thinking };
    }
  }
  return MODEL_ROLE_ORDER.every((role) => models[role] !== undefined)
    ? (models as Record<AgentRole, ModelSpec>)
    : undefined;
}

function parseRepositories(value: unknown, problems: string[]): readonly SetupAnswerRepo[] {
  if (!Array.isArray(value)) {
    problems.push("repositories must be a list.");
    return [];
  }
  return value.flatMap((entry: unknown, index): SetupAnswerRepo[] => {
    const where = `repositories[${index}]`;
    if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.trim().length === 0) {
      problems.push(`${where} has no path.`);
      return [];
    }
    unknownKeys(entry, REPO_KEYS, where, problems);
    const optional = (key: "validationCommands" | "setupCommands") =>
      entry[key] === undefined
        ? {}
        : { [key]: stringList(entry[key], `${where}.${key}`, problems) };
    return [
      {
        path: entry.path.trim(),
        ...optional("validationCommands"),
        ...optional("setupCommands"),
      },
    ];
  });
}

/**
 * Everything wrong with an answer on this machine, each as one sentence the user can act on; empty
 * when it can be saved as it is.
 */
export function checkSetupAnswer(answer: SetupAnswer, facts: SetupAnswerFacts): readonly string[] {
  const problems: string[] = [];
  for (const role of MODEL_ROLE_ORDER) {
    const spec = answer.models[role];
    const name = SETUP_ROLE_COPY[role].name;
    const matches = facts.catalogue.filter((model) => model.selector === spec.model);
    const [model] = matches;
    if (model === undefined || matches.length !== 1) {
      problems.push(`${name}: ${spec.model} isn't available on this computer.`);
    } else if (!model.thinking.includes(spec.thinking)) {
      problems.push(`${name}: ${spec.model} doesn't support thinking ${spec.thinking}.`);
    }
  }
  const roots = new Set<string>();
  for (const repo of answer.repositories) {
    const check = facts.repositories.get(repo.path) ?? { kind: "not-a-repo" };
    if (check.kind === "not-a-repo") {
      problems.push(`${repo.path} is not a Git repository.`);
      continue;
    }
    if (check.kind === "inside") {
      problems.push(`${repo.path} is inside the repository at ${check.root}; add that folder.`);
      continue;
    }
    if (check.setUp) problems.push(`${repo.path} is already set up.`);
    if (roots.has(check.root)) problems.push(`${repo.path} is listed twice.`);
    roots.add(check.root);
  }
  return problems;
}
/**
 * The providers Tandem may spend on: those of the answer's OMP models. Claude Code runs on the
 * user's own Claude login and is never enabled, so Tandem never picks it on its own.
 */
export function setupProviders(
  answer: SetupAnswer,
  catalogue: readonly ModelRecord[],
): readonly string[] {
  const providers = new Set<string>();
  for (const role of MODEL_ROLE_ORDER) {
    const model = catalogue.find((candidate) => candidate.selector === answer.models[role].model);
    if (model !== undefined && model.provider !== CLAUDE_CODE_PROVIDER) {
      providers.add(model.provider);
    }
  }
  return [...providers].sort();
}
