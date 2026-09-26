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
