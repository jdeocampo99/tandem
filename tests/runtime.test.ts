import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeReservations,
  type DurableJob,
  type DurableReservation,
  emptyRuntimeState,
  parseRuntimeState,
  type RuntimePresentation,
  type RuntimeState,
  type RuntimeTaskState,
  readRuntimeState,
  writeRuntimeState,
} from "../src/runtime.ts";

const checkpoint = {
  head: "abc123",
  base: "main",
  diff: "",
  dirty: false,
  unmerged: false,
};

function reservation(
  id: string,
  taskId: string,
  phase: DurableReservation["phase"] = "reserved",
): DurableReservation {
  return {
    schemaVersion: 1,
    id,
    taskId,
    ownerSessionId: "session-1",
    phase,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

function presentationJob(taskId: string): DurableJob {
  return {
    schemaVersion: 1,
    id: "presentation-job-1",
    taskId,
    generation: 0,
    role: "presentation",
    kind: "worker",
    cwd: "/tmp/tandem-presentation",
    jobPath: "/tmp/tandem-presentation/job.json",
    resultPath: "/tmp/tandem-presentation/result.json",
    attempt: 1,
    phase: "reserved",
    launchAttempted: false,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

test("runtime state preserves a clean source checkpoint with an empty diff", () => {
  const state = parseRuntimeState({
    schemaVersion: 1,
    tasks: [
      {
        schemaVersion: 1,
        taskId: "task-1",
        sourceCheckpoint: checkpoint,
        taskName: "tandem-task-1",
        endpoints: [],
        jobs: [],
      },
    ],
    presentations: [],
  });

  expect(state.tasks[0]?.sourceCheckpoint.diff).toBe("");
});

test("active reservations count task and presentation capacity but ignore released entries", () => {
  const task: RuntimeTaskState = {
    schemaVersion: 1,
    taskId: "task-1",
    sourceCheckpoint: checkpoint,
    taskName: "tandem-task-1",
    reservation: reservation("reservation-1", "task-1"),
    endpoints: [],
    jobs: [],
  };
  const presentation: RuntimePresentation = {
    schemaVersion: 1,
    id: "presentation-1",
    taskId: "task-1",
    recordPath: "/tmp/tandem-presentation/record.json",
    reservation: reservation("reservation-2", "task-1"),
    job: presentationJob("task-1"),
  };
  const released: RuntimeTaskState = {
    ...task,
    taskId: "task-2",
    reservation: reservation("reservation-3", "task-2", "released"),
  };
  const state: RuntimeState = {
    ...emptyRuntimeState(),
    tasks: [task, released],
    presentations: [presentation],
  };

  expect(activeReservations(state)).toBe(2);
});

test("runtime persistence rejects malformed JSON instead of resetting scheduler state", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-runtime-test-"));
  const path = join(root, "runtime.json");
  try {
    await writeRuntimeState(path, emptyRuntimeState());
    expect(await readRuntimeState(path)).toEqual(emptyRuntimeState());
    await writeFile(path, "{not-json", "utf8");
    await expect(readRuntimeState(path)).rejects.toThrow("invalid JSON");
    expect(await readFile(path, "utf8")).toBe("{not-json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("round-trips durable launch, stop, consumption, and pool housekeeping metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "tandem-runtime-durable-"));
  const path = join(root, "runtime.json");
  const timestamp = "2030-01-01T00:00:00.000Z";
  try {
    const job: DurableJob = {
      ...presentationJob("task-1"),
      role: "implementer",
      cwd: root,
      jobPath: join(root, "job.json"),
      resultPath: join(root, "result.json"),
      launchAttempted: true,
      phase: "consumed",
      consumedAt: timestamp,
      consumption: {
        schemaVersion: 1,
        inputEventKey: "job:event",
        appliedEventKey: "job:event",
        beforeRevision: 1,
        afterRevision: 2,
        beforeFingerprint: "before",
        taskFingerprint: "after",
        now: timestamp,
        notificationId: "notification-1",
      },
    };
    const state = parseRuntimeState({
      schemaVersion: 1,
      tasks: [
        {
          schemaVersion: 1,
          taskId: "task-1",
          sourceCheckpoint: checkpoint,
          taskName: "tandem-task-1",
          endpointLaunch: {
            schemaVersion: 1,
            reservationId: "reservation-1",
            sessionId: "session-1",
            taskName: "tandem-task-1",
            workspaceLabel: "└ tandem-task-1",
            cwd: root,
            role: "implementer",
            generation: 0,
            createdAt: timestamp,
          },
          stopRequest: {
            schemaVersion: 1,
            action: "pause",
            generation: 0,
            requestedAt: timestamp,
          },
          poolNotice: "pool capacity is unavailable",
          terminalCleanupRevision: 3,
          endpoints: [],
          jobs: [job],
        },
      ],
      presentations: [],
    });
    await writeRuntimeState(path, state);
    const reloaded = await readRuntimeState(path);
    const task = reloaded.tasks[0];
    expect(task?.endpointLaunch?.workspaceLabel).toBe("└ tandem-task-1");
    expect(task?.stopRequest?.action).toBe("pause");
    expect(task?.jobs[0]?.consumption?.afterRevision).toBe(2);
    expect(task?.poolNotice).toBe("pool capacity is unavailable");
    expect(task?.terminalCleanupRevision).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
