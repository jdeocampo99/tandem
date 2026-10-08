import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isNotFoundError } from "../../config/storage.ts";
import type { IdFactory } from "../../contracts.ts";
import { StoreLockTimeoutError } from "../../tasks/store-errors.ts";
import { acquireDarwinFileLock } from "../../tasks/store-lock.ts";

export type TernPreferenceDependencies = Readonly<{
  env?: Readonly<Record<string, string>>;
  settingsPath?: string;
  print?: (text: string) => void;
  newId?: IdFactory;
}>;

const SETUP_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const SETUP_LOCK_POLL_MS = 50;

type TernPluginSettingsInput = Readonly<{
  path?: string;
  configDirectory?: string;
  newId?: IdFactory;
}>;

const TERN_PLUGIN_KEYS: Readonly<Record<string, string>> = {
  "cmd+shift+b": "plugin.tandem.board",
  "cmd+shift+p": "plugin.tandem.prs",
  "cmd+shift+u": "plugin.tandem.usage",
  "cmd+shift+,": "plugin.tandem.settings",
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      [`cmd+${index + 1}`, `plugin.tandem.project-${index + 1}`],
      [`cmd+digit_${index + 1}`, `plugin.tandem.project-${index + 1}`],
    ]).flat(),
  ),
  "cmd+shift+[": "plugin.tandem.project-prev",
  "cmd+shift+]": "plugin.tandem.project-next",
};

const ternSettingsSchema = z
  .object({
    keybinds: z.record(z.union([z.string(), z.array(z.string())])).optional(),
    tabs_autohide: z.boolean().optional(),
    keymap: z.enum(["tern", "ghostty", "kitty", "cmux", "tmux"]).optional(),
  })
  .passthrough();

const recordSchema = z
  .object({
    version: z.literal(1),
    keybindsExisted: z.boolean(),
    keys: z
      .array(z.object({ key: z.string(), installed: z.string() }).strict())
      .refine(
        (keys) =>
          new Set(keys.map(({ key }) => key)).size === keys.length &&
          keys.every(({ key, installed }) => TERN_PLUGIN_KEYS[key] === installed),
        "unknown shortcut change",
      ),
    sidebar: z
      .object({ previous: z.boolean().optional(), installed: z.literal(true) })
      .strict()
      .optional(),
  })
  .strict();

function settingsPath(input: TernPluginSettingsInput): string {
  return (
    input.path ??
    join(
      input.configDirectory ??
        process.env.TERN_CONFIG_DIR ??
        join(homedir(), "Library", "Application Support", "Tern"),
      "settings.json",
    )
  );
}

export function settingsInput(deps: TernPreferenceDependencies): TernPluginSettingsInput {
  return {
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
    ...(deps.settingsPath === undefined ? {} : { path: deps.settingsPath }),
    ...(deps.env?.TERN_CONFIG_DIR === undefined
      ? {}
      : { configDirectory: deps.env.TERN_CONFIG_DIR }),
  };
}

/**
 * Every Tandem home on this machine shares one Tern config directory, which holds both the plugin
 * links and the settings file, so the lock lives there rather than in any one Tandem home. Tern's
 * `plugin list` never creates that directory, so first-time setup creates it before locking; restore
 * only locks once its record exists there.
 */
export async function withSetupLock<T>(input: TernPluginSettingsInput, run: () => Promise<T>) {
  const directory = dirname(settingsPath(input));
  await mkdir(directory, { recursive: true });
  let release: () => Promise<void>;
  try {
    release = await acquireDarwinFileLock(
      join(directory, "tandem-setup.lock"),
      SETUP_LOCK_TIMEOUT_MS,
      SETUP_LOCK_POLL_MS,
    );
  } catch (error) {
    if (!(error instanceof StoreLockTimeoutError)) throw error;
    throw new Error(
      "Another Tandem process is setting up Tern and is likely waiting for an answer to its question about Tern's sidebar and shortcuts. Answer it there, then try again.",
      { cause: error },
    );
  }
  try {
    return await run();
  } finally {
    await release();
  }
}

