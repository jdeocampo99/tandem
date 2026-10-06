import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeViewText } from "../../src/board/native-views.ts";
import { nativeDetailPath, nativeViewsPath } from "../../src/board/snapshot.ts";
import { runCli } from "../../src/cli.ts";
import { saveTerminalChoice } from "../../src/config/home-settings.ts";
import { defaultPolicy } from "../../src/config/policy.ts";
import { repositoryKey } from "../../src/config/repositories.ts";
import type { CommandRequest, RequestBriefContent } from "../../src/contracts.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import { readCoordinatorRecord, saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { runTerminal } from "../../src/main.ts";
import { visitNativeProject } from "../../src/memory/native-visits.ts";
import { withRequestReviewPane } from "../../src/requests/brief.ts";
import { briefView } from "../../src/requests/native-view.ts";
import { createRequestBriefStore } from "../../src/requests/store.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
import type {
  NativeRendererContext,
  NativeRendererHandler,
  NativeRendererInput,
} from "../../src/terminal/native-renderers.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { TerminalBackend, TerminalView } from "../../src/terminal-backend/contract.ts";

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
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-view-actions-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const poolRoot = join(root, "pool");
  const clean = join(poolRoot, "coordinator");
  await mkdir(repo);
  await mkdir(clean, { recursive: true });
  if (terminalName === "tern") {
    await mkdir(home, { recursive: true });
    await saveTerminalChoice(home, "tern");
  }
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
  const closed: Parameters<TerminalBackend["closeView"]>[0][] = [];
  let ownsCoordinator = true;
  const run = async (): Promise<never> => {
    throw new Error("No external commands expected");
  };
  const terminal: TerminalBackend = {
    ...terminalBackend(run, { terminal: terminalName }),
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
    openView: async (target) => {
      opened.push(target.view);
      return { opened: true, warnings: [] };
    },
    closeView: async (target) => {
      closed.push(target);
      return { closed: true, warnings: [] };
    },
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
  const input = join(root, "action.json");
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
    stdout: () => {},
    stderr: () => {},
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
    input,
    deps,
    prompts,
    opened,
    focused,
    closed,
    endpoint,
    setOwner: (owns: boolean) => {
      ownsCoordinator = owns;
    },
    write: (data: unknown) => writeFile(input, JSON.stringify(data)),
    close: async () => {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("native Approve click records the displayed revision and both digests without another confirmation", async () => {
  const f = await fixture();
  try {
    await f.write(f.seen);
    const result = await runTerminal(
      [
        "native",
        "brief-approve",
        f.record.id,
        "--input",
        f.input,
        "--json",
        "--pane",
        "101",
        "--cwd",
        f.clean,
      ],
      f.deps,
    );
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("native");
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
    const f = await fixture();
    try {
      let input: Record<string, unknown> = { ...f.seen };
      if (changed === "revision") {
        await f.service.draftRequestBrief({
          repoPath: f.repo,
          requestId: f.record.id,
          content: { ...content, goal: "A different goal" },
          reviewPane: false,
        });
      } else if (changed === "content") input.contentDigest = "wrong";
      else if (changed === "agreement") input.agreementDigest = "wrong";
      else {
        const { agreementDigest: _agreement, ...rest } = input;
        input = rest;
      }
      await f.write(input);
      const result = await runCli(["brief-approve", f.record.id, "--input", f.input], f.deps);
      expect(result.exitCode).not.toBe(0);
      expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
      expect(f.prompts).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

for (const action of ["brief-comment", "brief-request-changes"]) {
  test(`${action} resolves stable line ids through the original historical view`, async () => {
    const f = await fixture();
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
      await f.write({
        ...f.seen,
        text: "Keep the original goal",
        comments: [{ lineId: originalLine.id, text: "Keep this goal" }],
      });
      const result = await runTerminal(
        ["native", action, f.record.id, "--input", f.input, "--pane", "101", "--cwd", f.clean],
        f.deps,
      );
      expect(result.exitCode).toBe(0);
      expect(f.prompts[0]).toContain("From the open review page:");
      expect(f.prompts[0]).toContain(
        `Brief ${f.record.id}, revision 1: ${action === "brief-comment" ? "Comment" : "Request changes"}`,
      );
      expect(f.prompts[0]).toContain(
        `Line ${originalLine.number} [${originalLine.id}] (${content.goal}):`,
      );
      expect(f.prompts[0]).toContain("Keep this goal");
      expect(f.prompts[0]).not.toContain("The revised goal");
      expect((await f.store.read(f.record.id))?.draft.content.goal).toBe("The revised goal");
      expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
      const latest = await f.store.read(f.record.id);
      if (latest === undefined) throw new Error("Missing revised brief");
      const latestOnlyLine = briefView(latest).lines.find(
        (line) => line.text === "A newly added question",
      );
      if (latestOnlyLine === undefined) throw new Error("Missing new line");
      await f.write({
        ...f.seen,
        comments: [{ lineId: latestOnlyLine.id, text: "Not in old view" }],
      });
      const refused = await runTerminal(
        ["native", action, f.record.id, "--input", f.input, "--pane", "101", "--cwd", f.clean],
        f.deps,
      );
      expect(refused.exitCode).not.toBe(0);
      expect(refused.error?.message).toContain("Unknown brief line id");
      expect(f.prompts).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

test("request changes forwards feedback and retires only the matching brief projection", async () => {
  const f = await fixture();
  try {
    const closed: unknown[] = [];
    const service = {
      ...f.service,
      closeRequestBriefReview: async (id: string, revision: number) => {
        closed.push({ id, revision });
        return f.service.closeRequestBriefReview(id, revision);
      },
    };
    await f.write({ ...f.seen, text: "Please narrow the scope" });
    const result = await runCli(["brief-request-changes", f.record.id, "--input", f.input], {
      ...f.deps,
      service,
    });
    expect(result.exitCode).toBe(0);
    expect(f.prompts[0]).toContain("revision 1: Request changes");
    expect(closed).toEqual([{ id: f.record.id, revision: 1 }]);
    expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
  } finally {
    await f.close();
  }
});

for (const action of ["brief-comment", "brief-request-changes"]) {
  test(`${action} refuses invalid line ids, numeric anchors and stale view bindings before delivery`, async () => {
    const f = await fixture();
    try {
      const line = briefView(f.record).lines.find((line) => line.text === content.goal);
      if (line === undefined) throw new Error("Missing displayed goal line");
      const cases = [
        {
          comments: [{ lineId: "unknown:0:0", text: "Unknown id" }],
          error: "Unknown brief line id",
        },
        {
          comments: [{ lineId: ` ${line.id} `, text: "Changed id" }],
          error: "Unknown brief line id",
        },
        { comments: [{ line: line.number, text: "Numeric anchor" }], error: "unknown field line" },
        {
          comments: [{ lineId: line.number, text: "Numeric id" }],
          error: "lineId must be a nonempty string",
        },
        {
          comments: [{ lineId: "", text: "Missing id" }],
          error: "lineId must be a nonempty string",
        },
        { briefRevision: 100, error: "stale or unknown brief revision" },
        { contentDigest: "stale", error: "different content digest" },
        { agreementDigest: "stale", error: "different agreement digest" },
      ];
      const retired: string[] = [];
      for (const { error, ...input } of cases) {
        await f.write({ ...f.seen, comments: [{ lineId: line.id, text: "Feedback" }], ...input });
        const result = await runTerminal(
          ["native", action, f.record.id, "--input", f.input, "--pane", "101", "--cwd", f.clean],
          {
            ...f.deps,
            service: {
              ...f.service,
              closeRequestBriefReview: async (id, revision) => {
                retired.push(id);
                return f.service.closeRequestBriefReview(id, revision);
              },
            },
          },
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.error?.message).toContain(error);
      }
      expect(f.prompts).toEqual([]);
      expect(retired).toEqual([]);
      expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
    } finally {
      await f.close();
    }
  });
}

test("brief feedback refuses invalid anchors and a coordinator pane occupied by another process", async () => {
  const f = await fixture();
  try {
    await f.write({ ...f.seen, comments: [{ lineId: "missing:0:0", text: "bad anchor" }] });
    expect(
      (await runCli(["brief-comment", f.record.id, "--input", f.input], f.deps)).exitCode,
    ).not.toBe(0);
    await f.write({ ...f.seen, text: "Valid feedback" });
    f.setOwner(false);
    const result = await runCli(["brief-comment", f.record.id, "--input", f.input], f.deps);
    expect(result.exitCode).not.toBe(0);
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("brief actions resolve the coordinator's clean worktree to its original repository", async () => {
  const f = await fixture();
  try {
    await f.write({ ...f.seen, text: "A comment from the clean checkout" });
    expect(
      (
        await runTerminal(
          [
            "native",
            "brief-comment",
            f.record.id,
            "--input",
            f.input,
            "--pane",
            "101",
            "--cwd",
            f.clean,
          ],
          f.deps,
        )
      ).exitCode,
    ).toBe(0);
    expect(f.prompts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

async function createPrTask(f: Awaited<ReturnType<typeof fixture>>) {
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

test("native brief actions refuse another project's request before ownership or mutation", async () => {
  const f = await fixture();
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
      briefRevision: foreign.draft.revision,
      contentDigest: foreign.draft.contentDigest,
      agreementDigest: foreign.draft.agreementDigest,
    };
    let inspections = 0;
    for (const action of ["brief-comment", "brief-request-changes", "brief-approve", "open"]) {
      await f.write(action === "brief-approve" ? seen : { ...seen, text: "Foreign feedback" });
      const args =
        action === "open"
          ? ["open", "brief", foreign.id]
          : [action, foreign.id, "--input", f.input];
      const result = await runTerminal(["native", ...args, "--pane", "101", "--cwd", f.clean], {
        ...f.deps,
        terminal: {
          ...f.deps.terminal,
          inspect: async (input) => {
            inspections += 1;
            return f.deps.terminal.inspect(input);
          },
        },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain(
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
  const f = await fixture();
  try {
    await writeFile(recordPath(f.home, "isolated", join(f.root, "corrupt-project")), "{broken");
    await f.write({ ...f.seen, text: "Feedback still reaches this project" });
    const result = await runTerminal(
      [
        "native",
        "brief-comment",
        f.record.id,
        "--input",
        f.input,
        "--pane",
        "101",
        "--cwd",
        f.clean,
      ],
      f.deps,
    );
    expect(result.exitCode).toBe(0);
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
    const result = await runTerminal(
      ["native", "open", "brief", f.record.id, "--pane", "101", "--cwd", f.clean],
      f.deps,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message).toContain("no readable matching coordinator");
    expect(result.error?.message).toContain("unreadable records were skipped");
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
    const argv = ["native", "open", "brief", f.record.id, "--pane", "202", "--cwd", f.repo];
    expect((await runTerminal(argv, { ...f.deps, terminal })).exitCode).toBe(0);
    expect(f.opened).toHaveLength(1);
    dead = false;
    const ambiguous = await runTerminal(argv, { ...f.deps, terminal });
    expect(ambiguous.exitCode).not.toBe(0);
    expect(ambiguous.error?.message).toContain("exactly one Tandem project");
    expect(f.opened).toHaveLength(1);
    const unavailable = await runTerminal(argv, {
      ...f.deps,
      terminal: {
        ...terminal,
        listPanes: async () => {
          throw new Error("Session has stopped");
        },
      },
    });
    expect(unavailable.exitCode).not.toBe(0);
    expect(unavailable.error?.message).toContain("no live matching coordinator session");
  } finally {
    await f.close();
  }
});

test("request changes reports delivered feedback when retiring the pane fails", async () => {
  const f = await fixture();
  try {
    await f.write({ ...f.seen, text: "Please change this brief" });
    let closes = 0;
    const output: string[] = [];
    const result = await runTerminal(
      [
        "native",
        "brief-request-changes",
        f.record.id,
        "--input",
        f.input,
        "--pane",
        "101",
        "--cwd",
        f.clean,
      ],
      {
        ...f.deps,
        stdout: (value) => output.push(value),
        service: {
          ...f.service,
          closeRequestBriefReview: async () => {
            closes += 1;
            throw new Error("Pane retirement failed");
          },
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(f.prompts).toHaveLength(1);
    expect(closes).toBe(1);
    expect(output.join("")).toContain('"delivered": true');
    expect(output.join("")).toContain("Feedback was delivered");
    expect(output.join("")).toContain("Do not resubmit this feedback");
  } finally {
    await f.close();
  }
});

test("Tandem PR comments become durable worker fix requests without any GitHub call", async () => {
  const f = await fixture();
  try {
    const task = await createPrTask(f);
    const result = await runTerminal(
      [
        "native",
        "pr-comment",
        task.id,
        "--text",
        "Fix src/view.ts:12",
        "--pane",
        "101",
        "--cwd",
        f.clean,
      ],
      f.deps,
    );
    expect(result.exitCode).toBe(0);
    const current = await f.service.get(task.id);
    expect(current.communication?.messages[0]?.text).toContain(
      "PR fix request: Fix src/view.ts:12",
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
      const id = kind === "brief" ? f.record.id : (await createPrTask(f)).id;
      expect((await runCli(["open", kind, id], f.deps)).exitCode).toBe(0);
      expect(f.opened).toEqual([kind === "brief" ? { kind, requestId: id } : { kind, taskId: id }]);
      expect(f.prompts).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test("Herdr reports unsupported native views and uses its existing review pane for briefs", async () => {
  const f = await fixture();
  try {
    const herdr = terminalBackend(f.deps.run);
    const task = await createPrTask(f);
    const result = await runCli(["open", "task", task.id], {
      ...f.deps,
      terminal: { ...f.deps.terminal, openView: herdr.openView },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message).toContain("Herdr cannot display a native task view");
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
    const brief = await runCli(["open", "brief", f.record.id], {
      ...f.deps,
      service,
      terminal: { ...f.deps.terminal, openView: herdr.openView },
    });
    expect(brief.exitCode).toBe(0);
    expect(reviews).toEqual([f.record.id]);
    const refused = await runCli(
      ["open", "brief", f.record.id, "--pane", "101", "--cwd", f.repo, "--window", "opaque"],
      {
        ...f.deps,
        service,
        terminal: { ...f.deps.terminal, openView: herdr.openView },
      },
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.error?.message).toContain("Herdr cannot target an opaque Tern control window");
    expect(reviews).toEqual([f.record.id]);
    const unopened = await runCli(["open", "brief", f.record.id], {
      ...f.deps,
      service: { ...f.service, reviewRequestBrief: f.service.requestBrief },
      terminal: { ...f.deps.terminal, openView: herdr.openView },
    });
    expect(unopened.exitCode).not.toBe(0);
    expect(unopened.error?.message).toContain("could not be opened");
  } finally {
    await f.close();
  }
});

test("native review submit routes to the existing page submission service and rejects malformed submissions", async () => {
  const f = await fixture();
  try {
    const submissions: unknown[] = [];
    const service = {
      ...f.service,
      reviewSubmit: async (_id: string, submission: unknown, expected: unknown) => {
        submissions.push({ submission, expected });
        return { taskId: _id, posted: false, message: "The reviewed head moved" };
      },
    };
    const input = {
      tandemPrReview: 1,
      verdict: "approve",
      summary: "Looks good",
      drafts: [],
      yours: [],
    };
    await f.write({ ...input, reviewHead: "displayed-head", reviewGeneration: 0 });
    const result = await runCli(["review-submit", "task-review", "--input", f.input], {
      ...f.deps,
      service,
    });
    expect(result.exitCode).toBe(0);
    expect(result.result?.value).toMatchObject({
      posted: false,
      message: "The reviewed head moved",
    });
    expect(submissions).toEqual([
      { submission: input, expected: { head: "displayed-head", generation: 0 } },
    ]);
    for (const invalid of [
      {},
      { reviewHead: "displayed-head" },
      { reviewGeneration: 0 },
      { reviewHead: "displayed-head", reviewGeneration: -1 },
      { reviewHead: "displayed-head", reviewGeneration: 0.5 },
      { reviewHead: "displayed-head", reviewGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { reviewHead: " displayed-head ", reviewGeneration: 0 },
    ]) {
      await f.write({ ...input, ...invalid });
      const refused = await runTerminal(
        [
          "native",
          "review-submit",
          "task-review",
          "--input",
          f.input,
          "--pane",
          "101",
          "--cwd",
          f.clean,
        ],
        { ...f.deps, service },
      );
      expect(refused.exitCode).not.toBe(0);
      expect(refused.error?.message).toContain("review-submit requires");
    }
    expect(submissions).toHaveLength(1);
    await f.write({ text: "a comment containing JSON is not a submission" });
    expect(
      (await runCli(["review-submit", "task-review", "--input", f.input], { ...f.deps, service }))
        .exitCode,
    ).not.toBe(0);
    expect(submissions).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("inline PR comments preserve file and line in the worker's durable direction", async () => {
  const f = await fixture();
  try {
    const task = await createPrTask(f);
    await f.write({
      text: "Please fix these",
      comments: [{ file: "src/view.ts", line: 12, text: "Handle an empty list\nbefore rendering" }],
    });
    expect((await runCli(["pr-comment", task.id, "--input", f.input], f.deps)).exitCode).toBe(0);
    expect((await f.service.get(task.id)).communication?.messages[0]?.text).toContain(
      "src/view.ts:12: Handle an empty list before rendering",
    );
  } finally {
    await f.close();
  }
});

test("native command namespace rejects publication commands", async () => {
  const f = await fixture();
  try {
    expect(
      (await runTerminal(["native", "publish", "task-pr", "--yes"], f.deps)).exitCode,
    ).not.toBe(0);
    expect(await f.service.list()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a failed coordinator notification reports the recorded approval instead of inviting an approval retry", async () => {
  const f = await fixture();
  try {
    await f.write(f.seen);
    const terminal = {
      ...f.deps.terminal,
      promptAgent: async () => {
        throw new Error("coordinator disconnected");
      },
    };
    const result = await runCli(["brief-approve", f.record.id, "--input", f.input], {
      ...f.deps,
      terminal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.result?.approved).toBe(true);
    expect((await f.store.read(f.record.id))?.approval).toMatchObject(f.seen);
    expect(result.result?.value).toMatchObject({
      warnings: [
        "Approval was recorded, but the coordinator could not be notified: coordinator disconnected",
      ],
    });
  } finally {
    await f.close();
  }
});

for (const state of ["closed", "merged"] as const) {
  test(`comments on a ${state} PR are refused without recording a worker direction`, async () => {
    const f = await fixture();
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
        pullRequest: {
          repository: "owner/repo",
          number: 42,
          state,
          head: "a".repeat(40),
          base: "main",
        },
      }));
      expect(
        (await runCli(["pr-comment", task.id, "--text", "Fix this"], f.deps)).exitCode,
      ).not.toBe(0);
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
    expect((await runCli(["open", "pr", "42"], f.deps)).exitCode).toBe(0);
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
    const result = await runCli(["open", "pr", "42"], f.deps);
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message).toContain("More than one task");
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
      const terminal = {
        ...f.deps.terminal,
        openView: async (input: Parameters<TerminalBackend["openView"]>[0]) => {
          origins.push(input.origin);
          return f.deps.terminal.openView(input);
        },
      };
      const { service: _injectedService, ...dependencies } = f.deps;
      const result = await runTerminal(
        [
          "native",
          "open",
          "pr",
          "42",
          "--pane",
          "101",
          "--cwd",
          f.clean,
          ...(windowKey === undefined ? [] : ["--window", windowKey]),
        ],
        {
          ...dependencies,
          terminal,
          createService: (options) => {
            scopes.push(options.sourceWorkspace);
            return createTandemService({
              ...options,
              run: f.deps.run,
              clock: () => NOW,
              checkBriefLanguage: async () => [],
            });
          },
          processEnvironment: {
            ...f.deps.processEnvironment,
            TANDEM_SESSION: "another-session",
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.status).toBe("native");
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

test("native open refuses missing or invalid origin context before reading panes or opening", async () => {
  const f = await fixture();
  try {
    const invalidContexts = [
      [],
      ["--cwd", f.repo],
      ["--pane", "101"],
      ["--pane", "1.5", "--cwd", f.repo],
      ["--pane", " 101 ", "--cwd", f.repo],
      ["--pane", "-1", "--cwd", f.repo],
      ["--pane", "0101", "--cwd", f.repo],
      ["--pane", "9007199254740992", "--cwd", f.repo],
      ["--pane", "101", "--cwd", "relative/path"],
    ];
    let reads = 0;
    for (const flags of invalidContexts) {
      const errors: string[] = [];
      const result = await runTerminal(["native", "open", "brief", f.record.id, ...flags], {
        ...f.deps,
        terminal: {
          ...f.deps.terminal,
          listPanes: async (input) => {
            reads += 1;
            return f.deps.terminal.listPanes(input);
          },
        },
        processEnvironment: { ...f.deps.processEnvironment, TANDEM_NATIVE_CWD: f.repo },
        stderr: (message) => errors.push(message),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain("native open requires");
      expect(errors.join("")).toContain(result.error?.message ?? "missing error");
    }
    expect(reads).toBe(0);
    expect(f.opened).toEqual([]);
  } finally {
    await f.close();
  }
});

test("every native action refuses missing pane/cwd before reading input or mutating state", async () => {
  const f = await fixture();
  try {
    const actions = [
      ["brief-comment", f.record.id, "--input", f.input],
      ["brief-request-changes", f.record.id, "--input", f.input],
      ["brief-approve", f.record.id, "--input", f.input],
      ["pr-comment", "task-example", "--text", "Fix this"],
      ["review-submit", "task-example", "--input", f.input],
      ["restart", "task-example"],
      ["steer", "--task", "task-example", "--text", "Fix this"],
    ];
    for (const action of actions) {
      for (const flags of [[], ["--pane", "101"]]) {
        const errors: string[] = [];
        const result = await runTerminal(["native", ...action, ...flags], {
          ...f.deps,
          stderr: (message) => errors.push(message),
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.error?.message).toContain(`native ${action[0]} requires`);
        expect(errors.join("")).toContain(result.error?.message ?? "missing error");
      }
    }
    expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
    expect(f.prompts).toEqual([]);
    expect(f.opened).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const outcome of ["refusal", "failure"] as const) {
  test(`native open reports backend ${outcome} on stderr and never retries`, async () => {
    const f = await fixture();
    try {
      let attempts = 0;
      const errors: string[] = [];
      const reason =
        outcome === "refusal" ? "Ambiguous control window for pane 101" : "Tern control failed";
      const result = await runTerminal(
        ["native", "open", "brief", f.record.id, "--pane", "101", "--cwd", f.repo],
        {
          ...f.deps,
          terminal: {
            ...f.deps.terminal,
            openView: async () => {
              attempts += 1;
              if (outcome === "failure") throw new Error(reason);
              return { opened: false, warnings: [reason] };
            },
          },
          stderr: (message) => errors.push(message),
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toBe(reason);
      expect(errors.join("")).toContain(reason);
      expect(attempts).toBe(1);
      expect(f.opened).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test("native open refuses conflicting project and pane context before opening a view", async () => {
  const f = await fixture();
  try {
    const result = await runTerminal(
      [
        "native",
        "open",
        "brief",
        f.record.id,
        "--pane",
        "999",
        "--cwd",
        f.repo,
        "--window",
        "own-window",
      ],
      f.deps,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message).toContain("exactly one Tandem project");
    expect(f.opened).toEqual([]);
  } finally {
    await f.close();
  }
});

test("native PR comment explicitly refuses a completed implementation worker", async () => {
  const f = await fixture();
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
      stage: "completed",
    }));
    const result = await runTerminal(
      ["native", "pr-comment", task.id, "--text", "Fix this", "--pane", "101", "--cwd", f.clean],
      f.deps,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message).toContain("worker has finished");
    expect((await f.service.get(task.id)).communication?.messages).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("native project lookup uses the terminal saved in the explicit home before dispatch", async () => {
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
    await saveTerminalChoice(f.home, "tern");
    const calls: string[][] = [];
    const { terminal: _terminal, service: _service, ...dependencies } = f.deps;
    const result = await runTerminal(
      ["native", "board", "--home", f.home, "--pane", "101", "--cwd", f.clean],
      {
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
        nativeRendererHandlers: {
          board: async (context) => {
            expect(context.capabilities.terminal.name).toBe("tern");
            throw new Error("fixture renderer unavailable");
          },
        },
        createService: () => {
          throw new Error("Unavailable renderer must not start a service");
        },
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message).toBe("fixture renderer unavailable");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).not.toBe("herdr");
    expect(calls[0]?.slice(1)).toEqual(["ls", "--json"]);
  } finally {
    await f.close();
  }
});

test("published wave-2 argv dispatches a registered renderer without starting a service", async () => {
  const f = await fixture();
  try {
    let starts = 0;
    const { service: _service, ...dependencies } = f.deps;
    const commands = [["board"], ["usage"]];
    for (const command of commands) {
      const errors: string[] = [];
      const output: string[] = [];
      const result = await runTerminal(["native", ...command, "--pane", "101", "--cwd", f.clean], {
        ...dependencies,
        cwd: f.root,
        nativeRendererHandlers: {
          [command[0] ?? ""]: async () => {
            throw new Error(`fixture ${command[0]} renderer unavailable`);
          },
        },
        createService: () => {
          starts += 1;
          return f.service;
        },
        stdout: (value) => output.push(value),
        stderr: (value) => errors.push(value),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toBe(`fixture ${command[0]} renderer unavailable`);
      expect(errors.join("")).toContain(result.error?.message ?? "missing error");
      expect(output).toEqual([]);
    }
    expect(starts).toBe(0);
    expect(f.opened).toEqual([]);
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("one registered renderer receives normalized input and the explicit project/pane context", async () => {
  const f = await fixture();
  try {
    const commands: readonly Readonly<{ argv: readonly string[]; input: NativeRendererInput }>[] = [
      { argv: ["board"], input: { kind: "board" } },
      { argv: ["prs"], input: { kind: "prs" } },
      { argv: ["usage"], input: { kind: "usage" } },
      { argv: ["new-request"], input: { kind: "new-request" } },
      { argv: ["open-task"], input: { kind: "open-task" } },
      { argv: ["project", "3"], input: { kind: "project", target: 3 } },
      {
        argv: ["project", "repo:/fixture/tenth"],
        input: { kind: "project", target: { repoPath: "/fixture/tenth" } },
      },
      {
        argv: ["view-file", "my view.tandem-view.json"],
        input: { kind: "view-file", path: join(f.clean, "my view.tandem-view.json") },
      },
    ];
    for (const command of commands) {
      const received: NativeRendererContext[] = [];
      const handler: NativeRendererHandler = async (context) => {
        received.push(context);
        return { value: { handled: context.input.kind } };
      };
      const result = await runTerminal(
        [
          "native",
          ...command.argv,
          "--pane",
          "101",
          "--cwd",
          f.clean,
          "--window",
          "opaque control key",
        ],
        {
          ...f.deps,
          cwd: f.root,
          nativeRendererHandlers: { [command.input.kind]: handler },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0]?.input).toEqual(command.input);
      expect(received[0]?.origin).toEqual({
        paneId: "101",
        cwd: f.clean,
        windowId: "opaque control key",
      });
      expect(received[0]?.environment.repo).toBe(f.repo);
      expect(received[0]?.environment.sourceRepo).toBe(f.clean);
    }
    expect(f.opened).toEqual([]);
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("renderer commands reject missing context and invalid project/file input before dispatch", async () => {
  const f = await fixture();
  try {
    const cases = [
      ["board"],
      ["prs", "--pane", "101"],
      ["project", "0", "--pane", "101", "--cwd", f.clean],
      ["project", "10", "--pane", "101", "--cwd", f.clean],
      ["project", "unknown", "--pane", "101", "--cwd", f.clean],
      ["project", "--pane", "101", "--cwd", f.clean],
      ["view-file", "--pane", "101", "--cwd", f.clean],
      ["usage", "extra", "--pane", "101", "--cwd", f.clean],
    ];
    let attempts = 0;
    const handler: NativeRendererHandler = async () => {
      attempts += 1;
      throw new Error("Unexpected renderer invocation");
    };
    for (const argv of cases) {
      const result = await runTerminal(["native", ...argv], {
        ...f.deps,
        nativeRendererHandlers: {
          board: handler,
          prs: handler,
          usage: handler,
          project: handler,
          "view-file": handler,
        },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).not.toContain("not implemented yet");
      expect(result.error?.message).not.toContain("Unexpected renderer invocation");
    }
    expect(attempts).toBe(0);
  } finally {
    await f.close();
  }
});

for (const outcome of ["opened", "refused"] as const)
  test(`native task picker ${outcome} preserves exact origin and never retries`, async () => {
    const f = await fixture("tern");
    const calls: Parameters<TerminalBackend["openView"]>[0][] = [];
    try {
      const result = await runTerminal(
        [
          "native",
          "open-task",
          "--pane",
          "101",
          "--cwd",
          f.repo,
          "--window",
          "own-window",
          "--json",
        ],
        {
          ...f.deps,
          terminal: {
            ...f.deps.terminal,
            openView: async (input) => {
              calls.push(input);
              return {
                opened: outcome === "opened",
                warnings: outcome === "opened" ? [] : ["Picker unavailable"],
              };
            },
          },
        },
      );
      expect(result.exitCode, result.error?.message).toBe(outcome === "opened" ? 0 : 1);
      expect(calls, result.error?.message).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        view: { kind: "task-picker" },
        origin: { paneId: "101", cwd: f.repo, windowId: "own-window" },
        home: f.home,
      });
      if (outcome === "refused") expect(result.error?.message).toContain("Picker unavailable");
    } finally {
      await f.service.shutdown();
      await rm(f.root, { recursive: true, force: true });
    }
  });
test("New request focuses the owned coordinator and asks for conversational intake", async () => {
  const f = await fixture();
  const focused: string[] = [];
  try {
    const result = await runTerminal(["native", "new-request", "--pane", "101", "--cwd", f.clean], {
      ...f.deps,
      terminal: {
        ...f.deps.terminal,
        focusAgent: async (target) => {
          focused.push(target.paneId);
          return true;
        },
      },
    });
    expect(result.error).toBeUndefined();
    expect(focused).toEqual(["101"]);
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
    const unrelated = await runTerminal(
      ["native", "new-request", "--pane", "101", "--cwd", f.clean],
      f.deps,
    );
    expect(unrelated.error).toBeDefined();
    expect(f.prompts).toEqual([]);
    f.setOwner(true);
    const failed = await runTerminal(["native", "new-request", "--pane", "101", "--cwd", f.clean], {
      ...f.deps,
      terminal: { ...f.deps.terminal, focusAgent: async () => false },
    });
    expect(failed.error?.message).toContain("could not be focused");
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("New request rechecks coordinator ownership after focusing before sending input", async () => {
  const f = await fixture();
  try {
    const result = await runTerminal(["native", "new-request", "--pane", "101", "--cwd", f.clean], {
      ...f.deps,
      terminal: {
        ...f.deps.terminal,
        focusAgent: async () => {
          f.setOwner(false);
          return true;
        },
      },
    });
    expect(result.error).toBeDefined();
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("Show PRs opens the cached repository-qualified PR in the originating project without fetching GitHub", async () => {
  const f = await fixture("tern");
  try {
    const task = await createPrTask(f);
    const path = nativeViewsPath(f.home, f.repo);
    await mkdir(join(f.home, "native-views"), { recursive: true });
    const model = {
      version: 1,
      project: f.repo,
      writtenAt: NOW,
      tasks: {},
      briefs: {},
      projects: [],
      pullRequests: {
        "owner/repo#42": {
          header: { taskId: task.id, repo: "owner/repo", number: 42 },
          detailFile: "pr-owner%2Frepo-42.json",
        },
      },
    };
    await writeFile(path, nativeViewText("panel", model));
    const result = await runTerminal(["native", "prs", "--pane", "101", "--cwd", f.clean], f.deps);
    expect(result.exitCode).toBe(0);
    expect(f.opened).toEqual([{ kind: "pr", repo: "owner/repo", number: 42 }]);
    await writeFile(path, nativeViewText("panel", { ...model, pullRequests: {} }));
    expect(
      (await runTerminal(["native", "prs", "--pane", "101", "--cwd", f.clean], f.deps)).exitCode,
    ).toBe(1);
    expect(f.opened).toHaveLength(1);
    // Ownership is proved before reading the cache, even with a valid locating pane/cwd.
    f.deps.terminal = {
      ...f.deps.terminal,
      inspect: async () => {
        throw new Error("Cannot prove coordinator ownership");
      },
    };
    await writeFile(path, "{broken");
    const refused = await runTerminal(["native", "prs", "--pane", "101", "--cwd", f.clean], f.deps);
    expect(refused.exitCode).toBe(1);
    expect(refused.error?.message).toContain("Cannot prove coordinator ownership");
    expect(f.opened).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("native navigation selects published projects and details, refusing stale or foreign inputs", async () => {
  const f = await fixture("tern");
  try {
    const focused = f.focused;
    await mkdir(join(f.home, "native-views"), { recursive: true });
    const path = nativeViewsPath(f.home, f.repo);
    const model = {
      version: 1,
      project: f.repo,
      writtenAt: new Date().toISOString(),
      changeSignature: "changed-work",
      tasks: {},
      briefs: { [f.record.id]: { detailFile: "brief-native.json" } },
      pullRequests: {},
      projects: [
        {
          terminal: "tern",
          repoPath: f.repo,
          current: true,
          offline: false,
          sessionId: "isolated",
        },
      ],
    };
    const publish = (data: unknown) => writeFile(path, nativeViewText("panel", data));
    await publish(model);
    await visitNativeProject(
      {
        home: f.home,
        project: f.repo,
        signature: "earlier-work",
        now: new Date(Date.now() - 2 * 3600000).toISOString(),
      },
      async () => {},
    );
    const action = (...args: string[]) =>
      runTerminal(["native", ...args, "--pane", "101", "--cwd", f.clean], f.deps);
    expect((await action("project", "next")).exitCode).toBe(0);
    expect(focused).toEqual(["101"]);
    expect(
      (
        await action(
          "view-file",
          join(f.home, "native-views", repositoryKey(f.repo), "brief-native.json"),
        )
      ).exitCode,
    ).toBe(0);
    expect(f.opened).toEqual([{ kind: "catchup" }, { kind: "brief", requestId: f.record.id }]);
    expect((await action("view-file", join(f.root, "foreign.json"))).exitCode).not.toBe(0);
    const tenth = [
      ...Array.from({ length: 9 }, (_, index) => ({
        terminal: "tern",
        repoPath: `/fixture/${index}`,
        current: false,
        offline: true,
      })),
      ...model.projects,
    ];
    await publish({ ...model, projects: tenth });
    expect((await action("project", `repo:${f.repo}`)).exitCode).toBe(0);
    await publish({ ...model, projects: [...tenth].reverse() });
    expect((await action("project", `repo:${f.repo}`)).exitCode).toBe(0);
    expect((await action("project", "repo:/foreign/project")).exitCode).not.toBe(0);
    expect(focused).toHaveLength(3);
    await publish({ ...model, writtenAt: "2000-01-01T00:00:00Z" });
    expect((await action("project", "1")).exitCode).not.toBe(0);
    await publish({ ...model, projects: [{ ...model.projects[0], current: false }] });
    expect((await action("project", "prev")).exitCode).not.toBe(0);
    await publish({ ...model, projects: [{ ...model.projects[0], offline: true }] });
    expect((await action("project", "1")).exitCode).not.toBe(0);
    expect(focused).toHaveLength(3);
    expect(f.opened).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const status of ["closed", "retained", "quarantined"] as const) {
  test(`native approval never retries workflow retirement when its receipt is ${status}`, async () => {
    const f = await fixture("tern");
    try {
      await f.write(f.seen);
      const result = await runCli(
        ["brief-approve", f.record.id, "--input", f.input, "--pane", "102", "--cwd", f.clean],
        {
          ...f.deps,
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
      );
      expect(result.exitCode).toBe(0);
      expect(f.closed).toHaveLength(0);
      expect(result.result?.value).toMatchObject({
        warnings: status === "closed" ? [] : [expect.stringContaining("Do not resubmit")],
      });
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
      await mkdir(join(source.home, "native-views"), { recursive: true });
      const model = {
        version: 1,
        project: source.repo,
        writtenAt: new Date().toISOString(),
        changeSignature: "before",
        tasks: {},
        briefs: {},
        pullRequests: {},
        projects: [
          {
            terminal: "tern",
            repoPath: source.repo,
            current: true,
            offline: false,
            sessionId: "isolated",
          },
          {
            terminal: "tern",
            repoPath: destination.repo,
            current: false,
            offline: false,
            sessionId: "isolated",
          },
        ],
      };
      await writeFile(nativeViewsPath(source.home, source.repo), nativeViewText("panel", model));
      await writeFile(
        nativeViewsPath(source.home, destination.repo),
        nativeViewText("panel", {
          ...model,
          project: destination.repo,
          changeSignature: "after",
        }),
      );
      await visitNativeProject(
        {
          home: source.home,
          project: destination.repo,
          signature: "before",
          now: new Date(Date.now() - 2 * 3600000).toISOString(),
        },
        async () => {},
      );
      const visitPath = join(
        source.home,
        "native-visits",
        `${repositoryKey(destination.repo)}.json`,
      );
      const before = await readFile(visitPath, "utf8");
      const events: string[] = [];
      const stdout: string[] = [];
      const result = await runTerminal(
        ["native", "project", "next", "--pane", "101", "--cwd", source.clean],
        {
          ...source.deps,
          stdout: (text) => stdout.push(text),
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
            openView: async (input) => {
              events.push("catchup");
              expect(input.coordinator).toEqual(record.endpoint);
              if (failure === "catchup-thrown") throw new Error("fixture catch-up failure");
              return { opened: false, warnings: ["fixture catch-up failure"] };
            },
          },
        },
      );
      const catchUpFailure = failure.startsWith("catchup");
      expect(result.exitCode).toBe(catchUpFailure ? 0 : 1);
      expect(events).toEqual(catchUpFailure ? ["focus", "catchup"] : ["focus"]);
      expect(await readFile(visitPath, "utf8")).toBe(before);
      if (catchUpFailure)
        expect(JSON.parse(stdout.join(""))).toEqual({
          focused: true,
          project: destination.repo,
          warnings: ["Project opened, but catch-up is unavailable: fixture catch-up failure"],
        });
      else
        expect(result.error?.message).toContain(
          failure === "focus-thrown" ? "fixture focus failure" : "could not focus",
        );
    } finally {
      await source.close();
      await destination.close();
    }
  });
}

for (const action of ["brief-approve", "brief-request-changes"] as const) {
  test(`${action} closes only its native brief origin after recording or delivering the action`, async () => {
    const f = await fixture("tern");
    try {
      await f.write(action === "brief-approve" ? f.seen : { ...f.seen, text: "Narrow this scope" });
      const result = await runTerminal(
        [
          "native",
          action,
          f.record.id,
          "--input",
          f.input,
          "--pane",
          "102",
          "--cwd",
          f.clean,
          "--window",
          "brief-window",
        ],
        f.deps,
      );
      expect(result.exitCode).toBe(0);
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

  test(`${action} keeps a newer native brief open when the coordinator revises it during delivery`, async () => {
    const f = await fixture("tern");
    const output: string[] = [];
    try {
      await f.write(action === "brief-approve" ? f.seen : { ...f.seen, text: "Narrow this scope" });
      const result = await runTerminal(
        ["native", action, f.record.id, "--input", f.input, "--pane", "102", "--cwd", f.clean],
        {
          ...f.deps,
          stdout: (text) => output.push(text),
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
      );
      expect(result.exitCode).toBe(0);
      expect(f.prompts).toHaveLength(1);
      expect(f.closed).toEqual([]);
      expect(output.join("")).toContain("current brief was left open");
      expect((await f.store.read(f.record.id))?.draft.revision).toBe(2);
    } finally {
      await f.close();
    }
  });

  test(`${action} reports an uncertain native close as a success warning without retrying delivery or closure`, async () => {
    const f = await fixture("tern");
    const output: string[] = [];
    let attempts = 0;
    try {
      await f.write(action === "brief-approve" ? f.seen : { ...f.seen, text: "Narrow this scope" });
      const result = await runTerminal(
        ["native", action, f.record.id, "--input", f.input, "--pane", "102", "--cwd", f.clean],
        {
          ...f.deps,
          stdout: (text) => output.push(text),
          terminal: {
            ...f.deps.terminal,
            closeView: async () => {
              attempts++;
              throw new Error("native close acknowledgement was lost");
            },
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(attempts).toBe(1);
      expect(f.prompts).toHaveLength(1);
      expect(output.join("")).toContain("Do not resubmit this action");
      if (action === "brief-approve")
        expect((await f.store.read(f.record.id))?.approval).toBeDefined();
    } finally {
      await f.close();
    }
  });
}

test("a refused native approval never closes the brief or prompts the coordinator", async () => {
  const f = await fixture("tern");
  try {
    await f.write({ ...f.seen, contentDigest: "stale" });
    const result = await runTerminal(
      [
        "native",
        "brief-approve",
        f.record.id,
        "--input",
        f.input,
        "--pane",
        "102",
        "--cwd",
        f.clean,
      ],
      f.deps,
    );
    expect(result.exitCode).not.toBe(0);
    expect(f.closed).toEqual([]);
    expect(f.prompts).toEqual([]);
    expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("cached taskless PRs open from palette, repo#number, numeric fallback and detail file, without mutation", async () => {
  const f = await fixture("tern");
  try {
    const path = nativeViewsPath(f.home, f.repo);
    const detailFile = "pr-owner%2Frepo-43.json";
    await mkdir(join(f.home, "native-views"), { recursive: true });
    await writeFile(
      path,
      nativeViewText("panel", {
        version: 1,
        project: f.repo,
        writtenAt: NOW,
        tasks: {},
        briefs: {},
        projects: [],
        pullRequests: {
          "owner/repo#43": { header: { repo: "owner/repo", number: 43 }, detailFile },
        },
      }),
    );
    for (const argv of [
      ["prs"],
      ["open", "pr", "owner/repo#43"],
      ["open", "pr", "43"],
      ["view-file", nativeDetailPath(f.home, f.repo, detailFile)],
    ]) {
      const result = await runTerminal(
        ["native", ...argv, "--pane", "101", "--cwd", f.clean],
        f.deps,
      );
      expect(result.error?.message).toBeUndefined();
      expect(result.exitCode).toBe(0);
    }
    expect(f.opened).toEqual(Array(4).fill({ kind: "pr", repo: "owner/repo", number: 43 }));
    expect(await f.service.list()).toEqual([]);
    expect(
      (await runCli(["pr-comment", "owner/repo#43", "--text", "Fix this"], f.deps)).exitCode,
    ).not.toBe(0);
    await f.write({
      tandemPrReview: 1,
      verdict: "comment",
      summary: "",
      drafts: [],
      yours: [],
      reviewHead: "abc",
      reviewGeneration: 0,
    });
    expect(
      (await runCli(["review-submit", "owner/repo#43", "--input", f.input], f.deps)).exitCode,
    ).not.toBe(0);
    expect(f.prompts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("owned PR thread replies retain exact context in a worker fix request without GitHub writes", async () => {
  const f = await fixture();
  try {
    const task = await createPrTask(f);
    const reply = {
      threadId: "thread-second",
      commentId: "node-second",
      replyTo: 22,
      body: "Keep this guard",
    };
    await f.write({ reviewHead: "a".repeat(40), replies: [reply] });
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
    expect(
      (await runCli(["pr-comment", task.id, "--input", f.input], { ...f.deps, run })).exitCode,
    ).toBe(0);
    const text = (await f.service.get(task.id)).communication?.messages[0]?.text;
    expect(text).toContain(
      "thread thread-second, root comment node-second (GitHub 22), removed.ts (outside current diff): Keep this guard",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.includes("POST")).toBe(false);
    await f.write({ reviewHead: "a".repeat(40), replies: [{ ...reply, commentId: "wrong" }] });
    expect(
      (await runCli(["pr-comment", task.id, "--input", f.input], { ...f.deps, run })).exitCode,
    ).not.toBe(0);
    expect((await f.service.get(task.id)).communication?.messages).toHaveLength(1);
  } finally {
    await f.close();
  }
});
