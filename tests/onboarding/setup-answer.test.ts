import { expect, test } from "bun:test";
import { CLAUDE_CODE_MODELS } from "../../src/harness/claude-code/models.ts";
import type { ModelRecord } from "../../src/harness/contract.ts";
import {
  checkSetupAnswer,
  parseSetupAnswer,
  type SetupAnswer,
  type SetupAnswerFacts,
  setupProviders,
} from "../../src/onboarding/setup-answer.ts";

const catalogue: readonly ModelRecord[] = [
  {
    selector: "anthropic/opus",
    id: "opus",
    provider: "anthropic",
    name: "Opus",
    thinking: ["high"],
  },
  { selector: "openai/gpt", id: "gpt", provider: "openai", thinking: ["low", "high"] },
];

const answer = {
  tandemSetup: 1,
  mode: "setup",
  models: {
    coordinator: { model: "anthropic/opus", thinking: "high" },
    scout: { model: "anthropic/opus", thinking: "high" },
    implementer: { model: "anthropic/opus", thinking: "high" },
    reviewer: { model: "anthropic/opus", thinking: "high" },
    presentation: { model: "anthropic/opus", thinking: "high" },
  },
  repositories: [
    {
      path: "/code/api",
      validationCommands: ["bun run check"],
      setupCommands: [],
    },
    { path: "~/pasted", validationCommands: ["make check"] },
  ],
  selfImprovement: "fix",
};

const facts: SetupAnswerFacts = {
  catalogue,
  repositories: new Map([
    ["/code/api", { kind: "root", root: "/code/api", setUp: false }],
    ["~/pasted", { kind: "root", root: "/Users/me/pasted", setUp: false }],
  ]),
  homeSpecialists: new Map<string, Readonly<{ revision?: string }>>([
    ["seo-blog", { revision: "a".repeat(64) }],
    ["too-big", {}],
  ]),
};

const FIELDS = { label: "Notes", instructions: "Keep it short.", steps: ["Draft"] };

function settingsWith(specialists: readonly unknown[]): SetupAnswer {
  return parsed({ ...answer, mode: "settings", repositories: [], specialists });
}

function parsed(value: unknown): SetupAnswer {
  const result = parseSetupAnswer(JSON.stringify(value));
  if (!result.ok) throw new Error(result.problems.join(" "));
  return result.answer;
}

test("a well-formed answer passes every check on this machine", () => {
  const value = parsed(answer);
  expect(value.repositories[1]).toEqual({ path: "~/pasted", validationCommands: ["make check"] });
  expect(checkSetupAnswer(value, facts)).toEqual([]);
});

test("specialist changes parse strictly, and an answer without them changes none", () => {
  expect(parsed(answer).specialists).toEqual([]);
  expect(
    settingsWith([
      { op: "create", name: "notes", fields: { ...FIELDS, description: "When to pick it" } },
      { op: "update", name: "seo-blog", revision: "a".repeat(64), fields: FIELDS },
      { op: "remove", name: "old", revision: "b".repeat(64) },
    ]).specialists.map((change) => change.op),
  ).toEqual(["create", "update", "remove"]);
  const result = parseSetupAnswer(
    JSON.stringify({
      ...answer,
      specialists: [
        { op: "rename", name: "a" },
        { op: "remove", name: "a" },
        { op: "create", name: "b", fields: { ...FIELDS, model: "opus" } },
        { op: "create", name: "c", fields: { ...FIELDS, steps: [1] } },
      ],
    }),
  );
  expect(result).toEqual({
    ok: false,
    problems: [
      'specialists[0].op must be "create", "update", or "remove".',
      "specialists[1] has no revision.",
      "specialists[2].fields has an unknown field model.",
      "specialists[3].fields must be text, with steps a list of text.",
    ],
  });
});

test("one specialist that can't be saved refuses the whole answer, naming each problem", () => {
  const value = settingsWith([
    { op: "create", name: "notes", fields: FIELDS },
    { op: "create", name: "seo-blog", fields: FIELDS },
    { op: "update", name: "seo-blog", revision: "c".repeat(64), fields: FIELDS },
    { op: "remove", name: "too-big", revision: "d".repeat(64) },
    { op: "remove", name: "gone", revision: "d".repeat(64) },
    { op: "create", name: "fix-round", fields: FIELDS },
    { op: "create", name: "fenced", fields: { ...FIELDS, instructions: "```\nopen" } },
  ]);
  expect(checkSetupAnswer(value, facts)).toEqual([
    "Just me already has seo-blog. Pick another name.",
    "seo-blog is changed twice.",
    "seo-blog changed on disk since Settings showed it. Reopen Settings.",
    "too-big changed on disk since Settings showed it. Reopen Settings.",
    "gone is no longer in Just me. Reopen Settings.",
    "fix-round is Tandem's own fix-round checklist; pick another name.",
    "fenced: the instructions would not read back as written; close every code fence and leave out a ## Steps heading.",
  ]);
  expect(
    checkSetupAnswer(settingsWith([{ op: "create", name: "notes", fields: FIELDS }]), facts),
  ).toEqual([]);
});

