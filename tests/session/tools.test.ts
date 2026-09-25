import { describe, expect, test } from "bun:test";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { z } from "zod/v4";
import { ompToolParameters } from "../../src/adapters/omp-tool-schema.ts";
import { tandemRequestSchema as ompTandemRequestSchema } from "../../src/extension/registration.ts";
import type { TandemAction } from "../../src/session/actions.ts";
import {
  copyAssetSchema,
  submitReportSchema,
  tandemRequestSchema,
} from "../../src/session/tools.ts";
import type { WorkerRole } from "../../src/workers/jobs.ts";
import {
  copyAssetParameters,
  submitReportParameters,
} from "../../src/workers/terminal-extension.ts";

type Case = Readonly<{ name: string; input: unknown; valid: boolean }>;

type SafeParser = Readonly<{ safeParse(value: unknown): { success: boolean } }>;

/** Agreement between the pi.zod schema OMP uses today and its plain zod replacement. */
function expectParity(cases: readonly Case[], old: SafeParser, next: z.ZodType): void {
  const parameters = ompToolParameters(next);
  for (const { name, input, valid } of cases) {
    expect({ name, old: old.safeParse(input).success }).toEqual({ name, old: valid });
    expect({ name, next: next.safeParse(input).success }).toEqual({ name, next: valid });
    expect({ name, omp: ompAccepts(parameters, input) }).toEqual({
      name,
      omp: ompAccepts(old, input),
    });
  }
}

/** What OMP's own argument validation (with its LLM-quirk repairs) makes of `input`. */
function ompAccepts(parameters: object, input: unknown): unknown {
  try {
    return validateToolArguments(
      { name: "tool", description: "", parameters: parameters as Record<string, unknown> },
      { type: "toolCall", id: "call-1", name: "tool", arguments: input as Record<string, unknown> },
    );
  } catch {
    return "rejected";
  }
}

const modelSpec = { model: "openai-codex/gpt-5.6-luna", thinking: "high" };
const models = {
  coordinator: modelSpec,
  scout: modelSpec,
  implementer: modelSpec,
  reviewer: modelSpec,
  presentation: modelSpec,
};
const summary = { tldr: ["Short."], what: ["Change."], why: ["Reason."] };
const brief = {
  goal: "Ship it",
  scope: ["src"],
  constraints: [],
  nonGoals: [],
  acceptanceCriteria: ["Works"],
  manualVerification: [],
  recommendedApproach: "Small steps",
  keyDecisions: [],
  openQuestions: [],
  researchLinks: [],
};

