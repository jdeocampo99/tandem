import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  buildRequestUsageReceipt,
  renderRequestReceiptTable,
} from "../../src/runtime/usage-receipt.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { deliverPendingNotifications } from "../../src/session/notifications.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { StoreLockTimeoutError } from "../../src/tasks/store-errors.ts";
import { policy, task } from "./fixtures.ts";

/** Notification tests that deliver no request receipt. */
async function noReceipt(): Promise<never> {
  throw new Error("no receipt in this test");
}

function notificationContext(notify: ExtensionContext["ui"]["notify"]): {
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
} {
  return { ui: { notify } };
}

function notificationSink(
  sendMessage: (content: string, options: unknown) => void,
  appendEntry: (customType: string, data?: unknown) => void,
): Pick<ExtensionAPI, "sendMessage" | "appendEntry"> {
  return {
    sendMessage: (message, options) => {
      const content =
        typeof message === "string"
          ? message
          : typeof message.content === "string"
            ? message.content
            : (JSON.stringify(message.content) ?? "");
      sendMessage(content, options);
    },
    appendEntry,
  };
}

test("a delivered request shows its receipt table without a coordinator turn", async () => {
  const receipt = buildRequestUsageReceipt("req-1", { events: [], malformedEvents: 0 });
  const table = renderRequestReceiptTable(receipt);
  const sent: string[] = [];
  const shown: string[] = [];
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
      pi: notificationSink(
        (content) => sent.push(content),
        () => undefined,
      ),
      service,
      tasks: [delivered],
      delivered: new Set<string>(),
      unacknowledged: new Set<string>(),
      ctx: notificationContext((content) => shown.push(content)),
      readReport: async () => undefined,
    });

  await deliver();
  expect(sent).toEqual([]);
  expect(shown).toEqual([
    `[task-delivered] The request is delivered. Where its time and tokens went:\n${table}`,
  ]);
  expect(acknowledged).toEqual(["task-delivered:receipt-1"]);

  receiptReadable = false;
  await deliver();
  expect(sent).toEqual([]);
  expect(shown[1]).toContain("Its receipt could not be read yet");
  expect(shown[1]).not.toContain("Stage");
});

test("ready and bounded-loop-exhausted outcomes wake the coordinator as distinct messages", async () => {
  const sent: string[] = [];
  const turns: unknown[] = [];
  const acknowledged: string[] = [];
  const service: Pick<TandemService, "acknowledge" | "requestReceipt"> = {
    requestReceipt: noReceipt,
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => {
      sent.push(content);
      turns.push(options);
    },
    () => undefined,
  );
  const context = notificationContext(() => undefined);
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
    pi: sink,
    service: service,
    tasks: [readyTask, exhausted],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    ctx: context,
    readReport: async () => "Findings.",
  });

  expect(sent).toHaveLength(2);
  const identifiers = sent[0] ?? "";
  const content = sent[1] ?? "";
  expect(identifiers).toContain("task task-ready");
  expect(identifiers).toContain("task task-exhausted");
  expect(content).not.toContain("[task-ready]");
  expect(content).not.toContain("[task-exhausted]");
  expect(content).toContain("Ready: task task-ready passed");
  expect(content).toContain("Ready is not publication, merge, or deploy approval");
  expect(content).toContain("Task task-exhausted blocked: bounded review loop");
  expect(content).toContain("the task is not ready or accepted");
  expect(turns[0]).not.toMatchObject({ triggerTurn: true });
  expect(turns[1]).toMatchObject({ triggerTurn: true });
  expect(acknowledged.sort()).toEqual(["task-exhausted:exhausted-1", "task-ready:ready-1"]);
});

