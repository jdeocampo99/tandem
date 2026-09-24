import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listenPresentation, openPresentation, pollPresentation } from "../adapters/lavish.ts";
import type { Clock, CommandRequest, CommandRunner, TaskRecord } from "../contracts.ts";
import {
  ARTIFACT_FILE,
  clearRecordError,
  failedRecord,
  isWithin,
  observationError,
  type PresentationAgent,
  type PresentationRecord,
  readAbsolutePath,
  readSingleLine,
  readText,
  statusForObservation,
  type ValidatedRecordPaths,
  validateRecord,
} from "./records.ts";

const DRAW_BRIEF_FILE = "brief.md";
const PRIVATE_ENTRY_NAMES = [ARTIFACT_FILE, DRAW_BRIEF_FILE] as const;
const MAX_HELP_BYTES = 8_000;
const MAX_PLAYBOOK_BYTES = 2_000;
const MAX_TOTAL_PLAYBOOK_BYTES = 6_000;
const MAX_DESIGN_BYTES = 2_000;
const MAX_BRIEF_BYTES = 32_000;
const MAX_GUIDANCE_BYTES = 2_000;
const MAX_TOTAL_GUIDANCE_BYTES = 4_000;
const MAX_OBJECTIVE_BYTES = 3_000;
const MAX_ENTRY_BYTES = 256;
const MAX_LIST_ENTRIES = 12;
const HELP_TIMEOUT_MS = 30_000;
const MOCKUP_STYLE_PATH = fileURLToPath(new URL("./mockup-style.md", import.meta.url));

type PlaybookRule = Readonly<{
  readonly id: string;
  readonly terms: readonly string[];
}>;

const PLAYBOOK_RULES: readonly PlaybookRule[] = [
  { id: "diagram", terms: ["diagram", "flow", "architecture", "relationship", "state machine"] },
  { id: "table", terms: ["table", "records", "matrix", "dense"] },
  {
    id: "comparison",
    terms: [
      "comparison",
      "compare",
      "tradeoff",
      "options",
      "before and after",
      "variant",
      "layout",
    ],
  },
  { id: "plan", terms: ["plan", "roadmap", "scope", "implementation"] },
  { id: "code", terms: ["code", "source", "patch", "diff", "pull request", "pr"] },
  { id: "input", terms: ["input", "decision", "choice", "triage", "feedback"] },
  { id: "slides", terms: ["slides", "slide deck", "presentation deck"] },
];

const DESIGN_SOURCE_PATHS: readonly string[] = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  "src/styles.css",
  "src/index.css",
  "app/globals.css",
  "styles/globals.css",
  "src/components",
  "components",
  "public",
  "assets",
  "index.html",
];

