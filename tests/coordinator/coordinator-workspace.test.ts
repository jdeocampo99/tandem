import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  Endpoint,
  WorktreeLease,
} from "../../src/contracts.ts";
import { recordPath } from "../../src/coordinator/record.ts";
import {
  coordinatorWorkspaceLabel,
  retireCoordinatorWorkspace,
} from "../../src/coordinator/workspace.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    terminal: "herdr" as const,
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
  label?: string;
  plugin?: boolean;
  /** `plugin pane close` fails with this error code. */
  closeError?: string;
  /** The snapshot still lists the pane right after it closed. */
  lingers?: boolean;
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
    if (resource === "plugin" && action === "pane" && request.argv[5] === "close") {
      const pane = paneMap.get(request.argv[6] ?? "");
      if (pane === undefined || !pane.present || pane.plugin !== true) {
        return missingResult("plugin_pane_not_found");
      }
      if (pane.closeError !== undefined) return missingResult(pane.closeError);
      pane.present = pane.lingers === true;
      return {
        code: 0,
        stdout: JSON.stringify({ result: { type: "plugin_pane_closed" } }),
        stderr: "",
      };
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
                ...(pane.label === undefined ? {} : { label: pane.label }),
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

    const result = await retireCoordinatorWorkspace(
      terminalBackend(runner.run, { terminal: "herdr" }),
      join(root, "home"),
      record,
    );

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

    const result = await retireCoordinatorWorkspace(
      terminalBackend(runner.run, { terminal: "herdr" }),
      join(root, "home"),
      record,
    );

    expect(result).toEqual({
      outcome: "retained",
      reason: "extra panes still share this workspace",
      extraPaneIds: ["extra-pane"],
    });
    expect(runner.panes.get("pane-a")?.present).toBe(false);
    expect(runner.panes.get("extra-pane")?.present).toBe(true);
    expect(runner.workspaceLabel.get("workspace-a")).toBe(`◇ repo (old)`);
  } finally {
    await cleanup(root);
  }
});

/** Records a panel pane the way launch does: in a file beside the coordinator's record. */
async function recordPanel(root: string, repoPath: string, paneId: string): Promise<void> {
  const file = recordPath(join(root, "home"), "tandem", repoPath).replace(/\.json$/u, ".panel");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ paneId }));
}

function panelPane(overrides: Partial<FakePane> = {}): FakePane {
  return {
    present: true,
    workspaceId: "workspace-a",
    tabId: "tab-a",
    foregroundCwd: "/tandem/herdr-plugin",
    processes: [{ pid: 300, name: "bun", argv: ["bun", "src/main.ts", "panel"] }],
    label: "Tandem panel",
    plugin: true,
    ...overrides,
  };
}

const ownedStoppedPane: FakePane = {
  present: true,
  workspaceId: "workspace-a",
  tabId: "tab-a",
  foregroundCwd: "",
  shellPid: 100,
  processes: stoppedShell,
};

test("closes the recorded panel before the coordinator, so the panel never keeps the workspace", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    await recordPanel(root, repoPath, "panel-a");
    const runner = fakeRunner(
      {
        "pane-a": { ...ownedStoppedPane, foregroundCwd: worktree.path },
        "panel-a": panelPane(),
      },
      { "workspace-a": coordinatorWorkspaceLabel(repoPath) },
    );

    const result = await retireCoordinatorWorkspace(
      terminalBackend(runner.run, { terminal: "herdr" }),
      join(root, "home"),
      record,
    );

    expect(result).toEqual({ outcome: "closed" });
    expect(runner.panes.get("panel-a")?.present).toBe(false);
    expect(runner.panes.get("pane-a")?.present).toBe(false);
    const closes = runner.calls
      .filter((call) => call.argv.includes("close"))
      .map((call) => call.argv.at(-1));
    expect(closes).toEqual(["panel-a", "pane-a"]);
  } finally {
    await cleanup(root);
  }
});

