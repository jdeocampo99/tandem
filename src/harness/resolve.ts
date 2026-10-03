import type { Harness, HarnessName, KnownHarness } from "./contract.ts";
import { ompHarness } from "./omp/launch.ts";

/** Thrown when a project names a harness Tandem knows but cannot run yet. */
export class HarnessUnavailableError extends Error {}

const HARNESSES: Readonly<Record<KnownHarness, () => Harness>> = {
  omp: () => ompHarness,
  "claude-code": () => {
    throw new HarnessUnavailableError(
      'This project is set to run on Claude Code, which Tandem cannot run yet. Set harness = "omp" in the project\'s settings.toml, or delete the harness line, to use OMP.',
    );
  },
};

/** The one place a harness name becomes the harness that launches and recognizes its agents. */
export function harnessFor(name: HarnessName): Harness {
  const known: KnownHarness = name;
  return HARNESSES[known]();
}
