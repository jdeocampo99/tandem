import type { OmpModelRecord } from "./adapters.ts";
import type { AgentRole, ModelSpec, RepoPolicy } from "./contracts.ts";
import { MODEL_ROLE_LABELS, MODEL_ROLE_ORDER } from "./extension.ts";
import { defaultPolicy, parseModelAssignments } from "./policy.ts";

export type TerminalPrompt = (question: string) => Promise<string>;

export type TerminalPrompter = Readonly<{
  readonly ask: TerminalPrompt;
  readonly write: (text: string) => void;
}>;

export type ModelOnboardingMode = "first" | "saved";

export type ModelOnboardingInput = Readonly<{
  readonly mode: ModelOnboardingMode;
  readonly availableModels: readonly OmpModelRecord[];
  readonly currentModels?: RepoPolicy["models"];
  readonly prompter: TerminalPrompter;
  readonly home: string;
}>;

export type ModelOnboardingResult = Readonly<{
  readonly status: "approved" | "cancelled";
  readonly action: "save" | "keep" | "change" | "cancel";
  readonly models?: RepoPolicy["models"];
}>;

const CANCEL_WORDS: Readonly<Record<string, true>> = {
  cancel: true,
  "not now": true,
  "not-now": true,
  quit: true,
  q: true,
};
const SAVE_WORDS: Readonly<Record<string, true>> = {
  save: true,
  "save settings": true,
  yes: true,
  y: true,
};
const KEEP_WORDS: Readonly<Record<string, true>> = {
  keep: true,
  "keep all": true,
  "keep-all": true,
  "1": true,
};
const CHANGE_WORDS: Readonly<Record<string, true>> = {
  change: true,
  "change roles": true,
  "change-roles": true,
  "2": true,
};
const NOT_NOW_WORDS: Readonly<Record<string, true>> = {
  "not now": true,
  "not-now": true,
  cancel: true,
  "3": true,
  q: true,
  quit: true,
};
const SELECTION_CANCEL_WORDS: Readonly<Record<string, true>> = {
  "not now": true,
  "not-now": true,
  cancel: true,
  q: true,
  quit: true,
};

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function isCancellation(value: string): boolean {
  return CANCEL_WORDS[normalized(value)] === true;
}

function roleLabel(role: AgentRole): string {
  return MODEL_ROLE_LABELS[role];
}

function modelDescription(model: OmpModelRecord): string {
  const label = model.name === undefined ? "" : ` — ${model.name}`;
  return `${model.selector}${label} (thinking: ${model.thinking.join(", ")})`;
}

function writeCatalogue(
  prompter: TerminalPrompter,
  availableModels: readonly OmpModelRecord[],
): void {
  prompter.write("\nAvailable OMP models (choose an exact selector):\n");
  for (const model of availableModels) {
    prompter.write(`  ${modelDescription(model)}\n`);
  }
}

function uniqueModel(
  availableModels: readonly OmpModelRecord[],
  selector: string,
): OmpModelRecord | undefined {
  const matches = availableModels.filter((model) => model.selector === selector);
  return matches.length === 1 ? matches[0] : undefined;
}

function validateAgainstCatalogue(
  assignments: RepoPolicy["models"],
  availableModels: readonly OmpModelRecord[],
): RepoPolicy["models"] {
  const parsed = parseModelAssignments(assignments);
  for (const role of MODEL_ROLE_ORDER) {
    const assignment = parsed[role];
    const model = uniqueModel(availableModels, assignment.model);
    if (model === undefined) {
      throw new Error(
        `${roleLabel(role)} selector ${JSON.stringify(assignment.model)} is not an exact available OMP model`,
      );
    }
    if (!model.thinking.includes(assignment.thinking)) {
      throw new Error(
        `${roleLabel(role)} selector ${JSON.stringify(assignment.model)} does not support thinking ${JSON.stringify(assignment.thinking)}`,
      );
    }
  }
  return parsed;
}

function tryParseAllRoleAnswer(
  value: string,
  availableModels: readonly OmpModelRecord[],
): RepoPolicy["models"] | undefined {
  const text = value.trim();
  if (!text.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("the six-role answer must be valid JSON");
  }
  return validateAgainstCatalogue(parseModelAssignments(parsed), availableModels);
}

function currentForRole(
  currentModels: RepoPolicy["models"] | undefined,
  role: AgentRole,
): ModelSpec | undefined {
  return currentModels?.[role];
}

