import { lstatSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { TerminalName } from "../contracts.ts";
import { writeTextAtomically } from "../runtime/persistence.ts";
import { isNotFoundError } from "./storage.ts";
import { assertKnownKeys, deduplicateStrings, isRecord, readNonEmptyString } from "./values.ts";

/**
 * Settings for everything in one Tandem home, from `<home>/settings.toml`. They are read live on
 * each use and never pinned to a task; an absent file means every default.
 */
export type HomeSettings = Readonly<{
  /** Absent means Tern; only an explicit `terminal = "herdr"` selects Herdr. */
  readonly terminal?: TerminalName;
  /** What Tandem does when it looks into its own problems; see {@link SelfImprovementMode}. */
  readonly selfImprovement: SelfImprovementMode;
  /** Whether `selfImprovement` is written at all: the user already chose, so don't ask. */
  readonly selfImprovementChosen: boolean;
  /** Folders the user keeps code in, searched for checkouts by name; absolute paths. */
  readonly projectRoots: readonly string[];
}>;

/**
 * `off` never looks into Tandem's own problems. `fix` investigates, then fixes Tandem through the
 * normal brief, approval, and pull request loop. `report` investigates, then drafts a GitHub issue
 * for the user to approve, for machines that must not push code. Only the user chooses it, by hand
 * or when onboarding asks: push rights on GitHub say nothing about whether this machine may push.
 */
export type SelfImprovementMode = "off" | "fix" | "report";

const SELF_IMPROVEMENT_MODES: readonly SelfImprovementMode[] = ["off", "fix", "report"];

const HOME_SETTINGS_FILE = "settings.toml";
const HOME_SETTINGS_KEYS: Readonly<Record<string, true>> = {
  // Kept for backwards-compatible decoding. Older homes may still contain this inert key.
  workerSkills: true,
  selfImprovement: true,
  projectRoots: true,
  terminal: true,
};

export async function readHomeSettings(home: string): Promise<HomeSettings> {
  const file = join(home, HOME_SETTINGS_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        selfImprovement: "off",
        selfImprovementChosen: false,
        projectRoots: [],
      };
    }
    throw error;
  }
  return parseHomeSettings(text, file);
}

function parseHomeSettings(text: string, source: string): HomeSettings {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new TypeError(
      `${source} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new TypeError(`${source} must be a TOML table`);
  assertKnownKeys(parsed, HOME_SETTINGS_KEYS, source);
  return {
    ...(parsed.terminal === undefined ? {} : { terminal: readTerminalName(parsed.terminal) }),
    selfImprovement: readSelfImprovement(parsed.selfImprovement, `${source} selfImprovement`),
    selfImprovementChosen: parsed.selfImprovement !== undefined,
    projectRoots: readAbsolutePaths(parsed.projectRoots, `${source} projectRoots`),
  };
}

/** Saves where the user keeps code, replacing the folders saved before. */
export async function saveProjectRoots(
  home: string,
  roots: readonly string[],
): Promise<HomeSettings> {
  const paths = roots.map((root, index) => {
    const path = readNonEmptyString(root, `projectRoots[${index}]`);
    if (!isAbsolute(path)) throw new TypeError(`projectRoots[${index}] must be an absolute path`);
    return JSON.stringify(path);
  });
  return saveHomeSetting(home, "projectRoots", `[${paths.join(", ")}]`);
}

/** Saves the self-improvement mode the user chose. */
export async function saveSelfImprovement(
  home: string,
  mode: SelfImprovementMode,
): Promise<HomeSettings> {
  return saveHomeSetting(
    home,
    "selfImprovement",
    JSON.stringify(readSelfImprovement(mode, "mode")),
  );
}

/**
 * Sets one top-level key: a one-line value already there is replaced in place, and a missing key
 * goes first, before any table. A value written over several lines, or a file changed since it was
 * read, is left alone with a reason.
 */
async function saveHomeSetting(home: string, key: string, value: string): Promise<HomeSettings> {
  const file = join(home, HOME_SETTINGS_FILE);
  const line = `${key} = ${value}`;
  let before: string | undefined;
  try {
    before = await readFile(file, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  if (before === undefined) {
    const created = `# Tandem settings for every project in this home.\n${line}\n`;
    const saved = parseHomeSettings(created, file);
    await writeFile(file, created, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return saved;
  }
  const pattern = new RegExp(`^${key}\\s*=.*$`, "mu");
  const after = pattern.test(before) ? before.replace(pattern, line) : `${line}\n${before}`;
  let saved: HomeSettings;
  try {
    saved = parseHomeSettings(after, file);
  } catch {
    throw new Error(`${file} writes ${key} over several lines; edit it there.`);
  }
  if ((await readFile(file, "utf8")) !== before) {
    throw new Error(`${file} changed while saving; nothing was written. Try again.`);
  }
  await writeTextAtomically(file, after);
  return saved;
}

function readNameList(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of names`);
  return deduplicateStrings(
    value.map((entry: unknown, index) => readNonEmptyString(entry, `${field}[${index}]`)),
  );
}

function readAbsolutePaths(value: unknown, field: string): readonly string[] {
  const paths = readNameList(value, field);
  const relative = paths.find((path) => !isAbsolute(path));
  if (relative !== undefined) throw new TypeError(`${field} must hold absolute paths`);
  return paths;
}

function readSelfImprovement(value: unknown, field: string): SelfImprovementMode {
  if (value === undefined) return "off";
  const mode = SELF_IMPROVEMENT_MODES.find((candidate) => candidate === value);
  if (mode === undefined) throw new TypeError(`${field} must be "off", "fix", or "report"`);
  return mode;
}

/** Synchronous composition roots select the terminal before creating any service or pane. */
export function readHomeSettingsSync(home: string): HomeSettings {
  const file = join(home, HOME_SETTINGS_FILE);
  try {
    if (!lstatSync(file).isFile()) throw new Error(`${file} must be a regular settings file`);
    return parseHomeSettings(readFileSync(file, "utf8"), file);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    return { selfImprovement: "off", selfImprovementChosen: false, projectRoots: [] };
  }
}

export function readTerminalName(value: unknown): TerminalName {
  if (value === "herdr" || value === "tern") return value;
  throw new TypeError('terminal must be "herdr" or "tern"');
}

/** Caller holds the state lock and proves no active task or owned operation spans the switch. */
export async function saveTerminalChoice(
  home: string,
  terminal: TerminalName,
): Promise<HomeSettings> {
  return saveHomeSetting(home, "terminal", JSON.stringify(readTerminalName(terminal)));
}
