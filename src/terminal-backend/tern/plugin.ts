import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AdapterProtocolError } from "../../adapters/primitives.ts";
import { StoreLockTimeoutError } from "../../tasks/store-errors.ts";
import { acquireDarwinFileLock } from "../../tasks/store-lock.ts";
import { type TernRunner, ternPlugin } from "./cli.ts";

export const TANDEM_TERN_PLUGIN = "tandem";
export const TERN_PLUGIN_DIRECTORY = fileURLToPath(
  new URL("../../../tern-plugin", import.meta.url),
);

// A waiting caller sits behind another caller's consent question, which a person answers.
const SETUP_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const SETUP_LOCK_POLL_MS = 50;

const catalogSchema = z.object({
  plugins: z.array(
    z.object({ id: z.string(), status: z.string(), host: z.boolean(), window: z.boolean() }),
  ),
  problems: z.array(z.unknown()),
});

export type TernPluginDependencies = Readonly<{
  run: TernRunner;
  cwd: string;
  binary?: string;
  directory?: string;
  env?: Readonly<Record<string, string>>;
  confirm?: (question: string) => Promise<boolean>;
  settingsPath?: string;
  print?: (text: string) => void;
}>;

type TernPluginSettingsInput = Readonly<{
  path?: string;
  configDirectory?: string;
  approved?: boolean;
  confirm?: (question: string) => Promise<boolean>;
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
    approved: z.boolean(),
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

/** Tandem cannot run without Tern, so a missing app and a failed link end in this one message. */
export class TernRequiredError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Tandem needs Tern, which could not be used. Install Tern at /Applications/Tern.app, then try again.",
      options,
    );
    this.name = "TernRequiredError";
  }
}

async function pluginCommand(deps: TernPluginDependencies, args: readonly string[]) {
  try {
    return await ternPlugin(deps, args);
  } catch (error) {
    throw new TernRequiredError({ cause: error });
  }
}

async function catalog(deps: TernPluginDependencies) {
  const raw = await pluginCommand(deps, ["list"]);
  try {
    return catalogSchema.parse(JSON.parse(raw));
  } catch {
    throw new AdapterProtocolError("Tern plugin list", "invalid plugin catalog", raw);
  }
}

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

function settingsInput(deps: TernPluginDependencies): TernPluginSettingsInput {
  return {
    ...(deps.settingsPath === undefined ? {} : { path: deps.settingsPath }),
    ...(deps.env?.TERN_CONFIG_DIR === undefined
      ? {}
      : { configDirectory: deps.env.TERN_CONFIG_DIR }),
    ...(deps.confirm === undefined ? {} : { confirm: deps.confirm }),
  };
}

/**
 * Every Tandem home on this machine shares one Tern config directory, which holds both the plugin
 * links and the settings file, so the lock lives there rather than in any one Tandem home. Tern's
 * `plugin list` never creates that directory, so first-time setup creates it before locking; restore
 * only locks once its record exists there.
 */
async function withSetupLock<T>(input: TernPluginSettingsInput, run: () => Promise<T>) {
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
      const bits = part
        .split("+")
        .map((bit) => (bit === "super" ? "cmd" : bit === "opt" ? "alt" : bit));
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "{}", exists: false };
    throw error;
  }
}

/** Proof supplied by the writer before attempting its atomic commit. Other errors are uncertain. */
export class PreferenceWriteNotCommittedError extends Error {}

async function replacePreferenceFile(
  path: string,
  before: Readonly<{ text: string; exists: boolean }>,
  text: string,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
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
  notice?: true;
  preset?: string;
}>;

type PreferenceEffects = Readonly<{ replaceFile: typeof replacePreferenceFile }>;

