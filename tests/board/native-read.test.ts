import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { NativeAlerts } from "../../src/board/native-alerts.ts";
import { NativeViewsReader } from "../../src/board/native-read.ts";
import { boardView } from "../../src/board/view.ts";
import { repositoryKey } from "../../src/config/repositories.ts";
import { ViewFile } from "../../src/native/contract.ts";
import {
  markNativeAlertsRead,
  projectStoreDirectory,
  publishViews,
  readPublished,
  viewDetailPath,
  viewIndexPath,
} from "../../src/native/store.ts";
import { reviseRequestBriefRecord } from "../../src/requests/brief.ts";
import { createRequestBriefStore } from "../../src/requests/store.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import { seedScenarioTask, withScenario } from "../evals/scenario.ts";
import { savedState } from "../native/view-files.ts";
import { content, state } from "./fixtures.ts";

test("serialized brief detail exposes the exact native approval input for its displayed revision", async () => {
  await withScenario({}, async (world) => {
    const store = createRequestBriefStore({
      home: world.home,
      clock: world.clock,
      idFactory: world.idFactory,
    });
    const first = await store.create({ repoPath: world.repoPath, content: content("Old scope") });
    const revised = await store.update(first.id, first.revision, (current) =>
      reviseRequestBriefRecord(current, content("Approve the revised scope"), world.clock()),
    );
    const reader = new NativeViewsReader({
      home: world.home,
      clock: world.clock,
      run: world.run,
      terminal: terminalBackend(world.run, { terminal: "herdr" }),
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
    await publishViews(world.home, publication.bundle.project, async () => publication);
    const entry = publication.bundle.briefs[first.id];
    if (entry === undefined) throw new Error("Expected brief index");
    const detail = z
      .object({
        v: z.literal(1),
        kind: z.literal("brief"),
        epoch: z.string().min(1),
        seq: z.number().int().positive(),
        model: z.object({
          requestId: z.string(),
          revision: z.number(),
          lines: z.array(z.object({ text: z.string() })),
          approval: z
            .object({
              briefRevision: z.number(),
              contentDigest: z.string(),
              agreementDigest: z.string(),
            })
            .strict(),
        }),
      })
      .strict()
      .parse(
        JSON.parse(
          await readFile(viewDetailPath(world.home, world.repoPath, entry.detailFile), "utf8"),
        ),
      );
    expect(detail.kind).toBe("brief");
    expect(detail.model.requestId).toBe(first.id);
    expect(detail.model.revision).toBe(2);
    expect(detail.model.lines.some((line) => line.text === "Approve the revised scope")).toBe(true);
    expect(detail.model.approval).toEqual({
      briefRevision: revised.draft.revision,
      contentDigest: revised.draft.contentDigest,
      agreementDigest: revised.draft.agreementDigest,
    });
    expect(detail.model.approval.contentDigest).not.toBe(first.draft.contentDigest);
    expect(detail.model.approval.agreementDigest).not.toBe(first.draft.agreementDigest);
    await reader.settle();
  });
});

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
      terminal: terminalBackend(run, { terminal: "herdr" }),
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
    await publishViews(world.home, first.bundle.project, async () => first);
    const path = viewIndexPath(world.home, world.repoPath);
    const index = ViewFile.parse(JSON.parse(await readFile(path, "utf8")));
    expect(index).toEqual({ v: 1, kind: "index", epoch: index.epoch, seq: 2, model: first.bundle });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const detailPath = viewDetailPath(world.home, world.repoPath, detail.file);
    // Details are written before the index that names them, so they take the lower seq.
    expect(JSON.parse(await readFile(detailPath, "utf8"))).toEqual({
      v: 1,
      kind: "task",
      epoch: index.epoch,
      seq: 1,
      model: detail.view.data,
    });
    expect((await stat(detailPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(world.home, "tern"))).toEqual([repositoryKey(world.repoPath)]);
    expect((await readdir(projectStoreDirectory(world.home, world.repoPath))).toSorted()).toEqual([
      "state.json",
      "state.lock",
      "views",
    ]);
    const detailStat = await stat(detailPath);
    const bundleStat = await stat(path);
    await publishViews(world.home, first.bundle.project, async () => first);
    expect((await stat(detailPath)).ino).toBe(detailStat.ino);
    expect((await stat(detailPath)).mtimeMs).toBe(detailStat.mtimeMs);
    expect((await stat(path)).ino).toBe(bundleStat.ino);
    const taskView = detail.view;
    await publishViews(world.home, world.repoPath, async () => ({
      bundle: first.bundle,
      details: [
        {
          ...detail,
          view: {
            ...taskView,
            data: {
              ...taskView.data,
              stuck: { reason: "updated stop", actions: ["restart", "steer"] },
            },
          },
        },
      ],
    }));
    expect((await stat(detailPath)).ino).not.toBe(detailStat.ino);
    expect(ViewFile.parse(JSON.parse(await readFile(detailPath, "utf8"))).seq).toBe(3);
    expect((await stat(path)).ino).toBe(bundleStat.ino);
    expect(viewIndexPath(world.home, "/different/app")).not.toBe(
      viewIndexPath(world.home, "/work/app"),
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
      terminal: terminalBackend(run, { terminal: "herdr" }),
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

test("retained provider limits carry their original fetch time and failed-refresh warning into Usage display", async () => {
  await withScenario({}, async (world) => {
    let attempts = 0;
    const fetchedAt = Date.parse(world.clock());
    const run: typeof world.run = async (request) => {
      if (request.argv[0] !== "omp") return world.run(request);
      attempts++;
      return attempts === 1
        ? {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              reports: [
                {
                  provider: "anthropic",
                  fetchedAt,
                  limits: [
                    {
                      id: "five_hour",
                      label: "5-hour",
                      scope: { provider: "anthropic", accountId: "personal" },
                      window: { id: "5h", label: "5-hour", resetsAt: fetchedAt + 10_800_000 },
                      amount: { unit: "percent", used: 38 },
                    },
                  ],
                },
              ],
            }),
          }
        : { code: 1, stderr: "provider unavailable", stdout: "" };
    };
    const reader = new NativeViewsReader({
      home: world.home,
      clock: world.clock,
      run,
      terminal: terminalBackend(run, { terminal: "herdr" }),
    });
    const snapshot = {
      version: 1 as const,
      writtenAt: world.clock(),
      board: boardView(state({ projects: [world.repoPath] }), world.clock()),
      coordinators: [],
    };
    try {
      await reader.read(snapshot, world.repoPath);
      const fresh = await reader.read(snapshot, world.repoPath);
      expect(fresh.bundle.usage.limits[0]?.remainingPercent).toBe(62);
      world.advanceClock(2);
      await reader.read(snapshot, world.repoPath);
      const stale = await reader.read(snapshot, world.repoPath);
      expect(attempts).toBe(2);
      expect(stale.bundle.usage.limits[0]).toMatchObject({
        remainingPercent: 62,
        fetchedAt: "2030-01-01T00:00:00.000Z",
      });
      expect(stale.bundle.usage.display?.limitWarnings).toEqual(stale.bundle.warnings);
      expect(stale.bundle.usage.display?.limitWarnings).toContain(
        "Provider limit refresh failed; last known limits may be stale",
      );
      expect(stale.bundle.usage.display?.accounts[0]?.meters[0]).toMatchObject({
        remaining: "62% left",
        reset: "resets in 2h 58m",
        fetched: "Fetched at 2030-01-01 00:00:00 UTC",
      });
      expect(stale.bundle.usage.display?.updated).toBe("View updated at 2030-01-01 00:02:00 UTC");
    } finally {
      await reader.settle();
    }
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
      terminal: terminalBackend(run, { terminal: "herdr" }),
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
      terminal: terminalBackend(run, { terminal: "herdr" }),
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
    await publishViews(world.home, other.bundle.project, async () => other);
    const path = viewIndexPath(world.home, other.bundle.project);
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
    expect(initial.bundle.summary).toMatchObject({ sessionId: "own-session" });
    await publishViews(world.home, publication.bundle.project, async () => publication);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await stat(path)).ino).toBe(inode);
    const otherState = join(projectStoreDirectory(world.home, other.bundle.project), "state.json");
    const saved = JSON.parse(await readFile(otherState, "utf8"));
    await writeFile(
      otherState,
      JSON.stringify({
        ...saved,
        published: {
          ...saved.published,
          summary: { ...saved.published.summary, terminal: "herdr" },
        },
      }),
    );
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
      terminal: terminalBackend(world.run, { terminal: "herdr" }),
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
      publishViews(world.home, world.repoPath, async () => ({
        ...publication,
        details: [{ ...detail, view: { ...detail.view, project: "/another/app" } }],
      })),
    ).rejects.toThrow("another project's detail");
    await expect(
      publishViews(world.home, world.repoPath, async () => ({
        ...publication,
        details: [{ ...detail, file: "task-../../escape.json" }],
      })),
    ).rejects.toThrow("filename");
    await expect(stat(viewIndexPath(world.home, world.repoPath))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    await reader.settle();
  });
});

