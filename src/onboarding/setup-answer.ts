import type { OmpModelRecord } from "../adapters/omp.ts";
import type { SelfImprovementMode } from "../config/home-settings.ts";
import { type AgentRole, MODEL_ROLE_ORDER, type ModelSpec, THINKING_LEVELS } from "../contracts.ts";
import { SETUP_ROLE_COPY } from "./setup-view.ts";

/**
 * The setup page's one answer, and the checks it must pass before anything is saved. Pure: the
 * caller reads the catalogue and each repository's Git root, then passes them in.
 */
export type SetupAnswer = Readonly<{
  models: Readonly<Record<AgentRole, ModelSpec>>;
  repositories: readonly SetupAnswerRepo[];
  selfImprovement: SelfImprovementMode;
}>;

export type SetupPageDraft = Readonly<{
  picks: Partial<Record<AgentRole, ModelSpec>>;
  repositories: readonly Readonly<{
    path: string;
    checks: readonly string[];
    install: string;
    pasted: boolean;
  }>[];
  selfImprovement: SelfImprovementMode;
}>;

export type SetupSearchRequest = Readonly<{
  folder: string;
  draft: SetupPageDraft;
}>;

export type ParsedSetupSearchRequest =
  | Readonly<{ ok: true; request: SetupSearchRequest }>
  | Readonly<{ ok: false; problems: readonly string[]; draft?: SetupPageDraft }>;

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
  catalogue: readonly OmpModelRecord[];
  /** Keyed by the answer's own path spelling. */
  repositories: ReadonlyMap<string, SetupRepoCheck>;
}>;

export type ParsedSetupAnswer =
  | Readonly<{ ok: true; answer: SetupAnswer }>
  | Readonly<{ ok: false; problems: readonly string[] }>;

const SELF_IMPROVEMENT_MODES: readonly SelfImprovementMode[] = ["off", "fix", "report"];
const ANSWER_KEYS = ["tandemSetup", "models", "repositories", "selfImprovement"] as const;
const REPO_KEYS = ["path", "validationCommands", "setupCommands"];
const SEARCH_KEYS = ["tandemSearch", "folder", "draft"] as const;
const CHOOSE_FOLDER_KEYS = ["tandemChooseFolder", "draft"] as const;
const DRAFT_KEYS = ["picks", "repositories", "selfImprovement"] as const;
const DRAFT_REPO_KEYS = ["path", "checks", "install", "pasted"] as const;
const MAX_SEARCH_TEXT = 256_000;
const MAX_SEARCH_PATH = 4_096;
const MAX_DRAFT_ITEMS = 256;
const MAX_DRAFT_REPOSITORIES = 256;
const MAX_DRAFT_TEXT = 16_384;

/**
 * The setup page queues this request before it asks Lavish to send it. Keep it separate from the
 * final answer so a search can refresh the page without creating an approval or a user question.
 */
export function parseSetupSearchRequest(text: string): ParsedSetupSearchRequest {
  if (text.length > MAX_SEARCH_TEXT) {
    return { ok: false, problems: ["The repo search request is too large."] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["The repo search request is not valid JSON."] };
  }
  if (!isRecord(value) || value.tandemSearch !== 1) {
    return {
      ok: false,
      problems: ["The request is not a Tandem repo search request (tandemSearch: 1)."],
    };
  }
  const problems: string[] = [];
  unknownKeys(value, SEARCH_KEYS, "The search request", problems);
  if (typeof value.folder !== "string") problems.push("folder must be text.");
  const folder = typeof value.folder === "string" ? value.folder.trim() : "";
  if (folder.length === 0) problems.push("folder must not be empty.");
  if (folder.length > MAX_SEARCH_PATH) problems.push("folder is too long.");
  const draft = parseSetupDraft(value.draft, problems);
  if (problems.length > 0 || draft === undefined) {
    return {
      ok: false,
      problems,
      ...(draft === undefined ? {} : { draft }),
    };
  }
  return { ok: true, request: { folder, draft } };
}

/** A native folder request carries only the current draft; the path comes from macOS. */
export function parseSetupChooseFolderRequest(
  text: string,
):
  | Readonly<{ ok: true; draft: SetupPageDraft }>
  | Readonly<{ ok: false; problems: readonly string[]; draft?: SetupPageDraft }> {
  if (text.length > MAX_SEARCH_TEXT) {
    return { ok: false, problems: ["The folder request is too large."] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["The folder request is not valid JSON."] };
  }
  if (!isRecord(value) || value.tandemChooseFolder !== 1) {
    return { ok: false, problems: ["The request is not a Tandem folder request."] };
  }
  const problems: string[] = [];
  unknownKeys(value, CHOOSE_FOLDER_KEYS, "The folder request", problems);
  const draft = parseSetupDraft(value.draft, problems);
  if (problems.length > 0 || draft === undefined) {
    return { ok: false, problems, ...(draft === undefined ? {} : { draft }) };
  }
  return { ok: true, draft };
}

