import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planRenest, renestWorkspaces } from "../../src/coordinator/renest.ts";
import {
  type FakeSidebar,
  fakeSidebar,
  SESSION,
  saveCoordinator,
  seedTasks,
} from "./fake-workspace-order.ts";

type World = Readonly<{ home: string; tandem: string; tagalog: string }>;

async function withWorld(action: (world: World) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-renest-")));
  try {
    const world = {
      home: join(root, "home"),
      tandem: join(root, "tandem"),
      tagalog: join(root, "tagalog-learning-app"),
    };
    for (const path of Object.values(world)) await mkdir(path, { recursive: true });
    await action(world);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The live example: tagalog's first task sits under tandem's coordinator after an update. */
async function liveExample(world: World, extra: readonly string[] = []): Promise<FakeSidebar> {
  await saveCoordinator(world.home, world.tandem, "wV");
  await saveCoordinator(world.home, world.tagalog, "w1G");
  await seedTasks(world.home, [
    { id: "36a4f150-first", repoPath: world.tagalog, workspaceId: "w1F" },
    { id: "3ff969fc-second", repoPath: world.tagalog, workspaceId: "w1B" },
  ]);
  return fakeSidebar(["wV", "w1F", "w1G", "w1B", ...extra]);
}

const renest = (world: World, sidebar: FakeSidebar, apply: boolean) =>
  renestWorkspaces(
    sidebar.run,
    { home: world.home, sessionId: SESSION, cwd: world.home, apply },
    { moveWorkspace: sidebar.moveWorkspace },
  );

test("task workspaces are moved back under their own coordinator, oldest first", async () => {
  await withWorld(async (world) => {
    const sidebar = await liveExample(world, ["wMine"]);

    const dry = await renest(world, sidebar, false);
    expect(dry.planned.map((move) => move.workspaceId)).toEqual(["w1F"]);
    expect(sidebar.moves).toEqual([]);

    const applied = await renest(world, sidebar, true);
    expect(applied).toMatchObject({ moved: 1, warnings: [] });
    expect(sidebar.order).toEqual(["wV", "w1G", "w1F", "w1B", "wMine"]);
  });
});

test("already-nested workspaces are not moved", async () => {
  await withWorld(async (world) => {
    const sidebar = await liveExample(world);
    await renest(world, sidebar, true);
    const moves = sidebar.moves.length;

    const again = await renest(world, sidebar, true);
    expect(again).toEqual({ planned: [], moved: 0, warnings: [] });
    expect(sidebar.moves).toHaveLength(moves);
  });
});

test("a workspace no Tandem task record names is never moved", async () => {
  await withWorld(async (world) => {
    const sidebar = await liveExample(world);
    sidebar.order.splice(1, 0, "wMine");

    await renest(world, sidebar, true);
    expect(sidebar.moves.map((move) => move.workspaceId)).not.toContain("wMine");
    expect(sidebar.order).toEqual(["wV", "wMine", "w1G", "w1F", "w1B"]);
  });
});

test("a failed move is a warning, never an error", async () => {
  await withWorld(async (world) => {
    const sidebar = await liveExample(world);
    sidebar.fail("workspace.move is not supported");

    const report = await renest(world, sidebar, true);
    expect(report.moved).toBe(0);
    expect(report.warnings).toEqual([
      "workspace.move failed; worker placement was preserved: workspace.move is not supported",
    ]);
    expect(sidebar.order).toEqual(["wV", "w1F", "w1G", "w1B"]);
  });
});

test("an unreadable Herdr session is a warning, never an error", async () => {
  await withWorld(async (world) => {
    await saveCoordinator(world.home, world.tagalog, "w1G");
    const report = await renestWorkspaces(
      async () => ({ code: 1, stdout: "", stderr: "no server" }),
      { home: world.home, sessionId: SESSION, cwd: world.home, apply: true },
    );
    expect(report.moved).toBe(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("could not read Herdr workspaces");
  });
});

test("the plan follows Herdr's move rule across projects", () => {
  expect(
    planRenest(
      ["t-b2", "c-a", "c-b", "t-a1", "t-b1"],
      [
        {
          repoPath: "a",
          coordinatorWorkspaceId: "c-a",
          workspaces: [{ workspaceId: "t-a1", taskId: "a1" }],
        },
        {
          repoPath: "b",
          coordinatorWorkspaceId: "c-b",
          workspaces: [
            { workspaceId: "t-b1", taskId: "b1" },
            { workspaceId: "t-b2", taskId: "b2" },
          ],
        },
      ],
    ).map((move) => `${move.workspaceId}>${move.afterWorkspaceId}`),
  ).toEqual(["t-a1>c-a", "t-b2>t-b1"]);
});
