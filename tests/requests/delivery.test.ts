import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Clock,
  CommandRequest,
  CommandResult,
  CommandRunner,
  IdFactory,
  RepoPolicy,
  RequestBriefContent,
  ResolvedPolicy,
  ReviewLens,
  ReviewResult,
  TaskRecord,
} from "../../src/contracts.ts";
import { requestBriefDigests } from "../../src/requests/brief.ts";
import { RequestDeliveryWorkflow } from "../../src/requests/delivery.ts";
import { createRequestDeliveryStore } from "../../src/requests/delivery-store.ts";
import { createRequestBriefStore } from "../../src/requests/store.ts";
import { policyIdentity } from "../../src/tasks/acceptance.ts";
import { transitionTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore, type TaskStore } from "../../src/tasks/store.ts";

const NOW = "2030-01-01T00:00:00.000Z";
const BASE_HEAD = "a".repeat(40);
const MEMBER_HEADS: Readonly<Record<string, string>> = {
  "task-1": "b".repeat(40),
  "task-2": "c".repeat(40),
};
const MERGE_HEADS = ["d".repeat(40), "e".repeat(40)];
const INTEGRATED_HEAD = MERGE_HEADS[1] ?? "";
const REPOSITORY = "acme/repo";

const policyConfig: RepoPolicy = {
  version: 1,
  models: {
    coordinator: { model: "scenario/coordinator", thinking: "low" },
    scout: { model: "scenario/scout", thinking: "low" },
    implementer: { model: "scenario/implementer", thinking: "low" },
    reviewer: { model: "scenario/reviewer", thinking: "low" },
    presentation: { model: "scenario/presentation", thinking: "low" },
  },
  instructions: { implementation: [], validation: [], review: [] },
  instructionFiles: { implementation: [], validation: [], review: [] },
  validationCommands: [
    { name: "check", argv: ["bun", "run", "check"], surfaces: ["*"], timeoutMs: 10_000 },
  ],
  setupCommands: [],
  maxWorkers: 2,
  maxFixRounds: 1,
  reviewLevels: {
    deepScrutiny: false,
    jevAssistance: "off",
    sourceTransmission: false,
  },
};

const policy: ResolvedPolicy = {
  config: policyConfig,
  guidance: { implementation: [], validation: [], review: [] },
};

const briefContent: RequestBriefContent = {
  goal: "Deliver the whole request at once",
  scope: ["src/requests"],
  constraints: ["one verified pull request by default"],
  nonGoals: ["no automatic merge"],
  acceptanceCriteria: ["Every approved member is delivered through one pull request."],
  recommendedApproach: "Integrate reviewed member branches onto one delivery branch",
  keyDecisions: ["evidence binds to the integrated commit"],
  openQuestions: [],
  researchLinks: [],
};

function review(lens: ReviewLens, head: string): ReviewResult {
  return { lens, head, generation: 0, pass: true, findings: [], summary: `${lens} passed` };
}

const LENSES: readonly ReviewLens[] = ["review"];

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

type Remote = {
  pullRequestNumber: number | undefined;
  pullRequestHead: string;
  merged: boolean;
};

type Worktree = { branch: string; head: string };

type DeliveryWorld = Readonly<{
  readonly home: string;
  readonly repoPath: string;
  readonly poolRoot: string;
  readonly worktreePath: string;
  readonly run: CommandRunner;
  readonly calls: CommandRequest[];
  readonly remote: Remote;
  readonly worktree: Worktree;
  readonly failNextMerge: (stderr: string) => void;
  readonly taskStore: TaskStore;
  readonly workflow: () => RequestDeliveryWorkflow;
  readonly requestId: string;
}>;

