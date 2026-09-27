import type { OmpModelRecord } from "../adapters/omp.ts";
import { jevGateway } from "../adapters/typesafe.ts";
import { type JevSetting, parseModelAssignments } from "../config/models.ts";
import {
  type BalancedProfileProposal,
  type BalancedRoleGap,
  discoveredProviders,
  resolveBalancedProfile,
} from "../config/operating-profile.ts";
import { defaultPolicy } from "../config/policy.ts";
import {
  type AgentRole,
  MODEL_ROLE_LABELS,
  MODEL_ROLE_ORDER,
  type ModelSpec,
  type RepoPolicy,
} from "../contracts.ts";

export type TerminalSelection = Readonly<{
  readonly choices: readonly Readonly<{
    readonly name: string;
    readonly value: string;
    readonly description?: string;
  }>[];
  readonly search?: boolean;
  readonly default?: string;
}>;

export type TerminalPrompt = (question: string, selection?: TerminalSelection) => Promise<string>;

export type TerminalPrompter = Readonly<{
  readonly ask: TerminalPrompt;
  readonly write: (text: string) => void;
}>;

export type ModelOnboardingMode = "first" | "saved";

export type ModelOnboardingInput = Readonly<{
  readonly mode: ModelOnboardingMode;
  readonly availableModels: readonly OmpModelRecord[];
  readonly currentModels?: RepoPolicy["models"];
  /** Currently saved provider enablement, shown read-only on repeat onboarding. */
  readonly enabledProviders?: readonly string[];
  readonly prompter: TerminalPrompter;
  readonly home: string;
  /** Read only to tell the user whether a Jev key is set; keys are never asked for or stored. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The saved Jev setting; absent means on. */
  readonly jev?: JevSetting;
}>;

export type ModelOnboardingResult = Readonly<{
  readonly status: "approved" | "cancelled";
  readonly action: "save" | "keep" | "change" | "cancel";
  readonly models?: RepoPolicy["models"];
  /** Present only when this run decided a new explicit provider set; absent preserves the saved one. */
  readonly enabledProviders?: readonly string[];
  /** The Jev setting after this run, whether or not the user changed it. */
  readonly jev?: JevSetting;
}>;

const CANCEL_WORDS: Readonly<Record<string, true>> = {
  cancel: true,
  "not now": true,
  "not-now": true,
  quit: true,
  q: true,
};
const SELECTION_CANCEL_WORDS: Readonly<Record<string, true>> = {
  "not now": true,
  "not-now": true,
  cancel: true,
  q: true,
  quit: true,
};

const ROLE_GUIDANCE: Readonly<
  Record<AgentRole, Readonly<{ purpose: string; recommendation: string }>>
