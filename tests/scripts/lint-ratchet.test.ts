import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { findPassThroughs } from "../../scripts/lint-ratchet/pass-through.ts";
import { RULES as RATCHETED, type RatchetRule } from "../../scripts/lint-ratchet/rules.ts";
import { type BiomeTarget, type Counts, scanRepo, tally } from "../../scripts/lint-ratchet/scan.ts";
import { type Baseline, decide, type Mode } from "../../scripts/lint-ratchet.ts";

const RULES: readonly RatchetRule[] = [
  { id: "style/noNestedTernary", hint: "Use if/else.", appliesTo: () => true },
  {
    id: "complexity/useMaxParams",
    hint: "Group parameters.",
    appliesTo: (file) => !file.startsWith("tests/"),
  },
];
const BASELINE: Baseline = {
  rules: ["style/noNestedTernary", "complexity/useMaxParams"],
  counts: { "src/a.ts": { "style/noNestedTernary": 2 } },
};

function judge(current: Counts, mode: Mode, baseline: Baseline = BASELINE) {
  return decide({ baseline, scan: { counts: current, problems: [] }, mode }, RULES);
}

test("a rising count fails and names the file, rule, counts and fix", () => {
  const outcome = judge({ "src/a.ts": { "style/noNestedTernary": 3 } }, "check");
  expect(outcome.exitCode).toBe(1);
  expect(outcome.report).toContain("src/a.ts  style/noNestedTernary  2 -> 3  Use if/else.");
});

test("a new (file, rule) pair fails", () => {
  const current = {
    "src/a.ts": { "style/noNestedTernary": 2 },
    "src/b.ts": { "complexity/useMaxParams": 1 },
  };
  const outcome = judge(current, "check");
  expect(outcome.exitCode).toBe(1);
  expect(outcome.report).toContain("src/b.ts  complexity/useMaxParams  new  Group parameters.");
});

test("a dropped count passes and asks for an update without writing one", () => {
  const outcome = judge({ "src/a.ts": { "style/noNestedTernary": 1 } }, "check");
  expect(outcome).toEqual({
    exitCode: 0,
    report:
      "lint:ratchet: 1 count(s) dropped. Run `bun run lint:ratchet --update` to lock in the improvement.",
  });
});

test("update lowers the baseline", () => {
  const current = { "src/a.ts": { "style/noNestedTernary": 1 } };
  const outcome = judge(current, "update");
  expect(outcome.exitCode).toBe(0);
  expect(outcome.nextBaseline).toEqual({ rules: BASELINE.rules, counts: current });
});

test("update refuses to raise any count", () => {
  const current = {
    "src/a.ts": { "style/noNestedTernary": 1 },
    "src/b.ts": { "style/noNestedTernary": 1 },
  };
  const outcome = judge(current, "update");
  expect(outcome.exitCode).toBe(1);
  expect(outcome.nextBaseline).toBeUndefined();
  expect(outcome.report).toContain("refused to update");
});

test("a rule missing from the baseline fails until update seeds its current counts", () => {
  const baseline: Baseline = { rules: ["style/noNestedTernary"], counts: BASELINE.counts };
  const current = {
    "src/a.ts": { "style/noNestedTernary": 2 },
    "src/c.ts": { "complexity/useMaxParams": 4 },
  };
  expect(judge(current, "check", baseline).exitCode).toBe(1);
  expect(judge(current, "update", baseline).nextBaseline).toEqual({
    rules: ["style/noNestedTernary", "complexity/useMaxParams"],
    counts: current,
  });
});

test("tally counts only ratcheted rules in the files they apply to", () => {
  expect(
    tally(
      [
        { file: "src/a.ts", rule: "complexity/useMaxParams" },
        { file: "src/a.ts", rule: "complexity/useMaxParams" },
        { file: "tests/a.test.ts", rule: "complexity/useMaxParams" },
        { file: "src/a.ts", rule: "suspicious/noShadow" },
      ],
      RULES,
    ),
  ).toEqual({ "src/a.ts": { "complexity/useMaxParams": 2 } });
});

