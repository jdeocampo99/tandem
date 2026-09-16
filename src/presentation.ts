import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  listenPresentation,
  openPresentation,
  type PresentationObservation,
  pollPresentation,
} from "./adapters.ts";
import type {
  Clock,
  CommandRequest,
  CommandRunner,
  Endpoint,
  NotificationKind,
  TaskRecord,
} from "./contracts.ts";
import { buildAgentBrief } from "./instructions.ts";
import { parseWorkerResult, type WorkerJob, type WorkerResult } from "./jobs.ts";

export type { PresentationObservation } from "./adapters.ts";

export type PendingPresentationNotification = Readonly<{
  readonly id: string;
  readonly message: string;
  readonly kind: NotificationKind;
}>;

export type PresentationRecord = Readonly<{
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly cwd: string;
  readonly artifactPath: string;
  readonly jobPath: string;
  readonly resultPath: string;
  readonly status: "queued" | "running" | "open" | "ended" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endpoint?: Endpoint;
  readonly sessionUrl?: string;
  readonly observation?: PresentationObservation;
  readonly pendingNotification?: PendingPresentationNotification;
  readonly pendingNotificationQueue?: readonly PendingPresentationNotification[];
  readonly error?: string;
}>;

export type PresentationFeedbackEvidence = Readonly<{
  readonly schemaVersion: 1;
  readonly presentationId: string;
  readonly eventId: string;
  readonly observedAt: string;
  readonly observation: PresentationObservation;
}>;

type ValidatedRecordPaths = Readonly<{
  readonly cwd: string;
  readonly artifactPath: string;
  readonly jobPath: string;
  readonly resultPath: string;
}>;

const ARTIFACT_FILE = "artifact.html";
const JOB_FILE = "job.json";
const RESULT_FILE = "result.json";
const FEEDBACK_DIRECTORY = "feedback";
const PRIVATE_ENTRY_NAMES = [ARTIFACT_FILE, JOB_FILE, RESULT_FILE] as const;
const MAX_HELP_BYTES = 8_000;
const MAX_PLAYBOOK_BYTES = 2_000;
const MAX_TOTAL_PLAYBOOK_BYTES = 6_000;
const MAX_DESIGN_BYTES = 2_000;
const MAX_BRIEF_BYTES = 32_000;
const MAX_NOTIFICATION_BYTES = 4_000;
const MAX_GUIDANCE_BYTES = 2_000;
const MAX_TOTAL_GUIDANCE_BYTES = 4_000;
const MAX_OBJECTIVE_BYTES = 3_000;
const MAX_ENTRY_BYTES = 256;
const MAX_LIST_ENTRIES = 12;
const HELP_TIMEOUT_MS = 30_000;

type PlaybookRule = Readonly<{
  readonly id: string;
  readonly terms: readonly string[];
}>;

