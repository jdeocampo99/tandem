import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeViewsPublisher, NativeViewsReader } from "../../../src/board/native-read.ts";
import { readBoard } from "../../../src/board/read.ts";
import type { BoardSnapshot } from "../../../src/board/snapshot.ts";
import { saveProjectRoots } from "../../../src/config/home-settings.ts";
import { centralConfigPath, onboardRepo } from "../../../src/config/repositories.ts";
import type { CommandRunner, IsoTimestamp, TaskRecord } from "../../../src/contracts.ts";
import { listCoordinatorRecords } from "../../../src/coordinator/registry.ts";
import { publishViews, recordVisit } from "../../../src/native/store.ts";
import { createRequestBriefStore } from "../../../src/requests/store.ts";
import {
  readRuntimeState,
  runtimeFile,
  writeRuntimeState,
} from "../../../src/runtime/persistence.ts";
import { createTandemService } from "../../../src/service/controller.ts";
import { readTaskInbox, taskInboxPath } from "../../../src/tasks/communication-persistence.ts";
import { createTaskStore, type TaskStore } from "../../../src/tasks/store.ts";
import { ternCli } from "../../../src/terminal-backend/tern/cli.ts";

import { content } from "../../board/fixtures.ts";
import { scenarioRuntimeTask } from "../../evals/scenario.ts";
import { policy } from "../../session/fixtures.ts";
import {
  type ControlNode,
  flatten,
  hasClass,
  isolatedRunner,
  resend,
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
    /**
     * Publishes with GitHub answered by `github`. The reader refreshes pull requests in the
     * background and shows them from its next read, so this reads twice like two coordinator ticks.
     */
    publishWithGithub: (github: CommandRunner) => Promise<void>;
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
  const tick = async () => {
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
    const sessions = new Map(
      records.map((record) => [record.repoPath, record.endpoint.sessionId] as const),
    );
    return { snapshot, project: coordinator.repo, sessions };
  };
  return {
    ...coordinator,
    home: window.home,
    store,
    publish: async () => {
      const publisher = new NativeViewsPublisher({
        home: window.home,
        clock,
        run,
        terminal: window.terminal,
      });
      publisher.schedule(await tick());
      await publisher.settle();
    },
    publishWithGithub: async (github) => {
      const reader = new NativeViewsReader({
        home: window.home,
        clock,
        run: github,
        terminal: window.terminal,
      });
      const first = await tick();
      await reader.read(first.snapshot, first.project, first.sessions);
      await reader.settle();
      const next = await tick();
      await publishViews(window.home, next.project, () =>
        reader.read(next.snapshot, next.project, next.sessions),
      );
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

type Block = Readonly<{ tab: string; id: string; program?: string | undefined; cwd: string }>;

async function blocks(window: TernWindow): Promise<readonly Block[]> {
  const listing = await ternCli(window.run, { binary: window.binary }).ls(window.root);
  return listing.sessions.flatMap((session) =>
    session.tabs.flatMap((tab) =>
      tab.blocks.map((block) => ({
        tab: tab.id,
        id: block.id,
        program: block.program,
        cwd: block.cwd,
      })),
    ),
  );
}

/** The tab of every open native brief pane. */
async function briefTabs(window: TernWindow): Promise<readonly string[]> {
  return (await blocks(window))
    .filter((block) => block.program === "tandem.brief")
    .map((block) => block.tab);
}

/** Sends until `done` (see `resend`), then waits for it with labelled evidence. */
async function sendUntil(
  window: TernWindow,
  label: string,
  send: () => Promise<unknown>,
  done: () => Promise<boolean>,
): Promise<void> {
  await resend(send, done);
  await window.until(label, done);
}

/** Clicks the control showing `text` unless an earlier click already took it off the screen. */
async function clickIfShown(window: TernWindow, text: string): Promise<void> {
  const node = (await window.nodes()).find(
    (candidate) => candidate.text === text && candidate.rect,
  );
  if (node !== undefined) await window.click(node);
}

/**
 * Waits for the full-window view `program` showing `heading`, presses Esc in it, and waits until
 * it is gone and the conversation has focus again.
 */
async function escapeFullWindowView(
  window: TernWindow,
  project: Project,
  program: string,
  heading: string,
  shot: string,
  open: () => Promise<unknown>,
): Promise<void> {
  let pane: string | undefined;
  await sendUntil(window, `${program} open`, open, async () => {
    pane = (await blocks(window)).find((block) => block.program === program)?.id;
    return pane !== undefined && (await window.screen()).includes(heading);
  });
  await window.until(`${program} focused`, async () => (await window.focusedPane()) === pane);
  await window.shot(shot);
  const shown = async () => (await blocks(window)).some((block) => block.id === pane);
  await sendUntil(
    window,
    `${program} closed by Esc`,
    () => window.ctl("key", "escape"),
    async () => !(await shown()),
  );
  await window.until(
    `conversation focused after ${program}`,
    async () => (await window.focusedPane()) === project.endpoint.paneId,
  );
}

async function firstBriefLine(window: TernWindow): Promise<ControlNode | undefined> {
  return (await window.nodes()).find(
    (node) => hasClass(node, "brief-row") && !hasClass(node, "brief-heading"),
  );
}

/** Hovers a diff-style row so its gutter + appears, types `text` into the line editor and saves it. */
async function commentOnLine(
  window: TernWindow,
  row: ControlNode | undefined,
  placeholder: string,
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
  await window.typeInto(placeholder, text);
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

      await sendUntil(
        window,
        "task page opened by click",
        () => clickIfShown(window, "Tern backend adapter"),
        async () => (await window.screen()).includes("task #adapter"),
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

      await sendUntil(
        window,
        "conversation focused after ← Orchestrator",
        () => clickIfShown(window, "← Orchestrator"),
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
      await sendUntil(
        window,
        "conversation focused after the keyboard-opened task",
        () => clickIfShown(window, "← Orchestrator"),
        async () => (await window.focusedPane()) === project.endpoint.paneId,
      );
      await window.until(
        "keyboard-opened task page closed after ← Orchestrator",
        async () => !(await window.screen()).includes("task #width"),
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
      await sendUntil(
        window,
        "stuck banner",
        () => clickIfShown(window, "Close guard"),
        async () => (await window.screen()).includes(reason),
      );
      const banner = await window.nodes();
      expect(banner.some((node) => node.text === "Stuck")).toBe(true);
      expect(banner.some((node) => node.text === "Restart")).toBe(true);
      await window.shot("02-stuck-banner");

      const steer = "Match the exact pane id before closing.";
      await sendUntil(
        window,
        "steer text in the message box",
        async () => {
          await window.click("Steer…");
          await window.ctl("type", JSON.stringify(steer));
        },
        async () => (await window.screen()).includes(steer),
      );
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

        await sendUntil(
          window,
          "brief pane at revision 1",
          () => clickIfShown(window, goal),
          async () => (await window.screen()).includes("Brief · Request brief · rev 1 ·"),
        );
        expect(await briefTabs(window)).toEqual([project.endpoint.workspaceId]);
        await window.shot("03-brief-open");

        const lineNote = "Name the settings page in the scope.";
        await commentOnLine(
          window,
          await firstBriefLine(window),
          "Comment on this line…",
          lineNote,
        );
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
          )
            .split("\n")
            .includes(lineNote),
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
        await commentOnLine(
          window,
          await firstBriefLine(window),
          "Comment on this line…",
          "Pending on revision 2.",
        );
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

const PR_HEAD = "4f1c2a9e";
const PR_PATCH = `diff --git a/src/panel.ts b/src/panel.ts
--- a/src/panel.ts
+++ b/src/panel.ts
@@ -1,2 +1,3 @@
 export const width = 40;
-export const height = 10;
+export const height = 12;
+export const gap = 2;
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # tandem
+Tern support.
`;

/** Answers the GitHub CLI calls of the native PR cache with one open PR; everything else goes to `fallback`. */
function githubWithOnePr(fallback: CommandRunner): CommandRunner {
  const answer = (value: unknown) => ({
    code: 0,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: "",
  });
  const view = {
    number: 42,
    title: "Fix panel width",
    url: "https://github.com/acme/tandem/pull/42",
    headRefOid: PR_HEAD,
    isDraft: false,
    body: "Widens the panel so long task titles fit.",
    commits: [{ oid: PR_HEAD }],
    additions: 3,
    deletions: 1,
    statusCheckRollup: [
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", completedAt: clock() },
      { name: "unit", status: "IN_PROGRESS", startedAt: clock() },
      {
        name: "e2e",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/acme/tandem/actions/runs/1",
      },
    ],
    comments: [],
    reviews: [],
  };
  return async (request) => {
    const [program, group, verb] = request.argv;
    if (program !== "gh") return fallback(request);
    if (group === "api" && verb === "graphql")
      return answer({
        data: {
          repository: {
            pullRequest: {
              headRefOid: PR_HEAD,
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      });
    if (group === "pr" && verb === "diff") return answer(PR_PATCH);
    if (group === "pr" && verb === "view")
      return answer(request.argv.at(-1) === "headRefOid" ? { headRefOid: PR_HEAD } : view);
    return fallback(request);
  };
}

workflow(
  "PR pane: ⎇ opens the task's PR with its tabs, CI pills and file switcher, and a line comment reaches the worker as a fix request",
  async () => {
    await withTernWindow({ name: "wf-pr", driver }, async (window) => {
      const project = await seedProject(window, "tandem");
      await seedTask(project, {
        id: "width",
        title: "Panel width fix",
        stage: "implementing",
        pullRequest: {
          repository: "acme/tandem",
          number: 42,
          url: "https://github.com/acme/tandem/pull/42",
          title: "Fix panel width",
          state: "open",
          head: PR_HEAD,
          base: "main",
        },
      });
      await project.publishWithGithub(
        githubWithOnePr(isolatedRunner(window.run, join(window.root, "publisher.log"))),
      );
      await project.panel();
      await window.until("panel row", async () =>
        (await window.screen()).includes("Panel width fix"),
      );
      await sendUntil(
        window,
        "PR pane",
        () => clickIfShown(window, "⎇"),
        async () => (await window.screen()).includes("#42 Fix panel width"),
      );
      const header = await window.nodes();
      expect(header.some((node) => node.text?.startsWith("✓ lint") === true)).toBe(true);
      expect(header.some((node) => node.text === "✗ e2e")).toBe(true);
      expect(header.some((node) => node.text === "view log")).toBe(true);
      expect(await window.screen()).toContain("unit · running");
      expect(header.some((node) => node.text === "task width ↗")).toBe(true);
      await window.shot("04-pr-pane");

      await window.click("Description");
      await window.until("Description tab", async () =>
        (await window.screen()).includes("Widens the panel so long task titles fit."),
      );
      await window.shot("04-pr-description");
      await window.click("Diff");
      await window.until("Diff tab on the first file", async () =>
        (await window.screen()).includes("+2 −1 · src/panel.ts"),
      );
      await window.click("README.md");
      await window.until("file switcher shows README.md", async () =>
        (await window.screen()).includes("+1 −0 · README.md"),
      );
      await window.shot("04-pr-diff-readme");
      await window.click("src/panel.ts");
      await window.until("file switcher shows src/panel.ts", async () =>
        (await window.screen()).includes("+2 −1 · src/panel.ts"),
      );

      const note = "Keep the gap at 4 so rows breathe.";
      const row = (await window.nodes()).find(
        (node) =>
          hasClass(node, "tdm-diff-row") &&
          flatten(node.children ?? []).some((child) => child.text === "export const gap = 2;"),
      );
      await commentOnLine(window, row, "Comment…", note);
      await window.until("comment sent to the worker", async () =>
        (await window.screen()).includes("you · sent to worker"),
      );
      await window.until("fix request in the worker inbox", async () => {
        const inbox = await readTaskInbox(taskInboxPath(window.home, "width"));
        return (
          inbox?.messages.some(
            (message) =>
              message.text ===
              `PR fix request: src/panel.ts:3: ${note} This task's pull request is already open. If you change code, commit it before you submit; Tandem pushes the branch to the pull request, so don't push it yourself.`,
          ) === true
        );
      });
      await window.shot("04-pr-line-comment");
    });
  },
  120_000,
);

workflow(
  "board, usage and catch-up: shortcuts and panel buttons open them, catch-up greets a return after an hour away, and Esc returns to the conversation",
  async () => {
    await withTernWindow({ name: "wf-screens", driver }, async (window) => {
      const project = await seedProject(window, "tandem");
      await seedTask(project, { id: "width", title: "Panel width fix", stage: "implementing" });
      await project.publish();
      await project.panel();
      await window.until("panel row", async () =>
        (await window.screen()).includes("Panel width fix"),
      );
      const focusConversation = async () => {
        await window.tern("focus", project.endpoint.paneId, "--json");
        await window.until(
          "conversation focused",
          async () => (await window.focusedPane()) === project.endpoint.paneId,
        );
      };

      await focusConversation();
      await escapeFullWindowView(
        window,
        project,
        "tandem.board",
        "Board · tandem",
        "05-board-key",
        () => window.ctl("key", "cmd+shift+b"),
      );
      await escapeFullWindowView(
        window,
        project,
        "tandem.usage",
        "Usage · tandem",
        "05-usage-key",
        () => window.ctl("key", "cmd+shift+u"),
      );
      await escapeFullWindowView(
        window,
        project,
        "tandem.board",
        "Board · tandem",
        "05-board-button",
        () => clickIfShown(window, "▦"),
      );
      await escapeFullWindowView(
        window,
        project,
        "tandem.usage",
        "Usage · tandem",
        "05-usage-button",
        () => clickIfShown(window, "5h unavailable"),
      );

      // Away from the project in an unrelated shell for two hours while its work changed.
      const log = join(window.root, "driver.log");
      const outside = (await blocks(window)).find((block) => block.cwd === window.root)?.id;
      if (outside === undefined) throw new Error("No shell outside the project");
      await window.tern("focus", outside, "--json");
      await window.until(
        "unrelated shell focused",
        async () => (await window.focusedPane()) === outside,
      );
      // The window reports each focus change to Tandem in turn, and leaving a project records it
      // visible until then. The earlier visit is written once those reports have stopped.
      let reported = await Bun.file(log).text();
      await window.until("project left for the unrelated shell", async () => {
        await Bun.sleep(2_000);
        const latest = await Bun.file(log).text();
        const settled = latest === reported;
        reported = latest;
        return settled;
      });
      await recordVisit(window.home, project.repo, {
        kind: "entry",
        now: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        signature: "before-you-left",
        showCatchUp: async () => {
          throw new Error("The earlier visit cannot show catch-up");
        },
      });
      await focusConversation();
      // Entering the project is the only trigger; the catch-up must appear on its own.
      await escapeFullWindowView(
        window,
        project,
        "tandem.catchup",
        "Since you left",
        "05-catchup",
        async () => {},
      );
    });
  },
  120_000,
);

workflow(
  "two projects: the switcher lists both, choosing one moves to its session, and each project keeps its own alerts",
  async () => {
    await withTernWindow({ name: "wf-projects", driver }, async (window) => {
      const tandem = await seedProject(window, "tandem");
      const site = await seedProject(window, "site");
      await seedTask(tandem, { id: "width", title: "Panel width fix", stage: "implementing" });
      await seedTask(site, { id: "hero", title: "Hero copy", stage: "implementing" });
      const publishBoth = async () => {
        await tandem.publish();
        await site.publish();
      };
      await publishBoth();
      // A brief waiting for approval in tandem is a needs-you event for tandem alone.
      await createRequestBriefStore({
        home: window.home,
        clock,
        idFactory: () => "req-tern-board",
      }).create({ repoPath: tandem.repo, content: content("Show the board in Tern") });
      await publishBoth();
      await site.panel();
      await window.until("site panel", async () => (await window.screen()).includes("Hero copy"));
      await tandem.panel();
      const bell = async (count: number) =>
        (await window.nodes()).some((node) => node.text === `🔔︎ ${count}`);
      await window.until("tandem panel with its alert", async () => {
        const screen = await window.screen();
        return screen.includes("Panel width fix") && (await bell(1));
      });
      expect(await window.screen()).not.toContain("Hero copy");
      await window.shot("06-tandem-alert");

      await publishBoth();
      await window.click((await window.nodes()).find((node) => hasClass(node, "tdp-switch")));
      const projectNames = async () =>
        (await window.nodes())
          .filter((node) => hasClass(node, "tdp-project-name"))
          .flatMap((node) => flatten(node.children ?? []).filter((child) => child.text));
      await window.until("switcher lists both projects", async () => {
        const names = (await projectNames()).map((node) => node.text);
        return names.includes("tandem") && names.includes("site");
      });
      await window.shot("06-switcher");
      await window.click((await projectNames()).find((node) => node.text === "site"));
      await window.until(
        "site conversation focused",
        async () => (await window.focusedPane()) === site.endpoint.paneId,
      );
      await window.until("site panel without tandem's alert", async () => {
        const screen = await window.screen();
        return (
          screen.includes("Hero copy") && !screen.includes("Panel width fix") && (await bell(0))
        );
      });
      await window.shot("06-site");

      await publishBoth();
      await window.ctl("key", "cmd+2");
      await window.until(
        "tandem conversation focused by ⌘2",
        async () => (await window.focusedPane()) === tandem.endpoint.paneId,
      );
      await window.until("tandem panel still has its alert", async () => {
        const screen = await window.screen();
        return screen.includes("Panel width fix") && (await bell(1));
      });
      await window.shot("06-back-to-tandem");
    });
  },
  120_000,
);

workflow(
  "setup block: summary, customize through every step, Start saves the command, then Settings opens",
  async () => {
    await withTernWindow({ name: "wf-setup", driver }, async (window) => {
      const coordinator = await seedCoordinator(window, { name: "tandem", sessionId: SESSION });
      await onboardRepo({ repoPath: coordinator.repo, home: window.home, write: true });
      await saveProjectRoots(window.home, [window.root]);
      const open = async (mode: "setup" | "settings") => {
        const envelope = JSON.stringify({
          v: 1,
          origin: { pane: coordinator.endpoint.paneId, cwd: coordinator.checkout },
          action: { verb: "open", ref: { kind: "setup", mode } },
        });
        const child = Bun.spawn([process.execPath, driver, "native", "act"], {
          cwd: coordinator.repo,
          env: {
            ...window.env,
            TANDEM_SESSION: SESSION,
            TANDEM_WORKFLOW_ROOT: window.root,
          },
          stdin: new Blob([envelope]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        return { code, stdout };
      };

      expect(await open("setup")).toMatchObject({ code: 0 });
      await window.until("setup summary", async () =>
        (await window.screen()).includes("Set up Tandem"),
      );
      expect(await window.screen()).toContain("Needs a validation command");
      await window.shot("setup-summary");

      await sendUntil(
        window,
        "models step",
        () => clickIfShown(window, "Customize"),
        async () =>
          (await window.screen()).includes("Use recommended") ||
          (await window.screen()).includes("Recommended:"),
      );
      await window.shot("setup-models");
      const pick = (await window.nodes()).find((node) => node.text?.endsWith(" ▾") && node.rect);
      await window.click(pick);
      await window.until("model picker", async () =>
        (await window.screen()).includes("Search models"),
      );
      await window.shot("setup-model-picker");
      await window.click(pick);

      await window.click("2. Repositories");
      await window.until("repositories step", async () =>
        (await window.screen()).includes("+ Add validation command"),
      );
      await window.click("+ Add validation command");
      await window.typeInto("Command", "make check");
      await window.shot("setup-repositories");

      await window.click("4. Review");
      await window.until("review", async () =>
        (await window.screen()).includes("Validation: make check"),
      );
      await window.shot("setup-review");
      await window.click("Start");
      await window.until("done", async () => (await window.screen()).includes("You're all set"));
      await window.shot("setup-done");
      const config = await readFile(await centralConfigPath(coordinator.repo, window.home), "utf8");
      expect(config).toContain('validationCommands = ["make check"]');
      await window.until("coordinator told", async () =>
        (await readFile(coordinator.transcript, "utf8")).includes("Setup saved."),
      );

      await window.click("Close");
      expect(await open("settings")).toMatchObject({ code: 0 });
      await window.until("settings", async () =>
        (await window.screen()).includes("All changes saved"),
      );
      await window.shot("settings");
    });
  },
  180_000,
);