function chord(key: string): string {
  return key
    .toLowerCase()
    .split(">")
    .map((part) => {
      const bits = part.split("+").map((bit) => {
        if (bit === "super") return "cmd";
        if (bit === "opt") return "alt";
        return bit;
      });
      const name = bits.pop();
      return [...bits.sort(), name?.replace(/^digit_([1-9])$/u, "$1")].join("+");
    })
    .join(">");
}

/** Preserves custom shortcuts, including aliases and sequences beginning with a requested chord. */
export function planTernPluginKeys(raw: string): Readonly<{
  text: string;
  changed: boolean;
  skipped: readonly string[];
  added: readonly string[];
  preset?: string;
}> {
  const settings = ternSettingsSchema.parse(JSON.parse(raw));
  if (settings.keymap !== undefined && settings.keymap !== "tern")
    return { text: raw, changed: false, skipped: [], added: [], preset: settings.keymap };
  const keybinds = { ...settings.keybinds };
  const skipped: string[] = [];
  const added: string[] = [];
  let changed = false;
  for (const [key, action] of Object.entries(TERN_PLUGIN_KEYS)) {
    const customized = Object.entries(settings.keybinds ?? {}).some(
      ([each, value]) =>
        (chord(each) === chord(key) && value !== action) ||
        chord(each).startsWith(`${chord(key)}>`),
    );
    if (customized) {
      skipped.push(key);
      continue;
    }
    if (keybinds[key] === action) continue;
    keybinds[key] = action;
    added.push(key);
    changed = true;
  }
  return {
    text: changed ? `${JSON.stringify({ ...settings, keybinds }, null, 2)}\n` : raw,
    changed,
    skipped,
    added,
  };
}

/** Human names for preserved shortcuts; collapse physical-key and character aliases. */
export function describeTernPluginKeys(keys: readonly string[]): string {
  return [
    ...new Set(
      keys.map((key) =>
        key
          .replace("digit_", "")
          .replace("cmd+", "Command+")
          .replace("shift+", "Shift+")
          .replace(/\+([a-z])$/u, (_, letter: string) => `+${letter.toUpperCase()}`),
      ),
    ),
  ].join(", ");
}

async function readPreferenceFile(
  path: string,
): Promise<Readonly<{ text: string; exists: boolean }>> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Tern settings must be a regular file");
    return { text: await readFile(path, "utf8"), exists: true };
  } catch (error) {
    if (isNotFoundError(error)) return { text: "{}", exists: false };
    throw error;
  }
}

/** Proof supplied by the writer before attempting its atomic commit. Other errors are uncertain. */
export class PreferenceWriteNotCommittedError extends Error {}