async function readModelAndThinking(
  prompter: TerminalPrompter,
  availableModels: readonly OmpModelRecord[],
  role: AgentRole,
  currentModels: RepoPolicy["models"] | undefined,
  initialAnswer?: string,
): Promise<ModelSpec | undefined> {
  const current = currentForRole(currentModels, role);
  let modelAnswer = initialAnswer;
  while (true) {
    if (modelAnswer === undefined) {
      const suggestion = current?.model ?? defaultPolicy().models[role].model;
      const suggestionText =
        uniqueModel(availableModels, suggestion) === undefined
          ? "no default suggestion"
          : `suggested ${suggestion} (still enter it explicitly)`;
      modelAnswer = await prompter.ask(`${roleLabel(role)} model selector — ${suggestionText}: `);
    }

    const modelText = modelAnswer.trim();
    const lower = normalized(modelText);
    if (modelText.length === 0 || isCancellation(modelText)) return undefined;
    if (lower === "keep" || lower === "keep current") {
      if (current === undefined) {
        prompter.write(`${roleLabel(role)} has no saved choice to keep.\n`);
        modelAnswer = undefined;
        continue;
      }
      return { ...current };
    }

    const compactParts = modelText.split(/\s+/u);
    if (compactParts.length === 2) {
      const compactModel = uniqueModel(availableModels, compactParts[0] ?? "");
      const compactThinking = compactParts[1] ?? "";
      if (compactModel?.thinking.some((level) => level === compactThinking)) {
        return {
          model: compactModel.selector,
          thinking: compactThinking as ModelSpec["thinking"],
        };
      }
    }

    const selected = uniqueModel(availableModels, modelText);
    if (selected === undefined) {
      prompter.write(
        `${roleLabel(role)} must use one exact selector from the catalogue above; nothing was selected.\n`,
      );
      modelAnswer = undefined;
      continue;
    }

    const thinkingAnswer = await prompter.ask(
      `${roleLabel(role)} thinking level (${selected.thinking.join(", ")}): `,
    );
    const thinking = thinkingAnswer.trim();
    if (thinking.length === 0 || isCancellation(thinking)) return undefined;
    if (!selected.thinking.some((level) => level === thinking)) {
      prompter.write(
        `${roleLabel(role)} selector ${selected.selector} does not support ${JSON.stringify(thinking)}.\n`,
      );
      modelAnswer = undefined;
      continue;
    }
    return { model: selected.selector, thinking: thinking as ModelSpec["thinking"] };
  }
}
async function collectAssignments(
  prompter: TerminalPrompter,
  availableModels: readonly OmpModelRecord[],
  currentModels: RepoPolicy["models"] | undefined,
): Promise<RepoPolicy["models"] | undefined> {
  if (availableModels.length === 0) {
    throw new Error(
      "OMP returned no available models; install or authenticate OMP, then retry. Tandem will not guess a model.",
    );
  }
  writeCatalogue(prompter, availableModels);
  const values: Partial<Record<AgentRole, ModelSpec>> = {};
  for (const [index, role] of MODEL_ROLE_ORDER.entries()) {
    const current = currentForRole(currentModels, role);
    const suggestion = current?.model ?? defaultPolicy().models[role].model;
    const suggestionText =
      uniqueModel(availableModels, suggestion) === undefined
        ? "no default suggestion"
        : `suggested ${suggestion} (still enter it explicitly)`;
    prompter.write(`${roleLabel(role)}: ${suggestionText}\n`);
    const keepHint = current === undefined ? "" : " Type keep to retain the saved choice.";
    let initialAnswer: string | undefined = await prompter.ask(
      `${roleLabel(role)} model selector${keepHint}: `,
    );
    if (index === 0 && initialAnswer.trim().startsWith("{")) {
      try {
        return tryParseAllRoleAnswer(initialAnswer, availableModels);
      } catch (error) {
        prompter.write(`${error instanceof Error ? error.message : String(error)}\n`);
        initialAnswer = undefined;
      }
    }
    const assignment = await readModelAndThinking(
      prompter,
      availableModels,
      role,
      currentModels,
      initialAnswer,
    );
    if (assignment === undefined) return undefined;
    values[role] = assignment;
  }

  const assignmentFor = (role: AgentRole): ModelSpec => {
    const assignment = values[role];
    if (assignment === undefined) {
      throw new Error(`${roleLabel(role)} did not receive an explicit model choice`);
    }
    return assignment;
  };
  return validateAgainstCatalogue(
    {
      coordinator: assignmentFor("coordinator"),
      scout: assignmentFor("scout"),
      implementer: assignmentFor("implementer"),
      reviewer: assignmentFor("reviewer"),
      verifier: assignmentFor("verifier"),
      presentation: assignmentFor("presentation"),
    },
    availableModels,
  );
}

function writeRecap(prompter: TerminalPrompter, models: RepoPolicy["models"], home: string): void {
  prompter.write("\nComplete Tandem role choices:\n");
  for (const role of MODEL_ROLE_ORDER) {
    const assignment = models[role];
    prompter.write(
      `  ${roleLabel(role)} (${role}): ${assignment.model} · thinking ${assignment.thinking}\n`,
    );
  }
  prompter.write(
    `These choices apply to future Tandem work across projects and will be saved in ${home}/models.json.\n`,
  );
}

