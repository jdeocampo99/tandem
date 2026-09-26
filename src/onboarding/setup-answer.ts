import type { OmpModelRecord } from "../adapters/omp.ts";
import type { SelfImprovementMode } from "../config/home-settings.ts";
import { type AgentRole, MODEL_ROLE_ORDER, type ModelSpec, THINKING_LEVELS } from "../contracts.ts";
import { SETUP_ROLE_COPY } from "./setup-view.ts";

/**
 * The setup page's one answer, and the checks it must pass before anything is saved. Pure: the
 * caller reads the catalogue, the skills, and each repository's Git root, then passes them in.
 */
export type SetupAnswer = Readonly<{
  enabledProviders: readonly string[];
  models: Readonly<Record<AgentRole, ModelSpec>>;
  repositories: readonly SetupAnswerRepo[];
  workerSkills: readonly string[];
  selfImprovement: SelfImprovementMode;
}>;

/**
 * One repository to set up. An absent command list means "what Tandem discovers when it saves",
 * and absent MCP servers mean all of the repository's servers; the page leaves them out only for
 * a pasted path it could not look at in advance.
 */
export type SetupAnswerRepo = Readonly<{
  path: string;
  validationCommands?: readonly string[];
  setupCommands?: readonly string[];
  coordinatorMcpServers?: readonly string[];
}>;

/** What one answer path turned out to be on disk, read by the caller. */
export type SetupRepoCheck =
  | Readonly<{
      kind: "root";
      /** The canonical Git root, which is what gets saved. */
      root: string;
      setUp: boolean;
      /** The repository's MCP servers; absent when they could not be read. */
      mcpServers?: readonly string[];
    }>
  | Readonly<{ kind: "inside"; root: string }>
  | Readonly<{ kind: "not-a-repo" }>;

export type SetupAnswerFacts = Readonly<{
  catalogue: readonly OmpModelRecord[];
  /** Names of the skills the page listed. */
  skills: readonly string[];
  /** Keyed by the answer's own path spelling. */
  repositories: ReadonlyMap<string, SetupRepoCheck>;
}>;

export type ParsedSetupAnswer =
  | Readonly<{ ok: true; answer: SetupAnswer }>
  | Readonly<{ ok: false; problems: readonly string[] }>;

const SELF_IMPROVEMENT_MODES: readonly SelfImprovementMode[] = ["off", "fix", "report"];
const ANSWER_KEYS = [
  "tandemSetup",
  "enabledProviders",
  "models",
  "repositories",
  "workerSkills",
  "selfImprovement",
] as const;
const REPO_KEYS = ["path", "validationCommands", "setupCommands", "coordinatorMcpServers"];

/**
 * The setup answer inside `lavish-axi poll` feedback: its prompts come back as rows whose fields
 * are JSON string literals, and the answer is the last one holding a `tandemSetup` object.
 */