function commandRunner(
  input: Readonly<{
    readonly repoPath: string;
    readonly poolRoot: string;
    readonly worktreePath: string;
    readonly worktree: Worktree;
    readonly remote: Remote;
    readonly calls: CommandRequest[];
    readonly refusedMerges: string[];
  }>,
): CommandRunner {
  let mergeIndex = 0;
  return async (request) => {
    input.calls.push(request);
    const argv = request.argv;
    if (argv[0] === "treehouse") {
      if (argv.includes("status")) {
        return result(
          JSON.stringify([
            {
              name: "request",
              path: input.worktreePath,
              status: "leased",
              flavor: "worktree",
              lease_id: "lease-request",
              lease_holder: "tandem-req-r1",
              leased_at: NOW,
              processes: [],
            },
          ]),
        );
      }
      throw new Error(`unexpected treehouse command ${JSON.stringify(argv)}`);
    }
    if (argv[0] === "bun") return result("checks passed");
    if (argv[0] === "gh") {
      if (argv[2] === "list") {
        return result(
          input.remote.pullRequestNumber === undefined
            ? "[]"
            : JSON.stringify([pullRequestJson(input.remote)]),
        );
      }
      if (argv[2] === "create") {
        input.remote.pullRequestNumber = 11;
        input.remote.pullRequestHead = input.worktree.head;
        return result("https://github.com/acme/repo/pull/11\n");
      }
      if (argv[2] === "view") {
        if (input.remote.pullRequestNumber === undefined) {
          return result("", 1, "no pull request found");
        }
        return result(
          JSON.stringify({
            ...pullRequestJson(input.remote),
            statusCheckRollup: [
              { name: "ci", isRequired: true, state: "SUCCESS", conclusion: "SUCCESS" },
            ],
          }),
        );
      }
      if (argv[2] === "merge") {
        input.remote.merged = true;
        return result("merged\n");
      }
      throw new Error(`unexpected gh command ${JSON.stringify(argv)}`);
    }
    if (argv[0] !== "git") throw new Error(`unexpected command ${JSON.stringify(argv)}`);
    const target = argv[2] ?? request.cwd;
    const rest = argv.slice(3);
    const verb = rest[0];
    if (verb === "rev-parse") {
      const reference = rest.at(-1);
      if (reference === "--show-toplevel") return result(target);
      if (reference === "--git-common-dir") return result(join(input.repoPath, ".git"));
      return result(target === input.repoPath ? BASE_HEAD : input.worktree.head);
    }
    if (verb === "cat-file") return result();
    if (verb === "branch") return result(input.worktree.branch);
    if (verb === "symbolic-ref") return result(input.worktree.branch);
    if (verb === "status") return result();
    if (verb === "diff") return result();
    if (verb === "remote") return result("git@github.com:acme/repo.git\n");
    if (verb === "push") return result();
    if (verb === "switch") {
      input.worktree.branch = rest.at(-2) ?? input.worktree.branch;
      input.worktree.head = BASE_HEAD;
      mergeIndex = 0;
      return result();
    }
    if (verb === "merge") {
      if (rest[1] === "--abort") return result();
      const refusal = input.refusedMerges.shift();
      if (refusal !== undefined) return result("", 1, refusal);
      input.worktree.head = MERGE_HEADS[mergeIndex] ?? input.worktree.head;
      mergeIndex += 1;
      return result();
    }
    throw new Error(`unexpected git command ${JSON.stringify(argv)}`);
  };
}

function pullRequestJson(remote: Remote): Record<string, unknown> {
  return {
    number: remote.pullRequestNumber,
    url: "https://github.com/acme/repo/pull/11",
    state: remote.merged ? "MERGED" : "OPEN",
    isDraft: false,
    headRefName: "tandem/req-r1",
    headRefOid: remote.pullRequestHead,
    baseRefName: "main",
    title: "Deliver the whole request",
  };
}

