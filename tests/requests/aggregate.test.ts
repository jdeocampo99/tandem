import { expect, test } from "bun:test";
import type { RequestDeliveryRecord } from "../../src/contracts.ts";
import {
  admitRequestMember,
  createRequestDeliveryRecord,
  decideRequestConflict,
  quarantineOutdatedRelations,
  type RequestMemberTask,
  recordRequestConflict,
  recordRequestDependency,
  requestDispatchHold,
  summarizeRequestProgress,
} from "../../src/requests/aggregate.ts";

const NOW = "2030-01-01T00:00:00.000Z";
const REQUEST_ID = "req-1";
const AGREEMENT = "agreement-digest-1";

function memberTask(overrides: Partial<RequestMemberTask> = {}): RequestMemberTask {
  return {
    id: "task-1",
    kind: "implementation",
    stage: "queued",
    surfaces: ["api"],
    requestId: REQUEST_ID,
    ...overrides,
  };
}

function requestWith(tasks: readonly RequestMemberTask[]): RequestDeliveryRecord {
  let record = createRequestDeliveryRecord({ id: REQUEST_ID, repoPath: "/repo" }, NOW);
  for (const task of tasks) {
    record = admitRequestMember(
      record,
      { task, briefRevision: 1, agreementDigest: AGREEMENT, approvalState: "current" },
      NOW,
    );
  }
  return record;
}

function summarize(
  record: RequestDeliveryRecord,
  tasks: readonly RequestMemberTask[],
): ReturnType<typeof summarizeRequestProgress> {
  return summarizeRequestProgress({
    record,
    approvalState: "current",
    approvedBriefRevision: 1,
    tasks,
  });
}

test("admitting the same task twice under the same agreement does not duplicate membership", () => {
  const task = memberTask();
  const record = requestWith([task]);
  const again = admitRequestMember(
    record,
    { task, briefRevision: 1, agreementDigest: AGREEMENT, approvalState: "current" },
    NOW,
  );

  expect(again).toBe(record);
  expect(record.members).toHaveLength(1);
});

test("a task admitted under a different brief agreement is refused rather than re-pinned", () => {
  const task = memberTask();
  const record = requestWith([task]);

  expect(() =>
    admitRequestMember(
      record,
      { task, briefRevision: 2, agreementDigest: "other", approvalState: "current" },
      NOW,
    ),
  ).toThrow(/already admitted/u);
});

test("admission is refused while the request brief approval is not current", () => {
  const record = createRequestDeliveryRecord({ id: REQUEST_ID, repoPath: "/repo" }, NOW);

  expect(() =>
    admitRequestMember(
      record,
      {
        task: memberTask(),
        briefRevision: 1,
        agreementDigest: AGREEMENT,
        approvalState: "superseded",
      },
      NOW,
    ),
  ).toThrow(/no current brief approval/u);
});

test("a dependent member waits while its dependency is unfinished and runs once it is ready", () => {
  const first = memberTask({ id: "task-1", surfaces: ["api"] });
  const second = memberTask({ id: "task-2", surfaces: ["ui"] });
  const record = recordRequestDependency(
    requestWith([first, second]),
    { taskId: "task-2", dependsOn: "task-1", reason: "needs the new endpoint", briefRevision: 1 },
    NOW,
  );

  const waiting = summarize(record, [first, second]);
  expect(waiting.dispatchableTaskIds).toEqual(["task-1"]);
  expect(waiting.waiting).toEqual([
    { taskId: "task-2", waitingFor: ["task-1"], reason: "waiting for task-1 to finish" },
  ]);
  expect(requestDispatchHold(waiting, "task-2")).toContain("waiting for task-1");
  expect(requestDispatchHold(waiting, "task-1")).toBeUndefined();

  const released = summarize(record, [{ ...first, stage: "ready", reviewHead: "head-1" }, second]);
  expect(released.dispatchableTaskIds).toEqual(["task-2"]);
  expect(released.waiting).toEqual([]);
});

test("unfinished members that share a surface are serialized behind the first admitted one", () => {
  const first = memberTask({ id: "task-1", surfaces: ["api", "docs"] });
  const second = memberTask({ id: "task-2", surfaces: ["docs"] });
  const aggregate = summarize(requestWith([first, second]), [first, second]);

  expect(aggregate.dispatchableTaskIds).toEqual(["task-1"]);
  expect(aggregate.waiting[0]?.reason).toBe("serialized behind task-1 on shared surfaces");
});

test("an unresolved conflict holds its members and asks for a decision until one is recorded", () => {
  const first = memberTask({ id: "task-1", stage: "ready", reviewHead: "head-1" });
  const second = memberTask({ id: "task-2", surfaces: ["ui"], stage: "implementing" });
  const record = recordRequestConflict(
    requestWith([first, second]),
    {
      id: "conflict-1",
      taskIds: ["task-1", "task-2"],
      reason: "both rewrite the same handler",
      briefRevision: 1,
    },
    NOW,
  );

  const disputed = summarize(record, [first, second]);
  expect(disputed.decisions).toHaveLength(1);
  expect(disputed.decisions[0]?.detail).toContain("both rewrite the same handler");
  expect(disputed.dispatchableTaskIds).toEqual([]);
  expect(disputed.readyToIntegrate).toBe(false);

  const decided = summarize(
    decideRequestConflict(record, "conflict-1", "keep task-1's handler", NOW),
    [first, second],
  );
  expect(decided.decisions).toEqual([]);
});

