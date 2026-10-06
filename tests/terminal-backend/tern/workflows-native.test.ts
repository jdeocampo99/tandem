import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeViewsPublisher } from "../../../src/board/native-publish.ts";
import { readBoard } from "../../../src/board/read.ts";
import type { BoardSnapshot } from "../../../src/board/snapshot.ts";
import { onboardRepo } from "../../../src/config/repositories.ts";
import type { IsoTimestamp, TaskRecord } from "../../../src/contracts.ts";
import { listCoordinatorRecords } from "../../../src/coordinator/registry.ts";
import {
  readRuntimeState,
  runtimeFile,
  writeRuntimeState,
} from "../../../src/runtime/persistence.ts";
import { createTandemService } from "../../../src/service/controller.ts";
import { readTaskInbox, taskInboxPath } from "../../../src/tasks/communication-persistence.ts";
import { createTaskStore, type TaskStore } from "../../../src/tasks/store.ts";
import { ternCommands } from "../../../src/terminal-backend/tern/protocol.ts";
import { content } from "../../board/fixtures.ts";
import { scenarioRuntimeTask } from "../../evals/scenario.ts";
import { policy } from "../../session/fixtures.ts";
import {
  type ControlNode,
  flatten,
  hasClass,
  isolatedRunner,
  type SeededCoordinator,
  seedCoordinator,
  type TernWindow,
  ternNativeEnabled,
  withTernWindow,
} from "./native-window.ts";

const SESSION = "workflow";
const driver = fileURLToPath(new URL("./workflow-driver.ts", import.meta.url));
const clock = (): IsoTimestamp => new Date().toISOString() as IsoTimestamp;
const workflow = ternNativeEnabled ? test : test.skip;

type Project = SeededCoordinator &
  Readonly<{
    home: string;
    store: TaskStore;
    /** The coordinator's own publication: board, task, brief and PR views from durable state. */
    publish: () => Promise<void>;
    panel: () => Promise<string>;
  }>;

async function seedProject(window: TernWindow, name: string): Promise<Project> {
  const coordinator = await seedCoordinator(window, { name, sessionId: SESSION });
  await onboardRepo({ repoPath: coordinator.repo, home: window.home, write: true });
  const store = createTaskStore({
    directory: join(window.home, "tasks"),
    clock,
    idFactory: () => crypto.randomUUID(),
  });
  const run = isolatedRunner(window.run, join(window.root, "publisher.log"));
  return {
    ...coordinator,
    home: window.home,
    store,
    publish: async () => {
      const records = await listCoordinatorRecords(window.home, SESSION);
      const snapshot: BoardSnapshot = {
        version: 1,
        writtenAt: clock(),
        board: await readBoard(window.home, clock),
        coordinators: records.map((record) => ({
          repoPath: record.repoPath,
          project: basename(record.repoPath),
          terminal: record.endpoint.terminal,
          workspaceId: record.endpoint.workspaceId,
          paneId: record.endpoint.paneId,
        })),
      };
      const publisher = new NativeViewsPublisher({
        home: window.home,
        clock,
        run,
        terminal: window.terminal,
      });
      publisher.schedule({
        snapshot,
        project: coordinator.repo,
        sessions: new Map(
          records.map((record) => [
            record.repoPath,
            { terminal: "tern", sessionId: record.endpoint.sessionId },
          ]),
        ),
      });
      await publisher.settle();
    },
    panel: () =>
      window.terminal.openPanel({
        coordinator: coordinator.endpoint,
        cwd: coordinator.checkout,
        project: coordinator.repo,
      }),
  };
}

type SeedTask = Readonly<{
  id: string;
  title: string;
  stage: TaskRecord["stage"];
  previousStage?: TaskRecord["stage"];
  blockReason?: string;
  requestId?: string;
  pullRequest?: TaskRecord["pullRequest"];
}>;

