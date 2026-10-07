import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { NativeViews } from "../../src/board/native-views.ts";
import { defaultPolicy } from "../../src/config/policy.ts";
import type { CommandRequest, RequestBriefContent } from "../../src/contracts.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord, saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { runTerminal, type TerminalMainDependencies } from "../../src/main.ts";
import { blockOriginProblem, isApprovalVerb, VERB_AUTHORITY } from "../../src/native/actions.ts";
import {
  Action,
  ActionEnvelope,
  blockArgs,
  Outcome,
  setupFile,
  ViewFile,
} from "../../src/native/contract.ts";
import {
  projectStoreDirectory,
  recordVisit,
  viewDetailPath,
  viewIndexPath,
} from "../../src/native/store.ts";
import { SETUP_MODES, type SetupMode } from "../../src/onboarding/setup-view.ts";
import type { SetupApplyResult } from "../../src/onboarding/setup-workflow.ts";
import { withRequestReviewPane } from "../../src/requests/brief.ts";
import { briefView } from "../../src/requests/native-view.ts";
import { createRequestBriefStore } from "../../src/requests/store.ts";
import { createTandemService, type TandemService } from "../../src/service/controller.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type {
  ProvableView,
  TerminalBackend,
  TerminalView,
  ViewsCapability,
} from "../../src/terminal-backend/contract.ts";
import { seedScenarioTask, seedTernProject } from "../evals/scenario.ts";
import type { TernParityHost } from "../evals/tern-parity/harness.ts";
import { seedReview, withParity } from "../evals/tern-parity/inventory.ts";
import { setupViewFixture } from "../onboarding/setup-fixture.ts";
import { viewsOf, viewsWith } from "../terminal-backend/views.ts";
import { prIndexEntry, projectRow, publishFixture, savedState } from "./view-files.ts";

const NOW = "2030-01-01T00:00:00.000Z";
const content: RequestBriefContent = {
  goal: "Open native request views",
  scope: ["brief actions"],
  constraints: [],
  nonGoals: [],
  acceptanceCriteria: ["stale approval is refused"],
  manualVerification: [],
  recommendedApproach: "Reuse request workflows",
  keyDecisions: [],
  openQuestions: [],
  researchLinks: [],
};

async function fixture(terminalName: "herdr" | "tern" = "herdr") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-native-act-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const poolRoot = join(root, "pool");
  const clean = join(poolRoot, "coordinator");
  await mkdir(repo);
  await mkdir(clean, { recursive: true });
  const endpoint = {
    terminal: terminalName,
    ...(terminalName === "tern" ? { terminalSessionId: "1" } : {}),
    sessionId: "isolated",
    workspaceId: "workspace",
    tabId: "tab",
    paneId: "101",
    role: "coordinator",
    generation: 0,
  } as const;
  const command = ["omp", "--cwd", clean, "--session-dir", join(home, "conversation")];
  await saveCoordinatorRecord(home, {
    schemaVersion: 1,
    repoPath: repo,
    endpoint,
    harness: DEFAULT_HARNESS,
    command,
    worktree: {
      root: poolRoot,
      path: clean,
      name: "coordinator",
      baseHead: "a".repeat(40),
      branch: "coord",
      leaseId: "lease",
      leaseHolder: "coordinator:test",
      leasedAt: NOW,
    },
  });
  const prompts: string[] = [];
  const opened: TerminalView[] = [];
  const focused: string[] = [];
  const closed: Parameters<ViewsCapability["close"]>[0][] = [];
  /** The views Tern lists pane 102 as, this coordinator's block; every view unless a test says. */
  let blockViews: readonly ProvableView[] | "any" = "any";
  const proofs: Parameters<ViewsCapability["isView"]>[0][] = [];
  let ownsCoordinator = true;
  const run = async (): Promise<never> => {
    throw new Error("No external commands expected");
  };
  const base = terminalBackend(run, { terminal: terminalName });
  const terminal: TerminalBackend = {
    ...base,
    inspect: async (target) => ({
      endpoint: target.endpoint,
      pane: { ...endpoint, foregroundCwd: clean },
      activeWorker: true,
      processInfo: {
        paneId: endpoint.paneId,
        shellPid: 1,
        foregroundProcessGroupId: 2,
        foregroundProcesses: [
          {
            pid: 2,
            name: "omp",
            argv: ownsCoordinator ? command : ["unrelated"],
            argv0: "omp",
            commandLine: undefined,
          },
        ],
      },
    }),
    listPanes: async () => [
      { ...endpoint, cwd: clean, foregroundCwd: clean },
      ...(terminalName === "tern"
        ? [{ ...endpoint, paneId: "102", cwd: clean, foregroundCwd: clean }]
        : []),
    ],
    focusAgent: async (target) => {
      focused.push(target.paneId ?? "");
      return true;
    },
    promptAgent: async (target) => {
      prompts.push(target.text);
    },
    views: viewsWith(base, {
      open: async (target) => {
        opened.push(target.view);
        return { opened: true, warnings: [] };
      },
      close: async (target) => {
        closed.push(target);
        return { closed: true, warnings: [] };
      },
      isView: async (target) => {
        proofs.push(target);
        return (
          target.origin.paneId === "102" &&
          target.coordinator.paneId === endpoint.paneId &&
          (blockViews === "any" ||
            blockViews.some((view) => JSON.stringify(view) === JSON.stringify(target.view)))
        );
      },
    }),
  };
  let nextId = 0;
  const service = createTandemService({
    home,
    sessionId: "isolated",
    poolRoot,
    run,
    clock: () => NOW,
    idFactory: () => `message-${++nextId}`,
    checkBriefLanguage: async () => [],
  });
  const store = createRequestBriefStore({ home, clock: () => NOW, idFactory: () => "req-native" });
  const record = await store.create({ repoPath: repo, content });
  const seen = {
    briefRevision: record.draft.revision,
    contentDigest: record.draft.contentDigest,
    agreementDigest: record.draft.agreementDigest,
  };
  const deps = {
    cwd: repo,
    processEnvironment: {
      TANDEM_HOME: home,
      TANDEM_SESSION: "isolated",
      TANDEM_POOL_ROOT: poolRoot,
    },
    run,
    terminal,
    service,
    stderr: () => {},
  };
  /** What a block Tandem launched for this coordinator echoes as its origin. */
  const blockOrigin = (
    ctx: Partial<Record<"coordinator" | "cwd" | "home" | "index" | "window", string>> = {},
  ) => ({
    pane: "102",
    ctx: blockArgs(join(home, "view.json"), {
      coordinator: endpoint.paneId,
      cwd: clean,
      home,
      index: viewIndexPath(home, repo),
      ...ctx,
    })[1],
  });
  /**
   * One click through `tandem native act`: an approval-bearing verb from this coordinator's block,
   * anything else from the coordinator pane, unless `origin` says.
   */
  const act = async (
    action: unknown,
    options: Readonly<{ origin?: unknown; deps?: TerminalMainDependencies }> = {},
  ): Promise<Outcome> => {
    const output: string[] = [];
    // A test that builds its own services must not also inherit the fixture's.
    const { service: _service, ...unscoped } = deps;
    const result = await runTerminal(["native", "act"], {
      ...(options.deps?.createService === undefined ? deps : unscoped),
      ...options.deps,
      input: Readable.from([
        JSON.stringify({
          v: 1,
          origin:
            options.origin ??
            (approvalBearing(action) ? blockOrigin() : { pane: "101", cwd: clean }),
          action,
        }),
      ]),
      stdout: (text) => output.push(text),
    });
    expect(result.exitCode).toBe(0);
    return Outcome.parse(JSON.parse(output.join("")));
  };
  return {
    root,
    home,
    repo,
    clean,
    service,
    store,
    record,
    seen,
    deps,
    act,
    prompts,
    opened,
    focused,
    closed,
    proofs,
    endpoint,
    blockOrigin,
    setBlockViews: (views: readonly ProvableView[] | "any") => {
      blockViews = views;
    },
    setOwner: (owns: boolean) => {
      ownsCoordinator = owns;
    },
    close: async () => {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function approvalBearing(action: unknown): boolean {
  const parsed = Action.safeParse(action);
  return parsed.success && isApprovalVerb(parsed.data.verb);
}

const approve = (f: Fixture, seen: Record<string, unknown> = f.seen) => ({
  verb: "brief-approve",
  requestId: f.record.id,
  ...seen,
});

async function createPrTask(f: Fixture) {
  const store = createTaskStore({
    directory: join(f.home, "tasks"),
    clock: () => NOW,
    idFactory: () => "task-pr",
  });
  const task = await store.create({
    repoPath: f.repo,
    kind: "implementation",
    objective: "Fix native views",
    acceptanceCriteria: ["works"],
    surfaces: ["src"],
    policy: {
      config: defaultPolicy(),
      guidance: { implementation: [], validation: [], review: [] },
    },
  });
  return store.update(task.id, task.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    pullRequest: {
      repository: "owner/repo",
      number: 42,
      state: "draft",
      head: "a".repeat(40),
      base: "main",
    },
  }));
}

test("native Approve click records the displayed revision and both digests without another confirmation", async () => {
  const f = await fixture("tern");
  try {
    expect(await f.act(approve(f))).toEqual({ status: "done" });
    expect((await f.store.read(f.record.id))?.approval).toMatchObject({
      requestId: f.record.id,
      ...f.seen,
    });
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain("Approval is already recorded");
  } finally {
    await f.close();
  }
});

