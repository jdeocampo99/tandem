import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planRenest, renestWorkspaces } from "../../src/coordinator/renest.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { TerminalBackend } from "../../src/terminal-backend/contract.ts";
import {
  type FakeSidebar,
  fakeSidebar,
  SESSION,
  saveCoordinator,
  seedTasks,
} from "./fake-workspace-order.ts";

const DATABASE_MODULE = fileURLToPath(new URL("../../src/runtime/database.ts", import.meta.url));

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
function fakeTerminal(sidebar: FakeSidebar): TerminalBackend {
  const terminal = terminalBackend(sidebar.run, { terminal: "herdr" });
  return {
    ...terminal,
    orderWorkspaceAfter: async (input) => {
      try {
        await sidebar.moveWorkspace({
          socketPath: "/tmp/fake-herdr.sock",
          workspaceId: input.workspaceId,
          insertIndex: input.insertIndex ?? sidebar.order.indexOf(input.parentWorkspaceId) + 1,
        });
        return [];
      } catch (error) {
        return [
          `workspace.move failed; worker placement was preserved: ${error instanceof Error ? error.message : String(error)}`,
        ];
      }
    },
  };
}

const renest = (world: World, sidebar: FakeSidebar, apply: boolean) =>
  renestWorkspaces(fakeTerminal(sidebar), {
    home: world.home,
    sessionId: SESSION,
    cwd: world.home,
    apply,
  });

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

test("a task's presentation workspaces follow the task under its coordinator", async () => {
  await withWorld(async (world) => {
    await saveCoordinator(world.home, world.tagalog, "w2K");
    await seedTasks(
      world.home,
      [{ id: "4a6ac223-research", repoPath: world.tagalog, workspaceId: "w2D" }],
      [
        { id: "76e03f8e-first", taskId: "4a6ac223-research", workspaceId: "w2A" },
        { id: "027c60af-second", taskId: "4a6ac223-research", workspaceId: "w28" },
      ],
    );
    const sidebar = fakeSidebar(["w2A", "w28", "w2K", "w2D"]);

    await renest(world, sidebar, true);

    expect(sidebar.order).toEqual(["w2K", "w2D", "w2A", "w28"]);
  });
});

test("a coordinator listed last gets its task moved to the very end, after it", async () => {
  await withWorld(async (world) => {
    // The live order after `tandem update`: the replacement coordinator w1J is last, and w1F is a
    // Tandem-labelled workspace whose task no longer names it.
    await saveCoordinator(world.home, world.tagalog, "w1J");
    await seedTasks(world.home, [
      { id: "e2c0fbb5-ready", repoPath: world.tagalog, workspaceId: "w1B" },
    ]);
    const sidebar = fakeSidebar(["wV", "w1F", "w1B", "w1J"], {
      wV: "Tandem coordinator · tandem",
      w1F: "└ implement Execute TAG-1036 Chapter 7 · 9c1d9272e688",
      w1B: "└ implement Continue TAG-1036 · 5fb8c7082915",
      w1J: "Tandem coordinator · tagalog-learning-app",
    });

    const report = await renest(world, sidebar, true);
    // Herdr's insert_index may equal the list length, which appends; checked against a real session.
    expect(sidebar.moves).toEqual([
      { socketPath: "/tmp/fake-herdr.sock", workspaceId: "w1B", insertIndex: 4 },
    ]);
    expect(sidebar.order).toEqual(["wV", "w1F", "w1J", "w1B"]);
    expect(report.moved).toBe(1);
    expect(report.leftovers).toEqual([
      { workspaceId: "w1F", label: "└ implement Execute TAG-1036 Chapter 7 · 9c1d9272e688" },
    ]);
  });
});

test("a coordinator busy with the state lock only delays re-nesting", async () => {
  await withWorld(async (world) => {
    const sidebar = await liveExample(world);
    // A freshly started coordinator runs its first scheduler pass under the state lock, right
    // when a restart re-nests. Hold it longer than the store's usual 5-second wait.
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `const { withStateLock } = await import(${JSON.stringify(DATABASE_MODULE)});
         await withStateLock(${JSON.stringify(world.home)}, async () => {
           console.log("holding");
           await Bun.sleep(6000);
         });`,
      ],
      { stdout: "pipe" },
    );
    const reader = holder.stdout.getReader();
    await reader.read();

    const report = await renest(world, sidebar, true);
    await holder.exited;
    expect(report.warnings).toEqual([]);
    expect(report.moved).toBe(1);
    expect(sidebar.order).toEqual(["wV", "w1G", "w1F", "w1B"]);
  });
}, 30_000);

test("already-nested workspaces are not moved", async () => {
  await withWorld(async (world) => {
    const sidebar = await liveExample(world);
    await renest(world, sidebar, true);
    const moves = sidebar.moves.length;

    const again = await renest(world, sidebar, true);
    expect(again).toEqual({ planned: [], moved: 0, warnings: [], leftovers: [] });
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
      terminalBackend(async () => ({ code: 1, stdout: "", stderr: "no server" }), {
        terminal: "herdr",
      }),
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
