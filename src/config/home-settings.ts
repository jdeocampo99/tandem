import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeTextAtomically } from "../runtime/persistence.ts";
import { isNotFoundError } from "./storage.ts";
import { assertKnownKeys, deduplicateStrings, isRecord, readNonEmptyString } from "./values.ts";

/**
 * Settings for everything in one Tandem home, from `<home>/settings.toml`. They are read live on
 * each use and never pinned to a task; an absent file means every default.
 */
export type HomeSettings = Readonly<{
  /** Personal skills every task carries, looked up and pinned like skills named at create. */
  readonly workerSkills: readonly string[];
  /** Whether `workerSkills` is written at all, even empty: the user already chose, so don't offer. */
  readonly workerSkillsChosen: boolean;
}>;

const HOME_SETTINGS_FILE = "settings.toml";
const HOME_SETTINGS_KEYS: Readonly<Record<string, true>> = {
  workerSkills: true,
};

export async function readHomeSettings(home: string): Promise<HomeSettings> {
  const file = join(home, HOME_SETTINGS_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return { workerSkills: [], workerSkillsChosen: false };
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
    workerSkills: readNameList(parsed.workerSkills, `${source} workerSkills`),
    workerSkillsChosen: parsed.workerSkills !== undefined,
  };
}

/**
 * Saves the user's answer to "give tasks these skills?" as `workerSkills`, an empty list for no,
 * so it is never offered again. It only adds the setting: one the user already wrote is left
 * alone, and a file changed since it was read is not written.
 */
export async function saveWorkerSkills(
  home: string,
  skills: readonly string[],
): Promise<HomeSettings> {
  const file = join(home, HOME_SETTINGS_FILE);
  const line = `workerSkills = [${skills.map((skill) => JSON.stringify(readNonEmptyString(skill, "skill"))).join(", ")}]\n`;
  let before: string | undefined;
  try {
    before = await readFile(file, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  if (before === undefined) {
    const created = `# Tandem settings for every project in this home.\n${line}`;
    await writeFile(file, created, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return parseHomeSettings(created, file);
  }
  if (parseHomeSettings(before, file).workerSkillsChosen) {
    throw new Error(`${file} already lists workerSkills; edit it there.`);
  }
  // Keys go before any table, so the new one goes first.
  const after = `${line}${before}`;
  const saved = parseHomeSettings(after, file);
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
