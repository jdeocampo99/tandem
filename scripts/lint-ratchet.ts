import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { findPassThroughs, type PassThrough } from "./lint-ratchet/pass-through.ts";
import { type RatchetRule, RULES } from "./lint-ratchet/rules.ts";
import { type Counts, type Scan, type ScanProblem, scanRepo } from "./lint-ratchet/scan.ts";

/** The committed baseline: the rules it covers and their grandfathered counts. */
export type Baseline = Readonly<{ rules: readonly string[]; counts: Counts }>;

/** `check` is plain lint; `update` may only lower counts; `move` may also shift counts between files. */
export type Mode = "check" | "update" | "move";

export type CountChange = Readonly<{ file: string; rule: string; before: number; after: number }>;

export type RatchetOutcome = Readonly<{
  exitCode: 0 | 1;
  report: string;
  /** The baseline to write, present only when `--update` may lower, seed or move it. */
  nextBaseline?: Baseline;
}>;

const ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(ROOT, "scripts/lint-ratchet/baseline.json");
/** Enables exactly the ratcheted Biome rules, at their default limits, over the same files as biome.json. */
const BIOME_CONFIG_PATH = join(ROOT, "scripts/lint-ratchet/ratchet.json");

/** Where the pass-through report looks; it is report-only and never fails the ratchet. */
const PASS_THROUGH_GLOB = new Bun.Glob("{src,tests,evals,scripts}/**/*.ts");

const baselineSchema = z.object({
  rules: z.array(z.string()),
  counts: z.record(z.record(z.number().int().positive())),
});

function countOf(counts: Counts, file: string, rule: string): number {
  return counts[file]?.[rule] ?? 0;
}

function pairs(counts: Counts): ReadonlyArray<readonly [string, string]> {
  return Object.entries(counts).flatMap(([file, rules]) =>
    Object.keys(rules).map((rule) => [file, rule] as const),
  );
}

/** Every (file, rule) pair whose count differs, split into rises (new pairs included) and drops. */
export function compareCounts(
  baseline: Counts,
  current: Counts,
): Readonly<{ rises: readonly CountChange[]; drops: readonly CountChange[] }> {
  const keys = new Map<string, readonly [string, string]>();
  for (const pair of [...pairs(baseline), ...pairs(current)]) keys.set(pair.join("\0"), pair);
  const changes = [...keys.values()]
    .map(([file, rule]) => ({
      file,
      rule,
      before: countOf(baseline, file, rule),
      after: countOf(current, file, rule),
    }))
    .toSorted((left, right) =>
      `${left.file}\0${left.rule}`.localeCompare(`${right.file}\0${right.rule}`),
    );
  return {
    rises: changes.filter((change) => change.after > change.before),
    drops: changes.filter((change) => change.after < change.before),
  };
}

function hintFor(rule: string, rules: readonly RatchetRule[]): string {
  return rules.find((candidate) => candidate.id === rule)?.hint ?? "";
}

function describeRise(change: CountChange, rules: readonly RatchetRule[]): string {
  const label = change.before === 0 ? "new" : `${change.before} -> ${change.after}`;
  return `  ${change.file}  ${change.rule}  ${label}  ${hintFor(change.rule, rules)}`;
}

function onlyRules(counts: Counts, rules: ReadonlySet<string>): Counts {
  return Object.fromEntries(
    Object.entries(counts).map(([file, byRule]) => [
      file,
      Object.fromEntries(Object.entries(byRule).filter(([rule]) => rules.has(rule))),
    ]),
  );
}

function totals(counts: Counts): Map<string, number> {
  const byRule = new Map<string, number>();
  for (const forFile of Object.values(counts)) {
    for (const [rule, count] of Object.entries(forFile)) {
      byRule.set(rule, (byRule.get(rule) ?? 0) + count);
    }
  }
  return byRule;
}

/** Rules whose total across all files rose; only these block a move. */
function risenTotals(baseline: Counts, current: Counts): ReadonlyArray<CountChange> {
  const before = totals(baseline);
  return [...totals(current)]
    .map(([rule, after]) => ({ file: "total", rule, before: before.get(rule) ?? 0, after }))
    .filter((change) => change.after > change.before)
    .toSorted((left, right) => left.rule.localeCompare(right.rule));
}

