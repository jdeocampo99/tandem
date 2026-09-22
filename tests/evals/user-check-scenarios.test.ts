import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { interruptEndpoint } from "../../src/adapters/herdr.ts";
import type {
  Endpoint,
  PinnedValidationEvidence,
  ResolvedPolicy,
  ReviewResult,
  TaskRecord,
} from "../../src/contracts.ts";
import { assertTaskShape } from "../../src/delivery/evidence.ts";
import { readRuntimeState, runtimeFile, taskJobsDirectory } from "../../src/runtime/persistence.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";
import {
  workerReceiptPath,
  writeWorkerReceipt,
} from "../../src/tasks/communication-persistence.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import { userCheckQuestionId } from "../../src/tasks/user-checks.ts";
import { persistWorkerResult } from "../../src/workers/jobs.ts";
import {
  SCENARIO_HEAD,
  SCENARIO_POLICY,
  SCENARIO_TASK_ID,
  type ScenarioWorld,
  scenarioJob,
  scenarioOperation,
  scenarioReservation,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  withScenario,
} from "./scenario.ts";

/**
 * Reproduces issue #84's stuck scenario: a task whose acceptance criteria mix what a validation
 * command can prove with what only a Playwright-style hands-on pass can prove. Before this feature,
 * the verifier re-asked the same unprovable criterion every round because evidence repair could
 * never promote the implementer's ad-hoc run. This file proves the fix end to end, through the real
 * lifecycle transitions and the real service, not a re-description of them.
 */

const VALIDATING_POLICY: ResolvedPolicy = {
  ...SCENARIO_POLICY,
  config: {
    ...SCENARIO_POLICY.config,
    maxFixRounds: 2,
    validationCommands: [{ name: "smoke", argv: ["true"], surfaces: ["*"], timeoutMs: 5_000 }],
  },
};

const policyDigest = policyIdentity(VALIDATING_POLICY);

/** No configured command can prove this; the verifier must hand it off rather than loop on it. */
const UNTESTABLE_CRITERION = "The streak bar's final layout matches the approved design exactly";
/** Tagged as a "you check" item at approval time, the way the issue's Playwright paths should have been. */
const USER_CHECK_CRITERION = "Streak bar glows at 5 in a row in both typed and flashcard modes";

function serviceFor(world: ScenarioWorld): TandemService {
  return createTandemService({
    home: world.home,
    sessionId: world.sessionId,
    poolRoot: world.poolRoot,
    run: world.run,
    clock: world.clock,
    idFactory: world.idFactory,
  });
}

function evidence(head: string): PinnedValidationEvidence {
  return {
    name: "smoke",
    argv: ["true"],
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    head,
    contract: "final",
    origin: "local",
    policyDigest,
  };
}

function passingReview(
  lens: ReviewResult["lens"],
  head: string,
  handToUser?: readonly string[],
): ReviewResult {
  return {
    lens,
    head,
    generation: 0,
    pass: true,
    findings: [],
    summary: `${lens} review passed`,
    ...(handToUser === undefined ? {} : { handToUser }),
  };
}

/**
 * Drives one task from creation through `ready`, entirely through the production `transitionTask`
 * state machine (the same function every real worker result feeds), with:
 * - a "you check" criterion tagged at approval time, evidenced by the implementer's saved screenshot;
 * - a Tandem-check criterion no validation command can prove, which the verification lens hands off
 *   via `handToUser` instead of failing the lens or asking a needs-decision question about it.
 *
 * No `block` or needs-decision event is ever raised across the four review lenses: the only question
 * the task ends up asking is the single end-of-task "you check" question.
 */
