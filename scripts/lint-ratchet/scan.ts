import { join } from "node:path";
import { z } from "zod";
import type { RatchetRule } from "./rules.ts";

/** Diagnostic counts per file, then per rule. A missing entry means zero. */
export type Counts = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** A reason the scan cannot be trusted: a file Biome did not fully analyze, or output it did not explain. */
export type ScanProblem = Readonly<{ file: string; category: string; reason: string }>;

export type Scan = Readonly<{ counts: Counts; problems: readonly ScanProblem[] }>;

export type BiomeTarget = Readonly<{ root: string; configPath: string }>;

const BIOME = join(import.meta.dir, "../../node_modules/.bin/biome");

const reportSchema = z.object({
  summary: z.object({
    changed: z.number(),
    unchanged: z.number(),
    diagnosticsNotPrinted: z.number(),
  }),
  diagnostics: z.array(
    z.object({
      category: z.string(),
      message: z.string(),
      location: z.object({ path: z.string() }),
    }),
  ),
});

export type BiomeRun = Readonly<{ exitCode: number; report: z.infer<typeof reportSchema> }>;

/**
 * The ratchet config enables only the ratcheted rules, so a suppression aimed at any other rule
 * looks unused to it. `bun run lint`'s own Biome pass still reports suppressions that are really unused.
 */
const HARMLESS = new Set(["suppressions/unused"]);

/** Why a diagnostic outside the ratcheted rules fails the scan, by category prefix. */
const REASONS: ReadonlyArray<readonly [string, string]> = [
  ["parse", "parse error; Biome could not analyze the file"],
  ["internalError", "Biome internal or I/O error; the file was not analyzed"],
  ["configuration", "Biome configuration error"],
  ["files/", "Biome could not process the file"],
  ["plugin", "GritQL plugin failed or reported a rule the ratchet does not know"],
];

function reasonFor(category: string): string {
  // Biome reports a file it skipped (over files.maxSize, for one) as a bare `lint` warning with no message.
  if (category === "lint")
    return "Biome skipped the file without analyzing it (larger than files.maxSize?)";
  return (
    REASONS.find(([prefix]) => category.startsWith(prefix))?.[1] ??
    "diagnostic outside the ratcheted rules"
  );
}

/** Biome files every GritQL plugin diagnostic under "plugin"; the rule id leads its message. */
function ruleOf(diagnostic: Readonly<{ category: string; message: string }>): string {
  if (diagnostic.category !== "plugin") return diagnostic.category.replace(/^lint\//u, "");
  return /^\[(?<id>[^\]]+)\]/u.exec(diagnostic.message)?.groups?.id ?? "plugin";
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

function runProblems(run: BiomeRun, hitCount: number): ScanProblem[] {
  const { summary } = run.report;
  const problems: ScanProblem[] = [];
  if (summary.changed + summary.unchanged === 0) {
    problems.push({ file: ".", category: "scan/empty", reason: "Biome analyzed no files" });
  }
  if (summary.diagnosticsNotPrinted > 0) {
    const reason = `Biome left ${summary.diagnosticsNotPrinted} diagnostic(s) out of its report`;
    problems.push({ file: ".", category: "scan/truncated", reason });
  }
  if (run.exitCode !== 0 && !(run.exitCode === 1 && hitCount > 0)) {
    const reason = `Biome exited ${run.exitCode} without a ratcheted finding to explain it`;
    problems.push({ file: ".", category: "scan/exit", reason });
  }
  return problems;
}

/** Splits a Biome report into ratcheted counts and every sign that the scan was incomplete. */
export function readReport(run: BiomeRun, rules: readonly RatchetRule[]): Scan {
  const ids = new Set(rules.map((rule) => rule.id));
  const hits: Array<{ file: string; rule: string }> = [];
  const problems: ScanProblem[] = [];
  for (const diagnostic of run.report.diagnostics) {
    const rule = ruleOf(diagnostic);
    const file = diagnostic.location.path;
    if (ids.has(rule)) hits.push({ file, rule });
    else if (!HARMLESS.has(diagnostic.category)) {
      const detail = diagnostic.message.length === 0 ? "" : `: ${diagnostic.message}`;
      problems.push({
        file,
        category: diagnostic.category,
        reason: reasonFor(diagnostic.category) + detail,
      });
    }
  }
  return { counts: tally(hits, rules), problems: [...problems, ...runProblems(run, hits.length)] };
}

export async function runBiome(target: BiomeTarget, paths: readonly string[]): Promise<BiomeRun> {
  const child = Bun.spawn(
    [
      BIOME,
      "lint",
      `--config-path=${target.configPath}`,
      "--max-diagnostics=none",
      "--reporter=json",
      ...paths,
    ],
    { cwd: target.root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const parsed = reportSchema.safeParse(JSON.parse(stdout.length === 0 ? "null" : stdout));
  if (!parsed.success) throw new Error(`biome exited ${exitCode} with no JSON report:\n${stderr}`);
  return { exitCode, report: parsed.data };
}

/** A baselined file with no findings is either clean or unscanned; an explicit run tells them apart. */
async function confirmScanned(target: BiomeTarget, file: string): Promise<ScanProblem[]> {
  if (!(await Bun.file(join(target.root, file)).exists())) return [];
  const { exitCode, report } = await runBiome(target, [file]);
  if (exitCode === 0 && report.summary.changed + report.summary.unchanged === 1) return [];
  const reason = "baselined file is on disk but Biome did not analyze it (ignored or unsupported?)";
  return [{ file, category: "scan/missing", reason }];
}

/** Scans the repository and checks that every baselined file still on disk was analyzed. */
export async function scanRepo(
  target: BiomeTarget,
  baseline: Counts,
  rules: readonly RatchetRule[],
): Promise<Scan> {
  const scan = readReport(await runBiome(target, ["."]), rules);
  const reported = new Set(scan.problems.map((problem) => problem.file));
  const vanished = Object.keys(baseline).filter(
    (file) => scan.counts[file] === undefined && !reported.has(file),
  );
  const missing = await Promise.all(vanished.map((file) => confirmScanned(target, file)));
  return { counts: scan.counts, problems: [...scan.problems, ...missing.flat()] };
}