test("the ratchet's Biome config enables exactly the ratcheted rules and plugins", async () => {
  const config = z
    .object({
      plugins: z.array(z.string()),
      linter: z.object({ rules: z.record(z.union([z.boolean(), z.record(z.string())])) }),
    })
    .parse(
      JSON.parse(
        await Bun.file(join(import.meta.dir, "../../scripts/lint-ratchet/ratchet.json")).text(),
      ),
    );
  const enabled = Object.entries(config.linter.rules).flatMap(([group, rules]) =>
    typeof rules === "boolean" ? [] : Object.keys(rules).map((rule) => `${group}/${rule}`),
  );
  const plugins = config.plugins.map((path) => `tandem/${basename(path, ".grit")}`);
  expect([...enabled, ...plugins].toSorted()).toEqual(RATCHETED.map((rule) => rule.id).toSorted());
});

test("pass-through wrappers are found, inline callbacks and partial forwards are not", () => {
  const source = `
export function forward(a: string, b: number): string { return target(a, b); }
const arrow = async (input: Input) => await port.inspect(input);
const backend = { close: (input: Input) => select().close(input) };
class Service { open(...args: string[]) { this.inner.open(...args); } }
const reordered = (a: string, b: string) => target(b, a);
const extra = (a: string) => target(a, 1);
const thunk = () => target();
const shown = items.map((item) => show(item));
class Child extends Base { constructor(a: string) { super(a); } }
`;
  expect(findPassThroughs("x.ts", source).map((found) => found.name)).toEqual([
    "forward",
    "arrow",
    "close",
    "open",
  ]);
});

test("a move with --allow-moves rewrites the baseline when it renames a file", () => {
  const current = { "src/renamed.ts": { "style/noNestedTernary": 2 } };
  const outcome = judge(current, "move");
  expect(outcome.exitCode).toBe(0);
  expect(outcome.nextBaseline).toEqual({ rules: BASELINE.rules, counts: current });
  expect(outcome.report).toBe(
    [
      "lint:ratchet baseline updated: 0 count(s) lowered. Moved debt in 1 rule(s).",
      "  moved style/noNestedTernary: src/a.ts -2 -> src/renamed.ts +2",
    ].join("\n"),
  );
});

test("a move with --allow-moves splits one file's debt across three", () => {
  const baseline: Baseline = {
    rules: BASELINE.rules,
    counts: { "src/big.ts": { "style/noNestedTernary": 3, "complexity/useMaxParams": 1 } },
  };
  const current = {
    "src/one.ts": { "style/noNestedTernary": 1 },
    "src/two.ts": { "style/noNestedTernary": 1, "complexity/useMaxParams": 1 },
    "src/three.ts": { "style/noNestedTernary": 1 },
  };
  const outcome = judge(current, "move", baseline);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.nextBaseline?.counts).toEqual(current);
  expect(outcome.report).toContain(
    "moved style/noNestedTernary: src/big.ts -3 -> src/one.ts +1, src/three.ts +1, src/two.ts +1",
  );
  expect(outcome.report).toContain("moved complexity/useMaxParams: src/big.ts -1 -> src/two.ts +1");
});

test("--allow-moves refuses when a rule's total rises", () => {
  const outcome = judge({ "src/renamed.ts": { "style/noNestedTernary": 3 } }, "move");
  expect(outcome.exitCode).toBe(1);
  expect(outcome.nextBaseline).toBeUndefined();
  expect(outcome.report).toContain("refused to move debt");
  expect(outcome.report).toContain("style/noNestedTernary  total 2 -> 3  Use if/else.");
});

test("plain lint on a move fails per file and points at --allow-moves", () => {
  const outcome = judge({ "src/renamed.ts": { "style/noNestedTernary": 2 } }, "check");
  expect(outcome.exitCode).toBe(1);
  expect(outcome.report).toContain("src/renamed.ts  style/noNestedTernary  new  Use if/else.");
  expect(outcome.report).toContain("bun run lint:ratchet --update --allow-moves");
});

test("plain lint on a real rise does not suggest --allow-moves", () => {
  const outcome = judge({ "src/a.ts": { "style/noNestedTernary": 3 } }, "check");
  expect(outcome.report).not.toContain("--allow-moves");
});

test("an incomplete scan fails in every mode and names the file and category", () => {
  const scan = {
    counts: {},
    problems: [{ file: "src/big.ts", category: "lint", reason: "skipped" }],
  };
  for (const mode of ["check", "update", "move"] as const) {
    const outcome = decide({ baseline: BASELINE, scan, mode }, RULES);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.nextBaseline).toBeUndefined();
    expect(outcome.report).toContain("src/big.ts  lint  skipped");
  }
});