const PLAYBOOK_RULES: readonly PlaybookRule[] = [
  { id: "diagram", terms: ["diagram", "flow", "architecture", "relationship", "state machine"] },
  { id: "table", terms: ["table", "records", "matrix", "dense"] },
  { id: "comparison", terms: ["comparison", "compare", "tradeoff", "options", "before and after"] },
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

function readText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be non-empty text without NUL characters`);
  }
  return value.trim();
}

function readSingleLine(value: unknown, field: string): string {
  const text = readText(value, field);
  if (/[\r\n\u2028\u2029]/u.test(text)) throw new TypeError(`${field} must be a single-line value`);
  return text;
}

function readAbsolutePath(value: unknown, field: string): string {
  const path = readSingleLine(value, field);
  if (!isAbsolute(path)) throw new TypeError(`${field} must be an absolute path`);
  return resolve(path);
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

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return String(error);
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.startsWith("../") && !isAbsolute(relativePath))
  );
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

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    // Hard-linking publishes atomically and refuses an occupied destination.
    await link(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
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

function buildPresentationPrompt(
  task: TaskRecord,
  objective: string,
  artifacts: readonly string[],
  artifactPath: string,
  repository: string,
  lavishGuidance: string,
): string {
  const instructions = [
    "You are the restricted presentation worker. Author the HTML artifact, but do not open or poll Lavish yourself.",
    "The controller—not the restricted worker—opens Lavish after verifying the artifact and keeps a single tracked background feedback poll for each open presentation; feedback is an observation, never approval.",
    `Write complete, useful HTML at exactly ${artifactPath}; do not write it to another path and do not modify the repository.`,
    "Use only read, grep, glob, write, and edit. Bash is not available or permitted.",
    `Subject project design source: ${repository}. Inspect and preserve its existing styles, tokens, components, and brand assets when present; do not replace them with a generic system.`,
    "Follow every matching Lavish playbook guide below before authoring HTML. The controller retrieved these guides; do not run unavailable Lavish commands.",
    `Controller-retrieved Lavish guidance:\n${lavishGuidance}`,
    ...taskGuidance(task),
  ];
  const prompt = buildAgentBrief({
    role: "presentation",
    objective: boundedText(objective, "objective", MAX_OBJECTIVE_BYTES),
    acceptanceCriteria: boundedList(task.acceptanceCriteria, "task.acceptanceCriteria"),
    instructions,
    reportPath: artifactPath,
    artifacts: boundedList([...artifacts, repository], "artifacts"),
  });
  if (prompt.length > MAX_BRIEF_BYTES) {
    throw new Error("presentation worker brief exceeded the bounded prompt limit");
  }
  return prompt;
}

function validateRecordPaths(record: PresentationRecord): ValidatedRecordPaths {
  const cwd = readAbsolutePath(record.cwd, "record.cwd");
  const artifactPath = readAbsolutePath(record.artifactPath, "record.artifactPath");
  const jobPath = readAbsolutePath(record.jobPath, "record.jobPath");
  const resultPath = readAbsolutePath(record.resultPath, "record.resultPath");
  if (!isWithin(cwd, artifactPath) || !isWithin(cwd, jobPath) || !isWithin(cwd, resultPath)) {
    throw new Error("presentation paths must remain inside the private artifact directory");
  }
  return { cwd, artifactPath, jobPath, resultPath };
}

function validateRecord(record: PresentationRecord): ValidatedRecordPaths {
  if (!isRecord(record)) throw new TypeError("record must be a PresentationRecord");
  readSingleLine(record.id, "record.id");
  readSingleLine(record.taskId, "record.taskId");
  if (!Number.isSafeInteger(record.generation) || record.generation < 0) {
    throw new TypeError("record.generation must be a non-negative integer");
  }
  const statuses: readonly PresentationRecord["status"][] = [
    "queued",
    "running",
    "open",
    "ended",
    "failed",
  ];
  if (!statuses.includes(record.status)) throw new TypeError("record.status is unsupported");
  readSingleLine(record.createdAt, "record.createdAt");
  readSingleLine(record.updatedAt, "record.updatedAt");
  if (record.sessionUrl !== undefined) readSingleLine(record.sessionUrl, "record.sessionUrl");
  const pendingNotifications = [
    ...(record.pendingNotification === undefined ? [] : [record.pendingNotification]),
    ...(record.pendingNotificationQueue ?? []),
  ];
  for (const pending of pendingNotifications) {
    readSingleLine(pending.id, "record pending notification id");
    readText(pending.message, "record pending notification message");
    if (pending.kind !== "routine" && pending.kind !== "coordinator") {
      throw new TypeError("record pending notification kind is unsupported");
    }
  }
  if (record.error !== undefined) readText(record.error, "record.error");
  return validateRecordPaths(record);
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

function statusForObservation(observation: PresentationObservation): PresentationRecord["status"] {
  if (observation.status === "error" || observation.status === "missing") return "failed";
  if (observation.terminal || observation.status === "ended" || observation.status === "user-ended")
    return "ended";
  return "open";
}

function observationError(observation: PresentationObservation): string | undefined {
  if (observation.status !== "error" && observation.status !== "missing") return undefined;
  return observation.raw.trim().length > 0
    ? observation.raw
    : `Lavish presentation reported ${observation.status}`;
}

function failedRecord(record: PresentationRecord, now: string, error: unknown): PresentationRecord {
  return {
    ...record,
    status: "failed",
    updatedAt: now,
    error: describeError(error),
  };
}

function clearRecordError(record: PresentationRecord): Omit<PresentationRecord, "error"> {
  const { error: _error, ...withoutError } = record;
  return withoutError;
}
function feedbackEvidencePath(record: PresentationRecord, eventId: string): string {
  const paths = validateRecord(record);
  const safeEventId = readSingleLine(eventId, "eventId");
  if (!/^[A-Za-z0-9._-]+$/u.test(safeEventId)) {
    throw new TypeError(
      "eventId must contain only letters, numbers, dots, underscores, or hyphens",
    );
  }
  return join(paths.cwd, FEEDBACK_DIRECTORY, `${safeEventId}.json`);
}

export async function writePresentationFeedbackEvidence(input: {
  readonly record: PresentationRecord;
  readonly eventId: string;
  readonly observedAt: string;
  readonly observation: PresentationObservation;
}): Promise<string> {
  const eventId = readSingleLine(input.eventId, "eventId");
  const observedAt = readSingleLine(input.observedAt, "observedAt");
  const path = feedbackEvidencePath(input.record, eventId);
  const evidence: PresentationFeedbackEvidence = {
    schemaVersion: 1,
    presentationId: input.record.id,
    eventId,
    observedAt,
    observation: input.observation,
  };
  await writePrivateJson(path, evidence);
  return path;
}

function boundedNotificationText(value: string, limit = MAX_NOTIFICATION_BYTES): string {
  const normalized = value.trim();
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (normalized.length <= boundedLimit) return normalized;
  const suffix = "…";
  if (boundedLimit <= suffix.length) return normalized.slice(0, boundedLimit);
  return `${normalized.slice(0, boundedLimit - suffix.length)}${suffix}`;
}

export function presentationNotificationForTransition(
  previous: PresentationRecord,
  next: PresentationRecord,
  feedbackEvidencePath?: string,
): Pick<PendingPresentationNotification, "message" | "kind"> | undefined {
  const previousObservation = previous.observation;
  const observation = next.observation;
  if (next.status === "failed") {
    if (previous.status === "failed" && previous.error === next.error) return undefined;
    const detail = boundedNotificationText(
      next.error ?? "the presentation controller reported an error",
    );
    return {
      message: `Presentation ${next.id} failed: ${detail}`,
      kind: "coordinator",
    };
  }
  if (observation === undefined) return undefined;
  if (observation.status === "feedback") {
    const terminalSuffix = next.status === "ended" ? " and the session ended" : "";
    const prefix =
      feedbackEvidencePath === undefined
        ? `Presentation ${next.id} received feedback${terminalSuffix}:`
        : `${feedbackEvidencePath} — Presentation ${next.id} feedback evidence${terminalSuffix}:`;
    const excerptLimit =
      feedbackEvidencePath === undefined
        ? MAX_NOTIFICATION_BYTES
        : MAX_NOTIFICATION_BYTES - prefix.length - 1;
    const feedback = boundedNotificationText(observation.rawFeedback, excerptLimit);
    if (feedbackEvidencePath !== undefined) {
      return {
        message: feedback.length === 0 ? prefix : `${prefix}\n${feedback}`,
        kind: "coordinator",
      };
    }
    if (feedback.length > 0) {
      return {
        message: `${prefix}\n${feedback}`,
        kind: "coordinator",
      };
    }
  }
  if (observation.status === "browser_disconnected") {
    if (
      previousObservation?.status === "browser_disconnected" &&
      previousObservation.raw === observation.raw
    )
      return undefined;
    const location = next.sessionUrl === undefined ? "" : ` at ${next.sessionUrl}`;
    const base = `Presentation ${next.id} lost its browser connection${location}; it remains resumable and was not reopened.`;
    const raw = boundedNotificationText(observation.raw);
    return {
      message: raw.length === 0 ? base : `${base}\n${raw}`,
      kind: "coordinator",
    };
  }
  if (
    observation.status === "opened" ||
    observation.status === "ready" ||
    observation.status === "user-ended"
  ) {
    if (
      previousObservation?.status === observation.status &&
      previousObservation.raw === observation.raw
    )
      return undefined;
    const detail =
      observation.status === "user-ended"
        ? "was ended by the user; no reopen was attempted."
        : next.sessionUrl === undefined
          ? "is ready."
          : `is ready at ${next.sessionUrl}.`;
    const raw = boundedNotificationText(observation.raw);
    return {
      message:
        raw.length === 0
          ? `Presentation ${next.id} ${detail}`
          : `Presentation ${next.id} ${detail}\n${raw}`,
      kind: "routine",
    };
  }
  if (next.status !== "ended") return undefined;
  if (
    previous.status === "ended" &&
    previousObservation?.status === observation.status &&
    previousObservation.raw === observation.raw
  )
    return undefined;
  return {
    message:
      next.sessionUrl === undefined
        ? `Presentation ${next.id} ended.`
        : `Presentation ${next.id} ended at ${next.sessionUrl}.`,
    kind: "routine",
  };
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

export async function preparePresentation(input: {
  readonly task: TaskRecord;
  readonly id: string;
  readonly directory: string;
  readonly objective: string;
  readonly artifacts: readonly string[];
  readonly now: string;
  readonly timeoutMs?: number;
  readonly run: CommandRunner;
}): Promise<{ readonly record: PresentationRecord; readonly job: WorkerJob }> {
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
  const jobPath = join(directory, JOB_FILE);
  const resultPath = join(directory, RESULT_FILE);
  const lavishGuidance = await readLavishGuides(
    run,
    directory,
    repository,
    objective,
    artifacts,
    timeoutMs,
  );
  const prompt = buildPresentationPrompt(
    input.task,
    objective,
    artifacts,
    artifactPath,
    repository,
    lavishGuidance,
  );
  const model = input.task.policy.config.models.presentation;
  const job: WorkerJob = {
    schemaVersion: 1,
    id,
    taskId,
    generation,
    role: "presentation",
    cwd: directory,
    model: { model: model.model, thinking: model.thinking },
    prompt,
    resultPath,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const record: PresentationRecord = {
    id,
    taskId,
    generation,
    cwd: directory,
    artifactPath,
    jobPath,
    resultPath,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await assertFreshPresentationEntries(directory);
  await writePrivateJson(jobPath, job);
  return { record, job };
}

export async function completePresentation(input: {
  readonly record: PresentationRecord;
  readonly result: WorkerResult;
  readonly now: string;
  readonly run: CommandRunner;
}): Promise<PresentationRecord> {
  const run = readRunner(input.run);
  const paths = validateRecord(input.record);
  const now = readSingleLine(input.now, "now");
  if (input.record.status !== "queued" && input.record.status !== "running") {
    throw new Error(
      `presentation completion requires a queued or running record, not ${input.record.status}`,
    );
  }
  const result = parseWorkerResult(input.result);
  if (
    result.id !== input.record.id ||
    result.taskId !== input.record.taskId ||
    result.generation !== input.record.generation ||
    result.role !== "presentation"
  ) {
    throw new Error("presentation worker result identity does not match the presentation record");
  }
  if (result.status !== "completed") {
    return failedRecord(
      input.record,
      now,
      result.error ?? `presentation worker returned ${result.status}`,
    );
  }
  if (result.artifactPath !== paths.artifactPath) {
    throw new Error(
      "presentation worker result artifact does not match the expected artifact path",
    );
  }
  await verifyArtifact(paths);

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
