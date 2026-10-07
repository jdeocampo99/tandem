import { join } from "node:path";
import { z } from "zod";
import { findPassThroughs } from "./lint-ratchet/pass-through.ts";
import type { Counts } from "./lint-ratchet/scan.ts";
import { readBaseline } from "./lint-ratchet.ts";

/** One non-merge commit on origin/main: its subject and the files it touched. */
export type Commit = Readonly<{ subject: string; files: readonly string[] }>;

export type RankInputs = Readonly<{
  /** Ratchet counts per file, from scripts/lint-ratchet/baseline.json. */
  debt: Counts;
  passThroughs: ReadonlyMap<string, number>;
  /** Commits from the churn window (60 days). */
  commits: readonly Commit[];
  /** Files touched by an open pull request, under either their old or new name. */
  inOpenPullRequests: ReadonlySet<string>;
  /** Files changed on origin/main in the last 48 hours. */
  changedRecently: ReadonlySet<string>;
  /** Globs from scripts/cleanup-targets.exclude. */
  excludeGlobs: readonly string[];
}>;

export type Target = Readonly<{
  file: string;
  score: number;
  debt: number;
  churn: number;
  reason: string;
}>;

/**
 * Structural debt (long, branchy, wide or nested code, hidden clocks, unparsed JSON) costs a reader
 * more than a type assertion or a shadowed name, so it weighs more. Rules missing here weigh 1.
 */
export const RULE_WEIGHTS: Readonly<Record<string, number>> = {
  "complexity/noExcessiveCognitiveComplexity": 3,
  "complexity/noExcessiveLinesPerFunction": 3,
  "style/noExcessiveLinesPerFile": 3,
  "style/noNestedTernary": 2,
  "complexity/useMaxParams": 2,
  "tandem/hidden-clock": 2,
  "tandem/json-parse-cast": 2,
  "suspicious/noUnnecessaryConditions": 1,
  "suspicious/noSkippedTests": 1,
  "suspicious/noShadow": 1,
  "tandem/type-assertion": 1,
};
const PASS_THROUGH_WEIGHT = 1;
/** A fix commit counts twice: it marks a spot where the debt already produced a bug. */
const FIX_COMMIT = /^fix\b|\bbug/iu;
/** Weighted commits that double a file's score; hot debt outranks cold debt. */
const CHURN_FOR_DOUBLE = 5;
/** Never targeted: tests, Luau, docs, and the ratchet that measures the cleanup. */
const FENCED_PREFIXES = ["tests/", "tern-plugin/", "docs/", "scripts/lint-ratchet"];

function fenced(file: string, inputs: RankInputs): boolean {
  return (
    file.endsWith(".test.ts") ||
    FENCED_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    inputs.inOpenPullRequests.has(file) ||
    inputs.changedRecently.has(file) ||
    inputs.excludeGlobs.some((glob) => new Bun.Glob(glob).match(file))
  );
}

function churnByFile(commits: readonly Commit[]): Map<string, { commits: number; fixes: number }> {
  const churn = new Map<string, { commits: number; fixes: number }>();
  for (const commit of commits) {
    const fix = FIX_COMMIT.test(commit.subject) ? 1 : 0;
    for (const file of new Set(commit.files)) {
      const seen = churn.get(file) ?? { commits: 0, fixes: 0 };
      churn.set(file, { commits: seen.commits + 1, fixes: seen.fixes + fix });
    }
  }
  return churn;
}

function describe(
  rules: Readonly<Record<string, number>>,
  passThroughs: number,
  churn: Readonly<{ commits: number; fixes: number }>,
): string {
  const worst = Object.entries(rules)
    .toSorted(
      ([a, left], [b, right]) => right * (RULE_WEIGHTS[b] ?? 1) - left * (RULE_WEIGHTS[a] ?? 1),
    )
    .map(([rule, count]) => `${rule.split("/").at(-1)} x${count}`);
  const wrappers = passThroughs === 0 ? [] : [`pass-through x${passThroughs}`];
  return `${[...worst, ...wrappers].join(", ")}; ${churn.commits} commits (${churn.fixes} fix) in 60 days`;
}