export function readSetupAnswerText(rawFeedback: string): string | undefined {
  let found: string | undefined;
  for (const literal of rawFeedback.match(/"(?:[^"\\]|\\.)*"/gu) ?? []) {
    let text: unknown;
    try {
      text = JSON.parse(literal);
    } catch {
      continue;
    }
    if (typeof text === "string" && /^\s*\{/u.test(text) && text.includes('"tandemSetup"')) {
      found = text;
    }
  }
  return found;
}

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
  const enabledProviders = stringList(value.enabledProviders, "enabledProviders", problems);
  const models = parseModels(value.models, problems);
  const repositories = parseRepositories(value.repositories, problems);
  const workerSkills = stringList(value.workerSkills, "workerSkills", problems);
  const selfImprovement = SELF_IMPROVEMENT_MODES.find((mode) => mode === value.selfImprovement);
  if (selfImprovement === undefined) {
    problems.push('selfImprovement must be "off", "fix", or "report".');
  }
  if (problems.length > 0 || models === undefined || selfImprovement === undefined) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    answer: { enabledProviders, models, repositories, workerSkills, selfImprovement },
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
    const optional = (key: "validationCommands" | "setupCommands" | "coordinatorMcpServers") =>
      entry[key] === undefined
        ? {}
        : { [key]: stringList(entry[key], `${where}.${key}`, problems) };
    return [
      {
        path: entry.path.trim(),
        ...optional("validationCommands"),
        ...optional("setupCommands"),
        ...optional("coordinatorMcpServers"),
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
  const providers = new Set(facts.catalogue.map((model) => model.provider));
  if (answer.enabledProviders.length === 0) problems.push("Tick at least one provider.");
  for (const provider of answer.enabledProviders) {
    if (!providers.has(provider))
      problems.push(`${provider} is not a provider in your OMP models.`);
  }
  for (const role of MODEL_ROLE_ORDER) {
    const spec = answer.models[role];
    const name = SETUP_ROLE_COPY[role].name;
    const matches = facts.catalogue.filter((model) => model.selector === spec.model);
    const [model] = matches;
    if (model === undefined || matches.length !== 1) {
      problems.push(`${name}: ${spec.model} is not one of your OMP models.`);
    } else if (!answer.enabledProviders.includes(model.provider)) {
      problems.push(`${name}: ${spec.model} is from ${model.provider}, which isn't ticked.`);
    } else if (!model.thinking.includes(spec.thinking)) {
      problems.push(`${name}: ${spec.model} doesn't support thinking ${spec.thinking}.`);
    }
  }
  const skills = new Set(facts.skills);
  for (const skill of answer.workerSkills) {
    if (!skills.has(skill)) problems.push(`No skill named ${skill} in your skills or plugins.`);
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
    const unknown = (repo.coordinatorMcpServers ?? []).filter(
      (server) => check.mcpServers !== undefined && !check.mcpServers.includes(server),
    );
    if (unknown.length > 0) {
      problems.push(`${repo.path} has no MCP server named ${unknown.join(", ")}.`);
    }
  }
  return problems;
}

const MODE_LABELS: Readonly<Record<SelfImprovementMode, string>> = {
  off: "Off",
  fix: "Fix: look into it and offer a fix",
  report: "Report: draft a GitHub issue",
};

function listed(values: readonly string[] | undefined, absent: string): string {
  if (values === undefined) return absent;
  return values.length === 0 ? "none" : values.join("; ");
}

/**
 * The answer as short lines, for the chat and for the one approval dialog. `codeFolders` are the
 * folders saved for finding repositories by name, when this save adds them.
 */
export function setupRecap(
  answer: SetupAnswer,
  catalogue: readonly OmpModelRecord[],
  codeFolders: readonly string[] = [],
): readonly string[] {
  const modelName = (selector: string) =>
    catalogue.find((model) => model.selector === selector)?.name ?? selector;
  const lines = [
    `Providers: ${answer.enabledProviders.join(", ")}`,
    ...MODEL_ROLE_ORDER.map((role) => {
      const spec = answer.models[role];
      return `${SETUP_ROLE_COPY[role].name}: ${modelName(spec.model)} (${spec.model}), ${spec.thinking}`;
    }),
    `Skills every task gets: ${answer.workerSkills.length === 0 ? "none" : answer.workerSkills.join(", ")}`,
    `When Tandem runs into an issue: ${MODE_LABELS[answer.selfImprovement]}`,
  ];
  if (codeFolders.length > 0) lines.push(`Look for repos in: ${codeFolders.join(", ")}`);
  if (answer.repositories.length === 0) {
    lines.push("Repos: none yet");
    return lines;
  }
  lines.push("Repos, each opened in its own chat:");
  for (const repo of answer.repositories) {
    lines.push(
      `- ${repo.path}: checks ${listed(repo.validationCommands, "found when saving")} · install ${listed(repo.setupCommands, "found when saving")} · MCPs ${listed(repo.coordinatorMcpServers, "all")}`,
    );
  }
  return lines;
}

export const SETUP_ANSWER_RECEIVED = "Got your answers from the setup page:";
export const SETUP_ANSWER_NEXT =
  "Approve them once and Tandem saves everything, then opens a chat for each repo.";
export const SETUP_ANSWER_PROBLEM =
  "The setup page's answer can't be saved yet. Fix this on the page and save again:";
export const SETUP_PAGE_CLOSED =
  "The setup page closed without an answer. Say if you want it back, or keep setting up here.";
export const SETUP_PAGE_REPLY_RECEIVED = "Got it. Approve it in Tandem's chat to save.";
export const SETUP_PAGE_REPLY_OTHER =
  "Use Save and continue at the bottom of the page to send your answers to Tandem.";
