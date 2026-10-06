import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { saveCoordinatorRecord } from "../../src/coordinator/registry.ts";
import { DEFAULT_HARNESS } from "../../src/harness/contract.ts";
import { createRequestBriefStore } from "../../src/requests/store.ts";
import { RequestBriefWorkflow } from "../../src/requests/workflow.ts";
import { terminalBackend } from "../../src/terminal-backend/compose.ts";
import type { TerminalBackend } from "../../src/terminal-backend/contract.ts";
import { content } from "../board/fixtures.ts";
import { type ScenarioWorld, withScenario } from "../evals/scenario.ts";

async function fixture(world: ScenarioWorld, terminal: TerminalBackend) {
  const coordinator = {
    ...world.openPane({ paneId: "2001", cwd: world.repoPath }),
    terminalSessionId: "100",
    role: "coordinator" as const,
  };
  const worktree = await world.grantLease({ name: "coordinator", holder: "coordinator" });
  await saveCoordinatorRecord(world.home, {
    schemaVersion: 1,
    repoPath: world.repoPath,
    endpoint: coordinator,
    worktree,
    harness: DEFAULT_HARNESS,
    command: ["omp"],
  });
  const workflow = new RequestBriefWorkflow({
    home: world.home,
    sessionId: world.sessionId,
    parentWorkspaceId: coordinator.workspaceId,
    coordinatorPaneId: coordinator.paneId,
    terminal,
    clock: world.clock,
    store: createRequestBriefStore({
      home: world.home,
      clock: world.clock,
      idFactory: () => "req-native",
    }),
    listTasks: async () => [],
    pauseTask: async () => {
      throw new Error("No task to pause");
    },
    checkLanguage: async () => [],
  });
  return { workflow, coordinator, worktree };
}

for (const action of ["approve", "request-changes", "abandon"] as const) {
  test(`automatic Tern brief projection binds revisions and retires its native split on ${action}`, async () => {
    await withScenario({ terminal: "tern" }, async (world) => {
      const opens: Parameters<TerminalBackend["openView"]>[0][] = [];
      const closes: Parameters<TerminalBackend["closeView"]>[0][] = [];
      const terminal: TerminalBackend = {
        ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
        openView: async (input) => {
          opens.push(input);
          return { opened: true, warnings: [], endpoint: { ...input.coordinator, paneId: "3001" } };
        },
        closeView: async (input) => {
          closes.push(input);
          return { closed: true, warnings: [] };
        },
      };
      const { workflow, coordinator, worktree } = await fixture(world, terminal);
      const first = await workflow.draft({
        repoPath: world.repoPath,
        content: content("Let users review their brief in Tern"),
        reviewPane: true,
      });
      const next = await workflow.draft({
        repoPath: world.repoPath,
        requestId: first.record.id,
        content: content("Let users review their updated brief in Tern"),
        reviewPane: true,
      });
      expect(next.record.draft.revision).toBe(2);
      expect(next.record.reviewPane?.endpoint.paneId).toBe(
        first.record.reviewPane?.endpoint.paneId,
      );
      expect(next.record.reviewPane?.renderedRevision).toBe(2);
      const file = JSON.parse(await readFile(next.record.reviewPane?.renderedPath ?? "", "utf8"));
      expect(file).toMatchObject({
        version: 1,
        kind: "brief",
        model: {
          revision: 2,
          approval: {
            briefRevision: 2,
            contentDigest: next.record.draft.contentDigest,
            agreementDigest: next.record.draft.agreementDigest,
          },
        },
      });
      expect(opens).toHaveLength(2);
      expect(opens[0]).toEqual({
        coordinator,
        cwd: worktree.path,
        home: world.home,
        view: { kind: "brief", requestId: first.record.id },
        origin: { paneId: coordinator.paneId, cwd: worktree.path },
      });
      const stale = await workflow.closeReview(first.record.id, 1);
      expect(stale.record.reviewPane?.status).toBe("open");
      expect(closes).toHaveLength(0);
      const finished =
        action === "approve"
          ? await workflow.approve({
              requestId: next.record.id,
              briefRevision: 2,
              contentDigest: next.record.draft.contentDigest,
              agreementDigest: next.record.draft.agreementDigest,
            })
          : action === "abandon"
            ? await workflow.abandon(next.record.id)
            : await workflow.closeReview(next.record.id, 2);
      expect(finished.record.reviewPane?.status).toBe("closed");
      expect(closes).toEqual([
        {
          coordinator,
          cwd: worktree.path,
          home: world.home,
          view: { kind: "brief", requestId: next.record.id },
          origin: { paneId: "3001" },
        },
      ]);
      expect(
        world.trace().filter((each) => each.boundary === "tern" || each.boundary === "herdr"),
      ).toEqual([]);
    });
  });
}

test("Herdr workflow keeps projecting through the legacy shell pane", async () => {
  await withScenario({}, async (world) => {
    const { workflow } = await fixture(world, {
      ...terminalBackend(world.run),
      openView: async () => {
        throw new Error("Herdr must not open native views");
      },
      closeView: async () => {
        throw new Error("Herdr must not close native views");
      },
    });
    const drafted = await workflow.draft({
      repoPath: world.repoPath,
      content: content("Let users review their brief in Tern"),
      reviewPane: true,
    });
    expect(drafted.record.reviewPane?.status).toBe("open");
    expect(drafted.record.reviewPane?.renderedPath).toEndWith("req-native.md");
    expect(world.trace().some((each) => each.action === "herdr pane run")).toBe(true);
  });
});

test("uncertain native close preserves approval and quarantines the projection without retry", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    let opens = 0;
    let closes = 0;
    const { workflow } = await fixture(world, {
      ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
      openView: async (input) => {
        opens++;
        return { opened: true, warnings: [], endpoint: { ...input.coordinator, paneId: "3001" } };
      },
      closeView: async () => {
        closes++;
        throw new Error("close outcome unknown; quarantine");
      },
    });
    const drafted = await workflow.draft({
      repoPath: world.repoPath,
      content: content("Let users review their brief in Tern"),
      reviewPane: true,
    });
    const approved = await workflow.approve({
      requestId: drafted.record.id,
      briefRevision: 1,
      contentDigest: drafted.record.draft.contentDigest,
    });
    expect(approved.approvalState).toBe("current");
    expect(approved.record.reviewPane?.status).toBe("quarantined");
    await workflow.review(drafted.record.id);
    await workflow.closeReview(drafted.record.id, 1);
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });
});

test("an unknown native opening propagates once and leaves the exact draft durable", async () => {
  await withScenario({ terminal: "tern" }, async (world) => {
    let opens = 0;
    const { workflow } = await fixture(world, {
      ...terminalBackend(world.run, { terminal: "tern", home: world.home }),
      openView: async () => {
        opens++;
        throw new Error("open outcome unknown; quarantine and keep resources");
      },
    });
    await expect(
      workflow.draft({
        repoPath: world.repoPath,
        content: content("Let users review their brief in Tern"),
        reviewPane: true,
      }),
    ).rejects.toThrow("quarantine");
    expect(opens).toBe(1);
    expect((await workflow.read("req-native")).record.draft.revision).toBe(1);
    expect(
      world.trace().filter((each) => each.boundary === "tern" || each.boundary === "herdr"),
    ).toEqual([]);
  });
});
