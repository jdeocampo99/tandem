import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedPolicy, TaskRecord } from "../../src/contracts.ts";
import { readMigrationStatus, setMigrationStatus } from "../../src/runtime/database.ts";
import { MigrationError, migrateState, planMigration } from "../../src/runtime/migration.ts";
import { readRuntimeState, runtimeFile } from "../../src/runtime/persistence.ts";
import type { RuntimeState } from "../../src/runtime/schema.ts";
import { createTask } from "../../src/tasks/lifecycle.ts";
import { createTaskStore } from "../../src/tasks/store.ts";

const policy: ResolvedPolicy = {
  config: {
    version: 1,
    models: {
      coordinator: { model: "coordinator", thinking: "high" },
      scout: { model: "scout", thinking: "medium" },
      implementer: { model: "implementer", thinking: "high" },
      reviewer: { model: "reviewer", thinking: "high" },
      verifier: { model: "verifier", thinking: "high" },
      presentation: { model: "presentation", thinking: "low" },
    },
    instructions: { implementation: [], validation: [], review: [] },
    instructionFiles: { implementation: [], validation: [], review: [] },
    validationCommands: [],
    setupCommands: [],
    maxWorkers: 2,
    maxFixRounds: 2,
    reviewLevels: {
      reducedRouting: false,
      deepScrutiny: false,
      jevAssistance: "off",
      sourceTransmission: false,
    },
    requestBudget: { capMicros: "unset", operationEstimateMicros: "unset" },
  },
  guidance: { implementation: [], validation: [], review: [] },
};

function legacyTask(home: string): TaskRecord {
  const created = createTask(
    {
      id: "legacy-task",
      repoPath: join(home, "repo"),
      kind: "implementation",
      objective: "Preserve this legacy task",
      acceptanceCriteria: ["Keep its durable state"],
      surfaces: ["src/example.ts"],
      policy,
    },
    "2030-01-02T03:04:05.000Z",
  );
  return {
    ...created,
    revision: 4,
    stage: "completed",
    previousStage: "reviewing",
    generation: 2,
    reviewRound: 1,
    reviewHead: "review-head",
    reportPath: join(home, "reports", "legacy.md"),
    updatedAt: "2030-01-02T03:04:06.000Z",
  };
}