function parseSetupDraft(value: unknown, problems: string[]): SetupPageDraft | undefined {
  if (!isRecord(value)) {
    problems.push("draft must be an object.");
    return undefined;
  }
  unknownKeys(value, DRAFT_KEYS, "draft", problems);
  const picks: Partial<Record<AgentRole, ModelSpec>> = {};
  if (!isRecord(value.picks)) {
    problems.push("draft.picks must be an object.");
  } else {
    unknownKeys(value.picks, MODEL_ROLE_ORDER, "draft.picks", problems);
    for (const role of MODEL_ROLE_ORDER) {
      const candidate = value.picks[role];
      if (candidate === undefined) continue;
      if (!isRecord(candidate)) {
        problems.push(`draft.picks.${role} must be an object.`);
        continue;
      }
      unknownKeys(candidate, ["model", "thinking"], `draft.picks.${role}`, problems);
      const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
      const thinking = THINKING_LEVELS.find((level) => level === candidate.thinking);
      if (model.length === 0 || model.length > MAX_DRAFT_TEXT) {
        problems.push(`draft.picks.${role}.model must be non-empty text.`);
      } else if (thinking === undefined) {
        problems.push(`draft.picks.${role}.thinking must be a valid thinking level.`);
      } else {
        picks[role] = { model, thinking };
      }
    }
  }
  const repositories: SetupPageDraft["repositories"][number][] = [];
  if (!Array.isArray(value.repositories)) {
    problems.push("draft.repositories must be a list.");
  } else if (value.repositories.length > MAX_DRAFT_REPOSITORIES) {
    problems.push(`draft.repositories has more than ${MAX_DRAFT_REPOSITORIES} entries.`);
  } else {
    value.repositories.forEach((entry, index) => {
      const where = `draft.repositories[${index}]`;
      if (!isRecord(entry)) {
        problems.push(`${where} must be an object.`);
        return;
      }
      unknownKeys(entry, DRAFT_REPO_KEYS, where, problems);
      const path = typeof entry.path === "string" ? entry.path.trim() : "";
      const install = typeof entry.install === "string" ? entry.install : "";
      const checks = boundedStringList(entry.checks, `${where}.checks`, problems, true);
      if (path.length === 0 || path.length > MAX_SEARCH_PATH)
        problems.push(`${where}.path is invalid.`);
      if (install.length > MAX_DRAFT_TEXT) problems.push(`${where}.install is too long.`);
      if (typeof entry.pasted !== "boolean") problems.push(`${where}.pasted must be boolean.`);
      repositories.push({
        path,
        checks,
        install,
        pasted: entry.pasted === true,
      });
    });
  }
  const selfImprovement = SELF_IMPROVEMENT_MODES.find((mode) => mode === value.selfImprovement);
  if (selfImprovement === undefined) {
    problems.push('draft.selfImprovement must be "off", "fix", or "report".');
  }
  if (problems.length > 0 || selfImprovement === undefined) return undefined;
  return { picks, repositories, selfImprovement };
}

function boundedStringList(
  value: unknown,
  field: string,
  problems: string[],
  preserveInput = false,
): readonly string[] {
  if (!Array.isArray(value)) {
    problems.push(`${field} must be a list of text.`);
    return [];
  }
  if (value.length > MAX_DRAFT_ITEMS) {
    problems.push(`${field} has more than ${MAX_DRAFT_ITEMS} entries.`);
  }
  const entries = value.map((entry) =>
    typeof entry === "string" ? (preserveInput ? entry : entry.trim()) : "",
  );
  if (value.some((entry) => typeof entry !== "string"))
    problems.push(`${field} must be a list of text.`);
  if (entries.some((entry) => entry.length > MAX_DRAFT_TEXT))
    problems.push(`${field} has an entry that is too long.`);
  if (!preserveInput && entries.some((entry) => entry.length === 0))
    problems.push(`${field} has an empty entry.`);
  if (!preserveInput && new Set(entries).size !== entries.length)
    problems.push(`${field} lists something twice.`);
  return entries.slice(0, MAX_DRAFT_ITEMS);
}

/**
 * The setup answer is accepted only from Lavish's tagged Save control. Scanning every quoted
 * string would let an ordinary page comment smuggle a write-capable tandemSetup object into the
 * coordinator, so keep the prompt-row boundaries and exact selector/tag in the trust check.
 */
export function readSetupAnswerText(rawFeedback: string): string | undefined {
  let inPrompts = false;
  let found: string | undefined;
  for (const line of rawFeedback.split(/\r?\n/u)) {
    if (/^prompts\[\d+\]\{/u.test(line)) {
      inPrompts = true;
      continue;
    }
    if (/^(?:feedback|session|errors|warnings)\b/u.test(line)) {
      inPrompts = false;
      continue;
    }
    if (!inPrompts) continue;
    const match = /^\s+"(?:[^"\\]|\\.)*",("(?:[^"\\]|\\.)*"),button#next,tandem-setup(?:,|$)/u.exec(
      line,
    );
    if (match === null || match[1] === undefined) continue;
    try {
      const text: unknown = JSON.parse(match[1]);
      if (typeof text === "string" && /^\s*\{/u.test(text) && text.includes('"tandemSetup"')) {
        found = text;
      }
    } catch {
      // A malformed prompt row is not consent.
    }
  }
  return found;
}

