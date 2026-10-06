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
    { path: "~/pasted" },
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
  expect(value.repositories[1]).toEqual({ path: "~/pasted" });
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
      { path: "/code/api" },
      { path: "/code/api/src" },
      { path: "/tmp/plain" },
      { path: "/code/done" },
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
    "/code/done is already set up.",
  ]);
  expect(parseSetupAnswer(JSON.stringify({ ...answer, enabledProviders: ["google"] })).ok).toBe(
    false,
  );
});