test("a failed acknowledgement retries on the next tick without waking the coordinator again", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
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
  const sink = notificationSink(
    (content, options) => sent.push({ content, options }),
    () => undefined,
  );
  const context = notificationContext(() => undefined);
  const blocked = transitionTask(
    task({ stage: "implementing" }),
    { type: "block", reason: "worktree allocation failed before worker launch" },
    { now: "2030-01-02T03:04:06.000Z", notificationId: "blocked-notification" },
  );
  const delivered = new Set<string>();
  const unacknowledgedKeys = new Set<string>();
  const deliver = async (): Promise<void> =>
    deliverPendingNotifications({
      pi: sink,
      service,
      tasks: [blocked],
      delivered,
      unacknowledged: unacknowledgedKeys,
      ctx: context,
      readReport: async () => "Findings.",
    });

  // The wake reaches the coordinator (a hidden identifiers message, then the displayed prompt),
  // then the acknowledgement loses the state-lock race.
  await deliver();
  expect(sent).toHaveLength(2);
  expect(acknowledged).toHaveLength(0);
  expect(unacknowledgedKeys.has("task-1:blocked-notification")).toBe(true);

  // Later ticks over the same still-unacknowledged record must not send the wake a second time.
  await deliver();
  await deliver();
  expect(sent).toHaveLength(2);

  // Once the lock is free the acknowledgement lands, exactly once, with no further wake.
  acknowledgementsFail = false;
  await deliver();
  expect(sent).toHaveLength(2);
  expect(acknowledged).toEqual(["task-1:blocked-notification"]);
  expect(unacknowledgedKeys.size).toBe(0);

  await deliver();
  expect(acknowledged).toEqual(["task-1:blocked-notification"]);
});

test("fresh block transitions wake the coordinator once through the bridge", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  let modelTurns = 0;
  const service: Pick<TandemService, "acknowledge" | "requestReceipt"> = {
    requestReceipt: noReceipt,
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => {
      sent.push({ content, options });
      if (
        options !== null &&
        typeof options === "object" &&
        "triggerTurn" in options &&
        options.triggerTurn === true
      ) {
        modelTurns += 1;
      }
    },
    () => undefined,
  );
  const context = notificationContext((message) => notices.push(message));
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

  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [blocked],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    readReport: async () => "Findings.",
  });
  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [blocked],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    readReport: async () => "Findings.",
  });

  expect(blocked.stage).toBe("blocked");
  expect(blocked.notifications.at(-1)?.kind).toBe("coordinator");
  expect(sent).toHaveLength(2);
  expect(sent[0]?.content).toContain("task task-1");
  expect(sent[0]?.content).toContain("question question-1");
  expect(sent[1]?.content).not.toContain("[task-1]");
  expect(sent[1]?.content).not.toContain("question-1");
  expect(sent[1]?.content).toContain("worktree allocation failed before worker launch");
  expect(sent[1]?.content).toContain("Should the existing API remain unchanged?");
  expect(sent[1]?.content).toContain("Recommendation: Keep the existing API unchanged.");
  expect(sent[1]?.content).toContain("Evidence report: /tmp/tandem/task-1/report.txt");
  expect(modelTurns).toBe(1);
  expect(notices).toHaveLength(0);
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

    const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
    const notices: string[] = [];
    const sink = notificationSink(
      (content, options) => sent.push({ content, options }),
      () => undefined,
    );
    const context = notificationContext((message) => notices.push(message));
    const delivered = new Set<string>();
    const unacknowledgedKeys = new Set<string>();
    const service = createTandemService({
      home,
      sessionId: "extension-scout-session",
      clock,
      idFactory: () => "service-id",
    });
    try {
      await deliverPendingNotifications({
        pi: sink,
        service: service,
        tasks: [completed],
        delivered: delivered,
        unacknowledged: unacknowledgedKeys,
        ctx: context,
        readReport: async () => "Findings.",
      });
      await deliverPendingNotifications({
        pi: sink,
        service: service,
        tasks: [completed],
        delivered: delivered,
        unacknowledged: unacknowledgedKeys,
        ctx: context,
        readReport: async () => "Findings.",
      });
      expect(sent).toHaveLength(2);
      expect(sent[0]?.content).toContain("task scout-task");
      expect(sent[0]?.options).toEqual({ deliverAs: "followUp" });
      expect(sent[1]?.content).toContain("/tmp/tandem/scout-report.txt");
      expect(sent[1]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
      expect(notices).toHaveLength(0);
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
        pi: sink,
        service: reopened,
        tasks: [persisted],
        delivered: new Set<string>(),
        unacknowledged: new Set<string>(),
        ctx: context,
        readReport: async () => "Findings.",
      });
      expect(sent).toHaveLength(2);

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
      let failSend = true;
      const retrySent: string[] = [];
      const retrySink = notificationSink(
        (content) => {
          if (failSend) {
            failSend = false;
            throw new Error("coordinator bridge unavailable");
          }
          retrySent.push(content);
        },
        () => undefined,
      );
      const retryDelivered = new Set<string>();
      const retryUnacknowledged = new Set<string>();
      await expect(
        deliverPendingNotifications({
          pi: retrySink,
          service: reopened,
          tasks: [retryTask],
          delivered: retryDelivered,
          unacknowledged: retryUnacknowledged,
          ctx: context,
          readReport: async () => "Findings.",
        }),
      ).rejects.toThrow("coordinator bridge unavailable");
      const pendingRetry = await reopened.get("scout-retry");
      expect(pendingRetry.notifications.at(-1)?.id).toBe("scout-retry");
      expect(pendingRetry.notifications.at(-1)?.acknowledged).toBe(false);
      await deliverPendingNotifications({
        pi: retrySink,
        service: reopened,
        tasks: [pendingRetry],
        delivered: retryDelivered,
        unacknowledged: retryUnacknowledged,
        ctx: context,
        readReport: async () => "Findings.",
      });
      expect(retrySent).toHaveLength(2);
      expect(retrySent[1]).toContain("/tmp/tandem/scout-retry-report.txt");
      expect((await reopened.get("scout-retry")).notifications.at(-1)?.acknowledged).toBe(true);
    } finally {
      await reopened.shutdown();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("automatic review-fix handoffs stay visible without waking the coordinator", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const entries: Array<{ readonly type: string; readonly data: unknown }> = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  const service: Pick<TandemService, "acknowledge" | "requestReceipt"> = {
    requestReceipt: noReceipt,
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => sent.push({ content, options }),
    (type, data) => entries.push({ type, data }),
  );
  const context = notificationContext((message) => notices.push(message));
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

  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [routine],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    readReport: async () => "Findings.",
  });
  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [routine],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    readReport: async () => "Findings.",
  });

  expect(sent).toHaveLength(0);
  expect(notices).toHaveLength(1);
  expect(entries).toHaveLength(1);
  expect(acknowledged).toEqual(["task-1:routine-1"]);
});

