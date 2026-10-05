import { randomUUID } from "node:crypto";
import { link, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const TERN_PLUGIN_KEYS: Readonly<Record<string, string>> = {
  "cmd+shift+b": "plugin.tandem.board",
  "cmd+shift+p": "plugin.tandem.prs",
  "cmd+shift+u": "plugin.tandem.usage",
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      [`cmd+${index + 1}`, `plugin.tandem.bind.${index}`],
      [`cmd+digit_${index + 1}`, `plugin.tandem.bind.${index}`],
    ]).flat(),
  ),
  "cmd+shift+[": "plugin.tandem.bind.9",
  "cmd+shift+]": "plugin.tandem.bind.10",
};

const settingsSchema = z
  .object({ keybinds: z.record(z.union([z.string(), z.array(z.string())])).optional() })
  .passthrough();

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
export function planTernPluginKeys(
  raw: string,
): Readonly<{ text: string; changed: boolean; skipped: readonly string[] }> {
  const settings = settingsSchema.parse(JSON.parse(raw));
  const keybinds = { ...settings.keybinds };
  const skipped: string[] = [];
  let changed = false;
  for (const [key, action] of Object.entries(TERN_PLUGIN_KEYS)) {
    const existing = Object.keys(settings.keybinds ?? {}).find(
      (each) => chord(each) === chord(key) || chord(each).startsWith(`${chord(key)}>`),
    );
    if (existing !== undefined && keybinds[existing] !== action) {
      skipped.push(key);
      continue;
    }
    if (keybinds[key] === action) continue;
    keybinds[key] = action;
    changed = true;
  }
  return {
    text: changed ? `${JSON.stringify({ ...settings, keybinds }, null, 2)}\n` : raw,
    changed,
    skipped,
  };
}

async function readSettings(path: string): Promise<Readonly<{ text: string; exists: boolean }>> {
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

/** The caller supplies consent. Re-read immediately before replacing to refuse stale settings. */
export async function configureTernPluginKeys(
  input: Readonly<{
    path?: string;
    configDirectory?: string;
    approved?: boolean;
    confirm?: (question: string) => Promise<boolean>;
  }>,
): Promise<Readonly<{ configured: boolean; skipped: readonly string[] }>> {
  const path =
    input.path ??
    join(
      input.configDirectory ??
        process.env.TERN_CONFIG_DIR ??
        join(homedir(), "Library", "Application Support", "Tern"),
      "settings.json",
    );
  const raw = await readSettings(path);
  const plan = planTernPluginKeys(raw.text);
  if (!plan.changed) return { configured: true, skipped: plan.skipped };
  if (
    !input.approved &&
    (input.confirm === undefined ||
      !(await input.confirm("Use Tandem's board, PR, usage and project shortcuts in Tern?")))
  ) {
    return { configured: false, skipped: plan.skipped };
  }
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error("Tern config must be a regular directory");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, plan.text, { flag: "wx", mode: 0o600 });
    const current = await readSettings(path);
    if (current.text !== raw.text || current.exists !== raw.exists)
      throw new Error("Tern settings changed while configuring shortcuts");
    if (raw.exists) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { configured: true, skipped: plan.skipped };
}
