import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeViewText } from "../../src/board/native-views.ts";
import { nativeViewsPath } from "../../src/board/snapshot.ts";
import { repositoryKey } from "../../src/config/repositories.ts";
import {
  dismissNativeCatchUp,
  maybeShowCatchUp,
  visitNativeProject,
} from "../../src/memory/native-visits.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";

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
    const saved = JSON.parse(
      await readFile(join(home, "native-visits", `${repositoryKey(input.project)}.json`), "utf8"),
    );
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
    const saved = JSON.parse(
      await readFile(join(home, "native-visits", `${repositoryKey(input.project)}.json`), "utf8"),
    );
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
  const terminal = {
    ...terminalBackend(async () => ({ code: 0, stdout: "", stderr: "" })),
    name: "tern" as const,
    openView: async () => {
      attempts++;
      return { opened: false, warnings: ["uncertain native outcome"] };
    },
  };
  try {
    expect(await maybeShowCatchUp(terminal, { home, record })).toBe(false);
    const before = { home, project, now: "2030-01-02T10:00:00Z", signature: "before" };
    await visitNativeProject(before, async () => {});
    const path = nativeViewsPath(home, project);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      nativeViewText("panel", {
        version: 1,
        project,
        writtenAt: before.now,
        changeSignature: "after",
        tasks: {},
        briefs: {},
        pullRequests: {},
        projects: [],
      }),
    );
    await expect(
      maybeShowCatchUp(terminal, { home, record, now: "2030-01-02T11:00:00Z" }),
    ).rejects.toThrow("uncertain native outcome");
    const saved = JSON.parse(
      await readFile(join(home, "native-visits", `${repositoryKey(project)}.json`), "utf8"),
    );
    expect(saved.previousSignature).toBe("before");
    expect(saved.lastOpenedAt).toBe(before.now);
    expect(attempts).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