function problemReport(problems: readonly ScanProblem[], mode: Mode): string {
  const verb = mode === "check" ? "" : "refused to update: ";
  return [
    `lint:ratchet ${verb}the scan is incomplete, so its counts cannot be trusted. Fix these first:`,
    ...problems.map((problem) => `  ${problem.file}  ${problem.category}  ${problem.reason}`),
  ].join("\n");
}

function riseReport(
  rises: readonly CountChange[],
  risen: readonly CountChange[],
  input: Readonly<{ mode: Mode; rules: readonly RatchetRule[] }>,
): string {
  const verb = input.mode === "check" ? "" : "refused to update: ";
  const blocked = new Set(risen.map((change) => change.rule));
  const moved = [...new Set(rises.map((change) => change.rule))].filter(
    (rule) => !blocked.has(rule),
  );
  const moveHint =
    moved.length === 0
      ? []
      : [
          `The total for ${moved.join(", ")} did not rise, so this looks like debt moving between files (a rename or split). If so, run \`bun run lint:ratchet --update --allow-moves\`.`,
        ];
  return [
    `lint:ratchet ${verb}${rises.length} count(s) rose. Fix the code; the baseline only goes down.`,
    ...rises.map((change) => describeRise(change, input.rules)),
    ...moveHint,
  ].join("\n");
}

function moveRefusal(risen: readonly CountChange[], rules: readonly RatchetRule[]): string {
  return [
    `lint:ratchet refused to move debt: ${risen.length} rule total(s) rose. A move only shifts counts between files.`,
    ...risen.map(
      (change) =>
        `  ${change.rule}  total ${change.before} -> ${change.after}  ${hintFor(change.rule, rules)}`,
    ),
  ].join("\n");
}

function signed(change: CountChange): string {
  const delta = change.after - change.before;
  return `${change.file} ${delta > 0 ? "+" : ""}${delta}`;
}

/** One line per rule that rose somewhere: the files it left and the files it went to. */
function moveLines(rises: readonly CountChange[], drops: readonly CountChange[]): string[] {
  const rules = [...new Set(rises.map((change) => change.rule))].toSorted();
  return rules.map((rule) => {
    const from = drops.filter((change) => change.rule === rule).map(signed);
    const to = rises.filter((change) => change.rule === rule).map(signed);
    return `  moved ${rule}: ${from.join(", ")} -> ${to.join(", ")}`;
  });
}

function updated(
  input: Readonly<{
    current: Counts;
    rises: readonly CountChange[];
    drops: readonly CountChange[];
  }>,
  unseeded: readonly string[],
  rules: readonly RatchetRule[],
): RatchetOutcome {
  const seededNow = unseeded.length === 0 ? "" : ` Seeded ${unseeded.join(", ")}.`;
  const moves = moveLines(input.rises, input.drops);
  const movedNow = moves.length === 0 ? "" : ` Moved debt in ${moves.length} rule(s).`;
  const moved = new Set(input.rises.map((change) => change.rule));
  const lowered = input.drops.filter((change) => !moved.has(change.rule)).length;
  return {
    exitCode: 0,
    report: [
      `lint:ratchet baseline updated: ${lowered} count(s) lowered.${movedNow}${seededNow}`,
      ...moves,
    ].join("\n"),
    nextBaseline: { rules: rules.map((rule) => rule.id), counts: input.current },
  };
}

function checked(drops: readonly CountChange[], unseeded: readonly string[]): RatchetOutcome {
  if (unseeded.length > 0) {
    return {
      exitCode: 1,
      report: `lint:ratchet: ${unseeded.join(", ")} not in the baseline yet. Run \`bun run lint:ratchet --update\` to grandfather current hits.`,
    };
  }
  if (drops.length > 0) {
    return {
      exitCode: 0,
      report: `lint:ratchet: ${drops.length} count(s) dropped. Run \`bun run lint:ratchet --update\` to lock in the improvement.`,
    };
  }
  return { exitCode: 0, report: "lint:ratchet: no counts rose." };
}

