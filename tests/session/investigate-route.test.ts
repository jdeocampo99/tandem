import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JEV_MODEL,
  type JevChoiceAnswer,
  JevEvaluationError,
  type JevEvaluationInput,
  type JevEvaluationResponse,
} from "../../src/adapters/typesafe.ts";
import type { SelfImprovementMode } from "../../src/config/home-settings.ts";
import { appendDiagnosticEvent } from "../../src/runtime/diagnostics.ts";
import type { InvestigateInput } from "../../src/self-improvement/service.ts";
import type { TandemService } from "../../src/service/controller.ts";
import {
  classifyInvestigatePrompt,
  mentionsInvestigation,
} from "../../src/session/investigate-route.ts";
import {
  type PromptRoutingDependencies,
  routeUserPrompt,
  type UserPrompt,
} from "../../src/session/prompt-routing.ts";
import { recordingSessionHost } from "../evals/scenario.ts";
import { task } from "./fixtures.ts";

const config = { apiKey: "key", timeoutMs: 1_500 };
const LOGIN = task({ id: "task-login", objective: "Fix the login page", stage: "reviewing" });
const EXPORT = task({
  id: "task-export",
  objective: "Add CSV export",
  updatedAt: "2030-01-03T00:00:00.000Z",
});

function choice(value: string, options: readonly string[], confidence = 0.95): JevChoiceAnswer {
  const rest = (1 - confidence) / (options.length - 1);
  return {
    type: "choice",
    choice: value,
    confidence,
    probabilities: Object.fromEntries(
      options.map((option) => [option, option === value ? confidence : rest]),
    ),
  };
}

function criteria(input: JevEvaluationInput, id: string): Readonly<Record<string, string | null>> {
  return input.questions[id]?.criteria ?? {};
}

/** Answers the investigate questions, and sends every other route to the coordinator. */
function jev(request: string, target: string, seen: JevEvaluationInput[] = []) {
  return async (input: JevEvaluationInput): Promise<JevEvaluationResponse> => {
    seen.push(input);
    const targets = Object.keys(criteria(input, "target"));
    if (criteria(input, "request").investigate === undefined) {
      return { model: JEV_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    }
    return {
      model: JEV_MODEL,
      answers: {
        request: choice(request, ["investigate", "other"]),
        target: choice(target, targets),
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    };
  };
}

function typed(text: string): UserPrompt {
  return { type: "userPrompt", text, interactive: true, attachments: 0 };
}

function fakeService(mode: SelfImprovementMode, started: InvestigateInput[]): TandemService {
  return {
    selfImprovementMode: async () => mode,
    list: async () => [LOGIN, EXPORT],
    investigate: async (input: InvestigateInput) => {
      started.push(input);
      return task({ id: "task-investigation", kind: "scout", stage: "queued" });
    },
  } as unknown as TandemService;
}

test("only 'why did that task...' prompts are screened in", () => {
  expect(mentionsInvestigation("why did that task take so long?")).toBe(true);
  expect(mentionsInvestigation("Why does the login fix keep restarting")).toBe(true);
  expect(mentionsInvestigation("how's it going?")).toBe(false);
  expect(mentionsInvestigation("why is the sky blue")).toBe(false);
});

test("a confident investigate request names the listed task Jev chose", async () => {
  const seen: JevEvaluationInput[] = [];
  const result = await classifyInvestigatePrompt(
    "why did the login fix take so long?",
    [EXPORT, LOGIN],
    config,
    jev("investigate", "c2", seen),
  );
  expect(result.taskId).toBe("task-login");
  expect(seen[0] === undefined ? "" : criteria(seen[0], "target").c2).toContain(
    "Fix the login page",
  );

  const other = await classifyInvestigatePrompt(
    "why did the login fix take so long? and redo it",
    [EXPORT, LOGIN],
    config,
    jev("other", "c2"),
  );
  expect(other.taskId).toBeUndefined();
});

test("asking why a task took so long starts an investigation of it with no coordinator turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-investigate-route-"));
  const started: InvestigateInput[] = [];
  const recording = recordingSessionHost();
  try {
    const result = await routeUserPrompt(typed("why did the login fix take so long?"), {
      config,
      service: () => fakeService("report", started),
      host: recording.host,
      confirm: undefined,
      diagnostics: (entry) => appendDiagnosticEvent(home, entry),
      evaluate: jev("investigate", "c2"),
    });
    expect(result).toEqual({ handled: true });
    expect(started).toEqual([
      { taskId: "task-login", question: "why did the login fix take so long?" },
    ]);
    expect(recording.effects.filter((effect) => effect.type === "deliver")).toHaveLength(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("with self-improvement off, or when Jev fails, the prompt goes to the coordinator", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-investigate-route-"));
  const started: InvestigateInput[] = [];
  try {
    const route = (
      mode: SelfImprovementMode,
      evaluate: NonNullable<PromptRoutingDependencies["evaluate"]>,
    ) =>
      routeUserPrompt(typed("why did the login fix take so long?"), {
        config,
        service: () => fakeService(mode, started),
        host: recordingSessionHost().host,
        confirm: undefined,
        diagnostics: (entry) => appendDiagnosticEvent(home, entry),
        evaluate,
      });
    expect(await route("off", jev("investigate", "c2"))).toEqual({ handled: false });
    const failing = async (): Promise<JevEvaluationResponse> => {
      throw new JevEvaluationError("timeout", "slow");
    };
    expect(await route("fix", failing)).toEqual({ handled: false });
    expect(started).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
