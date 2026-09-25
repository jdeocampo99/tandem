import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRequestUsageReceipt,
  renderRequestReceiptTable,
} from "../../src/runtime/usage-receipt.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import type { SessionEffect } from "../../src/session/events.ts";
import {
  deliverPendingNotifications,
  deliverPrWatchNotices,
} from "../../src/session/notifications.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { StoreLockTimeoutError } from "../../src/tasks/store-errors.ts";
import { recordingSessionHost } from "../evals/scenario.ts";
import { policy, task } from "./fixtures.ts";

type Delivery = Extract<SessionEffect, { type: "deliver" }>;

/** Notification tests that deliver no request receipt. */
async function noReceipt(): Promise<never> {
  throw new Error("no receipt in this test");
}

function deliveries(effects: readonly SessionEffect[]): readonly Delivery[] {
  return effects.filter((effect): effect is Delivery => effect.type === "deliver");
}

function notices(effects: readonly SessionEffect[]): readonly string[] {
  return effects.flatMap((effect) => (effect.type === "notify" ? [effect.text] : []));
}

function entries(effects: readonly SessionEffect[]): readonly SessionEffect[] {
  return effects.filter((effect) => effect.type === "recordEntry");
}

function recordingAcknowledgements(
  acknowledged: string[],
): Pick<TandemService, "acknowledge" | "requestReceipt"> {
  return {
    requestReceipt: noReceipt,
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
}

test("a delivered request shows its receipt table without a coordinator turn", async () => {
  const receipt = buildRequestUsageReceipt("req-1", { events: [], malformedEvents: 0 });
  const table = renderRequestReceiptTable(receipt);
  const { host, effects } = recordingSessionHost();
  const acknowledged: string[] = [];
  let receiptReadable = true;
  const service: Pick<TandemService, "acknowledge" | "requestReceipt"> = {
    requestReceipt: async (requestId) => {
      if (!receiptReadable) throw new Error("ledger unavailable");
      expect(requestId).toBe("req-1");
      return receipt;
    },
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const delivered = task({
    id: "task-delivered",
    stage: "completed",
    requestId: "req-1",
    notifications: [
      {
        id: "receipt-1",
        message: "The request is delivered. Where its time and tokens went:",
        acknowledged: false,
        kind: "receipt",
      },
    ],
  });
  const deliver = (): Promise<void> =>
    deliverPendingNotifications({
      host,
      service,
      tasks: [delivered],
      delivered: new Set<string>(),
      unacknowledged: new Set<string>(),
      readReport: async () => undefined,
    });

  await deliver();
  expect(deliveries(effects)).toEqual([]);
  expect(notices(effects)).toEqual([
    `[task-delivered] The request is delivered. Where its time and tokens went:\n${table}`,
  ]);
  expect(acknowledged).toEqual(["task-delivered:receipt-1"]);

  receiptReadable = false;
  await deliver();
  expect(deliveries(effects)).toEqual([]);
  expect(notices(effects)[1]).toContain("Its receipt could not be read yet");
  expect(notices(effects)[1]).not.toContain("Stage");
});

test("ready and bounded-loop-exhausted outcomes wake the coordinator as distinct messages", async () => {
  const { host, effects } = recordingSessionHost();
  const acknowledged: string[] = [];
  const readyTask = task({
    id: "task-ready",
    stage: "ready",
    notifications: [
      {
        id: "ready-1",
        message:
          "Ready: task task-ready passed review at the standard review level and the final acceptance manifest at HEAD head-1. Ready is not publication, merge, or deploy approval; each remains explicit.",
        acknowledged: false,
        kind: "coordinator",
      },
    ],
  });
  const exhausted = transitionTask(
    task({ id: "task-exhausted", stage: "awaiting-fixes", reviewRound: 3 }),
    {
      type: "block",
      reason:
        "bounded review loop exhausted after 3 of 3 fix round(s); no new fix operation was admitted and the task is not ready or accepted",
    },
    { now: "2030-01-02T03:04:06.000Z", notificationId: "exhausted-1" },
  );

  await deliverPendingNotifications({
    host,
    service: recordingAcknowledgements(acknowledged),
    tasks: [readyTask, exhausted],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    readReport: async () => "Findings.",
  });

  const sent = deliveries(effects);
  expect(sent).toHaveLength(1);
  const identifiers = sent[0]?.hidden?.text ?? "";
  const content = sent[0]?.text ?? "";
  expect(identifiers).toContain("task task-ready");
  expect(identifiers).toContain("task task-exhausted");
  expect(content).not.toContain("[task-ready]");
  expect(content).not.toContain("[task-exhausted]");
  expect(content).toContain("Ready: task task-ready passed");
  expect(content).toContain("Ready is not publication, merge, or deploy approval");
  expect(content).toContain("Task task-exhausted blocked: bounded review loop");
  expect(content).toContain("the task is not ready or accepted");
  expect(sent[0]).toMatchObject({ timing: "followUp", triggerTurn: true });
  expect(acknowledged.sort()).toEqual(["task-exhausted:exhausted-1", "task-ready:ready-1"]);
});

test("a failed acknowledgement retries on the next tick without waking the coordinator again", async () => {
  const { host, effects } = recordingSessionHost();
  const acknowledged: string[] = [];
  let acknowledgementsFail = true;
  const service: Pick<TandemService, "acknowledge" | "requestReceipt"> = {
    requestReceipt: noReceipt,
    acknowledge: async (taskId, notificationId) => {
      if (acknowledgementsFail) {
        throw new StoreLockTimeoutError("/tmp/tandem/home", 5_000);
      }
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const blocked = transitionTask(
    task({ stage: "implementing" }),
    { type: "block", reason: "worktree allocation failed before worker launch" },
    { now: "2030-01-02T03:04:06.000Z", notificationId: "blocked-notification" },
  );
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();
  const deliver = async (): Promise<void> =>
    deliverPendingNotifications({
      host,
      service,
      tasks: [blocked],
      delivered,
      unacknowledged: unacknowledgedKeys,
      readReport: async () => "Findings.",
    });

  // The wake reaches the coordinator, then the acknowledgement loses the state-lock race.
  await deliver();
  expect(deliveries(effects)).toHaveLength(1);
  expect(acknowledged).toHaveLength(0);
  expect(unacknowledgedKeys.has("task-1:blocked-notification")).toBe(true);

  // Later ticks over the same still-unacknowledged record must not send the wake a second time.
  await deliver();
  await deliver();
  expect(deliveries(effects)).toHaveLength(1);

  // Once the lock is free the acknowledgement lands, exactly once, with no further wake.
  acknowledgementsFail = false;
  await deliver();
  expect(deliveries(effects)).toHaveLength(1);
  expect(acknowledged).toEqual(["task-1:blocked-notification"]);
  expect(unacknowledgedKeys.size).toBe(0);

  await deliver();
  expect(acknowledged).toEqual(["task-1:blocked-notification"]);
});

test("a failed send forgets the batch so the next tick delivers it again", async () => {
  const { host, effects, failNext } = recordingSessionHost();
  const acknowledged: string[] = [];
  const blocked = transitionTask(
    task({ stage: "implementing" }),
    { type: "block", reason: "worktree allocation failed before worker launch" },
    { now: "2030-01-02T03:04:06.000Z", notificationId: "blocked-notification" },
  );
  const delivered = new Set<string>();
  const unacknowledged = new Set<string>();
  const deliver = (): Promise<void> =>
    deliverPendingNotifications({
      host,
      service: recordingAcknowledgements(acknowledged),
      tasks: [blocked],
      delivered,
      unacknowledged,
      readReport: async () => "Findings.",
    });

  failNext("deliver");
  await expect(deliver()).rejects.toThrow("scripted deliver failure");
  expect(delivered.size).toBe(0);
  expect(unacknowledged.size).toBe(0);
  expect(acknowledged).toEqual([]);

  await deliver();
  expect(deliveries(effects)).toHaveLength(2);
  expect(deliveries(effects)[1]?.text).toContain("worktree allocation failed");
  expect(acknowledged).toEqual(["task-1:blocked-notification"]);
});

test("fresh block transitions wake the coordinator once through the bridge", async () => {
  const { host, effects } = recordingSessionHost();
  const acknowledged: string[] = [];
  const blocked = transitionTask(
    task({
      stage: "implementing",
      reportPath: "/tmp/tandem/task-1/report.txt",
      communication: {
        revision: 2,
        messages: [],
        question: {
          id: "question-1",
          text: "Should the existing API remain unchanged?",
          recommendation: "Keep the existing API unchanged.",
        },
      },
    }),
    { type: "block", reason: "worktree allocation failed before worker launch" },
    { now: "2030-01-02T03:04:06.000Z", notificationId: "blocked-notification" },
  );
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();
  const deliver = (): Promise<void> =>
    deliverPendingNotifications({
      host,
      service: recordingAcknowledgements(acknowledged),
      tasks: [blocked],
      delivered,
      unacknowledged: unacknowledgedKeys,
      readReport: async () => "Findings.",
    });

  await deliver();
  await deliver();

  expect(blocked.stage).toBe("blocked");
  expect(blocked.notifications.at(-1)?.kind).toBe("coordinator");
  const sent = deliveries(effects);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.hidden?.text).toContain("task task-1");
  expect(sent[0]?.hidden?.text).toContain("question question-1");
  expect(sent[0]?.text).not.toContain("[task-1]");
  expect(sent[0]?.text).not.toContain("question-1");
  expect(sent[0]?.text).toContain("worktree allocation failed before worker launch");
  expect(sent[0]?.text).toContain("Should the existing API remain unchanged?");
  expect(sent[0]?.text).toContain("Recommendation: Keep the existing API unchanged.");
  expect(sent[0]?.text).toContain("Evidence report: /tmp/tandem/task-1/report.txt");
  expect(sent[0]?.triggerTurn).toBe(true);
  expect(notices(effects)).toHaveLength(0);
  expect(acknowledged).toEqual(["task-1:blocked-notification"]);
});

test("scout report completion wakes once, survives durable reconnect, and retries failed delivery", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-extension-scout-"));
  const now = "2030-01-02T03:04:06.000Z";
  const clock = () => now;
  const store = createTaskStore({
    directory: join(home, "tasks"),
    clock,
    idFactory: () => "store-id",
  });
  try {
    let scouting = await store.create({
      id: "scout-task",
      repoPath: join(home, "repo"),
      kind: "scout",
      objective: "Collect the requested evidence.",
      acceptanceCriteria: ["Report the evidence."],
      surfaces: ["repository"],
      policy,
    });
    scouting = await store.update(scouting.id, scouting.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      stage: "scouting",
      updatedAt: now,
    }));
    const completed = await store.update(scouting.id, scouting.revision, (current) =>
      transitionTask(
        current,
        {
          type: "scout-report-complete",
          generation: current.generation,
          reportPath: "/tmp/tandem/scout-report.txt",
        },
        { now, notificationId: "scout-complete" },
      ),
    );
    expect(completed.stage).toBe("completed");
    expect(completed.notifications.at(-1)?.id).toBe("scout-complete");
    expect(completed.notifications.at(-1)?.kind).toBe("coordinator");

    const { host, effects, failNext } = recordingSessionHost();
    const delivered = new Set<string>();
    const unacknowledgedKeys = new Set<string>();
    const service = createTandemService({
      home,
      sessionId: "extension-scout-session",
      clock,
      idFactory: () => "service-id",
    });
    try {
      for (let tick = 0; tick < 2; tick += 1) {
        await deliverPendingNotifications({
          host,
          service,
          tasks: [completed],
          delivered,
          unacknowledged: unacknowledgedKeys,
          readReport: async () => "Findings.",
        });
      }
      const sent = deliveries(effects);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.hidden?.text).toContain("task scout-task");
      expect(sent[0]?.text).toContain("/tmp/tandem/scout-report.txt");
      expect(sent[0]).toMatchObject({ timing: "followUp", triggerTurn: true });
      expect(notices(effects)).toHaveLength(0);
    } finally {
      await service.shutdown();
    }

    const reopened = createTandemService({
      home,
      sessionId: "extension-scout-reconnected",
      clock,
      idFactory: () => "reconnected-id",
    });
    try {
      const persisted = await reopened.get("scout-task");
      expect(persisted.notifications.at(-1)?.acknowledged).toBe(true);
      await deliverPendingNotifications({
        host,
        service: reopened,
        tasks: [persisted],
        delivered: new Set<string>(),
        unacknowledged: new Set<string>(),
        readReport: async () => "Findings.",
      });
      expect(deliveries(effects)).toHaveLength(1);

      let retryScouting = await store.create({
        id: "scout-retry",
        repoPath: join(home, "repo"),
        kind: "scout",
        objective: "Retry the requested evidence.",
        acceptanceCriteria: ["Report the evidence."],
        surfaces: ["repository"],
        policy,
      });
      retryScouting = await store.update(retryScouting.id, retryScouting.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        stage: "scouting",
        updatedAt: now,
      }));
      const retryTask = await store.update(retryScouting.id, retryScouting.revision, (current) =>
        transitionTask(
          current,
          {
            type: "scout-report-complete",
            generation: current.generation,
            reportPath: "/tmp/tandem/scout-retry-report.txt",
          },
          { now, notificationId: "scout-retry" },
        ),
      );
      const retryDelivered = new Set<string>();
      const retryUnacknowledged = new Set<string>();
      failNext("deliver");
      await expect(
        deliverPendingNotifications({
          host,
          service: reopened,
          tasks: [retryTask],
          delivered: retryDelivered,
          unacknowledged: retryUnacknowledged,
          readReport: async () => "Findings.",
        }),
      ).rejects.toThrow("scripted deliver failure");
      const pendingRetry = await reopened.get("scout-retry");
      expect(pendingRetry.notifications.at(-1)?.id).toBe("scout-retry");
      expect(pendingRetry.notifications.at(-1)?.acknowledged).toBe(false);
      await deliverPendingNotifications({
        host,
        service: reopened,
        tasks: [pendingRetry],
        delivered: retryDelivered,
        unacknowledged: retryUnacknowledged,
        readReport: async () => "Findings.",
      });
      const retried = deliveries(effects).slice(1);
      expect(retried).toHaveLength(2);
      expect(retried[1]?.text).toContain("/tmp/tandem/scout-retry-report.txt");
      expect((await reopened.get("scout-retry")).notifications.at(-1)?.acknowledged).toBe(true);
    } finally {
      await reopened.shutdown();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("automatic review-fix handoffs stay visible without waking the coordinator", async () => {
  const { host, effects } = recordingSessionHost();
  const acknowledged: string[] = [];
  const routine = task({
    stage: "awaiting-fixes",
    notifications: [
      {
        id: "routine-1",
        message: "Review findings queued for the original implementer.",
        acknowledged: false,
      },
    ],
  });
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();

  for (let tick = 0; tick < 2; tick += 1) {
    await deliverPendingNotifications({
      host,
      service: recordingAcknowledgements(acknowledged),
      tasks: [routine],
      delivered,
      unacknowledged: unacknowledgedKeys,
      readReport: async () => "Findings.",
    });
  }

  expect(deliveries(effects)).toHaveLength(0);
  expect(notices(effects)).toHaveLength(1);
  expect(entries(effects)).toHaveLength(1);
  expect(acknowledged).toEqual(["task-1:routine-1"]);
});

test("actionable notifications coalesce one wake across tasks and exclude routine backlog", async () => {
  const { host, effects } = recordingSessionHost();
  const acknowledged: string[] = [];
  const service = recordingAcknowledgements(acknowledged);
  const scout = task({
    kind: "scout",
    stage: "completed",
    notifications: [
      { id: "scout-old", message: "Earlier scout evidence.", acknowledged: false },
      { id: "scout-latest", message: "Latest scout report needs review.", acknowledged: false },
    ],
  });
  const blocked = task({
    id: "blocked",
    stage: "blocked",
    notifications: [
      { id: "blocked-latest", message: "Owner decision required.", acknowledged: false },
    ],
  });
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();

  for (let tick = 0; tick < 2; tick += 1) {
    await deliverPendingNotifications({
      host,
      service,
      tasks: [scout, blocked],
      delivered,
      unacknowledged: unacknowledgedKeys,
      readReport: async () => "Findings.",
    });
  }

  const sent = deliveries(effects);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.hidden?.text).toContain("task task-1");
  expect(sent[0]?.hidden?.text).toContain("task blocked");
  expect(sent[0]?.text).toContain("Latest scout report needs review.");
  expect(sent[0]?.text).toContain("Owner decision required.");
  expect(sent[0]?.text).not.toContain("Earlier scout evidence.");
  expect(notices(effects).join("\n")).toContain("Earlier scout evidence.");
  expect(entries(effects)).toHaveLength(1);
  expect(acknowledged).toHaveLength(3);
  expect(new Set(acknowledged)).toEqual(
    new Set(["task-1:scout-old", "task-1:scout-latest", "blocked:blocked-latest"]),
  );

  const recovered = task({
    ...scout,
    notifications: scout.notifications.map((notification) => ({
      ...notification,
      acknowledged: notification.id === "scout-latest",
    })),
  });
  await deliverPendingNotifications({
    host,
    service,
    tasks: [recovered],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    readReport: async () => "Findings.",
  });
  expect(deliveries(effects)).toHaveLength(1);
  expect(acknowledged).toHaveLength(4);
  expect(acknowledged.filter((value) => value === "task-1:scout-old")).toHaveLength(2);
});

