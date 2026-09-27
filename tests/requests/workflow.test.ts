import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestBriefContent, TaskRecord } from "../../src/contracts.ts";
import { RequestBriefError } from "../../src/requests/brief.ts";
import { createRequestBriefStore } from "../../src/requests/store.ts";
import { RequestBriefWorkflow } from "../../src/requests/workflow.ts";
import { expectNoIdentifiers } from "../tasks/question.test.ts";

const NOW = "2030-01-01T00:00:00.000Z";

function content(overrides: Partial<RequestBriefContent> = {}): RequestBriefContent {
  return {
    goal: "Give every reader a plain-English approval prompt",
    scope: ["src/requests"],
    constraints: ["no request id in user-facing text"],
    nonGoals: [],
    acceptanceCriteria: ["a person never has to look up an id"],
    manualVerification: [],
    recommendedApproach: "name the request by its goal",
    keyDecisions: [],
    openQuestions: [],
    researchLinks: [],
    ...overrides,
  };
}

type Fixture = Readonly<{
  readonly workflow: RequestBriefWorkflow;
  readonly pauseCalls: Array<{ readonly taskId: string; readonly reason: string }>;
  readonly setTasks: (tasks: readonly TaskRecord[]) => void;
  readonly close: () => Promise<void>;
}>;

async function fixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "tandem-brief-workflow-"));
  let sequence = 0;
  const store = createRequestBriefStore({
    home,
    clock: () => NOW,
    idFactory: () => {
      sequence += 1;
      return `req-${sequence}`;
    },
  });
  const pauseCalls: Array<{ readonly taskId: string; readonly reason: string }> = [];
  let tasks: readonly TaskRecord[] = [];
  const workflow = new RequestBriefWorkflow({
    home,
    sessionId: "session-1",
    parentWorkspaceId: undefined,
    coordinatorPaneId: undefined,
    run: () => {
      throw new Error("run must not be called when no review pane is open");
    },
    clock: () => NOW,
    store,
    listTasks: async () => tasks,
    pauseTask: async (taskId, reason) => {
      pauseCalls.push({ taskId, reason });
    },
    idFactory: () => {
      sequence += 1;
      return `planning-${sequence}`;
    },
  });
  return {
    workflow,
    pauseCalls,
    setTasks: (next) => {
      tasks = next;
    },
    close: () => rm(home, { recursive: true, force: true }),
  };
}

test("approving a brief without a requestId resolves the one request awaiting approval", async () => {
  const { workflow, close } = await fixture();
  try {
    const drafted = await workflow.draft({
      repoPath: "/repo",
      content: content(),
      reviewPane: false,
    });
    const approved = await workflow.approve({
      briefRevision: drafted.record.draft.revision,
      contentDigest: drafted.record.draft.contentDigest,
    });
    expect(approved.approvalState).toBe("current");
    expect(approved.record.id).toBe(drafted.record.id);
  } finally {
    await close();
  }
});

test("approving a brief without a requestId fails closed when nothing is pending", async () => {
  const { workflow, close } = await fixture();
  try {
    const drafted = await workflow.draft({
      repoPath: "/repo",
      content: content(),
      reviewPane: false,
    });
    await workflow.approve({
      briefRevision: drafted.record.draft.revision,
      contentDigest: drafted.record.draft.contentDigest,
    });
    await expect(
      workflow.approve({
        briefRevision: drafted.record.draft.revision,
        contentDigest: drafted.record.draft.contentDigest,
      }),
    ).rejects.toMatchObject({ code: "no-pending-approval" });
  } finally {
    await close();
  }
});