/**
 * The ratchet's decision. An incomplete scan fails in every mode. A per-file rise in a baselined
 * rule fails, and `update` refuses it too; `move` accepts it when no rule's total rose. Drops pass.
 * A rule the baseline does not cover yet fails until an update seeds its current counts.
 */
export function decide(
  input: Readonly<{ baseline: Baseline; scan: Scan; mode: Mode }>,
  rules: readonly RatchetRule[],
): RatchetOutcome {
  if (input.scan.problems.length > 0) {
    return { exitCode: 1, report: problemReport(input.scan.problems, input.mode) };
  }
  const seeded = new Set(input.baseline.rules);
  const unseeded = rules.map((rule) => rule.id).filter((id) => !seeded.has(id));
  const before = onlyRules(input.baseline.counts, seeded);
  const after = onlyRules(input.scan.counts, seeded);
  const { rises, drops } = compareCounts(before, after);
  const risen = risenTotals(before, after);
  if (input.mode === "move" && risen.length > 0) {
    return { exitCode: 1, report: moveRefusal(risen, rules) };
  }
  if (rises.length > 0 && input.mode !== "move") {
    return { exitCode: 1, report: riseReport(rises, risen, { mode: input.mode, rules }) };
  }
  if (input.mode === "check") return checked(drops, unseeded);
  return updated({ current: input.scan.counts, rises, drops }, unseeded, rules);
}

function sortedCounts(counts: Counts): Counts {
  return Object.fromEntries(
    Object.keys(counts)
      .toSorted()
      .map((file) => [
        file,
        Object.fromEntries(
          Object.entries(counts[file] ?? {}).toSorted(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ]),
  );
}

export async function readBaseline(): Promise<Baseline> {
  if (!(await Bun.file(BASELINE_PATH).exists())) return { rules: [], counts: {} };
  return baselineSchema.parse(JSON.parse(await readFile(BASELINE_PATH, "utf8")));
}

async function passThroughs(): Promise<readonly PassThrough[]> {
  const found: PassThrough[] = [];
  for await (const file of PASS_THROUGH_GLOB.scan({ cwd: ROOT })) {
    if (file.includes("/.claude-plugin/types/")) continue;
    found.push(...findPassThroughs(file, await Bun.file(join(ROOT, file)).text()));
  }
  return found.toSorted(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}

function passThroughReport(found: readonly PassThrough[], listAll: boolean): string {
  const summary = `lint:ratchet warning: ${found.length} pass-through wrapper(s), report-only. Inline the call or give the wrapper a reason to exist.`;
  if (!listAll) return `${summary} List them with \`bun run lint:ratchet --warnings\`.`;
  return [summary, ...found.map((entry) => `  ${entry.file}:${entry.line}  ${entry.name}`)].join(
    "\n",
  );
}

function modeOf(argv: readonly string[]): Mode | undefined {
  const update = argv.includes("--update");
  if (!argv.includes("--allow-moves")) return update ? "update" : "check";
  return update ? "move" : undefined;
}

async function main(argv: readonly string[]): Promise<number> {
  const mode = modeOf(argv);
  if (mode === undefined) {
    process.stderr.write("lint:ratchet: --allow-moves only works with --update.\n");
    return 1;
  }
  process.stdout.write(`${passThroughReport(await passThroughs(), argv.includes("--warnings"))}\n`);
  const baseline = await readBaseline();
  const target = { root: ROOT, configPath: BIOME_CONFIG_PATH };
  const scan = await scanRepo(target, baseline.counts, RULES);
  const outcome = decide({ baseline, scan, mode }, RULES);
  if (outcome.nextBaseline !== undefined) {
    const { rules, counts } = outcome.nextBaseline;
    const text = JSON.stringify({ rules: rules.toSorted(), counts: sortedCounts(counts) }, null, 2);
    await writeFile(BASELINE_PATH, `${text}\n`);
  }
  const stream = outcome.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${outcome.report}\n`);
  return outcome.exitCode;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
