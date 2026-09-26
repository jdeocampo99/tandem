import { TANDEM_HERDR_PLUGIN } from "../adapters/herdr.ts";
import type { CommandResult, CommandRunner } from "../contracts.ts";
import { MIN_HERDR_VERSION, parseHerdrVersion, versionAtLeast } from "../terminal/herdr-setup.ts";

/** One thing Tandem needs on this machine: whether it is there, and the command that fixes it. */
export type ToolCheck = Readonly<{
  readonly name: string;
  readonly ok: boolean;
  /** What was found, in a few words. */
  readonly detail: string;
  /** The command to run when it is not ok. */
  readonly fix?: string;
  /** Tandem works without it; only some features need it. */
  readonly optional?: boolean;
}>;

/** A missing program reads as a failed command rather than an error. */
async function tryRun(
  run: CommandRunner,
  argv: readonly string[],
  cwd: string,
): Promise<CommandResult | undefined> {
  try {
    return await run({ argv, cwd });
  } catch {
    return undefined;
  }
}

function firstLine(result: CommandResult | undefined): string {
  return `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim().split("\n")[0] ?? "";
}

/** Checks the tools onboarding depends on, without changing anything. */
export async function checkTools(
  run: CommandRunner,
  input: Readonly<{ readonly cwd: string; readonly sessionId: string }>,
): Promise<readonly ToolCheck[]> {
  const { cwd } = input;
  const checks: ToolCheck[] = [];

  const herdrVersion = parseHerdrVersion(firstLine(await tryRun(run, ["herdr", "--version"], cwd)));
  const herdrCurrent =
    herdrVersion !== undefined && versionAtLeast(herdrVersion, MIN_HERDR_VERSION);
  checks.push({
    name: "Herdr",
    ok: herdrCurrent,
    detail:
      herdrVersion === undefined
        ? "not found"
        : herdrCurrent
          ? herdrVersion
          : `${herdrVersion}, needs ${MIN_HERDR_VERSION}+`,
    ...(herdrCurrent ? {} : { fix: "./setup.sh" }),
  });
  const plugins = await tryRun(run, ["herdr", "--session", input.sessionId, "plugin", "list"], cwd);
  const popup = plugins?.stdout.includes(`- ${TANDEM_HERDR_PLUGIN} (`) === true;
  checks.push({
    name: "Tandem's welcome popup in Herdr",
    ok: popup,
    detail: popup ? "linked" : "not linked",
    ...(popup ? {} : { fix: "./setup.sh" }),
    optional: true,
  });

  const omp = await tryRun(run, ["omp", "--version"], cwd);
  checks.push({
    name: "OMP",
    ok: omp?.code === 0,
    detail: omp?.code === 0 ? firstLine(omp) : "not found",
    ...(omp?.code === 0 ? {} : { fix: "bun install -g @oh-my-pi/pi-coding-agent" }),
  });

  const git = await tryRun(run, ["git", "--version"], cwd);
  checks.push({
    name: "Git",
    ok: git?.code === 0,
    detail: git?.code === 0 ? firstLine(git) : "not found",
    ...(git?.code === 0 ? {} : { fix: "xcode-select --install" }),
  });

  const gh = await tryRun(run, ["gh", "auth", "status"], cwd);
  checks.push({
    name: "GitHub CLI, signed in (for pull requests and PR watch)",
    ok: gh?.code === 0,
    detail: gh === undefined ? "not found" : gh.code === 0 ? "signed in" : "not signed in",
    ...(gh?.code === 0
      ? {}
      : { fix: gh === undefined ? "brew install gh && gh auth login" : "gh auth login" }),
    optional: true,
  });
  return checks;
}
