import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeViewsPublication } from "../../src/board/native-views.ts";
import { setupFile, ViewFile } from "../../src/native/contract.ts";
import {
  projectStoreDirectory,
  publishViews,
  readProjectState,
  viewDetailPath,
  viewIndexPath,
} from "../../src/native/store.ts";
import { SETUP_MODES, type SetupView } from "../../src/onboarding/setup-view.ts";
import { setupViewFixture } from "../onboarding/setup-fixture.ts";
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

test("each setup mode has its own detail file, which a full publication never prunes", async () => {
  const home = await mkdtemp(join(tmpdir(), "tdm-store-"));
  const project = join(home, "repo");
  try {
    for (const mode of SETUP_MODES)
      await publishViews(home, project, async () => ({ setup: setupViewFixture(mode) }));
    await publishViews(home, project, async () => publication(project));
    for (const mode of SETUP_MODES) {
      const file = ViewFile.parse(
        JSON.parse(await readFile(viewDetailPath(home, project, setupFile(mode)), "utf8")),
      );
      expect(file.kind).toBe("setup");
      expect(file.model).toMatchObject({ mode, schemaVersion: 1 });
    }
    expect(() => viewDetailPath(home, project, "setup-later.json")).toThrow();
    expect(() => viewDetailPath(home, project, "setup-settings.json/../../x")).toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a setup model its block cannot draw is refused before anything is written", async () => {
  const home = await mkdtemp(join(tmpdir(), "tdm-store-"));
  const project = join(home, "repo");
  try {
    const broken = { ...setupViewFixture("setup"), roles: undefined } as unknown as SetupView;
    await expect(publishViews(home, project, async () => ({ setup: broken }))).rejects.toThrow(
      "Native setup model is invalid: roles",
    );
    await expect(
      stat(viewDetailPath(home, project, setupFile("setup"))),
    ).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