/** The latest structured browser action for one discriminator in Lavish prompt feedback. */
function readSetupActionText(rawFeedback: string, discriminator: string): string | undefined {
  let found: string | undefined;
  for (const literal of rawFeedback.match(/"(?:[^"\\]|\\.)*"/gu) ?? []) {
    let text: unknown;
    try {
      text = JSON.parse(literal);
    } catch {
      continue;
    }
    if (typeof text === "string" && /^\s*\{/u.test(text) && text.includes(discriminator)) {
      found = text;
    }
  }
  return found;
}

export function readSetupSearchText(rawFeedback: string): string | undefined {
  return readSetupActionText(rawFeedback, '"tandemSearch"');
}

export function readSetupChooseFolderText(rawFeedback: string): string | undefined {
  return readSetupActionText(rawFeedback, '"tandemChooseFolder"');
}
/** Plain Lavish messages in one poll are kept together, excluding structured setup actions. */
export function readSetupCommentText(rawFeedback: string): string | undefined {
  const messages: string[] = [];
  let promptSuffix = -1;
  let feedback = false;
  for (const line of rawFeedback.split(/\r?\n/u)) {
    const prompts = /^prompts\[\d+\]\{([^}]+)\}:$/u.exec(line);
    if (prompts !== null) {
      const fields = prompts[1]?.split(",") ?? [];
      promptSuffix = fields.indexOf("prompt") === 1 ? fields.length - 2 : -1;
      feedback = false;
      continue;
    }
    if (/^feedback\[\d+\]\{/u.test(line)) {
      promptSuffix = -1;
      feedback = true;
      continue;
    }
    if (feedback) {
      const message = /^\s+message:\s*(.*)$/u.exec(line)?.[1]?.trim();
      if (message) messages.push(message);
    } else if (promptSuffix >= 0) {
      const row = /^\s+"(?:[^"\\]|\\.)*",(.*)$/u.exec(line)?.[1];
      if (row === undefined) continue;
      const quoted = /^"(?:[^"\\]|\\.)*"/u.exec(row)?.[0];
      let value: string;
      if (quoted === undefined) {
        const parts = row.split(",");
        value = parts
          .slice(0, parts.length > promptSuffix ? parts.length - promptSuffix : parts.length)
          .join(",")
          .trim();
      } else {
        try {
          const parsed: unknown = JSON.parse(quoted);
          value = typeof parsed === "string" ? parsed.trim() : "";
        } catch {
          value = row.trim();
        }
      }
      if (!value) continue;
      try {
        const action: unknown = JSON.parse(value);
        if (
          isRecord(action) &&
          (action.tandemSetup === 1 || action.tandemSearch === 1 || action.tandemChooseFolder === 1)
        ) {
          continue;
        }
      } catch {
        // Ordinary freeform text need not be JSON.
      }
      messages.push(value);
    }
  }
  return messages.length > 0 ? messages.join("\n\n") : undefined;
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
  const models = parseModels(value.models, problems);
  const repositories = parseRepositories(value.repositories, problems);
  const selfImprovement = SELF_IMPROVEMENT_MODES.find((mode) => mode === value.selfImprovement);
  if (selfImprovement === undefined) {
    problems.push('selfImprovement must be "off", "fix", or "report".');
  }
  if (problems.length > 0 || models === undefined || selfImprovement === undefined) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    answer: { models, repositories, selfImprovement },
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
      problems.push(`${name}: ${spec.model} is not one of your OMP models.`);
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
/** Returns the unique providers selected by the answer's model choices. */
export function setupProviders(
  answer: SetupAnswer,
  catalogue: readonly OmpModelRecord[],
): readonly string[] {
  const providers = new Set<string>();
  for (const role of MODEL_ROLE_ORDER) {
    const model = catalogue.find((candidate) => candidate.selector === answer.models[role].model);
    if (model !== undefined) providers.add(model.provider);
  }
  return [...providers].sort();
}

export const SETUP_ANSWER_SAVED = "Setup saved:";
export const SETUP_ANSWER_PARTIAL = "Setup partly saved; review results:";
export const SETUP_ANSWER_FAILED =
  "Lavish setup was not applied. Fix this on the page and save again:";
export const SETUP_ANSWER_PROBLEM =
  "The setup page's answer can't be saved yet. Fix this on the page and save again:";
export const SETUP_PAGE_CLOSED =
  "The setup page closed without an answer. Say if you want it back, or keep setting up here.";