test("a ready subset never completes the request while another member is unfinished", () => {
  const ready = memberTask({ id: "task-1", stage: "ready", reviewHead: "head-1" });
  const running = memberTask({ id: "task-2", surfaces: ["ui"], stage: "implementing" });
  const aggregate = summarize(requestWith([ready, running]), [ready, running]);

  expect(aggregate.completedTaskIds).toEqual(["task-1"]);
  expect(aggregate.readyToIntegrate).toBe(false);
  expect(aggregate.delivered).toBe(false);
  expect(aggregate.incompleteReasons).toContain("1 member(s) are still running");
});

test("an ordinary blocker on one member leaves independent members dispatchable", () => {
  const blocked = memberTask({ id: "task-1", stage: "blocked", blockReason: "worker exited" });
  const independent = memberTask({ id: "task-2", surfaces: ["ui"] });
  const aggregate = summarize(requestWith([blocked, independent]), [blocked, independent]);

  expect(aggregate.blockers).toEqual([{ taskId: "task-1", reason: "worker exited" }]);
  expect(aggregate.dispatchableTaskIds).toEqual(["task-2"]);
  expect(aggregate.incompleteReasons).toContain("task-1 is blocked: worker exited");
});

test("a dependency edge that contradicts the recorded order is quarantined for a decision", () => {
  const first = memberTask({ id: "task-1" });
  const second = memberTask({ id: "task-2", surfaces: ["ui"] });
  const forward = recordRequestDependency(
    requestWith([first, second]),
    { taskId: "task-2", dependsOn: "task-1", reason: "needs the endpoint", briefRevision: 1 },
    NOW,
  );
  const cyclic = recordRequestDependency(
    forward,
    { taskId: "task-1", dependsOn: "task-2", reason: "needs the screen", briefRevision: 1 },
    NOW,
  );

  const quarantined = cyclic.dependencies.filter((entry) => entry.status === "quarantined");
  expect(quarantined).toHaveLength(1);
  expect(quarantined[0]?.quarantineReason).toContain("contradictory");
  expect(summarize(cyclic, [first, second]).decisions[0]?.detail).toContain("quarantined");
});

test("membership outgrown by durable task state is quarantined and stays visible", () => {
  const cancelled = memberTask({ id: "task-1", stage: "cancelled" });
  const record = quarantineOutdatedRelations(
    requestWith([cancelled, memberTask({ id: "task-2", surfaces: ["ui"] })]),
    {
      tasks: [cancelled, memberTask({ id: "task-2", surfaces: ["ui"] })],
      approvedBriefRevision: 1,
      approvedAgreementDigest: AGREEMENT,
    },
    NOW,
  );

  expect(record.members).toHaveLength(2);
  expect(record.members[0]?.status).toBe("quarantined");
  expect(record.members[0]?.quarantineReason).toContain("cancelled");
});

test("a member admitted under a superseded agreement is quarantined rather than re-pinned", () => {
  const task = memberTask({ id: "task-1" });
  const record = quarantineOutdatedRelations(
    requestWith([task]),
    {
      tasks: [task],
      approvedBriefRevision: 2,
      approvedAgreementDigest: "agreement-digest-2",
    },
    NOW,
  );

  expect(record.members[0]?.status).toBe("quarantined");
  expect(record.members[0]?.quarantineReason).toContain("not the approved agreement");
});

test("integration order places every dependency before the member that waits on it", () => {
  const first = memberTask({ id: "task-1", stage: "ready", reviewHead: "head-1" });
  const second = memberTask({
    id: "task-2",
    surfaces: ["ui"],
    stage: "ready",
    reviewHead: "head-2",
  });
  const record = recordRequestDependency(
    requestWith([second, first]),
    { taskId: "task-2", dependsOn: "task-1", reason: "needs the endpoint", briefRevision: 1 },
    NOW,
  );

  const aggregate = summarize(record, [first, second]);
  expect(aggregate.integrationOrder).toEqual(["task-1", "task-2"]);
  expect(aggregate.readyToIntegrate).toBe(true);
  expect(aggregate.delivered).toBe(false);
});

test("a superseded brief holds every member and asks for reapproval", () => {
  const task = memberTask({ id: "task-1" });
  const aggregate = summarizeRequestProgress({
    record: requestWith([task]),
    approvalState: "superseded",
    approvedBriefRevision: 1,
    tasks: [task],
  });

  expect(aggregate.decisions[0]?.detail).toContain("needs reapproval");
  expect(requestDispatchHold(aggregate, "task-1")).toContain("superseded");
});