async function readyMember(
  store: TaskStore,
  input: Readonly<{
    readonly id: string;
    readonly requestId: string;
    readonly repoPath: string;
    readonly poolRoot: string;
    readonly surfaces: readonly string[];
  }>,
): Promise<TaskRecord> {
  const head = MEMBER_HEADS[input.id] ?? "";
  const created = await store.create({
    id: input.id,
    repoPath: input.repoPath,
    kind: "implementation",
    objective: `deliver ${input.id}`,
    acceptanceCriteria: ["the member is reviewed"],
    surfaces: input.surfaces,
    policy,
    requestId: input.requestId,
  });
  const approved = await store.update(created.id, created.revision, (task) =>
    transitionTask(task, { type: "approve" }, { now: NOW, notificationId: `${input.id}-approve` }),
  );
  return store.update(approved.id, approved.revision, (task) => ({
    ...task,
    revision: task.revision + 1,
    updatedAt: NOW,
    stage: "ready",
    reviewHead: head,
    worktree: {
      root: input.poolRoot,
      path: join(input.poolRoot, input.id),
      name: input.id,
      baseHead: BASE_HEAD,
      branch: `tandem/${input.id}`,
      leaseId: `lease-${input.id}`,
      leaseHolder: `tandem-${input.id}`,
      leasedAt: NOW,
    },
    validationEvidence: [
      {
        name: "check",
        argv: ["bun", "run", "check"],
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        head,
        contract: "final",
        origin: "local",
        policyDigest: policyIdentity(policy),
      },
    ],
    reviews: LENSES.map((lens) => review(lens, head)),
  }));
}