async function seedReadyTaskWithUserCheck(world: ScenarioWorld): Promise<{
  readonly task: TaskRecord;
  readonly evidencePath: string;
}> {
  let notificationSequence = 0;
  const context = (): { now: string; notificationId: string } => {
    notificationSequence += 1;
    return { now: world.clock(), notificationId: `scenario-user-check-${notificationSequence}` };
  };

  const created = await world.store.create({
    id: SCENARIO_TASK_ID,
    repoPath: world.repoPath,
    kind: "implementation",
    objective: "Add a streak bar to the habit screen",
    acceptanceCriteria: ["Streak logic has unit tests", UNTESTABLE_CRITERION],
    userCheckCriteria: [USER_CHECK_CRITERION],
    surfaces: ["app"],
    policy: VALIDATING_POLICY,
  });

  let task = await world.store.update(created.id, created.revision, (current) =>
    transitionTask(current, { type: "approve" }, context()),
  );

  const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
  const endpoint = {
    ...world.openPane({ paneId: "pane-1", cwd: lease.path }),
    role: "implementer" as const,
  };
  task = await world.store.update(task.id, task.revision, (current) =>
    transitionTask(current, { type: "start", worktree: lease, endpoints: [endpoint] }, context()),
  );
  // The durable runtime record a real launch would have written; review has since closed the
  // implementer's pane, so no writer endpoint remains (`beginFixes` gracefully leaves a fix round
  // unlaunched rather than blocking when the pane it expected to reuse is gone — see its own comment
  // in src/workers/workflow.ts — so the fix context it wrote to disk is still exactly what this
  // scenario needs to check).
  await seedScenarioRuntime(world, scenarioRuntimeTask({ worktree: lease }));

  const evidencePath = join(
    taskJobsDirectory(world.home, task.id),
    "0",
    "job-1",
    "user-checks",
    "streak.png",
  );
  task = await world.store.update(task.id, task.revision, (current) =>
    transitionTask(
      current,
      {
        type: "implementation-complete",
        head: SCENARIO_HEAD,
        generation: current.generation,
        userCheckEvidence: [{ criterion: USER_CHECK_CRITERION, paths: [evidencePath] }],
      },
      context(),
    ),
  );

  task = await world.store.update(task.id, task.revision, (current) =>
    transitionTask(
      current,
      {
        type: "validation-succeeded",
        head: SCENARIO_HEAD,
        generation: current.generation,
        contract: "final",
        policyDigest,
        evidence: [evidence(SCENARIO_HEAD)],
      },
      context(),
    ),
  );

  for (const lens of ["behavior", "design", "coverage"] as const) {
    task = await world.store.update(task.id, task.revision, (current) =>
      transitionTask(
        current,
        { type: "record-review", review: passingReview(lens, SCENARIO_HEAD) },
        context(),
      ),
    );
  }
  // Verification cannot prove the layout criterion from runner evidence or the source, so it hands
  // it off instead of asking a needs-decision question or failing the lens.
  task = await world.store.update(task.id, task.revision, (current) =>
    transitionTask(
      current,
      {
        type: "record-review",
        review: passingReview("verification", SCENARIO_HEAD, [UNTESTABLE_CRITERION]),
      },
      context(),
    ),
  );

  task = await world.store.update(task.id, task.revision, (current) =>
    transitionTask(
      current,
      { type: "finish-review", head: SCENARIO_HEAD, generation: current.generation },
      context(),
    ),
  );

  return { task, evidencePath };
}

test("the task reaches ready with exactly one user-check question and no verifier needs-decision", async () => {
  await withScenario({}, async (world) => {
    const { task, evidencePath } = await seedReadyTaskWithUserCheck(world);

    expect(task.stage).toBe("ready");
    expect(task.blockReason).toBeUndefined();
    expect(task.previousStage).toBeUndefined();

    // The handed-off criterion moved out of the Tandem-check list and into "you check".
    expect(task.acceptanceCriteria).toEqual(["Streak logic has unit tests"]);
    expect(task.userCheckCriteria).toEqual([USER_CHECK_CRITERION, UNTESTABLE_CRITERION]);

    // Exactly one question is durable on the task, and it is the end-of-task "you check" question.
    const question = task.communication?.question;
    expect(question).toBeDefined();
    expect(question?.id).toBe(userCheckQuestionId(task.generation, SCENARIO_HEAD));
    expect(question?.id.startsWith("user-check-")).toBe(true);
    expect(question?.text).toContain("look right?");
    expect(question?.text).toContain("1 screenshot attached.");

    // No verifier needs-decision question was ever raised: the task was never blocked, and its
    // notification log never carries a decision-needed message.
    expect(task.notifications.every((entry) => !entry.message.includes("needs a decision"))).toBe(
      true,
    );

    expect(task.userCheck).toEqual({
      head: SCENARIO_HEAD,
      generation: 0,
      evidence: [{ criterion: USER_CHECK_CRITERION, paths: [evidencePath] }],
    });
  });
});

