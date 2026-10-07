import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectStoreDirectory, recordVisit } from "../../src/native/store.ts";
import { savedState } from "./view-files.ts";

async function savedVisit(home: string, project: string) {
  const visit = (await savedState(home, project))?.visit;
  if (visit === undefined) throw new Error("no visit was saved");
  return visit;
}

/** An entry that counts the catch-up opens it was asked for. */
function entries(home: string, project: string) {
  let opened = 0;
  return {
    opened: () => opened,
    enter: (now: string, signature: string) =>
      recordVisit(home, project, {
        kind: "entry",
        now,
        signature,
        showCatchUp: async () => {
          opened++;
        },
      }),
  };
}

test("returning after an hour shows changed work once; short visits and dismissed work stay quiet", async () => {
  const home = await mkdtemp("/tmp/tdm-visit-");
  const project = "/fixture/tandem";
  const visits = entries(home, project);
  try {
    expect(await visits.enter("2030-01-02T10:00:00Z", "before")).toBe(false);
    expect(await visits.enter("2030-01-02T10:30:00Z", "changed-early")).toBe(false);
    expect(await visits.enter("2030-01-02T11:30:00Z", "changed-later")).toBe(true);
    expect(
      await recordVisit(home, project, {
        kind: "dismiss",
        now: "2030-01-02T11:31:00Z",
        signature: "changed-later",
      }),
    ).toBe(false);
    expect(await visits.enter("2030-01-02T13:00:00Z", "changed-later")).toBe(false);
    expect(visits.opened()).toBe(1);
    expect(await savedVisit(home, project)).toEqual({
      lastOpenedAt: "2030-01-02T13:00:00Z",
      lastVisibleAt: "2030-01-02T13:00:00Z",
      previousSignature: "changed-later",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failed catch-up open does not acknowledge its changed signature", async () => {
  const home = await mkdtemp("/tmp/tdm-visit-");
  const project = "/fixture/tandem";
  try {
    await entries(home, project).enter("2030-01-02T10:00:00Z", "before");
    await expect(
      recordVisit(home, project, {
        kind: "entry",
        now: "2030-01-02T11:00:00Z",
        signature: "after",
        showCatchUp: async () => {
          throw new Error("unknown open outcome");
        },
      }),
    ).rejects.toThrow("unknown open outcome");
    const saved = await savedVisit(home, project);
    expect(saved.previousSignature).toBe("before");
    expect(saved.lastOpenedAt).toBe("2030-01-02T10:00:00Z");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("long foreground work then an immediate return stays quiet; one hour away shows changed work", async () => {
  const home = await mkdtemp("/tmp/tdm-visibility-");
  const project = "/fixture/project";
  const visits = entries(home, project);
  try {
    await visits.enter("2030-01-02T09:00:00Z", "start");
    await recordVisit(home, project, {
      kind: "away",
      now: "2030-01-02T11:00:00Z",
      signature: "working",
    });
    expect(await visits.enter("2030-01-02T11:00:05Z", "immediate-change")).toBe(false);
    await recordVisit(home, project, {
      kind: "away",
      now: "2030-01-02T11:01:00Z",
      signature: "visible-change",
    });
    expect(await visits.enter("2030-01-02T12:01:00Z", "away-change")).toBe(true);
    expect(visits.opened()).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("visibility heartbeats skip writes within a minute; transitions capture departure immediately", async () => {
  const home = await mkdtemp("/tmp/tdm-visibility-");
  const project = "/fixture/project";
  const path = join(projectStoreDirectory(home, project), "state.json");
  try {
    await entries(home, project).enter("2030-01-02T09:00:00Z", "start");
    const original = await readFile(path, "utf8");
    const inode = (await lstat(path)).ino;
    for (const now of ["2030-01-02T09:00:00Z", "2030-01-02T09:00:30Z", "2030-01-02T09:00:59Z"]) {
      await recordVisit(home, project, { kind: "visible", now, signature: "changed" });
      expect(await readFile(path, "utf8")).toBe(original);
      expect((await lstat(path)).ino).toBe(inode);
    }
    await recordVisit(home, project, { kind: "visible", now: "2030-01-02T09:01:00Z" });
    expect((await savedVisit(home, project)).lastVisibleAt).toBe("2030-01-02T09:01:00Z");
    await recordVisit(home, project, {
      kind: "away",
      now: "2030-01-02T09:01:05Z",
      signature: "departure",
    });
    const departed = await readFile(path, "utf8");
    const departureInode = (await lstat(path)).ino;
    expect(await savedVisit(home, project)).toMatchObject({
      lastVisibleAt: "2030-01-02T09:01:05Z",
      previousSignature: "departure",
    });
    for (const now of ["2030-01-02T09:01:05Z", "2030-01-02T09:00:00Z"]) {
      await recordVisit(home, project, { kind: "away", now, signature: "departure" });
      expect(await readFile(path, "utf8")).toBe(departed);
      expect((await lstat(path)).ino).toBe(departureInode);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a visit without a known last-visible time stays quiet", async () => {
  const home = await mkdtemp("/tmp/tdm-visibility-");
  const project = "/fixture/project";
  try {
    const directory = projectStoreDirectory(home, project);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, "state.json"),
      `${JSON.stringify({
        v: 1,
        project,
        epoch: "older-epoch",
        seq: 0,
        visit: { lastOpenedAt: "2030-01-02T09:00:00Z", previousSignature: "old" },
      })}\n`,
      { mode: 0o600 },
    );
    expect(
      await recordVisit(home, project, {
        kind: "entry",
        now: "2030-01-02T12:00:00Z",
        signature: "new",
        showCatchUp: async () => {
          throw new Error("must stay quiet");
        },
      }),
    ).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
