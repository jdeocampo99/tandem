import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "./storage.ts";
import { assertKnownKeys, deduplicateStrings, isRecord, readNonEmptyString } from "./values.ts";

/**
 * Settings for everything in one Tandem home, from `<home>/settings.toml`. They are read live on
 * each use and never pinned to a task; an absent file means every default.
 */
export type HomeSettings = Readonly<{
  /** Personal skills every task carries, looked up and pinned like skills named at create. */
  readonly workerSkills: readonly string[];
}>;

const HOME_SETTINGS_FILE = "settings.toml";
const HOME_SETTINGS_KEYS: Readonly<Record<string, true>> = { workerSkills: true };

export async function readHomeSettings(home: string): Promise<HomeSettings> {
  const file = join(home, HOME_SETTINGS_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return { workerSkills: [] };
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
  return { workerSkills: readNameList(parsed.workerSkills, `${source} workerSkills`) };
}

function readNameList(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of names`);
  return deduplicateStrings(
    value.map((entry: unknown, index) => readNonEmptyString(entry, `${field}[${index}]`)),
  );
}
