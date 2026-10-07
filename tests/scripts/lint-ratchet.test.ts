import { expect, test } from "bun:test";
import { basename, join } from "node:path";
import { z } from "zod";
import { findPassThroughs } from "../../scripts/lint-ratchet/pass-through.ts";
import { RULES as RATCHETED, type RatchetRule } from "../../scripts/lint-ratchet/rules.ts";
import { type Baseline, decide, tally } from "../../scripts/lint-ratchet.ts";

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

test("a rising count fails and names the file, rule, counts and fix", () => {
  const outcome = decide(
    { baseline: BASELINE, current: { "src/a.ts": { "style/noNestedTernary": 3 } }, update: false },
    RULES,
  );
  expect(outcome.exitCode).toBe(1);
  expect(outcome.report).toContain("src/a.ts  style/noNestedTernary  2 -> 3  Use if/else.");
});

test("a new (file, rule) pair fails", () => {
  const current = {
    "src/a.ts": { "style/noNestedTernary": 2 },
    "src/b.ts": { "complexity/useMaxParams": 1 },
  };
  const outcome = decide({ baseline: BASELINE, current, update: false }, RULES);
  expect(outcome.exitCode).toBe(1);
  expect(outcome.report).toContain("src/b.ts  complexity/useMaxParams  new  Group parameters.");
});

test("a dropped count passes and asks for an update without writing one", () => {
  const outcome = decide(
    { baseline: BASELINE, current: { "src/a.ts": { "style/noNestedTernary": 1 } }, update: false },
    RULES,
  );
  expect(outcome).toEqual({
    exitCode: 0,
    report:
      "lint:ratchet: 1 count(s) dropped. Run `bun run lint:ratchet --update` to lock in the improvement.",
  });
});

test("update lowers the baseline", () => {
  const current = { "src/a.ts": { "style/noNestedTernary": 1 } };
  const outcome = decide({ baseline: BASELINE, current, update: true }, RULES);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.nextBaseline).toEqual({ rules: BASELINE.rules, counts: current });
});

test("update refuses to raise any count", () => {
  const current = {
    "src/a.ts": { "style/noNestedTernary": 1 },
    "src/b.ts": { "style/noNestedTernary": 1 },
  };
  const outcome = decide({ baseline: BASELINE, current, update: true }, RULES);
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
  expect(decide({ baseline, current, update: false }, RULES).exitCode).toBe(1);
  expect(decide({ baseline, current, update: true }, RULES).nextBaseline).toEqual({
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