async function seedTask(project: Project, input: SeedTask): Promise<TaskRecord> {
  const created = await project.store.create({
    id: input.id,
    repoPath: project.repo,
    kind: "implementation",
    title: input.title,
    objective: `${input.title}: make the Tern views behave like the spec.`,
    acceptanceCriteria: ["The native view shows the saved state."],
    surfaces: ["tern-plugin"],
    policy,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
  const saved = await project.store.update(created.id, created.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    scopeApproved: true,
    stage: input.stage,
    ...(input.previousStage === undefined ? {} : { previousStage: input.previousStage }),
    ...(input.blockReason === undefined ? {} : { blockReason: input.blockReason }),
    ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
  }));
  const path = runtimeFile(project.home);
  const runtime = await readRuntimeState(path);
  await writeRuntimeState(path, {
    ...runtime,
    tasks: [...runtime.tasks, scenarioRuntimeTask({ taskId: input.id, taskName: input.id })],
  });
  return saved;
}

async function selectTab(window: TernWindow, tab: string): Promise<void> {
  const tabs = (await window.nodes()).find((node) => hasClass(node, "tt-tabs"));
  await window.click(flatten(tabs?.children ?? []).find((node) => node.text === tab));
  await window.until(`${tab} tab selected`, async () => {
    const current = (await window.nodes()).find((node) => hasClass(node, "tt-tabs"));
    return flatten(current?.children ?? []).some(
      (node) => node.text === tab && hasClass(node, "tt-primary"),
    );
  });
}

/** The tab of every open native brief pane. */
async function briefTabs(window: TernWindow): Promise<readonly string[]> {
  const listing = await ternCommands(window.run, { binary: window.binary }).ls(window.root);
  return listing.sessions.flatMap((session) =>
    session.tabs.flatMap((tab) =>
      tab.blocks.filter((block) => block.program === "tandem.brief").map(() => tab.id),
    ),
  );
}

async function firstBriefLine(window: TernWindow): Promise<ControlNode | undefined> {
  return (await window.nodes()).find(
    (node) => hasClass(node, "brief-row") && !hasClass(node, "brief-heading"),
  );
}

/** Hovers a diff-style row so its gutter + appears, opens the line editor and saves `text`. */
async function commentOnLine(
  window: TernWindow,
  row: ControlNode | undefined,
  text: string,
): Promise<void> {
  const gutter = flatten(row?.children ?? []).find((node) => node.text === "+" && node.rect);
  const [x = 0, y = 0, width = 0, height = 0] = gutter?.rect ?? [];
  if (gutter === undefined) throw new Error("Row has no comment gutter");
  await window.ctl("move", String(x + width / 2), String(y + height / 2));
  await window.until("line comment editor", async () => {
    const plus = (await window.nodes()).find(
      (node) => hasClass(node, "tdm-plus") && Math.abs((node.rect?.[1] ?? -1) - y) < height,
    );
    await window.click(plus);
    return (await window.nodes()).some((node) => node.text === "Comment");
  });
  await window.typeInto("Comment on this line…", text);
  await window.click("Comment");
}

