import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstructionChannels, ResolvedPolicy } from "../../src/contracts.ts";
import { readRuntimeState, runtimeFile, writeRuntimeState } from "../../src/runtime/persistence.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { runWorkerJob } from "../../src/worker.ts";
import { claimExecutionStart, type ExecutionGateInput } from "../../src/workers/execution-gate.ts";

const channels: InstructionChannels = { implementation: [], validation: [], review: [] };
const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: { model: "provider/coordinator", thinking: "high" },
      scout: { model: "provider/scout", thinking: "medium" },
      implementer: { model: "provider/implementer", thinking: "max" },
      reviewer: { model: "provider/reviewer", thinking: "high" },
      verifier: { model: "provider/verifier", thinking: "high" },
      presentation: { model: "provider/presentation", thinking: "low" },
    },
    instructions: channels,
    instructionFiles: channels,
    validationCommands: [],
    maxWorkers: 2,
    maxFixRounds: 1,
    reviewLevels: {
      reducedRouting: false,
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "tandem-execution-gate-"));
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock: () => "2030-01-01T00:00:00.000Z",
    idFactory: () => "generated",
  });
  const task = await store.create({
    id: "task-1",
    repoPath: home,
    kind: "implementation",
    objective: "exercise the gate",
    acceptanceCriteria: ["one launch"],
    surfaces: ["source"],
    policy,
  });
  const jobPath = join(home, "job.json");
  const resultPath = join(home, "result.json");
  await writeRuntimeState(runtimeFile(home), {
    schemaVersion: 1,
    tasks: [
      {
        schemaVersion: 1,
        taskId: task.id,
        sourceCheckpoint: { head: "head", base: "main", diff: "", dirty: false, unmerged: false },
        taskName: "gate-task",
        operation: {
          schemaVersion: 1,
          id: "operation-1",
          taskId: task.id,
          kind: "implementation",
          role: "implementer",
          generation: task.generation,
          inputHead: "head",
          policyDigest: "policy",
          instructionRevision: 0,
          jobId: "job-1",
          phase: "launching",
          fencingRevision: 1,
          claimOwner: "owner-1",
          createdAt: "2030-01-01T00:00:00.000Z",
          effects: [],
        },
        endpoints: [],
        jobs: [
          {
            schemaVersion: 1,
            id: "job-1",
            taskId: task.id,
            generation: task.generation,
            role: "implementer",
            kind: "worker",
            cwd: home,
            jobPath,
            resultPath,
            attempt: 1,
            phase: "launching",
            launchAttempted: true,
            createdAt: "2030-01-01T00:00:00.000Z",
            operationId: "operation-1",
          },
        ],
      },
    ],
    presentations: [],
  });
  const input: ExecutionGateInput = {
    execution: {
      schemaVersion: 1,
      home,
      operationId: "operation-1",
      fencingRevision: 1,
      claimOwner: "owner-1",
    },
    jobId: "job-1",
    taskId: task.id,
    generation: task.generation,
    command: "worker",
    cwd: home,
    resultPath,
  };
  return { home, input, store, task };
}

test("concurrent worker entrypoints persist exactly one execution claim", async () => {
  const { home, input } = await fixture();
  try {
    const [first, second] = await Promise.all([
      claimExecutionStart(input),
      claimExecutionStart(input),
    ]);
    expect([first.admitted, second.admitted].filter(Boolean)).toHaveLength(1);
    const state = await readRuntimeState(runtimeFile(home));
    expect(state.tasks[0]?.operation?.effects).toHaveLength(1);
    expect(state.tasks[0]?.operation?.effects[0]?.id).toBe("execution:job-1");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("refuses worker execution when the canonical task generation has advanced", async () => {
  const { home, input, store, task } = await fixture();
  try {
    const current = await store.read(task.id);
    if (current === undefined) throw new Error("fixture task disappeared");
    await store.update(task.id, current.revision, (value) => ({
      ...value,
      generation: value.generation + 1,
      revision: value.revision + 1,
    }));
    const outcome = await claimExecutionStart(input);
    expect(outcome.admitted).toBe(false);
    expect(outcome.reason).toContain("generation");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stale fencing and durable stop requests refuse before external worker effects", async () => {
  const { home, input } = await fixture();
  try {
    const stale = await claimExecutionStart({
      ...input,
      execution: { ...input.execution, fencingRevision: 2 },
    });
    expect(stale.admitted).toBe(false);
    const stoppedState = await readRuntimeState(runtimeFile(home));
    await writeRuntimeState(runtimeFile(home), {
      ...stoppedState,
      tasks: stoppedState.tasks.map((task) =>
        task.taskId === input.taskId
          ? {
              ...task,
              stopRequest: {
                schemaVersion: 1 as const,
                action: "pause" as const,
                generation: input.generation,
                requestedAt: "2030-01-01T00:00:01.000Z",
              },
            }
          : task,
      ),
    });
    const stopped = await claimExecutionStart(input);
    expect(stopped.admitted).toBe(false);
    const job = {
      schemaVersion: 1 as const,
      id: "job-1",
      taskId: "task-1",
      generation: 0,
      role: "implementer" as const,
      cwd: home,
      model: { model: "provider/implementer", thinking: "max" as const },
      prompt: "run",
      resultPath: join(home, "worker-result.json"),
      execution: input.execution,
    };
    await writeFile(join(home, "worker-job.json"), JSON.stringify(job));
    let ran = 0;
    const refused = await runWorkerJob(join(home, "worker-job.json"), {
      run: async () => {
        ran += 1;
        return 0;
      },
      executionGate: async () => ({ admitted: false, reason: "paused" }),
    });
    expect(refused.status).toBe("failed");
    expect(ran).toBe(0);
    expect(await Bun.file(job.resultPath).exists()).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
