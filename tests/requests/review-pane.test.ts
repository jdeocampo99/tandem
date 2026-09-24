import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShellCommand } from "../../src/adapters/commands.ts";
import type {
  CommandRequest,
  CommandRunner,
  Endpoint,
  RequestBriefContent,
  RequestBriefRecord,
} from "../../src/contracts.ts";
import { createRequestBriefRecord, withRequestReviewPane } from "../../src/requests/brief.ts";
import {
  briefViewerCommand,
  closeRequestBriefPane,
  projectRequestBriefPane,
  type RequestReviewPaneDependencies,
} from "../../src/requests/review-pane.ts";
import { type ScenarioWorld, withScenario } from "../evals/scenario.ts";

const NOW = "2030-01-01T00:00:00.000Z";

function content(overrides: Partial<RequestBriefContent> = {}): RequestBriefContent {
  return {
    goal: "Show the agreed request in a read-only pane",
    scope: ["src/requests"],
    constraints: ["never close a pane Tandem does not own"],
    nonGoals: ["no editing path in the pane"],
    acceptanceCriteria: ["the pane shows the current draft revision"],
    manualVerification: [],
    recommendedApproach: "Render Markdown from the durable record",
    keyDecisions: ["the coordinator owns the pane"],
    openQuestions: [],
    researchLinks: [],
    ...overrides,
  };
}

function dependencies(
  world: ScenarioWorld,
  coordinatorPaneId?: string,
  run: CommandRunner = world.run,
): RequestReviewPaneDependencies {
  return {
    run,
    home: world.home,
    sessionId: world.sessionId,
    parentWorkspaceId: undefined,
    coordinatorPaneId,
    clock: () => NOW,
  };
}

/** Records the argv of every Herdr command so a test can see which pane each one targeted. */
function recordingRun(world: ScenarioWorld): Readonly<{
  readonly run: CommandRunner;
  readonly herdrCommands: (verb: string) => readonly (readonly string[])[];
}> {
  const calls: CommandRequest[] = [];
  return {
    run: async (request) => {
      calls.push(request);
      return world.run(request);
    },
    herdrCommands: (verb) =>
      calls
        .map((call) => call.argv)
        .filter((argv) => argv[0] === "herdr" && argv[3] === "pane" && argv[4] === verb),
  };
}

function record(
  world: ScenarioWorld,
  overrides: Partial<RequestBriefContent> = {},
): RequestBriefRecord {
  return createRequestBriefRecord(
    { id: "req-1", repoPath: world.repoPath, content: content(overrides) },
    NOW,
  );
}

function workspaceCreateCount(world: ScenarioWorld): number {
  return world.trace().filter((event) => event.action === "herdr workspace create").length;
}

test("the projection opens one owned pane and refreshes it in place for later revisions", async () => {
  await withScenario({}, async (world) => {
    const first = record(world);
    const opened = await projectRequestBriefPane(dependencies(world), first);
    const firstRender = await readFile(opened.renderedPath, "utf8");
    const revised = withRequestReviewPane(
      { ...first, draft: { ...first.draft, revision: 2 } },
      opened,
      NOW,
    );
    const refreshed = await projectRequestBriefPane(dependencies(world), revised);

    expect(opened.status).toBe("open");
    expect(opened.renderedRevision).toBe(1);
    expect(refreshed.status).toBe("open");
    expect(refreshed.renderedRevision).toBe(2);
    expect(refreshed.endpoint.paneId).toBe(opened.endpoint.paneId);
    expect(workspaceCreateCount(world)).toBe(1);

    expect(opened.renderedPath).toBe(join(world.home, "request-briefs", "req-1.md"));
    expect(firstRender).toContain("Draft revision: 1");
    expect(firstRender).toContain("Read-only view.");
    expect(firstRender).toContain("not approved");
    expect(await readFile(opened.renderedPath, "utf8")).toContain("Draft revision: 2");
  });
});

