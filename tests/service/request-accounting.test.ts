import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, TaskRecord } from "../../src/contracts.ts";
import { createRequestBriefStore } from "../../src/requests/store.ts";
import type {
  DurableJob,
  DurableOperation,
  RuntimeState,
  RuntimeTaskState,
} from "../../src/runtime/schema.ts";
import { createRequestUsageLedger, readTaskUsage } from "../../src/runtime/usage-ledger.ts";
import { RequestAccountingWorkflow } from "../../src/service/request-accounting.ts";
import { taskCost } from "../../src/tasks/trace.ts";
import { writeWorkerTokenTally } from "../../src/workers/terminal.ts";
import { task } from "../session/fixtures.ts";

const NOW = "2030-01-01T02:00:00.000Z";
const REQUEST_ID = "req-accounting";

type Seeded = Readonly<{
  readonly records: readonly TaskRecord[];
  readonly state: RuntimeState;
}>;

function operation(
  taskId: string,
  kind: DurableOperation["kind"],
  role: DurableOperation["role"],
): DurableOperation {
  return {
    schemaVersion: 1,
    id: `op-${taskId}`,
    taskId,
    kind,
    role,
    generation: 0,
    inputHead: "a".repeat(40),
    policyDigest: "digest",
    instructionRevision: 1,
    jobId: `job-${taskId}`,
    phase: "completed",
    fencingRevision: 1,
    claimOwner: "session:1",
    createdAt: "2030-01-01T00:10:00.000Z",
    effects: [],
    resultConsumedAt: "2030-01-01T00:40:00.000Z",
  };
}

function job(root: string, settled: DurableOperation): DurableJob {
  return {
    schemaVersion: 1,
    id: settled.jobId,
    taskId: settled.taskId,
    generation: 0,
    role: settled.role,
    kind: "worker",
    cwd: root,
    jobPath: join(root, `${settled.jobId}.json`),
    resultPath: join(root, `${settled.jobId}-result.json`),
    attempt: 1,
    phase: "consumed",
    launchAttempted: true,
    createdAt: settled.createdAt,
    consumedAt: settled.resultConsumedAt ?? settled.createdAt,
    operationId: settled.id,
  };
}

function runtime(settled: DurableOperation, jobs: readonly DurableJob[]): RuntimeTaskState {
  return {
    schemaVersion: 1,
    taskId: settled.taskId,
    sourceCheckpoint: {
      head: "b".repeat(40),
      base: "main",
      diff: "",
      dirty: false,
      unmerged: false,
    },
    taskName: settled.taskId,
    endpoints: [],
    jobs,
    operationHistory: [settled],
  };
}

/**
 * A requestless scout and PR review beside an implementation governed by a request, each with one
 * settled operation whose worker tallied its tokens and OMP's price-table cost.
 */
async function seed(root: string, requestless: readonly TaskRecord[]): Promise<Seeded> {
  const implementation = task({ id: "task-impl", requestId: REQUEST_ID, stage: "reviewing" });
  const records = [implementation, ...requestless];
  const plans: readonly (readonly [TaskRecord, DurableOperation, number])[] = records.map(
    (record) => {
      if (record.kind === "scout") return [record, operation(record.id, "scout", "scout"), 0.25];
      if (record.kind === "pr-review") {
        return [record, operation(record.id, "review", "reviewer"), 0.5];
      }
      return [record, operation(record.id, "implementation", "implementer"), 1];
    },
  );
  const tasks: RuntimeTaskState[] = [];
  for (const [, settled, costUsd] of plans) {
    const settledJob = job(root, settled);
    await writeWorkerTokenTally(settledJob.jobPath, {
      schemaVersion: 1,
      provider: "anthropic",
      model: "claude",
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      replies: 1,
    });
    tasks.push(runtime(settled, [settledJob]));
  }
  return { records, state: { schemaVersion: 1, tasks, presentations: [] } };
}