workflow(
  "panel to task and back: a row opens the task page by click and by keyboard, every tab draws, and ← Orchestrator returns focus to the conversation",
  async () => {
    await withTernWindow({ name: "wf-panel-task", driver }, async (window) => {
      const project = await seedProject(window, "tandem");
      await seedTask(project, {
        id: "adapter",
        title: "Tern backend adapter",
        stage: "implementing",
      });
      await seedTask(project, { id: "width", title: "Panel width fix", stage: "implementing" });
      await project.publish();
      const panel = await project.panel();
      await window.until("panel rows", async () => {
        const screen = await window.screen();
        return screen.includes("Tern backend adapter") && screen.includes("Panel width fix");
      });
      expect(await window.screen()).toContain("Running · 2");
      await window.shot("01-panel-rows");

      await window.click("Tern backend adapter");
      await window.until("task page opened by click", async () =>
        (await window.screen()).includes("task #adapter"),
      );
      const page = await window.screen();
      expect(page).toContain("Tern backend adapter");
      expect(page).toContain("Right now");
      expect(page).toContain("Agent progress");
      await window.shot("01-task-page");
      for (const [tab, body] of [
        ["Brief", "No brief is linked to this task yet."],
        ["Progress", "Timeline"],
        ["Diff", "No pull request is available yet."],
        ["PR", "No pull request is available yet."],
        ["Cost", "Usage receipt unavailable. No recorded task usage yet."],
        ["Overview", "Summary"],
      ] as const) {
        await selectTab(window, tab);
        await window.until(`${tab} tab body`, async () => (await window.screen()).includes(body));
        await window.shot(`01-task-tab-${tab.toLowerCase()}`);
      }

      await window.click("← Orchestrator");
      await window.until(
        "conversation focused after ← Orchestrator",
        async () => (await window.focusedPane()) === project.endpoint.paneId,
      );
      await window.until(
        "task page closed after ← Orchestrator",
        async () => !(await window.screen()).includes("task #adapter"),
      );
      await window.shot("01-back-to-conversation");

      await window.tern("focus", panel, "--json");
      await window.until("panel focused", async () => (await window.focusedPane()) === panel);
      const selected = async () =>
        flatten(
          (await window.nodes()).find((node) => hasClass(node, "tdp-selected"))?.children ?? [],
        ).some((node) => node.text === "Panel width fix");
      // j is idempotent on the last row, so it repeats until the block has keyboard focus.
      await window.until("j selects the second row", async () => {
        await window.ctl("key", "j");
        return selected();
      });
      await window.shot("01-panel-keyboard-selection");
      await window.ctl("key", "enter");
      await window.until("task page opened by keyboard", async () =>
        (await window.screen()).includes("task #width"),
      );
      await window.shot("01-task-page-by-keyboard");
      await window.click("← Orchestrator");
      await window.until(
        "conversation focused after the keyboard-opened task",
        async () => (await window.focusedPane()) === project.endpoint.paneId,
      );
    });
  },
  120_000,
);

workflow(
  "stuck task: the banner shows the reason, Steer… reaches the worker inbox, and Restart clears the banner on republish",
  async () => {
    await withTernWindow({ name: "wf-stuck", driver }, async (window) => {
      const project = await seedProject(window, "tandem");
      const reason = "Setup failed twice before a worktree was free, so Tandem stopped retrying.";
      await seedTask(project, {
        id: "guard",
        title: "Close guard",
        stage: "blocked",
        previousStage: "queued",
        blockReason: reason,
      });
      await project.publish();
      await project.panel();
      await window.until("stuck row", async () => (await window.screen()).includes("Close guard"));
      await window.click("Close guard");
      await window.until("stuck banner", async () => (await window.screen()).includes(reason));
      const banner = await window.nodes();
      expect(banner.some((node) => node.text === "Stuck")).toBe(true);
      expect(banner.some((node) => node.text === "Restart")).toBe(true);
      await window.shot("02-stuck-banner");

      const steer = "Match the exact pane id before closing.";
      await window.typeInto("Steer…", steer);
      await window.ctl("key", "enter");
      await window.until("steer message in the worker inbox", async () => {
        const inbox = await readTaskInbox(taskInboxPath(window.home, "guard"));
        return inbox?.messages.some((message) => message.text === steer) === true;
      });
      await window.shot("02-steered");

      await window.click("Restart");
      await window.until(
        "restart left the stuck stage",
        async () => (await project.store.read("guard"))?.stage !== "blocked",
      );
      await project.publish();
      await window.until("banner cleared", async () => {
        const nodes = await window.nodes();
        return (
          nodes.some((node) => node.text === "task #guard") &&
          !nodes.some((node) => hasClass(node, "tt-stuck"))
        );
      });
      const page = await window.nodes();
      expect(page.some((node) => node.text === "Restart" || node.text === "Stuck")).toBe(false);
      expect(page.some((node) => node.text === "▸ waiting for a free worktree")).toBe(true);
      await window.shot("02-restarted");
    });
  },
  120_000,
);

