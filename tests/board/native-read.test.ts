import { expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeViewsReader } from "../../src/board/native-read.ts";
import { nativeDetailPath, nativeViewsPath, writeNativeViews } from "../../src/board/snapshot.ts";
import { boardView } from "../../src/board/view.ts";
import { repositoryKey } from "../../src/config/repositories.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { seedScenarioTask, withScenario } from "../evals/scenario.ts";
import { state } from "./fixtures.ts";

test("native bundle reads saved task inspection/timeline and writes an atomic private project-scoped file", async () => {
  await withScenario({}, async (world) => {
    const task = await seedScenarioTask(world, {
      kind: "implementation",
      stage: "blocked",
      previousStage: "implementing",
    });
    await world.store.update(task.id, task.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      blockReason: "worker stopped twice",
    }));
    const commands: string[] = [];
    const run: typeof world.run = async (request) => {
      if (request.argv[0] === "omp") {
        commands.push(request.argv.join(" "));
        return { code: 0, stdout: '{"reports":[]}', stderr: "" };
      }
      return world.run(request);
    };
    const reader = new NativeViewsReader({
      home: world.home,
      clock: world.clock,
      run,
      terminal: terminalBackend(run),
    });
    const snapshot = {
      version: 1 as const,
      writtenAt: world.clock(),
      board: boardView(state({ projects: [world.repoPath] }), world.clock()),
      coordinators: [],
    };
    const first = await reader.read(snapshot, world.repoPath);
    const second = await reader.read(snapshot, world.repoPath);
    const detail = first.details.find((detail) => detail.view.kind === "task");
    if (detail?.view.kind !== "task") throw new Error("Expected task detail");
    expect(detail.view.data.stuck?.reason).toBe("worker stopped twice");
    expect(detail.view.data.progress.events[0]?.type).toBe("created");
    expect(detail.view.data.cost?.recorded).toBe(false);
    expect(first.bundle.tasks[task.id]?.detailFile).toBe(detail.file);
    expect(first.bundle.tasks[task.id]).not.toHaveProperty("progress");
    expect(commands).toEqual(["omp usage --json"]);
    expect(first.bundle.changeSignature).toBe(second.bundle.changeSignature);
    await writeNativeViews(world.home, first);
    const path = nativeViewsPath(world.home, world.repoPath);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(first.bundle);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const detailPath = nativeDetailPath(world.home, world.repoPath, detail.file);
    expect(JSON.parse(await readFile(detailPath, "utf8"))).toEqual(detail.view);
    expect((await stat(detailPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(world.home, "native-views"))).toSorted()).toEqual(
      [repositoryKey(world.repoPath), `${repositoryKey(world.repoPath)}.json`].toSorted(),
    );
    const detailStat = await stat(detailPath);
    const bundleStat = await stat(path);
    await writeNativeViews(world.home, first);
    expect((await stat(detailPath)).ino).toBe(detailStat.ino);
    expect((await stat(detailPath)).mtimeMs).toBe(detailStat.mtimeMs);
    expect((await stat(path)).ino).toBe(bundleStat.ino);
    await writeNativeViews(world.home, {
      bundle: first.bundle,
      details: [
        {
          ...detail,
          view: {
            ...detail.view,
            data: {
              ...detail.view.data,
              stuck: { reason: "updated stop", actions: ["restart", "steer"] },
            },
          },
        },
      ],
    });
    expect((await stat(detailPath)).ino).not.toBe(detailStat.ino);
    expect((await stat(path)).ino).toBe(bundleStat.ino);
    expect(nativeViewsPath(world.home, "/different/app")).not.toBe(
      nativeViewsPath(world.home, "/work/app"),
    );
  });
});

test("provider refresh failure is visible and backs off while task data still projects", async () => {
  await withScenario({}, async (world) => {
    let attempts = 0;
    const run: typeof world.run = async (request) => {
      if (request.argv[0] === "omp") {
        attempts++;
        return { code: 1, stdout: "", stderr: "unavailable" };
      }
      return world.run(request);
    };
    const reader = new NativeViewsReader({
      home: world.home,
      clock: world.clock,
      run,
      terminal: terminalBackend(run),
    });
    const snapshot = {
      version: 1 as const,
      writtenAt: world.clock(),
      board: boardView(state({ projects: [world.repoPath] }), world.clock()),
      coordinators: [],
    };
    await reader.read(snapshot, world.repoPath);
    const second = await reader.read(snapshot, world.repoPath);
    expect(attempts).toBe(1);
    expect(second.bundle.warnings).toEqual([
      "Provider limit refresh failed; last known limits may be stale",
    ]);
    expect(second.bundle.usage.limits).toEqual([]);
  });
});

