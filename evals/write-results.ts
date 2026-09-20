/**
 * Generic JSONL-results-plus-summary writer, shared by every stacked evaluation runner
 * (prompt-routing, research-continuation, and any later one) so there is exactly one place that
 * decides the on-disk shape of an eval run's output.
 */

import { join } from "node:path";

export type EvalResultIo = Readonly<{
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
}>;

export async function realEvalResultIo(): Promise<EvalResultIo> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  return {
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    writeFile: async (path, contents) => {
      await writeFile(path, contents, "utf8");
    },
  };
}

/** Writes `results.jsonl` (one outcome per line) plus a `summary.json` built by `summarize`. */
export async function writeEvalResults<TOutcome, TSummary>(
  outcomes: readonly TOutcome[],
  outputDir: string,
  io: EvalResultIo,
  summarize: (outcomes: readonly TOutcome[]) => TSummary,
): Promise<Readonly<{ resultsPath: string; summaryPath: string }>> {
  await io.mkdir(outputDir);
  const resultsPath = join(outputDir, "results.jsonl");
  const summaryPath = join(outputDir, "summary.json");
  const lines = outcomes.map((outcome) => JSON.stringify(outcome));
  await io.writeFile(resultsPath, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  const summary = summarize(outcomes);
  await io.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { resultsPath, summaryPath };
}
