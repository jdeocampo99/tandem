import { expect, test } from "bun:test";
import {
  parseLog,
  type RankInputs,
  RULE_WEIGHTS,
  rankTargets,
} from "../../scripts/cleanup-targets.ts";
import { RULES } from "../../scripts/lint-ratchet/rules.ts";

const NOTHING: RankInputs = {
  debt: {},
  passThroughs: new Map(),
  commits: [],
  inOpenPullRequests: new Set(),
  changedRecently: new Set(),
  excludeGlobs: [],
};

function ranked(inputs: Partial<RankInputs>, limit = 10): readonly string[] {
  return rankTargets({ ...NOTHING, ...inputs }, limit).map((target) => target.file);
}

test("every ratcheted rule has a weight", () => {
  expect(RULES.map((rule) => rule.id).filter((id) => RULE_WEIGHTS[id] === undefined)).toEqual([]);
});

test("structural debt outranks the same count of type assertions", () => {
  const debt = {
    "src/asserts.ts": { "tandem/type-assertion": 2 },
    "src/branchy.ts": { "complexity/noExcessiveCognitiveComplexity": 2 },
  };
  expect(ranked({ debt })).toEqual(["src/branchy.ts", "src/asserts.ts"]);
});

test("churn lifts a hot file above colder, larger debt, and fix commits count double", () => {
  const debt = {
    "src/cold.ts": { "tandem/type-assertion": 4 },
    "src/hot.ts": { "tandem/type-assertion": 3 },
    "src/fixed.ts": { "tandem/type-assertion": 3 },
  };
  const commits = [
    { subject: "feat: one", files: ["src/hot.ts"] },
    { subject: "feat: two", files: ["src/hot.ts"] },
    { subject: "fix(store): one", files: ["src/fixed.ts"] },
    { subject: "fix: two", files: ["src/fixed.ts"] },
  ];
  const targets = rankTargets({ ...NOTHING, debt, commits }, 10);
  expect(targets.map((target) => [target.file, target.score])).toEqual([
    ["src/fixed.ts", 5.4],
    ["src/hot.ts", 4.2],
    ["src/cold.ts", 4],
  ]);
});

test("pass-through wrappers add debt to files the baseline does not list", () => {
  expect(ranked({ passThroughs: new Map([["src/wrap.ts", 2]]) })).toEqual(["src/wrap.ts"]);
});

test("churn without debt is not a target", () => {
  expect(ranked({ commits: [{ subject: "fix: busy", files: ["src/clean.ts"] }] })).toEqual([]);
});

test("nothing to rank gives no targets", () => {
  expect(rankTargets(NOTHING, 2)).toEqual([]);
});

test("limit keeps the highest scores, ties broken by path", () => {
  const debt = {
    "src/c.ts": { "suspicious/noShadow": 1 },
    "src/b.ts": { "suspicious/noShadow": 1 },
    "src/a.ts": { "suspicious/noShadow": 2 },
  };
  expect(ranked({ debt }, 2)).toEqual(["src/a.ts", "src/b.ts"]);
});

test.each([
  ["tests/a.test.ts", {}],
  ["src/a.test.ts", {}],
  ["tern-plugin/a.ts", {}],
  ["docs/a.ts", {}],
  ["scripts/lint-ratchet.ts", {}],
  ["scripts/lint-ratchet/scan.ts", {}],
  ["src/open.ts", { inOpenPullRequests: new Set(["src/open.ts"]) }],
  ["src/recent.ts", { changedRecently: new Set(["src/recent.ts"]) }],
  ["src/fenced/deep/a.ts", { excludeGlobs: ["src/fenced/**"] }],
] satisfies ReadonlyArray<readonly [string, Partial<RankInputs>]>)(
  "%s is never a target",
  (file, fence) => {
    const debt = {
      [file]: { "complexity/noExcessiveCognitiveComplexity": 9 },
      "src/ok.ts": { "suspicious/noShadow": 1 },
    };
    expect(ranked({ ...fence, debt })).toEqual(["src/ok.ts"]);
  },
);

test("parseLog splits commits and their files", () => {
  const output = "\x1efix: a\n\nsrc/a.ts\nsrc/b.ts\n\x1efeat: empty\n\x1edocs: c\n\ndocs/c.md\n";
  expect(parseLog(output)).toEqual([
    { subject: "fix: a", files: ["src/a.ts", "src/b.ts"] },
    { subject: "feat: empty", files: [] },
    { subject: "docs: c", files: ["docs/c.md"] },
  ]);
});
