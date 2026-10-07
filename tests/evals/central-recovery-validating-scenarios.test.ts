import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Endpoint, ResolvedPolicy } from "../../src/contracts.ts";
import { VALIDATION_RETRY_QUESTION_ID_PREFIX } from "../../src/recovery/central.ts";
import { activeRuntimeJob } from "../../src/runtime/activity.ts";
import {
  readRuntimeState,
  runtimeFile,
  writeJsonAtomically,
  writeRuntimeState,
} from "../../src/runtime/persistence.ts";
import type { DurableJob } from "../../src/runtime/schema.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { ValidationResult } from "../../src/validation-worker.ts";
import {
  SCENARIO_NOW,
  SCENARIO_POLICY,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioOperation,
  scenarioReservation,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

/** A policy with one real validation command, covering the scenario task's default surfaces. */
const VALIDATING_POLICY: ResolvedPolicy = {
  ...SCENARIO_POLICY,
  config: {
    ...SCENARIO_POLICY.config,
    validationCommands: [{ name: "smoke", argv: ["true"], surfaces: ["*"], timeoutMs: 5_000 }],
  },
};

const RAN_FOR_THIRTY_SECONDS = new Date(Date.parse(SCENARIO_NOW) + 30_000).toISOString();
const VALIDATING_HEAD = "0123456789abcdef0123456789abcdef01234567";

/**
 * The exact durable job an infrastructure-lost validation run leaves behind once
 * `WorkerWorkflow.reconcileJob` has already settled it as failed without blocking (this slice's
 * `reconcileMissingEndpoint`/"validation stopped without durable evidence" change): a terminal
 * failed job, and the task still names its now-dead pane in `task.endpoints` (not yet reconciled).
 */
function deadValidationJob(paneId: string, cwd: string): DurableJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    taskId: SCENARIO_TASK_ID,
    generation: 0,
    role: "validation",
    kind: "validation",
    cwd,
    jobPath: join(cwd, "dead-job", "job.json"),
    resultPath: join(cwd, "dead-job", "result.json"),
    attempt: 1,
    phase: "failed",
    launchAttempted: true,
    createdAt: SCENARIO_NOW,
    consumedAt: RAN_FOR_THIRTY_SECONDS,
    endpoint: {
      terminal: "herdr" as const,
      sessionId: "scenario-session",
      workspaceId: "workspace-dead",
      tabId: "tab-dead",
      paneId,
      role: "reviewer",
      generation: 0,
    },
    head: VALIDATING_HEAD,
    error: "validation stopped without durable evidence: pane is missing",
  };
}

/** Seeds a task at `validating` behind a dead validation job, with its implementer's own pane still
 *  owned (validation's re-entry needs a live writer endpoint, exactly as the real pipeline does). */
async function seedStuckValidating(world: ScenarioWorld) {
  const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  const writerEndpoint: Endpoint = {
    ...world.openPane({ paneId: "pane-writer", cwd: lease.path }),
    role: "implementer",
  };
  const deadPaneId = "pane-validation-dead";
  const deadEndpoint: Endpoint = {
    terminal: "herdr" as const,
    sessionId: "scenario-session",
    workspaceId: "workspace-dead",
    tabId: "tab-dead",
    paneId: deadPaneId,
    role: "reviewer",
    generation: 0,
  };
  const job = deadValidationJob(deadPaneId, lease.path);
  await seedScenarioTask(world, {
    kind: "implementation",
    stage: "validating",
    worktree: lease,
    endpoints: [writerEndpoint, deadEndpoint],
    reviewHead: VALIDATING_HEAD,
    policy: VALIDATING_POLICY,
  });
  await seedScenarioRuntime(
    world,
    scenarioRuntimeTask({
      worktree: lease,
      endpoints: [writerEndpoint],
      jobs: [job],
    }),
  );
  return { lease, job };
}

test("a stuck validation job reruns at the same reviewed HEAD and passes", async () => {
  await withScenario({}, async (world) => {
    const { lease, job } = await seedStuckValidating(world);

    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
      workerTimeoutMs: 1_500,
    });

    // --- The pane behind the dead job is proven gone, and a fresh validation job is launched. ---
    await service.tick();
    let task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("validating");
    expect(task.endpoints?.some((entry) => entry.paneId === "pane-validation-dead")).toBe(false);
    expect(
      task.notifications.some((entry) => entry.message.includes("I reran it at the same reviewed")),
    ).toBe(true);
    let snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.recovery?.validationRetries).toBe(1);
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);

    const state = await readRuntimeState(runtimeFile(world.home));
    const runtime = state.tasks.find((entry) => entry.taskId === SCENARIO_TASK_ID);
    const newJob = runtime?.jobs.find((entry) => entry.id !== job.id && activeRuntimeJob(entry));
    if (newJob === undefined) throw new Error("central recovery did not start a replacement job");
    expect(newJob.kind).toBe("validation");
    const newEndpoint = newJob.endpoint;
    if (newEndpoint === undefined) throw new Error("replacement validation job has no endpoint");

    // --- The new validation run "finishes": its pane returns to shell and it writes a passing result. ---
    await terminalBackend(world.run, { terminal: "herdr" }).interrupt({
      endpoint: newEndpoint,
      cwd: lease.path,
    });
    const result: ValidationResult = {
      schemaVersion: 1,
      id: newJob.id,
      taskId: SCENARIO_TASK_ID,
      generation: 0,
      head: newJob.head as string,
      contract: newJob.contract as "final",
      policyDigest: newJob.policyDigest as string,
      status: "completed",
      evidence: [
        {
          name: "smoke",
          argv: ["true"],
          exitCode: 0,
          stdout: "",
          stderr: "",
          head: newJob.head as string,
          contract: newJob.contract as "final",
          origin: "local",
          policyDigest: newJob.policyDigest as string,
        },
      ],
      finishedAt: SCENARIO_NOW,
    };
    await writeJsonAtomically(newJob.resultPath, result);

    await service.tick();
    task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("reviewing");
    snapshot = await world.snapshot();
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);

    await service.shutdown();
  });
}, 20_000);