test("a pane whose native identity no longer matches is quarantined and left open", async () => {
  await withScenario({}, async (world) => {
    const opened = await projectRequestBriefPane(dependencies(world), record(world));
    const foreign: Endpoint = { ...opened.endpoint, workspaceId: "someone-elses-workspace" };
    const moved = withRequestReviewPane(record(world), { ...opened, endpoint: foreign }, NOW);

    const projected = await projectRequestBriefPane(dependencies(world), moved);
    const closed = await closeRequestBriefPane(dependencies(world), moved);

    expect(projected.status).toBe("quarantined");
    expect(projected.reason).toContain("native identity");
    expect(closed?.status).toBe("quarantined");
    expect(world.paneIsPresent(opened.endpoint.paneId)).toBe(true);
  });
});

test("approval closes only the owned pane and leaves unrelated panes untouched", async () => {
  await withScenario({}, async (world) => {
    const bystander = world.openPane({ paneId: "pane-bystander", cwd: world.repoPath });
    const opened = await projectRequestBriefPane(dependencies(world), record(world));
    const withPane = withRequestReviewPane(record(world), opened, NOW);

    const closed = await closeRequestBriefPane(dependencies(world), withPane);

    expect(closed?.status).toBe("closed");
    expect(world.paneIsPresent(opened.endpoint.paneId)).toBe(false);
    expect(world.paneIsPresent(bystander.paneId)).toBe(true);
  });
});

test("the brief's own pager is quit before the pane is refreshed or closed", async () => {
  await withScenario({}, async (world) => {
    const recording = recordingRun(world);
    const deps = dependencies(world, undefined, recording.run);
    const first = record(world);
    const opened = await projectRequestBriefPane(deps, first);
    const showPager = () =>
      world.run({
        argv: [
          "herdr",
          "--session",
          world.sessionId,
          "pane",
          "run",
          opened.endpoint.paneId,
          quoteShellCommand(["glow", "-p", "--", opened.renderedPath]),
        ],
        cwd: world.repoPath,
      });

    await showPager();
    const revised = withRequestReviewPane(
      { ...first, draft: { ...first.draft, revision: 2 } },
      opened,
      NOW,
    );
    const refreshed = await projectRequestBriefPane(deps, revised);
    await showPager();
    const closed = await closeRequestBriefPane(
      deps,
      withRequestReviewPane(revised, refreshed, NOW),
    );

    expect(refreshed.status).toBe("open");
    expect(refreshed.renderedRevision).toBe(2);
    expect(closed?.status).toBe("closed");
    expect(world.paneIsPresent(opened.endpoint.paneId)).toBe(false);
    expect(recording.herdrCommands("send-keys").map((argv) => argv.slice(5))).toEqual([
      [opened.endpoint.paneId, "q"],
      [opened.endpoint.paneId, "q"],
    ]);
  });
});

test("a busy pane is retained rather than closed", async () => {
  await withScenario({}, async (world) => {
    const opened = await projectRequestBriefPane(dependencies(world), record(world));
    await world.run({
      argv: [
        "herdr",
        "--session",
        world.sessionId,
        "pane",
        "run",
        opened.endpoint.paneId,
        "'bun' 'worker.ts'",
      ],
      cwd: world.repoPath,
    });

    const closed = await closeRequestBriefPane(
      dependencies(world),
      withRequestReviewPane(record(world), opened, NOW),
    );

    expect(closed?.status).toBe("retained");
    expect(closed?.reason).toContain("foreground process");
    expect(world.paneIsPresent(opened.endpoint.paneId)).toBe(true);
  });
});

test("a pane that is already gone reopens on the next projection and never fails the brief", async () => {
  await withScenario({}, async (world) => {
    const opened = await projectRequestBriefPane(dependencies(world), record(world));
    await world.run({
      argv: ["herdr", "--session", world.sessionId, "pane", "close", opened.endpoint.paneId],
      cwd: world.repoPath,
    });
    const dismissed = withRequestReviewPane(record(world), opened, NOW);

    const settled = await closeRequestBriefPane(dependencies(world), dismissed);
    const reopened = await projectRequestBriefPane(dependencies(world), dismissed);

    expect(settled?.status).toBe("closed");
    expect(settled?.reason).toBe("pane was already gone");
    expect(reopened.status).toBe("open");
    expect(reopened.endpoint.paneId).not.toBe(opened.endpoint.paneId);
    expect(workspaceCreateCount(world)).toBe(2);
  });
});

