import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeViewsPublication } from "../../src/board/native-views.ts";
import { ViewFile } from "../../src/native/contract.ts";
import {
  projectStoreDirectory,
  publishViews,
  readProjectState,
  viewDetailPath,
  viewIndexPath,
} from "../../src/native/store.ts";
import { taskScreenPublication } from "../tasks/task-screen-fixture.ts";
import { nativeScreensFixture } from "../tern-view/screens-fixture.ts";

function publication(project: string): NativeViewsPublication {
  const fixture = taskScreenPublication(project);
  const screens = nativeScreensFixture();
  return {
    ...fixture,
    bundle: {
      ...fixture.bundle,
      board: screens.board,
      usage: screens.usage,
      catchup: { ...screens.catchup, project },
    },
  };
}

async function seq(path: string): Promise<number> {
  return ViewFile.parse(JSON.parse(await readFile(path, "utf8"))).seq;
}

test("a model its screens cannot draw is refused before anything is written", async () => {
  const home = await mkdtemp(join(tmpdir(), "tdm-store-"));
  const project = join(home, "repo");
  try {
    const valid = publication(project);
    const broken = {
      ...valid,
      bundle: { ...valid.bundle, board: { ...valid.bundle.board, lanes: [] } },
    };
    await expect(publishViews(home, project, async () => broken)).rejects.toThrow(
      "Native index model is invalid: board.lanes",
    );
    await expect(stat(viewIndexPath(home, project))).rejects.toHaveProperty("code", "ENOENT");
    expect(await readProjectState(home, project)).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("every write takes the next seq of one epoch, committed before the file carries it", async () => {
  const home = await mkdtemp(join(tmpdir(), "tdm-store-"));
  const project = join(home, "repo");
  try {
    const full = publication(project);
    await publishViews(home, project, async () => full);
    const index = viewIndexPath(home, project);
    const brief = viewDetailPath(home, project, "brief-req-tern.json");
    const first = await readProjectState(home, project);
    expect(first?.seq).toBe(4);
    expect(await seq(index)).toBe(4);
    expect(first?.published?.pullRequests).toEqual([
      { repo: "owner/repo", number: 281, taskId: "102" },
    ]);

    const [saved] = full.details.flatMap((entry) =>
      entry.view.kind === "brief" ? [entry.view.data] : [],
    );
    if (saved === undefined) throw new Error("fixture has no brief");
    await publishViews(home, project, async () => ({
      brief: { ...saved, title: "Renamed brief" },
    }));
    const second = await readProjectState(home, project);
    expect(second?.seq).toBe(5);
    expect(second?.epoch).toBe(first?.epoch);
    expect(second?.published).toEqual(first?.published);
    expect(await seq(brief)).toBe(5);
    expect(await seq(index)).toBe(4);

    // A store directory that is gone starts a new epoch, so watchers accept its first files.
    await rm(projectStoreDirectory(home, project), { recursive: true });
    await publishViews(home, project, async () => full);
    const third = await readProjectState(home, project);
    expect(third?.epoch).not.toBe(first?.epoch);
    expect(third?.seq).toBe(4);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
