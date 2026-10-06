import { z } from "zod";

export const TERN_PLUGIN_KEYS: Readonly<Record<string, string>> = {
  "cmd+shift+b": "plugin.tandem.board",
  "cmd+shift+p": "plugin.tandem.prs",
  "cmd+shift+u": "plugin.tandem.usage",
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      [`cmd+${index + 1}`, `plugin.tandem.project-${index + 1}`],
      [`cmd+digit_${index + 1}`, `plugin.tandem.project-${index + 1}`],
    ]).flat(),
  ),
  "cmd+shift+[": "plugin.tandem.project-prev",
  "cmd+shift+]": "plugin.tandem.project-next",
};

export const ternSettingsSchema = z
  .object({
    keybinds: z.record(z.union([z.string(), z.array(z.string())])).optional(),
    tabs_autohide: z.boolean().optional(),
    keymap: z.enum(["tern", "ghostty", "kitty", "cmux", "tmux"]).optional(),
  })
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
