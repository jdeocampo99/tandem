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
};

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
    repositories: [blank("/code/api", []), blank("~/pasted", [" ", ""]), blank("/code/done", ["x"])],
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
