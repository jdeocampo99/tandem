import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchContinuationDisposition, TaskStage } from "../../src/contracts.ts";
import type { PresentationAgent } from "../../src/presentations/records.ts";
import {
  askResearchAgent,
  type ResearchFollowUpDeps,
} from "../../src/service/research-follow-up.ts";
import type { WorkerMockupRequest, WorkerTerminalState } from "../../src/workers/terminal.ts";

const NOW = Date.parse("2030-01-02T03:04:05.000Z");

function scout(disposition: ResearchContinuationDisposition, stage: TaskStage = "completed") {
  return {
    id: "task-1",
    kind: "scout" as const,
    stage,
    researchContinuation: {
      schemaVersion: 1 as const,
      disposition,
      selectedBy: "explicit" as const,
    },
  };
}

async function agent(): Promise<PresentationAgent> {
  const dir = await mkdtemp(join(tmpdir(), "tandem-follow-up-"));
  return { jobId: "job-1", jobPath: join(dir, "job.json"), generation: 0, cwd: dir };
}

function idle(overrides: Partial<WorkerTerminalState> = {}): WorkerTerminalState {
  return {
    schemaVersion: 1,
    jobId: "job-1",
    taskId: "task-1",
    generation: 0,
    role: "scout",
    cwd: "/repo",
    pid: 1,
    phase: "idle",
    completed: true,
    heartbeatAt: "2030-01-02T03:04:04.000Z",
    ...overrides,
  };
}

function deps(
  terminals: ReadonlyArray<WorkerTerminalState | undefined>,
  send: ResearchFollowUpDeps["send"] = async () => {},
): ResearchFollowUpDeps {
  let reads = 0;
  return {
    readTerminal: async () => terminals[Math.min(reads++, terminals.length - 1)],
    send,
    now: () => NOW,
    sleep: async () => {},
    waitMs: 0,
  };
}

const input = { id: "q-1", question: "Which file owns the retry limit?" };

test("a follow-up is refused unless a kept research agent is idle", async () => {
  const kept = await agent();
  const cases: ReadonlyArray<
    [
      ReturnType<typeof scout>,
      PresentationAgent | undefined,
      WorkerTerminalState | undefined,
      string,
    ]
  > = [
    [scout("ask-intent", "scouting"), kept, idle(), "not completed research"],
    [scout("report-only"), kept, idle(), "was report-only"],
    [scout("ask-intent"), undefined, undefined, "has closed"],
    [scout("ask-intent"), kept, idle({ phase: "closed" }), "has closed"],
    [scout("implementation-interview"), kept, idle({ phase: "busy" }), "is busy"],
  ];
  for (const [task, maybeAgent, terminal, reason] of cases) {
    await expect(askResearchAgent(task, maybeAgent, input, deps([terminal]))).rejects.toThrow(
      reason,
    );
  }
});

test("the kept research agent answers the question in its own follow-up folder", async () => {
  const kept = await agent();
  const sent: WorkerMockupRequest[] = [];
  const answer = await askResearchAgent(scout("ask-intent"), kept, input, {
    ...deps(
      [idle(), idle({ phase: "busy", commandId: "q-1" }), idle({ settledCommandId: "q-1" })],
      async (_job, id, request) => {
        expect(id).toBe("q-1");
        sent.push(request);
        await writeFile(join(request.artifactDir, "answer.md"), "src/retry.ts\n");
      },
    ),
    waitMs: 60_000,
  });
  expect(answer).toBe("src/retry.ts");
  const [request] = sent;
  expect(request?.artifactDir).toBe(join(kept.cwd, "follow-up-q-1"));
  expect(await readFile(request?.briefPath ?? "", "utf8")).toContain(input.question);
});

test("a slow answer returns where it will appear, and a refused send asks to retry", async () => {
  const kept = await agent();
  const slow = await askResearchAgent(
    scout("ask-intent"),
    kept,
    input,
    deps([idle(), idle({ phase: "busy", commandId: "q-1" })]),
  );
  expect(slow).toContain(join(kept.cwd, "follow-up-q-1", "answer.md"));
  const refused = await askResearchAgent(
    scout("ask-intent"),
    kept,
    input,
    deps([idle()], async () => {
      throw new Error("not acknowledged");
    }),
  );
  expect(refused).toContain("did not take the question");
});
