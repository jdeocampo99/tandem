import { expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { NativeViewsReader } from "../../src/board/native-read.ts";
import { nativeViewsPath, writeNativeViews } from "../../src/board/snapshot.ts";
import { boardView } from "../../src/board/view.ts";
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
    expect(Object.values(first.tasks)[0]?.stuck?.reason).toBe("worker stopped twice");
    expect(Object.values(first.tasks)[0]?.progress.events[0]?.type).toBe("created");
    expect(Object.values(first.tasks)[0]?.cost?.recorded).toBe(false);
    expect(commands).toEqual(["omp usage --json"]);
    expect(first.changeSignature).toBe(second.changeSignature);
    await writeNativeViews(world.home, first);
    const path = nativeViewsPath(world.home, world.repoPath);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(world.home, "native-views"))).toEqual([path.split("/").at(-1) ?? ""]);
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
    expect(second.warnings).toEqual([
      "Provider limit refresh failed; last known limits may be stale",
    ]);
    expect(second.usage.limits).toEqual([]);
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
    expect(view.warnings).toContain("Provider limits are refreshing");
    release?.();
    await reader.settle();
    expect((await reader.read(snapshot, world.repoPath)).warnings).not.toContain(
      "Provider limits are refreshing",
    );
  });
});
