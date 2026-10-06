import { expect, test } from "bun:test";
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
import { readTaskInbox, taskInboxPath } from "../../../src/tasks/communication-persistence.ts";
import { createTaskStore, type TaskStore } from "../../../src/tasks/store.ts";
import { scenarioRuntimeTask } from "../../evals/scenario.ts";
import { policy } from "../../session/fixtures.ts";
import {
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
