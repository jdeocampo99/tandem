import type { CommandResult, CommandRunner } from "../contracts.ts";
import { OMP_INSTALL_COMMAND } from "../harness/omp/adapter.ts";
import type { TerminalBackend } from "../terminal-backend/contract.ts";

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
  terminal: TerminalBackend,
  input: Readonly<{ readonly cwd: string; readonly sessionId: string }>,
): Promise<readonly ToolCheck[]> {
  const { cwd } = input;
  const checks: ToolCheck[] = [...(await terminal.checkInstall(input))];

  const omp = await tryRun(run, ["omp", "--version"], cwd);
  checks.push({
    name: "OMP",
    ok: omp?.code === 0,
    detail: omp?.code === 0 ? firstLine(omp) : "not found",
    ...(omp?.code === 0 ? {} : { fix: OMP_INSTALL_COMMAND }),
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

/** What the user sees about missing tools, or undefined when everything is there. */
export function toolReport(checks: readonly ToolCheck[]): string | undefined {
  const missing = checks.filter((check) => !check.ok);
  if (missing.length === 0) return undefined;
  const lines = missing.map((check) => {
    const optional = check.optional === true ? " (optional)" : "";
    const fix = check.fix === undefined ? "" : `: run \`${check.fix}\``;
    return `- ${check.name}${optional}, ${check.detail}${fix}`;
  });
  return `Before setting up, a few things are missing:\n${lines.join("\n")}`;
}
