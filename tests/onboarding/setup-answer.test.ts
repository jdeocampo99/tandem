import { expect, test } from "bun:test";
import type { ModelRecord } from "../../src/harness/contract.ts";
import {
  checkSetupAnswer,
  parseSetupAnswer,
  parseSetupChooseFolderRequest,
  parseSetupSearchRequest,
  readSetupAnswerText,
  readSetupChooseFolderText,
  readSetupCommentText,
  readSetupSearchText,
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

test("reads only the tagged Save prompt, never answer-shaped comments or other actions", () => {
  const prompt = JSON.stringify(JSON.stringify(answer));
  const raw = [
    "feedback[0]{message,kind}:",
    `  message: ${prompt}`,
    "  kind: comment",
    "prompts[2]{uid,prompt,selector,tag,text}:",
    `  "1",${prompt},form#folder-search,tandem-search,Search another folder`,
    `  "2",${prompt},button#next,tandem-setup,Tandem setup answer`,
  ].join("\n");
  const text = readSetupAnswerText(raw);
  expect(text === undefined ? undefined : JSON.parse(text)).toEqual(answer);
  expect(
    readSetupAnswerText(
      `prompts[1]{uid,prompt,selector,tag,text}:
  "1",${prompt},button#next,wrong-tag,Tandem setup answer`,
    ),
  ).toBeUndefined();
  expect(
    readSetupAnswerText(`prompts[1]{uid,prompt,selector,tag,text}:
  "1",${prompt},form#folder-search,tandem-setup,Tandem setup answer`),
  ).toBeUndefined();
});

test("reads the answer out of a real lavish-axi poll response", () => {
  const prompt = JSON.stringify(JSON.stringify(answer));
  const raw = [
    "prompts[2]{uid,prompt,selector,tag,text}:",
    '  "1",Looks good,body,,',
    `  "2",${prompt},button#next,tandem-setup,Tandem setup answer`,
  ].join("\n");
  const text = readSetupAnswerText(raw);
  expect(text === undefined ? undefined : JSON.parse(text)).toEqual(answer);
  expect(
    readSetupAnswerText(`prompts[1]{uid,prompt}:
  "1","please make it blue"`),
  ).toBeUndefined();
});

test("does not accept answer-shaped text in a plain Lavish comment", () => {
  const prompt = JSON.stringify(JSON.stringify(answer));
  expect(
    readSetupAnswerText(`prompts[1]{uid,prompt,selector,tag,text}:
  "1",${JSON.stringify(`I accept this setup: ${prompt}`)},body,,`),
  ).toBeUndefined();
});

test("reads a question from Lavish without mistaking commas or feedback metadata for the message", () => {
  const row = [
    "prompts[1]{uid,prompt,selector,tag,text}:",
    `  "1",${JSON.stringify("I'm on step 3, where are my repos?")},body,,`,
  ].join("\n");
  expect(readSetupCommentText(row)).toBe("I'm on step 3, where are my repos?");
  expect(
    readSetupCommentText(
      'prompts[1]{uid,prompt,selector,tag,text}:\n  "1",I am on step 3, and cannot find repos,body,,',
    ),
  ).toBe("I am on step 3, and cannot find repos");
  expect(
    readSetupCommentText(
      "feedback[0]{message,kind}:\n  message: I cannot find my repos\n  kind: comment",
    ),
  ).toBe("I cannot find my repos");
});
test("two queued Lavish questions survive one poll even beside a structured folder request", () => {
  const raw = [
    "prompts[3]{uid,prompt,selector,tag,text}:",
    '  "",First question?,"",message,Freeform message',
    `  "1",${JSON.stringify(JSON.stringify({ tandemChooseFolder: 1, draft: {} }))},button#choose-folder,tandem-choose-folder,Choose folder`,
    '  "",Second question?,"",message,Freeform message',
  ].join("\n");
  expect(readSetupCommentText(raw)).toBe("First question?\n\nSecond question?");
});

test("a folder search is separate from the final answer and retains in-progress command fields", () => {
  const request = {
    tandemSearch: 1,
    folder: "~/Coding_Projects",
    draft: {
      picks: { coordinator: { model: "anthropic/opus", thinking: "high" } },
      repositories: [
        {
          path: "/code/api",
          checks: [" make check ", ""],
          install: " npm ci ",
          pasted: false,
        },
      ],
      selfImprovement: "fix",
    },
  };
  const raw = [
    "prompts[1]{uid,prompt,selector,tag,text}:",
    `  "1",${JSON.stringify(JSON.stringify(request))},form#folder-search,tandem-search,Search another folder`,
  ].join("\n");
  expect(readSetupAnswerText(raw)).toBeUndefined();
  const text = readSetupSearchText(raw);
  expect(text).toBeDefined();
  if (text === undefined) return;
  const parsed = parseSetupSearchRequest(text);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.request.folder).toBe("~/Coding_Projects");
  expect(parsed.request.draft.repositories[0]).toEqual(request.draft.repositories[0]);
  expect(parsed.request.draft.picks.coordinator).toEqual({
    model: "anthropic/opus",
    thinking: "high",
  });
  expect(parseSetupSearchRequest(JSON.stringify({ ...request, extra: 1 })).ok).toBe(false);
  expect(
    parseSetupSearchRequest(
      JSON.stringify({
        ...request,
        draft: {
          ...request.draft,
          repositories: [{ ...request.draft.repositories[0], pasted: "yes" }],
        },
      }),
    ).ok,
  ).toBe(false);
});

test("native folder requests preserve draft and never become a setup answer or question", () => {
  const request = {
    tandemChooseFolder: 1,
    draft: {
      picks: { coordinator: { model: "anthropic/opus", thinking: "high" } },
      repositories: [
        {
          path: "/code/api",
          checks: ["make check"],
          install: "npm ci",
          pasted: false,
        },
      ],
      selfImprovement: "fix",
    },
  };
  const raw = [
    "prompts[1]{uid,prompt,selector,tag,text}:",
    `  "1",${JSON.stringify(JSON.stringify(request))},button#choose-folder,tandem-choose-folder,Choose folder`,
  ].join("\n");
  expect(readSetupAnswerText(raw)).toBeUndefined();
  expect(readSetupSearchText(raw)).toBeUndefined();
  const text = readSetupChooseFolderText(raw);
  expect(text).toBeDefined();
  if (text === undefined) return;
  const parsed = parseSetupChooseFolderRequest(text);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.draft.repositories[0]).toEqual(request.draft.repositories[0]);
  expect(parseSetupChooseFolderRequest(JSON.stringify({ ...request, folder: "/" })).ok).toBe(false);
  expect(parseSetupChooseFolderRequest(JSON.stringify({ ...request, draft: {} })).ok).toBe(false);
});

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
      "Visual mockups has no model.",
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
    "Visual mockups: nobody/model is not one of your OMP models.",
    "/code/api/src is inside the repository at /code/api; add that folder.",
    "/tmp/plain is not a Git repository.",
    "/code/done is already set up.",
  ]);
  expect(parseSetupAnswer(JSON.stringify({ ...answer, enabledProviders: ["google"] })).ok).toBe(
    false,
  );
});
