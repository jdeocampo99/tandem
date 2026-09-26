import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergePullRequest,
  publishPullRequest,
  readDiffRange,
  readReferencingFiles,
} from "../../src/adapters/git.ts";
import {
  closeEndpoint,
  createReviewerEndpoint,
  createTaskEndpoint,
  inspectEndpoint,
  sendCommand,
  showNotification,
  splitBesidePane,
  taskWorkspaceLabel,
} from "../../src/adapters/herdr.ts";
import {
  listenPresentation,
  openPresentation,
  pollPresentation,
} from "../../src/adapters/lavish.ts";
import { buildOmpArgv, listOmpModels, validateModel } from "../../src/adapters/omp.ts";
import {
  AdapterProtocolError,
  ApprovalRequiredError,
  EndpointOwnershipError,
  LeaseSafetyError,
} from "../../src/adapters/primitives.ts";
import {
  acquireWorktree,
  destroyTreehouseWorktree,
  inspectPoolWorktree,
  readTreehousePoolStatus,
  releaseWorktree,
  sanitizeTaskBranchName,
} from "../../src/adapters/treehouse.ts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  WorktreeLease,
} from "../../src/contracts.ts";

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

function scriptedRunner(results: readonly CommandResult[]): Readonly<{
  readonly calls: CommandRequest[];
  readonly run: CommandRunner;
}> {
  const calls: CommandRequest[] = [];
  const remaining = [...results];
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const next = remaining.shift();
    if (next === undefined) throw new Error(`unexpected command ${JSON.stringify(request.argv)}`);
    return next;
  };
  return { calls, run };
}

function endpoint(): Endpoint {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: "pane-1",
    role: "implementer",
    generation: 2,
  };
}
function panePayload(
  value: Partial<{
    paneId: string;
    tabId: string;
    workspaceId: string;
    foregroundCwd: string;
  }> = {},
): string {
  return JSON.stringify({
    result: {
      pane: {
        pane_id: value.paneId ?? "pane-1",
        tab_id: value.tabId ?? "tab-1",
        workspace_id: value.workspaceId ?? "workspace-1",
        foreground_cwd: value.foregroundCwd ?? "/tmp/worktree",
      },
    },
  });
}

function processPayload(paneId = "pane-1", processes: readonly unknown[] = []): string {
  return JSON.stringify({
    result: { process_info: { pane_id: paneId, foreground_processes: processes } },
  });
}

const lease: WorktreeLease = {
  root: "/tmp/treehouse",
  path: "/tmp/treehouse/worktree",
  name: "Task/Test",
  baseHead: "abc123",
  branch: "tandem/Task-Test",
  leaseId: "lease-1",
  leaseHolder: "tandem-1",
  leasedAt: "2030-01-02T03:04:05.000Z",
};

