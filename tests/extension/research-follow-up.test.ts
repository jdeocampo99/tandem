import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
  RepoPolicy,
  ResearchContinuationDisposition,
  ResolvedPolicy,
  TaskRecord,
} from "../../src/contracts.ts";
import {
  deliverPendingNotifications,
  INLINE_RESEARCH_REPORT_MAX_CHARS,
  readResearchReport,
} from "../../src/extension/notifications.ts";
import { buildResearchFollowUpContent } from "../../src/extension/research-follow-up.ts";
import { summarizeTandemActionValue } from "../../src/extension/summary.ts";
import type { TandemService } from "../../src/service/controller.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import {
  decideResearchFollowUp,
  type ResearchFollowUpDecision,
} from "../../src/tasks/research-continuation.ts";
import { createTaskStore } from "../../src/tasks/store.ts";

const NOW = "2030-01-02T03:04:05.000Z";

const models: RepoPolicy["models"] = {
  coordinator: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  implementer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  presentation: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
};

const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models,
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [],
    setupCommands: [],
    maxFixRounds: 3,
    reviewLevels: {
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

function recordingSink(sent: string[]): Pick<ExtensionAPI, "sendMessage" | "appendEntry"> {
  return {
    sendMessage: (message) => {
      sent.push(typeof message === "string" ? message : String(message.content));
    },
    appendEntry: () => undefined,
  };
}

function silentUi(): { readonly ui: Pick<ExtensionContext["ui"], "notify"> } {
  return { ui: { notify: () => undefined } };
}

function noopAcknowledge(
  record: TaskRecord,
): Pick<TandemService, "acknowledge" | "requestReceipt"> {
  return {
    acknowledge: async () => record,
    requestReceipt: async () => {
      throw new Error("no receipt in this test");
    },
  };
}

async function completedScout(
  home: string,
  disposition: ResearchContinuationDisposition,
): Promise<Readonly<{ readonly directory: string; readonly reportPath: string }>> {
  const directory = join(home, "tasks");
  const reportPath = join(home, "jobs", "scout-task", "0", "job-1", "report.txt");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    "Outcome: completed\nThe retry loop drops the final attempt.\n",
    "utf8",
  );
  const store = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
  const created = await store.create({
    id: "scout-task",
    repoPath: join(home, "repo"),
    kind: "scout",
    objective: "Investigate the retry defect and then fix it",
    acceptanceCriteria: ["Report the cause"],
    surfaces: ["src"],
    policy,
    researchContinuation: { schemaVersion: 1, disposition, selectedBy: "explicit" },
  });
  const scouting = await store.update(created.id, created.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    updatedAt: NOW,
    stage: "scouting",
  }));
  await store.update(scouting.id, scouting.revision, (current) =>
    transitionTask(
      current,
      { type: "scout-report-complete", generation: current.generation, reportPath },
      { now: NOW, notificationId: "scout-complete" },
    ),
  );
  return { directory, reportPath };
}

function decision(
  followUp: ResearchFollowUpDecision["followUp"],
  disposition: ResearchContinuationDisposition,
  override?: ResearchFollowUpDecision["override"],
): ResearchFollowUpDecision {
  return override === undefined ? { followUp, disposition } : { followUp, disposition, override };
}

test("each post-research follow-up renders its own coordinator wake content", () => {
  const reportOnly = buildResearchFollowUpContent(decision("report-only", "report-only"));
  const askIntent = buildResearchFollowUpContent(decision("ask-intent", "ask-intent"));
  const interview = buildResearchFollowUpContent(
    decision("implementation-interview", "implementation-interview"),
  );
  const answerQuestion = buildResearchFollowUpContent(
    decision("answer-question", "implementation-interview", "open-question"),
  );
  const blocker = buildResearchFollowUpContent(
    decision("disclose-blocker", "implementation-interview", "missing-report"),
  );

  expect(reportOnly).toContain("Research follow-up: report-only");
  for (const followUp of [reportOnly, askIntent, interview]) {
    expect(followUp).toContain("which one you recommend and why");
    expect(followUp).toContain("one-or-two-sentence limit does not apply");
  }
  expect(reportOnly).toContain("End with the natural next steps");
  expect(reportOnly).toContain("Do not start the implementation interview");
  expect(reportOnly).not.toContain("acceptance criteria");

  expect(askIntent).toContain("Research follow-up: ask-intent");
  expect(askIntent).toContain("ask exactly one question");
  expect(askIntent).not.toContain("acceptance criteria");

  expect(interview).toContain("Research follow-up: implementation-interview");
  expect(interview).toContain("Propose one initial direction drawn from that evidence");
  expect(interview).toContain(
    "desired behavior, acceptance criteria, affected surfaces, non-goals, risks and compatibility",
  );
  expect(interview).not.toContain(
    "desired behavior, acceptance criteria, affected surfaces, non-goals, risks and compatibility, and approval",
  );
  expect(interview).toContain("do not widen scope on your own");
  expect(interview).toContain("researchTaskIds");
  expect(interview).toContain(
    "its own confirmation is the single approval ask, not a prose question first",
  );

  expect(answerQuestion).toContain("Research follow-up: answer-question");
  expect(answerQuestion).toContain("the task has an open question");
  expect(answerQuestion).toContain("Do not start the implementation interview");

  expect(blocker).toContain("Research follow-up: disclose-blocker");
  expect(blocker).toContain("there is no readable report");
  expect(blocker).toContain("Do not start the implementation interview");

  expect(new Set([reportOnly, askIntent, interview, answerQuestion, blocker]).size).toBe(5);
});

