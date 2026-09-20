import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  WorktreeLease,
} from "../../src/contracts.ts";
import {
  coordinatorWorkspaceLabel,
  retireCoordinatorWorkspace,
} from "../../src/coordinator/workspace.ts";

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    sessionId: "tandem",
    workspaceId: "workspace-a",
    tabId: "tab-a",
    paneId: "pane-a",
    role: "coordinator",
    generation: 0,
    ...overrides,
  };
}

type FakeProcess = Readonly<{ pid: number; name: string; argv: readonly string[]; argv0?: string }>;

type FakePane = {
  present: boolean;
  workspaceId: string;
  tabId: string;
  foregroundCwd: string;
  shellPid?: number;
  processes: readonly FakeProcess[];
};

type FakeRunner = Readonly<{
  readonly calls: readonly CommandRequest[];
  readonly run: CommandRunner;
  readonly panes: ReadonlyMap<string, FakePane>;
  readonly workspaceLabel: Map<string, string>;
}>;

function missingResult(code: string): CommandResult {
  return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code } }) };
}

function fakeRunner(
  panes: Readonly<Record<string, FakePane>>,
  workspaceLabels: Readonly<Record<string, string>>,
): FakeRunner {
  const calls: CommandRequest[] = [];
  const paneMap = new Map(Object.entries(panes));
  const labelMap = new Map(Object.entries(workspaceLabels));
  const run: CommandRunner = async (request) => {
    calls.push(request);
    const [program, , , resource, action] = request.argv;
    if (program !== "herdr" || resource === undefined) {
      throw new Error(`unexpected command ${JSON.stringify(request.argv)}`);
    }
    if (resource === "workspace") {
      const workspaceId = request.argv[5] ?? "";
      if (action === "get") {
        const label = labelMap.get(workspaceId);
        if (label === undefined) return missingResult("workspace_not_found");
        return {
          code: 0,
          stdout: JSON.stringify({
            result: { type: "workspace_info", workspace: { workspace_id: workspaceId, label } },
          }),
          stderr: "",
        };
      }
      if (action === "rename") {
        if (!labelMap.has(workspaceId)) return missingResult("workspace_not_found");
        const label = request.argv[6] ?? "";
        labelMap.set(workspaceId, label);
        return {
          code: 0,
          stdout: JSON.stringify({
            result: { type: "workspace_info", workspace: { workspace_id: workspaceId, label } },
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected workspace action ${JSON.stringify(action)}`);
    }
    if (resource === "api" && action === "snapshot") {
      return {
        code: 0,
        stdout: JSON.stringify({
          result: {
            type: "session_snapshot",
            snapshot: {
              panes: [...paneMap.entries()]
                .filter(([, pane]) => pane.present)
                .map(([paneId, pane]) => ({
                  workspace_id: pane.workspaceId,
                  tab_id: pane.tabId,
                  pane_id: paneId,
                })),
            },
          },
        }),
        stderr: "",
      };
    }
    if (resource === "pane" && action !== undefined) {
      const paneId = action === "process-info" ? request.argv[6] : request.argv[5];
      if (typeof paneId !== "string") {
        throw new Error(`pane command omitted pane id: ${JSON.stringify(request.argv)}`);
      }
      const pane = paneMap.get(paneId);
      if (pane === undefined || !pane.present) return missingResult("pane_not_found");
      if (action === "get") {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              pane: {
                pane_id: paneId,
                tab_id: pane.tabId,
                workspace_id: pane.workspaceId,
                foreground_cwd: pane.foregroundCwd,
              },
            },
          }),
          stderr: "",
        };
      }
      if (action === "process-info") {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: paneId,
                shell_pid: pane.shellPid,
                foreground_processes: pane.processes,
              },
            },
          }),
          stderr: "",
        };
      }
      if (action === "close") {
        pane.present = false;
        return { code: 0, stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "" };
      }
    }
    throw new Error(`unexpected command ${JSON.stringify(request.argv)}`);
  };
  return { calls, run, panes: paneMap, workspaceLabel: labelMap };
}

const stoppedShell: readonly FakeProcess[] = [
  { pid: 100, name: "zsh", argv: ["-zsh"], argv0: "-zsh" },
];

type Fixture = Readonly<{
  readonly root: string;
  readonly repoPath: string;
  readonly worktree: WorktreeLease;
}>;

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-coordinator-workspace-")));
  const repoPath = join(root, "repo");
  const worktreePath = join(root, "worktree");
  await mkdir(repoPath, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  return {
    root,
    repoPath,
    worktree: {
      root: join(root, "pool"),
      path: worktreePath,
      name: "coordinator-a",
      baseHead: "abc123",
      branch: "tandem/coordinator-a",
      leaseId: "lease-a",
      leaseHolder: "coordinator-a",
      leasedAt: "2030-01-02T03:04:05.000Z",
    },
  };
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

test("closes a stopped owned pane when no other pane shares its workspace", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    const label = coordinatorWorkspaceLabel(repoPath);
    const runner = fakeRunner(
      {
        "pane-a": {
          present: true,
          workspaceId: "workspace-a",
          tabId: "tab-a",
          foregroundCwd: worktree.path,
          shellPid: 100,
          processes: stoppedShell,
        },
      },
      { "workspace-a": label },
    );

    const result = await retireCoordinatorWorkspace(runner.run, record);

    expect(result).toEqual({ outcome: "closed" });
    expect(runner.panes.get("pane-a")?.present).toBe(false);
    expect(runner.calls.some((call) => call.argv.includes("rename"))).toBe(false);
  } finally {
    await cleanup(root);
  }
});

test("closes its own pane but retains the workspace when an extra pane remains", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    const label = coordinatorWorkspaceLabel(repoPath);
    const runner = fakeRunner(
      {
        "pane-a": {
          present: true,
          workspaceId: "workspace-a",
          tabId: "tab-a",
          foregroundCwd: worktree.path,
          shellPid: 100,
          processes: stoppedShell,
        },
        "extra-pane": {
          present: true,
          workspaceId: "workspace-a",
          tabId: "tab-extra",
          foregroundCwd: "/somewhere/else",
          shellPid: 200,
          processes: [{ pid: 200, name: "vim", argv: ["vim", "notes"], argv0: "vim" }],
        },
      },
      { "workspace-a": label },
    );

    const result = await retireCoordinatorWorkspace(runner.run, record);

    expect(result).toEqual({
      outcome: "retained",
      reason: "extra panes still share this workspace",
      extraPaneIds: ["extra-pane"],
    });
    expect(runner.panes.get("pane-a")?.present).toBe(false);
    expect(runner.panes.get("extra-pane")?.present).toBe(true);
    expect(runner.workspaceLabel.get("workspace-a")).toBe(`Retained terminals · repo`);
  } finally {
    await cleanup(root);
  }
});

test("leaves a custom-labeled workspace and its pane completely untouched", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    const runner = fakeRunner(
      {
        "pane-a": {
          present: true,
          workspaceId: "workspace-a",
          tabId: "tab-a",
          foregroundCwd: worktree.path,
          shellPid: 100,
          processes: stoppedShell,
        },
      },
      { "workspace-a": "My scratch terminal" },
    );

    const result = await retireCoordinatorWorkspace(runner.run, record);

    expect(result).toEqual({ outcome: "retained", reason: "workspace has a custom label" });
    expect(runner.panes.get("pane-a")?.present).toBe(true);
    expect(runner.workspaceLabel.get("workspace-a")).toBe("My scratch terminal");
    expect(
      runner.calls.some((call) => call.argv.includes("close") || call.argv.includes("rename")),
    ).toBe(false);
  } finally {
    await cleanup(root);
  }
});

test("treats an already-gone workspace as already clear", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    const runner = fakeRunner({}, {});

    const result = await retireCoordinatorWorkspace(runner.run, record);

    expect(result).toEqual({ outcome: "already-clear" });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.argv).toEqual([
      "herdr",
      "--session",
      "tandem",
      "workspace",
      "get",
      "workspace-a",
    ]);
  } finally {
    await cleanup(root);
  }
});

test("quarantines a pane whose foreground working directory no longer matches its recorded worktree", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    const label = coordinatorWorkspaceLabel(repoPath);
    const runner = fakeRunner(
      {
        "pane-a": {
          present: true,
          workspaceId: "workspace-a",
          tabId: "tab-a",
          foregroundCwd: "/somewhere/foreign",
          shellPid: 100,
          processes: stoppedShell,
        },
      },
      { "workspace-a": label },
    );

    const result = await retireCoordinatorWorkspace(runner.run, record);

    expect(result.outcome).toBe("quarantined");
    expect(result.reason).toMatch(/no longer matches its recorded worktree/);
    expect(runner.panes.get("pane-a")?.present).toBe(true);
    expect(runner.workspaceLabel.get("workspace-a")).toBe(label);
    expect(
      runner.calls.some((call) => call.argv.includes("close") || call.argv.includes("rename")),
    ).toBe(false);
  } finally {
    await cleanup(root);
  }
});

test("quarantines a pane occupied by a foreign active process instead of the recorded coordinator shell", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    const label = coordinatorWorkspaceLabel(repoPath);
    const runner = fakeRunner(
      {
        "pane-a": {
          present: true,
          workspaceId: "workspace-a",
          tabId: "tab-a",
          foregroundCwd: worktree.path,
          shellPid: 100,
          processes: [
            { pid: 100, name: "zsh", argv: ["-zsh"], argv0: "-zsh" },
            { pid: 321, name: "vim", argv: ["vim"], argv0: "vim" },
          ],
        },
      },
      { "workspace-a": label },
    );

    const result = await retireCoordinatorWorkspace(runner.run, record);

    expect(result.outcome).toBe("quarantined");
    expect(runner.panes.get("pane-a")?.present).toBe(true);
    expect(runner.workspaceLabel.get("workspace-a")).toBe(label);
    expect(
      runner.calls.some((call) => call.argv.includes("close") || call.argv.includes("rename")),
    ).toBe(false);
  } finally {
    await cleanup(root);
  }
});

test("explicit retain request renames the workspace without attempting to close the pane", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    const label = coordinatorWorkspaceLabel(repoPath);
    const runner = fakeRunner(
      {
        "pane-a": {
          present: true,
          workspaceId: "workspace-a",
          tabId: "tab-a",
          foregroundCwd: worktree.path,
          shellPid: 100,
          processes: stoppedShell,
        },
      },
      { "workspace-a": label },
    );

    const result = await retireCoordinatorWorkspace(runner.run, record, { retain: true });

    expect(result).toEqual({ outcome: "retained", reason: "retention was explicitly requested" });
    expect(runner.panes.get("pane-a")?.present).toBe(true);
    expect(runner.workspaceLabel.get("workspace-a")).toBe(`Retained terminals · repo`);
    expect(runner.calls.some((call) => call.argv.includes("close"))).toBe(false);
  } finally {
    await cleanup(root);
  }
});