async function withAccounting(
  run: (
    input: Readonly<{
      readonly root: string;
      readonly accounting: (state: RuntimeState) => RequestAccountingWorkflow;
      readonly ledger: ReturnType<typeof createRequestUsageLedger>;
    }>,
  ) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-request-accounting-")));
  const home = join(root, "home");
  const clock: Clock = () => NOW;
  const idFactory = () => "fixed-id";
  const ledger = createRequestUsageLedger({ home, clock });
  try {
    await run({
      root,
      ledger,
      accounting: (state) =>
        new RequestAccountingWorkflow({
          home,
          clock,
          idFactory,
          requestStore: createRequestBriefStore({ home, clock, idFactory }),
          usage: ledger,
          sourceRepoPath: undefined,
          listTasks: async () => [],
          openRequestForNewWork: async () => undefined,
          readState: async () => state,
          updateTask: async (taskId) => {
            throw new Error(`no task update was expected for ${taskId}`);
          },
        }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("requestless research and PR reviews are accounted in their own task scope", async () => {
  await withAccounting(async ({ root, accounting, ledger }) => {
    const scout = task({ id: "task-scout", kind: "scout", stage: "completed" });
    const review = task({ id: "task-review", kind: "pr-review", stage: "completed" });
    const { records, state } = await seed(root, [scout, review]);

    await accounting(state).recordSettledTasks(records);

    const scoutUsage = await readTaskUsage(ledger, scout);
    const reviewUsage = await readTaskUsage(ledger, review);
    expect(scoutUsage.events.map((event) => [event.kind, event.workKind])).toEqual([
      ["work", "research"],
    ]);
    expect(scoutUsage.events[0]?.identity).toMatchObject({ taskId: "task-scout", role: "scout" });
    expect(scoutUsage.events[0]?.identity.requestId).toBeUndefined();
    expect(reviewUsage.events.map((event) => [event.kind, event.workKind])).toEqual([
      ["work", "review"],
    ]);
    expect(taskCost(scoutUsage, scout.id)).toMatchObject({
      amountMicros: 250_000,
      estimatedSamples: 1,
    });
    expect(taskCost(reviewUsage, review.id)).toMatchObject({
      amountMicros: 500_000,
      estimatedSamples: 1,
    });
  });
});

test("accounting requestless tasks leaves the request's receipt as it was", async () => {
  await withAccounting(async ({ root, accounting, ledger }) => {
    const scout = task({ id: "task-scout", kind: "scout", stage: "completed" });
    const review = task({ id: "task-review", kind: "pr-review", stage: "completed" });
    const { records, state } = await seed(root, [scout, review]);
    const governedOnly = records.filter((record) => record.requestId !== undefined);

    await accounting(state).recordSettledTasks(governedOnly);
    const before = await ledger.receipt(REQUEST_ID);
    await accounting(state).recordSettledTasks(records);
    const after = await ledger.receipt(REQUEST_ID);

    expect(after).toEqual(before);
    expect(after.charges).toMatchObject({ amountMicros: 1_000_000, estimatedSamples: 1 });
  });
});

test("research credited to a request is counted once on the receipt and once for the scout", async () => {
  await withAccounting(async ({ root, accounting, ledger }) => {
    const scout = task({ id: "task-scout", kind: "scout", stage: "completed" });
    const { records, state } = await seed(root, [scout]);
    const citing = records.map((record) =>
      record.requestId === undefined
        ? record
        : {
            ...record,
            researchHandoffs: [
              {
                scoutTaskId: scout.id,
                scoutRepoPath: "/repo",
                scoutSourceHead: "b".repeat(40),
                scoutSourceBase: "main",
                reportPath: "/repo/report.md",
                reportDigest: "digest",
                excerpt: "what the scout found",
              },
            ],
          },
    );

    await accounting(state).recordSettledTasks(citing);

    const receipt = await ledger.receipt(REQUEST_ID);
    expect(receipt.charges).toMatchObject({ amountMicros: 1_250_000, estimatedSamples: 2 });
    expect(taskCost(await readTaskUsage(ledger, scout), scout.id)?.amountMicros).toBe(250_000);
  });
});

test("replaying the accounting pass records nothing new", async () => {
  await withAccounting(async ({ root, accounting, ledger }) => {
    const scout = task({ id: "task-scout", kind: "scout", stage: "completed" });
    const review = task({ id: "task-review", kind: "pr-review", stage: "completed" });
    const { records, state } = await seed(root, [scout, review]);
    await accounting(state).recordSettledTasks(records);
    const first = await readTaskUsage(ledger, scout);

    await accounting(state).recordSettledTasks(records);

    const allEvents = [
      ...(await ledger.read(REQUEST_ID)).events,
      ...(await ledger.readTask(scout.id)).events,
      ...(await ledger.readTask(review.id)).events,
    ];
    const replay = await ledger.record(allEvents);
    expect(replay.recorded).toBe(0);
    expect(await readTaskUsage(ledger, scout)).toEqual(first);
    expect((await readTaskUsage(ledger, review)).events).toHaveLength(1);
  });
});
