import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardSnapshot,
  boardSnapshotPath,
  readBoardSnapshot,
  writeBoardSnapshot,
} from "../../src/board/snapshot.ts";
import { boardView } from "../../src/board/view.ts";
import { blockCause } from "../../src/contracts.ts";
import { task } from "../session/fixtures.ts";
import { NOW, state } from "./fixtures.ts";

const SNAPSHOT: BoardSnapshot = {
  version: 1,
  writtenAt: NOW,
  board: boardView(
    state({
      tasks: [
        task({ id: "task-run", repoPath: "/work/app", stage: "implementing" }),
        task({
          id: "task-stop",
          repoPath: "/work/app",
          stage: "blocked",
          blockCause: blockCause("worker-failed", { summary: "s", detail: "d" }),
        }),
        task({
          id: "task-ready",
          repoPath: "/work/app",
          stage: "ready",
          pullRequest: { repository: "acme/app", number: 7, state: "draft", head: "h", base: "b" },
        }),
      ],
      workerPanes: new Map([["task-run", { workspaceId: "w2", paneId: "w2:p3" }]]),
      restarts: new Map([["task-stop", 2]]),
    }),
    NOW,
  ),
  coordinators: [{ repoPath: "/work/app", project: "app", workspaceId: "w2", paneId: "w2:p1" }],
};

test("a written snapshot reads back the same, leaving no temporary file behind", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-snapshot-"));
  try {
    await writeBoardSnapshot(home, SNAPSHOT);
    expect(await readBoardSnapshot(home)).toEqual(SNAPSHOT);
    expect(
      SNAPSHOT.board.needsYou.map(({ blockKind, restarts, pullRequest }) => ({
        blockKind,
        restarts,
        pullRequest,
      })),
    ).toEqual([
      { blockKind: "worker-failed", restarts: 2, pullRequest: undefined },
      { blockKind: undefined, restarts: undefined, pullRequest: { number: 7, draft: true } },
    ]);
    expect(await readdir(home)).toEqual(["board-snapshot.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a missing snapshot reads as none, and a torn or other-version one fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-snapshot-"));
  try {
    expect(await readBoardSnapshot(home)).toBeUndefined();
    await writeFile(boardSnapshotPath(home), '{"version":1,"writtenAt":');
    await expect(readBoardSnapshot(home)).rejects.toThrow("not a board snapshot");
    await writeFile(boardSnapshotPath(home), JSON.stringify({ ...SNAPSHOT, version: 2 }));
    await expect(readBoardSnapshot(home)).rejects.toThrow("not a board snapshot");
    const badRestarts = {
      ...SNAPSHOT,
      board: {
        ...SNAPSHOT.board,
        needsYou: SNAPSHOT.board.needsYou.map((row) => ({ ...row, restarts: "two" })),
      },
    };
    await writeFile(boardSnapshotPath(home), JSON.stringify(badRestarts));
    await expect(readBoardSnapshot(home)).rejects.toThrow("not a board snapshot");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
