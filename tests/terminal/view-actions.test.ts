import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import { defaultPolicy } from "../../src/config/policy.ts";
import type { RequestBriefContent } from "../../src/contracts.ts";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { runTerminal } from "../../src/main.ts";
import { createRequestBriefStore } from "../../src/requests/store.ts";
import { createTandemService } from "../../src/service/controller.ts";
import { createTaskStore } from "../../src/tasks/store.ts";
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

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-view-actions-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const poolRoot = join(root, "pool");
  const clean = join(poolRoot, "coordinator");
  await mkdir(repo);
  await mkdir(clean, { recursive: true });
  const endpoint = {
    sessionId: "isolated",
    workspaceId: "workspace",
    tabId: "tab",
    paneId: "coordinator",
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
  let ownsCoordinator = true;
  const run = async (): Promise<never> => {
    throw new Error("No external commands expected");
  };
  const terminal: TerminalBackend = {
    ...terminalBackend(run),
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
    listPanes: async () => [{ ...endpoint, cwd: clean, foregroundCwd: clean }],
    promptAgent: async (target) => {
      prompts.push(target.text);
    },
    openView: async (target) => {
      opened.push(target.view);
      return { opened: true, warnings: [] };
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
      ["native", "brief-approve", f.record.id, "--input", f.input, "--json"],
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

test("brief comments reach the verified coordinator as user feedback on their original revision", async () => {
  const f = await fixture();
  try {
    await f.service.draftRequestBrief({
      repoPath: f.repo,
      requestId: f.record.id,
      content: { ...content, goal: "The revised goal" },
      reviewPane: false,
    });
    await f.write({
      ...f.seen,
      text: "Keep the original goal",
      comments: [{ line: 1, text: "Use this title" }],
    });
    const result = await runCli(["brief-comment", f.record.id, "--input", f.input], f.deps);
    expect(result.exitCode).toBe(0);
    expect(f.prompts[0]).toContain("From the open review page:");
    expect(f.prompts[0]).toContain(`Brief ${f.record.id}, revision 1: Comment`);
    expect(f.prompts[0]).toContain("Line 1 (");
    expect(f.prompts[0]).toContain("Use this title");
    expect((await f.store.read(f.record.id))?.draft.content.goal).toBe("The revised goal");
    expect((await f.store.read(f.record.id))?.approval).toBeUndefined();
  } finally {
    await f.close();
  }
});

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

test("brief feedback refuses invalid anchors and a coordinator pane occupied by another process", async () => {
  const f = await fixture();
  try {
    await f.write({ ...f.seen, comments: [{ line: 100_000, text: "bad anchor" }] });
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
    await f.store.update(f.record.id, f.record.revision, (record) => ({
      ...record,
      revision: record.revision + 1,
      repoPath: f.clean,
    }));
    await f.write({ ...f.seen, text: "A comment from the clean checkout" });
    expect(
      (await runCli(["brief-comment", f.record.id, "--input", f.input], f.deps)).exitCode,
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

test("Tandem PR comments become durable worker fix requests without any GitHub call", async () => {
  const f = await fixture();
  try {
    const task = await createPrTask(f);
    const result = await runTerminal(
      ["native", "pr-comment", task.id, "--text", "Fix src/view.ts:12"],
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
    expect(result.result?.value).toMatchObject({ opened: false });
    expect(JSON.stringify(result.result?.value)).toContain(
      "Herdr cannot display a native task view",
    );
    const reviews: string[] = [];
    const service = {
      ...f.service,
      reviewRequestBrief: async (id: string) => {
        reviews.push(id);
        return f.service.requestBrief(id);
      },
    };
    const brief = await runCli(["open", "brief", f.record.id], {
      ...f.deps,
      service,
      terminal: { ...f.deps.terminal, openView: herdr.openView },
    });
    expect(brief.exitCode).toBe(0);
    expect(reviews).toEqual([f.record.id]);
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
      reviewSubmit: async (_id: string, submission: unknown) => {
        submissions.push(submission);
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
    await f.write(input);
    const result = await runCli(["review-submit", "task-review", "--input", f.input], {
      ...f.deps,
      service,
    });
    expect(result.exitCode).toBe(0);
    expect(result.result?.value).toMatchObject({
      posted: false,
      message: "The reviewed head moved",
    });
    expect(submissions).toEqual([input]);
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

for (const contextSource of ["flags", "environment"] as const) {
  test(`native open selects the project and carries the plugin context from ${contextSource}`, async () => {
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
          "coordinator",
          ...(contextSource === "flags" ? ["--cwd", f.clean, "--window", "own-window"] : []),
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
            TANDEM_NATIVE_CWD: contextSource === "environment" ? f.clean : "/unrelated/project",
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.status).toBe("native");
      expect(scopes).toEqual([{ repoPath: f.repo, path: f.clean }]);
      expect(origins).toEqual([
        {
          paneId: "coordinator",
          cwd: f.clean,
          ...(contextSource === "flags" ? { windowId: "own-window" } : {}),
        },
      ]);
      expect(f.opened).toEqual([{ kind: "pr", taskId: task.id }]);
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
        "unrelated",
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
      ["native", "pr-comment", task.id, "--text", "Fix this"],
      f.deps,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message).toContain("worker has finished");
    expect((await f.service.get(task.id)).communication?.messages).toBeUndefined();
  } finally {
    await f.close();
  }
});