test("a failed render is reported without losing the durable brief", async () => {
  await withScenario({}, async (world) => {
    world.failAt({ boundary: "herdr", action: "herdr pane run" });

    const projected = await projectRequestBriefPane(dependencies(world), record(world));

    expect(projected.status).toBe("quarantined");
    expect(projected.reason).toContain("could not render revision 1");
    expect(await readFile(projected.renderedPath, "utf8")).toContain("Draft revision: 1");
  });
});

test("with a known coordinator pane the brief opens as a split beside it, not a new workspace", async () => {
  await withScenario({}, async (world) => {
    const coordinator = world.openPane({ paneId: "pane-coordinator", cwd: world.repoPath });
    const recorder = recordingRun(world);

    const opened = await projectRequestBriefPane(
      dependencies(world, coordinator.paneId, recorder.run),
      record(world),
    );

    expect(opened.status).toBe("open");
    expect(workspaceCreateCount(world)).toBe(0);
    expect(recorder.herdrCommands("split")).toEqual([
      [
        "herdr",
        "--session",
        world.sessionId,
        "pane",
        "split",
        coordinator.paneId,
        "--direction",
        "right",
        "--cwd",
        world.repoPath,
        "--no-focus",
      ],
    ]);
    expect(opened.endpoint.workspaceId).toBe(coordinator.workspaceId);
    expect(opened.endpoint.tabId).toBe(coordinator.tabId);
    expect(opened.endpoint.paneId).not.toBe(coordinator.paneId);
    expect(recorder.herdrCommands("run").map((argv) => argv[5])).toEqual([opened.endpoint.paneId]);
  });
});

test("closing a split brief pane closes only that pane and never the coordinator beside it", async () => {
  await withScenario({}, async (world) => {
    const coordinator = world.openPane({ paneId: "pane-coordinator", cwd: world.repoPath });
    const recorder = recordingRun(world);
    const deps = dependencies(world, coordinator.paneId, recorder.run);
    const opened = await projectRequestBriefPane(deps, record(world));

    const closed = await closeRequestBriefPane(
      deps,
      withRequestReviewPane(record(world), opened, NOW),
    );

    expect(closed?.status).toBe("closed");
    expect(world.paneIsPresent(opened.endpoint.paneId)).toBe(false);
    expect(world.paneIsPresent(coordinator.paneId)).toBe(true);
    expect(recorder.herdrCommands("close").map((argv) => argv[5])).toEqual([
      opened.endpoint.paneId,
    ]);
  });
});

test("a brief record naming the coordinator's own pane is quarantined and never written or closed", async () => {
  await withScenario({}, async (world) => {
    const coordinator = world.openPane({ paneId: "pane-coordinator", cwd: world.repoPath });
    const recorder = recordingRun(world);
    const deps = dependencies(world, coordinator.paneId, recorder.run);
    const opened = await projectRequestBriefPane(deps, record(world));
    const pointsAtCoordinator = withRequestReviewPane(
      record(world),
      { ...opened, endpoint: { ...coordinator, role: "coordinator" } },
      NOW,
    );

    const closed = await closeRequestBriefPane(deps, pointsAtCoordinator);
    const projected = await projectRequestBriefPane(deps, pointsAtCoordinator);

    expect(closed?.status).toBe("quarantined");
    expect(closed?.reason).toContain("coordinator's own pane");
    expect(projected.status).toBe("quarantined");
    expect(world.paneIsPresent(coordinator.paneId)).toBe(true);
    expect(recorder.herdrCommands("close")).toEqual([]);
    expect(recorder.herdrCommands("run").map((argv) => argv[5])).not.toContain(coordinator.paneId);
  });
});

test("the pane shows the brief with glow when it is installed, and plain text otherwise", async () => {
  await withScenario({}, async (world) => {
    const recording = recordingRun(world);
    const opened = await projectRequestBriefPane(
      dependencies(world, undefined, recording.run),
      record(world),
    );

    const [paneRun] = recording.herdrCommands("run");
    const viewer = briefViewerCommand(opened.renderedPath);
    expect(viewer).toContain(Bun.which("glow") ?? "cat");
    expect(viewer.at(-1)).toBe(opened.renderedPath);
    expect(paneRun?.at(-1)).toBe(quoteShellCommand(viewer));
  });
});