test("notification kind controls whether presentation bookkeeping wakes the coordinator", async () => {
  const { host, effects } = recordingSessionHost();
  const acknowledged: string[] = [];
  const routine = task({
    stage: "blocked",
    notifications: [
      {
        id: "presentation-ready",
        message: "Presentation presentation-1 is ready.",
        acknowledged: false,
        kind: "routine",
      },
    ],
  });
  const coordinator = task({
    id: "task-coordinator",
    stage: "ready",
    notifications: [
      {
        id: "presentation-feedback",
        message: "Presentation presentation-1 received feedback:\nChoose a direction.",
        acknowledged: false,
        kind: "coordinator",
      },
    ],
  });
  await deliverPendingNotifications({
    host,
    service: recordingAcknowledgements(acknowledged),
    tasks: [routine, coordinator],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    readReport: async () => "Findings.",
  });
  const sent = deliveries(effects);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.hidden?.text).toContain("task task-coordinator");
  expect(sent[0]?.text).not.toContain("[task-coordinator]");
  expect(sent[0]?.text).toContain("Presentation presentation-1 received feedback");
  expect(notices(effects)).toHaveLength(1);
  expect(notices(effects)[0]).toContain("[task-1]");
  expect(acknowledged).toHaveLength(2);
});

test("legacy scout recovery survives a later routine presentation notice", async () => {
  const { host, effects } = recordingSessionHost();
  const acknowledged: string[] = [];
  const service = recordingAcknowledgements(acknowledged);
  const recovered = task({
    kind: "scout",
    stage: "completed",
    notifications: [
      {
        id: "legacy-report",
        message: "Legacy scout report requires coordinator review.",
        acknowledged: false,
      },
      {
        id: "routine-presentation",
        message: "Presentation presentation-1 is ready.",
        acknowledged: false,
        kind: "routine",
      },
    ],
  });

  await deliverPendingNotifications({
    host,
    service,
    tasks: [recovered],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    readReport: async () => "Findings.",
  });

  expect(deliveries(effects)).toHaveLength(1);
  expect(deliveries(effects)[0]?.text).toContain(
    "Legacy scout report requires coordinator review.",
  );
  expect(notices(effects).join("\n")).toContain("Presentation presentation-1 is ready.");
  expect(acknowledged).toEqual(["task-1:legacy-report", "task-1:routine-presentation"]);

  const routineOnly = task({
    id: "routine-only",
    stage: "blocked",
    notifications: [
      {
        id: "routine-only-notice",
        message: "Routine presentation bookkeeping.",
        acknowledged: false,
        kind: "routine",
      },
    ],
  });
  await deliverPendingNotifications({
    host,
    service,
    tasks: [routineOnly],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    readReport: async () => "Findings.",
  });

  expect(deliveries(effects)).toHaveLength(1);
});

