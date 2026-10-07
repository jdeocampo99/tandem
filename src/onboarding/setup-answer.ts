import { basename } from "node:path";
import type { SelfImprovementMode } from "../config/home-settings.ts";
import { type AgentRole, MODEL_ROLE_ORDER, type ModelSpec, THINKING_LEVELS } from "../contracts.ts";
import { CLAUDE_CODE_PROVIDER } from "../harness/claude-code/models.ts";
import type { ModelRecord } from "../harness/contract.ts";
import type { SpecialistChange } from "../specialists/home-files.ts";
import { RESERVED_SPECIALIST_NAME } from "../specialists/registry.ts";
import { type SpecialistFields, specialistMarkdown } from "../specialists/specialist.ts";
import { SETUP_MODES, SETUP_ROLE_COPY, type SetupMode } from "./setup-view.ts";

/**
 * The setup answer, and the checks it must pass before anything is saved. Pure: the caller reads
 * the catalogue and each repository's Git root, then passes them in.
 */
export type SetupAnswer = Readonly<{
  /** Setup opens each saved repository's chat; settings only the ones it adds. */
  mode: SetupMode;
  models: Readonly<Record<AgentRole, ModelSpec>>;
  repositories: readonly SetupAnswerRepo[];
  selfImprovement: SelfImprovementMode;
  /** Just-me files to change, at most one change per name; settings only. A missing key is none. */
  specialists: readonly SpecialistChange[];
}>;

/**
 * One repository to save: a new one is set up, one already set up has its commands updated. Every
 * repository needs a validation command; omitted setup commands are discovered for a new one and
 * left alone for one already set up.
 */
export type SetupAnswerRepo = Readonly<{
  path: string;
  validationCommands: readonly string[];
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
  /** Just-me files by name; the revision is absent when the file could not be read whole. */
  homeSpecialists: ReadonlyMap<string, Readonly<{ revision?: string }>>;
}>;

export type ParsedSetupAnswer =
  | Readonly<{ ok: true; answer: SetupAnswer }>
  | Readonly<{ ok: false; problems: readonly string[] }>;

const SELF_IMPROVEMENT_MODES: readonly SelfImprovementMode[] = ["off", "fix", "report"];
const ANSWER_KEYS = [
  "tandemSetup",
  "mode",
  "models",
  "repositories",
  "selfImprovement",
  "specialists",
] as const;
const REPO_KEYS = ["path", "validationCommands", "setupCommands"];
const REVISION = /^[0-9a-f]{64}$/u;

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
  const specialists =
    value.specialists === undefined ? [] : parseSpecialistChanges(value.specialists, problems);
  const selfImprovement = SELF_IMPROVEMENT_MODES.find((mode) => mode === value.selfImprovement);
  if (selfImprovement === undefined) {
    problems.push('selfImprovement must be "off", "fix", or "report".');
  }
  const mode = SETUP_MODES.find((candidate) => candidate === value.mode);
  if (mode === undefined) problems.push('mode must be "setup" or "settings".');
  if (
    problems.length > 0 ||
    models === undefined ||
    selfImprovement === undefined ||
    mode === undefined
  ) {
    return { ok: false, problems };
  }
  return { ok: true, answer: { mode, models, repositories, selfImprovement, specialists } };
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
    const setupCommands =
      entry.setupCommands === undefined
        ? {}
        : { setupCommands: stringList(entry.setupCommands, `${where}.setupCommands`, problems) };
    return [
      {
        path: entry.path.trim(),
        // An absent list is an empty one: the gate then names the repository.
        validationCommands:
          entry.validationCommands === undefined
            ? []
            : stringList(entry.validationCommands, `${where}.validationCommands`, problems),
        ...setupCommands,
      },
    ];
  });
}