test("approving a brief without a requestId fails closed and names every candidate when ambiguous", async () => {
  const { workflow, close } = await fixture();
  try {
    const first = await workflow.draft({
      repoPath: "/repo",
      content: content({ goal: "First request" }),
      reviewPane: false,
    });
    const second = await workflow.draft({
      repoPath: "/repo",
      content: content({ goal: "Second request" }),
      reviewPane: false,
    });
    let caught: unknown;
    try {
      await workflow.approve({
        briefRevision: 1,
        contentDigest: first.record.draft.contentDigest,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RequestBriefError);
    const error = caught as RequestBriefError;
    expect(error.code).toBe("ambiguous-pending-approval");
    expect(error.message).toContain(first.record.id);
    expect(error.message).toContain(second.record.id);
  } finally {
    await close();
  }
});

test("naming a requestId explicitly still resolves it directly, ambiguity notwithstanding", async () => {
  const { workflow, close } = await fixture();
  try {
    const first = await workflow.draft({
      repoPath: "/repo",
      content: content({ goal: "First request" }),
      reviewPane: false,
    });
    await workflow.draft({
      repoPath: "/repo",
      content: content({ goal: "Second request" }),
      reviewPane: false,
    });
    const approved = await workflow.approve({
      requestId: first.record.id,
      briefRevision: first.record.draft.revision,
      contentDigest: first.record.draft.contentDigest,
    });
    expect(approved.record.id).toBe(first.record.id);
    expect(approved.approvalState).toBe("current");
  } finally {
    await close();
  }
});

test("a changed brief pauses affected work with a plain-English reason naming the goal, not the request id or revision", async () => {
  const { workflow, pauseCalls, setTasks, close } = await fixture();
  try {
    const drafted = await workflow.draft({
      repoPath: "/repo",
      content: content(),
      reviewPane: false,
    });
    await workflow.approve({
      requestId: drafted.record.id,
      briefRevision: drafted.record.draft.revision,
      contentDigest: drafted.record.draft.contentDigest,
    });
    setTasks([
      {
        id: "task-1",
        requestId: drafted.record.id,
        stage: "implementing",
      } as unknown as TaskRecord,
    ]);
    await workflow.draft({
      repoPath: "/repo",
      requestId: drafted.record.id,
      content: content({ scope: ["src/requests", "src/tasks"] }),
      reviewPane: false,
    });
    expect(pauseCalls).toHaveLength(1);
    const [paused] = pauseCalls;
    expect(paused).toBeDefined();
    expect(paused?.reason).toContain(content().goal);
    expectNoIdentifiers(paused?.reason ?? "", [drafted.record.id, "revision"]);
  } finally {
    await close();
  }
});

test("abandoning a stale draft lets a no-id approval land on the one brief still pending", async () => {
  const { workflow, close } = await fixture();
  try {
    const stale = await workflow.draft({
      repoPath: "/repo",
      content: content({ goal: "A request the user walked away from" }),
      reviewPane: false,
    });
    const current = await workflow.draft({
      repoPath: "/repo",
      content: content({ goal: "The request in view" }),
      reviewPane: false,
    });
    const abandoned = await workflow.abandon(stale.record.id);
    expect(abandoned.record.abandonedAt).toBe(NOW);
    expect((await workflow.read(stale.record.id)).record.abandonedAt).toBe(NOW);
    expect(await workflow.pendingApprovalId()).toBe(current.record.id);
    await expect(
      workflow.draft({
        repoPath: "/repo",
        requestId: stale.record.id,
        content: stale.record.draft.content,
        reviewPane: false,
      }),
    ).rejects.toMatchObject({ code: "request-abandoned" });
  } finally {
    await close();
  }
});

test("planning interviews persist ordered decisions and require final brief approval", async () => {
  const { workflow, pauseCalls, setTasks, close } = await fixture();
  try {
    const drafted = await workflow.draft({
      repoPath: "/repo",
      content: content({ openQuestions: ["Which behavior?", "What compatibility constraint?"] }),
      reviewPane: false,
      startPlanningInterview: true,
      researchTaskIds: ["scout-1"],
    });
    expect(drafted.record.planningInterview).toMatchObject({
      status: "active",
      researchTaskIds: ["scout-1"],
      questions: [],
    });
    await expect(
      workflow.approve({
        requestId: drafted.record.id,
        briefRevision: drafted.record.draft.revision,
        contentDigest: drafted.record.draft.contentDigest,
      }),
    ).rejects.toMatchObject({ code: "planning-interview-incomplete" });

    const first = await workflow.addPlanningQuestion(drafted.record.id, {
      context: "The report found two plausible paths.",
      question: "Which behavior should remain?",
      options: [{ label: "Stable behavior" }, { label: "New behavior" }],
      recommendedOption: 0,
    });
    const firstQuestion = first.planningInterview?.questions[0];
    if (firstQuestion === undefined) throw new Error("first planning question was not saved");
    await expect(
      workflow.addPlanningQuestion(drafted.record.id, {
        context: "A second decision.",
        question: "What compatibility constraint applies?",
        options: [{ label: "Preserve" }, { label: "Replace" }],
        recommendedOption: 0,
      }),
    ).rejects.toMatchObject({ code: "planning-question-pending" });

    const firstAnswers = await Promise.all([
      workflow.recordPlanningAnswer(drafted.record.id, firstQuestion.id, {
        kind: "option",
        value: "Stable behavior",
      }),
      workflow.recordPlanningAnswer(drafted.record.id, firstQuestion.id, {
        kind: "option",
        value: "Stable behavior",
      }),
    ]);
    expect(firstAnswers.map((answer) => answer.duplicate).sort()).toEqual([false, true]);
    await expect(
      workflow.recordPlanningAnswer(drafted.record.id, firstQuestion.id, {
        kind: "option",
        value: "New behavior",
      }),
    ).rejects.toMatchObject({ code: "planning-question-stale" });

    const second = await workflow.addPlanningQuestion(drafted.record.id, {
      context: "The replacement path affects older callers.",
      question: "What compatibility constraint applies?",
      options: [{ label: "Preserve" }, { label: "Replace" }],
      recommendedOption: 0,
    });
    const secondQuestion = second.planningInterview?.questions[1];
    if (secondQuestion === undefined) throw new Error("second planning question was not saved");
    await expect(workflow.completePlanningInterview(drafted.record.id)).rejects.toMatchObject({
      code: "planning-interview-incomplete",
    });
    await workflow.recordPlanningAnswer(drafted.record.id, secondQuestion.id, {
      kind: "custom",
      value: "Keep the adapter for older callers",
    });
    await expect(workflow.completePlanningInterview(drafted.record.id)).rejects.toMatchObject({
      code: "planning-interview-incomplete",
    });

    await workflow.draft({
      repoPath: "/repo",
      requestId: drafted.record.id,
      content: content({
        keyDecisions: ["Keep stable behavior and the adapter for older callers"],
        openQuestions: [],
      }),
      reviewPane: false,
    });
    const completed = await workflow.completePlanningInterview(drafted.record.id);
    expect(completed.record.planningInterview?.status).toBe("complete");
    expect(completed.record.draft.content.planningAnswers).toEqual([
      "Which behavior should remain?\nAnswer: Stable behavior",
      "What compatibility constraint applies?\nAnswer: Keep the adapter for older callers",
    ]);
    expect(completed.approvalState).toBe("unapproved");

    const approved = await workflow.approve({
      requestId: drafted.record.id,
      briefRevision: completed.record.draft.revision,
      contentDigest: completed.record.draft.contentDigest,
    });
    expect(approved.approvalState).toBe("current");
    const repeatedCompletion = await workflow.completePlanningInterview(drafted.record.id);
    expect(repeatedCompletion.record.revision).toBe(approved.record.revision);
    expect(repeatedCompletion.approvalState).toBe("current");
    expect(await workflow.dispatchDecisionForTask({ requestId: drafted.record.id })).toMatchObject({
      allowed: true,
    });

    setTasks([
      { id: "task-owned", requestId: drafted.record.id, stage: "implementing" } as TaskRecord,
      { id: "task-other", requestId: "req-other", stage: "implementing" } as TaskRecord,
    ]);
    const priorAnswers = approved.record.draft.content.planningAnswers;
    if (priorAnswers === undefined) throw new Error("completed interview did not persist answers");
    const reopened = await workflow.draft({
      repoPath: "/repo",
      requestId: drafted.record.id,
      content: {
        ...approved.record.draft.content,
        openQuestions: ["Should older clients remain supported?"],
      },
      reviewPane: false,
      startPlanningInterview: true,
      researchTaskIds: ["scout-2"],
    });
    expect(reopened.approvalState).toBe("current");
    expect(reopened.record.planningInterview).toMatchObject({
      status: "active",
      researchTaskIds: ["scout-2"],
      questions: [],
    });
    expect(reopened.record.draft.content.planningAnswers).toEqual(priorAnswers);
    expect(reopened.pausedTaskIds).toEqual(["task-owned"]);
    expect(pauseCalls.map((call) => call.taskId)).toEqual(["task-owned"]);
    await expect(
      workflow.dispatchDecisionForTask({ requestId: drafted.record.id }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("planning interview"),
    });
    await expect(
      workflow.recordPlanningAnswer(drafted.record.id, firstQuestion.id, {
        kind: "option",
        value: "Stable behavior",
      }),
    ).rejects.toMatchObject({ code: "planning-question-stale" });

    const followup = await workflow.addPlanningQuestion(drafted.record.id, {
      context: "Implementation found a new compatibility issue.",
      question: "Should older clients remain supported?",
      options: [{ label: "Preserve support" }, { label: "Require migration" }],
      recommendedOption: 0,
    });
    const followupQuestion = followup.planningInterview?.questions[0];
    if (followupQuestion === undefined) throw new Error("follow-up question was not saved");
    await workflow.recordPlanningAnswer(drafted.record.id, followupQuestion.id, {
      kind: "option",
      value: "Preserve support",
    });
    setTasks([
      { id: "task-owned", requestId: drafted.record.id, stage: "paused" } as TaskRecord,
      { id: "task-other", requestId: "req-other", stage: "implementing" } as TaskRecord,
    ]);
    await workflow.draft({
      repoPath: "/repo",
      requestId: drafted.record.id,
      content: {
        ...reopened.record.draft.content,
        keyDecisions: [
          ...reopened.record.draft.content.keyDecisions,
          "Preserve support for older clients",
        ],
        openQuestions: [],
      },
      reviewPane: false,
    });
    const completedAgain = await workflow.completePlanningInterview(drafted.record.id);
    expect(completedAgain.record.draft.content.planningAnswers).toEqual([
      ...priorAnswers,
      "Should older clients remain supported?\nAnswer: Preserve support",
    ]);
    expect(completedAgain.approvalState).toBe("superseded");
    const reapproved = await workflow.approve({
      requestId: drafted.record.id,
      briefRevision: completedAgain.record.draft.revision,
      contentDigest: completedAgain.record.draft.contentDigest,
    });
    expect(reapproved.approvalState).toBe("current");
  } finally {
    await close();
  }
});

test("an active interview gates only its request and pauses stale work after a scope change", async () => {
  const { workflow, pauseCalls, setTasks, close } = await fixture();
  try {
    const drafted = await workflow.draft({
      repoPath: "/repo",
      content: content(),
      reviewPane: false,
    });
    const approved = await workflow.approve({
      requestId: drafted.record.id,
      briefRevision: drafted.record.draft.revision,
      contentDigest: drafted.record.draft.contentDigest,
    });
    setTasks([
      { id: "task-owned", requestId: drafted.record.id, stage: "implementing" } as TaskRecord,
      { id: "task-other", requestId: "req-other", stage: "implementing" } as TaskRecord,
    ]);

    const active = await workflow.draft({
      repoPath: "/repo",
      requestId: drafted.record.id,
      content: content(),
      reviewPane: false,
      startPlanningInterview: true,
      researchTaskIds: ["scout-1"],
    });
    expect(active.approvalState).toBe("current");
    expect(active.pausedTaskIds).toEqual(["task-owned"]);
    expect(pauseCalls.map((call) => call.taskId)).toEqual(["task-owned"]);
    setTasks([
      { id: "task-owned", requestId: drafted.record.id, stage: "paused" } as TaskRecord,
      { id: "task-other", requestId: "req-other", stage: "implementing" } as TaskRecord,
    ]);
    await expect(
      workflow.dispatchDecisionForTask({ requestId: drafted.record.id }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("planning interview"),
    });
    await expect(
      workflow.approve({
        requestId: drafted.record.id,
        briefRevision: approved.record.draft.revision,
        contentDigest: approved.record.draft.contentDigest,
      }),
    ).rejects.toMatchObject({ code: "planning-interview-incomplete" });

    const question = await workflow.addPlanningQuestion(drafted.record.id, {
      context: "Research raised a scope decision.",
      question: "Should the adapter remain?",
      options: [{ label: "Keep it" }, { label: "Remove it" }],
      recommendedOption: 0,
    });
    const savedQuestion = question.planningInterview?.questions[0];
    if (savedQuestion === undefined) throw new Error("planning question was not saved");
    await workflow.recordPlanningAnswer(drafted.record.id, savedQuestion.id, {
      kind: "option",
      value: "Keep it",
    });
    const revised = await workflow.draft({
      repoPath: "/repo",
      requestId: drafted.record.id,
      content: content({ keyDecisions: ["Keep the adapter"] }),
      reviewPane: false,
    });
    expect(revised.approvalState).toBe("superseded");
    expect(pauseCalls.map((call) => call.taskId)).toEqual(["task-owned"]);

    setTasks([
      { id: "task-owned", requestId: drafted.record.id, stage: "paused" } as TaskRecord,
      { id: "task-other", requestId: "req-other", stage: "implementing" } as TaskRecord,
    ]);
    const completed = await workflow.completePlanningInterview(drafted.record.id);
    expect(completed.pausedTaskIds).toEqual([]);
    expect(pauseCalls.map((call) => call.taskId)).toEqual(["task-owned"]);
    const finalApproval = await workflow.approve({
      requestId: drafted.record.id,
      briefRevision: completed.record.draft.revision,
      contentDigest: completed.record.draft.contentDigest,
    });
    expect(finalApproval.approvalState).toBe("current");
  } finally {
    await close();
  }
});