for (const changed of ["revision", "content", "agreement", "missing-agreement"]) {
  test(`native approval refuses ${changed} without approving or prompting the coordinator`, async () => {
    const f = await fixture("tern");
    try {
      let seen: Record<string, unknown> = { ...f.seen };
      if (changed === "revision") {
        await f.service.draftRequestBrief({
          repoPath: f.repo,
          requestId: f.record.id,
          content: { ...content, goal: "A different goal" },
          reviewPane: false,
        });
      } else if (changed === "content") seen.contentDigest = "wrong";
      else if (changed === "agreement") seen.agreementDigest = "wrong";
      else {
        const { agreementDigest: _agreement, ...rest } = seen;
        seen = rest;
      }
      expect((await f.act(approve(f, seen))).status).toBe("refused");
      expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
      expect(f.prompts).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

for (const verb of ["brief-request-changes"] as const) {
  test(`${verb} resolves stable line ids through the original historical view`, async () => {
    const f = await fixture("tern");
    try {
      const originalLine = briefView(f.record).lines.find((line) => line.text === content.goal);
      if (originalLine === undefined) throw new Error("Missing displayed goal line");
      await f.service.draftRequestBrief({
        repoPath: f.repo,
        requestId: f.record.id,
        content: {
          ...content,
          goal: "The revised goal",
          openQuestions: ["A newly added question"],
        },
        reviewPane: false,
      });
      const outcome = await f.act({
        verb,
        requestId: f.record.id,
        ...f.seen,
        text: "Keep the original goal",
        comments: [{ lineId: originalLine.id, text: "Keep this goal" }],
      });
      // Delivered against the displayed revision; the newer draft stays open.
      expect(outcome.status).toBe("kept");
      expect(outcome.notice?.code).toBe("brief-left-open");
      expect(f.prompts[0]).toContain("From the open review page:");
      expect(f.prompts[0]).toContain(`Brief ${f.record.id}, revision 1: Request changes`);
      expect(f.prompts[0]).toContain(
        `Line ${originalLine.number} [${originalLine.id}] (${content.goal}):`,
      );
      expect(f.prompts[0]).toContain("Keep this goal");
      expect(f.prompts[0]).not.toContain("The revised goal");
      const latest = await f.store.read(f.record.id);
      if (latest === undefined) throw new Error("Missing revised brief");
      expect(latest.draft.content.goal).toBe("The revised goal");
      expect(latest.approval).toBeUndefined();
      const latestOnlyLine = briefView(latest).lines.find(
        (line) => line.text === "A newly added question",
      );
      if (latestOnlyLine === undefined) throw new Error("Missing new line");
      const refused = await f.act({
        verb,
        requestId: f.record.id,
        ...f.seen,
        comments: [{ lineId: latestOnlyLine.id, text: "Not in old view" }],
      });
      expect(refused.status).toBe("refused");
      expect(refused.notice?.text).toContain("Unknown brief line id");
      expect(f.prompts).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  test(`${verb} refuses invalid line ids, numeric anchors and stale view bindings before delivery`, async () => {
    const f = await fixture("tern");
    try {
      const line = briefView(f.record).lines.find((each) => each.text === content.goal);
      if (line === undefined) throw new Error("Missing displayed goal line");
      const cases: readonly Readonly<Record<string, unknown> & { error: string }>[] = [
        {
          comments: [{ lineId: "unknown:0:0", text: "Unknown id" }],
          error: "Unknown brief line id",
        },
        {
          comments: [{ lineId: ` ${line.id} `, text: "Changed id" }],
          error: "Unknown brief line id",
        },
        { comments: [{ line: line.number, text: "Numeric anchor" }], error: "comments.0" },
        { comments: [{ lineId: line.number, text: "Numeric id" }], error: "comments.0.lineId" },
        { comments: [{ lineId: "", text: "Missing id" }], error: "comments.0.lineId" },
        { briefRevision: 100, error: "stale or unknown brief revision" },
        { contentDigest: "stale", error: "different content digest" },
        { agreementDigest: "stale", error: "different agreement digest" },
      ];
      const retired: string[] = [];
      for (const { error, ...input } of cases) {
        const outcome = await f.act(
          {
            verb,
            requestId: f.record.id,
            ...f.seen,
            comments: [{ lineId: line.id, text: "Feedback" }],
            ...input,
          },
          {
            deps: {
              service: {
                ...f.service,
                closeRequestBriefReview: async (id, revision) => {
                  retired.push(id);
                  return f.service.closeRequestBriefReview(id, revision);
                },
              },
            },
          },
        );
        expect(outcome.status).toBe("refused");
        expect(outcome.notice?.text).toContain(error);
      }
      expect(f.prompts).toEqual([]);
      expect(retired).toEqual([]);
      expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
    } finally {
      await f.close();
    }
  });
}

/** Every approval-bearing verb, as its own block sends it for this fixture's brief and task. */
async function approvalActions(f: Fixture) {
  const task = await createPrTask(f);
  const submission = {
    tandemPrReview: 1,
    verdict: "comment",
    summary: "Looks fine",
    drafts: [],
    yours: [],
  };
  return [
    { verb: "restart", taskId: task.id },
    { verb: "steer", taskId: task.id, text: "Narrow this" },
    approve(f),
    { verb: "brief-request-changes", requestId: f.record.id, ...f.seen, comments: [] },
    { verb: "pr-comment", taskId: task.id, text: "Fix this" },
    {
      verb: "review-submit",
      taskId: task.id,
      reviewHead: "a".repeat(40),
      reviewGeneration: 0,
      submission,
    },
    { verb: "setup-save", answer: { mode: "settings" } },
  ] as const;
}

/** What each approval-bearing verb changed: none of these may move when its origin is refused. */
async function effects(f: Fixture, taskId: string) {
  const task = await f.service.get(taskId);
  return {
    approval: (await f.store.read(f.record.id))?.approval,
    messages: task.communication?.messages.length ?? 0,
    revision: task.revision,
    prompts: f.prompts.length,
    closed: f.closed.length,
  };
}

test("approval classification covers every verb, and only navigation is open to any listed pane", () => {
  const verbs = Action.options.map((option) => option.shape.verb.value).toSorted();
  expect(Object.keys(VERB_AUTHORITY).toSorted()).toEqual(verbs);
  expect(verbs.filter(isApprovalVerb)).toEqual([
    "brief-approve",
    "brief-request-changes",
    "pr-comment",
    "restart",
    "review-submit",
    "setup-save",
    "steer",
  ]);
});

test("an approval-bearing origin must echo exactly this coordinator's block context", () => {
  const expected = { coordinator: "101", cwd: "/clean", home: "/home", index: "/home/index.json" };
  const block = { ...expected };
  expect(blockOriginProblem(block, "102", expected)).toBeUndefined();
  expect(blockOriginProblem(undefined, "102", expected)).toContain("Only Tandem's own view");
  expect(blockOriginProblem(block, "101", expected)).toContain("conversation pane");
  for (const field of ["coordinator", "cwd", "home", "index"] as const)
    expect(blockOriginProblem({ ...block, [field]: "/other" }, "102", expected)).toContain(
      "another coordinator",
    );
});

test("every approval-bearing verb is refused from a worker pane, a window command, the conversation and a forged context", async () => {
  const f = await fixture("tern");
  try {
    const actions = await approvalActions(f);
    const taskId = actions[0].taskId;
    const before = await effects(f, taskId);
    // A worker's pane in the project's session, with its own echoed-looking context.
    const workerPane = { paneId: "103", workspaceId: "worker", tabId: "worker-tab" };
    const terminal: TerminalBackend = {
      ...f.deps.terminal,
      listPanes: async (input) => [
        ...(await f.deps.terminal.listPanes(input)),
        { ...f.endpoint, ...workerPane, cwd: f.clean, foregroundCwd: f.clean },
      ],
    };
    const origins = [
      { name: "worker block-shaped", origin: { ...f.blockOrigin(), pane: "103" } },
      { name: "worker window command", origin: { pane: "103", cwd: f.clean } },
      { name: "window command from the block", origin: { pane: "102", cwd: f.clean } },
      { name: "conversation pane", origin: { ...f.blockOrigin(), pane: "101" } },
      { name: "conversation window command", origin: { pane: "101", cwd: f.clean } },
      { name: "other coordinator", origin: f.blockOrigin({ coordinator: "999" }) },
      { name: "other home", origin: f.blockOrigin({ home: join(f.root, "elsewhere") }) },
      { name: "other index", origin: f.blockOrigin({ index: join(f.root, "index.json") }) },
    ];
    for (const action of actions)
      for (const { name, origin } of origins) {
        const outcome = await f.act(action, { origin, deps: { terminal } });
        expect({ verb: action.verb, name, status: outcome.status }).toEqual({
          verb: action.verb,
          name,
          status: "refused",
        });
        // Another home records no coordinator, so locating the origin refuses first.
        expect(outcome.notice?.code).toBe(name === "other home" ? "failed" : "origin-unproven");
      }
    expect(await effects(f, taskId)).toEqual(before);
    // Window commands and conversation panes never reach Tern's listing.
    expect(f.proofs.every((proof) => proof.origin.paneId === "103")).toBe(true);
  } finally {
    await f.close();
  }
});

test("an approval-bearing verb is refused unless Tern lists its origin as the block for that subject", async () => {
  const f = await fixture("tern");
  try {
    const actions = await approvalActions(f);
    const taskId = actions[0].taskId;
    const before = await effects(f, taskId);
    // Pane 102 is a genuine block of this coordinator, but of another subject.
    f.setBlockViews([{ kind: "brief", requestId: "req-other" }]);
    for (const action of actions) {
      const outcome = await f.act(action);
      expect({ verb: action.verb, outcome: outcome.notice?.code }).toEqual({
        verb: action.verb,
        outcome: "origin-unproven",
      });
    }
    expect(await effects(f, taskId)).toEqual(before);
    const asked = f.proofs.map((proof) => proof.view);
    expect(asked).toContainEqual({ kind: "task", taskId });
    expect(asked).toContainEqual({ kind: "pr", taskId });
    expect(asked).toContainEqual({ kind: "brief", requestId: f.record.id });
    expect(asked).toContainEqual({ kind: "setup", mode: "settings" });
    // A listing Tern cannot read refuses too, with its reason.
    const outcome = await f.act(approve(f), {
      deps: {
        terminal: {
          ...f.deps.terminal,
          views: viewsWith(f.deps.terminal, {
            isView: async () => {
              throw new Error("native view placement or identity is ambiguous");
            },
          }),
        },
      },
    });
    expect(outcome.notice?.code).toBe("origin-unproven");
    expect(outcome.notice?.text).toContain("ambiguous");
    expect(await effects(f, taskId)).toEqual(before);
  } finally {
    await f.close();
  }
});

test("a genuine block click is proved against its own subject and then acts", async () => {
  const f = await fixture("tern");
  try {
    f.setBlockViews([{ kind: "brief", requestId: f.record.id }]);
    expect(await f.act(approve(f))).toEqual({ status: "done" });
    expect((await f.store.read(f.record.id))?.approval).toBeDefined();
    expect(f.proofs).toEqual([
      {
        coordinator: f.endpoint,
        cwd: f.clean,
        home: f.home,
        origin: { paneId: "102" },
        view: { kind: "brief", requestId: f.record.id },
      },
    ]);
    const task = await createPrTask(f);
    f.setBlockViews([{ kind: "pr", taskId: task.id }]);
    expect(await f.act({ verb: "pr-comment", taskId: task.id, text: "Fix this" })).toEqual({
      status: "done",
    });
  } finally {
    await f.close();
  }
});

test("Herdr refuses every approval-bearing verb; approvals stay in the coordinator conversation", async () => {
  const f = await fixture();
  try {
    const actions = await approvalActions(f);
    const taskId = actions[0].taskId;
    const before = await effects(f, taskId);
    // Herdr's terminal hosts no native views at all.
    const terminal = { ...f.deps.terminal, views: undefined };
    for (const action of actions)
      for (const origin of [
        { pane: "101", cwd: f.clean },
        { ...f.blockOrigin(), pane: "101" },
      ]) {
        const outcome = await f.act(action, { origin, deps: { terminal } });
        expect(outcome.status).toBe("refused");
        expect(outcome.notice?.code).toBe("origin-unproven");
        expect(outcome.notice?.text).toContain("coordinator conversation");
      }
    expect(await effects(f, taskId)).toEqual(before);
    // Navigation still works from a window command.
    expect(await f.act({ verb: "open", ref: { kind: "brief", requestId: f.record.id } })).toEqual({
      status: "done",
    });
  } finally {
    await f.close();
  }
});

test("navigational verbs still work from window commands without a block proof", async () => {
  const f = await fixture("tern");
  try {
    const task = await createPrTask(f);
    expect(await f.act({ verb: "open", ref: { kind: "brief", requestId: f.record.id } })).toEqual({
      status: "done",
    });
    expect(await f.act({ verb: "open", ref: { kind: "task-picker" } })).toEqual({
      status: "done",
    });
    expect(f.opened).toEqual([{ kind: "brief", requestId: f.record.id }, { kind: "task-picker" }]);
    expect(f.proofs).toEqual([]);
    expect(task.id).toBe("task-pr");
  } finally {
    await f.close();
  }
});

test("brief feedback refuses a coordinator pane occupied by another process", async () => {
  const f = await fixture("tern");
  try {
    f.setOwner(false);
    const outcome = await f.act({
      verb: "brief-request-changes",
      requestId: f.record.id,
      ...f.seen,
      text: "Valid feedback",
      comments: [],
    });
    expect(outcome.status).toBe("refused");
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("native brief actions refuse another project's request before ownership or mutation", async () => {
  const f = await fixture("tern");
  try {
    const otherRepo = join(f.root, "another-project");
    await mkdir(otherRepo);
    const otherStore = createRequestBriefStore({
      home: f.home,
      clock: () => NOW,
      idFactory: () => "req-other-project",
    });
    const foreign = await otherStore.create({ repoPath: otherRepo, content });
    const seen = {
      requestId: foreign.id,
      briefRevision: foreign.draft.revision,
      contentDigest: foreign.draft.contentDigest,
      agreementDigest: foreign.draft.agreementDigest,
    };
    let inspections = 0;
    for (const action of [
      { verb: "brief-request-changes", ...seen, text: "Foreign feedback", comments: [] },
      { verb: "brief-approve", ...seen },
      { verb: "open", ref: { kind: "brief", requestId: foreign.id } },
    ]) {
      const outcome = await f.act(action, {
        deps: {
          terminal: {
            ...f.deps.terminal,
            inspect: async (input) => {
              inspections += 1;
              return f.deps.terminal.inspect(input);
            },
          },
        },
      });
      expect(outcome.status).toBe("refused");
      expect(outcome.notice?.text).toContain(
        "brief does not belong to the selected Tandem project",
      );
    }
    expect(inspections).toBe(0);
    expect((await otherStore.read(foreign.id))?.approval).toBeUndefined();
    expect(f.prompts).toEqual([]);
    expect(f.opened).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a corrupt unrelated record cannot disable a native action in the same session", async () => {
  const f = await fixture("tern");
  try {
    await writeFile(recordPath(f.home, "isolated", join(f.root, "corrupt-project")), "{broken");
    const outcome = await f.act({
      verb: "brief-request-changes",
      requestId: f.record.id,
      ...f.seen,
      text: "Feedback still reaches this project",
      comments: [],
    });
    expect(outcome.status).toBe("done");
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain("Feedback still reaches this project");
  } finally {
    await f.close();
  }
});

test("an unreadable only candidate is refused clearly without opening or prompting", async () => {
  const f = await fixture();
  try {
    await writeFile(recordPath(f.home, "isolated", f.repo), "{broken");
    const outcome = await f.act({ verb: "open", ref: { kind: "brief", requestId: f.record.id } });
    expect(outcome.status).toBe("refused");
    expect(outcome.notice?.text).toContain("no readable matching coordinator");
    expect(outcome.notice?.text).toContain("unreadable records were skipped");
    expect(f.opened).toEqual([]);
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a dead recorded session is a non-match, while two live matches remain ambiguous", async () => {
  const f = await fixture();
  try {
    const current = await readCoordinatorRecord(recordPath(f.home, "isolated", f.repo));
    if (current === undefined) throw new Error("Fixture coordinator record is missing");
    const otherClean = join(current.worktree.root, "other-coordinator");
    await mkdir(otherClean);
    await saveCoordinatorRecord(f.home, {
      ...current,
      endpoint: { ...current.endpoint, sessionId: "other-session" },
      worktree: {
        ...current.worktree,
        path: otherClean,
        name: "other-coordinator",
        leaseId: "other-lease",
        leaseHolder: "coordinator:other",
      },
      command: ["omp", "--cwd", otherClean, "--session-dir", join(f.home, "other-conversation")],
    });
    let dead = true;
    const terminal: TerminalBackend = {
      ...f.deps.terminal,
      listPanes: async (input) => {
        if (input.sessionId === "other-session" && dead) throw new Error("Session has stopped");
        return [{ paneId: "202", workspaceId: "workspace", tabId: "tab", cwd: f.repo }];
      },
    };
    const action = { verb: "open", ref: { kind: "brief", requestId: f.record.id } };
    const origin = { pane: "202", cwd: f.repo };
    expect((await f.act(action, { origin, deps: { terminal } })).status).toBe("done");
    expect(f.opened).toHaveLength(1);
    dead = false;
    const ambiguous = await f.act(action, { origin, deps: { terminal } });
    expect(ambiguous.status).toBe("refused");
    expect(ambiguous.notice?.text).toContain("exactly one Tandem project");
    expect(f.opened).toHaveLength(1);
    const unavailable = await f.act(action, {
      origin,
      deps: {
        terminal: {
          ...terminal,
          listPanes: async () => {
            throw new Error("Session has stopped");
          },
        },
      },
    });
    expect(unavailable.status).toBe("refused");
    expect(unavailable.notice?.text).toContain("no live matching coordinator session");
  } finally {
    await f.close();
  }
});

test("Tandem PR comments become durable worker fix requests without any GitHub call", async () => {
  const f = await fixture("tern");
  try {
    const task = await createPrTask(f);
    expect(
      await f.act({
        verb: "pr-comment",
        taskId: task.id,
        text: "Please fix these",
        comments: [
          { file: "src/view.ts", line: 12, text: "Handle an empty list\nbefore rendering" },
        ],
      }),
    ).toEqual({ status: "done" });
    const current = await f.service.get(task.id);
    expect(current.communication?.messages[0]?.text).toContain(
      "PR fix request: src/view.ts:12: Handle an empty list before rendering Please fix these",
    );
    expect(current.scopeApproved).toBe(false);
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const kind of ["task", "brief", "pr"] as const) {
  test(`open ${kind} asks the terminal port to present the validated durable identity`, async () => {
    const f = await fixture();
    try {
      const ref =
        kind === "brief"
          ? { kind, requestId: f.record.id }
          : kind === "task"
            ? { kind, taskId: (await createPrTask(f)).id }
            : { kind, number: (await createPrTask(f)).pullRequest?.number };
      expect(await f.act({ verb: "open", ref })).toEqual({ status: "done" });
      expect(f.opened).toEqual([
        kind === "brief" ? { kind, requestId: f.record.id } : { kind, taskId: "task-pr" },
      ]);
      expect(f.prompts).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test("Herdr reports unsupported native views and uses its existing review pane for briefs", async () => {
  const f = await fixture();
  try {
    const terminal = { ...f.deps.terminal, views: undefined };
    const task = await createPrTask(f);
    const unsupported = await f.act(
      { verb: "open", ref: { kind: "task", taskId: task.id } },
      { deps: { terminal } },
    );
    expect(unsupported.status).toBe("refused");
    expect(unsupported.notice?.text).toContain("Herdr cannot display a native task view");
    const reviews: string[] = [];
    const service = {
      ...f.service,
      reviewRequestBrief: async (id: string) => {
        reviews.push(id);
        const brief = await f.service.requestBrief(id);
        return {
          ...brief,
          record: {
            ...brief.record,
            reviewPane: {
              status: "open" as const,
              endpoint: {
                terminal: "herdr" as const,
                sessionId: "isolated",
                workspaceId: "workspace",
                tabId: "tab",
                paneId: "review",
                role: "coordinator" as const,
                generation: 0,
              },
              renderedRevision: brief.record.draft.revision,
              renderedPath: join(f.home, "brief.md"),
              observedAt: NOW,
            },
          },
        };
      },
    };
    const brief = { verb: "open", ref: { kind: "brief", requestId: f.record.id } };
    expect(await f.act(brief, { deps: { service, terminal } })).toEqual({ status: "done" });
    expect(reviews).toEqual([f.record.id]);
    const refused = await f.act(brief, {
      origin: { pane: "101", cwd: f.clean, window: "opaque" },
      deps: { service, terminal },
    });
    expect(refused.status).toBe("refused");
    expect(refused.notice?.text).toContain("Herdr cannot target an opaque Tern control window");
    expect(reviews).toEqual([f.record.id]);
    const unopened = await f.act(brief, {
      deps: { service: { ...f.service, reviewRequestBrief: f.service.requestBrief }, terminal },
    });
    expect(unopened.status).toBe("refused");
    expect(unopened.notice?.text).toContain("could not be opened");
  } finally {
    await f.close();
  }
});

test("native review submit routes to the existing page submission service and refuses malformed submissions", async () => {
  const f = await fixture("tern");
  try {
    const submissions: unknown[] = [];
    const service = {
      ...f.service,
      reviewSubmit: async (id: string, submission: unknown, expected: unknown) => {
        submissions.push({ submission, expected });
        return { taskId: id, posted: false, message: "The reviewed head moved" };
      },
    };
    const submission = {
      tandemPrReview: 1,
      verdict: "approve",
      summary: "Looks good",
      drafts: [],
      yours: [],
    };
    const submit = (fields: Record<string, unknown>) =>
      f.act({ verb: "review-submit", taskId: "task-review", ...fields }, { deps: { service } });
    expect(await submit({ reviewHead: "displayed-head", reviewGeneration: 0, submission })).toEqual(
      {
        status: "kept",
        notice: { code: "review-unconfirmed", text: "The reviewed head moved" },
      },
    );
    expect(submissions).toEqual([
      { submission, expected: { head: "displayed-head", generation: 0 } },
    ]);
    for (const invalid of [
      {},
      { reviewHead: "displayed-head" },
      { reviewGeneration: 0 },
      { reviewHead: "displayed-head", reviewGeneration: -1 },
      { reviewHead: "displayed-head", reviewGeneration: 0.5 },
      { reviewHead: "displayed-head", reviewGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { reviewHead: " displayed-head ", reviewGeneration: 0 },
    ])
      expect((await submit({ ...invalid, submission })).status).toBe("refused");
    expect(
      (
        await submit({
          reviewHead: "displayed-head",
          reviewGeneration: 0,
          submission: { text: "a comment containing JSON is not a submission" },
        })
      ).status,
    ).toBe("refused");
    expect(submissions).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a posted review is done and names where it landed", async () => {
  const f = await fixture("tern");
  try {
    const service = {
      ...f.service,
      reviewSubmit: async (id: string) => ({
        taskId: id,
        posted: true,
        message: "Posted 1 comment",
      }),
    };
    expect(
      await f.act(
        {
          verb: "review-submit",
          taskId: "task-review",
          reviewHead: "head",
          reviewGeneration: 0,
          submission: { tandemPrReview: 1, verdict: "comment", summary: "", drafts: [], yours: [] },
        },
        { deps: { service } },
      ),
    ).toEqual({ status: "done", notice: { code: "review-posted", text: "Posted 1 comment" } });
  } finally {
    await f.close();
  }
});

test("a failed coordinator notification reports the recorded approval instead of inviting an approval retry", async () => {
  const f = await fixture("tern");
  try {
    const outcome = await f.act(approve(f), {
      deps: {
        terminal: {
          ...f.deps.terminal,
          promptAgent: async () => {
            throw new Error("coordinator disconnected");
          },
        },
      },
    });
    expect(outcome).toEqual({
      status: "done",
      notice: {
        code: "brief-warning",
        text: "Approval was recorded, but the coordinator could not be notified: coordinator disconnected",
      },
    });
    expect((await f.store.read(f.record.id))?.approval).toMatchObject(f.seen);
  } finally {
    await f.close();
  }
});

for (const state of ["closed", "merged", "completed"] as const) {
  test(`comments on a ${state} PR task are refused without recording a worker direction`, async () => {
    const f = await fixture("tern");
    try {
      const task = await createPrTask(f);
      const store = createTaskStore({
        directory: join(f.home, "tasks"),
        clock: () => NOW,
        idFactory: () => "task-pr",
      });
      await store.update(task.id, task.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        ...(state === "completed"
          ? { stage: "completed" as const }
          : {
              pullRequest: {
                repository: "owner/repo",
                number: 42,
                state,
                head: "a".repeat(40),
                base: "main",
              },
            }),
      }));
      const outcome = await f.act({ verb: "pr-comment", taskId: task.id, text: "Fix this" });
      expect(outcome.status).toBe("refused");
      if (state === "completed") expect(outcome.notice?.text).toContain("worker has finished");
      expect((await f.service.get(task.id)).communication?.messages).toBeUndefined();
    } finally {
      await f.close();
    }
  });
}

test("a numeric PR route resolves its durable task and refuses an ambiguous PR number", async () => {
  const f = await fixture();
  try {
    const task = await createPrTask(f);
    const open = { verb: "open", ref: { kind: "pr", number: 42 } };
    expect((await f.act(open)).status).toBe("done");
    expect(f.opened).toEqual([{ kind: "pr", taskId: task.id }]);
    const store = createTaskStore({
      directory: join(f.home, "tasks"),
      clock: () => NOW,
      idFactory: () => "another-task",
    });
    const other = await store.create({
      repoPath: f.repo,
      kind: "implementation",
      objective: "Another task",
      acceptanceCriteria: ["works"],
      surfaces: ["src"],
      policy: {
        config: defaultPolicy(),
        guidance: { implementation: [], validation: [], review: [] },
      },
    });
    await store.update(other.id, other.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      pullRequest: {
        repository: "owner/repo",
        number: 42,
        state: "draft",
        head: "a".repeat(40),
        base: "main",
      },
    }));
    const ambiguous = await f.act(open);
    expect(ambiguous.status).toBe("refused");
    expect(ambiguous.notice?.text).toContain("More than one task");
    expect(f.opened).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const windowKey of [undefined, "opaque-control-window"] as const) {
  test(`native open carries exact pane/cwd context with window key ${windowKey ?? "absent"}`, async () => {
    const f = await fixture();
    try {
      const task = await createPrTask(f);
      const origins: unknown[] = [];
      const scopes: unknown[] = [];
      const { service: _injectedService, ...dependencies } = f.deps;
      const outcome = await f.act(
        { verb: "open", ref: { kind: "pr", number: 42 } },
        {
          origin: {
            pane: "101",
            cwd: f.clean,
            ...(windowKey === undefined ? {} : { window: windowKey }),
          },
          deps: {
            ...dependencies,
            terminal: {
              ...f.deps.terminal,
              views: viewsWith(f.deps.terminal, {
                open: async (input) => {
                  origins.push(input.origin);
                  return viewsOf(f.deps.terminal).open(input);
                },
              }),
            },
            createService: (options) => {
              scopes.push(options.sourceWorkspace);
              return createTandemService({
                ...options,
                run: f.deps.run,
                clock: () => NOW,
                checkBriefLanguage: async () => [],
              });
            },
            processEnvironment: { ...f.deps.processEnvironment, TANDEM_SESSION: "another-session" },
          },
        },
      );
      expect(outcome.status).toBe("done");
      expect(scopes).toEqual([{ repoPath: f.repo, path: f.clean }]);
      expect(origins).toEqual([
        {
          paneId: "101",
          cwd: f.clean,
          ...(windowKey === undefined ? {} : { windowId: windowKey }),
        },
      ]);
      expect(f.opened).toEqual([{ kind: "pr", taskId: task.id }]);
    } finally {
      await f.close();
    }
  });
}

test("a block's echoed context names the Tandem home and cwd; anything else is refused", async () => {
  const f = await fixture("tern");
  try {
    const [, ctx] = blockArgs(join(f.home, "view.json"), {
      coordinator: "101",
      cwd: f.clean,
      home: f.home,
      index: join(f.home, "index.json"),
      window: "block-window",
    });
    const origins: unknown[] = [];
    const deps = {
      // The process's own home is elsewhere; only the block's context selects this project.
      processEnvironment: { TANDEM_HOME: join(f.root, "different-home") },
      terminal: {
        ...f.deps.terminal,
        views: viewsWith(f.deps.terminal, {
          open: async (input) => {
            origins.push(input.origin);
            return viewsOf(f.deps.terminal).open(input);
          },
        }),
      },
    };
    const open = { verb: "open", ref: { kind: "brief", requestId: f.record.id } };
    expect((await f.act(open, { origin: { pane: "102", ctx }, deps })).status).toBe("done");
    expect(origins).toEqual([{ paneId: "102", cwd: f.clean, windowId: "block-window" }]);
    for (const tampered of [JSON.stringify(JSON.parse(ctx), null, 1), "{}", "not a context"]) {
      const refused = await f.act(open, { origin: { pane: "102", ctx: tampered }, deps });
      expect(refused.status).toBe("refused");
    }
    expect(origins).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("native actions refuse missing or invalid origin context before reading panes or acting", async () => {
  const f = await fixture();
  try {
    const invalidOrigins = [
      undefined,
      {},
      { cwd: f.repo },
      { pane: "101" },
      { pane: 101, cwd: f.repo },
      { pane: "1.5", cwd: f.repo },
      { pane: " 101 ", cwd: f.repo },
      { pane: "-1", cwd: f.repo },
      { pane: "0101", cwd: f.repo },
      { pane: "101", cwd: "relative/path" },
      { pane: "101", cwd: f.repo, extra: true },
    ];
    let reads = 0;
    const terminal = {
      ...f.deps.terminal,
      listPanes: async (input: Parameters<TerminalBackend["listPanes"]>[0]) => {
        reads += 1;
        return f.deps.terminal.listPanes(input);
      },
    };
    for (const origin of invalidOrigins)
      for (const action of [
        { verb: "open", ref: { kind: "brief", requestId: f.record.id } },
        approve(f),
        { verb: "restart", taskId: "task-example" },
        { verb: "steer", taskId: "task-example", text: "Fix this" },
      ]) {
        const output: string[] = [];
        await runTerminal(["native", "act"], {
          ...f.deps,
          terminal,
          input: Readable.from([JSON.stringify({ v: 1, origin, action })]),
          stdout: (text) => output.push(text),
        });
        const outcome = Outcome.parse(JSON.parse(output.join("")));
        expect(outcome.status).toBe("refused");
        expect(outcome.notice?.text).toContain("origin");
      }
    expect(reads).toBe(0);
    expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
    expect(f.prompts).toEqual([]);
    expect(f.opened).toEqual([]);
  } finally {
    await f.close();
  }
});

test("native act takes one bounded JSON envelope and nothing else", async () => {
  const f = await fixture();
  try {
    const run = async (argv: readonly string[], input: string) => {
      const output: string[] = [];
      const result = await runTerminal(argv, {
        ...f.deps,
        input: Readable.from([input]),
        stdout: (text) => output.push(text),
      });
      return { exitCode: result.exitCode, output: output.join("") };
    };
    const action = JSON.stringify({
      v: 1,
      origin: { pane: "101", cwd: f.clean },
      action: { verb: "open", ref: { kind: "brief", requestId: f.record.id } },
    });
    expect((await run(["native", "open", "brief", f.record.id], action)).exitCode).not.toBe(0);
    expect((await run(["native", "act", "extra"], action)).exitCode).not.toBe(0);
    expect((await run(["native", "act"], `${action}${" ".repeat(1024 * 1024)}`)).exitCode).not.toBe(
      0,
    );
    for (const malformed of ["", "{", JSON.stringify({ ...JSON.parse(action), v: 2 })]) {
      const result = await run(["native", "act"], malformed);
      expect(result.exitCode).toBe(0);
      expect(Outcome.parse(JSON.parse(result.output)).status).toBe("refused");
    }
    expect(f.opened).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const outcome of ["refusal", "failure"] as const) {
  test(`native open reports backend ${outcome} as a refusal and never retries`, async () => {
    const f = await fixture();
    try {
      let attempts = 0;
      const reason =
        outcome === "refusal" ? "Ambiguous control window for pane 101" : "Tern control failed";
      const result = await f.act(
        { verb: "open", ref: { kind: "brief", requestId: f.record.id } },
        {
          deps: {
            terminal: {
              ...f.deps.terminal,
              views: viewsWith(f.deps.terminal, {
                open: async () => {
                  attempts += 1;
                  if (outcome === "failure") throw new Error(reason);
                  return { opened: false, warnings: [reason] };
                },
              }),
            },
          },
        },
      );
      expect(result).toEqual({ status: "refused", notice: { code: "failed", text: reason } });
      expect(attempts).toBe(1);
    } finally {
      await f.close();
    }
  });
}

test("native open refuses a pane no recorded coordinator session lists", async () => {
  const f = await fixture();
  try {
    const outcome = await f.act(
      { verb: "open", ref: { kind: "brief", requestId: f.record.id } },
      { origin: { pane: "999", cwd: f.repo, window: "own-window" } },
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.notice?.text).toContain("exactly one Tandem project");
    expect(f.opened).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const result of ["opened", "refused"] as const)
  test(`native task picker ${result} preserves exact origin and never retries`, async () => {
    const f = await fixture("tern");
    const calls: Parameters<ViewsCapability["open"]>[0][] = [];
    try {
      const outcome = await f.act(
        { verb: "open", ref: { kind: "task-picker" } },
        {
          origin: { pane: "101", cwd: f.repo, window: "own-window" },
          deps: {
            terminal: {
              ...f.deps.terminal,
              views: viewsWith(f.deps.terminal, {
                open: async (input) => {
                  calls.push(input);
                  return {
                    opened: result === "opened",
                    warnings: result === "opened" ? [] : ["Picker unavailable"],
                  };
                },
              }),
            },
          },
        },
      );
      expect(outcome.status).toBe(result === "opened" ? "done" : "refused");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        view: { kind: "task-picker" },
        origin: { paneId: "101", cwd: f.repo, windowId: "own-window" },
        home: f.home,
      });
      if (result === "refused") expect(outcome.notice?.text).toContain("Picker unavailable");
    } finally {
      await f.close();
    }
  });

test("an open that returns warnings keeps its origin and says the view is uncertain", async () => {
  const f = await fixture("tern");
  try {
    const warning = "Returned to your conversation. An earlier view could not be verified.";
    const outcome = await f.act(
      { verb: "open", ref: { kind: "orchestrator" } },
      {
        deps: {
          terminal: {
            ...f.deps.terminal,
            views: viewsWith(f.deps.terminal, {
              open: async () => ({ opened: true, warnings: [warning] }),
            }),
          },
        },
      },
    );
    expect(outcome).toEqual({ status: "kept", notice: { code: "view-kept", text: warning } });
  } finally {
    await f.close();
  }
});

const NEW_REQUEST = { verb: "open", ref: { kind: "new-request" } };

test("New request focuses the owned coordinator and asks for conversational intake", async () => {
  const f = await fixture();
  try {
    expect(await f.act(NEW_REQUEST)).toEqual({ status: "done" });
    expect(f.focused).toEqual(["101"]);
    expect(f.prompts).toEqual([
      "I'd like to start a new request. Ask me what I want to change, then help me plan it in this conversation.",
    ]);
    expect(await f.service.list()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("New request refuses an occupied coordinator and sends nothing after failed focus", async () => {
  const f = await fixture();
  try {
    f.setOwner(false);
    expect((await f.act(NEW_REQUEST)).status).toBe("refused");
    expect(f.prompts).toEqual([]);
    f.setOwner(true);
    const failed = await f.act(NEW_REQUEST, {
      deps: { terminal: { ...f.deps.terminal, focusAgent: async () => false } },
    });
    expect(failed.notice?.text).toContain("could not be focused");
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("New request rechecks coordinator ownership after focusing before sending input", async () => {
  const f = await fixture();
  try {
    const outcome = await f.act(NEW_REQUEST, {
      deps: {
        terminal: {
          ...f.deps.terminal,
          focusAgent: async () => {
            f.setOwner(false);
            return true;
          },
        },
      },
    });
    expect(outcome.status).toBe("refused");
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("Show PRs opens the cached repository-qualified PR in the originating project without fetching GitHub", async () => {
  const f = await fixture("tern");
  try {
    const task = await createPrTask(f);
    await publishFixture(f.home, f.repo, {
      writtenAt: NOW,
      pullRequests: prIndexEntry("owner/repo", 42, task.id),
    });
    const prs = { verb: "open", ref: { kind: "prs" } };
    expect((await f.act(prs)).status).toBe("done");
    expect(f.opened).toEqual([{ kind: "pr", repo: "owner/repo", number: 42 }]);
    await publishFixture(f.home, f.repo, { writtenAt: NOW, pullRequests: {} });
    expect((await f.act(prs)).status).toBe("refused");
    expect(f.opened).toHaveLength(1);
    // Ownership is proved before reading the cache, even with a valid locating pane/cwd.
    await writeFile(join(projectStoreDirectory(f.home, f.repo), "state.json"), "{broken");
    const refused = await f.act(prs, {
      deps: {
        terminal: {
          ...f.deps.terminal,
          inspect: async () => {
            throw new Error("Cannot prove coordinator ownership");
          },
        },
      },
    });
    expect(refused.status).toBe("refused");
    expect(refused.notice?.text).toContain("Cannot prove coordinator ownership");
    expect(f.opened).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("project switching selects published projects, refusing stale or foreign targets", async () => {
  const f = await fixture("tern");
  try {
    const current = projectRow(f.repo, { current: true, sessionId: "isolated" });
    const model = { changeSignature: "changed-work", projects: [current] };
    const publish = (change: Partial<NativeViews>) => publishFixture(f.home, f.repo, change);
    await publish(model);
    await recordVisit(f.home, f.repo, {
      kind: "entry",
      signature: "earlier-work",
      now: new Date(Date.now() - 2 * 3600000).toISOString(),
      showCatchUp: async () => {},
    });
    const project = (target: unknown) => f.act({ verb: "project", target });
    expect((await project("next")).status).toBe("done");
    expect(f.focused).toEqual(["101"]);
    expect(f.opened).toEqual([{ kind: "catchup" }]);
    const tenth = [
      ...Array.from({ length: 9 }, (_, index) =>
        projectRow(`/fixture/${index}`, { offline: true }),
      ),
      current,
    ];
    await publish({ ...model, projects: tenth });
    expect((await project({ repoPath: f.repo })).status).toBe("done");
    await publish({ ...model, projects: [...tenth].reverse() });
    expect((await project({ repoPath: f.repo })).status).toBe("done");
    expect((await project({ repoPath: "/foreign/project" })).status).toBe("refused");
    expect(f.focused).toHaveLength(3);
    for (const target of [0, 10, "unknown", "repo:/fixture/0", { repoPath: "relative" }])
      expect((await project(target)).status).toBe("refused");
    await publish({ ...model, writtenAt: "2000-01-01T00:00:00Z" });
    const stale = await project(1);
    expect(stale.notice?.text).toBe("Project switcher is stale; wait for the coordinator snapshot");
    await publish({ ...model, projects: [{ ...current, current: false }] });
    expect((await project("prev")).status).toBe("refused");
    await publish({ ...model, projects: [{ ...current, offline: true }] });
    expect((await project(1)).status).toBe("refused");
    expect(f.focused).toHaveLength(3);
    expect(f.opened).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const status of ["closed", "retained", "quarantined"] as const) {
  test(`native approval never retries workflow retirement when its receipt is ${status}`, async () => {
    const f = await fixture("tern");
    try {
      const outcome = await f.act(approve(f), {
        origin: f.blockOrigin(),
        deps: {
          service: {
            ...f.service,
            approveRequestBrief: async (intent) => {
              const approved = await f.service.approveRequestBrief(intent);
              await f.store.update(approved.record.id, approved.record.revision, (current) =>
                withRequestReviewPane(
                  current,
                  {
                    status,
                    endpoint: { ...f.endpoint, paneId: "102" },
                    renderedRevision: 1,
                    renderedPath: join(f.home, "native-views", "brief.json"),
                    observedAt: NOW,
                    ...(status === "closed" ? {} : { reason: "retirement not confirmed" }),
                  },
                  NOW,
                ),
              );
              return f.service.requestBrief(approved.record.id);
            },
          },
        },
      });
      expect(f.closed).toHaveLength(0);
      if (status === "closed") expect(outcome).toEqual({ status: "done" });
      else {
        expect(outcome.status).toBe("kept");
        expect(outcome.notice?.text).toContain("Do not resubmit");
      }
    } finally {
      await f.close();
    }
  });
}

for (const failure of [
  "catchup-refused",
  "catchup-thrown",
  "focus-refused",
  "focus-thrown",
] as const) {
  test(`native project switch preserves focus and the unacknowledged visit on optional catch-up failure: ${failure}`, async () => {
    const source = await fixture("tern");
    const destination = await fixture("tern");
    try {
      const saved = await readCoordinatorRecord(
        recordPath(destination.home, "isolated", destination.repo),
      );
      if (saved === undefined) throw new Error("Missing destination fixture coordinator");
      const record = { ...saved, endpoint: { ...saved.endpoint, paneId: "202" } };
      await saveCoordinatorRecord(source.home, record);
      const projects = [
        projectRow(source.repo, { current: true, sessionId: "isolated" }),
        projectRow(destination.repo, { sessionId: "isolated" }),
      ];
      await publishFixture(source.home, source.repo, { changeSignature: "before", projects });
      await publishFixture(source.home, destination.repo, { changeSignature: "after", projects });
      await recordVisit(source.home, destination.repo, {
        kind: "entry",
        signature: "before",
        now: new Date(Date.now() - 2 * 3600000).toISOString(),
        showCatchUp: async () => {},
      });
      const visit = async () =>
        JSON.stringify((await savedState(source.home, destination.repo))?.visit);
      const before = await visit();
      const events: string[] = [];
      const outcome = await source.act(
        { verb: "project", target: "next" },
        {
          deps: {
            terminal: {
              ...source.deps.terminal,
              inspect: (input) =>
                input.endpoint.paneId === "202"
                  ? destination.deps.terminal.inspect(input)
                  : source.deps.terminal.inspect(input),
              focusAgent: async (input) => {
                events.push("focus");
                expect(input.paneId).toBe("202");
                if (failure === "focus-thrown") throw new Error("fixture focus failure");
                return failure !== "focus-refused";
              },
              views: viewsWith(source.deps.terminal, {
                open: async (input) => {
                  events.push("catchup");
                  expect(input.coordinator).toEqual(record.endpoint);
                  if (failure === "catchup-thrown") throw new Error("fixture catch-up failure");
                  return { opened: false, warnings: ["fixture catch-up failure"] };
                },
              }),
            },
          },
        },
      );
      const catchUpFailure = failure.startsWith("catchup");
      expect(events).toEqual(catchUpFailure ? ["focus", "catchup"] : ["focus"]);
      expect(await visit()).toBe(before);
      if (catchUpFailure)
        expect(outcome).toEqual({
          status: "done",
          notice: {
            code: "catch-up-unavailable",
            text: "Project opened, but catch-up is unavailable: fixture catch-up failure",
          },
        });
      else {
        expect(outcome.status).toBe("refused");
        expect(outcome.notice?.text).toContain(
          failure === "focus-thrown" ? "fixture focus failure" : "could not focus",
        );
      }
    } finally {
      await source.close();
      await destination.close();
    }
  });
}

for (const verb of ["brief-approve", "brief-request-changes"] as const) {
  const action = (f: Fixture) =>
    verb === "brief-approve"
      ? approve(f)
      : { verb, requestId: f.record.id, ...f.seen, text: "Narrow this scope", comments: [] };

  test(`${verb} closes only its native brief origin after recording or delivering the action`, async () => {
    const f = await fixture("tern");
    try {
      expect(await f.act(action(f), { origin: f.blockOrigin({ window: "brief-window" }) })).toEqual(
        { status: "done" },
      );
      expect(f.prompts).toHaveLength(1);
      expect(f.closed).toEqual([
        {
          coordinator: f.endpoint,
          cwd: f.clean,
          home: f.home,
          origin: { paneId: "102", windowId: "brief-window" },
          view: { kind: "brief", requestId: f.record.id },
        },
      ]);
    } finally {
      await f.close();
    }
  });

  test(`${verb} keeps a newer native brief open and says so, not that it completed`, async () => {
    const f = await fixture("tern");
    try {
      const outcome = await f.act(action(f), {
        origin: f.blockOrigin(),
        deps: {
          terminal: {
            ...f.deps.terminal,
            promptAgent: async (target) => {
              f.prompts.push(target.text);
              await f.service.draftRequestBrief({
                requestId: f.record.id,
                repoPath: f.repo,
                content: { ...content, goal: "A newer draft" },
                reviewPane: false,
              });
            },
          },
        },
      });
      expect(outcome).toEqual({
        status: "kept",
        notice: {
          code: "brief-left-open",
          text: "The brief changed after this action; the current brief was left open. Do not resubmit this action.",
        },
      });
      expect(f.prompts).toHaveLength(1);
      expect(f.closed).toEqual([]);
      expect((await f.store.read(f.record.id))?.draft.revision).toBe(2);
    } finally {
      await f.close();
    }
  });

  test(`${verb} reports an uncertain native close as kept without retrying delivery or closure`, async () => {
    const f = await fixture("tern");
    let attempts = 0;
    try {
      const outcome = await f.act(action(f), {
        origin: f.blockOrigin(),
        deps: {
          terminal: {
            ...f.deps.terminal,
            views: viewsWith(f.deps.terminal, {
              close: async () => {
                attempts++;
                throw new Error("native close acknowledgement was lost");
              },
            }),
          },
        },
      });
      expect(outcome.status).toBe("kept");
      expect(outcome.notice?.code).toBe("brief-warning");
      expect(outcome.notice?.text).toContain("Do not resubmit this action");
      expect(attempts).toBe(1);
      expect(f.prompts).toHaveLength(1);
      if (verb === "brief-approve")
        expect((await f.store.read(f.record.id))?.approval).toBeDefined();
    } finally {
      await f.close();
    }
  });
}

test("a refused native approval never closes the brief or prompts the coordinator", async () => {
  const f = await fixture("tern");
  try {
    const outcome = await f.act(approve(f, { ...f.seen, contentDigest: "stale" }), {
      origin: f.blockOrigin(),
    });
    expect(outcome.status).toBe("refused");
    expect(f.closed).toEqual([]);
    expect(f.prompts).toEqual([]);
    expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("cached taskless PRs open from palette, repo and number, number alone, without mutation", async () => {
  const f = await fixture("tern");
  try {
    await publishFixture(f.home, f.repo, {
      writtenAt: NOW,
      pullRequests: prIndexEntry("owner/repo", 43),
    });
    for (const ref of [
      { kind: "prs" },
      { kind: "pr", repo: "owner/repo", number: 43 },
      { kind: "pr", number: 43 },
    ])
      expect(await f.act({ verb: "open", ref })).toEqual({ status: "done" });
    expect(f.opened).toEqual(Array(3).fill({ kind: "pr", repo: "owner/repo", number: 43 }));
    expect(await f.service.list()).toEqual([]);
    expect(
      (await f.act({ verb: "pr-comment", taskId: "owner/repo#43", text: "Fix this" })).status,
    ).toBe("refused");
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("owned PR thread replies retain exact context in a worker fix request without GitHub writes", async () => {
  const f = await fixture("tern");
  try {
    const task = await createPrTask(f);
    const reply = {
      threadId: "thread-second",
      commentId: "node-second",
      replyTo: 22,
      body: "Keep this guard",
    };
    const calls: string[][] = [];
    const run = async (request: CommandRequest) => {
      calls.push([...request.argv]);
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                headRefOid: "a".repeat(40),
                reviewThreads: {
                  nodes: [
                    {
                      id: reply.threadId,
                      path: "removed.ts",
                      line: null,
                      diffSide: "RIGHT",
                      isResolved: false,
                      isOutdated: true,
                      comments: {
                        nodes: [
                          {
                            id: reply.commentId,
                            databaseId: 22,
                            author: { login: "sam" },
                            createdAt: NOW,
                            body: "Earlier guard",
                          },
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      };
    };
    const comment = (replies: unknown) =>
      f.act(
        { verb: "pr-comment", taskId: task.id, reviewHead: "a".repeat(40), replies },
        { deps: { run } },
      );
    expect(await comment([reply])).toEqual({ status: "done" });
    expect((await f.service.get(task.id)).communication?.messages[0]?.text).toContain(
      "thread thread-second, root comment node-second (GitHub 22), removed.ts (outside current diff): Keep this guard",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.includes("POST")).toBe(false);
    expect((await comment([{ ...reply, commentId: "wrong" }])).status).toBe("refused");
    expect((await f.service.get(task.id)).communication?.messages).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a focus report from a pane that has closed changes no presence state", async () => {
  const f = await fixture("tern");
  try {
    await publishFixture(f.home, f.repo, { changeSignature: "after" });
    await recordVisit(f.home, f.repo, {
      kind: "entry",
      signature: "before",
      now: new Date(Date.now() - 2 * 3600000).toISOString(),
      showCatchUp: async () => {},
    });
    const path = join(projectStoreDirectory(f.home, f.repo), "state.json");
    const before = await readFile(path, "utf8");
    const coordinatorOnly = [{ ...f.endpoint, cwd: f.clean, foregroundCwd: f.clean }];
    // Pane 102 was a task page. It closed before the report was sent, or while the CLI proved it.
    for (const [closedAfter, refusal] of [
      [0, "does not identify exactly one Tandem project"],
      [1, "Originating pane disappeared"],
    ] as const) {
      for (const event of ["entry", "away", "visible"] as const) {
        let listings = 0;
        const terminal: TerminalBackend = {
          ...f.deps.terminal,
          listPanes: async (input) =>
            listings++ < closedAfter ? f.deps.terminal.listPanes(input) : coordinatorOnly,
        };
        const outcome = await f.act(
          { verb: "visit", event },
          { origin: { pane: "102", cwd: f.clean }, deps: { terminal } },
        );
        expect(outcome.status).toBe("refused");
        expect(outcome.notice?.text).toContain(refusal);
      }
    }
    expect(await readFile(path, "utf8")).toBe(before);
    expect(f.opened).toEqual([]);
    expect(f.focused).toEqual([]);
  } finally {
    await f.close();
  }
});

test("returning from a task page by ← Orchestrator reports focus only from panes that still exist", async () => {
  await withParity(async ({ host, panel, world, project }) => {
    await panel.click(/^● Port the terminal/);
    const task = host.pane("task");
    await host.focus(task);
    await host.refresh();
    const mark = host.cli.length;
    await host.screen(task).click("← Orchestrator");
    expect(world.paneIsPresent(String(task))).toBe(false);
    await host.focus(Number(project.coordinator.paneId));
    const visits = host.cli.slice(mark).flatMap((run) => {
      const { action, origin } = ActionEnvelope.parse(JSON.parse(run.stdin ?? ""));
      return action.verb === "visit"
        ? [
            {
              event: action.event,
              pane: origin.pane,
              outcome: Outcome.parse(JSON.parse(run.stdout)),
            },
          ]
        : [];
    });
    expect(visits).toEqual([
      { event: "entry", pane: project.coordinator.paneId, outcome: { status: "done" } },
    ]);
  });
}, 60_000);

/** Fires every enabled control `open` draws, reopening the screen whenever a click closed it. */
async function fireEvery(host: TernParityHost, open: () => Promise<number>): Promise<void> {
  // A new block draws its loading state until its first poll reads the view file.
  const ready = async () => {
    const pane = await open();
    await host.refresh();
    return pane;
  };
  let pane = await ready();
  const count = (await host.screen(pane).render()).actions.length;
  // Last first: docked submit controls come before line editors that would hold them back.
  for (let index = count - 1; index >= 0; index--) {
    if (!host.world.paneIsPresent(String(pane))) pane = await ready();
    const { actions } = await host.screen(pane).render();
    const control = actions[index];
    if (control === undefined) continue;
    await host.send({ op: "action", pane, action: control.action });
    await host.settle();
  }
}

/** Every envelope the real plugin wrote to `tandem native act`, as the contract parses it. */
function envelopes(host: TernParityHost): readonly ActionEnvelope[] {
  return host.cli.map((run) => {
    expect(run.argv).toEqual(["/bin/sh", "tandem.sh", "native", "act"]);
    const parsed = ActionEnvelope.safeParse(JSON.parse(run.stdin ?? ""));
    if (!parsed.success) throw new Error(`${run.stdin}: ${parsed.error.message}`);
    return parsed.data;
  });
}

test("T2: every click in every rendered view sends an envelope the contract accepts", async () => {
  const verbs = new Set<string>();
  await withParity(async ({ host, panel, world, briefId }) => {
    await fireEvery(host, async () => panel.pane);
    // Clicks open further views, so a screen is the newest block of its kind.
    const opener = (open: () => Promise<unknown>, kind: string) => async () => {
      await open();
      const pane = world
        .ternBlocks()
        .filter((block) => block.program === `tandem.${kind}`)
        .at(-1)?.paneId;
      if (pane === undefined) throw new Error(`no tandem.${kind} opened`);
      return Number(pane);
    };
    // Controls that only send once the user has typed something.
    await panel.click(/^● Port the terminal/);
    const task = host.screen(await opener(async () => {}, "task")());
    await task.click(/^Message the worker…/);
    await task.type("use the new API");
    await task.press({ name: "enter" });
    await host.link(`tandem://brief/${briefId}`);
    const brief = host.screen(await opener(async () => {}, "brief")());
    await brief.click("+", { nth: 2 });
    await brief.focusField("Comment on this line…");
    await brief.type("Keep the old palette");
    await brief.click("Comment");
    await brief.click("Request changes (1)");
    await host.link("tandem://pr/281");
    const pr = host.screen(await opener(async () => {}, "pr")());
    await pr.click("Diff");
    await pr.click("+", { nth: 1 });
    await pr.type("Rename port");
    await pr.click("Comment");
    await fireEvery(
      host,
      opener(() => panel.click(/^● Port the terminal/), "task"),
    );
    await fireEvery(
      host,
      opener(() => panel.click(/^● Fix login/), "task"),
    );
    await fireEvery(
      host,
      opener(() => host.link(`tandem://brief/${briefId}`), "brief"),
    );
    await fireEvery(
      host,
      opener(() => host.link("tandem://pr/281"), "pr"),
    );
    await fireEvery(
      host,
      opener(() => panel.click("▦"), "board"),
    );
    await fireEvery(
      host,
      opener(() => panel.click("5h unavailable"), "usage"),
    );
    await fireEvery(
      host,
      opener(() => host.command("open-task"), "task-picker"),
    );
    const settings = opener(() => host.command("settings"), "setup");
    await fireEvery(host, settings);
    const setup = host.screen(await settings());
    await host.refresh();
    await setup.click("Bug reports");
    // "Fix it" is what an unchosen setting already means, so only another option makes it unsaved.
    await setup.click("Draft an issue");
    await setup.click("Save changes");
    // The project switcher's rows live in a dropdown layer only drawn while it is open.
    await host.refresh();
    const switcher = async () => {
      const { actions } = await panel.render();
      if (!actions.some((control) => control.label === "+ Open another project…"))
        await panel.click(/^tandem ▾/);
      return panel.pane;
    };
    await fireEvery(host, switcher);
    await switcher();
    await panel.click("+ Open another project…");
    for (const { id } of await host.commands()) await host.command(id);
    for (const kind of ["task/port", `brief/${briefId}`, "pr/281"])
      await host.link(`tandem://${kind}`);
    await host.windowStart();
    for (const { action } of envelopes(host)) verbs.add(action.verb);
  });
  await withParity(async ({ host, world, project }) => {
    await seedReview(world);
    await host.publish();
    await host.refresh();
    await host.link("tandem://pr/290");
    await host.screen(host.pane("pr")).click("Post");
    const other = await seedTernProject(world, {
      coordinatorPaneId: "111",
      helperPaneId: "112",
      repoPath: join(dirname(world.repoPath), "api"),
    });
    await seedScenarioTask(world, {
      id: "api-stuck",
      title: "Unblock api",
      kind: "implementation",
      stage: "blocked",
      previousStage: "implementing",
      repoPath: other.repoPath,
    });
    await host.publish(other);
    await host.focus(Number(project.coordinator.paneId));
    const catchup = async () => {
      await host.stepAway(other, 120, true);
      return host.pane("catchup");
    };
    await fireEvery(host, catchup);
    await host.screen(await catchup()).click("Dismiss");
    for (const { action } of envelopes(host)) verbs.add(action.verb);
  });
  // Merged-PR links have no control in these seeds; the native-screens eval sends them directly.
  expect([...verbs].toSorted()).toEqual(
    Action.options
      .map((option) => option.shape.verb.value)
      .filter((verb) => verb !== "merged-link")
      .toSorted(),
  );
}, 240_000);

test("project lookup uses the terminal saved in the block's home, not the process's", async () => {
  const f = await fixture();
  try {
    const record = await readCoordinatorRecord(recordPath(f.home, "isolated", f.repo));
    if (record === undefined) throw new Error("Missing fixture coordinator");
    await saveCoordinatorRecord(f.home, {
      ...record,
      endpoint: {
        ...record.endpoint,
        terminal: "tern",
        terminalSessionId: "201",
        workspaceId: "301",
        tabId: "301",
      },
    });
    const [, ctx] = blockArgs(join(f.home, "view.json"), {
      coordinator: "101",
      cwd: f.clean,
      home: f.home,
      index: join(f.home, "index.json"),
    });
    const calls: string[][] = [];
    const output: string[] = [];
    const { terminal: _terminal, service: _service, ...dependencies } = f.deps;
    await runTerminal(["native", "act"], {
      ...dependencies,
      processEnvironment: { TANDEM_HOME: join(f.root, "different-home") },
      run: async (request) => {
        calls.push([...request.argv]);
        if (request.argv[1] !== "ls") throw new Error("Only a Tern pane listing expected");
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            sessions: [
              {
                id: "201",
                name: "isolated",
                tabs: [
                  {
                    id: "301",
                    name: "project",
                    blocks: [{ id: "101", title: "coordinator", cwd: f.clean, live: true }],
                  },
                ],
              },
            ],
            detached: [],
          }),
        };
      },
      createService: () => {
        throw new Error("Opening the board must not start a service");
      },
      input: Readable.from([
        JSON.stringify({
          v: 1,
          origin: { pane: "101", ctx },
          action: { verb: "open", ref: { kind: "board" } },
        }),
      ]),
      stdout: (text) => output.push(text),
    });
    // The pane was found through Tern's listing, so the click got past origin proof; the
    // fixture then stops at the first non-listing command.
    expect(Outcome.parse(JSON.parse(output.join("")))).toEqual({
      status: "refused",
      notice: { code: "failed", text: "Only a Tern pane listing expected" },
    });
    expect(calls[0]?.slice(1)).toEqual(["ls", "--json"]);
    expect(calls.every((argv) => argv[0] !== "herdr")).toBe(true);
  } finally {
    await f.close();
  }
});

const setupAnswer = (mode: SetupMode, repositories: readonly unknown[]) => ({
  tandemSetup: 1,
  mode,
  models: Object.fromEntries(
    ["coordinator", "scout", "implementer", "reviewer", "presentation"].map((role) => [
      role,
      { model: "claude-code/opus", thinking: "high" },
    ]),
  ),
  repositories,
  selfImprovement: "fix",
});

/** The fixture's service with setup's discovery and save replaced, since no machine is behind it. */
function setupService(f: Fixture, save: (answerText: string) => SetupApplyResult): TandemService {
  return {
    ...f.service,
    setupView: async (_repoPath, mode) => setupViewFixture(mode),
    saveSetup: async (_repoPath, answerText) => save(answerText),
  };
}

async function publishedSetup(f: Fixture, mode: SetupMode) {
  return ViewFile.parse(
    JSON.parse(await readFile(viewDetailPath(f.home, f.repo, setupFile(mode)), "utf8")),
  );
}

test("setup opens beside the conversation and settings in a tab, each from its published model", async () => {
  const f = await fixture("tern");
  try {
    const service = setupService(f, () => {
      throw new Error("nothing is saved by opening");
    });
    for (const mode of SETUP_MODES) {
      const outcome = await f.act(
        { verb: "open", ref: { kind: "setup", mode } },
        { deps: { service } },
      );
      expect(outcome).toEqual({ status: "done" });
      const file = await publishedSetup(f, mode);
      expect(file.kind).toBe("setup");
      expect(file.model).toMatchObject({ mode });
    }
    expect(f.opened).toEqual([
      { kind: "setup", mode: "setup" },
      { kind: "setup", mode: "settings" },
    ]);

    // A terminal without native views cannot show the block.
    const withoutViews = { service, terminal: { ...f.deps.terminal, views: undefined } };
    const refused = await f.act(
      { verb: "open", ref: { kind: "setup", mode: "settings" } },
      { deps: withoutViews },
    );
    expect(refused.status).toBe("refused");
    expect(f.opened).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("setup-save applies the answer, shows the saved model again and tells the coordinator in fixed words", async () => {
  const f = await fixture("tern");
  try {
    const saved: string[] = [];
    const service = setupService(f, (text) => {
      saved.push(text);
      return { message: "", complete: true, opened: ["api", "web", "docs"] };
    });
    const answer = setupAnswer("setup", [
      { path: "/code/api", validationCommands: ["make check"] },
    ]);
    expect(await f.act({ verb: "setup-save", answer }, { deps: { service } })).toEqual({
      status: "done",
    });
    expect(saved.map((text) => JSON.parse(text))).toEqual([answer]);
    expect(f.prompts).toEqual([
      "Setup saved. Chats for api, web and docs are open in the sidebar.",
    ]);
    expect((await publishedSetup(f, "setup")).model).toMatchObject({ mode: "setup" });

    const settings = setupService(f, () => ({ message: "", complete: true, opened: [] }));
    const edited = setupAnswer("settings", [{ path: "/code/api", validationCommands: ["make"] }]);
    const outcome = await f.act(
      { verb: "setup-save", answer: edited },
      { deps: { service: settings } },
    );
    expect(outcome).toEqual({ status: "done" });
    expect(f.prompts.at(-1)).toBe("Settings saved. New tasks will use them.");
  } finally {
    await f.close();
  }
});

test("a partly failed setup-save is kept with what failed and tells the coordinator", async () => {
  const f = await fixture("tern");
  try {
    const service = setupService(f, () => ({
      message: "Model choices were not saved: models broke",
      complete: false,
      opened: [],
    }));
    const answer = setupAnswer("setup", [
      { path: "/code/api", validationCommands: ["make check"] },
    ]);
    expect(await f.act({ verb: "setup-save", answer }, { deps: { service } })).toEqual({
      status: "kept",
      notice: { code: "setup-incomplete", text: "Model choices were not saved: models broke" },
    });
    expect(f.prompts).toEqual([
      "Setup was saved with problems:\nModel choices were not saved: models broke",
    ]);
  } finally {
    await f.close();
  }
});

test("setup-save refuses an answer the CLI cannot parse before saving or prompting", async () => {
  const f = await fixture("tern");
  try {
    const service = setupService(f, () => {
      throw new Error("must not save a refused answer");
    });
    const bad = { ...setupAnswer("setup", []), models: {}, mode: "later" };
    const outcome = await f.act({ verb: "setup-save", answer: bad }, { deps: { service } });
    expect(outcome.status).toBe("refused");
    expect(outcome.notice?.text).toContain("Planning has no model.");
    expect(outcome.notice?.text).toContain('mode must be "setup" or "settings".');
    expect(f.prompts).toEqual([]);
    expect(Action.safeParse({ verb: "setup-save" }).success).toBe(false);
    expect(Action.safeParse({ verb: "setup-save", answer: [] }).success).toBe(false);
    expect(Action.safeParse({ verb: "setup-save", answer: {}, extra: 1 }).success).toBe(false);
  } finally {
    await f.close();
  }
});
