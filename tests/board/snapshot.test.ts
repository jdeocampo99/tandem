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
import { task } from "../session/fixtures.ts";
import { NOW, state } from "./fixtures.ts";

const SNAPSHOT: BoardSnapshot = {
  version: 1,
  writtenAt: NOW,
  board: boardView(
    state({
      tasks: [task({ id: "task-run", repoPath: "/work/app", stage: "implementing" })],
      workerPanes: new Map([["task-run", { workspaceId: "w2", paneId: "w2:p3" }]]),
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
    expect(await readdir(home)).toEqual(["board-snapshot.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a missing, torn, or other-version snapshot reads as none", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-snapshot-"));
  try {
    expect(await readBoardSnapshot(home)).toBeUndefined();
    await writeFile(boardSnapshotPath(home), '{"version":1,"writtenAt":');
    expect(await readBoardSnapshot(home)).toBeUndefined();
    await writeFile(boardSnapshotPath(home), JSON.stringify({ ...SNAPSHOT, version: 2 }));
    expect(await readBoardSnapshot(home)).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
