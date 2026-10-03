import type { CommandRunner } from "../../contracts.ts";

/**
 * Whether a role could run in Claude Code on this computer. `mods-off`: managed settings set
 * `disableAllHooks`, which Tandem's `--setting-sources project,local` cannot drop, so its plugin
 * never starts.
 */
export type ClaudeCodeAvailability = "ready" | "not-installed" | "mods-off";

/** Where macOS keeps Claude Code's managed settings, which apply to every launch. */
export const CLAUDE_CODE_MANAGED_SETTINGS =
  "/Library/Application Support/ClaudeCode/managed-settings.json";

export type ClaudeCodeProbe = Readonly<{
  run: CommandRunner;
  cwd: string;
  /** The file's text, or undefined when it does not exist or can't be read. */
  readText: (path: string) => Promise<string | undefined>;
}>;

/** Pure: what `claude --version` and the managed settings file say about running Claude Code. */
export function claudeCodeAvailability(
  versionExitCode: number | undefined,
  managedSettings: string | undefined,
): ClaudeCodeAvailability {
  if (versionExitCode !== 0) return "not-installed";
  return disablesAllHooks(managedSettings) ? "mods-off" : "ready";
}

export async function probeClaudeCode(probe: ClaudeCodeProbe): Promise<ClaudeCodeAvailability> {
  const [version, managedSettings] = await Promise.all([
    probe
      .run({ argv: ["claude", "--version"], cwd: probe.cwd, timeoutMs: 15_000 })
      .then((result) => result.code)
      .catch(() => undefined),
    probe.readText(CLAUDE_CODE_MANAGED_SETTINGS).catch(() => undefined),
  ]);
  return claudeCodeAvailability(version, managedSettings);
}

function disablesAllHooks(text: string | undefined): boolean {
  if (text === undefined) return false;
  try {
    const settings: unknown = JSON.parse(text);
    return (
      typeof settings === "object" &&
      settings !== null &&
      (settings as Readonly<Record<string, unknown>>).disableAllHooks === true
    );
  } catch {
    return false;
  }
}
