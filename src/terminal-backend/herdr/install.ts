import type { CommandResult, CommandRunner } from "../../contracts.ts";
import type { ToolCheck } from "../../onboarding/tools.ts";
import type { SessionTarget } from "../contract.ts";
import { TANDEM_HERDR_PLUGIN } from "./ui.ts";

/** The oldest Herdr with both popup keybindings (0.7.4) and command entries in the tab bar (0.8.2). */
export const MIN_HERDR_VERSION = "0.8.2";

/** The version in `herdr --version` output, like "herdr 0.9.1". */
export function parseHerdrVersion(output: string): string | undefined {
  return /herdr\s+v?(\d+\.\d+\.\d+)/u.exec(output)?.[1];
}

/** Whether a dotted version is at least the minimum, comparing each number in turn. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const left = version.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** Whether Herdr, and Tandem's plugin in the session, are installed; a missing program fails its check. */
export async function checkInstall(
  run: CommandRunner,
  input: SessionTarget,
): Promise<readonly ToolCheck[]> {
  const tryRun = async (argv: readonly string[]): Promise<CommandResult | undefined> => {
    try {
      return await run({ argv, cwd: input.cwd });
    } catch {
      return undefined;
    }
  };
  const versionResult = await tryRun(["herdr", "--version"]);
  const version = parseHerdrVersion(
    `${versionResult?.stdout ?? ""}${versionResult?.stderr ?? ""}`.trim().split("\n")[0] ?? "",
  );
  const current = version !== undefined && versionAtLeast(version, MIN_HERDR_VERSION);
  const plugins = await tryRun(["herdr", "--session", input.sessionId, "plugin", "list"]);
  const popup = plugins?.stdout.includes(`- ${TANDEM_HERDR_PLUGIN} (`) === true;
  return [
    {
      name: "Herdr",
      ok: current,
      detail:
        version === undefined
          ? "not found"
          : current
            ? version
            : `${version}, needs ${MIN_HERDR_VERSION}+`,
      ...(current ? {} : { fix: "./setup.sh" }),
    },
    {
      name: "Tandem's welcome popup in Herdr",
      ok: popup,
      detail: popup ? "linked" : "not linked",
      ...(popup ? {} : { fix: "./setup.sh" }),
      optional: true,
    },
  ];
}
