import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResearchContinuation, TaskRecord } from "../../src/contracts.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { finishPendingScoutCleanup } from "../../src/service/scout-cleanup.ts";
import { persistWorkerResult } from "../../src/workers/jobs.ts";
import {
  SCENARIO_NOW,
  SCENARIO_HEAD,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  appendScenarioRuntime,
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
  options: Readonly<{
    taskId?: string;
    paneId?: string;
    continuation?: ResearchContinuation;
    holder?: string;
  }> = {},
): Promise<string> {
  const taskId = options.taskId ?? SCENARIO_TASK_ID;
  const paneId = options.paneId ?? "pane-1";
  const lease = await world.grantLease({
    name: taskId === SCENARIO_TASK_ID ? "scenario-task" : `scenario-${taskId}`,
    holder: options.holder ?? "scenario-holder",
  });
  const endpoint = {
    ...world.openPane({ paneId, cwd: lease.path }),
    role: "scout" as const,
  };
  const job = scenarioJob({
    home: world.home,
    role: "scout",
    cwd: lease.path,
    endpoint,
    taskId,
  });
  await seedScenarioTask(world, {
    id: taskId,
    kind: "scout",
    stage: "scouting",
    worktree: lease,
    endpoints: [endpoint],
    researchContinuation: options.continuation ?? REPORT_ONLY,
  });
  const runtime = scenarioRuntimeTask({
    taskId,
    worktree: lease,
    endpoints: [endpoint],
    jobs: [job],
    operation: scenarioOperation(job),
    reservation: scenarioReservation({ taskId }),
  });
  if (taskId === SCENARIO_TASK_ID) await seedScenarioRuntime(world, runtime);
  else await appendScenarioRuntime(world, runtime);
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
    researchInterview: { schemaVersion: 1, status: "stopped", decisions: [] },
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

async function seedApprovedMultipleScoutHandoff(
  world: ScenarioWorld,
): Promise<Readonly<{
  readonly service: ReturnType<typeof serviceFor>;
  readonly implementation: TaskRecord;
  readonly primaryPath: string;
  readonly additionalPath: string;
}>> {
  const continuation: ResearchContinuation = {
    schemaVersion: 1,
    disposition: "implementation-interview",
    selectedBy: "explicit",
  };
  const primaryPath = await seedRunningScout(world, {
    continuation,
    holder: `${world.sessionId}:${SCENARIO_TASK_ID}`,
  });
  const additionalPath = await seedRunningScout(world, {
    taskId: "scout-extra",
    paneId: "pane-2",
    continuation,
    holder: `${world.sessionId}:scout-extra`,
  });
  const service = serviceFor(world);
  await service.tick();
  await service.tick();
  const implementation = await service.create({
    repoPath: world.repoPath,
    kind: "implementation",
    objective: "apply the cited research",
    acceptanceCriteria: ["the cited findings are applied"],
    surfaces: ["scenario"],
    researchTaskIds: [SCENARIO_TASK_ID, "scout-extra"],
  });
  await service.approve(implementation.id);
  return { service, implementation, primaryPath, additionalPath };
}

test("completed research retains its session and clean workspace until explicit stop", async () => {
  await withScenario({}, async (world) => {
    await seedRunningScout(world);
    const service = serviceFor(world);

    await service.tick();

    const completed = await service.get(SCENARIO_TASK_ID);
    const snapshot = await world.snapshot();
    expect(completed.stage).toBe("completed");
    expect(completed.researchInterview?.status).toBe("open");
    expect(completed.cleanup?.status).toBe("retained");
    expect(completed.cleanup?.reason).toContain("interview is open");
    expect(await readFile(completed.reportPath ?? "", "utf8")).toBe(REPORT_TEXT);
    expect(snapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
    expect(snapshot.resources.retained).toContain("pane:pane-1");
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.released).not.toContain("pane:pane-1");
    expect(snapshot.resources.released).not.toContain("lease:lease-1");
    expect(snapshot.runtime.tasks[0]?.worktree?.leaseId).toBe("lease-1");
    await service.shutdown();
  });
});
test("explicit stop releases a proven clean research pane and lease", async () => {
  await withScenario({}, async (world) => {
    await seedRunningScout(world);
    const service = serviceFor(world);
    await service.tick();

    const stopped = await service.cleanup(SCENARIO_TASK_ID);
    const snapshot = await world.snapshot();
    expect(stopped.researchInterview?.status).toBe("stopped");
    expect(stopped.cleanup?.status).toBe("released");
    expect(snapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
    expect(snapshot.resources.released).toContain("pane:pane-1");
    expect(snapshot.resources.released).toContain("lease:lease-1");
    expect(snapshot.runtime.tasks[0]?.worktree).toBeUndefined();
    await service.shutdown();
  });
});
test("a dirty research workspace keeps one pending decision and stays retained on stop", async () => {
  await withScenario({}, async (world) => {
    const worktreePath = await seedRunningScout(world, {
      continuation: {
        schemaVersion: 1,
        disposition: "implementation-interview",
        selectedBy: "explicit",
      },
      holder: `${world.sessionId}:${SCENARIO_TASK_ID}`,
    });
    const service = serviceFor(world);
    await service.tick();
    world.patchCheckout(worktreePath, { dirty: true });
    const request = {
      taskId: SCENARIO_TASK_ID,
      question: "Which constraint changes the recommendation?",
    };

    await expect(service.researchFollowUp(request)).rejects.toThrow(
      "uncommitted or untracked changes",
    );
    const first = await service.get(SCENARIO_TASK_ID);
    const decisionId = first.researchInterview?.decisions[0]?.id;
    expect(first.researchInterview?.decisions).toHaveLength(1);
    expect(first.researchInterview?.decisions[0]?.status).toBe("pending");
    const implementation = await service.create({
      repoPath: world.repoPath,
      kind: "implementation",
      objective: "apply the scout findings",
      acceptanceCriteria: ["the findings are applied"],
      surfaces: ["scenario"],
      researchTaskIds: [SCENARIO_TASK_ID],
    });
    await expect(service.approve(implementation.id)).rejects.toThrow("unanswered decision");
    expect((await service.get(implementation.id)).scopeApproved).toBe(false);
    expect((await service.get(SCENARIO_TASK_ID)).researchInterview?.decisions[0]?.status).toBe(
      "pending",
    );
    await expect(service.researchFollowUp(request)).rejects.toThrow(
      "uncommitted or untracked changes",
    );

    const second = await service.get(SCENARIO_TASK_ID);
    const snapshot = await world.snapshot();
    expect(second.researchInterview?.decisions).toHaveLength(1);
    expect(second.researchInterview?.decisions[0]?.id).toBe(decisionId);
    expect(second.generation).toBe(first.generation);
    expect(snapshot.runtime.tasks[0]?.jobs).toHaveLength(1);
    expect(snapshot.runtime.tasks[0]?.worktree?.leaseId).toBe("lease-1");
    expect(snapshot.resources.retained).toContain("pane:pane-1");
    expect(snapshot.resources.retained).toContain("lease:lease-1");

    const stopped = await service.cleanup(SCENARIO_TASK_ID);
    expect(stopped.researchInterview?.status).toBe("stopped");
    expect(stopped.researchInterview?.decisions[0]?.status).toBe("withdrawn");
    expect(stopped.cleanup?.status).toBe("retained");
    expect(stopped.cleanup?.reason).toContain("uncommitted or untracked changes");
    await expect(service.researchFollowUp(request)).rejects.toThrow("interview is not open");
    const stoppedSnapshot = await world.snapshot();
    expect(stoppedSnapshot.runtime.tasks[0]?.jobs).toHaveLength(1);
    world.patchCheckout(worktreePath, { head: SCENARIO_HEAD, dirty: false });
    const retried = await service.cleanup(SCENARIO_TASK_ID);
    expect(retried.cleanup?.status).toBe("released");
    const releasedSnapshot = await world.snapshot();
    expect(releasedSnapshot.resources.released).toContain("lease:lease-1");
    expect(releasedSnapshot.resources.retained).toContain(`report:${SCENARIO_TASK_ID}`);
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
    const traceBeforeRepeat = world.trace();
    const service = serviceFor(world);
    const repeated = await service.cleanup(SCENARIO_TASK_ID);
    expect(repeated.cleanup?.status).toBe("quarantined");
    expect(world.trace()).toEqual(traceBeforeRepeat);
    await service.shutdown();
  });
});

test("a refusing Treehouse boundary retains explicitly stopped scout resources", async () => {
  await withScenario({}, async (world) => {
    await seedRunningScout(world);
    const service = serviceFor(world);

    await service.tick();
    world.failAt({ boundary: "treehouse", action: "treehouse return", times: 2 });
    await service.cleanup(SCENARIO_TASK_ID);
    await service.tick();

    const snapshot = await world.snapshot();
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("completed");
    expect(task.researchInterview?.status).toBe("stopped");
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
    expect(scout.cleanup?.reason).toContain("interview is open");
    // The completed scout remains available until the implementation is approved.
    expect(world.paneIsPresent("pane-1")).toBe(true);

    const implementation = await service.create({
      repoPath: world.repoPath,
      kind: "implementation",
      objective: "apply the scout findings",
      acceptanceCriteria: ["the findings are applied"],
      surfaces: ["scenario"],
      researchTaskIds: [SCENARIO_TASK_ID],
    });
    await service.approve(implementation.id);
    const approvedScout = await service.get(SCENARIO_TASK_ID);
    expect(approvedScout.researchInterview?.status).toBe("approved");
    expect(approvedScout.cleanup?.reason).toBe(
      "research approved for implementation handoff",
    );
    // An older persisted implementation carries explicit approval but no interview field.
    await world.store.update(approvedScout.id, approvedScout.revision, (latest) => {
      const { researchInterview: _researchInterview, ...legacy } = latest;
      return {
        ...legacy,
        revision: latest.revision + 1,
        updatedAt: world.clock(),
      };
    });
    await service.tick();

    const snapshot = await world.snapshot();
    const runtime = (taskId: string) =>
      snapshot.runtime.tasks.find((entry) => entry.taskId === taskId);
    expect(runtime(implementation.id)?.worktree?.leaseId).toBe("lease-1");
    expect(runtime(implementation.id)?.worktree?.branch).not.toBe("tandem/scenario-task");
    expect(runtime(SCENARIO_TASK_ID)?.worktree).toBeUndefined();
    expect(runtime(SCENARIO_TASK_ID)?.endpoints).toEqual([]);
    expect(world.paneIsPresent("pane-1")).toBe(false);
    expect(snapshot.trace.some((event) => event.action === "treehouse get")).toBe(false);
    expect(snapshot.trace.some((event) => event.action === "treehouse return")).toBe(false);
    const adoptedScout = await service.get(SCENARIO_TASK_ID);
    expect(adoptedScout.researchInterview?.status).toBe("approved");
    expect(adoptedScout.cleanup?.reason).toBe(
      "research approved for implementation handoff",
    );
    await service.shutdown();
  });
});

test("multiple research handoffs adopt one workspace and release clean extras", async () => {
  await withScenario({}, async (world) => {
    const { service, implementation, primaryPath } =
      await seedApprovedMultipleScoutHandoff(world);

    await service.tick();

    const snapshot = await world.snapshot();
    const runtime = (taskId: string) =>
      snapshot.runtime.tasks.find((entry) => entry.taskId === taskId);
    expect(runtime(implementation.id)?.worktree?.path).toBe(primaryPath);
    expect(runtime(implementation.id)?.worktree?.leaseId).toBe("lease-1");
    expect(runtime(SCENARIO_TASK_ID)?.worktree).toBeUndefined();
    expect(runtime("scout-extra")?.worktree).toBeUndefined();
    expect(world.paneIsPresent("pane-1")).toBe(false);
    expect(world.paneIsPresent("pane-2")).toBe(false);
    expect(snapshot.resources.released).toContain("lease:lease-2");
    expect(snapshot.resources.released).not.toContain("lease:lease-1");
    expect(
      snapshot.trace.filter((event) => event.action === "treehouse return"),
    ).toHaveLength(1);
    expect((await service.get(SCENARIO_TASK_ID)).researchInterview?.status).toBe("approved");
    const additional = await service.get("scout-extra");
    expect(additional.researchInterview?.status).toBe("approved");
    expect(additional.cleanup?.status).toBe("released");
    await service.shutdown();
  });
});

test("multiple research handoffs retain dirty extras and adopt only the first", async () => {
  await withScenario({}, async (world) => {
    const { service, implementation, primaryPath, additionalPath } =
      await seedApprovedMultipleScoutHandoff(world);
    world.patchCheckout(additionalPath, { dirty: true });

    await service.tick();

    const snapshot = await world.snapshot();
    const runtime = (taskId: string) =>
      snapshot.runtime.tasks.find((entry) => entry.taskId === taskId);
    expect(runtime(implementation.id)?.worktree?.path).toBe(primaryPath);
    expect(runtime(implementation.id)?.worktree?.leaseId).toBe("lease-1");
    expect(runtime(SCENARIO_TASK_ID)?.worktree).toBeUndefined();
    expect(runtime("scout-extra")?.worktree?.leaseId).toBe("lease-2");
    expect(world.paneIsPresent("pane-1")).toBe(false);
    expect(world.paneIsPresent("pane-2")).toBe(false);
    expect(snapshot.resources.retained).toContain("lease:lease-2");
    expect(snapshot.resources.released).not.toContain("lease:lease-2");
    const additional = await service.get("scout-extra");
    expect(additional.researchInterview?.status).toBe("approved");
    expect(additional.cleanup?.status).toBe("retained");
    expect(additional.cleanup?.reason).toContain("uncommitted");
    await service.shutdown();
  });
});

test("uncertain extra research closure blocks the cited implementation", async () => {
  await withScenario({}, async (world) => {
    const { service, implementation } = await seedApprovedMultipleScoutHandoff(world);
    world.failAt({ boundary: "herdr", action: "herdr pane process-info" });

    await service.tick();

    const snapshot = await world.snapshot();
    const blocked = await service.get(implementation.id);
    const runtime = (taskId: string) =>
      snapshot.runtime.tasks.find((entry) => entry.taskId === taskId);
    expect(blocked.stage).toBe("blocked");
    expect(blocked.blockCause?.detail).toContain("research handoff");
    expect(runtime(implementation.id)?.worktree).toBeUndefined();
    expect(runtime(SCENARIO_TASK_ID)?.worktree?.leaseId).toBe("lease-1");
    expect(runtime("scout-extra")?.worktree?.leaseId).toBe("lease-2");
    expect(snapshot.resources.retained).toContain("pane:pane-1");
    expect(snapshot.resources.retained).toContain("pane:pane-2");
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(snapshot.resources.retained).toContain("lease:lease-2");
    expect(world.paneIsPresent("pane-1")).toBe(true);
    expect(world.paneIsPresent("pane-2")).toBe(true);
    expect(snapshot.trace.some((event) => event.action === "treehouse get")).toBe(false);
    expect(snapshot.trace.some((event) => event.action === "treehouse return")).toBe(false);
    await service.shutdown();
  });
});

test("uncertain scout-pane closure blocks handoff without a fresh workspace", async () => {
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

    const implementation = await service.create({
      repoPath: world.repoPath,
      kind: "implementation",
      objective: "apply the scout findings",
      acceptanceCriteria: ["the findings are applied"],
      surfaces: ["scenario"],
      researchTaskIds: [SCENARIO_TASK_ID],
    });
    await service.approve(implementation.id);
    world.failAt({ boundary: "herdr", action: "herdr pane process-info" });
    await service.tick();

    const snapshot = await world.snapshot();
    const blocked = await service.get(implementation.id);
    const runtime = (taskId: string) =>
      snapshot.runtime.tasks.find((entry) => entry.taskId === taskId);
    expect(blocked.stage).toBe("blocked");
    expect(blocked.blockCause?.detail).toContain("research handoff");
    expect(runtime(implementation.id)?.worktree).toBeUndefined();
    expect(runtime(SCENARIO_TASK_ID)?.worktree?.leaseId).toBe("lease-1");
    expect(snapshot.resources.retained).toContain("pane:pane-1");
    expect(snapshot.resources.retained).toContain("lease:lease-1");
    expect(world.paneIsPresent("pane-1")).toBe(true);
    expect(snapshot.trace).toContainEqual({
      boundary: "herdr",
      action: "herdr pane process-info",
      outcome: "refused",
    });
    expect(snapshot.trace.some((event) => event.action === "treehouse get")).toBe(false);
    await service.shutdown();
  });
});