test("slow remote usage never blocks native task snapshots and shutdown drains its refresh", async () => {
  await withScenario({}, async (world) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run: typeof world.run = async (request) => {
      if (request.argv[0] === "omp") {
        await gate;
        return { code: 0, stdout: '{"reports":[]}', stderr: "" };
      }
      return world.run(request);
    };
    const reader = new NativeViewsReader({
      home: world.home,
      clock: world.clock,
      run,
      terminal: terminalBackend(run),
    });
    const snapshot = {
      version: 1 as const,
      writtenAt: world.clock(),
      board: boardView(state({ projects: [world.repoPath] }), world.clock()),
      coordinators: [],
    };
    const view = await reader.read(snapshot, world.repoPath);
    expect(view.bundle.warnings).toContain("Provider limits are refreshing");
    release?.();
    await reader.settle();
    expect((await reader.read(snapshot, world.repoPath)).bundle.warnings).not.toContain(
      "Provider limits are refreshing",
    );
  });
});

test("project switcher reads only other owners' published summaries without rewriting their state", async () => {
  await withScenario({}, async (world) => {
    const run: typeof world.run = async (request) =>
      request.argv[0] === "omp"
        ? { code: 0, stdout: '{"reports":[]}', stderr: "" }
        : world.run(request);
    const reader = new NativeViewsReader({
      home: world.home,
      clock: world.clock,
      run,
      terminal: terminalBackend(run),
    });
    const snapshot = {
      version: 1 as const,
      writtenAt: world.clock(),
      board: boardView(state({ projects: [world.repoPath, "/another/app"] }), world.clock()),
      coordinators: [],
    };
    const initial = await reader.read(
      snapshot,
      world.repoPath,
      new Map([[world.repoPath, "own-session"]]),
    );
    const other = {
      bundle: {
        ...initial.bundle,
        project: "/another/app",
        summary: {
          ...initial.bundle.summary,
          repoPath: "/another/app",
          name: "Other app",
          running: 4,
          needsYou: 9,
          sessionId: "other-session",
        },
      },
      details: [],
    };
    await writeNativeViews(world.home, other);
    const path = nativeViewsPath(world.home, other.bundle.project);
    const before = await readFile(path, "utf8");
    const inode = (await stat(path)).ino;
    const publication = await reader.read(snapshot, world.repoPath);
    expect(
      publication.bundle.projects.find((project) => project.repoPath === "/another/app"),
    ).toMatchObject({
      name: "Other app",
      running: 4,
      needsYou: 9,
      offline: false,
      sessionId: "other-session",
      current: false,
    });
    expect(publication.bundle.panel.header.otherProjectsNeedYou).toBe(9);
    expect(publication.bundle.summary.repoPath).toBe(world.repoPath);
    await writeNativeViews(world.home, publication);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await stat(path)).ino).toBe(inode);
    await writeFile(path, JSON.stringify({ ...other.bundle, version: 2 }));
    const unreadable = await reader.read(snapshot, world.repoPath);
    expect(unreadable.bundle.projects).toHaveLength(1);
    expect(
      unreadable.bundle.warnings.some((warning) =>
        warning.startsWith("Native project summary unavailable:"),
      ),
    ).toBe(true);
    await reader.settle();
  });
});

test("native publication refuses cross-project details and escaping filenames before writing", async () => {
  await withScenario({}, async (world) => {
    await seedScenarioTask(world, { kind: "implementation", stage: "implementing" });
    const reader = new NativeViewsReader({
      home: world.home,
      clock: world.clock,
      run: world.run,
      terminal: terminalBackend(world.run),
    });
    const publication = await reader.read(
      {
        version: 1,
        writtenAt: world.clock(),
        board: boardView(state({ projects: [world.repoPath] }), world.clock()),
        coordinators: [],
      },
      world.repoPath,
    );
    const detail = publication.details[0];
    if (detail === undefined) throw new Error("Expected detail");
    await expect(
      writeNativeViews(world.home, {
        ...publication,
        details: [{ ...detail, view: { ...detail.view, project: "/another/app" } }],
      }),
    ).rejects.toThrow("another project's detail");
    await expect(
      writeNativeViews(world.home, {
        ...publication,
        details: [{ ...detail, file: "task-../../escape.json" }],
      }),
    ).rejects.toThrow("filename");
    await expect(stat(nativeViewsPath(world.home, world.repoPath))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    await reader.settle();
  });
});
