import { claudeCodeHarness } from "./claude-code/launch.ts";
import type { Harness, HarnessName, KnownHarness } from "./contract.ts";
import { ompHarness } from "./omp/launch.ts";

const HARNESSES: Readonly<Record<KnownHarness, Harness>> = {
  omp: ompHarness,
  "claude-code": claudeCodeHarness,
};

/**
 * The one place a harness name, recorded or derived from a model with `harnessOf`, becomes the
 * harness that launches and recognizes its agent. Both harnesses run every role.
 */
export function harnessFor(name: HarnessName): Harness {
  const known: KnownHarness = name;
  return HARNESSES[known];
}

/** Every harness a coordinator may run in, for recognizing one Tandem launched without a record. */
export function coordinatorHarnesses(): readonly Harness[] {
  return Object.values(HARNESSES);
}

/**
 * OMP lists the models Tandem offers and picks on its own, and the MCP servers, for every role.
 * Claude Code models are never offered or picked automatically.
 */
export function catalogueHarness(): Harness {
  return ompHarness;
}
