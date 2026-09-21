import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Endpoint, RequestBriefContent, RequestBriefRecord } from "../../src/contracts.ts";
import { createRequestBriefRecord, withRequestReviewPane } from "../../src/requests/brief.ts";
import {
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
    recommendedApproach: "Render Markdown from the durable record",
    keyDecisions: ["the coordinator owns the pane"],
    openQuestions: [],
    researchLinks: [],
    ...overrides,
  };
}

function dependencies(world: ScenarioWorld): RequestReviewPaneDependencies {
  return {
    run: world.run,
    home: world.home,
    sessionId: world.sessionId,
    parentWorkspaceId: undefined,
    clock: () => NOW,
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
