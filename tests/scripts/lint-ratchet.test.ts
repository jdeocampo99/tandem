import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import {
  type Baseline,
  decide,
  RULES as RATCHETED,
  type RatchetRule,
  tally,
} from "../../scripts/lint-ratchet.ts";

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

test("the ratchet's Biome config enables exactly the ratcheted rules", async () => {
  const config = z
    .object({ linter: z.object({ rules: z.record(z.union([z.boolean(), z.record(z.string())])) }) })
    .parse(
      JSON.parse(
        await Bun.file(join(import.meta.dir, "../../scripts/lint-ratchet/ratchet.json")).text(),
      ),
    );
  const enabled = Object.entries(config.linter.rules).flatMap(([group, rules]) =>
    typeof rules === "boolean" ? [] : Object.keys(rules).map((rule) => `${group}/${rule}`),
  );
  expect(enabled.toSorted()).toEqual(RATCHETED.map((rule) => rule.id).toSorted());
});