test("actionable notifications coalesce one wake across tasks and exclude routine backlog", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const entries: Array<{ readonly type: string; readonly data: unknown }> = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  let modelTurns = 0;
  const service: Pick<TandemService, "acknowledge" | "requestReceipt"> = {
    requestReceipt: noReceipt,
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => {
      sent.push({ content, options });
      if (
        options !== null &&
        typeof options === "object" &&
        "triggerTurn" in options &&
        options.triggerTurn === true
      ) {
        modelTurns += 1;
      }
    },
    (type, data) => entries.push({ type, data }),
  );
  const context = notificationContext((message) => notices.push(message));
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

  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [scout, blocked],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    readReport: async () => "Findings.",
  });
  await deliverPendingNotifications({
    pi: sink,
    service: service,
    tasks: [scout, blocked],
    delivered: delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    readReport: async () => "Findings.",
  });

  expect(sent).toHaveLength(2);
  expect(sent[0]?.content).toContain("task task-1");
  expect(sent[0]?.content).toContain("task blocked");
  expect(sent[1]?.content).toContain("Latest scout report needs review.");
  expect(sent[1]?.content).toContain("Owner decision required.");
  expect(sent[1]?.content).not.toContain("Earlier scout evidence.");
  expect(modelTurns).toBe(1);
  expect(notices.join("\n")).toContain("Earlier scout evidence.");
  expect(entries).toHaveLength(1);
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
    pi: sink,
    service: service,
    tasks: [recovered],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    ctx: context,
    readReport: async () => "Findings.",
  });
  expect(sent).toHaveLength(2);
  expect(modelTurns).toBe(1);
  expect(acknowledged).toHaveLength(4);
  expect(acknowledged.filter((value) => value === "task-1:scout-old")).toHaveLength(2);
});