test("'yes' confirms the you-check without bumping communication.revision and clears delivery's gate", async () => {
  await withScenario({}, async (world) => {
    const { task } = await seedReadyTaskWithUserCheck(world);
    const questionId = task.communication?.question?.id;
    if (questionId === undefined)
      throw new Error("scenario task is missing its user-check question");
    const revisionBefore = task.communication?.revision ?? 0;

    const service = serviceFor(world);
    await service.answer({ taskId: task.id, questionId, text: "yes" });
    const confirmed = await service.get(task.id);

    expect(confirmed.stage).toBe("ready");
    expect(confirmed.communication?.question).toBeUndefined();
    expect(confirmed.communication?.revision).toBe(revisionBefore);
    expect(confirmed.userCheck?.answer?.outcome).toBe("confirmed");
    expect(() => assertTaskShape(confirmed)).not.toThrow();
    await service.shutdown();
  });
});

test("a non-yes reply starts a fix round whose fix context carries the user-check finding", async () => {
  await withScenario({}, async (world) => {
    const { task } = await seedReadyTaskWithUserCheck(world);
    const questionId = task.communication?.question?.id;
    if (questionId === undefined)
      throw new Error("scenario task is missing its user-check question");

    const service = serviceFor(world);
    await service.answer({
      taskId: task.id,
      questionId,
      text: "The glow is the wrong color.",
    });
    const changed = await service.get(task.id);

    // beginFixes admits the round (bumping the generation and moving the task to `implementing`)
    // before it ever touches a pane; since review closed the original implementer's pane, it leaves
    // the round there unlaunched rather than blocking (src/workers/workflow.ts's own comment on
    // this). The fix context is already durably written by that point, which is what this checks.
    expect(changed.stage).toBe("implementing");
    expect(changed.generation).toBe(task.generation + 1);
    expect(changed.reviewRound).toBe(task.reviewRound + 1);
    expect(changed.communication?.question).toBeUndefined();
    expect(changed.userCheck?.answer).toEqual({
      outcome: "changes-requested",
      text: "The glow is the wrong color.",
      answeredAt: expect.any(String),
    });
    const lastMessage = changed.communication?.messages.at(-1);
    expect(lastMessage?.kind).toBe("answer");
    expect(lastMessage?.text).toBe("The glow is the wrong color.");
    expect(lastMessage?.replyTo).toBe(questionId);

    const contextPath = join(
      taskJobsDirectory(world.home, task.id),
      `fix-context-${changed.generation}.json`,
    );
    const raw = await readFile(contextPath, "utf8");
    const fixContext = JSON.parse(raw) as {
      findings: readonly { id: string; description: string }[];
    };
    const userFinding = fixContext.findings.find((finding) => finding.id === "user-check");
    expect(userFinding?.description).toContain("The glow is the wrong color.");
    await service.shutdown();
  });
});

test("answering the user-check question after the task has left ready throws", async () => {
  await withScenario({}, async (world) => {
    const { task } = await seedReadyTaskWithUserCheck(world);
    const questionId = task.communication?.question?.id;
    if (questionId === undefined)
      throw new Error("scenario task is missing its user-check question");

    // A pause leaves the pending question exactly as it was but moves the task off `ready`, which is
    // the only way the still-current question and a non-ready stage coexist; it proves the stage
    // guard is enforced independently of whatever cleared the question in the ordinary flows.
    const service = serviceFor(world);
    await service.pause(task.id, "operator paused the scenario");
    await expect(service.answer({ taskId: task.id, questionId, text: "yes" })).rejects.toThrow(
      "no longer waiting on you",
    );
    await service.shutdown();
  });
});

