import { expect, test } from "bun:test";
import type { JevEvaluationResponse, JevGateway } from "../../src/adapters/typesafe.ts";
import { buildAgentBrief } from "../../src/instructions.ts";
import { PLAYBOOKS } from "../../src/playbooks/catalog.ts";
import { classifyPlaybook } from "../../src/playbooks/classify.ts";
import { openSteps, todoItems } from "../../src/playbooks/progress.ts";
import { playbookForRun, selectPlaybook } from "../../src/playbooks/selection.ts";

test("selection pins each confident job type, and general for other, low confidence, or no pick", () => {
  for (const jobType of ["bug-fix", "feature", "refactor", "perf"] as const) {
    expect(selectPlaybook({ jobType, confidence: 0.9 })).toBe(jobType);
  }
  expect(selectPlaybook({ jobType: "other", confidence: 0.99 })).toBe("general");
  expect(selectPlaybook({ jobType: "bug-fix", confidence: 0.79 })).toBe("general");
  expect(selectPlaybook(undefined)).toBe("general");
});

test("every fix round follows the fix-round playbook; otherwise the pinned one, if any", () => {
  expect(playbookForRun("perf", false)).toBe("perf");
  expect(playbookForRun("perf", true)).toBe("fix-round");
  expect(playbookForRun(undefined, true)).toBe("fix-round");
  expect(playbookForRun(undefined, false)).toBeUndefined();
});

test("general is the feature playbook without naming its data first", () => {
  expect(PLAYBOOKS.general.steps).toEqual(PLAYBOOKS.feature.steps.slice(1));
});

function answer(choice: string, confidence: number): JevEvaluationResponse {
  const probabilities = { "bug-fix": 0, feature: 0, refactor: 0, perf: 0, other: 0, [choice]: 1 };
  return {
    model: "jev-1.13.0",
    answers: { jobType: { type: "choice", choice, probabilities, confidence } },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

test("classification asks Jev once and falls back to general without a key, on failure, or unsure", async () => {
  const config = { apiKey: "key", timeoutMs: 1_000 };
  let calls = 0;
  const reply = (response: JevEvaluationResponse) => async () => {
    calls += 1;
    return response;
  };
  expect(await classifyPlaybook("Fix the crash", config, reply(answer("bug-fix", 0.95)))).toBe(
    "bug-fix",
  );
  expect(calls).toBe(1);
  expect(await classifyPlaybook("Fix it", { timeoutMs: 1_000 }, reply(answer("perf", 1)))).toBe(
    "general",
  );
  expect(calls).toBe(1);
  expect(await classifyPlaybook("Fix it", config, reply(answer("perf", 0.5)))).toBe("general");
  const failing = async () => {
    throw new Error("down");
  };
  expect(await classifyPlaybook("Fix it", config, failing)).toBe("general");
});

test("classification goes through the configured Jev gateway", async () => {
  const gateway: JevGateway = { url: "https://gateway.example/v1", model: "jev", headers: {} };
  let used: JevGateway | undefined;
  await classifyPlaybook(
    "Fix the crash",
    { apiKey: "key", timeoutMs: 1_000, gateway },
    async (_, options) => {
      used = options.gateway;
      return answer("bug-fix", 0.95);
    },
  );
  expect(used).toEqual(gateway);
});

const steps = ["Measure a baseline", "Find the cause", "Measure again"];
const result = (tasks: ReadonlyArray<{ content: string; status: string }>) => ({
  details: { op: "done", phases: [{ name: "Playbook", tasks }] },
});

test("progress: completed and abandoned steps close; open, blocked, and missing ones stay open", () => {
  const all = todoItems(
    result([
      { content: "Measure a baseline", status: "completed" },
      { content: "Find the cause", status: "abandoned" },
      { content: "Measure again", status: "completed" },
    ]),
  );
  expect(openSteps(steps, all)).toEqual([]);

  const partial = todoItems(
    result([
      { content: "Measure a baseline", status: "completed" },
      { content: "Find the cause", status: "blocked" },
    ]),
  );
  expect(openSteps(steps, partial)).toEqual(["Find the cause", "Measure again"]);
  expect(openSteps(steps, undefined)).toEqual(steps);
  expect(todoItems({ details: { phases: [{ tasks: [{ content: 1 }] }] } })).toBeUndefined();
});

test("only a brief given a playbook carries its steps", () => {
  const base = {
    objective: "Make the report faster.",
    acceptanceCriteria: ["It is faster."],
    instructions: [],
    reportPath: "/tmp/report.md",
  };
  const implementer = buildAgentBrief({ ...base, role: "implementer", playbook: "perf" });
  expect(implementer).toContain("## Playbook: perf");
  expect(implementer).toContain("1. Measure a baseline");
  expect(buildAgentBrief({ ...base, role: "implementer" })).not.toContain("## Playbook");
  expect(buildAgentBrief({ ...base, role: "scout" })).not.toContain("## Playbook");
});
