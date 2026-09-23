import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { rememberedSetupPath } from "../config/environment.ts";
import type { CommandRunner } from "../contracts.ts";
import { resetCoordinators } from "../coordinator/reset.ts";
import type { TerminalEnvironment } from "./environment.ts";
import { readRegisteredProjects } from "./projects.ts";

export type HardResetPlan = Readonly<{
  readonly repos: readonly string[];
  readonly remove: readonly string[];
}>;

function pathIsWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** Refuses paths whose removal would take far more than Tandem's own state with it. */
function assertRemovable(path: string, repos: readonly string[]): void {
  const home = homedir();
  if (path === parse(path).root || path === home || pathIsWithin(home, path)) {
    throw new Error(`refusing to delete ${path}; point TANDEM_HOME at a dedicated directory`);
  }
  const repo = repos.find((candidate) => pathIsWithin(candidate, path));
  if (repo !== undefined) throw new Error(`refusing to delete ${path}; it contains ${repo}`);
}

async function rememberedSetupFor(
  home: string,
  environment: TerminalEnvironment,
): Promise<string | undefined> {
  const path = rememberedSetupPath(environment.source);
  try {
    const setup = JSON.parse(await readFile(path, "utf8")) as { home?: unknown };
    return typeof setup.home === "string" && resolve(setup.home) === home ? path : undefined;
  } catch {
    // A missing or unreadable setup file points at no home, so there is nothing to remove.
    return undefined;
  }
}

export async function planHardReset(environment: TerminalEnvironment): Promise<HardResetPlan> {
  // Broken state is what a hard reset is for, so unreadable project records do not stop it.
  const repos = await readRegisteredProjects(environment.home).catch(() => []);
  const setup = await rememberedSetupFor(environment.home, environment);
  const remove = [
    environment.home,
    ...(pathIsWithin(environment.poolRoot, environment.home) ? [] : [environment.poolRoot]),
    ...(setup === undefined ? [] : [setup]),
  ];
  for (const path of remove) assertRemovable(path, repos);
  return { repos, remove };
}

export function renderHardResetPlan(plan: HardResetPlan): string {
  return [
    "This deletes all of Tandem's state: onboarded projects, model settings, task history,",
    "and every Tandem worktree, including work that was never pushed or merged.",
    "Your repositories themselves are not touched.",
    "",
    "Will delete:",
    ...plan.remove.map((path) => `  ${path}`),
    "",
  ].join("\n");
}

/**
 * Stops Tandem's panes as well as it can, then deletes its state. Stopping is best effort:
 * a hard reset exists for state too broken to stop cleanly, so a failure there is reported
 * and the deletion still happens.
 */
export async function applyHardReset(
  plan: HardResetPlan,
  environment: TerminalEnvironment,
  run: CommandRunner,
  stdout: (text: string) => void,
  reset: typeof resetCoordinators = resetCoordinators,
): Promise<void> {
  try {
    await reset(run, {
      home: environment.home,
      sessionId: environment.sessionId,
      repoPaths: plan.repos,
      force: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdout(
      `Could not stop every Tandem pane (${message}). Close any leftover Tandem panes in Herdr by hand.\n`,
    );
  }
  for (const path of plan.remove) await rm(path, { recursive: true, force: true });
  // The deleted worktrees are still registered in each repository until pruned.
  for (const repo of plan.repos) {
    await run({ argv: ["git", "-C", repo, "worktree", "prune"], cwd: repo });
  }
  stdout("Tandem is reset. Run `tandem` to onboard your projects again.\n");
}
