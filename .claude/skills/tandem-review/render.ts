#!/usr/bin/env bun
/**
 * bun render.ts <batch.json> <out.html>
 *
 * Validates a tandem-review batch file, loads the previous batch from the same directory (if any)
 * to compute deltas, and writes a self-contained HTML page built from .claude/skills/tandem-review/
 * page.html with the data embedded as JSON. Not part of the Tandem app: standalone, no src/ imports.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Fraction = Readonly<{ readonly num: number; readonly den: number }>;
export type Problem = Readonly<{
  readonly name: string;
  readonly count: number | null;
  readonly source: "agent" | "you";
  readonly status: "new" | "recurring" | "fixed" | "fix merged, unverified" | "one incident";
  readonly note?: string;
}>;
export type Card = Readonly<{
  readonly taskId: string;
  readonly title: string;
  readonly facts: readonly string[];
  readonly note: string;
  readonly quote: string;
  readonly trace: Readonly<Record<string, string>>;
}>;
export type NoProblemItem = Readonly<{
  readonly taskId: string;
  readonly title: string;
  readonly reason: string;
}>;
export type FoldedGroup = Readonly<{
  readonly label: string;
  readonly items: readonly NoProblemItem[];
}>;
export type Batch = Readonly<{
  readonly ranAt: string;
  readonly since: string;
  readonly taskCount: number;
  readonly verdict: string;
  readonly metrics: Readonly<{
    readonly firstPassReview: Fraction;
    readonly fixRoundsPerTask: number;
    readonly merged: Fraction;
    readonly offScopeFiles: number | null;
    readonly briefNoRate: Fraction | null;
  }>;
  readonly problems: readonly Problem[];
  readonly cards: readonly Card[];
  readonly noProblem: readonly NoProblemItem[];
  readonly folded: readonly FoldedGroup[];
  /** One sentence naming lesser, once-seen issues left out of `problems`. */
  readonly alsoSeen?: string;
}>;

function fail(path: string, expected: string): never {
  throw new Error(`Invalid batch JSON: "${path}" must be ${expected}`);
}
const str = (v: unknown, p: string): string => (typeof v === "string" ? v : fail(p, "a string"));
const num = (v: unknown, p: string): number =>
  typeof v === "number" && !Number.isNaN(v) ? v : fail(p, "a number");
const nullableNum = (v: unknown, p: string): number | null => (v === null ? null : num(v, p));
const obj = (v: unknown, p: string): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail(p, "an object");
const arr = (v: unknown, p: string): unknown[] => (Array.isArray(v) ? v : fail(p, "an array"));
const strArray = (v: unknown, p: string): string[] =>
  arr(v, p).map((item, i) => str(item, `${p}[${i}]`));
const strRecord = (v: unknown, p: string): Record<string, string> =>
  Object.fromEntries(Object.entries(obj(v, p)).map(([k, val]) => [k, str(val, `${p}.${k}`)]));
const fraction = (v: unknown, p: string): Fraction => {
  const o = obj(v, p);
  return { num: num(o.num, `${p}.num`), den: num(o.den, `${p}.den`) };
};
const nullableFraction = (v: unknown, p: string): Fraction | null =>
  v === null ? null : fraction(v, p);
const oneOf = <T extends string>(v: unknown, p: string, options: readonly T[]): T => {
  const s = str(v, p);
  if (!(options as readonly string[]).includes(s)) fail(p, `one of ${options.join(", ")}`);
  return s as T;
};
const noProblemItem = (v: unknown, p: string): NoProblemItem => {
  const o = obj(v, p);
  return {
    taskId: str(o.taskId, `${p}.taskId`),
    title: str(o.title, `${p}.title`),
    reason: str(o.reason, `${p}.reason`),
  };
};

export function validateBatch(data: unknown): Batch {
  const b = obj(data, "batch");
  const metrics = obj(b.metrics, "batch.metrics");
  return {
    ranAt: str(b.ranAt, "batch.ranAt"),
    since: str(b.since, "batch.since"),
    taskCount: num(b.taskCount, "batch.taskCount"),
    verdict: str(b.verdict, "batch.verdict"),
    metrics: {
      firstPassReview: fraction(metrics.firstPassReview, "batch.metrics.firstPassReview"),
      fixRoundsPerTask: num(metrics.fixRoundsPerTask, "batch.metrics.fixRoundsPerTask"),
      merged: fraction(metrics.merged, "batch.metrics.merged"),
      offScopeFiles: nullableNum(metrics.offScopeFiles, "batch.metrics.offScopeFiles"),
      briefNoRate: nullableFraction(metrics.briefNoRate, "batch.metrics.briefNoRate"),
    },
    problems: arr(b.problems, "batch.problems").map((item, i) => {
      const p = `batch.problems[${i}]`;
      const o = obj(item, p);
      return {
        name: str(o.name, `${p}.name`),
        count: nullableNum(o.count, `${p}.count`),
        source: oneOf(o.source, `${p}.source`, ["agent", "you"] as const),
        status: oneOf(o.status, `${p}.status`, [
          "new",
          "recurring",
          "fixed",
          "fix merged, unverified",
          "one incident",
        ] as const),
        ...(o.note === undefined ? {} : { note: str(o.note, `${p}.note`) }),
      };
    }),
    cards: arr(b.cards, "batch.cards").map((item, i) => {
      const p = `batch.cards[${i}]`;
      const o = obj(item, p);
      return {
        taskId: str(o.taskId, `${p}.taskId`),
        title: str(o.title, `${p}.title`),
        facts: strArray(o.facts, `${p}.facts`),
        note: str(o.note, `${p}.note`),
        quote: str(o.quote, `${p}.quote`),
        trace: strRecord(o.trace, `${p}.trace`),
      };
    }),
    noProblem: arr(b.noProblem, "batch.noProblem").map((item, i) =>
      noProblemItem(item, `batch.noProblem[${i}]`),
    ),
    folded: arr(b.folded, "batch.folded").map((item, i) => {
      const p = `batch.folded[${i}]`;
      const o = obj(item, p);
      return {
        label: str(o.label, `${p}.label`),
        items: arr(o.items, `${p}.items`).map((sub, j) => noProblemItem(sub, `${p}.items[${j}]`)),
      };
    }),
    ...(b.alsoSeen === undefined ? {} : { alsoSeen: str(b.alsoSeen, "batch.alsoSeen") }),
  };
}