async function replacePreferenceFile(
  path: string,
  before: Readonly<{ text: string; exists: boolean }>,
  text: string,
  newId: IdFactory,
): Promise<void> {
  const temporary = `${path}.${newId()}.tmp`;
  let commitAttempted = false;
  try {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error("Tern config must be a regular directory");
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    const current = await readPreferenceFile(path);
    if (current.text !== before.text || current.exists !== before.exists)
      throw new Error("Tern settings changed while configuring preferences");
    commitAttempted = true;
    if (before.exists) await rename(temporary, path);
    else await link(temporary, path);
  } catch (error) {
    if (!commitAttempted)
      throw new PreferenceWriteNotCommittedError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

type ConfigureResult = Readonly<{
  configured: boolean;
  skipped: readonly string[];
  applied?: Readonly<{ sidebar: boolean; keys: boolean }>;
  preset?: string;
}>;

type PreferencePlan =
  | Readonly<{ status: "configured"; configured: boolean; skipped: readonly string[] }>
  | Readonly<{
      status: "apply";
      record: string;
      settings: string;
      applied: Readonly<{ sidebar: boolean; keys: boolean }>;
      preset?: string;
      skipped: readonly string[];
    }>;

type PreferenceEffects = Readonly<{
  replaceFile: (
    path: string,
    before: Readonly<{ text: string; exists: boolean }>,
    text: string,
  ) => Promise<void>;
}>;

export function planPreferences(
  settingsText: string,
  recordText: string | undefined,
): PreferencePlan {
  const plan = planTernPluginKeys(settingsText);
  if (recordText !== undefined) {
    const record = recordSchema.parse(JSON.parse(recordText));
    const current = ternSettingsSchema.parse(JSON.parse(settingsText));
    return {
      status: "configured",
      configured:
        record.keys.every(({ key, installed }) => current.keybinds?.[key] === installed) &&
        (!record.sidebar || current.tabs_autohide === record.sidebar.installed),
      skipped: plan.skipped,
    };
  }
  const settings = ternSettingsSchema.parse(JSON.parse(plan.text));
  const sidebar = settings.tabs_autohide !== true;
  if (!plan.changed && !sidebar)
    return { status: "configured", configured: true, skipped: plan.skipped };
  const record = recordSchema.parse({
    version: 1,
    keybindsExisted: ternSettingsSchema.parse(JSON.parse(settingsText)).keybinds !== undefined,
    keys: plan.added.map((key) => ({ key, installed: TERN_PLUGIN_KEYS[key] })),
    ...(sidebar ? { sidebar: { previous: settings.tabs_autohide, installed: true } } : {}),
  });
  if (sidebar) settings.tabs_autohide = true;
  return {
    status: "apply",
    record: `${JSON.stringify(record, null, 2)}\n`,
    settings: `${JSON.stringify(settings, null, 2)}\n`,
    applied: { sidebar, keys: plan.added.length > 0 },
    ...(plan.preset ? { preset: plan.preset } : {}),
    skipped: plan.skipped,
  };
}

export async function applyPreferences(
  plan: Extract<PreferencePlan, { status: "apply" }>,
  effects: Readonly<{
    saveRecord: (text: string) => Promise<void>;
    saveSettings: (text: string) => Promise<void>;
    discardRecord: (text: string) => Promise<void>;
  }>,
): Promise<ConfigureResult> {
  await effects.saveRecord(plan.record);
  try {
    await effects.saveSettings(plan.settings);
  } catch (error) {
    // Byte differences cannot prove a failed commit: a user may have edited afterward.
    if (error instanceof PreferenceWriteNotCommittedError) await effects.discardRecord(plan.record);
    throw error;
  }
  return {
    configured: true,
    skipped: plan.skipped,
    applied: plan.applied,
    ...(plan.preset ? { preset: plan.preset } : {}),
  };
}

export async function configureTernPluginSettingsLocked(
  input: TernPluginSettingsInput,
  effects: PreferenceEffects = {
    replaceFile: (path, before, text) =>
      replacePreferenceFile(path, before, text, input.newId ?? randomUUID),
  },
): Promise<ConfigureResult> {
  const path = settingsPath(input);
  const recordPath = `${path}.tandem.json`;
  const raw = await readPreferenceFile(path);
  // Validate settings before reading the record, preserving the first failure during setup.
  ternSettingsSchema.parse(JSON.parse(raw.text));
  const prior = await readPreferenceFile(recordPath);
  const plan = planPreferences(raw.text, prior.exists ? prior.text : undefined);
  if (plan.status === "configured") return { configured: plan.configured, skipped: plan.skipped };
  return applyPreferences(plan, {
    saveRecord: (text) => effects.replaceFile(recordPath, prior, text),
    saveSettings: (text) => effects.replaceFile(path, raw, text),
    discardRecord: async (text) => {
      const saved = await readPreferenceFile(recordPath);
      if (saved.exists && saved.text === text) await rm(recordPath);
    },
  });
}

export function configureTernPluginSettings(
  input: TernPluginSettingsInput,
  effects?: PreferenceEffects,
): Promise<ConfigureResult> {
  return withSetupLock(input, () => configureTernPluginSettingsLocked(input, effects));
}

function restoreSidebar(
  settings: z.infer<typeof ternSettingsSchema>,
  sidebar: NonNullable<z.infer<typeof recordSchema>["sidebar"]>,
): boolean {
  if (settings.tabs_autohide !== sidebar.installed) return false;
  if (sidebar.previous === undefined) delete settings.tabs_autohide;
  else settings.tabs_autohide = sidebar.previous;
  return true;
}

function restoreRecordedSettings(
  settings: z.infer<typeof ternSettingsSchema>,
  record: z.infer<typeof recordSchema>,
) {
  const restored: string[] = [];
  const preserved: string[] = [];
  for (const { key, installed } of record.keys) {
    if (settings.keybinds?.[key] === installed) {
      delete settings.keybinds[key];
      restored.push(key);
    } else preserved.push(key);
  }
  if (!record.keybindsExisted && settings.keybinds && Object.keys(settings.keybinds).length === 0)
    delete settings.keybinds;
  if (record.sidebar)
    (restoreSidebar(settings, record.sidebar) ? restored : preserved).push("sidebar");
  return { restored, preserved };
}

/** Restore only values still equal to Tandem's recorded values, preserving subsequent user edits. */
export async function restoreTernPluginSettings(
  input: TernPluginSettingsInput,
): Promise<Readonly<{ restored: readonly string[]; preserved: readonly string[] }>> {
  const path = settingsPath(input);
  const recordPath = `${path}.tandem.json`;
  const none = { restored: [], preserved: [] };
  // The record appears atomically, so seeing none orders this call before any configure that writes
  // one; Herdr starts on machines without Tern then never touch Tern's config directory.
  if (!(await readPreferenceFile(recordPath)).exists) return none;
  return withSetupLock(input, async () => {
    const saved = await readPreferenceFile(recordPath);
    if (!saved.exists) return none;
    const record = recordSchema.parse(JSON.parse(saved.text));
    const raw = await readPreferenceFile(path);
    const settings = ternSettingsSchema.parse(JSON.parse(raw.text));
    const { restored, preserved } = restoreRecordedSettings(settings, record);
    if (restored.length > 0)
      await replacePreferenceFile(
        path,
        raw,
        `${JSON.stringify(settings, null, 2)}\n`,
        input.newId ?? randomUUID,
      );
    const current = await readPreferenceFile(recordPath);
    if (current.text !== saved.text || current.exists !== saved.exists)
      throw new Error("Tern preference record changed while restoring settings");
    await rm(recordPath);
    return { restored, preserved };
  });
}

const restorationWarnings = new Set<string>();

/** Preference cleanup is best-effort: it must never prevent using the selected Herdr terminal. */
export async function restoreTernPluginPreferences(
  deps: TernPreferenceDependencies,
): Promise<void> {
  try {
    const result = await restoreTernPluginSettings(settingsInput(deps));
    if (result.restored.length > 0)
      deps.print?.("Restored Tern's previous sidebar and Tandem shortcuts.\n");
    if (result.preserved.length > 0)
      deps.print?.("Kept Tern settings you changed after Tandem setup.\n");
  } catch (error) {
    const key = deps.settingsPath ?? deps.env?.TERN_CONFIG_DIR ?? "default";
    if (restorationWarnings.has(key)) return;
    restorationWarnings.add(key);
    const message = error instanceof Error ? error.message : String(error);
    const warning = `Tandem couldn't restore Tern preferences; Herdr will still open. Fix Tern's settings and try again: ${message}\n`;
    if (deps.print) deps.print(warning);
    else process.stderr.write(warning);
  }
}
