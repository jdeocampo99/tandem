import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** Diagnostic counts per file, then per rule. A missing entry means zero. */
export type Counts = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** The committed baseline: the rules it covers and their grandfathered counts. */
export type Baseline = Readonly<{ rules: readonly string[]; counts: Counts }>;

export type CountChange = Readonly<{ file: string; rule: string; before: number; after: number }>;

export type RatchetRule = Readonly<{
  id: string;
  hint: string;
  /** Files the rule is ratcheted in; others are left out of the counts. */
  appliesTo: (file: string) => boolean;
}>;

export type RatchetOutcome = Readonly<{
  exitCode: 0 | 1;
  report: string;
  /** The baseline to write, present only when `--update` may lower or seed it. */
  nextBaseline?: Baseline;
}>;

const ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(ROOT, "scripts/lint-ratchet/baseline.json");
/** Enables exactly the ratcheted Biome rules, at their default limits, over the same files as biome.json. */
const BIOME_CONFIG_PATH = join(ROOT, "scripts/lint-ratchet/ratchet.json");

const isTest = (file: string): boolean => file.startsWith("tests/") || file.endsWith(".test.ts");
const everywhere = (): boolean => true;

export const RULES: readonly RatchetRule[] = [
  {
    id: "complexity/noExcessiveCognitiveComplexity",
    hint: "Split the function into named steps, or replace branching with a lookup table.",
    appliesTo: everywhere,
  },
  {
    id: "complexity/noExcessiveLinesPerFunction",
    hint: "Extract cohesive steps into named functions (limit 50 lines).",
    appliesTo: (file) => !isTest(file),
  },
  {
    id: "style/noNestedTernary",
    hint: "Use if/else, a switch, or a lookup table instead of nesting ternaries.",
    appliesTo: everywhere,
  },
  {
    id: "style/noExcessiveLinesPerFile",
    hint: "Split the file by responsibility (limit 300 lines).",
    appliesTo: everywhere,
  },
  {
    id: "complexity/useMaxParams",
    hint: "Group related parameters into one named object (limit 4).",
    appliesTo: everywhere,
  },
  {
    id: "suspicious/noUnnecessaryConditions",
    hint: "Delete the check; the types already decide it.",
    appliesTo: everywhere,
  },
  {
    id: "suspicious/noShadow",
    hint: "Rename the inner binding so it does not hide the outer one.",
    appliesTo: everywhere,
  },
  {
    id: "suspicious/noSkippedTests",
    hint: "Fix or delete the skipped test; gate machine-specific tests on an explicit flag.",
    appliesTo: everywhere,
  },
];

const baselineSchema = z.object({
  rules: z.array(z.string()),
  counts: z.record(z.record(z.number().int().positive())),
});
const biomeReportSchema = z.object({
  diagnostics: z.array(
    z.object({ category: z.string(), location: z.object({ path: z.string() }) }),
  ),
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

/** Builds counts from (file, rule) hits, keeping only ratcheted rules in the files they apply to. */
export function tally(
  hits: Iterable<Readonly<{ file: string; rule: string }>>,
  rules: readonly RatchetRule[],
): Counts {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const counts: Record<string, Record<string, number>> = {};
  for (const { file, rule } of hits) {
    if (byId.get(rule)?.appliesTo(file) !== true) continue;
    const forFile = counts[file] ?? {};
    forFile[rule] = (forFile[rule] ?? 0) + 1;
    counts[file] = forFile;
  }
  return counts;
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

/**
 * The ratchet's decision. A rise in a baselined rule fails, and `--update` refuses it too. Drops
 * pass. A rule the baseline does not cover yet fails until `--update` seeds its current counts.
 */
export function decide(
  input: Readonly<{ baseline: Baseline; current: Counts; update: boolean }>,
  rules: readonly RatchetRule[],
): RatchetOutcome {
  const seeded = new Set(input.baseline.rules);
  const unseeded = rules.map((rule) => rule.id).filter((id) => !seeded.has(id));
  const { rises, drops } = compareCounts(
    onlyRules(input.baseline.counts, seeded),
    onlyRules(input.current, seeded),
  );
  if (rises.length > 0) {
    const verb = input.update ? "refused to update: " : "";
    return {
      exitCode: 1,
      report: [
        `lint:ratchet ${verb}${rises.length} count(s) rose. Fix the code; the baseline only goes down.`,
        ...rises.map((change) => describeRise(change, rules)),
      ].join("\n"),
    };
  }
  if (input.update) {
    const seededNow = unseeded.length === 0 ? "" : ` Seeded ${unseeded.join(", ")}.`;
    return {
      exitCode: 0,
      report: `lint:ratchet baseline updated: ${drops.length} count(s) lowered.${seededNow}`,
      nextBaseline: { rules: rules.map((rule) => rule.id), counts: input.current },
    };
  }
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

async function biomeHits(): Promise<ReadonlyArray<Readonly<{ file: string; rule: string }>>> {
  const child = Bun.spawn(
    [
      "bunx",
      "biome",
      "lint",
      `--config-path=${BIOME_CONFIG_PATH}`,
      "--max-diagnostics=none",
      "--reporter=json",
      ".",
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const parsed = biomeReportSchema.safeParse(JSON.parse(stdout.length === 0 ? "null" : stdout));
  if (!parsed.success) throw new Error(`biome produced no JSON report:\n${stderr}`);
  return parsed.data.diagnostics.map((diagnostic) => ({
    file: diagnostic.location.path,
    rule: diagnostic.category.replace(/^lint\//u, ""),
  }));
}

async function readBaseline(): Promise<Baseline> {
  if (!(await Bun.file(BASELINE_PATH).exists())) return { rules: [], counts: {} };
  return baselineSchema.parse(JSON.parse(await readFile(BASELINE_PATH, "utf8")));
}

async function main(argv: readonly string[]): Promise<number> {
  const update = argv.includes("--update");
  const current = tally(await biomeHits(), RULES);
  const outcome = decide({ baseline: await readBaseline(), current, update }, RULES);
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