> = {
  coordinator: {
    purpose: "Talks with you, plans the work, delegates tasks, and asks for decisions.",
    recommendation: "strong reasoning model",
  },
  scout: {
    purpose: "Explores the codebase and gathers facts without changing code.",
    recommendation: "cheap, fast model",
  },
  implementer: {
    purpose: "Writes code and fixes issues within the scope you approve.",
    recommendation: "strong coding model",
  },
  reviewer: {
    purpose: "Independently checks changes for bugs, security risks, and design problems.",
    recommendation: "strong reasoning model",
  },
  presentation: {
    purpose: "Creates visual explanations and presentation artifacts when useful.",
    recommendation: "fast model with good writing and layout skills",
  },
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

function currentForRole(
  currentModels: RepoPolicy["models"] | undefined,
  role: AgentRole,
): ModelSpec | undefined {
  return currentModels?.[role];
}

function uniqueModel(
  availableModels: readonly OmpModelRecord[],
  selector: string,
): OmpModelRecord | undefined {
  const matches = availableModels.filter((model) => model.selector === selector);
  return matches.length === 1 ? matches[0] : undefined;
}

function usableModels(availableModels: readonly OmpModelRecord[]): readonly OmpModelRecord[] {
  return availableModels.filter((model) => model.thinking.length > 0);
}

function ensureUsableCatalogue(
  availableModels: readonly OmpModelRecord[],
): readonly OmpModelRecord[] {
  if (availableModels.length === 0) {
    throw new Error(
      "OMP returned no available models; install or authenticate OMP, then retry. Tandem will not guess a model.",
    );
  }
  const models = usableModels(availableModels);
  if (models.length === 0) {
    throw new Error(
      "OMP returned no models with supported thinking levels; refresh OMP model metadata, then retry.",
    );
  }
  return models;
}

function modelSelection(
  models: readonly OmpModelRecord[],
  role: AgentRole,
  currentModels: RepoPolicy["models"] | undefined,
): TerminalSelection {
  const choices = models.map((model) => ({
    name: model.name === undefined ? model.selector : `${model.selector} — ${model.name}`,
    value: model.selector,
    description: `Supported thinking levels: ${model.thinking.join(", ")}`,
  }));
  const current = currentForRole(currentModels, role);
  const defaults = defaultPolicy().models[role];
  const suggested =
    uniqueModel(models, current?.model ?? "")?.selector ??
    uniqueModel(models, defaults.model)?.selector;
  return suggested === undefined
    ? { choices, search: true }
    : { choices, search: true, default: suggested };
}

function thinkingSelection(
  model: OmpModelRecord,
  role: AgentRole,
  currentModels: RepoPolicy["models"] | undefined,
): TerminalSelection {
  const current = currentForRole(currentModels, role);
  const defaults = defaultPolicy().models[role];
  const choices = model.thinking.map((level) => ({
    name: `${level}${level === defaults.thinking ? " (Recommended)" : ""}${
      current?.model === model.selector && level === current.thinking ? " (Saved)" : ""
    }`,
    value: level,
  }));
  const suggested =
    current?.model === model.selector && model.thinking.includes(current.thinking)
      ? current.thinking
      : model.thinking.includes(defaults.thinking)
        ? defaults.thinking
        : undefined;
  return suggested === undefined ? { choices } : { choices, default: suggested };
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

async function readModelAndThinking(
  prompter: TerminalPrompter,
  models: readonly OmpModelRecord[],
  role: AgentRole,
  currentModels: RepoPolicy["models"] | undefined,
): Promise<ModelSpec | undefined> {
  const guidance = ROLE_GUIDANCE[role];
  prompter.write(
    `\n${roleLabel(role)} (${role})\n${guidance.purpose}\n(Recommended: ${guidance.recommendation})\n`,
  );
  const modelAnswer = (
    await prompter.ask(
      `${roleLabel(role)} model selector`,
      modelSelection(models, role, currentModels),
    )
  ).trim();
  if (modelAnswer.length === 0 || isCancellation(modelAnswer)) return undefined;

  const selected = uniqueModel(models, modelAnswer);
  if (selected === undefined) {
    throw new Error(
      `${roleLabel(role)} selected an unavailable OMP model ${JSON.stringify(modelAnswer)}`,
    );
  }

  const thinkingAnswer = (
    await prompter.ask(
      `${roleLabel(role)} thinking level`,
      thinkingSelection(selected, role, currentModels),
    )
  ).trim();
  if (thinkingAnswer.length === 0 || isCancellation(thinkingAnswer)) return undefined;
  if (!selected.thinking.includes(thinkingAnswer as ModelSpec["thinking"])) {
    throw new Error(
      `${roleLabel(role)} selector ${selected.selector} does not support thinking ${JSON.stringify(thinkingAnswer)}`,
    );
  }
  return { model: selected.selector, thinking: thinkingAnswer as ModelSpec["thinking"] };
}

async function collectAssignments(
  prompter: TerminalPrompter,
  availableModels: readonly OmpModelRecord[],
  currentModels: RepoPolicy["models"] | undefined,
): Promise<RepoPolicy["models"] | undefined> {
  const models = ensureUsableCatalogue(availableModels);
  prompter.write(
    "Type to filter models by name or selector. Use arrow keys and Enter to choose; Ctrl+C cancels without saving.\n",
  );
  prompter.write(
    "Thinking level controls reasoning effort. Higher levels can take longer and cost more; Recommended marks the role's usual level when supported.\n",
  );
  const values: Partial<Record<AgentRole, ModelSpec>> = {};
  for (const role of MODEL_ROLE_ORDER) {
    const assignment = await readModelAndThinking(prompter, models, role, currentModels);
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

/**
 * Asks, one provider at a time, whether the user grants it explicit spending permission. A plain
 * choice list (rather than free-text multi-select) keeps this navigable with the same arrow-key
 * and Enter interaction as every other onboarding prompt. Returns undefined only on cancellation;
 * declining an individual provider is a normal "skip" answer, not a cancellation.
 */
async function askEnabledProviders(
  prompter: TerminalPrompter,
  discovered: readonly string[],
  currentlyEnabled: readonly string[],
): Promise<readonly string[] | undefined> {
  if (discovered.length === 0) return [];
  prompter.write(
    "\nDiscovered providers (from the OMP catalogue only; discovery never authorizes spending):\n",
  );
  const enabled: string[] = [];
  for (const provider of discovered) {
    const wasEnabled = currentlyEnabled.includes(provider);
    const answer = normalized(
      await prompter.ask(`Enable ${provider} for automatic Balanced selection?`, {
        choices: [
          { name: "Enable", value: "enable" },
          { name: "Skip", value: "skip" },
        ],
        default: wasEnabled ? "enable" : "skip",
      }),
    );
    if (answer.length === 0 || isCancellation(answer)) return undefined;
    if (answer === "enable") enabled.push(provider);
  }
  return enabled;
}

function writeBalancedRecap(
  prompter: TerminalPrompter,
  proposal: Extract<BalancedProfileProposal, { status: "resolved" }>,
  home: string,
): void {
  prompter.write(
    "\nBalanced proposal (exact selector and thinking level chosen from enabled providers):\n",
  );
  for (const role of MODEL_ROLE_ORDER) {
    const assignment = proposal.roles[role].model;
    prompter.write(
      `  ${roleLabel(role)} (${role}): ${assignment.model} · thinking ${assignment.thinking}\n`,
    );
  }
  prompter.write(
    `Exact selectors, capability evidence, and reasons are shown above; accepting saves these choices in ${home}/models.json.\n`,
  );
}

function writeUnresolvedGaps(prompter: TerminalPrompter, gaps: readonly BalancedRoleGap[]): void {
  prompter.write(
    "\nBalanced could not resolve every role; no built-in pin, fuzzy alias, or silent fallback is used:\n",
  );
  for (const gap of gaps) {
    prompter.write(`  ${roleLabel(gap.role)} (${gap.role}): ${gap.reason}\n`);
  }
}

function cancelledFirstRun(prompter: TerminalPrompter): ModelOnboardingResult {
  prompter.write("Model setup paused; no model choices were saved and no project will launch.\n");
  return { status: "cancelled", action: "cancel" };
}

async function firstTimeOnboarding(input: ModelOnboardingInput): Promise<ModelOnboardingResult> {
  const usable = ensureUsableCatalogue(input.availableModels);
  input.prompter.write(
    "\nTandem needs an explicit model and supported thinking level for every role before it can start.\n",
  );
  const enabledProviders = await askEnabledProviders(
    input.prompter,
    discoveredProviders(usable),
    [],
  );
  if (enabledProviders === undefined) return cancelledFirstRun(input.prompter);

  const proposal = resolveBalancedProfile({
    catalogue: usable,
    enabledProviders: new Set(enabledProviders),
  });
  let seed: RepoPolicy["models"] | undefined;
  if (proposal.status === "unresolved") {
    writeUnresolvedGaps(input.prompter, proposal.gaps);
    input.prompter.write("Choose every role explicitly instead.\n");
  } else {
    writeBalancedRecap(input.prompter, proposal, input.home);
    const choice = normalized(
      await input.prompter.ask(
        "Accept the Balanced proposal, inspect and override roles, or Not now",
        {
          choices: [
            { name: "Accept Balanced", value: "accept" },
            { name: "Inspect and override roles", value: "override" },
            { name: "Not now", value: "not now" },
          ],
          default: "accept",
        },
      ),
    );
    if (choice.length === 0 || choice === "not now" || isCancellation(choice)) {
      return cancelledFirstRun(input.prompter);
    }
    if (choice === "accept") {
      return {
        status: "approved",
        action: "save",
        models: proposal.assignments,
        enabledProviders,
      };
    }
    if (choice !== "override") {
      throw new Error(
        "first-run Balanced action must be Accept Balanced, Inspect and override roles, or Not now",
      );
    }
    seed = proposal.assignments;
  }

  const models = await collectAssignments(input.prompter, usable, seed);
  if (models === undefined) return cancelledFirstRun(input.prompter);
  writeRecap(input.prompter, models, input.home);
  const save = await input.prompter.ask("Save these role choices?", {
    choices: [
      { name: "Save", value: "save" },
      { name: "Not now", value: "not now" },
    ],
    default: "not now",
  });
  if (normalized(save) !== "save") return cancelledFirstRun(input.prompter);
  return { status: "approved", action: "save", models, enabledProviders };
}

async function savedOnboarding(input: ModelOnboardingInput): Promise<ModelOnboardingResult> {
  if (input.currentModels === undefined) {
    throw new TypeError("saved model onboarding requires currentModels");
  }
  ensureUsableCatalogue(input.availableModels);
  const current = parseModelAssignments(input.currentModels);
  input.prompter.write("\nSaved Tandem role choices:\n");
  for (const role of MODEL_ROLE_ORDER) {
    const assignment = current[role];
    input.prompter.write(
      `  ${roleLabel(role)} (${role}): ${assignment.model} · thinking ${assignment.thinking}\n`,
    );
  }
  if (input.enabledProviders !== undefined) {
    input.prompter.write(
      `Enabled providers (explicit spending permission): ${
        input.enabledProviders.length === 0 ? "none" : input.enabledProviders.join(", ")
      }\n`,
    );
  }
  const choice = normalized(
    await input.prompter.ask("Choose Keep all, Change roles, or Not now", {
      choices: [
        { name: "Keep all", value: "keep all" },
        { name: "Change roles", value: "change roles" },
        { name: "Not now", value: "not now" },
      ],
    }),
  );
  if (choice === "keep all") {
    return {
      status: "approved",
      action: "keep",
      models: validateAgainstCatalogue(current, input.availableModels),
    };
  }
  if (choice === "not now" || isCancellation(choice)) {
    input.prompter.write(
      "Model setup paused; saved choices are unchanged and no project will launch.\n",
    );
    return { status: "cancelled", action: "cancel" };
  }
  if (choice !== "change roles") {
    throw new Error("saved model action must be Keep all, Change roles, or Not now");
  }

  const models = await collectAssignments(input.prompter, input.availableModels, current);
  if (models === undefined) {
    input.prompter.write(
      "Model setup paused; saved choices are unchanged and no project will launch.\n",
    );
    return { status: "cancelled", action: "cancel" };
  }
  writeRecap(input.prompter, models, input.home);
  const save = await input.prompter.ask("Save the changed role choices?", {
    choices: [
      { name: "Save", value: "save" },
      { name: "Not now", value: "not now" },
    ],
    default: "not now",
  });
  if (normalized(save) !== "save") {
    input.prompter.write(
      "Model setup paused; saved choices are unchanged and no project will launch.\n",
    );
    return { status: "cancelled", action: "cancel" };
  }
  return { status: "approved", action: "change", models };
}

/**
 * Jev is on unless the user turns it off. Keys stay in the user's shell profile: this step only
 * says whether one is set and shows the lines to add, so a key never passes through Tandem.
 */
async function askJev(input: ModelOnboardingInput): Promise<JevSetting> {
  const current = input.jev ?? "on";
  const { prompter, environment } = input;
  prompter.write(
    '\nFaster answers (Jev): answers simple questions like "list my tasks" without waking the coordinator\'s model.\n',
  );
  const hasKey = (environment.TYPESAFE_API_KEY?.trim() ?? "").length > 0;
  if (!hasKey) {
    prompter.write(
      "No TypeSafe key found. To use Jev, add this to ~/.zshrc, then open a new terminal:\n" +
        "  export TYPESAFE_API_KEY=<your key>\n" +
        "Using a company Portkey gateway? Also add PORTKEY_BASE_URL, PORTKEY_API_KEY, PORTKEY_PROVIDER, PORTKEY_CUSTOM_HOST, and PORTKEY_JEV_MODEL.\n",
    );
  } else if (jevGateway(environment) === undefined) {
    prompter.write("Found your TypeSafe key.\n");
  } else {
    prompter.write(
      `Found your keys; Jev connects through ${environment.PORTKEY_BASE_URL?.trim()}.\n`,
    );
  }
  const answer = normalized(
    await prompter.ask("Use Jev?", {
      choices: [
        { name: "Use Jev (recommended)", value: "on" },
        { name: "Turn off", value: "off" },
      ],
      default: current,
    }),
  );
  return answer === "on" || answer === "off" ? answer : current;
}

/** Collects every exact catalogue-backed role choice and requires explicit save consent. */
export async function runModelOnboarding(
  input: ModelOnboardingInput,
): Promise<ModelOnboardingResult> {
  if (!input.prompter || typeof input.prompter.ask !== "function") {
    throw new TypeError("prompter must provide ask");
  }
  const decision =
    input.mode === "first" ? await firstTimeOnboarding(input) : await savedOnboarding(input);
  if (decision.status !== "approved") return decision;
  return { ...decision, jev: await askJev(input) };
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
  const answer = await prompter.ask("Save project settings?", {
    choices: [
      { name: "Save settings", value: "save settings" },
      { name: "Not now", value: "not now" },
    ],
    default: "save settings",
  });
  return answer === "save settings";
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