test("closes a lone panel left after the coordinator's pane already closed", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    await recordPanel(root, repoPath, "panel-a");
    const runner = fakeRunner(
      { "panel-a": panelPane() },
      { "workspace-a": coordinatorWorkspaceLabel(repoPath) },
    );

    expect(
      await retireCoordinatorWorkspace(
        terminalBackend(runner.run, { terminal: "herdr" }),
        join(root, "home"),
        record,
      ),
    ).toEqual({
      outcome: "closed",
    });
    expect(runner.panes.get("panel-a")?.present).toBe(false);
  } finally {
    await cleanup(root);
  }
});

test("a panel Herdr closed but still lists is not counted as a pane keeping the workspace", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    await recordPanel(root, repoPath, "panel-a");
    const runner = fakeRunner(
      {
        "pane-a": { ...ownedStoppedPane, foregroundCwd: worktree.path },
        "panel-a": panelPane({ lingers: true }),
      },
      { "workspace-a": coordinatorWorkspaceLabel(repoPath) },
    );

    const result = await retireCoordinatorWorkspace(
      terminalBackend(runner.run, { terminal: "herdr" }),
      join(root, "home"),
      record,
    );

    expect(result).toEqual({ outcome: "closed" });
    expect(runner.workspaceLabel.get("workspace-a")).toBe(coordinatorWorkspaceLabel(repoPath));
  } finally {
    await cleanup(root);
  }
});

test("a panel that cannot be closed retains the workspace instead of failing retirement", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    await recordPanel(root, repoPath, "panel-a");
    const runner = fakeRunner(
      {
        "pane-a": { ...ownedStoppedPane, foregroundCwd: worktree.path },
        "panel-a": panelPane({ closeError: "server_busy" }),
      },
      { "workspace-a": coordinatorWorkspaceLabel(repoPath) },
    );

    const result = await retireCoordinatorWorkspace(
      terminalBackend(runner.run, { terminal: "herdr" }),
      join(root, "home"),
      record,
    );

    expect(result).toEqual({
      outcome: "retained",
      reason: "panel could not be closed",
      extraPaneIds: ["panel-a"],
    });
    expect(runner.panes.get("pane-a")?.present).toBe(false);
    expect(runner.panes.get("panel-a")?.present).toBe(true);
  } finally {
    await cleanup(root);
  }
});

test("a recorded panel id that now names another pane is left open and reported", async () => {
  const { root, repoPath, worktree } = await fixture();
  try {
    const record = { repoPath, endpoint: endpoint(), worktree };
    await recordPanel(root, repoPath, "panel-a");
    const runner = fakeRunner(
      {
        "pane-a": { ...ownedStoppedPane, foregroundCwd: worktree.path },
        "panel-a": panelPane({ label: "notes", plugin: false }),
      },
      { "workspace-a": coordinatorWorkspaceLabel(repoPath) },
    );

    const result = await retireCoordinatorWorkspace(
      terminalBackend(runner.run, { terminal: "herdr" }),
      join(root, "home"),
      record,
    );

    expect(result).toMatchObject({ outcome: "retained", extraPaneIds: ["panel-a"] });
    expect(runner.panes.get("panel-a")?.present).toBe(true);
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

    const result = await retireCoordinatorWorkspace(
      terminalBackend(runner.run, { terminal: "herdr" }),
      join(root, "home"),
      record,
    );

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

    const result = await retireCoordinatorWorkspace(
      terminalBackend(runner.run, { terminal: "herdr" }),
      join(root, "home"),
      record,
    );

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

    const result = await retireCoordinatorWorkspace(
      terminalBackend(runner.run, { terminal: "herdr" }),
      join(root, "home"),
      record,
    );

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

    const result = await retireCoordinatorWorkspace(
      terminalBackend(runner.run, { terminal: "herdr" }),
      join(root, "home"),
      record,
    );

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
