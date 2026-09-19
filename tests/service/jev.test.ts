import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, ModelSpec, ResolvedPolicy, TaskRecord } from "../../src/contracts.ts";
import { createJevShadowEvaluator } from "../../src/service/jev.ts";

const BASE: ModelSpec = { model: "provider/base", thinking: "medium" };
const ALT: ModelSpec = { model: "provider/alt", thinking: "high" };
const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: BASE,
      scout: BASE,
      implementer: BASE,
      reviewer: BASE,
      verifier: BASE,
      presentation: BASE,
    },
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [],
    maxWorkers: 3,
    maxFixRounds: 3,
  },
  guidance: { implementation: [], validation: [], review: [] },
};

function task(id: string, repoPath: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    repoPath,
    kind: "implementation",
    objective: "implement the requested behavior",
    acceptanceCriteria: ["preserve dispatch behavior"],
    surfaces: [],
    stage: "queued",
    scopeApproved: true,
    policy,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    generation: 1,
    reviewRound: 0,
    validationEvidence: [],
    reviews: [],
    notifications: [],
    ...overrides,
  };
}

function ompResult(): CommandResult {
  return {
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      models: [
        { selector: ALT.model, id: "alt", provider: "provider", thinking: ["high"] },
        { selector: BASE.model, id: "base", provider: "provider", thinking: ["medium"] },
      ],
    }),
  };
}

test("batches distinguishable context questions with routing and deduplicates the durable artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-jev-evaluator-"));
  const home = join(root, "home");
  const worktree = join(root, "worktree");
  const reportPath = join(home, "jobs", "scout", "report.txt");
  const jobPath = join(home, "jobs", "task", "job.json");
  await mkdir(join(home, "jobs", "scout"), { recursive: true });
  await mkdir(join(home, "jobs", "task"), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(reportPath, "Scout evidence: use the bounded migration guide.");
  await writeFile(
    join(home, "jev.json"),
    JSON.stringify({
      schemaVersion: 1,
      routingCandidates: {
        implementer: [
          { id: "alt-model", model: ALT.model, thinking: ALT.thinking, description: "Alternative" },
        ],
      },
    }),
  );
  const target = task("task", worktree);
  const scout = task("scout", worktree, {
    kind: "scout",
    stage: "completed",
    reportPath,
  });
  let requests = 0;
  let requestBody: Record<string, unknown> | undefined;
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests += 1;
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const questions = requestBody.questions as Record<string, { type: string }>;
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(questions)) {
      answers[id] =
        question.type === "choice"
          ? {
              type: "choice",
              choice: "alt-model",
              probabilities: { "current-baseline": 0.1, "alt-model": 0.9 },
              confidence: 0.9,
            }
          : { type: "noul", noul: id.endsWith("0") ? 0.9 : 0.2 };
    }
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers,
        usage: { input_tokens: 12, output_tokens: 8 },
      }),
      { status: 200 },
    );
  };
  try {
    const evaluator = createJevShadowEvaluator({
      home,
      run: async () => ompResult(),
      listTasks: async () => [target, scout],
      env: { TANDEM_JEV_MODE: "shadow", TYPESAFE_API_KEY: "fake" },
      fetch,
      clock: () => "2030-01-01T00:00:00.000Z",
    });
    const job = { id: "job", role: "implementer" as const, jobPath, cwd: worktree };
    const first = await evaluator({ task: target, job });
    const second = await evaluator({ task: target, job });
    expect(first.status).toBe("recorded");
    expect(second.status).toBe("recorded");
    expect(requests).toBe(1);
    const state = requestBody?.state as {
      supplementalContext: readonly { id: string; excerpt: string }[];
    };
    expect(state.supplementalContext[0]?.excerpt).toContain("bounded migration guide");
    const questions = requestBody?.questions as Record<string, { instructions: string }>;
    const contextQuestion = Object.entries(questions).find(([id]) => id.startsWith("context:"));
    expect(contextQuestion?.[1].instructions).toContain(
      contextQuestion?.[0].slice("context:".length) ?? "",
    );
    const artifact = JSON.parse(await readFile(first.artifactPath ?? "", "utf8")) as {
      routing: { choice: { id: string } };
    };
    expect(artifact.routing.choice.id).toBe("alt-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