async function firstTimeOnboarding(input: ModelOnboardingInput): Promise<ModelOnboardingResult> {
  input.prompter.write(
    "\nTandem needs an explicit model and supported thinking level for all six roles before it can start.\n",
  );
  const models = await collectAssignments(input.prompter, input.availableModels, undefined);
  if (models === undefined) {
    input.prompter.write(
      "Model setup paused; no model choices were saved and no project will launch.\n",
    );
    return { status: "cancelled", action: "cancel" };
  }
  writeRecap(input.prompter, models, input.home);
  const save = await input.prompter.ask("Save these six choices? Enter save or not now: ");
  if (SAVE_WORDS[normalized(save)] !== true) {
    input.prompter.write(
      "Model setup paused; no model choices were saved and no project will launch.\n",
    );
    return { status: "cancelled", action: "cancel" };
  }
  return { status: "approved", action: "save", models };
}

async function savedOnboarding(input: ModelOnboardingInput): Promise<ModelOnboardingResult> {
  if (input.currentModels === undefined) {
    throw new TypeError("saved model onboarding requires currentModels");
  }
  const current = parseModelAssignments(input.currentModels);
  input.prompter.write("\nSaved Tandem role choices:\n");
  for (const role of MODEL_ROLE_ORDER) {
    const assignment = current[role];
    input.prompter.write(
      `  ${roleLabel(role)} (${role}): ${assignment.model} · thinking ${assignment.thinking}\n`,
    );
  }
  const choice = await input.prompter.ask("Choose Keep all, Change roles, or Not now: ");
  const selected = normalized(choice);
  if (KEEP_WORDS[selected] === true) {
    return { status: "approved", action: "keep", models: current };
  }
  if (NOT_NOW_WORDS[selected] === true) {
    input.prompter.write(
      "Model setup paused; saved choices are unchanged and no project will launch.\n",
    );
    return { status: "cancelled", action: "cancel" };
  }
  if (CHANGE_WORDS[selected] !== true) {
    input.prompter.write("Enter Keep all, Change roles, or Not now.\n");
    return savedOnboarding(input);
  }

  const models = await collectAssignments(input.prompter, input.availableModels, current);
  if (models === undefined) {
    input.prompter.write(
      "Model setup paused; saved choices are unchanged and no project will launch.\n",
    );
    return { status: "cancelled", action: "cancel" };
  }
  writeRecap(input.prompter, models, input.home);
  const save = await input.prompter.ask(
    "Save the changed six-role choices? Enter save or not now: ",
  );
  if (SAVE_WORDS[normalized(save)] !== true) {
    input.prompter.write(
      "Model setup paused; saved choices are unchanged and no project will launch.\n",
    );
    return { status: "cancelled", action: "cancel" };
  }
  return { status: "approved", action: "change", models };
}

/** Collects all six exact catalogue-backed role choices and requires explicit save consent. */
export async function runModelOnboarding(
  input: ModelOnboardingInput,
): Promise<ModelOnboardingResult> {
  if (!input.prompter || typeof input.prompter.ask !== "function") {
    throw new TypeError("prompter must provide ask");
  }
  if (input.mode === "first") return firstTimeOnboarding(input);
  return savedOnboarding(input);
}

/** Asks for approval to create a Tandem-owned central project record. */
export async function askProjectSettingsApproval(
  prompter: TerminalPrompter,
  projectPath: string,
  configPath: string,
): Promise<boolean> {
  prompter.write(
    `\nSave Tandem settings for ${projectPath}? These settings stay on this computer, outside the project; they do not change the app or start work.\n`,
  );
  prompter.write(`The project record will be saved at ${configPath}.\n`);
  const answer = await prompter.ask("Choose Save settings or Not now: ");
  return SAVE_WORDS[normalized(answer)] === true;
}

/** Selects one or more registered projects, or returns a path explicitly entered by the user. */
export async function askProjectSelection(
  prompter: TerminalPrompter,
  projects: readonly string[],
): Promise<readonly string[] | undefined> {
  prompter.write("\nRegistered Tandem projects:\n");
  if (projects.length === 0) {
    prompter.write("  No registered projects were found.\n");
  } else {
    for (const [index, project] of projects.entries()) {
      prompter.write(`  ${index + 1}. ${project}\n`);
    }
  }
  prompter.write("Select one or more numbers, enter all, or type add to enter a project path.\n");
  const answer = normalized(await prompter.ask("Projects (or cancel): "));
  if (answer.length === 0 || SELECTION_CANCEL_WORDS[answer] === true) return undefined;
  if (answer === "add" || answer === "a") {
    const path = (await prompter.ask("Project path (or cancel): ")).trim();
    return path.length === 0 || isCancellation(path) ? undefined : [path];
  }
  if (answer === "all") return projects;
  const values = answer
    .split(/[\s,]+/u)
    .filter((entry) => entry.length > 0)
    .map((entry) => Number(entry));
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > projects.length)
  ) {
    throw new Error("project selection must be numbers from the registered list, all, or add");
  }
  const selected: string[] = [];
  for (const value of values) {
    const project = projects[value - 1];
    if (project === undefined) throw new Error("selected project is unavailable");
    selected.push(project);
  }
  return [...new Set(selected)];
}