/** Files ranked by weighted ratchet debt, scaled up by recent churn, with every fenced file left out. */
export function rankTargets(inputs: RankInputs, limit: number): readonly Target[] {
  const churn = churnByFile(inputs.commits);
  const files = new Set([...Object.keys(inputs.debt), ...inputs.passThroughs.keys()]);
  return [...files]
    .filter((file) => !fenced(file, inputs))
    .map((file) => {
      const rules = inputs.debt[file] ?? {};
      const passThroughs = inputs.passThroughs.get(file) ?? 0;
      const debt =
        Object.entries(rules).reduce((sum, [rule, n]) => sum + n * (RULE_WEIGHTS[rule] ?? 1), 0) +
        passThroughs * PASS_THROUGH_WEIGHT;
      const history = churn.get(file) ?? { commits: 0, fixes: 0 };
      const weightedChurn = history.commits + history.fixes;
      const score = Math.round(debt * (1 + weightedChurn / CHURN_FOR_DOUBLE) * 10) / 10;
      const reason = describe(rules, passThroughs, history);
      return { file, score, debt, churn: weightedChurn, reason };
    })
    .filter((target) => target.score > 0)
    .toSorted((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, limit);
}

/** Parses `git log --format=%x1e%s --name-only` output. */
export function parseLog(output: string): readonly Commit[] {
  return output
    .split("\x1e")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const [subject = "", ...files] = chunk.split("\n");
      return { subject, files: files.filter((file) => file !== "") };
    });
}

const ROOT = join(import.meta.dir, "..");
const EXCLUDE_PATH = join(ROOT, "scripts/cleanup-targets.exclude");
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const pullRequestsSchema = z.array(z.object({ number: z.number().int() }));

/** Runs a command in the repository root; any failure stops the ranking rather than guessing. */
function run(command: readonly string[]): string {
  const result = Bun.spawnSync([...command], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function lines(output: string): readonly string[] {
  return output.split("\n").filter((line) => line.trim() !== "");
}

function openPullRequestFiles(): ReadonlySet<string> {
  const list = run(["gh", "pr", "list", "--state", "open", "--json", "number", "--limit", "1000"]);
  const files = pullRequestsSchema
    .parse(JSON.parse(list))
    .flatMap(({ number }) =>
      lines(
        run([
          "gh",
          "api",
          "--paginate",
          `repos/{owner}/{repo}/pulls/${number}/files`,
          "--jq",
          ".[] | .filename, (.previous_filename // empty)",
        ]),
      ),
    );
  return new Set(files);
}

function changedRecently(): ReadonlySet<string> {
  const before = run([
    "git",
    "rev-list",
    "-1",
    "--first-parent",
    "--before=48.hours",
    "origin/main",
  ]);
  const base = before.trim() === "" ? EMPTY_TREE : before.trim();
  return new Set(lines(run(["git", "diff", "--name-only", base, "origin/main"])));
}

async function excludeGlobs(): Promise<readonly string[]> {
  const file = Bun.file(EXCLUDE_PATH);
  if (!(await file.exists())) return [];
  return lines(await file.text())
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#"));
}

async function passThroughCounts(): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>();
  for await (const file of new Bun.Glob("{src,evals,scripts}/**/*.ts").scan({ cwd: ROOT })) {
    const found = findPassThroughs(file, await Bun.file(join(ROOT, file)).text()).length;
    if (found > 0) counts.set(file, found);
  }
  return counts;
}

async function gather(): Promise<RankInputs> {
  const log = ["git", "log", "origin/main", "--since=60.days", "--no-merges"];
  return {
    debt: (await readBaseline()).counts,
    passThroughs: await passThroughCounts(),
    commits: parseLog(run([...log, "--format=%x1e%s", "--name-only"])),
    inOpenPullRequests: openPullRequestFiles(),
    changedRecently: changedRecently(),
    excludeGlobs: await excludeGlobs(),
  };
}

function limitOf(argv: readonly string[]): number {
  const index = argv.indexOf("--limit");
  if (index === -1) return 10;
  const limit = Number(argv[index + 1]);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit needs a positive integer");
  return limit;
}

async function main(argv: readonly string[]): Promise<number> {
  const targets = rankTargets(await gather(), limitOf(argv));
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(targets, null, 2)}\n`);
    return 0;
  }
  if (targets.length === 0) process.stdout.write("cleanup-targets: no targets.\n");
  for (const [index, target] of targets.entries()) {
    process.stdout.write(`${index + 1}. ${target.file}  score ${target.score}  ${target.reason}\n`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`cleanup-targets: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