function legacyRuntime(home: string, task: TaskRecord): RuntimeState {
  return {
    schemaVersion: 1,
    tasks: [
      {
        schemaVersion: 1,
        taskId: task.id,
        sourceCheckpoint: {
          head: "checkpoint-head",
          base: "checkpoint-base",
          diff: "diff --git a/src/example.ts b/src/example.ts",
          dirty: false,
          unmerged: false,
        },
        sourceRepoPath: join(home, "repo"),
        taskName: "legacy-task",
        endpoints: [],
        jobs: [],
      },
    ],
    presentations: [],
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function source(
  path: string,
  contents: string,
): { readonly path: string; readonly sha256: string; readonly bytes: number } {
  const bytes = Buffer.byteLength(contents);
  return {
    path,
    bytes,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function writeLegacySnapshot(
  home: string,
  task: TaskRecord,
  runtime: RuntimeState = legacyRuntime(home, task),
): Promise<{
  readonly taskPath: string;
  readonly runtimePath: string;
  readonly taskBytes: string;
  readonly runtimeBytes: string;
}> {
  const taskPath = join(home, "tasks", `${task.id}.json`);
  const runtimePath = runtimeFile(home);
  const taskBytes = json(task);
  const runtimeBytes = json(runtime);
  await mkdir(join(home, "tasks"), { recursive: true });
  await writeFile(taskPath, taskBytes, "utf8");
  await writeFile(runtimePath, runtimeBytes, "utf8");
  return { taskPath, runtimePath, taskBytes, runtimeBytes };
}

async function writeManifest(
  home: string,
  sources: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[],
  phase: "prepared" | "archived" | "imported" | "fenced" | "complete",
): Promise<void> {
  const archivePath = join(home, ".tandem-migration", "archive");
  await mkdir(join(home, ".tandem-migration"), { recursive: true });
  await writeFile(
    join(home, ".tandem-migration", "manifest.json"),
    json({
      schemaVersion: 1,
      id: "migration-fixture",
      home,
      createdAt: "2030-01-02T03:04:05.000Z",
      phase,
      sources,
      archivePath,
    }),
    "utf8",
  );
}

test("read-only migration planning does not create state for an empty offline home", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-empty-"));
  try {
    const plan = await planMigration(home);
    expect(plan.status).toBe("empty");
    await expect(lstat(join(home, "state.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("malformed legacy runtime is refused before any cutover mutation", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-malformed-"));
  try {
    await writeFile(join(home, "runtime.json"), "{not-json", "utf8");
    await expect(planMigration(home)).rejects.toBeInstanceOf(MigrationError);
    await expect(lstat(join(home, "state.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migration archives and fences the legacy runtime while preserving its bytes", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-apply-"));
  const original = JSON.stringify({ schemaVersion: 1, tasks: [], presentations: [] });
  try {
    await writeFile(join(home, "runtime.json"), original, "utf8");
    const result = await migrateState(home);
    expect(result.status).toBe("complete");
    expect(await readMigrationStatus(home)).toBe("complete");
    expect(await readFile(join(home, ".tandem-migration", "archive", "runtime.json"), "utf8")).toBe(
      original,
    );
    expect((await lstat(join(home, "runtime.json"))).isDirectory()).toBe(true);
    expect(await readFile(join(home, ".tandem-migration", "fence.json"), "utf8")).toContain(
      "archivePath",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migration refuses an explicitly live native authority before cutover", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-live-"));
  const original = JSON.stringify({ schemaVersion: 1, tasks: [], presentations: [] });
  try {
    await writeFile(join(home, "runtime.json"), original, "utf8");
    const inspectAuthority = async () => ({
      live: true as const,
      ambiguous: false as const,
      evidence: ["worker pid 42"],
    });
    await expect(planMigration(home, { inspectAuthority })).resolves.toMatchObject({
      status: "blocked",
      diagnostics: ["worker pid 42"],
    });
    await expect(migrateState(home, { inspectAuthority })).rejects.toThrow("migration refused");
    await expect(lstat(join(home, "state.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(home, "runtime.json"), "utf8")).toBe(original);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("malformed legacy task is refused before runtime or task cutover", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-malformed-task-"));
  const runtimeBytes = json({ schemaVersion: 1, tasks: [], presentations: [] });
  const taskPath = join(home, "tasks", "broken.json");
  try {
    await mkdir(join(home, "tasks"), { recursive: true });
    await writeFile(runtimeFile(home), runtimeBytes, "utf8");
    await writeFile(taskPath, "{not-json", "utf8");
    await expect(planMigration(home)).rejects.toBeInstanceOf(MigrationError);
    await expect(lstat(join(home, "state.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(runtimeFile(home), "utf8")).toBe(runtimeBytes);
    expect(await readFile(taskPath, "utf8")).toBe("{not-json");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("symlinked legacy runtime is refused without following or fencing its target", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-symlink-"));
  const target = join(home, "target-runtime.json");
  const runtimePath = runtimeFile(home);
  const targetBytes = json({ schemaVersion: 1, tasks: [], presentations: [] });
  try {
    await writeFile(target, targetBytes, "utf8");
    await symlink(target, runtimePath);
    await expect(planMigration(home)).rejects.toBeInstanceOf(MigrationError);
    await expect(lstat(join(home, "state.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(runtimePath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe(targetBytes);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("default authority inspection blocks an unknown active worker without registry cutover", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-worker-"));
  const task = legacyTask(home);
  const baseRuntime = legacyRuntime(home, task);
  const baseTask = baseRuntime.tasks[0];
  if (baseTask === undefined) throw new Error("missing runtime task fixture");
  const activeRuntime: RuntimeState = {
    ...baseRuntime,
    tasks: [
      {
        ...baseTask,
        jobs: [
          {
            schemaVersion: 1,
            id: "legacy-worker",
            taskId: task.id,
            generation: 2,
            role: "implementer",
            kind: "worker",
            cwd: join(home, "worktree"),
            jobPath: join(home, "jobs", "legacy-worker.json"),
            resultPath: join(home, "jobs", "legacy-worker.result.json"),
            attempt: 1,
            phase: "running",
            launchAttempted: true,
            createdAt: "2030-01-02T03:04:05.000Z",
          },
        ],
      },
    ],
  };
  try {
    const fixture = await writeLegacySnapshot(home, task, activeRuntime);
    const plan = await planMigration(home);
    expect(plan.status).toBe("blocked");
    expect(plan.diagnostics.join(" ")).toContain("active worker job legacy-worker");
    await expect(migrateState(home)).rejects.toThrow("migration refused");
    await expect(lstat(join(home, "state.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(fixture.runtimePath, "utf8")).toBe(fixture.runtimeBytes);
    expect(await readFile(fixture.taskPath, "utf8")).toBe(fixture.taskBytes);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("imports nonempty legacy task and runtime state without losing identity or evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-import-"));
  const task = legacyTask(home);
  const runtime = legacyRuntime(home, task);
  try {
    const fixture = await writeLegacySnapshot(home, task, runtime);
    const result = await migrateState(home);
    expect(result.status).toBe("complete");
    expect(result.taskCount).toBe(1);
    expect(await readMigrationStatus(home)).toBe("complete");

    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => "2030-01-02T03:04:07.000Z",
      idFactory: () => "unused",
    });
    expect(await store.read(task.id)).toEqual(task);
    expect(await readRuntimeState(runtimeFile(home))).toEqual(runtime);
    expect(await readFile(join(home, ".tandem-migration", "archive", "runtime.json"), "utf8")).toBe(
      fixture.runtimeBytes,
    );
    await expect(writeFile(runtimeFile(home), fixture.runtimeBytes, "utf8")).rejects.toThrow();
    await expect(
      (async () => {
        const legacyTasks = join(home, "tasks");
        await mkdir(legacyTasks, { recursive: true });
        await chmod(legacyTasks, 0o700);
        await writeFile(join(legacyTasks, `${task.id}.json`), fixture.taskBytes, "utf8");
      })(),
    ).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy scout records migrate to the conservative post-research disposition", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-scout-"));
  try {
    const scout = createTask(
      {
        id: "legacy-scout",
        repoPath: join(home, "repo"),
        kind: "scout",
        objective: "Preserve this legacy research task",
        acceptanceCriteria: ["Keep its durable state"],
        surfaces: ["src/example.ts"],
        policy,
      },
      "2030-01-02T03:04:05.000Z",
    );
    const { researchContinuation: _absentBeforeMigration, ...withoutContinuation } = scout;
    await writeLegacySnapshot(home, withoutContinuation, legacyRuntime(home, scout));

    const result = await migrateState(home);
    expect(result.status).toBe("complete");

    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => "2030-01-02T03:04:07.000Z",
      idFactory: () => "unused",
    });
    const migrated = await store.read(scout.id);
    expect(migrated?.researchContinuation).toEqual({
      schemaVersion: 1,
      disposition: "ask-intent",
      selectedBy: "deterministic",
    });
    expect(migrated?.scopeApproved).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resumes an interrupted runtime-only archive and commits imported state before fencing", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-runtime-archive-"));
  const task = legacyTask(home);
  const runtime = legacyRuntime(home, task);
  try {
    const fixture = await writeLegacySnapshot(home, task, runtime);
    const sources = [
      source(fixture.runtimePath, fixture.runtimeBytes),
      source(fixture.taskPath, fixture.taskBytes),
    ];
    await writeManifest(home, sources, "archived");
    await mkdir(join(home, ".tandem-migration", "archive"), { recursive: true });
    await rename(fixture.runtimePath, join(home, ".tandem-migration", "archive", "runtime.json"));
    await setMigrationStatus(home, "pending");

    await expect(planMigration(home)).resolves.toMatchObject({ status: "pending", taskCount: 1 });
    expect((await migrateState(home)).status).toBe("complete");
    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => "2030-01-02T03:04:07.000Z",
      idFactory: () => "unused",
    });
    expect(await store.read(task.id)).toEqual(task);
    expect(await readRuntimeState(runtimeFile(home))).toEqual(runtime);
    expect(await readMigrationStatus(home)).toBe("complete");
    expect(await readFile(join(home, ".tandem-migration", "archive", "runtime.json"), "utf8")).toBe(
      fixture.runtimeBytes,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("replays an import-committed pending manifest without duplicating state", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-import-replay-"));
  const task = legacyTask(home);
  const runtime = legacyRuntime(home, task);
  try {
    await writeLegacySnapshot(home, task, runtime);
    await migrateState(home);
    const manifestPath = join(home, ".tandem-migration", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.phase = "imported";
    await writeFile(manifestPath, json(manifest), "utf8");
    await setMigrationStatus(home, "pending");

    await expect(planMigration(home)).resolves.toMatchObject({ status: "pending" });
    expect((await migrateState(home)).status).toBe("complete");
    const store = createTaskStore({
      directory: join(home, "tasks"),
      clock: () => "2030-01-02T03:04:07.000Z",
      idFactory: () => "unused",
    });
    expect(await store.read(task.id)).toEqual(task);
    expect(await readRuntimeState(runtimeFile(home))).toEqual(runtime);
    expect(await readMigrationStatus(home)).toBe("complete");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("replays a fenced migration and publishes the final completion marker", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-fenced-replay-"));
  const task = legacyTask(home);
  try {
    await writeLegacySnapshot(home, task);
    await migrateState(home);
    const manifestPath = join(home, ".tandem-migration", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.phase = "fenced";
    await writeFile(manifestPath, json(manifest), "utf8");

    await expect(planMigration(home)).resolves.toMatchObject({ status: "pending" });
    expect((await migrateState(home)).status).toBe("complete");
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({ phase: "complete" });
    expect(await readMigrationStatus(home)).toBe("complete");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("completed migration replay is idempotent", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-replay-"));
  try {
    await writeFile(
      join(home, "runtime.json"),
      JSON.stringify({ schemaVersion: 1, tasks: [], presentations: [] }),
      "utf8",
    );
    expect((await migrateState(home)).status).toBe("complete");
    expect((await migrateState(home)).status).toBe("complete");
    expect(await readMigrationStatus(home)).toBe("complete");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("unknown nested legacy runtime fields are refused without changing source files", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-migration-nested-"));
  const task = legacyTask(home);
  try {
    const runtime = legacyRuntime(home, task);
    const raw = JSON.parse(json(runtime)) as { tasks: Array<Record<string, unknown>> };
    const runtimeTask = raw.tasks[0];
    if (runtimeTask === undefined) throw new Error("missing runtime task fixture");
    runtimeTask.unexpectedEvidence = { retained: true };
    const fixture = await writeLegacySnapshot(home, task, runtime);
    const runtimeBytes = json(raw);
    await writeFile(fixture.runtimePath, runtimeBytes, "utf8");
    await expect(planMigration(home)).rejects.toBeInstanceOf(MigrationError);
    expect(await readFile(fixture.runtimePath, "utf8")).toBe(runtimeBytes);
    expect(await readFile(fixture.taskPath, "utf8")).toBe(fixture.taskBytes);
    await expect(lstat(join(home, "state.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