const validRequests: readonly Record<string, unknown>[] = [
  { action: "restart", taskId: "t" },
  { action: "onboard", repoPath: "/r" },
  { action: "setup", repoPath: "/r" },
  { action: "models", repoPath: "." },
  { action: "configure-models", repoPath: "/r", models },
  { action: "configure-models", repoPath: "/r", models, enabledProviders: ["openai-codex"] },
  {
    action: "create",
    repoPath: "/r",
    kind: "scout",
    objective: "Look",
    acceptanceCriteria: [],
    surfaces: [],
  },
  {
    action: "create",
    repoPath: "/r",
    requestId: "req-1",
    kind: "implementation",
    objective: "Build",
    acceptanceCriteria: ["Done"],
    manualVerification: ["Click"],
    surfaces: ["src"],
    researchTaskIds: ["t0"],
    skill: { name: "tdd", context: "red first" },
    targetRepo: "owner/repo",
    targetCheckout: "/elsewhere",
    targetClone: true,
    validationCommands: ["bun test"],
  },
  { action: "list" },
  { action: "presentations" },
  { action: "presentation-open", presentationId: "p" },
  { action: "show", taskId: "t" },
  { action: "show", taskId: "t", detail: "full" },
  { action: "steer", taskId: "t", text: "go", supersedes: ["m1"] },
  { action: "answer", taskId: "t", questionId: "q", text: "yes" },
  { action: "messages", taskId: "t" },
  { action: "inspect", taskId: "t" },
  { action: "delivery-preflight", taskId: "t", base: "main" },
  { action: "approve", taskId: "t" },
  { action: "brief-draft", repoPath: "/r", content: brief, reviewPane: false },
  {
    action: "brief-draft",
    repoPath: "/r",
    requestId: "req-1",
    content: { ...brief, skipReview: true },
    reviewPane: true,
  },
  { action: "brief-review", requestId: "req-1" },
  { action: "brief-show", requestId: "req-1" },
  { action: "request-receipt" },
  { action: "request-receipt", requestId: "req-1" },
  { action: "brief-approve", briefRevision: 1, contentDigest: "d" },
  { action: "brief-approve", requestId: "req-1", briefRevision: 3, contentDigest: "d" },
  { action: "tick" },
  { action: "pause", taskId: "t" },
  { action: "pause", taskId: "t", reason: "wait" },
  { action: "resume", taskId: "t" },
  { action: "cancel", taskId: "t", reason: "stop", discard: true },
  { action: "present", taskId: "t", objective: "show", artifacts: ["/a.html"] },
  { action: "describe", taskId: "t", summary },
  { action: "publish", taskId: "t", title: "T", base: "main", summary },
  { action: "publish-now", taskId: "t", repository: "o/r", title: "T", base: "main", summary },
  { action: "draft", taskId: "t", title: "T", base: "main" },
  { action: "merge", taskId: "t", method: "squash" },
  { action: "cleanup", taskIds: ["t"] },
  { action: "cleanup", taskIds: ["t", "u"], discard: false },
  { action: "review-pr", pullRequest: "o/r#1", repoPath: "/r" },
  {
    action: "review-pr",
    pullRequest: "https://github.com/o/r/pull/1",
    repoPath: "/r",
    lens: "focus",
    focus: "the migration",
    checkout: "/c",
    clone: false,
  },
  { action: "review-show", taskId: "t", page: true },
  { action: "review-notes", taskId: "t" },
  { action: "review-edit", taskId: "t" },
  {
    action: "review-edit",
    taskId: "t",
    comments: [{ id: "c1", body: "b", severity: "nit", drop: false }, { id: "c2" }],
    summaryComment: "s",
  },
  { action: "review-post", taskId: "t", verdict: "request-changes" },
  { action: "review-again", taskId: "t" },
  { action: "review-close", taskId: "t" },
];

const invalidRequests: readonly [string, unknown][] = [
  ["unknown action", { request: { action: "feedback", presentationId: "p" } }],
  ["no request", {}],
  ["extra root field", { request: { action: "list" }, note: "x" }],
  ["extra request field", { request: { action: "list", taskId: "t" } }],
  ["missing required field", { request: { action: "restart" } }],
  ["wrong field type", { request: { action: "restart", taskId: 1 } }],
  ["null optional", { request: { action: "show", taskId: "t", detail: null } }],
  ["bad enum", { request: { action: "show", taskId: "t", detail: "brief" } }],
  [
    "model assignments missing a role",
    { request: { action: "configure-models", repoPath: "/r", models: { scout: modelSpec } } },
  ],
  [
    "model spec with an extra field",
    {
      request: {
        action: "configure-models",
        repoPath: "/r",
        models: { ...models, scout: { ...modelSpec, temperature: 1 } },
      },
    },
  ],
  [
    "bad thinking level",
    {
      request: {
        action: "configure-models",
        repoPath: "/r",
        models: { ...models, scout: { model: "m", thinking: "extreme" } },
      },
    },
  ],
  [
    "skill with an extra field",
    {
      request: {
        action: "create",
        repoPath: "/r",
        kind: "scout",
        objective: "o",
        acceptanceCriteria: [],
        surfaces: [],
        skill: { name: "n", context: "c", args: "x" },
      },
    },
  ],
  [
    "summary with an extra field",
    { request: { action: "describe", taskId: "t", summary: { ...summary, extra: [] } } },
  ],
  [
    "brief missing a field",
    {
      request: {
        action: "brief-draft",
        repoPath: "/r",
        content: { goal: "g" },
        reviewPane: false,
      },
    },
  ],
  [
    "zero brief revision",
    { request: { action: "brief-approve", briefRevision: 0, contentDigest: "d" } },
  ],
  [
    "negative brief revision",
    { request: { action: "brief-approve", briefRevision: -2, contentDigest: "d" } },
  ],
  [
    "fractional brief revision",
    { request: { action: "brief-approve", briefRevision: 1.5, contentDigest: "d" } },
  ],
  ["empty cleanup", { request: { action: "cleanup", taskIds: [] } }],
  ["bad merge method", { request: { action: "merge", taskId: "t", method: "ff" } }],
  [
    "review comment with an extra field",
    { request: { action: "review-edit", taskId: "t", comments: [{ id: "c", line: 3 }] } },
  ],
  ["request as a string", { request: "list" }],
];