export type TileDelta =
  | Readonly<{ readonly kind: "baseline" }>
  | Readonly<{ readonly kind: "delta"; readonly text: string }>;
export type ComputedDeltas = Readonly<{
  readonly firstPassReview: TileDelta;
  readonly fixRoundsPerTask: TileDelta;
  readonly merged: TileDelta;
  readonly offScopeFiles: TileDelta;
  readonly briefNoRate: TileDelta;
}>;

function pct(f: Fraction): number | undefined {
  return f.den === 0 ? undefined : (f.num / f.den) * 100;
}
function signed(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return rounded === 0 ? "±0" : rounded > 0 ? `+${rounded}` : `${rounded}`;
}
function rateDelta(current: Fraction, previous: Fraction): TileDelta {
  const c = pct(current);
  const p = pct(previous);
  if (c === undefined || p === undefined) return { kind: "delta", text: "not comparable" };
  return { kind: "delta", text: `${signed(c - p)}pp vs last` };
}
function numberDelta(current: number, previous: number): TileDelta {
  return { kind: "delta", text: `${signed(current - previous)} vs last` };
}
function nullableNumberDelta(current: number | null, previous: number | null): TileDelta {
  if (current === null || previous === null) return { kind: "delta", text: "not measured yet" };
  return numberDelta(current, previous);
}
function nullableRateDelta(current: Fraction | null, previous: Fraction | null): TileDelta {
  if (current === null || previous === null) return { kind: "delta", text: "not asked yet" };
  return rateDelta(current, previous);
}

/** Baseline (no previous batch) reports every tile as "baseline"; otherwise each tile's own delta. */
export function computeDeltas(current: Batch, previous: Batch | undefined): ComputedDeltas {
  if (previous === undefined) {
    const baseline: TileDelta = { kind: "baseline" };
    return {
      firstPassReview: baseline,
      fixRoundsPerTask: baseline,
      merged: baseline,
      offScopeFiles: baseline,
      briefNoRate: baseline,
    };
  }
  return {
    firstPassReview: rateDelta(current.metrics.firstPassReview, previous.metrics.firstPassReview),
    fixRoundsPerTask: numberDelta(
      current.metrics.fixRoundsPerTask,
      previous.metrics.fixRoundsPerTask,
    ),
    merged: rateDelta(current.metrics.merged, previous.metrics.merged),
    offScopeFiles: nullableNumberDelta(
      current.metrics.offScopeFiles,
      previous.metrics.offScopeFiles,
    ),
    briefNoRate: nullableRateDelta(current.metrics.briefNoRate, previous.metrics.briefNoRate),
  };
}

/** The most recent dated batch file in `dir` strictly before `excludeFilename`, or undefined. */
async function findPreviousBatch(dir: string, excludeFilename: string): Promise<Batch | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const dated = names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name < excludeFilename)
    .sort();
  const previousName = dated.at(-1);
  if (previousName === undefined) return undefined;
  return validateBatch(JSON.parse(await readFile(join(dir, previousName), "utf8")));
}

async function main(): Promise<void> {
  const [batchPath, outPath] = process.argv.slice(2);
  if (batchPath === undefined || outPath === undefined) {
    console.error("usage: bun render.ts <batch.json> <out.html>");
    process.exit(1);
  }
  const batch = validateBatch(JSON.parse(await readFile(batchPath, "utf8")));
  const previous = await findPreviousBatch(
    dirname(batchPath),
    batchPath.split("/").at(-1) ?? batchPath,
  );
  const deltas = computeDeltas(batch, previous);
  const templatePath = join(dirname(new URL(import.meta.url).pathname), "page.html");
  const template = await readFile(templatePath, "utf8");
  const payload = JSON.stringify({ batch, deltas }).replaceAll("</", "<\\/");
  await writeFile(outPath, template.replace("__BATCH__", payload));
}

if (import.meta.main) {
  await main();
}
