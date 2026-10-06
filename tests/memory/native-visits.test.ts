import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  dismissNativeCatchUp,
  maybeShowCatchUp,
  recordNativeVisibility,
  visitNativeProject,
} from "../../src/memory/native-visits.ts";
import {
  projectStoreDirectory,
  readProjectState,
  withProjectLock,
} from "../../src/native/store.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { publishFixture } from "../native/view-files.ts";
import { viewsWith } from "../terminal-backend/views.ts";

async function savedVisit(home: string, project: string) {
  const visit = (await readProjectState(home, project))?.visit;
  if (visit === undefined) throw new Error("no visit was saved");
  return visit;
}

test("returning after an hour shows changed work once; short visits and dismissed work stay quiet", async () => {
  const home = await mkdtemp("/tmp/tdm-visit-");
  const input = {
    home,
    project: "/fixture/tandem",
    signature: "before",
    now: "2030-01-02T10:00:00Z",
  };
  let opened = 0;
  const show = async () => {
    opened++;
  };
  try {
    expect(await visitNativeProject(input, show)).toBe(false);
    expect(
      await visitNativeProject(
        { ...input, now: "2030-01-02T10:30:00Z", signature: "changed-early" },
        show,
      ),
    ).toBe(false);
    expect(
      await visitNativeProject(
        { ...input, now: "2030-01-02T11:30:00Z", signature: "changed-later" },
        show,
      ),
    ).toBe(true);
    await dismissNativeCatchUp({
      ...input,
      now: "2030-01-02T11:31:00Z",
      signature: "changed-later",
    });
    expect(
      await visitNativeProject(
        { ...input, now: "2030-01-02T13:00:00Z", signature: "changed-later" },
        show,
      ),
    ).toBe(false);
    expect(opened).toBe(1);
    const saved = await savedVisit(home, input.project);
    expect(saved.previousSignature).toBe("changed-later");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failed catch-up open does not acknowledge its changed signature", async () => {
  const home = await mkdtemp("/tmp/tdm-visit-");
  const input = {
    home,
    project: "/fixture/tandem",
    signature: "before",
    now: "2030-01-02T10:00:00Z",
  };
  try {
    await visitNativeProject(input, async () => {});
    const later = { ...input, now: "2030-01-02T11:00:00Z", signature: "after" };
    await expect(
      visitNativeProject(later, async () => {
        throw new Error("unknown open outcome");
      }),
    ).rejects.toThrow("unknown open outcome");
    const saved = await savedVisit(home, input.project);
    expect(saved.previousSignature).toBe("before");
    expect(saved.lastOpenedAt).toBe(input.now);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the project trigger stays quiet without a publication and preserves visits on refused opens", async () => {
  const home = await mkdtemp("/tmp/tdm-visit-");
  const project = "/fixture/tandem";
  const record = {
    repoPath: project,
    worktree: { path: "/fixture/pool/coordinator" },
    endpoint: {
      terminal: "tern" as const,
      sessionId: "tandem",
      terminalSessionId: "17",
      workspaceId: "201",
      tabId: "201",
      paneId: "101",
      role: "coordinator" as const,
      generation: 0,
    },
  };
  let attempts = 0;
  const base = terminalBackend(async () => ({ code: 0, stdout: "", stderr: "" }));
  const terminal = {
    ...base,
    name: "tern" as const,
    views: viewsWith(base, {
      open: async () => {
        attempts++;
        return { opened: false, warnings: ["uncertain native outcome"] };
      },
    }),
  };
  try {
    expect(await maybeShowCatchUp(terminal, { home, record })).toBe(false);
    const before = { home, project, now: "2030-01-02T10:00:00Z", signature: "before" };
    await visitNativeProject(before, async () => {});
    await publishFixture(home, project, { writtenAt: before.now, changeSignature: "after" });
    await expect(
      maybeShowCatchUp(terminal, { home, record, now: "2030-01-02T11:00:00Z" }),
    ).rejects.toThrow("uncertain native outcome");
    const saved = await savedVisit(home, project);
    expect(saved.previousSignature).toBe("before");
    expect(saved.lastOpenedAt).toBe(before.now);
    expect(attempts).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("long foreground work then an immediate return stays quiet; one hour away shows changed work", async () => {
  const home = await mkdtemp("/tmp/tdm-visibility-");
  const input = {
    home,
    project: "/fixture/project",
    now: "2030-01-02T09:00:00Z",
    signature: "start",
  };
  let shows = 0;
  const show = async () => {
    shows++;
  };
  try {
    await visitNativeProject(input, show);
    await recordNativeVisibility({ ...input, now: "2030-01-02T11:00:00Z", signature: "working" });
    expect(
      await visitNativeProject(
        { ...input, now: "2030-01-02T11:00:05Z", signature: "immediate-change" },
        show,
      ),
    ).toBe(false);
    await recordNativeVisibility({
      ...input,
      now: "2030-01-02T11:01:00Z",
      signature: "visible-change",
    });
    expect(
      await visitNativeProject(
        { ...input, now: "2030-01-02T12:01:00Z", signature: "away-change" },
        show,
      ),
    ).toBe(true);
    expect(shows).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("visibility heartbeats skip writes within a minute; transitions capture departure immediately", async () => {
  const home = await mkdtemp("/tmp/tdm-visibility-");
  const input = {
    home,
    project: "/fixture/project",
    now: "2030-01-02T09:00:00Z",
    signature: "start",
  };
  const path = join(projectStoreDirectory(home, input.project), "state.json");
  try {
    await visitNativeProject(input, async () => {});
    const original = await readFile(path, "utf8");
    const inode = (await lstat(path)).ino;
    for (const now of ["2030-01-02T09:00:00Z", "2030-01-02T09:00:30Z", "2030-01-02T09:00:59Z"]) {
      await recordNativeVisibility({ ...input, now, signature: "changed", heartbeat: true });
      expect(await readFile(path, "utf8")).toBe(original);
      expect((await lstat(path)).ino).toBe(inode);
    }
    await recordNativeVisibility({ ...input, now: "2030-01-02T09:01:00Z", heartbeat: true });
    expect(JSON.parse(await readFile(path, "utf8")).visit.lastVisibleAt).toBe(
      "2030-01-02T09:01:00Z",
    );
    await recordNativeVisibility({ ...input, now: "2030-01-02T09:01:05Z", signature: "departure" });
    const departed = await readFile(path, "utf8");
    const departureInode = (await lstat(path)).ino;
    expect(JSON.parse(departed).visit).toMatchObject({
      lastVisibleAt: "2030-01-02T09:01:05Z",
      previousSignature: "departure",
    });
    for (const now of ["2030-01-02T09:01:05Z", "2030-01-02T09:00:00Z"]) {
      await recordNativeVisibility({ ...input, now, signature: "departure" });
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
    await withProjectLock(home, project, async (store) =>
      store.write({
        ...(await store.read()),
        visit: { lastOpenedAt: "2030-01-02T09:00:00Z", previousSignature: "old" },
      }),
    );
    expect(
      await visitNativeProject(
        { home, project, now: "2030-01-02T12:00:00Z", signature: "new" },
        async () => {
          throw new Error("must stay quiet");
        },
      ),
    ).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