/** One decision controls both global preferences. Record changes before applying them for recovery. */
async function configureLocked(
  input: TernPluginSettingsInput,
  effects: PreferenceEffects,
): Promise<ConfigureResult> {
  const path = settingsPath(input);
  const recordPath = `${path}.tandem.json`;
  const raw = await readPreferenceFile(path);
  const plan = planTernPluginKeys(raw.text);
  const prior = await readPreferenceFile(recordPath);
  if (prior.exists) {
    const record = recordSchema.parse(JSON.parse(prior.text));
    const current = ternSettingsSchema.parse(JSON.parse(raw.text));
    return {
      configured:
        record.approved &&
        record.keys.every(({ key, installed }) => current.keybinds?.[key] === installed) &&
        (!record.sidebar || current.tabs_autohide === record.sidebar.installed),
      skipped: plan.skipped,
    };
  }
  const settings = ternSettingsSchema.parse(JSON.parse(plan.text));
  const sidebar = settings.tabs_autohide !== true;
  if (!plan.changed && !sidebar) return { configured: true, skipped: plan.skipped };
  if (input.approved === undefined && input.confirm === undefined)
    return { configured: false, skipped: plan.skipped };
  const approved =
    input.approved ??
    (await input.confirm?.(
      "Hide Tern's sidebar and use Tandem's board, PR, usage and project shortcuts? These settings apply to every Tern window. Your custom shortcuts stay unchanged. Palette commands and panel buttons work either way.",
    )) ??
    false;
  const record = recordSchema.parse({
    version: 1,
    approved,
    keybindsExisted: ternSettingsSchema.parse(JSON.parse(raw.text)).keybinds !== undefined,
    keys: approved ? plan.added.map((key) => ({ key, installed: TERN_PLUGIN_KEYS[key] })) : [],
    ...(approved && sidebar
      ? { sidebar: { previous: settings.tabs_autohide, installed: true } }
      : {}),
  });
  // Refuse consent based on a stale settings snapshot, even when only recording a decline.
  const current = await readPreferenceFile(path);
  if (current.text !== raw.text || current.exists !== raw.exists)
    throw new Error("Tern settings changed while configuring preferences");
  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  await effects.replaceFile(recordPath, prior, recordText);
  if (approved) {
    if (sidebar) settings.tabs_autohide = true;
    const installedText = `${JSON.stringify(settings, null, 2)}\n`;
    try {
      await effects.replaceFile(path, raw, installedText);
    } catch (error) {
      // Byte differences cannot prove a failed commit: a user may have edited afterward.
      // Only an explicit pre-commit proof permits abandoning restoration ownership.
      if (error instanceof PreferenceWriteNotCommittedError) {
        const saved = await readPreferenceFile(recordPath);
        if (saved.exists && saved.text === recordText) await rm(recordPath);
      }
      throw error;
    }
  }
  return {
    configured: approved,
    skipped: plan.skipped,
    notice: true,
    ...(plan.preset ? { preset: plan.preset } : {}),
  };
}

export function configureTernPluginSettings(
  input: TernPluginSettingsInput,
  effects: PreferenceEffects = { replaceFile: replacePreferenceFile },
): Promise<ConfigureResult> {
  return withSetupLock(input, () => configureLocked(input, effects));
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
    if (record.sidebar) {
      if (settings.tabs_autohide === record.sidebar.installed) {
        if (record.sidebar.previous === undefined) delete settings.tabs_autohide;
        else settings.tabs_autohide = record.sidebar.previous;
        restored.push("sidebar");
      } else preserved.push("sidebar");
    }
    if (restored.length > 0)
      await replacePreferenceFile(path, raw, `${JSON.stringify(settings, null, 2)}\n`);
    const current = await readPreferenceFile(recordPath);
    if (current.text !== saved.text || current.exists !== saved.exists)
      throw new Error("Tern preference record changed while restoring settings");
    await rm(recordPath);
    return { restored, preserved };
  });
}

function readyIn(plugins: z.infer<typeof catalogSchema>["plugins"]): boolean {
  return plugins.some(
    (plugin) =>
      plugin.id === TANDEM_TERN_PLUGIN && plugin.status === "ready" && plugin.host && plugin.window,
  );
}

/**
 * Selecting Tern links its view package; one separate consent controls global preferences. The
 * whole sequence holds the setup lock, so concurrent starts link once and ask once.
 */
export async function ensureTernPlugin(deps: TernPluginDependencies): Promise<boolean> {
  const input = settingsInput(deps);
  return withSetupLock(input, async () => {
    const before = await catalog(deps);
    if (before.plugins.some((plugin) => plugin.id === TANDEM_TERN_PLUGIN)) {
      if (!readyIn(before.plugins)) return false;
    } else {
      await pluginCommand(deps, ["link", deps.directory ?? TERN_PLUGIN_DIRECTORY]);
      if (!readyIn((await catalog(deps)).plugins)) return false;
    }
    printConfigureNotices(
      deps,
      await configureLocked(input, { replaceFile: replacePreferenceFile }),
    );
    return true;
  });
}

function printConfigureNotices(deps: TernPluginDependencies, result: ConfigureResult): void {
  if (!result.notice) return;
  if (result.preset)
    deps.print?.(
      `Tandem kept Tern's ${result.preset} keymap preset; Tandem shortcuts were not added.\n`,
    );
  if (result.skipped.length > 0)
    deps.print?.(
      `Tandem kept your custom Tern shortcuts: ${describeTernPluginKeys(result.skipped)}.\n`,
    );
  if (!result.configured)
    deps.print?.(
      "Tern's sidebar and shortcuts are unchanged. Tandem is available from the palette and panel buttons. To change this later, switch to Herdr and select Tern again in setup.\n",
    );
}

const restorationWarnings = new Set<string>();

/** Preference cleanup is best-effort: it must never prevent using the selected Herdr terminal. */
export async function restoreTernPluginPreferences(deps: TernPluginDependencies): Promise<void> {
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

/** Update reloads an already installed integration. It never installs one without consent. */
export function reloadTernPlugin(deps: TernPluginDependencies): Promise<boolean> {
  return withSetupLock(settingsInput(deps), async () => {
    const before = await catalog(deps);
    if (!before.plugins.some((plugin) => plugin.id === TANDEM_TERN_PLUGIN)) return false;
    await ternPlugin(deps, ["reload"]);
    if (!readyIn((await catalog(deps)).plugins))
      throw new Error("Tandem's Tern plugin failed to reload");
    return true;
  });
}
