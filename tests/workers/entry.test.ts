import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkerJob } from "../../src/worker.ts";
import type { ExecutionGateInput } from "../../src/workers/execution-gate.ts";
import { parseWorkerJob, persistWorkerResult, type WorkerResult } from "../../src/workers/jobs.ts";

const FINISHED_AT = "2030-01-02T03:04:05.000Z";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tandem-worker-entry-"));
  const job = parseWorkerJob({
    schemaVersion: 1,
    id: "job-1",
    taskId: "task-1",
    generation: 3,
    role: "reviewer",
    cwd: root,
    model: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
    prompt: "Review the approved change.",
    resultPath: join(root, "result.json"),
    review: { head: "head-1", lens: "review" },
    execution: {
      schemaVersion: 1,
      home: root,
      operationId: "operation-1",
      fencingRevision: 2,
      claimOwner: "test-owner",
    },
  });
  const jobPath = join(root, "job.json");
  await writeFile(jobPath, JSON.stringify(job));
  const completed: WorkerResult = {
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: job.role,
    status: "needs-decision",
    text: "Need a decision.",
    question: { text: "Which approach?" },
    finishedAt: FINISHED_AT,
  };
  return { root, job, jobPath, completed };
}

test("worker entry returns an existing result before admission or process effects", async () => {
  const f = await fixture();
  try {
    await persistWorkerResult(f.job.resultPath, f.completed);
    const effects: string[] = [];
    const result = await runWorkerJob(f.jobPath, {
      executionGate: () => {
        effects.push("gate");
        return { admitted: false };
      },
      run: async () => {
        effects.push("run");
        return 0;
      },
      now: () => {
        effects.push("clock");
        return FINISHED_AT;
      },
      writeResult: () => {
        effects.push("write");
      },
    });
    expect(result).toEqual(f.completed);
    expect(effects).toEqual([]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("worker entry forwards the review fence and returns admission failures without persisting them", async () => {
  const f = await fixture();
  try {
    const inputs: ExecutionGateInput[] = [];
    const effects: string[] = [];
    const result = await runWorkerJob(f.jobPath, {
      executionGate: (input) => {
        inputs.push(input);
        throw new Error("stale fence");
      },
      run: async () => {
        effects.push("run");
        return 0;
      },
      writeResult: () => {
        effects.push("write");
      },
      now: () => FINISHED_AT,
    });
    expect(inputs).toEqual([
      {
        execution: {
          schemaVersion: 1,
          home: f.root,
          operationId: "operation-1",
          fencingRevision: 2,
          claimOwner: "test-owner",
        },
        jobId: f.job.id,
        taskId: f.job.taskId,
        generation: f.job.generation,
        command: "worker",
        cwd: f.job.cwd,
        resultPath: f.job.resultPath,
        resolvedModel: f.job.model,
        inputHead: "head-1",
      },
    ]);
    expect(result.error).toBe("execution refused: stale fence");
    expect(result.finishedAt).toBe(FINISHED_AT);
    expect(effects).toEqual([]);
    expect(await Bun.file(f.job.resultPath).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("worker entry preserves a persisted result when the agent exits or throws afterwards", async () => {
  const f = await fixture();
  try {
    for (const throws of [false, true]) {
      await rm(f.job.resultPath, { force: true });
      const writes: WorkerResult[] = [];
      const result = await runWorkerJob(f.jobPath, {
        executionGate: () => ({ admitted: true }),
        run: async () => {
          await persistWorkerResult(f.job.resultPath, f.completed);
          if (throws) throw new Error("failure after submit");
          return 9;
        },
        writeResult: (_path, written) => {
          writes.push(written);
        },
        now: () => {
          throw new Error("completed results keep their recorded timestamp");
        },
      });
      expect(result).toEqual(f.completed);
      expect(writes).toEqual([]);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("worker entry retains failure normalization for errors, strings, and empty throws", async () => {
  const f = await fixture();
  try {
    for (const [error, message] of [
      [new Error("  process failed  "), "  process failed  "],
      ["  process failed  ", "process failed"],
      [null, "worker execution failed"],
      ["   ", "worker execution failed"],
    ] as const) {
      const writes: WorkerResult[] = [];
      const result = await runWorkerJob(f.jobPath, {
        executionGate: () => ({ admitted: true }),
        run: async () => {
          throw error;
        },
        writeResult: (_path, written) => {
          writes.push(written);
        },
        now: () => FINISHED_AT,
      });
      expect(result.error).toBe(message);
      expect(result.finishedAt).toBe(FINISHED_AT);
      expect(writes).toEqual([result]);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
