import { expect, test } from "bun:test";
import type { OmpModelRecord } from "../../src/adapters/omp.ts";
import {
  checkSetupAnswer,
  parseSetupAnswer,
  readSetupAnswerText,
  type SetupAnswer,
  type SetupAnswerFacts,
  setupRecap,
} from "../../src/onboarding/setup-answer.ts";

const catalogue: readonly OmpModelRecord[] = [
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
  enabledProviders: ["anthropic"],
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
      coordinatorMcpServers: ["linear"],
    },
    { path: "~/pasted" },
  ],
  workerSkills: ["tdd"],
  selfImprovement: "fix",
};

const facts: SetupAnswerFacts = {
  catalogue,
  skills: ["tdd", "buildkite"],
  repositories: new Map([
    ["/code/api", { kind: "root", root: "/code/api", setUp: false, mcpServers: ["linear"] }],
    ["~/pasted", { kind: "root", root: "/Users/me/pasted", setUp: false }],
  ]),
};

function parsed(value: unknown): SetupAnswer {
  const result = parseSetupAnswer(JSON.stringify(value));
  if (!result.ok) throw new Error(result.problems.join(" "));
  return result.answer;
}

test("reads the answer out of a real lavish-axi poll response", () => {
  const prompt = JSON.stringify(JSON.stringify(answer));
  const raw = [
    "prompts[2]{uid,prompt,selector,tag,text}:",
    '  "1",Looks good,body,,',
    `  "2",${prompt},button#next,tandem-setup,Tandem setup answer`,
  ].join("\n");
  const text = readSetupAnswerText(raw);
  expect(text === undefined ? undefined : JSON.parse(text)).toEqual(answer);
  expect(readSetupAnswerText('prompts[1]{uid,prompt}:\n  "1","please make it blue"')).toBe(
    undefined,
  );
});

test("a well-formed answer passes every check on this machine", () => {
  const value = parsed(answer);
  expect(value.repositories[1]).toEqual({ path: "~/pasted" });
  expect(checkSetupAnswer(value, facts)).toEqual([]);
});

test("the shape is strict: unknown fields, missing jobs, and bad modes are named", () => {
  const { models: _models, ...noModels } = answer;
  const result = parseSetupAnswer(
    JSON.stringify({
      ...noModels,
      models: { ...answer.models, presentation: undefined, verifier: {} },
      extra: true,
      selfImprovement: "sometimes",
      workerSkills: ["tdd", "tdd"],
    }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems).toEqual(
    expect.arrayContaining([
      "The answer has an unknown field extra.",
      "models has an unknown field verifier.",
      "Visual mockups has no model.",
      'selfImprovement must be "off", "fix", or "report".',
      "workerSkills lists something twice.",
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
    enabledProviders: ["anthropic", "mystery"],
    models: {
      ...answer.models,
      scout: { model: "openai/gpt", thinking: "high" },
      reviewer: { model: "anthropic/opus", thinking: "low" },
      presentation: { model: "nobody/model", thinking: "high" },
    },
    workerSkills: ["gone"],
    repositories: [
      { path: "/code/api", coordinatorMcpServers: ["sentry"] },
      { path: "/code/api/src" },
      { path: "/tmp/plain" },
      { path: "/code/done" },
    ],
  });
  const problems = checkSetupAnswer(value, {
    ...facts,
    repositories: new Map([
      ["/code/api", { kind: "root", root: "/code/api", setUp: false, mcpServers: ["linear"] }],
      ["/code/api/src", { kind: "inside", root: "/code/api" }],
      ["/code/done", { kind: "root", root: "/code/done", setUp: true }],
    ]),
  });
  expect(problems).toEqual([
    "mystery is not a provider in your OMP models.",
    "Research: openai/gpt is from openai, which isn't ticked.",
    "Review: anthropic/opus doesn't support thinking low.",
    "Visual mockups: nobody/model is not one of your OMP models.",
    "No skill named gone in your skills or plugins.",
    "/code/api has no MCP server named sentry.",
    "/code/api/src is inside the repository at /code/api; add that folder.",
    "/tmp/plain is not a Git repository.",
    "/code/done is already set up.",
  ]);
  expect(checkSetupAnswer(parsed({ ...answer, enabledProviders: [] }), facts)).toContain(
    "Tick at least one provider.",
  );
});

test("the recap names every choice, with discovered commands left to the save", () => {
  expect(setupRecap(parsed(answer), catalogue, ["/code"])).toEqual([
    "Providers: anthropic",
    "Planning: Opus (anthropic/opus), high",
    "Research: Opus (anthropic/opus), high",
    "Coding: Opus (anthropic/opus), high",
    "Review: Opus (anthropic/opus), high",
    "Visual mockups: Opus (anthropic/opus), high",
    "Skills every task gets: tdd",
    "When Tandem runs into an issue: Fix: look into it and offer a fix",
    "Look for repos in: /code",
    "Repos, each opened in its own chat:",
    "- /code/api: checks bun run check · install none · MCPs linear",
    "- ~/pasted: checks found when saving · install found when saving · MCPs all",
  ]);
});