const NESTED = "export const pick = (a: boolean, b: boolean) => (a ? 1 : b ? 2 : 3);\n";

/** A throwaway repository with its own ratchet config that enables noNestedTernary plus `extraRules`. */
async function fixture(
  files: Readonly<Record<string, string>>,
  config: Readonly<{ maxSize?: number; ignore?: readonly string[]; extraRules?: object }> = {},
): Promise<BiomeTarget> {
  // Biome stops honoring `files.includes` when the config path runs through a symlink like /var.
  const root = await realpath(await mkdtemp(join(tmpdir(), "lint-ratchet-")));
  for (const [file, text] of Object.entries(files)) await writeFile(join(root, file), text);
  const ratchet = {
    root: true,
    files: {
      includes: ["**/*.ts", ...(config.ignore ?? []).map((file) => `!${file}`)],
      ...(config.maxSize === undefined ? {} : { maxSize: config.maxSize }),
    },
    formatter: { enabled: false },
    assist: { enabled: false },
    linter: {
      rules: { recommended: false, style: { noNestedTernary: "error" }, ...config.extraRules },
    },
  };
  await writeFile(join(root, "ratchet.json"), JSON.stringify(ratchet));
  return { root, configPath: join(root, "ratchet.json") };
}

async function scanned(target: BiomeTarget, baseline: Counts) {
  try {
    return await scanRepo(target, baseline, RULES);
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
}

test("a file over Biome's size limit fails the ratchet in check and update modes", async () => {
  const big = `${NESTED}// ${"x".repeat(400)}\n`;
  const counts = { "big.ts": { "style/noNestedTernary": 1 } };
  const scan = await scanned(
    await fixture({ "big.ts": big, "small.ts": NESTED }, { maxSize: 200 }),
    counts,
  );
  expect(scan.problems.map((problem) => [problem.file, problem.category])).toEqual([
    ["big.ts", "lint"],
  ]);
  for (const mode of ["check", "update"] as const) {
    const outcome = decide({ baseline: { rules: BASELINE.rules, counts }, scan, mode }, RULES);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.nextBaseline).toBeUndefined();
    expect(outcome.report).toContain("big.ts  lint  Biome skipped the file without analyzing it");
  }
});

test("a diagnostic outside the ratcheted rules fails the scan", async () => {
  const target = await fixture(
    { "a.ts": "debugger;\n" },
    { extraRules: { suspicious: { noDebugger: "error" } } },
  );
  const scan = await scanned(target, {});
  expect(scan.problems).toContainEqual(
    expect.objectContaining({ file: "a.ts", category: "lint/suspicious/noDebugger" }),
  );
});

test("a baselined file on disk that Biome no longer analyzes fails the scan", async () => {
  const target = await fixture(
    { "hidden.ts": NESTED, "seen.ts": NESTED },
    { ignore: ["hidden.ts"] },
  );
  const scan = await scanned(target, { "hidden.ts": { "style/noNestedTernary": 1 } });
  expect(scan.problems).toEqual([
    expect.objectContaining({ file: "hidden.ts", category: "scan/missing" }),
  ]);
});

test("a deleted or fully cleaned baselined file drops without a scan problem", async () => {
  const target = await fixture({ "cleaned.ts": "export const one = 1;\n", "kept.ts": NESTED });
  const baselineCounts = {
    "deleted.ts": { "style/noNestedTernary": 1 },
    "cleaned.ts": { "style/noNestedTernary": 1 },
    "kept.ts": { "style/noNestedTernary": 1 },
  };
  const scan = await scanned(target, baselineCounts);
  expect(scan).toEqual({ counts: { "kept.ts": { "style/noNestedTernary": 1 } }, problems: [] });
  const outcome = decide(
    { baseline: { rules: BASELINE.rules, counts: baselineCounts }, scan, mode: "check" },
    RULES,
  );
  expect(outcome.exitCode).toBe(0);
  expect(outcome.report).toContain("2 count(s) dropped");
});

test("a scan that analyzes no files fails", async () => {
  const target = await fixture({ "notes.md": "# notes\n" });
  const scan = await scanned(target, {});
  expect(scan.problems.map((problem) => problem.category)).toContain("scan/empty");
});

test("--allow-moves without --update is rejected", async () => {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "../../scripts/lint-ratchet.ts"), "--allow-moves"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toBe(
    "lint:ratchet: --allow-moves only works with --update.\n",
  );
});