test("first-time setup never changes specialists", () => {
  const value = parsed({ ...answer, specialists: [{ op: "create", name: "n", fields: FIELDS }] });
  expect(checkSetupAnswer(value, facts)).toEqual(["Specialists are changed in Settings."]);
});

test("selected models authorize only their providers, regardless of the rest of the catalogue", () => {
  const value = parsed({
    ...answer,
    models: { ...answer.models, scout: { model: "openai/gpt", thinking: "high" } },
  });
  const available = [
    ...catalogue,
    { selector: "google/gemini", id: "gemini", provider: "google", thinking: ["high"] },
  ] satisfies readonly ModelRecord[];
  expect(checkSetupAnswer(value, { ...facts, catalogue: available })).toEqual([]);
  expect(setupProviders(value, available)).toEqual(["anthropic", "openai"]);
});

test("Claude Code roles never enable Claude Code for spending", () => {
  const value = parsed({
    ...answer,
    models: { ...answer.models, scout: { model: "claude-code/sonnet", thinking: "medium" } },
  });
  const available = [...catalogue, ...CLAUDE_CODE_MODELS];
  expect(checkSetupAnswer(value, { ...facts, catalogue: available })).toEqual([]);
  expect(setupProviders(value, available)).toEqual(["anthropic"]);
});

test("the shape is strict: unknown fields, missing jobs, and bad modes are named", () => {
  const { models: _models, ...noModels } = answer;
  const result = parseSetupAnswer(
    JSON.stringify({
      ...noModels,
      models: { ...answer.models, presentation: undefined, verifier: {} },
      extra: true,
      selfImprovement: "sometimes",
      workerSkills: ["tdd"],
    }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems).toEqual(
    expect.arrayContaining([
      "The answer has an unknown field extra.",
      "The answer has an unknown field workerSkills.",
      "models has an unknown field verifier.",
      "Mockups has no model.",
      'selfImprovement must be "off", "fix", or "report".',
    ]),
  );
  expect(parseSetupAnswer("not json")).toEqual({
    ok: false,
    problems: ["The answer is not valid JSON."],
  });
  expect(parseSetupAnswer('{"hello":1}').ok).toBe(false);
});

test("each problem on this machine is one sentence the user can act on", () => {
  const value = parsed({
    ...answer,
    models: {
      ...answer.models,
      scout: { model: "openai/gpt", thinking: "high" },
      reviewer: { model: "anthropic/opus", thinking: "low" },
      presentation: { model: "nobody/model", thinking: "high" },
    },
    repositories: [
      { path: "/code/api", validationCommands: ["make check"] },
      { path: "/code/api/src", validationCommands: ["make check"] },
      { path: "/tmp/plain", validationCommands: ["make check"] },
      { path: "/code/done", validationCommands: ["make check"] },
    ],
  });
  const problems = checkSetupAnswer(value, {
    ...facts,
    repositories: new Map([
      ["/code/api", { kind: "root", root: "/code/api", setUp: false }],
      ["/code/api/src", { kind: "inside", root: "/code/api" }],
      ["/code/done", { kind: "root", root: "/code/done", setUp: true }],
    ]),
  });
  expect(problems).toEqual([
    "Review: anthropic/opus doesn't support thinking low.",
    "Mockups: nobody/model isn't available on this computer.",
    "/code/api/src is inside the repository at /code/api; add that folder.",
    "/tmp/plain is not a Git repository.",
  ]);
  expect(parseSetupAnswer(JSON.stringify({ ...answer, enabledProviders: ["google"] })).ok).toBe(
    false,
  );
});

test("every repository needs a non-blank validation command, and the repository is named", () => {
  const blank = (path: string, commands: readonly string[]) => ({
    path,
    validationCommands: commands,
  });
  const value: SetupAnswer = {
    ...parsed(answer),
    repositories: [
      blank("/code/api", []),
      blank("~/pasted", [" ", ""]),
      blank("/code/done", ["x"]),
    ],
  };
  expect(
    checkSetupAnswer(value, {
      ...facts,
      repositories: new Map([
        ["/code/api", { kind: "root", root: "/code/api", setUp: false }],
        ["~/pasted", { kind: "root", root: "/Users/me/pasted", setUp: false }],
        ["/code/done", { kind: "root", root: "/code/done", setUp: true }],
      ]),
    }),
  ).toEqual(["api needs a validation command.", "pasted needs a validation command."]);
  const omitted = parseSetupAnswer(
    JSON.stringify({ ...answer, repositories: [{ path: "/code/api" }] }),
  );
  expect(omitted.ok && omitted.answer.repositories).toEqual([
    { path: "/code/api", validationCommands: [] },
  ]);
});

test("setup needs a repository; settings may have none", () => {
  const none = { ...parsed(answer), repositories: [] };
  expect(checkSetupAnswer(none, facts)).toEqual(["Add at least one repository."]);
  expect(checkSetupAnswer({ ...none, mode: "settings" }, facts)).toEqual([]);
  expect(parseSetupAnswer(JSON.stringify({ ...answer, mode: "later" })).ok).toBe(false);
});
