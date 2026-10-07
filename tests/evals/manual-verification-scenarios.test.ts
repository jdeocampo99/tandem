import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Endpoint, ResolvedPolicy } from "../../src/contracts.ts";
import { MANUAL_VERIFICATION_REVIEWER } from "../../src/instructions.ts";
import { readRuntimeState, runtimeFile } from "../../src/runtime/persistence.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";
import {
  workerReceiptPath,
  writeWorkerReceipt,
} from "../../src/tasks/communication-persistence.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { persistWorkerResult } from "../../src/workers/jobs.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_NOW,
  SCENARIO_POLICY,
  SCENARIO_TASK_ID,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  withScenario,
} from "./scenario.ts";

const SMOKE = "An admin creates a lesson and a learner sees it in the browser";

const POLICY: ResolvedPolicy = {
  ...SCENARIO_POLICY,
  config: {
    ...SCENARIO_POLICY.config,
    validationCommands: [{ name: "ci", argv: ["true"], surfaces: ["*"], timeoutMs: 1_000 }],
    maxFixRounds: 1,
  },
};

test("a manual verification item never reaches review as something to judge, and becomes an unticked PR checklist item", async () => {
  await withScenario({}, async (world) => {
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const seeded = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "reviewing",
      worktree: lease,
      reviewHead: SCENARIO_HEAD,
      policy: POLICY,
      manualVerification: [SMOKE],
    });
    await world.store.update(SCENARIO_TASK_ID, seeded.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: SCENARIO_NOW,
      validationEvidence: [
        {
          name: "ci",
          argv: ["true"],
          exitCode: 0,
          stdout: "",
          stderr: "",
          head: SCENARIO_HEAD,
          contract: "final",
          origin: "local",
          policyDigest: policyIdentity(POLICY),
        },
      ],
    }));
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({ worktree: lease, reviewMode: "review_existing_head" }),
    );
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
    const state = await readRuntimeState(runtimeFile(world.home));
    const review = state.tasks
      .find((entry) => entry.taskId === SCENARIO_TASK_ID)
      ?.jobs.find((entry) => entry.reviewLens === "review");
    if (review === undefined) throw new Error("no review was launched");
    // The reviewer is told a person checks the smoke test, in both its prompt and its review brief.
    const job = JSON.parse(await readFile(review.jobPath, "utf8")) as { readonly prompt: string };
    expect(job.prompt).toContain(
      `## Manual verification\n${MANUAL_VERIFICATION_REVIEWER}\n- ${SMOKE}`,
    );
    const brief = await readFile(join(review.jobPath, "..", "review-brief.md"), "utf8");
    expect(brief).toContain(
      `- manual verification (${MANUAL_VERIFICATION_REVIEWER}):\n  - ${SMOKE}`,
    );

    // The reviewer passes with no finding about the smoke test, and the task comes back clean.
    const endpoint = review.endpoint as Endpoint;
    await terminalBackend(world.run, { terminal: "herdr" }).interrupt({
      endpoint,
      cwd: lease.path,
    });
    await writeWorkerReceipt(workerReceiptPath(review.jobPath), {
      schemaVersion: 1,
      jobId: review.id,
      taskId: SCENARIO_TASK_ID,
      generation: 0,
      receivedRevision: 0,
      appliedRevision: 0,
      heartbeatAt: SCENARIO_NOW,
      progressAt: SCENARIO_NOW,
      phase: "finished",
    });
    await persistWorkerResult(review.resultPath, {
      id: review.id,
      taskId: SCENARIO_TASK_ID,
      generation: 0,
      role: "reviewer",
      status: "completed",
      text: "Review passed.",
      instructionRevision: 0,
      review: {
        lens: "review",
        head: SCENARIO_HEAD,
        generation: 0,
        pass: true,
        findings: [],
        summary: "review passed",
        mode: "review_existing_head",
      },
      finishedAt: SCENARIO_NOW,
    });
    await service.tick();
    await service.tick();

    const task = await service.get(SCENARIO_TASK_ID);
    expect(task.stage).toBe("ready");
    expect(task.reviewRound).toBe(0);
    const body = await service.describePr(SCENARIO_TASK_ID, {
      tldr: ["Lessons reach learners."],
      what: ["Publishes lessons."],
      why: ["Learners need them."],
    });
    expect(body).toContain(
      `# Manual verification\nCheck these by hand before merging.\n- [ ] ${SMOKE}`,
    );
    await service.shutdown();
  });
}, 20_000);