const tandemCases: readonly Case[] = [
  ...validRequests.map((request) => ({
    name: String(request.action),
    input: { request },
    valid: true,
  })),
  ...invalidRequests.map(([name, input]) => ({ name, input, valid: false })),
];

const review = {
  findings: [
    {
      id: "f1",
      severity: "P1",
      verdict: "confirmed",
      file: "src/a.ts",
      line: 3,
      description: "Broken.",
    },
    { id: "f2", severity: "P3", verdict: "plausible", description: "Maybe." },
  ],
  summary: "One issue.",
};

function submitReportCases(role: WorkerRole): readonly Case[] {
  const done = role === "implementer" ? "implemented" : "completed";
  return [
    { name: "outcome only", input: { outcome: done }, valid: true },
    {
      name: "needs-decision",
      input: { outcome: "needs-decision", report: "r", question: "q?", recommendation: "yes" },
      valid: true,
    },
    { name: "failed", input: { outcome: "failed", report: "r" }, valid: true },
    {
      name: "another role's outcome",
      input: { outcome: role === "implementer" ? "completed" : "implemented" },
      valid: false,
    },
    { name: "no outcome", input: { report: "r" }, valid: false },
    { name: "extra field", input: { outcome: done, notes: "n" }, valid: false },
    { name: "numeric report", input: { outcome: done, report: 1 }, valid: false },
    {
      name: "artifact path",
      input: { outcome: done, artifactPath: "/a.html" },
      valid: role === "presentation",
    },
    { name: "review", input: { outcome: done, review }, valid: role === "reviewer" },
    {
      name: "review with a bad severity",
      input: {
        outcome: done,
        review: { ...review, findings: [{ ...review.findings[1], severity: "P9" }] },
      },
      valid: false,
    },
    {
      name: "review finding with a zero line",
      input: {
        outcome: done,
        review: { ...review, findings: [{ ...review.findings[0], line: 0 }] },
      },
      valid: false,
    },
    {
      name: "review with an extra field",
      input: { outcome: done, review: { ...review, passed: true } },
      valid: false,
    },
    {
      name: "review without a summary",
      input: { outcome: done, review: { findings: [] } },
      valid: false,
    },
  ];
}

const workerRoles: readonly WorkerRole[] = ["scout", "implementer", "reviewer", "presentation"];

describe("tool schemas match the pi.zod schemas OMP uses today", () => {
  test("tandem request", () => {
    expectParity(tandemCases, ompTandemRequestSchema(zod), tandemRequestSchema);
  });

  for (const role of workerRoles) {
    test(`submit_report for ${role}`, () => {
      expectParity(
        submitReportCases(role),
        submitReportParameters(zod, role),
        submitReportSchema(role),
      );
    });
  }

  test("copy_asset", () => {
    expectParity(
      [
        { name: "both paths", input: { from: "img/a.png", name: "a.png" }, valid: true },
        { name: "missing name", input: { from: "img/a.png" }, valid: false },
        { name: "extra field", input: { from: "a", name: "b", mode: "link" }, valid: false },
        { name: "numeric name", input: { from: "a", name: 1 }, valid: false },
      ],
      copyAssetParameters(zod),
      copyAssetSchema,
    );
  });
});

test("every tandem request the schema accepts is a TandemAction", () => {
  const accepted: z.infer<typeof tandemRequestSchema>["request"][] = validRequests.map(
    (request) => tandemRequestSchema.parse({ request }).request,
  );
  const actions: readonly TandemAction[] = accepted;
  expect(actions).toHaveLength(validRequests.length);
});

test("OMP tool parameters are plain JSON Schema without a dialect marker", () => {
  const parameters = ompToolParameters(copyAssetSchema);
  expect(parameters).toEqual({
    type: "object",
    properties: {
      from: { type: "string", description: "Path of the file in the repository checkout." },
      name: { type: "string", description: "Plain file name to save it as in the mockup folder." },
    },
    required: ["from", "name"],
    additionalProperties: false,
  });
});