test("publication prunes absent task/brief/PR details only in its own project and retains warming PRs", async () => {
  await withScenario({}, async (world) => {
    const task = await seedScenarioTask(world, { kind: "implementation", stage: "blocked" });
    await world.store.update(task.id, task.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      pullRequest: {
        repository: "acme/app",
        number: 4,
        state: "draft",
        head: "head-4",
        base: "base-4",
      },
    }));
    const reader = new NativeViewsReader({
      home: world.home,
      clock: world.clock,
      run: world.run,
      terminal: terminalBackend(world.run, { terminal: "herdr" }),
    });
    try {
      const publication = await reader.read(
        {
          version: 1,
          writtenAt: world.clock(),
          board: boardView(state({ projects: [world.repoPath] }), world.clock()),
          coordinators: [],
        },
        world.repoPath,
      );
      expect(publication.retainedDetailFiles).toContain("pr-acme%2Fapp-4.json");
      await publishViews(world.home, publication.bundle.project, async () => publication);
      const directory = join(projectStoreDirectory(world.home, world.repoPath), "views");
      const stale = ["task-deleted.json", "brief-deleted.json", "pr-acme%2Fapp-3.json"];
      for (const file of [...stale, "pr-acme%2Fapp-4.json", "notes.json", "task-write.json.tmp"])
        await writeFile(join(directory, file), "previous content");
      const foreign = viewDetailPath(world.home, "/another/app", "task-foreign.json");
      await mkdir(join(projectStoreDirectory(world.home, "/another/app"), "views"), {
        recursive: true,
      });
      await writeFile(foreign, "another owner's content");
      await publishViews(world.home, publication.bundle.project, async () => publication);
      for (const file of stale)
        await expect(stat(join(directory, file))).rejects.toHaveProperty("code", "ENOENT");
      expect(await readFile(join(directory, "pr-acme%2Fapp-4.json"), "utf8")).toBe(
        "previous content",
      );
      expect(await readFile(foreign, "utf8")).toBe("another owner's content");
      expect(await readFile(join(directory, "notes.json"), "utf8")).toBe("previous content");
      expect(await readFile(join(directory, "task-write.json.tmp"), "utf8")).toBe(
        "previous content",
      );
      // When the entities disappear, even the last good cached detail goes away.
      await publishViews(world.home, world.repoPath, async () => ({
        bundle: { ...publication.bundle, tasks: {}, briefs: {}, pullRequests: {} },
        details: [],
        retainedDetailFiles: [],
      }));
      expect((await readdir(directory)).toSorted()).toEqual(
        ["index.json", "notes.json", "task-write.json.tmp"].toSorted(),
      );
      expect(await readFile(foreign, "utf8")).toBe("another owner's content");
    } finally {
      await reader.settle();
    }
  });
});