test("creates a reviewer in the same physical worktree through a path alias", async () => {
  const runner = scriptedRunner([
    result(panePayload({ foregroundCwd: "/private/tmp/worktree" })),
    result(processPayload()),
    result(panePayload({ paneId: "reviewer-1" })),
  ]);
  const reviewer = await createReviewerEndpoint(
    runner.run,
    { sessionId: "session-1", cwd: "/tmp/worktree", writer: endpoint(), generation: 2 },
    { realpath: async (path) => path.replace(/^\/tmp\//u, "/private/tmp/") },
  );
  expect(reviewer.endpoint.paneId).toBe("reviewer-1");
  expect(reviewer.endpoint.workspaceId).toBe(endpoint().workspaceId);
  expect(reviewer.endpoint.role).toBe("reviewer");
  expect(reviewer.warnings).toEqual([]);
});

test("refuses a reviewer in a different physical worktree", async () => {
  const runner = scriptedRunner([
    result(panePayload({ foregroundCwd: "/tmp/another-worktree" })),
    result(processPayload()),
  ]);
  await expect(
    createReviewerEndpoint(
      runner.run,
      { sessionId: "session-1", cwd: "/tmp/worktree", writer: endpoint(), generation: 2 },
      { realpath: async (path) => path },
    ),
  ).rejects.toBeInstanceOf(EndpointOwnershipError);
});

test("splits beside an anchor pane in its own workspace and tab without touching the anchor", async () => {
  const runner = scriptedRunner([
    result(panePayload({ paneId: "anchor-1" })),
    result(panePayload({ paneId: "split-1" })),
  ]);
  const split = await splitBesidePane(runner.run, {
    sessionId: "session-1",
    cwd: "/tmp/repo",
    anchorPaneId: "anchor-1",
    role: "coordinator",
    generation: 0,
  });

  expect(split.endpoint).toEqual({
    sessionId: "session-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: "split-1",
    role: "coordinator",
    generation: 0,
  });
  expect(runner.calls.map((call) => call.argv)).toEqual([
    ["herdr", "--session", "session-1", "pane", "get", "anchor-1"],
    [
      "herdr",
      "--session",
      "session-1",
      "pane",
      "split",
      "anchor-1",
      "--direction",
      "right",
      "--cwd",
      "/tmp/repo",
      "--no-focus",
    ],
  ]);
});

test("refuses a split that lands outside the anchor's tab", async () => {
  const runner = scriptedRunner([
    result(panePayload({ paneId: "anchor-1" })),
    result(panePayload({ paneId: "split-1", tabId: "tab-2" })),
  ]);
  await expect(
    splitBesidePane(runner.run, {
      sessionId: "session-1",
      cwd: "/tmp/repo",
      anchorPaneId: "anchor-1",
      role: "coordinator",
      generation: 0,
    }),
  ).rejects.toBeInstanceOf(EndpointOwnershipError);
});

test("sanitizes task branches and builds the exact OMP invocation", () => {
  expect(sanitizeTaskBranchName("  Fix: pane / ownership  ")).toBe("tandem/Fix-pane-ownership");
  expect(
    buildOmpArgv({
      model: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
      prompt: "Implement the approved scope.",
    }),
  ).toEqual([
    "omp",
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--thinking",
    "max",
    "--no-prewalk",
    "--no-extensions",
    "--no-title",
    "Implement the approved scope.",
  ]);
});
test("labels use readable role names while preserving normalized bounded identity", () => {
  const objective = `Fix parser\nwith hostile\u0000 controls and ${"界".repeat(120)}`;
  const first = taskWorkspaceLabel(
    "tandem-task-01M2TV2GZ4FG73A3GMVVSJ24S0",
    objective,
    "implementer",
  );
  const second = taskWorkspaceLabel(
    "tandem-task-01M2TV2GZ4FG73A3GMVVSJ24S1",
    objective,
    "implementer",
  );

  expect(first).toMatch(/^└ implement Fix parser with hostile controls/u);
  expect(first).toContain("A3GMVVSJ24S0");
  expect(first).not.toContain(" · impl");
  expect(first).not.toMatch(/\p{Cc}/u);
  expect(first.length).toBeLessThanOrEqual(96);
  expect(second).not.toBe(first);
});

test("labels use readable role names, avoid duplicates, and provide a fallback", () => {
  const scoutLabel = taskWorkspaceLabel("tandem-task-research", "Research app standards", "scout");
  const implementationLabel = taskWorkspaceLabel(
    "tandem-task-implementation",
    "implement app store review",
    "implementer",
  );
  const reviewerLabel = taskWorkspaceLabel(
    "tandem-task-review",
    "inspect app store review",
    "reviewer",
  );

  expect(scoutLabel).toMatch(/^└ Research app standards · /u);
  expect(scoutLabel).not.toContain("research Research");
  expect(reviewerLabel).toMatch(/^└ task inspect app store review · /u);
  expect(implementationLabel).not.toContain("implement implement");
});

test("long labels retain complete graphemes and normalize combining marks", () => {
  const cluster = "\u{1F469}\u200d\u{1F4BB}";
  const label = taskWorkspaceLabel("tandem-task-1", `e\u0301${cluster.repeat(30)}`, "implementer");
  const title = label.slice(0, label.indexOf(" · "));
  expect(title).toMatch(new RegExp(`^└ implement é(?:${cluster})*…$`, "u"));
  expect(label.length).toBeLessThanOrEqual(96);
});

test("validates an exact OMP model selector and thinking level without fallback", async () => {
  const runner = scriptedRunner([
    result(
      JSON.stringify({
        models: [
          {
            selector: "openai-codex/gpt-5.6-luna",
            id: "gpt-5.6-luna",
            provider: "openai-codex",
            thinking: ["medium", "max"],
          },
        ],
      }),
    ),
  ]);

  const model = await validateModel(runner.run, {
    cwd: "/tmp/repo",
    model: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
  });
  expect(model.provider).toBe("openai-codex");
  expect(runner.calls[0]?.argv).toEqual(["omp", "models", "--json"]);

  const mismatch = scriptedRunner([
    result(
      JSON.stringify({
        models: [
          {
            selector: "openai-codex/gpt-5.5",
            id: "gpt-5.5",
            provider: "openai-codex",
            thinking: ["max"],
          },
        ],
      }),
    ),
  ]);
  await expect(
    validateModel(mismatch.run, {
      cwd: "/tmp/repo",
      model: { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
    }),
  ).rejects.toBeInstanceOf(AdapterProtocolError);
});
test("lists available OMP models with conservative optional metadata", async () => {
  const runner = scriptedRunner([
    result(
      JSON.stringify({
        models: [
          {
            provider: "openai-codex",
            id: "gpt-5.6-luna",
            selector: "openai-codex/gpt-5.6-luna",
            name: "GPT-5.6-Luna",
            reasoning: true,
            contextWindow: 272000,
            thinking: ["low", "max"],
            cost: { input: 0.2, output: 1.2, cacheRead: 0.02 },
          },
          {
            provider: "openai-codex",
            id: "gpt-5.5",
            selector: "openai-codex/gpt-5.5",
            thinking: ["low"],
          },
        ],
      }),
    ),
  ]);

  await expect(listOmpModels(runner.run, { cwd: "/tmp/repo" })).resolves.toEqual([
    {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      selector: "openai-codex/gpt-5.6-luna",
      name: "GPT-5.6-Luna",
      reasoning: true,
      contextWindow: 272000,
      thinking: ["low", "max"],
      cost: { input: 0.2, output: 1.2 },
    },
    {
      provider: "openai-codex",
      id: "gpt-5.5",
      selector: "openai-codex/gpt-5.5",
      thinking: ["low"],
    },
  ]);
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0]?.argv).toEqual(["omp", "models", "--json"]);
});

test("refuses a Herdr endpoint whose pane identity changed", async () => {
  const runner = scriptedRunner([result(panePayload({ workspaceId: "other-workspace" }))]);

  await expect(
    inspectEndpoint(runner.run, { endpoint: endpoint(), cwd: "/tmp/worktree" }),
  ).rejects.toBeInstanceOf(EndpointOwnershipError);
  expect(runner.calls).toHaveLength(1);
});

test("accepts omitted foreground processes on native worker exit", async () => {
  const runner = scriptedRunner([
    result(panePayload()),
    result(JSON.stringify({ result: { process_info: { pane_id: endpoint().paneId } } })),
  ]);
  const inspection = await inspectEndpoint(runner.run, {
    endpoint: endpoint(),
    cwd: "/tmp/worktree",
  });
  expect(inspection.activeWorker).toBe(false);
});

test("rejects malformed foreground processes rather than treating them as idle", async () => {
  const runner = scriptedRunner([
    result(panePayload()),
    result(
      JSON.stringify({
        result: { process_info: { pane_id: endpoint().paneId, foreground_processes: null } },
      }),
    ),
  ]);
  await expect(
    inspectEndpoint(runner.run, { endpoint: endpoint(), cwd: "/tmp/worktree" }),
  ).rejects.toBeInstanceOf(AdapterProtocolError);
});

test("sends a hostile command as one quoted pane command after identity inspection", async () => {
  const runner = scriptedRunner([result(panePayload()), result(processPayload()), result()]);
  const command = ["printf", "$(touch /tmp/not-created)"];
  const sent = await sendCommand(runner.run, {
    endpoint: endpoint(),
    cwd: "/tmp/worktree",
    command,
  });

  expect(sent.command).toEqual(command);
  expect(runner.calls[2]?.argv).toEqual([
    "herdr",
    "--session",
    "session-1",
    "pane",
    "run",
    "pane-1",
    "'printf' '$(touch /tmp/not-created)'",
  ]);
});

test("creates a task workspace and best-effort moves it directly after its parent", async () => {
  const moved: { request: unknown }[] = [];
  const runner = scriptedRunner([
    result(
      JSON.stringify({
        result: {
          workspace: { workspace_id: "workspace-child" },
          tab: { tab_id: "tab-child" },
          root_pane: { pane_id: "pane-child" },
        },
      }),
    ),
    result(
      JSON.stringify({
        server: { socket: "/tmp/herdr.sock", running: true, session: "session-1" },
      }),
    ),
    result(
      JSON.stringify({
        result: {
          workspaces: [{ workspace_id: "workspace-parent" }, { workspace_id: "workspace-child" }],
        },
      }),
    ),
  ]);

  const created = await createTaskEndpoint(
    runner.run,
    {
      sessionId: "session-1",
      cwd: "/tmp/worktree",
      taskName: "Implement child",
      workspaceLabel: "└ Implement child · child",
      role: "implementer",
      generation: 1,
      parentWorkspaceId: "workspace-parent",
    },
    {
      moveWorkspace: async (request) => {
        moved.push({ request });
        return {
          result: {
            type: "workspace_list",
            workspaces: [{ workspace_id: "workspace-parent" }, { workspace_id: "workspace-child" }],
          },
        };
      },
    },
  );

  expect(created.endpoint.paneId).toBe("pane-child");
  expect(created.warnings).toEqual([]);
  expect(runner.calls[0]?.argv).toContain("└ Implement child · child");
  expect(moved[0]?.request).toEqual({
    socketPath: "/tmp/herdr.sock",
    workspaceId: "workspace-child",
    insertIndex: 1,
  });
});

test("reports workspace-order warnings separately from the endpoint", async () => {
  const runner = scriptedRunner([
    result(
      JSON.stringify({
        result: {
          workspace: { workspace_id: "workspace-child" },
          tab: { tab_id: "tab-child" },
          root_pane: { pane_id: "pane-child" },
        },
      }),
    ),
  ]);
  const reportedWarnings: string[] = [];
  const created = await createTaskEndpoint(
    runner.run,
    {
      sessionId: "session-1",
      cwd: "/tmp/worktree",
      taskName: "Implement child",
      workspaceLabel: "└ Implement child · child",
      role: "implementer",
      generation: 1,
      parentWorkspaceId: "workspace-child",
    },
    { warn: (message) => reportedWarnings.push(message) },
  );

  expect(created.endpoint.paneId).toBe("pane-child");
  expect(created.warnings).toHaveLength(1);
  expect(created.warnings).toEqual(reportedWarnings);
  expect(Object.hasOwn(created.endpoint, "warnings")).toBe(false);
});

test("pins a newly acquired lease to the captured commit when the pool checkout is newer", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-treehouse-pin-"));
  const repo = join(home, "repo");
  const pool = join(home, "pool");
  const slot = join(pool, "slot");
  await mkdir(repo, { recursive: true });
  await mkdir(pool, { recursive: true });
  const environment = {
    ...process.env,
    GIT_AUTHOR_NAME: "Tandem Test",
    GIT_AUTHOR_EMAIL: "tandem@example.test",
    GIT_COMMITTER_NAME: "Tandem Test",
    GIT_COMMITTER_EMAIL: "tandem@example.test",
  };
  const runGit = async (args: readonly string[], cwd = repo): Promise<string> => {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
    return stdout.trim();
  };
  try {
    await runGit(["init", "-b", "main"]);
    await writeFile(join(repo, "source.txt"), "A\n");
    await runGit(["add", "source.txt"]);
    await runGit(["commit", "-m", "A"]);
    const sourceHead = await runGit(["rev-parse", "HEAD"]);
    await writeFile(join(repo, "source.txt"), "B\n");
    await runGit(["commit", "-am", "B"]);
    const poolHead = await runGit(["rev-parse", "HEAD"]);
    await runGit(["worktree", "add", "--detach", slot, poolHead]);

    const run: CommandRunner = async (request) => {
      if (request.argv[0] === "treehouse" && request.argv.includes("status")) {
        return result("[]");
      }
      if (request.argv[0] === "treehouse" && request.argv.includes("get")) {
        return result(
          JSON.stringify({
            path: slot,
            lease_id: "lease-pinned",
            lease_holder: "tandem-pinned",
            leased_at: "2030-01-02T03:04:05.000Z",
          }),
        );
      }
      const child = Bun.spawn([...request.argv], {
        cwd: request.cwd,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    };

    const acquired = await acquireWorktree(run, {
      repo,
      root: pool,
      tandemId: "tandem-pinned",
      taskName: "Pinned",
      sourceHead,
    });
    expect(acquired.baseHead).toBe(sourceHead);
    expect(await runGit(["rev-parse", "HEAD"], slot)).toBe(sourceHead);
    expect(await readFile(join(slot, "source.txt"), "utf8")).toBe("A\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reuses a leftover task branch with no extra commits and refuses one that holds work", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-treehouse-leftover-"));
  const repo = join(home, "repo");
  const pool = join(home, "pool");
  const slot = join(pool, "slot");
  await mkdir(repo, { recursive: true });
  await mkdir(pool, { recursive: true });
  const environment = {
    ...process.env,
    GIT_AUTHOR_NAME: "Tandem Test",
    GIT_AUTHOR_EMAIL: "tandem@example.test",
    GIT_COMMITTER_NAME: "Tandem Test",
    GIT_COMMITTER_EMAIL: "tandem@example.test",
  };
  const spawn = async (argv: readonly string[], cwd: string): Promise<CommandResult> => {
    const child = Bun.spawn([...argv], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  const runGit = async (args: readonly string[], cwd = repo): Promise<string> => {
    const outcome = await spawn(["git", ...args], cwd);
    if (outcome.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${outcome.stderr}`);
    return outcome.stdout.trim();
  };
  const run: CommandRunner = async (request) => {
    if (request.argv[0] === "treehouse" && request.argv.includes("status")) return result("[]");
    if (request.argv[0] === "treehouse" && request.argv.includes("get")) {
      return result(
        JSON.stringify({
          path: slot,
          lease_id: "lease-leftover",
          lease_holder: "tandem-leftover",
          leased_at: "2030-01-02T03:04:05.000Z",
        }),
      );
    }
    return spawn(request.argv, request.cwd);
  };
  const acquire = async (sourceHead: string) =>
    acquireWorktree(run, {
      repo,
      root: pool,
      tandemId: "tandem-leftover",
      taskName: "Leftover",
      sourceHead,
    });
  try {
    await runGit(["init", "-b", "main"]);
    await writeFile(join(repo, "source.txt"), "A\n");
    await runGit(["add", "source.txt"]);
    await runGit(["commit", "-m", "A"]);
    const first = await runGit(["rev-parse", "HEAD"]);
    await runGit(["worktree", "add", "--detach", slot, first]);
    const branch = (await acquire(first)).branch;

    // A later home asks for the same branch at a newer source: it moves forward.
    await runGit(["switch", "--detach"], slot);
    await runGit(["commit", "--allow-empty", "-m", "B"]);
    const second = await runGit(["rev-parse", "HEAD"]);
    await acquire(second);
    expect(await runGit(["branch", "--show-current"], slot)).toBe(branch);
    expect(await runGit(["rev-parse", "HEAD"], slot)).toBe(second);

    // Once the branch holds a commit the source lacks, it is refused rather than moved.
    await runGit(["commit", "--allow-empty", "-m", "work"], slot);
    await runGit(["switch", "--detach", second], slot);
    await expect(acquire(second)).rejects.toThrow("already exists with commits");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("preserves acquired lease identity when post-acquire validation fails", async () => {
  const runner = scriptedRunner([
    result("[]"),
    result(
      JSON.stringify({
        path: lease.path,
        lease_id: lease.leaseId,
        lease_holder: lease.leaseHolder,
        leased_at: lease.leasedAt,
      }),
    ),
    result("", 1, "not a git worktree"),
  ]);

  let caught: unknown;
  try {
    await acquireWorktree(
      runner.run,
      {
        repo: "/tmp/repo",
        root: lease.root,
        tandemId: lease.leaseHolder,
        taskName: lease.name,
        sourceHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      { realpath: async (path) => path },
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LeaseSafetyError);
  if (caught instanceof LeaseSafetyError) {
    expect(caught.lease.leaseId).toBe(lease.leaseId);
  }
});

test("requires explicit approval before a destructive release or pull request merge", async () => {
  const releaseRunner = scriptedRunner([]);
  await expect(
    releaseWorktree(releaseRunner.run, {
      repo: "/tmp/repo",
      lease,
      childWorkerStopped: true,
      discard: true,
    }),
  ).rejects.toBeInstanceOf(ApprovalRequiredError);
  expect(releaseRunner.calls).toHaveLength(0);

  const mergeRunner = scriptedRunner([]);
  await expect(
    mergePullRequest(mergeRunner.run, {
      cwd: "/tmp/repo",
      repository: "acme/repo",
      number: 7,
      expectedHead: "reviewed-head",
      method: "squash",
      approved: false,
    }),
  ).rejects.toBeInstanceOf(ApprovalRequiredError);
  expect(mergeRunner.calls).toHaveLength(0);
});

test("preserves Treehouse return diagnostics in a failed destructive release", async () => {
  const status = JSON.stringify([
    {
      name: lease.name,
      path: lease.path,
      status: "leased",
      flavor: "git",
      lease_id: lease.leaseId,
      lease_holder: lease.leaseHolder,
      leased_at: lease.leasedAt,
      processes: [],
    },
  ]);
  const runner = scriptedRunner([
    result(status),
    result("", 1, "Treehouse refused to return the checkout"),
  ]);

  await expect(
    releaseWorktree(runner.run, {
      repo: "/tmp/repo",
      lease,
      childWorkerStopped: true,
      discard: true,
      destructiveApproval: true,
    }),
  ).rejects.toThrow(/Treehouse refused to return the checkout/u);
});

test("refuses a pull request merge when the reviewed head is stale", async () => {
  const runner = scriptedRunner([
    result(
      JSON.stringify({
        number: 7,
        state: "OPEN",
        headRefOid: "changed-head",
        isDraft: false,
        baseRefName: "main",
      }),
    ),
  ]);
  let caught: unknown;
  try {
    await mergePullRequest(runner.run, {
      cwd: "/tmp/repo",
      repository: "acme/repo",
      number: 7,
      expectedHead: "reviewed-head",
      method: "squash",
      approved: true,
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AdapterProtocolError);
  if (caught instanceof AdapterProtocolError) {
    expect(caught.message).toContain("does not match expected head");
  }
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0]?.argv).toEqual([
    "gh",
    "pr",
    "view",
    "7",
    "--repo",
    "acme/repo",
    "--json",
    "number,url,state,isDraft,headRefOid,baseRefName,title",
  ]);
});

test("pins the reviewed head and verifies the merged pull request response", async () => {
  const runner = scriptedRunner([
    result(
      JSON.stringify({
        number: 7,
        state: "OPEN",
        headRefOid: "reviewed-head",
        isDraft: false,
        baseRefName: "main",
      }),
    ),
    result(),
    result(
      JSON.stringify({
        number: 7,
        state: "MERGED",
        headRefOid: "reviewed-head",
        isDraft: false,
        baseRefName: "main",
      }),
    ),
  ]);

  const merged = await mergePullRequest(runner.run, {
    cwd: "/tmp/repo",
    repository: "acme/repo",
    number: 7,
    expectedHead: "reviewed-head",
    method: "squash",
    approved: true,
  });

  expect(merged.state).toBe("merged");
  expect(runner.calls[1]?.argv).toEqual([
    "gh",
    "pr",
    "merge",
    "7",
    "--repo",
    "acme/repo",
    "--squash",
    "--match-head-commit",
    "reviewed-head",
  ]);
});

test("observes the published PR commit and distinguishes a draft from GitHub OPEN state", async () => {
  const runner = scriptedRunner([
    result("https://github.com/acme/repo/pull/7\n"),
    result(
      JSON.stringify({
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        state: "OPEN",
        headRefOid: "reviewed-head",
        isDraft: true,
        baseRefName: "main",
        title: "Task",
      }),
    ),
  ]);
  const pullRequest = await publishPullRequest(runner.run, {
    cwd: "/tmp/repo",
    repository: "acme/repo",
    title: "Task",
    body: "# What\n- change\n\n# Why\n- reason\n\n# Validation\n- smoke",
    base: "main",
    head: "tandem/task",
  });

  expect(pullRequest).toEqual({
    repository: "acme/repo",
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
    title: "Task",
    state: "draft",
    head: "reviewed-head",
    base: "main",
  });
  expect(runner.calls[0]?.argv.slice(0, 4)).toEqual(["gh", "pr", "create", "--repo"]);
});

test("keeps Lavish feedback raw and marks ended sessions terminal", async () => {
  const runner = scriptedRunner([
    result(
      [
        "session:",
        "  status: feedback",
        "  session_ended: false",
        "feedback[0]{message,kind}:",
        "  message: Please review the artifact",
      ].join("\n"),
    ),
    result("session:\n  status: ended\n  session_ended: true\n"),
  ]);

  const opened = await openPresentation(runner.run, "/tmp/artifact.html", "/tmp/repo");
  expect(opened.status).toBe("feedback");
  expect(opened.terminal).toBe(false);
  expect(opened.rawFeedback).toContain("Please review the artifact");

  const polled = await pollPresentation(runner.run, "/tmp/artifact.html", "/tmp/repo");
  expect(polled.status).toBe("ended");
  expect(polled.terminal).toBe(true);
  expect(runner.calls[1]?.argv).toEqual([
    "lavish-axi",
    "poll",
    "/tmp/artifact.html",
    "--timeout-ms",
    "1000",
  ]);
  expect(runner.calls[1]?.timeoutMs).toBe(5000);
});
test("extracts the native session URL from an opened presentation response", async () => {
  const runner = scriptedRunner([
    result(
      [
        "session:",
        "  status: opened",
        "  session_ended: false",
        "  url: http://127.0.0.1:4567/presentation",
      ].join("\n"),
    ),
  ]);
  const observation = await openPresentation(runner.run, "/tmp/artifact.html", "/tmp/repo");
  expect(observation.sessionUrl).toBe("http://127.0.0.1:4567/presentation");
});

test("continuous presentation listening leaves the native command without a timeout", async () => {
  const runner = scriptedRunner([result("session:\n  status: waiting\n  session_ended: false\n")]);
  const observation = await listenPresentation(runner.run, "/tmp/artifact.html", "/tmp/repo");
  expect(observation.status).toBe("waiting");
  expect(runner.calls[0]?.argv).toEqual(["lavish-axi", "poll", "/tmp/artifact.html"]);
  expect(runner.calls[0]?.timeoutMs).toBeUndefined();
});

test("accepts native opened, ready, and user-ended sessions as nonterminal observations", async () => {
  const statuses = ["opened", "ready", "user-ended"] as const;
  const runner = scriptedRunner(
    statuses.map((status) => result(`session:\n  status: ${status}\n  session_ended: false\n`)),
  );

  for (const status of statuses) {
    const observation = await openPresentation(runner.run, "/tmp/artifact.html", "/tmp/repo");
    expect(observation.status).toBe(status);
    expect(observation.terminal).toBe(false);
    expect(observation.sessionEnded).toBe(false);
  }
});

test("keeps a disconnected Lavish session resumable without reopening it", async () => {
  const runner = scriptedRunner([
    result("session:\n  status: browser_disconnected\n  session_ended: false\n"),
  ]);
  const observation = await pollPresentation(runner.run, "/tmp/artifact.html", "/tmp/repo");
  expect(observation.status).toBe("browser_disconnected");
  expect(observation.terminal).toBe(false);
  expect(observation.sessionEnded).toBe(false);
  expect(runner.calls).toHaveLength(1);
});

test("close endpoint never closes a pane with an active worker", async () => {
  const runner = scriptedRunner([
    result(panePayload()),
    result(
      processPayload("pane-1", [
        {
          pid: 42,
          name: "node",
          argv: ["node", "worker.js"],
          argv0: "node",
          cmdline: "node worker.js",
        },
      ]),
    ),
  ]);

  await expect(
    closeEndpoint(runner.run, { endpoint: endpoint(), cwd: "/tmp/worktree" }),
  ).rejects.toThrow("active foreground worker");
  expect(runner.calls).toHaveLength(2);
});

test("confirms pane closure from Herdr's structured stderr response", async () => {
  const runner = scriptedRunner([
    result(panePayload()),
    result(processPayload()),
    result(),
    result("", 1, JSON.stringify({ error: { code: "pane_not_found" } })),
  ]);
  const closed = await closeEndpoint(runner.run, { endpoint: endpoint(), cwd: "/tmp/worktree" });
  expect(closed.closed).toBe(true);
});

test("closing an already absent owned pane is idempotent", async () => {
  const runner = scriptedRunner([
    result("", 1, JSON.stringify({ error: { code: "pane_not_found" } })),
  ]);
  const closed = await closeEndpoint(runner.run, { endpoint: endpoint(), cwd: "/tmp/worktree" });
  expect(closed.closed).toBe(true);
  expect(runner.calls).toHaveLength(1);
});

test("parses the strict Treehouse pool status envelope", async () => {
  const runner = scriptedRunner([
    result(
      JSON.stringify([
        {
          name: "1",
          path: "/tmp/treehouse/worktree",
          status: "available",
          flavor: "git",
          lease_id: "",
          lease_holder: "",
          leased_at: null,
          processes: [],
        },
      ]),
    ),
  ]);

  const records = await readTreehousePoolStatus(runner.run, {
    repo: "/tmp/repo",
    root: "/tmp/treehouse",
  });

  expect(records).toEqual([
    {
      name: "1",
      path: "/tmp/treehouse/worktree",
      status: "available",
      flavor: "git",
      leaseId: "",
      leaseHolder: "",
      leasedAt: null,
      processes: [],
    },
  ]);
  expect(runner.calls[0]?.argv).toEqual([
    "treehouse",
    "--root",
    "/tmp/treehouse",
    "status",
    "--json",
  ]);
});

test("refuses malformed Treehouse pool metadata instead of guessing safety", async () => {
  const runner = scriptedRunner([
    result(
      JSON.stringify([
        {
          name: "1",
          path: "/tmp/treehouse/worktree",
          status: "available",
          flavor: "git",
          lease_id: "",
          lease_holder: "",
          leased_at: null,
        },
      ]),
    ),
  ]);

  await expect(
    readTreehousePoolStatus(runner.run, {
      repo: "/tmp/repo",
      root: "/tmp/treehouse",
    }),
  ).rejects.toBeInstanceOf(AdapterProtocolError);
});

test("checks ignored content and merged ancestry before pool destruction", async () => {
  const runner = scriptedRunner([
    result(""),
    result(""),
    result("/tmp/treehouse/worktree"),
    result("/tmp/repo"),
    result("copy-head"),
    result("primary-head"),
    result(""),
  ]);

  const safety = await inspectPoolWorktree(
    runner.run,
    {
      repo: "/tmp/repo",
      path: "/tmp/treehouse/worktree",
    },
    { realpath: async (path) => path },
  );

  expect(safety).toEqual({ clean: true, ignored: false, unmerged: false, merged: true });
  expect(runner.calls[0]?.argv).toEqual([
    "git",
    "-C",
    "/tmp/treehouse/worktree",
    "status",
    "--porcelain=v1",
    "--ignored",
    "--untracked-files=all",
  ]);
});

test("accepts a realpath alias when Git reports the same physical worktree", async () => {
  const runner = scriptedRunner([
    result(""),
    result(""),
    result("/private/tmp/treehouse/worktree"),
    result("/private/tmp/repo"),
    result("copy-head"),
    result("primary-head"),
    result(""),
  ]);

  const safety = await inspectPoolWorktree(
    runner.run,
    { repo: "/tmp/repo", path: "/tmp/treehouse/worktree" },
    { realpath: async (path) => path.replace(/^\/tmp/u, "/private/tmp") },
  );

  expect(safety.merged).toBe(true);
});

test("rejects a clean path whose Git root is a different physical worktree", async () => {
  const runner = scriptedRunner([
    result(""),
    result(""),
    result("/private/tmp/treehouse/other-worktree"),
    result("/private/tmp/repo"),
  ]);

  const safety = await inspectPoolWorktree(
    runner.run,
    { repo: "/tmp/repo", path: "/tmp/treehouse/worktree" },
    { realpath: async (path) => path.replace(/^\/tmp/u, "/private/tmp") },
  );

  expect(safety).toEqual({ clean: true, ignored: false, unmerged: false, merged: false });
  expect(runner.calls).toHaveLength(4);
});

test("destroys one exact Treehouse target with the safe confirmation flag", async () => {
  const runner = scriptedRunner([result()]);

  await expect(
    destroyTreehouseWorktree(runner.run, {
      repo: "/tmp/repo",
      root: "/tmp/treehouse",
      path: "/tmp/treehouse/worktree",
    }),
  ).resolves.toBe(true);
  expect(runner.calls[0]?.argv).toEqual([
    "treehouse",
    "--root",
    "/tmp/treehouse",
    "destroy",
    "/tmp/treehouse/worktree",
    "--yes",
  ]);
});

test("readDiffRange reports the changed files and bounds the patch", async () => {
  const patch = "x".repeat(200);
  const { calls, run } = scriptedRunner([result("src/a.ts\nsrc/b.ts\n"), result(patch)]);

  const observation = await readDiffRange(run, {
    repo: "/repo",
    fromRef: "base",
    toRef: "head",
    maxBytes: 64,
  });

  expect(observation.files).toEqual(["src/a.ts", "src/b.ts"]);
  expect(observation.truncated).toBe(true);
  expect(observation.patch).toHaveLength(64);
  expect(calls[0]?.argv).toEqual([
    "git",
    "-C",
    "/repo",
    "diff",
    "--no-ext-diff",
    "--name-only",
    "base..head",
  ]);
  expect(calls[1]?.argv).toContain("base..head");
});

test("readDiffRange keeps an empty range readable", async () => {
  const { run } = scriptedRunner([result(""), result("")]);

  const observation = await readDiffRange(run, {
    repo: "/repo",
    fromRef: "base",
    toRef: "head",
    maxBytes: 64,
  });

  expect(observation.files).toEqual([]);
  expect(observation.truncated).toBe(false);
});

test("readReferencingFiles excludes the changed files and bounds the result", async () => {
  const { calls, run } = scriptedRunner([
    result("head:src/a.ts\nhead:src/main.ts\nhead:src/cli.ts\n"),
  ]);

  const referencing = await readReferencingFiles(run, {
    repo: "/repo",
    ref: "head",
    files: ["src/a.ts"],
    maxResults: 1,
  });

  expect(referencing).toEqual(["src/main.ts"]);
  expect(calls[0]?.argv).toEqual([
    "git",
    "-C",
    "/repo",
    "grep",
    "--files-with-matches",
    "--fixed-strings",
    "-e",
    "a",
    "head",
  ]);
});

test("readReferencingFiles treats no match as an empty observation", async () => {
  const { run } = scriptedRunner([result("", 1)]);

  await expect(
    readReferencingFiles(run, { repo: "/repo", ref: "head", files: ["src/a.ts"], maxResults: 5 }),
  ).resolves.toEqual([]);
});

test("readReferencingFiles surfaces a real git failure", async () => {
  const { run } = scriptedRunner([result("", 128, "fatal: bad revision")]);

  await expect(
    readReferencingFiles(run, { repo: "/repo", ref: "head", files: ["src/a.ts"], maxResults: 5 }),
  ).rejects.toThrow();
});

test("a Herdr notification goes through the user's toast settings with the needs-input sound", async () => {
  const runner = scriptedRunner([{ code: 0, stdout: "", stderr: "" }]);
  await showNotification(runner.run, "session-1", "/repo", {
    title: "Tandem: Dark mode",
    body: "brief waiting for approval · prefix+t for status",
  });
  expect(runner.calls[0]?.argv).toEqual([
    "herdr",
    "--session",
    "session-1",
    "notification",
    "show",
    "Tandem: Dark mode",
    "--body",
    "brief waiting for approval · prefix+t for status",
    "--sound",
    "request",
  ]);
});
