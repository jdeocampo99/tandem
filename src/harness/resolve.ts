import type { AgentRole, ModelSpec } from "../contracts.ts";
import { type Harness, type HarnessName, harnessOf, type KnownHarness } from "./contract.ts";
import { ompHarness } from "./omp/launch.ts";

/** Thrown when a role's model runs in a harness Tandem knows but cannot run yet. */
export class HarnessUnavailableError extends Error {}

/** Each known harness, or undefined while Tandem can't run it yet. */
const RUNNABLE: Readonly<Record<KnownHarness, Harness | undefined>> = {
  omp: ompHarness,
  "claude-code": undefined,
};

function runnable(name: HarnessName): Harness | undefined {
  const known: KnownHarness = name;
  return RUNNABLE[known];
}

/** The one place a harness name becomes the harness that launches and recognizes its agents. */
export function harnessFor(name: HarnessName): Harness {
  const harness = runnable(name);
  if (harness === undefined) {
    throw new HarnessUnavailableError(
      "This agent's model runs in Claude Code, and Tandem can't run Claude Code yet. Pick a model from another provider for its role with `tandem configure`.",
    );
  }
  return harness;
}

/** The harness that runs `role` on `model`, refusing in plain English when Tandem can't run it. */
export function harnessForRole(role: AgentRole, model: ModelSpec | undefined): Harness {
  const harness = runnable(harnessOf(model));
  if (harness === undefined) {
    throw new HarnessUnavailableError(
      `The ${role}'s model is ${model?.model}, which runs in Claude Code. Tandem can't run Claude Code yet. Pick a model from another provider for this role with \`tandem configure\`.`,
    );
  }
  return harness;
}