workflow(
  "brief review: the brief opens beside the conversation, Request changes delivers line feedback and closes it, a stale approval is refused, and Approve records the shown revision",
  async () => {
    await withTernWindow({ name: "wf-brief", driver }, async (window) => {
      const project = await seedProject(window, "tandem");
      await writeFile(join(window.home, "settings.toml"), 'terminal = "tern"\n');
      const service = createTandemService({
        home: window.home,
        sessionId: SESSION,
        parentWorkspaceId: project.endpoint.workspaceId,
        coordinatorPaneId: project.endpoint.paneId,
        run: isolatedRunner(window.run, join(window.root, "service.log")),
        clock,
      });
      try {
        const goal = "Show the board in Tern";
        const draft = (scope: readonly string[]) => ({ ...content(goal), scope: [...scope] });
        const { record } = await service.draftRequestBrief({
          repoPath: project.repo,
          content: draft(["the settings page"]),
          reviewPane: false,
        });
        await project.publish();
        await project.panel();
        await window.until("brief row in Needs you", async () =>
          (await window.screen()).includes("brief waiting for approval"),
        );
        await window.shot("03-panel-brief-row");

        await window.click(goal);
        await window.until("brief pane at revision 1", async () =>
          (await window.screen()).includes("Brief · Request brief · rev 1 ·"),
        );
        expect(await briefTabs(window)).toEqual([project.endpoint.workspaceId]);
        await window.shot("03-brief-open");

        const lineNote = "Name the settings page in the scope.";
        await commentOnLine(window, await firstBriefLine(window), lineNote);
        await window.until("pending line comment", async () =>
          (await window.screen()).includes("you · pending"),
        );
        await window.shot("03-brief-line-comment");
        await window.click("Request changes (1)");
        await window.until("feedback in the coordinator conversation", async () =>
          (
            await Bun.file(project.transcript)
              .text()
              .catch(() => "")
          ).includes(lineNote),
        );
        await window.until(
          "brief pane closed after Request changes",
          async () => (await briefTabs(window)).length === 0,
        );
        expect((await service.requestBrief(record.id)).approvalState).toBe("unapproved");
        await window.shot("03-changes-requested");

        await service.draftRequestBrief({
          repoPath: project.repo,
          requestId: record.id,
          content: draft(["the settings page", "the board page"]),
          reviewPane: true,
        });
        await window.until("brief pane at revision 2", async () =>
          (await window.screen()).includes("Brief · Request brief · rev 2 ·"),
        );
        await commentOnLine(window, await firstBriefLine(window), "Pending on revision 2.");
        await window.until("pending comment on revision 2", async () =>
          (await window.screen()).includes("you · pending"),
        );
        await service.draftRequestBrief({
          repoPath: project.repo,
          requestId: record.id,
          content: draft(["the settings page", "the board page", "the usage page"]),
          reviewPane: true,
        });
        await window.until("newer revision notice", async () =>
          (await window.screen()).includes("A newer revision is available."),
        );
        expect(await window.screen()).toContain("Brief · Request brief · rev 2 ·");
        await window.click("Approve");
        await window.until("stale approval refused", async () =>
          (await window.screen()).includes("Tandem couldn't send the brief"),
        );
        const refused = await service.requestBrief(record.id);
        expect(refused.record.approval).toBeUndefined();
        expect(refused.record.draft.revision).toBe(3);
        await window.shot("03-stale-approval-refused");

        await window.click("Discard comments and refresh");
        await window.until("brief pane at revision 3", async () =>
          (await window.screen()).includes("Brief · Request brief · rev 3 ·"),
        );
        await window.click("Approve");
        await window.until(
          "approval recorded",
          async () => (await service.requestBrief(record.id)).approvalState === "current",
        );
        expect((await service.requestBrief(record.id)).record.approval?.briefRevision).toBe(3);
        await window.until(
          "brief pane closed after Approve",
          async () => (await briefTabs(window)).length === 0,
        );
        await window.until("approval announced to the coordinator", async () =>
          (await Bun.file(project.transcript).text()).includes(
            `The user approved brief ${record.id}, revision 3.`,
          ),
        );
        await window.shot("03-approved");
      } finally {
        await service.shutdown();
      }
    });
  },
  120_000,
);