test("a recovery question wakes the coordinator once with its recommendation and consequences", async () => {
  const { host, effects } = recordingSessionHost();
  const acknowledged: string[] = [];
  const question = {
    id: "recovery-3f2a",
    text: "Task task-1 in request req-1 is blocked: the reviewer never reported a result. Restart it?",
    recommendation: "restart: relaunches the reviewer at the exact reviewed HEAD",
  };
  const asked = task({
    id: "task-1",
    stage: "blocked",
    requestId: "req-1",
    blockReason: question.text,
    communication: { revision: 0, messages: [], question },
    notifications: [
      {
        id: "recovery-notification",
        message: question.text,
        acknowledged: false,
        kind: "coordinator",
      },
    ],
  });
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();

  for (let tick = 0; tick < 2; tick += 1) {
    await deliverPendingNotifications({
      host,
      service: recordingAcknowledgements(acknowledged),
      tasks: [asked],
      delivered,
      unacknowledged: unacknowledgedKeys,
      readReport: async () => "Findings.",
    });
  }

  const sent = deliveries(effects);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.hidden?.text).toContain("task task-1");
  expect(sent[0]?.hidden?.text).toContain("question recovery-3f2a");
  expect(sent[0]?.text).not.toContain("Question recovery-3f2a:");
  expect(sent[0]?.text).toContain("Restart it?");
  expect(sent[0]?.text).toContain("Recommendation: restart:");
  expect(sent[0]?.triggerTurn).toBe(true);
  expect(notices(effects)).toHaveLength(0);
  expect(acknowledged).toEqual(["task-1:recovery-notification"]);
});

test("PR watch notices show without a turn, and a question to fix conflicts waits for the reply", async () => {
  const recording = recordingSessionHost();
  await deliverPrWatchNotices({
    host: recording.host,
    service: {
      prWatchNotices: async () => [
        { pullRequest: "acme/app#7", text: "🎉 acme/app#7 merged" },
        {
          pullRequest: "acme/app#9",
          text: "acme/app#9 has merge conflicts in a.ts. Fix them?",
          askToFix: true,
        },
      ],
    },
  });
  expect(notices(recording.effects)).toEqual(["🎉 acme/app#7 merged"]);
  expect(deliveries(recording.effects)).toEqual([
    {
      type: "deliver",
      source: "notification",
      text: "acme/app#9 has merge conflicts in a.ts. Fix them?",
      hidden: { text: expect.stringContaining("call pr-watch-fix with pullRequest acme/app#9") },
      timing: "nextTurn",
      triggerTurn: false,
    },
  ]);
});