test("validation exhausting its retry budget asks instead of rerunning again", async () => {
  await withScenario({}, async (world) => {
    const { lease } = await seedStuckValidating(world);
    const state = await readRuntimeState(runtimeFile(world.home));
    await writeRuntimeState(runtimeFile(world.home), {
      ...state,
      tasks: state.tasks.map((entry) => ({
        ...entry,
        recovery: {
          schemaVersion: 1 as const,
          recoveryAttempts: 0,
          validationRetries: 3,
          evidenceRepairs: 0,
        },
      })),
    });

    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
      workerTimeoutMs: 1_500,
    });

    await service.tick();
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("blocked");
    expect(task.communication?.question?.id.startsWith(VALIDATION_RETRY_QUESTION_ID_PREFIX)).toBe(
      true,
    );
    expect(task.communication?.revision ?? 0).toBe(0);
    const snapshot = await world.snapshot();
    expect(snapshot.runtime.tasks[0]?.recovery?.validationRetries).toBe(3);
    // Asking never discards work: the worktree lease is still retained, never released.
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);
    expect(snapshot.resources.released).not.toContain(`worktree:${lease.leaseId}`);

    await service.shutdown();
  });
}, 20_000);

test("a genuine task-code validation failure still moves to awaiting-fixes, not recovery", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const writerEndpoint: Endpoint = {
      ...world.openPane({ paneId: "pane-writer", cwd: lease.path }),
      role: "implementer",
    };
    const validationEndpoint: Endpoint = {
      ...world.openPane({ paneId: "pane-validation", cwd: lease.path }),
      role: "reviewer",
    };
    const head = "0123456789abcdef0123456789abcdef01234567";
    const job: DurableJob = {
      schemaVersion: 1,
      id: "job-1",
      taskId: SCENARIO_TASK_ID,
      generation: 0,
      role: "validation",
      kind: "validation",
      cwd: lease.path,
      jobPath: "/tmp/unused/job.json",
      resultPath: `${lease.path}/result.json`,
      attempt: 1,
      phase: "running",
      launchAttempted: true,
      createdAt: SCENARIO_NOW,
      operationId: "operation-1",
      endpoint: validationEndpoint,
      head,
      contract: "final",
      policyDigest: policyIdentity(VALIDATING_POLICY),
    };
    await seedScenarioTask(world, {
      kind: "implementation",
      stage: "validating",
      worktree: lease,
      endpoints: [writerEndpoint, validationEndpoint],
      reviewHead: head,
      policy: VALIDATING_POLICY,
    });
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        worktree: lease,
        endpoints: [writerEndpoint, validationEndpoint],
        jobs: [job],
        operation: scenarioOperation(job),
        reservation: scenarioReservation(),
      }),
    );
    // The pane's process already returned to shell before this tick, matching a validation run that
    // finished (successfully or not) rather than one whose process is still live.
    await terminalBackend(world.run, { terminal: "herdr" }).interrupt({
      endpoint: validationEndpoint,
      cwd: lease.path,
    });
    const result: ValidationResult = {
      schemaVersion: 1,
      id: job.id,
      taskId: SCENARIO_TASK_ID,
      generation: 0,
      head,
      contract: "final",
      policyDigest: policyIdentity(VALIDATING_POLICY),
      status: "failed",
      evidence: [
        {
          name: "smoke",
          argv: ["true"],
          exitCode: 1,
          stdout: "",
          stderr: "assertion failed",
          head,
          contract: "final",
          origin: "local",
          policyDigest: policyIdentity(VALIDATING_POLICY),
        },
      ],
      finishedAt: SCENARIO_NOW,
      error: "validation command failed",
    };
    await writeJsonAtomically(job.resultPath, result);

    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
      workerTimeoutMs: 1_500,
    });

    await service.tick();
    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("awaiting-fixes");
    expect(task.communication?.question).toBeUndefined();
    const snapshot = await world.snapshot();
    expect(snapshot.resources.retained).toContain(`worktree:${lease.leaseId}`);

    await service.shutdown();
  });
}, 20_000);