async function withRequest(body: (world: DeliveryWorld) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-request-delivery-")));
  const home = join(root, "home");
  const repoPath = join(root, "repo");
  const poolRoot = join(root, "pool");
  const worktreePath = join(poolRoot, "request");
  await mkdir(join(repoPath, ".git"), { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  const calls: CommandRequest[] = [];
  const remote: Remote = { pullRequestNumber: undefined, pullRequestHead: "", merged: false };
  const worktree: Worktree = { branch: "", head: BASE_HEAD };
  const refusedMerges: string[] = [];
  const run = commandRunner({
    repoPath,
    poolRoot,
    worktreePath,
    worktree,
    remote,
    calls,
    refusedMerges,
  });
  const clock: Clock = () => NOW;
  let identifier = 0;
  const idFactory: IdFactory = () => {
    identifier += 1;
    return identifier === 1 ? "r1" : `generated-${identifier}`;
  };
  const briefStore = createRequestBriefStore({ home, clock, idFactory });
  const deliveryStore = createRequestDeliveryStore({ home, clock });
  const taskStore = createTaskStore({ directory: join(home, "tasks"), clock, idFactory });
  try {
    const created = await briefStore.create({ repoPath, content: briefContent });
    await briefStore.update(created.id, created.revision, (record) => ({
      ...record,
      revision: record.revision + 1,
      updatedAt: NOW,
      approval: {
        requestId: record.id,
        briefRevision: record.draft.revision,
        contentDigest: record.draft.contentDigest,
        agreementDigest: requestBriefDigests(record.draft.content).agreementDigest,
        approvedAt: NOW,
      },
    }));
    const workflow = (): RequestDeliveryWorkflow =>
      new RequestDeliveryWorkflow({
        sessionId: "session-1",
        poolRoot,
        run,
        clock,
        idFactory,
        store: deliveryStore,
        readBrief: async (requestId) => {
          const record = await briefStore.read(requestId);
          if (record === undefined) throw new Error(`request ${requestId} is missing`);
          return record;
        },
        listTasks: () => taskStore.list(),
        transitionTask: async (taskId, event) => {
          const task = await taskStore.read(taskId);
          if (task === undefined) throw new Error(`task ${taskId} is missing`);
          return taskStore.update(taskId, task.revision, (current) =>
            transitionTask(current, event, {
              now: NOW,
              notificationId: `${taskId}-${current.revision}`,
            }),
          );
        },
      });
    for (const id of ["task-1", "task-2"]) {
      const admitted = await readyMember(taskStore, {
        id,
        requestId: created.id,
        repoPath,
        poolRoot,
        surfaces: [id],
      });
      await workflow().admit(admitted);
    }
    await body({
      home,
      repoPath,
      poolRoot,
      worktreePath,
      run,
      calls,
      remote,
      worktree,
      failNextMerge: (stderr) => refusedMerges.push(stderr),
      taskStore,
      workflow,
      requestId: created.id,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function mergeCalls(calls: readonly CommandRequest[]): readonly CommandRequest[] {
  return calls.filter(
    (call) => call.argv[0] === "git" && call.argv[3] === "merge" && call.argv[4] !== "--abort",
  );
}

async function recordIntegrationReviews(world: DeliveryWorld, head: string): Promise<void> {
  for (const lens of LENSES) {
    await world.workflow().recordReview(world.requestId, review(lens, head));
  }
}

test("integration records one delivery commit with evidence pinned to that commit", async () => {
  await withRequest(async (world) => {
    const view = await world.workflow().integrate(world.requestId);
    const integration = view.record.integration;

    expect(integration?.head).toBe(INTEGRATED_HEAD);
    expect(integration?.members.map((member) => member.taskId)).toEqual(["task-1", "task-2"]);
    expect(integration?.evidence).toHaveLength(1);
    expect(integration?.evidence[0]?.head).toBe(INTEGRATED_HEAD);
    expect(integration?.evidence[0]?.contract).toBe("final");
    expect(view.acceptance?.satisfied).toBe(false);
    expect(view.acceptance?.manifest.pendingLenses).toEqual([...LENSES]);
  });
});

test("a restarted workflow reuses the recorded integration instead of merging again", async () => {
  await withRequest(async (world) => {
    const first = await world.workflow().integrate(world.requestId);
    const mergesAfterFirst = mergeCalls(world.calls).length;

    const second = await world.workflow().integrate(world.requestId);

    expect(mergeCalls(world.calls)).toHaveLength(mergesAfterFirst);
    expect(second.record.revision).toBe(first.record.revision);
    expect(second.record.integration?.head).toBe(INTEGRATED_HEAD);
  });
});

test("a member output that does not merge cleanly becomes a conflict needing a decision", async () => {
  await withRequest(async (world) => {
    world.failNextMerge("CONFLICT (content): Merge conflict in src/handler.ts");

    await expect(world.workflow().integrate(world.requestId)).rejects.toThrow(
      /could not be integrated/u,
    );

    const view = await world.workflow().status(world.requestId);
    expect(view.record.integration).toBeUndefined();
    expect(view.record.conflicts).toHaveLength(1);
    expect(view.aggregate.decisions[0]?.detail).toContain("Merge conflict");
    expect(view.aggregate.readyToIntegrate).toBe(false);
  });
});

test("publication is refused until the integrated commit satisfies the final acceptance contract", async () => {
  await withRequest(async (world) => {
    await world.workflow().integrate(world.requestId);

    await expect(
      world.workflow().publish(world.requestId, {
        repository: REPOSITORY,
        title: "Deliver the whole request",
        base: "main",
        summary: { tldr: ["t"], what: ["w"], why: ["y"] },
        approved: true,
      }),
    ).rejects.toThrow(/no passing review/u);
    expect(world.remote.pullRequestNumber).toBeUndefined();
  });
});

test("publication needs its own approval and then creates exactly one pull request", async () => {
  await withRequest(async (world) => {
    await world.workflow().integrate(world.requestId);
    await recordIntegrationReviews(world, INTEGRATED_HEAD);
    const publishInput = {
      repository: REPOSITORY,
      title: "Deliver the whole request",
      base: "main",
      summary: { tldr: ["t"], what: ["w"], why: ["y"] },
    };

    await expect(
      world.workflow().publish(world.requestId, { ...publishInput, approved: false }),
    ).rejects.toThrow(/approval/u);

    const published = await world.workflow().publish(world.requestId, {
      ...publishInput,
      approved: true,
    });
    expect(published.record.publication?.pullRequest.number).toBe(11);
    expect(published.record.publication?.integratedHead).toBe(INTEGRATED_HEAD);
    expect(published.aggregate.delivered).toBe(true);

    const republished = await world.workflow().publish(world.requestId, {
      ...publishInput,
      approved: true,
    });
    expect(republished.record.publication?.pullRequest.number).toBe(11);
    expect(world.calls.filter((call) => call.argv[2] === "create")).toHaveLength(1);
  });
});

test("a review naming another commit is refused rather than retargeted", async () => {
  await withRequest(async (world) => {
    await world.workflow().integrate(world.requestId);

    await expect(
      world.workflow().recordReview(world.requestId, review("review", "f".repeat(40))),
    ).rejects.toThrow(/not the integrated HEAD/u);
  });
});

test("only a decision and true completion interrupt the main conversation", async () => {
  await withRequest(async (world) => {
    const integrated = await world.workflow().reconcile(world.requestId);
    expect(integrated.record.notifications).toEqual([]);

    await world.workflow().integrate(world.requestId);
    const afterIntegration = await world.workflow().reconcile(world.requestId);
    expect(afterIntegration.record.notifications).toEqual([]);

    await recordIntegrationReviews(world, INTEGRATED_HEAD);
    const published = await world.workflow().publish(world.requestId, {
      repository: REPOSITORY,
      title: "Deliver the whole request",
      base: "main",
      summary: { tldr: ["t"], what: ["w"], why: ["y"] },
      approved: true,
    });

    expect(published.record.notifications).toHaveLength(1);
    expect(published.record.notifications[0]?.kind).toBe("coordinator");
    expect(published.record.notifications[0]?.message).toContain("is complete");

    const again = await world.workflow().reconcile(world.requestId);
    expect(again.record.notifications).toHaveLength(1);
  });
});

test("merge needs a separate approval and then marks every member merged with its proof", async () => {
  await withRequest(async (world) => {
    await world.workflow().integrate(world.requestId);
    await recordIntegrationReviews(world, INTEGRATED_HEAD);
    await world.workflow().publish(world.requestId, {
      repository: REPOSITORY,
      title: "Deliver the whole request",
      base: "main",
      summary: { tldr: ["t"], what: ["w"], why: ["y"] },
      approved: true,
    });

    await expect(world.workflow().merge(world.requestId, { approved: false })).rejects.toThrow(
      /approval/u,
    );
    expect(world.remote.merged).toBe(false);

    const merged = await world.workflow().merge(world.requestId, { approved: true });
    expect(merged.record.publication?.pullRequest.state).toBe("merged");
    for (const id of ["task-1", "task-2"]) {
      const task = await world.taskStore.read(id);
      expect(task?.stage).toBe("merged");
      expect(task?.pullRequest?.head).toBe(INTEGRATED_HEAD);
    }
  });
});

test("delivering one member on its own needs explicit approval to split the request", async () => {
  await withRequest(async (world) => {
    const member = await world.taskStore.read("task-1");
    if (member === undefined) throw new Error("member task is missing");

    await expect(
      world.workflow().assertSeparateDeliveryApproved(member, "publishing"),
    ).rejects.toThrow(/needs explicit approval to split delivery/u);

    await world.workflow().approveSplit(world.requestId);
    await world.workflow().assertSeparateDeliveryApproved(member, "publishing");
  });
});

test("a member waiting on a dependency is held back while its dependency runs", async () => {
  await withRequest(async (world) => {
    const blocking = await world.taskStore.read("task-1");
    if (blocking === undefined) throw new Error("member task is missing");
    await world.taskStore.update(blocking.id, blocking.revision, (task) => ({
      ...task,
      revision: task.revision + 1,
      updatedAt: NOW,
      stage: "implementing",
    }));
    const queued = await world.taskStore.read("task-2");
    if (queued === undefined) throw new Error("dependent task is missing");
    await world.taskStore.update(queued.id, queued.revision, (task) => ({
      ...task,
      revision: task.revision + 1,
      updatedAt: NOW,
      stage: "queued",
    }));
    await world.workflow().relate(world.requestId, {
      taskId: "task-2",
      dependsOn: "task-1",
      reason: "needs the endpoint",
    });

    const dependent = await world.taskStore.read("task-2");
    if (dependent === undefined) throw new Error("dependent task is missing");
    expect(await world.workflow().dispatchHold(dependent)).toContain("waiting for task-1");
    expect(
      await world.workflow().dispatchHold({ ...blocking, requestId: world.requestId }),
    ).toBeUndefined();
  });
});
