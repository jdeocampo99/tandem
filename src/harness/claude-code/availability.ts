import { join } from "node:path";
import type { CommandRunner } from "../../contracts.ts";

/** A setting that keeps Tandem's `--plugin-dir` mods from loading. */
type ModsOffSetting =
  | "disableAllHooks"
  | "allowManagedHooksOnly"
  | "allowManagedModsOnly"
  | "disableSideloadFlags";

/**
 * The settings files a Tandem launch reads. `--setting-sources project,local` drops user settings,
 * and managed settings always apply.
 */
type SettingsSource = "managed" | "project" | "local";

export type ModsOff = Readonly<{ setting: ModsOffSetting; source: SettingsSource }>;

/** Whether a role could run in Claude Code on this computer. */
export type ClaudeCodeAvailability = "ready" | "not-installed" | ModsOff;

export type SettingsFile = Readonly<{
  source: SettingsSource;
  /** The file's text, or undefined when it does not exist or can't be read. */
  text: string | undefined;
}>;

/** Where macOS keeps Claude Code's managed settings, which apply to every launch. */
const CLAUDE_CODE_MANAGED_DIRECTORY = "/Library/Application Support/ClaudeCode";

export type ClaudeCodeProbe = Readonly<{
  run: CommandRunner;
  /** The project's checkout. A worktree reads its `.claude/settings.local.json` too. */
  cwd: string;
  /** The file's text, or undefined when it does not exist or can't be read. */
  readText: (path: string) => Promise<string | undefined>;
  /** The directory's entry names, or none when it does not exist. */
  listDirectory: (path: string) => Promise<readonly string[]>;
}>;

type Settings = Readonly<Record<string, unknown>>;

const SETTING_IS_ON: Readonly<Record<ModsOffSetting, (settings: Settings) => boolean>> = {
  disableAllHooks: (settings) => settings.disableAllHooks === true,
  allowManagedHooksOnly: (settings) => settings.allowManagedHooksOnly === true,
  allowManagedModsOnly: (settings) =>
    field(
      field(field(settings.pluginConfigs, "cc-plugin-sec-default@builtin"), "options"),
      "allowManagedModsOnly",
    ) === true,
  disableSideloadFlags: (settings) => settings.disableSideloadFlags === true,
};

/** Claude Code honors the managed-only settings from managed settings alone. */
const SETTINGS_READ_FROM: Readonly<Record<SettingsSource, readonly ModsOffSetting[]>> = {
  managed: [
    "disableAllHooks",
    "allowManagedHooksOnly",
    "allowManagedModsOnly",
    "disableSideloadFlags",
  ],
  project: ["disableAllHooks"],
  local: ["disableAllHooks"],
};

/** Pure: what `claude --version` and the settings files a launch reads say about running Claude Code. */
export function claudeCodeAvailability(
  versionExitCode: number | undefined,
  files: readonly SettingsFile[],
): ClaudeCodeAvailability {
  if (versionExitCode !== 0) return "not-installed";
  for (const file of files) {
    const settings = parseSettings(file.text);
    if (settings === undefined) continue;
    const setting = SETTINGS_READ_FROM[file.source].find((name) => SETTING_IS_ON[name](settings));
    if (setting !== undefined) return { setting, source: file.source };
  }
  return "ready";
}

const SOURCE_NAMES: Readonly<Record<SettingsSource, string>> = {
  managed: "Claude Code's managed settings",
  project: "this project's .claude/settings.json",
  local: "this project's .claude/settings.local.json",
};

/** The plain-English reason the model picker gives for mods being off. */
export function modsOffReason(off: ModsOff): string {
  const effect =
    off.setting === "disableSideloadFlags"
      ? "blocks the --plugin-dir flag Tandem loads its plugin with"
      : "switches off mods";
  return `The ${off.setting} setting in ${SOURCE_NAMES[off.source]} ${effect}, so Tandem can't run in Claude Code.`;
}

export async function probeClaudeCode(probe: ClaudeCodeProbe): Promise<ClaudeCodeAvailability> {
  const read = (path: string) => probe.readText(path).catch(() => undefined);
  const dropIns = join(CLAUDE_CODE_MANAGED_DIRECTORY, "managed-settings.d");
  const [version, dropInNames] = await Promise.all([
    probe
      .run({ argv: ["claude", "--version"], cwd: probe.cwd, timeoutMs: 15_000 })
      .then((result) => result.code)
      .catch(() => undefined),
    probe.listDirectory(dropIns).catch(() => []),
  ]);
  const paths: readonly Readonly<{ source: SettingsSource; path: string }>[] = [
    { source: "managed", path: join(CLAUDE_CODE_MANAGED_DIRECTORY, "managed-settings.json") },
    ...dropInNames
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ source: "managed" as const, path: join(dropIns, name) })),
    { source: "project", path: join(probe.cwd, ".claude", "settings.json") },
    { source: "local", path: join(probe.cwd, ".claude", "settings.local.json") },
  ];
  const files = await Promise.all(
    paths.map(async ({ source, path }) => ({ source, text: await read(path) })),
  );
  return claudeCodeAvailability(version, files);
}

function parseSettings(text: string | undefined): Settings | undefined {
  if (text === undefined) return undefined;
  try {
    const settings: unknown = JSON.parse(text);
    return isRecord(settings) ? settings : undefined;
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

function isRecord(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