test("panel bell reads successful native deliveries and ignores coordinator acknowledgement", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    const task = await seedScenarioTask(world, { kind: "implementation", stage: "implementing" });
    const terminal = {
      ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
      notify: async () => {},
    };
    const deps = { home: world.home, clock: world.clock, run: world.run, terminal };
    const alerts = new NativeAlerts(deps);
    const reader = new NativeViewsReader(deps);
    const snapshot = {
      version: 1 as const,
      writtenAt: world.clock(),
      coordinators: [],
      board: boardView(state({ projects: [world.repoPath] }), world.clock()),
    };
    await alerts.observe(snapshot, world.repoPath, world.sessionId);
    const updated = await world.store.update(task.id, task.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      communication: {
        revision: 0,
        messages: [],
        question: { id: "decision", text: "Approve scope?" },
      },
      notifications: [{ id: "coordinator-backlog", message: "worker report", acknowledged: false }],
    }));
    expect((await reader.read(snapshot, world.repoPath)).bundle.panel.header.bellCount).toBe(0);
    await alerts.observe(snapshot, world.repoPath, world.sessionId);
    expect((await reader.read(snapshot, world.repoPath)).bundle.panel.header.bellCount).toBe(1);
    await world.store.update(task.id, updated.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      notifications: current.notifications.map((notification) => ({
        ...notification,
        acknowledged: true,
      })),
    }));
    expect((await reader.read(snapshot, world.repoPath)).bundle.panel.header.bellCount).toBe(1);
    await markNativeAlertsRead(world.home, world.repoPath, 1);
    expect((await reader.read(snapshot, world.repoPath)).bundle.panel.header.bellCount).toBe(0);
    await reader.settle();
  });
});

test("a state written before the summary lost its terminal tag publishes again and keeps its cursors", async () => {
  await withScenario({}, async (world) => {
    const reader = new NativeViewsReader({
      home: world.home,
      clock: world.clock,
      run: world.run,
      terminal: terminalBackend(world.run),
    });
    const snapshot = {
      version: 1 as const,
      writtenAt: world.clock(),
      board: boardView(state({ projects: [world.repoPath] }), world.clock()),
      coordinators: [],
    };
    const publish = () =>
      publishViews(world.home, world.repoPath, () => reader.read(snapshot, world.repoPath));
    await publish();
    const path = join(projectStoreDirectory(world.home, world.repoPath), "state.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    const alerts = { cursors: {}, drafts: {}, rows: [], routing: [], delivered: 3, read: 1 };
    const visit = { lastOpenedAt: world.clock() };
    await writeFile(
      path,
      JSON.stringify({
        ...saved,
        alerts,
        visit,
        published: {
          ...saved.published,
          summary: { terminal: "tern", ...saved.published.summary },
        },
      }),
    );
    expect(await readPublished(world.home, world.repoPath)).toBeUndefined();
    await publish();
    const republished = await savedState(world.home, world.repoPath);
    if (republished === undefined) throw new Error("Republication left no project state");
    expect(republished).toMatchObject({ epoch: saved.epoch, alerts, visit });
    expect(republished.seq).toBeGreaterThan(saved.seq);
    expect((await readPublished(world.home, world.repoPath))?.summary).toEqual(
      saved.published.summary,
    );
    const index = ViewFile.parse(
      JSON.parse(await readFile(viewIndexPath(world.home, world.repoPath), "utf8")),
    );
    expect(index.seq).toBe(republished.seq);
    await reader.settle();
  });
});
