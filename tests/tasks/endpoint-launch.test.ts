import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRequest, CommandResult } from "../../src/contracts.ts";
import type { DurableEndpointLaunch } from "../../src/runtime/schema.ts";
import { recoverEndpointFromLaunch } from "../../src/tasks/endpoint-launch.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";

const LABEL = "└ fix paid access";

type FakeWorkspace = Readonly<{ id: string; cwd: string }>;

function herdrWithWorkspaces(workspaces: readonly FakeWorkspace[]) {
  return async (request: CommandRequest): Promise<CommandResult> => {
    const { argv } = request;
    if (argv.includes("workspace") && argv.includes("list")) {
      const payload = workspaces.map((workspace) => ({
        workspace_id: workspace.id,
        active_tab_id: `${workspace.id}-tab`,
        label: LABEL,
      }));
      return { code: 0, stdout: JSON.stringify({ result: { workspaces: payload } }), stderr: "" };
    }
    if (argv.includes("pane") && argv.includes("list")) {
      const workspaceId = argv[argv.indexOf("--workspace") + 1];
      const panes = workspaces
        .filter((workspace) => workspace.id === workspaceId)
        .map((workspace) => ({
          pane_id: `${workspace.id}-pane`,
          tab_id: `${workspace.id}-tab`,
          workspace_id: workspace.id,
          cwd: workspace.cwd,
          foreground_cwd: workspace.cwd,
        }));
      return { code: 0, stdout: JSON.stringify({ result: { panes } }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
  };
}

async function withWorktrees(
  body: (paths: Readonly<{ mine: string; other: string }>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tandem-endpoint-launch-"));
  const mine = join(root, "mine");
  const other = join(root, "other");
  await mkdir(mine);
  await mkdir(other);
  try {
    await body({ mine, other });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function launchAt(cwd: string): DurableEndpointLaunch {
  return {
    terminal: "herdr" as const,
    schemaVersion: 1,
    reservationId: "reservation-1",
    sessionId: "session-1",
    taskName: "tandem-task-1",
    workspaceLabel: LABEL,
    cwd,
    role: "implementer",
    generation: 0,
    createdAt: "2026-09-27T00:00:00.000Z",
  };
}

test("launch recovery tells same-titled workspaces apart by their worktree", async () => {
  await withWorktrees(async ({ mine, other }) => {
    const run = herdrWithWorkspaces([
      { id: "workspace-other", cwd: other },
      { id: "workspace-mine", cwd: mine },
    ]);

    const recovery = await recoverEndpointFromLaunch(
      terminalBackend(run, { terminal: "herdr" }),
      launchAt(mine),
    );

    expect(recovery).toMatchObject({
      status: "recovered",
      endpoint: { workspaceId: "workspace-mine", paneId: "workspace-mine-pane" },
    });
  });
});

test("launch recovery stays ambiguous when same-titled workspaces share the worktree", async () => {
  await withWorktrees(async ({ mine }) => {
    const run = herdrWithWorkspaces([
      { id: "workspace-a", cwd: mine },
      { id: "workspace-b", cwd: mine },
    ]);

    const recovery = await recoverEndpointFromLaunch(
      terminalBackend(run, { terminal: "herdr" }),
      launchAt(mine),
    );

    expect(recovery.status).toBe("ambiguous");
  });
});
