import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResearchContinuation } from "../../src/contracts.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { finishPendingScoutCleanup } from "../../src/service/scout-cleanup.ts";
import { persistWorkerResult } from "../../src/workers/jobs.ts";
import {
  SCENARIO_NOW,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioJob,
  scenarioOperation,
  scenarioReservation,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

const REPORT_TEXT = "The scout findings that must outlive every cleanup decision.";

function serviceFor(world: ScenarioWorld) {
  return createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run: world.run,
    clock: world.clock,
    idFactory: world.idFactory,
  });
}

/** Research that ends at its report, so its worktree has no implementation to wait for. */
const REPORT_ONLY: ResearchContinuation = {
  schemaVersion: 1,
  disposition: "report-only",
  selectedBy: "explicit",
};

async function seedRunningScout(
  world: ScenarioWorld,
  options: Readonly<{ continuation?: ResearchContinuation; holder?: string }> = {},
): Promise<string> {
  const lease = await world.grantLease({
    name: "scenario-task",
    holder: options.holder ?? "scenario-holder",
  });
  const endpoint = {
    ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
    role: "scout" as const,
  };
  const job = scenarioJob({ home: world.home, role: "scout", cwd: lease.path, endpoint });
  await seedScenarioTask(world, {
    kind: "scout",
    stage: "scouting",
    worktree: lease,
    endpoints: [endpoint],
    researchContinuation: options.continuation ?? REPORT_ONLY,
  });
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({
      worktree: lease,
      endpoints: [endpoint],
      jobs: [job],
      operation: scenarioOperation(job),
      reservation: scenarioReservation(),
    }),
  );
  await persistWorkerResult(job.resultPath, {
    id: job.id,
    taskId: job.taskId,
    generation: job.generation,
    role: "scout",
    status: "completed",
    text: REPORT_TEXT,
    finishedAt: SCENARIO_NOW,
  });
  return lease.path;
}

/** A scout that already reported and whose cleanup is still owed, as reconciliation finds it. */
async function seedSettledScout(world: ScenarioWorld): Promise<string> {
  const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  const endpoint = {
    ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
    role: "scout" as const,
  };
  const reportPath = join(world.home, "jobs", SCENARIO_TASK_ID, "0", "job-1", "report.txt");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, REPORT_TEXT, "utf8");
  await seedScenarioTask(world, {
    kind: "scout",
    stage: "completed",
    reportPath,
    worktree: lease,
    endpoints: [endpoint],
  });
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({
      worktree: lease,
      endpoints: [endpoint],
      reservation: scenarioReservation({ phase: "released", releasedAt: SCENARIO_NOW }),
    }),
  );
  return lease.path;
}

test("completed scout persists its report and releases the pane and lease it proved idle", async () => {
  await withScenario({}, async (world) => {
    await seedRunningScout(world);
    const service = serviceFor(world);

    await service.tick();

    const completed = await service.get(SCENARIO_TASK_ID);
    const snapshot = await world.snapshot();
    expect(completed.stage).toBe("completed");
    expect(completed.cleanup?.status).toBe("released");
    expect(completed.cleanup?.reason).toContain("still on its source commit");
    expect(await readFile(completed.reportPath ?? "", "utf8")).toBe(REPORT_TEXT);
    expect(snapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
    expect(snapshot.resources.released).toContain("pane:pane-1");
    expect(snapshot.resources.released).toContain("lease:lease-1");
    expect(snapshot.resources.quarantined).toEqual([]);
    expect(snapshot.runtime.tasks[0]?.worktree).toBeUndefined();
    await service.shutdown();
  });
});

test("unmerged scout work keeps its worktree and report instead of being cleaned up", async () => {
  await withScenario({}, async (world) => {
    const worktreePath = await seedSettledScout(world);
    world.patchCheckout(worktreePath, { unmerged: true });

    const outcomes = await finishPendingScoutCleanup({
      home: world.home,
      run: world.run,
      clock: world.clock,
    });

    const snapshot = await world.snapshot();
    const task = await world.store.read(SCENARIO_TASK_ID);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("retained");
    expect(outcomes[0]?.reason).toContain("unmerged");
    expect(task?.cleanup?.status).toBe("retained");
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain("worktree:lease-1");
    expect(snapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
    expect(snapshot.resources.retained).toContain(`cleanup:${SCENARIO_TASK_ID}`);
    expect(snapshot.resources.released).not.toContain("lease:lease-1");
    expect(snapshot.trace.some((event) => event.action === "treehouse return")).toBe(false);
  });
});

test("a scout worktree that moved off its lease branch is quarantined rather than returned", async () => {
  await withScenario({}, async (world) => {
    const worktreePath = await seedSettledScout(world);
    world.patchCheckout(worktreePath, { branch: "someone-elses-branch" });

    const outcomes = await finishPendingScoutCleanup({
      home: world.home,
      run: world.run,
      clock: world.clock,
    });

    const snapshot = await world.snapshot();
    expect(outcomes[0]?.status).toBe("quarantined");
    expect(snapshot.resources.quarantined).toContain(`cleanup:${SCENARIO_TASK_ID}`);
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
    expect(snapshot.trace.some((event) => event.action === "treehouse return")).toBe(false);
  });
});

test("a refusing Treehouse boundary retains the scout lease and never discards it", async () => {
  await withScenario({}, async (world) => {
    await seedRunningScout(world);
    const service = serviceFor(world);
    world.failAt({ boundary: "treehouse", action: "treehouse return", times: 2 });

    await service.tick();
    await service.tick();

    const snapshot = await world.snapshot();
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("completed");
    expect(task.cleanup?.status).toBe("pending");
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain("worktree:lease-1");
    expect(snapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
    expect(snapshot.resources.retained).toContain(`cleanup:${SCENARIO_TASK_ID}`);
    expect(
      snapshot.trace.some((event) => event.boundary === "treehouse" && event.outcome === "refused"),
    ).toBe(true);
    await service.shutdown();
  });
});

test("an implementation built on research adopts the scout's worktree instead of leasing another", async () => {
  await withScenario({}, async (world) => {
    await seedRunningScout(world, {
      continuation: {
        schemaVersion: 1,
        disposition: "implementation-interview",
        selectedBy: "explicit",
      },
      holder: `${world.sessionId}:${SCENARIO_TASK_ID}`,
    });
    const service = serviceFor(world);

    await service.tick();
    const scout = await service.get(SCENARIO_TASK_ID);
    expect(scout.cleanup?.status).toBe("retained");
    expect(scout.cleanup?.reason).toContain("kept for the implementation");
    expect(world.paneIsPresent("pane-1")).toBe(false);

    const implementation = await service.create({
      repoPath: world.repoPath,
      kind: "implementation",
      objective: "apply the scout findings",
      acceptanceCriteria: ["the findings are applied"],
      surfaces: ["scenario"],
      researchTaskIds: [SCENARIO_TASK_ID],
    });
    await service.approve(implementation.id);
    await service.tick();

    const snapshot = await world.snapshot();
    const runtime = (taskId: string) =>
      snapshot.runtime.tasks.find((entry) => entry.taskId === taskId);
    expect(runtime(implementation.id)?.worktree?.leaseId).toBe("lease-1");
    expect(runtime(implementation.id)?.worktree?.branch).not.toBe("tandem/scenario-task");
    expect(runtime(SCENARIO_TASK_ID)?.worktree).toBeUndefined();
    expect(snapshot.trace.some((event) => event.action === "treehouse get")).toBe(false);
    expect(snapshot.trace.some((event) => event.action === "treehouse return")).toBe(false);
    await service.shutdown();
  });
});
