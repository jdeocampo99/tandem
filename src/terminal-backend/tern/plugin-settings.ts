import { randomUUID } from "node:crypto";
import { link, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { planTernPluginKeys, TERN_PLUGIN_KEYS, ternSettingsSchema } from "./plugin-keys.ts";

export type TernPluginSettingsInput = Readonly<{
  path?: string;
  configDirectory?: string;
  approved?: boolean;
  confirm?: (question: string) => Promise<boolean>;
}>;

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

async function replacePreferenceFile(
  path: string,
  before: Readonly<{ text: string; exists: boolean }>,
  text: string,
): Promise<void> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error("Tern config must be a regular directory");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    const current = await readPreferenceFile(path);
    if (current.text !== before.text || current.exists !== before.exists)
      throw new Error("Tern settings changed while configuring preferences");
    if (before.exists) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** One decision controls both global preferences. Record changes before applying them for recovery. */
export async function configureTernPluginSettings(
  input: TernPluginSettingsInput,
): Promise<Readonly<{ configured: boolean; skipped: readonly string[] }>> {
  const path = settingsPath(input);
  const recordPath = `${path}.tandem.json`;
  const raw = await readPreferenceFile(path);
  const plan = planTernPluginKeys(raw.text);
  const prior = await readPreferenceFile(recordPath);
  if (prior.exists)
    return {
      configured: recordSchema.parse(JSON.parse(prior.text)).approved,
      skipped: plan.skipped,
    };
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
  await replacePreferenceFile(recordPath, prior, `${JSON.stringify(record, null, 2)}\n`);
  if (approved) {
    if (sidebar) settings.tabs_autohide = true;
    await replacePreferenceFile(path, raw, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { configured: approved, skipped: plan.skipped };
}

/** Restore only values still equal to Tandem's recorded values, preserving subsequent user edits. */
export async function restoreTernPluginSettings(
  input: TernPluginSettingsInput,
): Promise<Readonly<{ restored: readonly string[]; preserved: readonly string[] }>> {
  const path = settingsPath(input);
  const recordPath = `${path}.tandem.json`;
  const saved = await readPreferenceFile(recordPath);
  if (!saved.exists) return { restored: [], preserved: [] };
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
}