/** The shape only: whether a change can be saved is checkSetupAnswer's question. */
function parseSpecialistChanges(value: unknown, problems: string[]): readonly SpecialistChange[] {
  if (!Array.isArray(value)) {
    problems.push("specialists must be a list.");
    return [];
  }
  return value.flatMap((entry: unknown, index): SpecialistChange[] => {
    const where = `specialists[${index}]`;
    if (!isRecord(entry) || typeof entry.name !== "string") {
      problems.push(`${where} has no name.`);
      return [];
    }
    const name = entry.name;
    const op = entry.op;
    const revision =
      typeof entry.revision === "string" && REVISION.test(entry.revision)
        ? entry.revision
        : undefined;
    if (op !== "create" && op !== "update" && op !== "remove") {
      problems.push(`${where}.op must be "create", "update", or "remove".`);
      return [];
    }
    const keys = { create: ["fields"], update: ["revision", "fields"], remove: ["revision"] }[op];
    unknownKeys(entry, ["op", "name", ...keys], where, problems);
    if (op !== "create" && revision === undefined) {
      problems.push(`${where} has no revision.`);
      return [];
    }
    if (op === "remove") return revision === undefined ? [] : [{ op, name, revision }];
    const fields = parseSpecialistFields(entry.fields, where, problems);
    if (fields === undefined) return [];
    if (op === "create") return [{ op, name, fields }];
    return revision === undefined ? [] : [{ op, name, revision, fields }];
  });
}

function parseSpecialistFields(
  value: unknown,
  where: string,
  problems: string[],
): SpecialistFields | undefined {
  if (!isRecord(value)) {
    problems.push(`${where} has no fields.`);
    return undefined;
  }
  const keys = ["label", "description", "instructions", "steps"];
  unknownKeys(value, keys, `${where}.fields`, problems);
  const { label, description, instructions, steps } = value;
  const stepList = Array.isArray(steps)
    ? steps.filter((step): step is string => typeof step === "string")
    : undefined;
  if (
    typeof label !== "string" ||
    (description !== undefined && typeof description !== "string") ||
    typeof instructions !== "string" ||
    stepList === undefined ||
    !Array.isArray(steps) ||
    stepList.length !== steps.length
  ) {
    problems.push(`${where}.fields must be text, with steps a list of text.`);
    return undefined;
  }
  return {
    label,
    ...(description === undefined ? {} : { description }),
    instructions,
    steps: stepList,
  };
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
    if (roots.has(check.root)) problems.push(`${repo.path} is listed twice.`);
    roots.add(check.root);
    if (!repo.validationCommands.some((command) => command.trim().length > 0)) {
      problems.push(`${basename(check.root)} needs a validation command.`);
    }
  }
  if (answer.mode === "setup" && answer.repositories.length === 0) {
    problems.push("Add at least one repository.");
  }
  problems.push(...specialistProblems(answer, facts));
  return problems;
}

/**
 * Refuses the whole answer before anything is saved: a name changed twice, a create over a file
 * Just me has, an update or remove of a file that changed since Settings showed it, and a file
 * that would not read back as itself.
 */
function specialistProblems(answer: SetupAnswer, facts: SetupAnswerFacts): readonly string[] {
  if (answer.specialists.length === 0) return [];
  if (answer.mode === "setup") return ["Specialists are changed in Settings."];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const change of answer.specialists) {
    const { name } = change;
    if (seen.has(name)) problems.push(`${name} is changed twice.`);
    seen.add(name);
    const existing = facts.homeSpecialists.get(name);
    if (change.op === "create") {
      if (name === RESERVED_SPECIALIST_NAME) {
        problems.push(`${name} is Tandem's own fix-round checklist; pick another name.`);
      } else if (existing !== undefined) {
        problems.push(`Just me already has ${name}. Pick another name.`);
      }
    } else if (existing === undefined) {
      problems.push(`${name} is no longer in Just me. Reopen Settings.`);
    } else if (existing.revision !== change.revision) {
      problems.push(`${name} changed on disk since Settings showed it. Reopen Settings.`);
    }
    if (change.op !== "remove") {
      const written = specialistMarkdown(name, change.fields);
      if (!written.ok) problems.push(`${name}: ${written.problem}.`);
    }
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
