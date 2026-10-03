import type { CommandRunner } from "../contracts.ts";
import { claudeCodeHarness } from "./claude-code/launch.ts";
import { CLAUDE_CODE_MODELS } from "./claude-code/models.ts";
import type { Harness, HarnessName, KnownHarness, ModelRecord } from "./contract.ts";
import { ompHarness } from "./omp/launch.ts";

// A function, not a module constant: omp/launch.ts imports this module back through
// coordinator/record.ts, so the harnesses may not exist yet while this module loads.
function harnesses(): Readonly<Record<KnownHarness, Harness>> {
  return { omp: ompHarness, "claude-code": claudeCodeHarness };
}

/**
 * The one place a harness name, recorded or derived from a model with `harnessOf`, becomes the
 * harness that launches and recognizes its agent. Both harnesses run every role.
 */
export function harnessFor(name: HarnessName): Harness {
  const known: KnownHarness = name;
  return harnesses()[known];
}

/** Every harness a coordinator may run in, for recognizing one Tandem launched without a record. */
export function coordinatorHarnesses(): readonly Harness[] {
  return Object.values(harnesses());
}

/**
 * OMP lists the models Tandem offers and picks on its own, and the MCP servers, for every role.
 * Claude Code models are never offered or picked automatically.
 */
export function catalogueHarness(): Harness {
  return ompHarness;
}

/**
 * Every model a role may be pinned to and run on: OMP's listing and the Claude Code catalogue.
 * Reassignment still never moves a role into Claude Code, because it keeps the pinned harness and
 * picks only from enabled providers.
 */
export async function runnableModels(
  run: CommandRunner,
  cwd: string,
): Promise<readonly ModelRecord[]> {
  return [...(await ompHarness.listModels(run, cwd)), ...CLAUDE_CODE_MODELS];
}