/**
 * The anti-loop enforcement this file's earlier tests assume: a scripted verification lens that
 * asks needs-decision twice in a row, with no `handToUser`, for the same reviewed HEAD and
 * generation. The first ask blocks normally (the coordinator answers it); the second, from the
 * exact same lens, is recognized as the loop issue #84 reported and is handed to the user instead
 * of blocking again — entirely through `WorkerWorkflow.consumeWorkerResult`'s real code path, driven
 * by `service.tick()`, not a shortcut.
 */
test("a verifier that asks needs-decision twice without handToUser still ends in exactly one user-check question", async () => {
  await withScenario({}, async (world) => {
    let notificationSequence = 0;
    const context = (): { now: string; notificationId: string } => {
      notificationSequence += 1;
      return { now: world.clock(), notificationId: `anti-loop-${notificationSequence}` };
    };

    const created = await world.store.create({
      id: SCENARIO_TASK_ID,
      repoPath: world.repoPath,
      kind: "implementation",
      objective: "Add a streak bar to the habit screen",
      acceptanceCriteria: [UNTESTABLE_CRITERION],
      surfaces: ["app"],
      policy: VALIDATING_POLICY,
    });
    let task = await world.store.update(created.id, created.revision, (current) =>
      transitionTask(current, { type: "approve" }, context()),
    );
    const lease = await world.grantLease({ name: "scenario-task", holder: "scenario-holder" });
    const implementerEndpoint = {
      ...world.openPane({ paneId: "pane-implementer", cwd: lease.path }),
      role: "implementer" as const,
    };
    task = await world.store.update(task.id, task.revision, (current) =>
      transitionTask(
        current,
        { type: "start", worktree: lease, endpoints: [implementerEndpoint] },
        context(),
      ),
    );
    task = await world.store.update(task.id, task.revision, (current) =>
      transitionTask(
        current,
        { type: "implementation-complete", head: SCENARIO_HEAD, generation: current.generation },
        context(),
      ),
    );
    task = await world.store.update(task.id, task.revision, (current) =>
      transitionTask(
        current,
        {
          type: "validation-succeeded",
          head: SCENARIO_HEAD,
          generation: current.generation,
          contract: "final",
          policyDigest,
          evidence: [evidence(SCENARIO_HEAD)],
        },
        context(),
      ),
    );
    for (const lens of ["behavior", "design", "coverage"] as const) {
      task = await world.store.update(task.id, task.revision, (current) =>
        transitionTask(
          current,
          { type: "record-review", review: passingReview(lens, SCENARIO_HEAD) },
          context(),
        ),
      );
    }

    // The last required lens (verification) is an active, running job about to ask needs-decision
    // for the first time.
    const verifierEndpoint = {
      ...world.openPane({ paneId: "pane-verifier", cwd: lease.path }),
      role: "verifier" as const,
    };
    const firstJob = {
      ...scenarioJob({
        home: world.home,
        role: "verifier",
        cwd: lease.path,
        endpoint: verifierEndpoint,
      }),
      head: SCENARIO_HEAD,
      reviewLens: "verification" as const,
    };
    await seedScenarioRuntime(
      world,
      scenarioRuntimeTask({
        worktree: lease,
        // The implementer endpoint is the runtime's writer; it stays present through review rounds
        // in production, and advanceReview's relaunch path (currentWriter) requires one to proceed.
        endpoints: [implementerEndpoint, verifierEndpoint],
        jobs: [firstJob],
        operation: scenarioOperation(firstJob),
        reservation: scenarioReservation(),
      }),
    );
    const service = createTandemService({
      home: world.home,
      sessionId: world.sessionId,
      poolRoot: world.poolRoot,
      run: world.run,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    try {
      await persistWorkerResult(firstJob.resultPath, {
        id: firstJob.id,
        taskId: task.id,
        generation: firstJob.generation,
        role: "verifier",
        status: "needs-decision",
        text: "Cannot confirm the exact layout matches the design from the diff alone.",
        question: { text: "Does the final layout match the approved design exactly?" },
        finishedAt: world.clock(),
      });

      await service.tick();
      const blocked = await service.get(task.id);
      expect(blocked.stage).toBe("blocked");
      expect(blocked.stuckReviewLenses).toEqual(["verification"]);
      const firstQuestionId = blocked.communication?.question?.id;
      if (firstQuestionId === undefined) throw new Error("first needs-decision question missing");

      await service.answer({
        taskId: task.id,
        questionId: firstQuestionId,
        text: "Close enough to the mock; proceed.",
      });

      // Answering resumed the task, and reconciling relaunches the still-missing verification lens
      // as a fresh job; find it to drive the second, looping ask.
      let secondJobId: string | undefined;
      let secondResultPath: string | undefined;
      let secondJobPath: string | undefined;
      let secondInstructionRevision: number | undefined;
      let secondEndpoint: Endpoint | undefined;
      for (let attempt = 0; attempt < 5 && secondJobId === undefined; attempt += 1) {
        await service.tick();
        const runtime = await readRuntimeState(runtimeFile(world.home));
        const runtimeTask = runtime.tasks.find((entry) => entry.taskId === task.id);
        const activeJob = runtimeTask?.jobs.find(
          (entry) => entry.reviewLens === "verification" && entry.id !== firstJob.id,
        );
        if (activeJob !== undefined) {
          secondJobId = activeJob.id;
          secondResultPath = activeJob.resultPath;
          secondJobPath = activeJob.jobPath;
          secondInstructionRevision = activeJob.instructionRevision;
          secondEndpoint = activeJob.endpoint;
        }
      }
      if (
        secondJobId === undefined ||
        secondResultPath === undefined ||
        secondJobPath === undefined
      ) {
        throw new Error("verification was never relaunched after the first answer");
      }

      // The relaunched lens now "finishes": its pane goes quiet, and it proves it applied the
      // current canonical instruction, before its durable result lands — the same way central
      // recovery's own relaunch test simulates completion.
      if (secondEndpoint !== undefined) {
        await interruptEndpoint(world.run, { endpoint: secondEndpoint, cwd: lease.path });
      }
      await writeWorkerReceipt(workerReceiptPath(secondJobPath), {
        schemaVersion: 1,
        jobId: secondJobId,
        taskId: task.id,
        generation: 0,
        receivedRevision: secondInstructionRevision ?? 0,
        appliedRevision: secondInstructionRevision ?? 0,
        heartbeatAt: world.clock(),
        progressAt: world.clock(),
        phase: "finished",
      });

      const beforeSecondAsk = await service.get(task.id);
      await persistWorkerResult(secondResultPath, {
        id: secondJobId,
        taskId: task.id,
        generation: beforeSecondAsk.generation,
        role: "verifier",
        status: "needs-decision",
        instructionRevision: secondInstructionRevision ?? 0,
        text: "Still cannot confirm the exact layout from the diff alone.",
        question: { text: "Does the final layout match the approved design exactly?" },
        finishedAt: world.clock(),
      });

      await service.tick();
      const handedOff = await service.get(task.id);
      expect(handedOff.stage).not.toBe("blocked");
      expect(handedOff.acceptanceCriteria).not.toContain(UNTESTABLE_CRITERION);
      expect(handedOff.userCheckCriteria).toEqual([UNTESTABLE_CRITERION]);
      const verificationReview = handedOff.reviews.find(
        (review) =>
          review.lens === "verification" &&
          review.head === SCENARIO_HEAD &&
          review.generation === handedOff.generation,
      );
      expect(verificationReview?.pass).toBe(true);
      expect(verificationReview?.handToUser).toEqual([UNTESTABLE_CRITERION]);

      // Reconciling once more reaches `ready` and asks the one user-check question the criterion was
      // handed off for — never a second needs-decision from the same lens.
      let ready: TaskRecord | undefined;
      for (let attempt = 0; attempt < 5 && ready === undefined; attempt += 1) {
        await service.tick();
        const current = await service.get(task.id);
        if (current.stage === "ready") ready = current;
      }
      if (ready === undefined) throw new Error("task never reached ready after the hand-off");
      const question = ready.communication?.question;
      expect(question?.id.startsWith("user-check-")).toBe(true);
      expect(question?.id).toBe(userCheckQuestionId(ready.generation, ready.reviewHead ?? ""));
      expect(
        ready.notifications.filter((entry) => entry.message.includes("needs a decision")),
      ).toHaveLength(1);
    } finally {
      await service.shutdown();
    }
  });
});