const DESIGN_DEPENDENCY_MARKERS: readonly string[] = [
  "tailwindcss",
  "daisyui",
  "@mui/",
  "@chakra-ui/",
  "styled-components",
  "@emotion/",
  "vanilla-extract",
  "@radix-ui/",
  "radix-ui",
  "@shadcn/",
  "shadcn",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function readRunner(run: unknown): CommandRunner {
  if (typeof run !== "function") throw new TypeError("run must be an argv command runner");
  return run as CommandRunner;
}

function readClock(clock: unknown): Clock {
  if (typeof clock !== "function") throw new TypeError("clock must be a timestamp capability");
  return clock as Clock;
}

function boundedText(value: unknown, field: string, limit: number): string {
  const text = readText(value, field);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function boundedList(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array of strings`);
  return values
    .slice(0, MAX_LIST_ENTRIES)
    .map((value, index) => boundedText(value, `${field}[${index}]`, MAX_ENTRY_BYTES));
}

function selectPlaybookIds(objective: string, artifacts: readonly string[]): readonly string[] {
  const subject = `${objective}\n${artifacts.join("\n")}`.toLowerCase();
  const words = new Set(subject.split(/[^a-z0-9]+/u).filter((word) => word.length > 0));
  const selected = PLAYBOOK_RULES.filter((rule) =>
    rule.terms.some((term) =>
      term.includes(" ")
        ? subject.includes(term)
        : words.has(term) || (term.length > 2 && subject.includes(term)),
    ),
  ).map((rule) => rule.id);
  return selected.length === 0 ? ["plan"] : selected;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory());
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function projectHasDesignSystem(repository: string): Promise<boolean> {
  for (const reference of DESIGN_SOURCE_PATHS) {
    if (await pathExists(join(repository, reference))) return true;
  }
  const packagePath = join(repository, "package.json");
  if (!(await pathExists(packagePath))) return false;
  try {
    const packageText = await readFile(packagePath, "utf8");
    const parsed: unknown = JSON.parse(packageText);
    if (!isRecord(parsed)) return false;
    const dependencySections = [
      parsed.dependencies,
      parsed.devDependencies,
      parsed.peerDependencies,
    ];
    for (const section of dependencySections) {
      if (!isRecord(section)) continue;
      if (
        Object.keys(section).some((dependency) =>
          DESIGN_DEPENDENCY_MARKERS.some(
            (marker) => dependency === marker || dependency.startsWith(marker),
          ),
        )
      ) {
        return true;
      }
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return false;
}

function hasExplicitDesignDirection(objective: string): boolean {
  return /(?:design system|tailwind|daisyui|mui|chakra|brand|palette|colou?rs?|typograph\w*|font|typeface|theme|dark(?: mode)?|light(?: mode)?|style(?: guide)?)/iu.test(
    objective,
  );
}

// ponytail: keyword match on the objective; add an explicit request flag if mockups get misrouted.
function isMockup(objective: string): boolean {
  return /\bmock[\s-]?ups?\b|\bwireframes?\b/iu.test(objective);
}

function taskGuidance(task: TaskRecord): readonly string[] {
  const instructions: string[] = [];
  let totalBytes = 0;
  for (const [channel, entries] of Object.entries(task.policy.guidance)) {
    for (const [index, guidance] of entries.entries()) {
      if (totalBytes >= MAX_TOTAL_GUIDANCE_BYTES || instructions.length >= MAX_LIST_ENTRIES) {
        return instructions;
      }
      const remaining = MAX_TOTAL_GUIDANCE_BYTES - totalBytes;
      const text = boundedText(
        guidance.text,
        `task.policy.guidance.${channel}[${index}].text`,
        Math.min(MAX_GUIDANCE_BYTES, remaining),
      );
      const instruction = `Pinned ${channel} guidance (${guidance.provenance.source}):\n${text}`;
      instructions.push(instruction);
      totalBytes += instruction.length;
    }
  }
  return instructions;
}

async function resolvePhysicalDirectory(path: string, field: string): Promise<string> {
  const physicalPath = await realpath(path);
  const entry = await lstat(physicalPath);
  if (!entry.isDirectory()) throw new Error(`${field} must resolve to a directory`);
  return physicalPath;
}

async function resolvePhysicalParent(directory: string): Promise<string> {
  let candidate = dirname(directory);
  while (true) {
    let entry: Stats | undefined;
    try {
      entry = await lstat(candidate);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    if (entry !== undefined) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        throw new Error("presentation directory parent must be a directory");
      }
      return resolvePhysicalDirectory(candidate, "presentation directory parent");
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error("presentation directory has no existing physical ancestor");
    }
    candidate = parent;
  }
}

async function assertFreshPresentationEntries(directory: string): Promise<void> {
  for (const name of PRIVATE_ENTRY_NAMES) {
    const path = join(directory, name);
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) {
        throw new Error(`presentation ${name} must not preexist as a symlink`);
      }
      throw new Error(`presentation ${name} must not preexist`);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  const entries = await readdir(directory);
  if (entries.length !== 0) {
    throw new Error("presentation directory must be a fresh, empty private leaf");
  }
}

async function createFreshPresentationDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
    const existing = await lstat(directory);
    if (existing.isSymbolicLink()) {
      throw new Error("presentation directory must be freshly created and must not be a symlink");
    }
    if (existing.isDirectory()) {
      throw new Error("presentation directory must be freshly created and must not be reused");
    }
    throw new Error("presentation directory path is already occupied");
  }

  const created = await lstat(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error("presentation directory must remain a fresh private regular directory");
  }
  await assertFreshPresentationEntries(directory);
}

async function ensurePrivateDirectory(directory: string, repository: string): Promise<void> {
  const cwd = resolve(directory);
  const repo = resolve(repository);
  if (cwd === repo || isWithin(repo, cwd)) {
    throw new Error(
      "presentation cwd must be a private artifact directory outside the source repository",
    );
  }

  const physicalRepository = await resolvePhysicalDirectory(repo, "source repository");
  const physicalParent = await resolvePhysicalParent(cwd);
  if (isWithin(physicalRepository, physicalParent)) {
    throw new Error("presentation cwd must remain outside the physical source repository");
  }

  await mkdir(dirname(cwd), { recursive: true, mode: 0o700 });
  const verifiedParent = await resolvePhysicalParent(cwd);
  if (isWithin(physicalRepository, verifiedParent)) {
    throw new Error("presentation cwd must remain outside the physical source repository");
  }

  await createFreshPresentationDirectory(cwd);
  const physicalCwd = await resolvePhysicalDirectory(cwd, "presentation directory");
  if (isWithin(physicalRepository, physicalCwd)) {
    throw new Error("presentation cwd must remain outside the physical source repository");
  }
}

async function readLavishGuide(
  run: CommandRunner,
  cwd: string,
  argv: readonly string[],
  timeoutMs: number | undefined,
  operation: string,
  maxBytes: number,
): Promise<string> {
  const request: CommandRequest = {
    argv,
    cwd,
    ...(timeoutMs === undefined ? {} : { timeoutMs: Math.min(timeoutMs, HELP_TIMEOUT_MS) }),
  };
  const result = await run(request);
  if (
    !isRecord(result) ||
    typeof result.code !== "number" ||
    !Number.isSafeInteger(result.code) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw new Error(`${operation} returned a malformed command result`);
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim().length === 0 ? result.stdout.trim() : result.stderr.trim();
    throw new Error(`${operation} failed with exit code ${result.code}: ${detail}`);
  }
  const guidance = result.stdout.trim();
  if (guidance.length === 0) throw new Error(`${operation} returned no guidance`);
  return guidance.length <= maxBytes ? guidance : `${guidance.slice(0, maxBytes - 1)}…`;
}

async function readLavishGuides(
  run: CommandRunner,
  cwd: string,
  repository: string,
  objective: string,
  artifacts: readonly string[],
  timeoutMs: number | undefined,
): Promise<string> {
  const help = await readLavishGuide(
    run,
    cwd,
    ["lavish-axi", "--help"],
    timeoutMs,
    "lavish-axi --help",
    MAX_HELP_BYTES,
  );
  const sections: string[] = [`Installed lavish-axi --help guidance:\n${help}`];
  let playbookBytes = 0;
  for (const id of selectPlaybookIds(objective, artifacts)) {
    if (playbookBytes >= MAX_TOTAL_PLAYBOOK_BYTES) break;
    const guide = await readLavishGuide(
      run,
      cwd,
      ["lavish-axi", "playbook", id],
      timeoutMs,
      `lavish-axi playbook ${id}`,
      Math.min(MAX_PLAYBOOK_BYTES, MAX_TOTAL_PLAYBOOK_BYTES - playbookBytes),
    );
    sections.push(`Required ${id} playbook guidance:\n${guide}`);
    playbookBytes += guide.length;
  }

  if (!(await projectHasDesignSystem(repository)) && !hasExplicitDesignDirection(objective)) {
    const design = await readLavishGuide(
      run,
      cwd,
      ["lavish-axi", "design"],
      timeoutMs,
      "lavish-axi design",
      MAX_DESIGN_BYTES,
    );
    sections.push(
      `Fallback design guidance (the subject project has no detected design system):\n${design}`,
    );
  } else {
    sections.push(
      "The subject project has an explicit or detected design direction. Preserve it instead of replacing it with a generic design system.",
    );
  }
  return sections.join("\n\n");
}

function buildDrawBrief(
  task: TaskRecord,
  objective: string,
  artifacts: readonly string[],
  artifactPath: string,
  guidance: Readonly<{ mockup: boolean; text: string }>,
): string {
  const brief = [
    "Tandem: the user wants a visual built on your research. Draw it now.",
    `What to show:\n${boundedText(objective, "objective", MAX_OBJECTIVE_BYTES)}`,
    `Write the complete HTML to exactly ${artifactPath}. Its folder is the only place you can write; do not change the repository.`,
    "To use an image, font, or other file from the repository, copy it into that folder with copy_asset and reference it by relative path (./name). Never embed a path to the repository.",
    "Do not open Lavish or call submit_report. Tandem opens the page when your turn ends, and the user's comments on it come back to you in this conversation.",
    "When you finish, reply with one short line saying what you drew.",
    ...(guidance.mockup
      ? [
          "Before writing any screen copy, read the project's AGENTS.md and CLAUDE.md for writing, copy, or design rules and the files they name; those rules win over the mockup style guide where they conflict.",
          `Mockup style guide (follow it exactly):\n${guidance.text}`,
        ]
      : [
          "Follow every matching Lavish playbook guide below. Tandem retrieved them for you; do not run Lavish commands.",
          `Lavish guidance:\n${guidance.text}`,
          ...(task.acceptanceCriteria.length === 0
            ? []
            : [
                `The research questions it should help answer:\n${boundedList(
                  task.acceptanceCriteria,
                  "task.acceptanceCriteria",
                )
                  .map((criterion) => `- ${criterion}`)
                  .join("\n")}`,
              ]),
        ]),
    ...(artifacts.length === 0
      ? []
      : [`Supporting files:\n${artifacts.map((artifact) => `- ${artifact}`).join("\n")}`]),
    ...taskGuidance(task),
  ].join("\n\n");
  if (brief.length > MAX_BRIEF_BYTES) {
    throw new Error("presentation brief exceeded the bounded prompt limit");
  }
  return brief;
}

/** The request that sends the user's Lavish comments back to the agent that drew the page. */
export function buildRevisionBrief(artifactPath: string, feedback: string): string {
  return [
    "Tandem: the user commented on your visual in Lavish:",
    boundedText(feedback, "feedback", MAX_BRIEF_BYTES - 1_000),
    `Update ${artifactPath} in place to address it; keep the same file so the open tab reloads. Keep everything they did not ask to change. Use copy_asset for any repository file you need.`,
    "When you finish, reply with one short line saying what you changed.",
  ].join("\n\n");
}

async function verifyArtifact(paths: ValidatedRecordPaths): Promise<void> {
  const cwdStat = await lstat(paths.cwd);
  if (cwdStat.isSymbolicLink() || !cwdStat.isDirectory()) {
    throw new Error("presentation cwd is not a regular private directory");
  }
  const artifactStat = await lstat(paths.artifactPath);
  if (artifactStat.isSymbolicLink() || !artifactStat.isFile() || artifactStat.size === 0) {
    throw new Error("presentation artifact must be a nonempty regular file, not a symlink");
  }
  const [realCwd, realArtifact] = await Promise.all([
    realpath(paths.cwd),
    realpath(paths.artifactPath),
  ]);
  if (!isWithin(realCwd, realArtifact)) {
    throw new Error("presentation artifact resolves outside the private artifact directory");
  }
}

function isAbortLike(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return (
    isRecord(error) &&
    (error.name === "AbortError" ||
      error.name === "CommandAbortedError" ||
      error.code === "ABORT_ERR")
  );
}

function isPollTimeout(error: unknown): boolean {
  if (!isRecord(error) || error.name !== "CommandTimeoutError") return false;
  const request = error.request;
  if (!isRecord(request) || !Array.isArray(request.argv)) return false;
  return request.argv[0] === "lavish-axi" && request.argv[1] === "poll";
}

function signalRunner(run: CommandRunner, signal: AbortSignal | undefined): CommandRunner {
  if (signal === undefined) return run;
  return async (request) => {
    if (signal.aborted)
      throw signal.reason ?? new Error("presentation feedback poll was cancelled");
    return run({ ...request, signal });
  };
}

/**
 * Creates the private folder and the draw request for the research agent whose live job is
 * `agent`. The agent writes the HTML; Tandem opens it once the agent's turn ends.
 */
export async function preparePresentation(input: {
  readonly task: TaskRecord;
  readonly id: string;
  readonly requestId: string;
  readonly directory: string;
  readonly objective: string;
  readonly artifacts: readonly string[];
  readonly agent: PresentationAgent;
  readonly now: string;
  readonly timeoutMs?: number;
  readonly run: CommandRunner;
}): Promise<PresentationRecord> {
  const run = readRunner(input.run);
  const id = readSingleLine(input.id, "id");
  const objective = boundedText(input.objective, "objective", MAX_OBJECTIVE_BYTES);
  const artifacts = boundedList(input.artifacts, "artifacts");
  const now = readSingleLine(input.now, "now");
  const timeoutMs =
    input.timeoutMs === undefined ? undefined : readPositiveInteger(input.timeoutMs, "timeoutMs");
  if (!isRecord(input.task)) throw new TypeError("task must be a TaskRecord");
  const taskId = readSingleLine(input.task.id, "task.id");
  const generation = readNonNegativeInteger(input.task.generation, "task.generation");
  const directory = readAbsolutePath(input.directory, "directory");
  const repository = readAbsolutePath(input.task.repoPath, "task.repoPath");
  await ensurePrivateDirectory(directory, repository);

  const artifactPath = join(directory, ARTIFACT_FILE);
  const briefPath = join(directory, DRAW_BRIEF_FILE);
  const mockup = isMockup(objective);
  const guidance = {
    mockup,
    text: mockup
      ? (await readFile(MOCKUP_STYLE_PATH, "utf8")).trim()
      : await readLavishGuides(run, directory, repository, objective, artifacts, timeoutMs),
  };
  const brief = buildDrawBrief(input.task, objective, artifacts, artifactPath, guidance);
  await assertFreshPresentationEntries(directory);
  await writeFile(briefPath, brief, { flag: "wx", mode: 0o600 });
  return {
    id,
    taskId,
    generation,
    cwd: directory,
    artifactPath,
    objective,
    agent: input.agent,
    request: {
      id: readSingleLine(input.requestId, "requestId"),
      kind: "draw",
      briefPath,
      requestedAt: now,
    },
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

/** Writes one revision request next to the page, for the agent to read as its next turn. */
export async function writeRevisionBrief(
  record: PresentationRecord,
  requestId: string,
  feedback: string,
): Promise<string> {
  const paths = validateRecord(record);
  const id = readSingleLine(requestId, "requestId");
  if (!/^[A-Za-z0-9-]+$/u.test(id)) throw new TypeError("requestId must be a plain id");
  const briefPath = join(paths.cwd, `revision-${id}.md`);
  await writeFile(briefPath, buildRevisionBrief(paths.artifactPath, feedback), {
    flag: "wx",
    mode: 0o600,
  });
  return briefPath;
}

/** Checks the agent's page and opens it in Lavish the first time. */
export async function openDrawnPresentation(input: {
  readonly record: PresentationRecord;
  readonly now: string;
  readonly run: CommandRunner;
}): Promise<PresentationRecord> {
  const run = readRunner(input.run);
  const paths = validateRecord(input.record);
  const now = readSingleLine(input.now, "now");
  try {
    await verifyArtifact(paths);
  } catch {
    return failedRecord(
      input.record,
      now,
      "The research agent finished without writing the page; its pane shows what it said.",
    );
  }
  try {
    const observation = await openPresentation(run, paths.artifactPath, paths.cwd);
    const status = statusForObservation(observation);
    const observationFailure = observationError(observation);
    const base = clearRecordError(input.record);
    const sessionUrl = observation.sessionUrl ?? input.record.sessionUrl;
    return {
      ...base,
      status,
      updatedAt: now,
      ...(sessionUrl === undefined ? {} : { sessionUrl }),
      ...(observationFailure === undefined ? {} : { error: observationFailure }),
      observation,
    };
  } catch (error) {
    return failedRecord(input.record, now, error);
  }
}

export async function readPresentationFeedback(input: {
  readonly record: PresentationRecord;
  readonly clock: Clock;
  readonly run: CommandRunner;
  readonly signal?: AbortSignal;
  readonly continuous?: boolean;
}): Promise<PresentationRecord> {
  const run = readRunner(input.run);
  const clock = readClock(input.clock);
  const paths = validateRecord(input.record);
  if (input.record.status === "ended" || input.record.status === "failed") return input.record;
  if (input.record.status !== "open") {
    throw new Error(
      `presentation feedback requires an open presentation, not ${input.record.status}`,
    );
  }
  if (input.signal?.aborted === true) return input.record;
  try {
    const observation =
      input.continuous === true
        ? await listenPresentation(signalRunner(run, input.signal), paths.artifactPath, paths.cwd)
        : await pollPresentation(signalRunner(run, input.signal), paths.artifactPath, paths.cwd);
    const updatedAt = readSingleLine(clock(), "clock()");
    const status = statusForObservation(observation);
    const observationFailure = observationError(observation);
    const base = clearRecordError(input.record);
    const sessionUrl = observation.sessionUrl ?? input.record.sessionUrl;
    return {
      ...base,
      status,
      updatedAt,
      ...(sessionUrl === undefined ? {} : { sessionUrl }),
      ...(observationFailure === undefined ? {} : { error: observationFailure }),
      observation,
    };
  } catch (error) {
    if (isAbortLike(error, input.signal) || (!input.continuous && isPollTimeout(error))) {
      return input.record;
    }
    return failedRecord(input.record, readSingleLine(clock(), "clock()"), error);
  }
}