test("notification kind controls whether presentation bookkeeping wakes the coordinator", async () => {
  const sent: string[] = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  const service: Pick<TandemService, "acknowledge" | "requestReceipt"> = {
    requestReceipt: noReceipt,
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content) => sent.push(content),
    () => undefined,
  );
  const context = notificationContext((message) => notices.push(message));
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
    pi: sink,
    service: service,
    tasks: [routine, coordinator],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    ctx: context,
    readReport: async () => "Findings.",
  });
  expect(sent).toHaveLength(2);
  expect(sent[0]).toContain("task task-coordinator");
  expect(sent[1]).not.toContain("[task-coordinator]");
  expect(sent[1]).toContain("Presentation presentation-1 received feedback");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("[task-1]");
  expect(acknowledged).toHaveLength(2);
});

test("legacy scout recovery survives a later routine presentation notice", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  let modelTurns = 0;
  const service: Pick<TandemService, "acknowledge" | "requestReceipt"> = {
    requestReceipt: noReceipt,
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => {
      sent.push({ content, options });
      if (
        options !== null &&
        typeof options === "object" &&
        "triggerTurn" in options &&
        options.triggerTurn === true
      ) {
        modelTurns += 1;
      }
    },
    () => undefined,
  );
  const context = notificationContext((message) => notices.push(message));
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
    pi: sink,
    service: service,
    tasks: [recovered],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    ctx: context,
    readReport: async () => "Findings.",
  });

  expect(sent).toHaveLength(2);
  expect(sent[1]?.content).toContain("Legacy scout report requires coordinator review.");
  expect(modelTurns).toBe(1);
  expect(notices.join("\n")).toContain("Presentation presentation-1 is ready.");
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
    pi: sink,
    service: service,
    tasks: [routineOnly],
    delivered: new Set<string>(),
    unacknowledged: new Set<string>(),
    ctx: context,
    readReport: async () => "Findings.",
  });

  expect(sent).toHaveLength(2);
  expect(modelTurns).toBe(1);
});

test("a recovery question wakes the coordinator once with its recommendation and consequences", async () => {
  const sent: Array<{ readonly content: string; readonly options: unknown }> = [];
  const notices: string[] = [];
  const acknowledged: string[] = [];
  const service: Pick<TandemService, "acknowledge" | "requestReceipt"> = {
    requestReceipt: noReceipt,
    acknowledge: async (taskId, notificationId) => {
      acknowledged.push(`${taskId}:${notificationId}`);
      return task({ id: taskId });
    },
  };
  const sink = notificationSink(
    (content, options) => sent.push({ content, options }),
    () => undefined,
  );
  const context = notificationContext((message) => notices.push(message));
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

  await deliverPendingNotifications({
    pi: sink,
    service,
    tasks: [asked],
    delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    readReport: async () => "Findings.",
  });
  await deliverPendingNotifications({
    pi: sink,
    service,
    tasks: [asked],
    delivered,
    unacknowledged: unacknowledgedKeys,
    ctx: context,
    readReport: async () => "Findings.",
  });

  expect(sent).toHaveLength(2);
  expect(sent[0]?.content).toContain("task task-1");
  expect(sent[0]?.content).toContain("question recovery-3f2a");
  expect(sent[1]?.content).not.toContain("Question recovery-3f2a:");
  expect(sent[1]?.content).toContain("Restart it?");
  expect(sent[1]?.content).toContain("Recommendation: restart:");
  expect(sent[1]?.options).toMatchObject({ triggerTurn: true });
  expect(notices).toHaveLength(0);
  expect(acknowledged).toEqual(["task-1:recovery-notification"]);
});