test("every overriding durable state names its own blocker reason", () => {
  const reasons = (
    ["not-a-scout", "blocked", "cancelled", "incomplete", "stale-generation"] as const
  ).map((override) =>
    buildResearchFollowUpContent(decision("disclose-blocker", "ask-intent", override)),
  );
  expect(new Set(reasons).size).toBe(reasons.length);
  expect(reasons[1]).toContain("the research is blocked");
  expect(reasons[4]).toContain("out of date");
});

test("a completed scout wake carries its durable follow-up and repeats it after a restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-follow-up-"));
  try {
    const { directory } = await completedScout(home, "implementation-interview");
    const live = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const record = await live.read("scout-task");
    if (record === undefined) throw new Error("scout task was not persisted");

    const first: string[] = [];
    await deliverPendingNotifications({
      pi: recordingSink(first),
      service: noopAcknowledge(record),
      tasks: [record],
      delivered: new Set<string>(),
      unacknowledged: new Set<string>(),
      ctx: silentUi(),
      readReport: readResearchReport,
    });

    const restarted = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const reloaded = await restarted.read("scout-task");
    if (reloaded === undefined) throw new Error("scout task did not survive the restart");
    const second: string[] = [];
    await deliverPendingNotifications({
      pi: recordingSink(second),
      service: noopAcknowledge(reloaded),
      tasks: [reloaded],
      delivered: new Set<string>(),
      unacknowledged: new Set<string>(),
      ctx: silentUi(),
      readReport: readResearchReport,
    });

    expect(first).toHaveLength(2);
    expect(first[1]).toContain("Evidence report: ");
    expect(first[1]).toContain("Research follow-up: implementation-interview");
    expect(second).toEqual(first);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an unreadable report downgrades the recorded interview to a disclosed blocker", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-follow-up-missing-"));
  try {
    const { directory, reportPath } = await completedScout(home, "implementation-interview");
    await rm(reportPath, { force: true });
    const store = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const record = await store.read("scout-task");
    if (record === undefined) throw new Error("scout task was not persisted");

    const sent: string[] = [];
    await deliverPendingNotifications({
      pi: recordingSink(sent),
      service: noopAcknowledge(record),
      tasks: [record],
      delivered: new Set<string>(),
      unacknowledged: new Set<string>(),
      ctx: silentUi(),
      readReport: readResearchReport,
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Research follow-up: disclose-blocker");
    expect(sent[1]).toContain("there is no readable report");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an implementation-interview wake approves no scope and creates no implementation task", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-follow-up-gate-"));
  try {
    const { directory } = await completedScout(home, "implementation-interview");
    const store = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const record = await store.read("scout-task");
    if (record === undefined) throw new Error("scout task was not persisted");

    const sent: string[] = [];
    await deliverPendingNotifications({
      pi: recordingSink(sent),
      service: noopAcknowledge(record),
      tasks: [record],
      delivered: new Set<string>(),
      unacknowledged: new Set<string>(),
      ctx: silentUi(),
      readReport: readResearchReport,
    });

    const after = await store.list();
    expect(after.map((entry) => entry.id)).toEqual(["scout-task"]);
    expect(after.every((entry) => entry.kind === "scout")).toBe(true);
    expect(after[0]?.researchHandoffs).toBeUndefined();
    expect(sent[1]).toContain("its own confirmation is the single approval ask");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("routine scout bookkeeping stays out of the model wake and carries no follow-up", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-follow-up-routine-"));
  try {
    const { directory } = await completedScout(home, "report-only");
    const store = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const record = await store.read("scout-task");
    if (record === undefined) throw new Error("scout task was not persisted");
    const routineOnly: TaskRecord = {
      ...record,
      notifications: [
        {
          id: "routine-notice",
          message: "Scout workspace bookkeeping.",
          acknowledged: false,
          kind: "routine",
        },
      ],
    };

    const sent: string[] = [];
    const notices: string[] = [];
    await deliverPendingNotifications({
      pi: recordingSink(sent),
      service: noopAcknowledge(routineOnly),
      tasks: [routineOnly],
      delivered: new Set<string>(),
      unacknowledged: new Set<string>(),
      ctx: { ui: { notify: (message) => notices.push(message) } },
      readReport: readResearchReport,
    });

    expect(sent).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain("Post-research follow-up");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("task summaries explain the disposition and its precedence in plain language", () => {
  const home = "/repo";
  const scout: TaskRecord = {
    schemaVersion: 1,
    id: "scout-task",
    revision: 1,
    repoPath: home,
    kind: "scout",
    objective: "Investigate the retry defect and then fix it",
    acceptanceCriteria: ["Report the cause"],
    surfaces: ["src"],
    stage: "completed",
    scopeApproved: true,
    policy,
    createdAt: NOW,
    updatedAt: NOW,
    generation: 0,
    reviewRound: 0,
    validationEvidence: [],
    reviews: [],
    notifications: [],
    reportPath: "/reports/scout.txt",
    researchContinuation: {
      schemaVersion: 1,
      disposition: "implementation-interview",
      selectedBy: "explicit",
    },
  };
  const summary = summarizeTandemActionValue("show", scout);
  expect(summary).toContain("After research: summarize the report, propose one direction");
  expect(summary).toContain("interview for implementation scope");

  const reportOnly = summarizeTandemActionValue("show", {
    ...scout,
    researchContinuation: { schemaVersion: 1, disposition: "report-only", selectedBy: "explicit" },
  });
  expect(reportOnly).toContain(
    "After research: summarize the report, recommend, and offer next steps",
  );
});

test("the delivered wake matches the pure decision for the same durable record", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-follow-up-pure-"));
  try {
    const { directory } = await completedScout(home, "ask-intent");
    const store = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const record = await store.read("scout-task");
    if (record === undefined) throw new Error("scout task was not persisted");

    const sent: string[] = [];
    await deliverPendingNotifications({
      pi: recordingSink(sent),
      service: noopAcknowledge(record),
      tasks: [record],
      delivered: new Set<string>(),
      unacknowledged: new Set<string>(),
      ctx: silentUi(),
      readReport: readResearchReport,
    });

    const expected = buildResearchFollowUpContent(
      decideResearchFollowUp({ task: record, reportReadable: true }),
    );
    expect(sent[1]).toContain(expected);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a finished research wake carries a short report so the coordinator need not read it", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-follow-up-inline-"));
  try {
    const { directory, reportPath } = await completedScout(home, "report-only");
    const store = createTaskStore({ directory, clock: () => NOW, idFactory: () => "unused" });
    const record = await store.read("scout-task");
    if (record === undefined) throw new Error("scout task was not persisted");
    const savedDetails: string[] = [];
    const deliver = async (): Promise<readonly string[]> => {
      const sent: string[] = [];
      await deliverPendingNotifications({
        pi: {
          sendMessage: (message) => {
            if (typeof message === "string") throw new Error("expected a custom message payload");
            sent.push(String(message.content));
            savedDetails.push(JSON.stringify(message.details ?? null));
          },
          appendEntry: () => undefined,
        },
        service: noopAcknowledge(record),
        tasks: [record],
        delivered: new Set<string>(),
        unacknowledged: new Set<string>(),
        ctx: silentUi(),
        readReport: readResearchReport,
      });
      return sent;
    };

    const [hidden, shown] = await deliver();
    expect(hidden).toContain("Full report for task scout-task");
    expect(hidden).toContain("The retry loop drops the final attempt.");
    expect(shown).not.toContain("The retry loop drops the final attempt.");
    expect(savedDetails.join("\n")).toContain("scout-task");
    expect(savedDetails.join("\n")).not.toContain("The retry loop drops the final attempt.");

    await writeFile(reportPath, "x".repeat(INLINE_RESEARCH_REPORT_MAX_CHARS + 1), "utf8");
    const [longHidden, longShown] = await deliver();
    expect(longHidden).not.toContain("Full report");
    expect(longShown).toContain(`Evidence report: ${reportPath}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
