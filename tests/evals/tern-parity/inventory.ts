import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type PrReviewRound, prReviewRunDiffPath } from "../../../src/pr-review/state.ts";
import { withPrWatches } from "../../../src/pr-watch/store.ts";
import { reviseRequestBriefRecord } from "../../../src/requests/brief.ts";
import { createRequestBriefStore } from "../../../src/requests/store.ts";
import { nativeReplyLinks } from "../../../src/session/native-links.ts";
import { content } from "../../board/fixtures.ts";
import {
  SCENARIO_POLICY,
  type ScenarioPullRequest,
  type ScenarioTernProject,
  type ScenarioWorld,
  scenarioRuntimeTask,
  seedScenarioRuntime,
  seedScenarioTask,
  seedTernProject,
  withScenario,
} from "../scenario.ts";
import { type Rendered, type Screen, TernParityHost } from "./harness.ts";

export type Parity = Readonly<{
  world: ScenarioWorld;
  host: TernParityHost;
  project: ScenarioTernProject;
  panel: Screen;
  briefId: string;
}>;

export type InventoryEntry = Readonly<{ view: string; item: string; run: () => Promise<void> }>;

const PR_URL = "https://github.com/acme/app/pull/281";
/** The keys Tandem installs into Tern's global settings once the user consents. */
const TERN_KEYBINDS: Readonly<Record<string, string>> = {
  "cmd+shift+b": "plugin.tandem.board",
  "cmd+shift+p": "plugin.tandem.prs",
  "cmd+shift+u": "plugin.tandem.usage",
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      [`cmd+${index + 1}`, `plugin.tandem.project-${index + 1}`],
      [`cmd+digit_${index + 1}`, `plugin.tandem.project-${index + 1}`],
    ]).flat(),
  ),
  "cmd+shift+[": "plugin.tandem.project-prev",
  "cmd+shift+]": "plugin.tandem.project-next",
};
const PATCH = [
  "diff --git a/src/port.ts b/src/port.ts",
  "--- a/src/port.ts",
  "+++ b/src/port.ts",
  "@@ -1,2 +1,3 @@",
  " export function port() {",
  "+  guard();",
  " }",
  "",
].join("\n");

export function briefs(world: ScenarioWorld) {
  return createRequestBriefStore({
    home: world.home,
    clock: world.clock,
    idFactory: world.idFactory,
  });
}

/** A finished pr-review task on someone else's PR #290: one tour chapter, a concern and a draft. */
export async function seedReview(world: ScenarioWorld): Promise<ScenarioPullRequest> {
  const pr = world.github.openPullRequest({
    repo: "acme/app",
    number: 290,
    title: "Add retries",
    body: "Retries flaky calls.",
    patch: PATCH,
  });
  const round: PrReviewRound = {
    generation: 0,
    head: pr.head,
    from: pr.head,
    notes: [],
    review: {
      head: pr.head,
      intent: "Check the retry guard",
      tour: [
        {
          title: "The guard",
          why: "Every call now passes the guard.",
          stops: [{ file: "src/port.ts", from: 2, to: 2, title: "Guard", body: "Runs first." }],
        },
      ],
      concerns: [
        { title: "No backoff", detail: "Retries run back to back.", severity: "suggestion" },
      ],
      comments: [
        { id: "d1", file: "src/port.ts", line: 2, body: "Name the guard.", severity: "nit" },
      ],
      summaryComment: "Looks good overall",
      priorComments: [],
    },
  };
  const created = await world.store.create({
    id: "review-290",
    repoPath: world.repoPath,
    kind: "pr-review",
    objective: "Review #290",
    acceptanceCriteria: [],
    surfaces: [],
    policy: SCENARIO_POLICY,
    prReview: {
      ref: { repo: "acme/app", number: 290 },
      url: "https://github.com/acme/app/pull/290",
      title: "Add retries",
      author: "sam",
      baseRef: "main",
      checkout: world.repoPath,
      remote: "origin",
      lens: { kind: "full" },
      mode: "review",
      rounds: [round],
    },
  });
  await world.store.update(created.id, created.revision, (task) => ({
    ...task,
    revision: task.revision + 1,
    stage: "completed",
  }));
  const diff = prReviewRunDiffPath(world.home, created.id, 0);
  await mkdir(dirname(diff), { recursive: true });
  await writeFile(diff, PATCH);
  return pr;
}

/** A project mid-flight: one task in each panel section, a brief to approve and a watched PR. */
async function seedWork(world: ScenarioWorld): Promise<string> {
  await seedScenarioTask(world, {
    id: "port",
    title: "Port the terminal",
    kind: "implementation",
    stage: "implementing",
  });
  const stuck = await seedScenarioTask(world, {
    id: "login",
    title: "Fix login",
    kind: "implementation",
    stage: "blocked",
    previousStage: "implementing",
  });
  await world.store.update(stuck.id, stuck.revision, (task) => ({
    ...task,
    revision: task.revision + 1,
    blockReason: "worker stopped twice",
  }));
  await seedScenarioTask(world, {
    id: "docs",
    title: "Write docs",
    kind: "implementation",
    stage: "completed",
  });
  const shipped = world.github.openPullRequest({
    repo: "acme/app",
    number: 281,
    title: "Ship the port",
    body: "Ports the terminal backend.",
    patch: PATCH,
    checks: [
      { name: "lint", state: "pass" },
      {
        name: "e2e",
        state: "pending",
        startedAt: new Date(Date.parse(world.clock()) - 90_000).toISOString(),
      },
      { name: "unit", state: "fail" },
    ],
    comments: [{ id: "c1", author: "sam", createdAt: world.clock(), body: "Looks close." }],
    threads: [
      {
        id: "thread-1",
        path: "src/port.ts",
        line: 2,
        side: "RIGHT",
        resolved: false,
        outdated: false,
        comments: [
          {
            id: "n1",
            databaseId: 11,
            author: "jules",
            createdAt: world.clock(),
            body: "Why guard here?",
          },
        ],
      },
    ],
  });
  await seedScenarioTask(world, {
    id: "ship",
    title: "Ship the port",
    kind: "implementation",
    stage: "ready",
    pullRequest: {
      repository: "acme/app",
      number: 281,
      url: PR_URL,
      state: "open",
      head: shipped.head,
      base: "main",
    },
  });
  world.github.openPullRequest({ repo: "acme/app", number: 282, title: "Bump deps", patch: PATCH });
  await withPrWatches(world.home, ({ put }) => {
    put({
      ref: { repo: "acme/app", number: 281 },
      origin: "task",
      taskId: "ship",
      repoPath: world.repoPath,
      startedAt: world.clock(),
      log: [],
    });
    put({
      ref: { repo: "acme/app", number: 282 },
      origin: "user",
      repoPath: world.repoPath,
      startedAt: world.clock(),
      log: [],
      row: { color: "yellow", status: "⏳ checks running", note: "2 checks pending" },
      summary: {
        title: "Bump deps",
        branch: "feature-282",
        url: "https://github.com/acme/app/pull/282",
        checks: { passed: 1, failed: 0, pending: 2 },
      },
    });
  });
  const brief = await briefs(world).create({
    repoPath: world.repoPath,
    content: content("Add dark mode"),
  });
  return brief.id;
}

/** Runs `body` against a seeded project whose panel is open in the Tern window. */
export async function withParity(
  body: (parity: Parity) => Promise<void>,
  options: Readonly<{ seed?: boolean; publish?: boolean }> = {},
): Promise<void> {
  // Switcher staleness and visit gaps read the wall clock, so the scenario clock starts at it.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  await withScenario({ terminal: "tern", now }, async (world) => {
    const project = await seedTernProject(world, { coordinatorPaneId: "101", helperPaneId: "102" });
    const briefId = options.seed === false ? "" : await seedWork(world);
    const host = await TernParityHost.start(world, project);
    try {
      if (options.publish !== false) await host.publish();
      const panel = host.screen(await host.openPanel());
      await body({ world, host, project, panel, briefId });
    } finally {
      await host.close();
    }
  });
}

async function otherProject(parity: Parity, name = "api"): Promise<ScenarioTernProject> {
  const { world, host } = parity;
  const other = await seedTernProject(world, {
    coordinatorPaneId: name === "api" ? "111" : "121",
    helperPaneId: name === "api" ? "112" : "122",
    repoPath: join(dirname(world.repoPath), name),
  });
  await seedScenarioTask(world, {
    id: `${name}-stuck`,
    title: `Unblock ${name}`,
    kind: "implementation",
    stage: "blocked",
    previousStage: "implementing",
    repoPath: other.repoPath,
  });
  await host.publish(other);
  return other;
}

function labels(view: Rendered): readonly string[] {
  return view.actions.map((action) => action.label);
}

function styleOf(view: Rendered, text: string): string {
  const span = view.spans.find((entry) => entry.text === text);
  if (span === undefined) throw new Error(`"${text}" is not drawn`);
  return span.style;
}

function opened(host: TernParityHost, mark: number): readonly string[] {
  return host.since(mark).flatMap((event) => (event.open ? [event.open.url] : []));
}

function traceSince(world: ScenarioWorld, mark: number): readonly string[] {
  return world
    .trace()
    .slice(mark)
    .map((event) => `${event.action} ${event.outcome}`);
}

function blockKinds(world: ScenarioWorld): readonly string[] {
  return world
    .ternBlocks()
    .flatMap((block) => (block.program === undefined ? [] : [block.program]))
    .toSorted();
}

/** Every row of the experience inventory in final.md. Assertions are what the user sees. */
export const inventory: readonly InventoryEntry[] = [
  {
    view: "Panel",
    item: "Header with tandem ▾, other-project count, 5h meter and label, bell count, PRs and Board icons",
    run: () =>
      withParity(async (parity) => {
        const { host, panel, world } = parity;
        await otherProject(parity);
        await host.publish();
        await host.refresh();
        const view = await panel.render();
        expect(view.text.slice(0, 7)).toEqual([
          "tandem ▾",
          "1",
          "5h unavailable",
          "🔔︎ 0",
          "⎇",
          "▦",
          "Needs you · 2",
        ]);
        expect(labels(view).slice(0, 5)).toEqual([
          "tandem ▾ 1",
          "5h unavailable",
          "🔔︎ 0",
          "⎇",
          "▦",
        ]);
        await panel.click("▦");
        expect(host.screen(host.pane("board")).pane).toBeGreaterThan(0);
        await panel.click("5h unavailable");
        expect((await host.screen(host.pane("usage")).render()).text).toContain("Usage · tandem");
        await panel.click("⎇");
        const prs = await host.screen(host.pane("pr")).render();
        expect(prs.title).toBe("#281 ▾");
        expect(blockKinds(world)).toEqual([
          "tandem.board",
          "tandem.panel",
          "tandem.pr",
          "tandem.usage",
        ]);
      }),
  },
  {
    view: "Panel",
    item: "Sections and two-line rows, state colors, PR link in the dim line",
    run: () =>
      withParity(async ({ host, panel }) => {
        const view = await panel.render();
        expect(view.text.slice(5)).toEqual([
          "Needs you · 2",
          "●",
          "Add dark mode",
          "brief to approve",
          "brief waiting for approval",
          "●",
          "Fix login",
          "stuck",
          "0s",
          "worker stopped twice",
          "Running · 1",
          "●",
          "Port the terminal",
          "implementing",
          "0s",
          "for 0s",
          "Ready · 2",
          "●",
          "Ship the port",
          "ready",
          "0s",
          " · waiting for PR watch",
          "#281 ↗",
          "●",
          "#282 feature-282",
          "checks running",
          "2 checks pending",
          "Recently done · 1",
          "●",
          "Write docs",
          "done",
          "0s",
          "done",
        ]);
        expect(styleOf(view, "Needs you · 2")).toContain("tdp-needs");
        const dots = view.spans
          .filter((span) => span.text === "●")
          .map((span) => span.style.split(" ").at(-1));
        expect(dots).toEqual([
          "tdp-yellow",
          "tdp-red",
          "tdp-blue",
          "tdp-green",
          "tdp-yellow",
          "tdp-green",
        ]);
        const mark = host.events.length;
        await panel.click("#281 ↗");
        expect(opened(host, mark)).toEqual([PR_URL]);
      }),
  },
  {
    view: "Panel",
    item: "Enter, click, j/k, arrows, Esc; task, brief and PR targets",
    run: () =>
      withParity(async ({ host, panel }) => {
        const row = async () =>
          (await panel.render()).spans.find(
            (span) => span.style.includes("tdp-selected") && span.style.includes("tdp-name"),
          )?.text;
        expect(await row()).toBe("Add dark mode");
        expect(await panel.press({ name: "j" })).toBe(true);
        expect(await row()).toBe("Fix login");
        await panel.press({ name: "down" });
        expect(await row()).toBe("Port the terminal");
        await panel.press({ name: "k" });
        await panel.press({ name: "up" });
        await panel.press({ name: "up" });
        expect(await row()).toBe("Add dark mode");
        await panel.press({ name: "enter" });
        expect((await host.screen(host.pane("brief")).render()).title).toBe(
          "Brief · Request brief",
        );
        await panel.click(/^● Port the terminal/);
        expect((await host.screen(host.pane("task")).render()).title).toBe("Port the terminal");
        await panel.click(/^● #282 feature-282/);
        expect((await host.screen(host.pane("pr")).render()).title).toBe("#282 ▾");
        await panel.click("tandem ▾");
        expect((await panel.render()).text).toContain("+ Open another project…");
        expect(await panel.press({ name: "escape" })).toBe(true);
        expect((await panel.render()).text).not.toContain("+ Open another project…");
      }),
  },
  {
    view: "Panel",
    item: "Bell opens the inbox and marks alerts read",
    run: () =>
      withParity(async ({ host, panel, world }) => {
        const task = await world.store.read("port");
        if (task === undefined) throw new Error("missing seeded task");
        await world.store.update(task.id, task.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          stage: "blocked",
          previousStage: "implementing",
          blockReason: "tests keep failing",
        }));
        await host.publish();
        await host.refresh();
        expect((await panel.render()).text).toContain("🔔︎ 1");
        const mark = host.events.length;
        await panel.click("🔔︎ 1");
        expect(host.since(mark).flatMap((event) => (event.command ? [event.command] : []))).toEqual(
          ["inbox"],
        );
        expect(await host.unreadAlerts()).toBe(0);
        await host.publish();
        await host.refresh();
        expect((await panel.render()).text).toContain("🔔︎ 0");
      }),
  },
  {
    view: "Panel",
    item: "Loading, unavailable, stale footer; empty sections",
    run: () =>
      withParity(
        async ({ host, panel }) => {
          expect((await panel.render()).text).toEqual(["Waiting for Tandem's project snapshot…"]);
          await host.publish();
          await host.refresh();
          expect((await panel.render()).text).toEqual([
            "tandem ▾",
            "5h unavailable",
            "🔔︎ 0",
            "⎇",
            "▦",
            "Needs you · 0",
            "Running · 0",
            "Ready · 0",
            "Recently done · 0",
          ]);
          await host.corruptPanelView();
          await host.refresh();
          const unavailable = await panel.render();
          expect(unavailable.text).toContain("View unavailable · actions paused");
          const mark = host.cli.length;
          await panel.click("⎇");
          expect(host.cli.length).toBe(mark);
          await host.publish(host.project, { snapshotAgeMinutes: 1 });
          await host.refresh();
          expect((await panel.render()).text.at(-1)).toBe(
            "⚠ updated 1m ago · no coordinator running",
          );
        },
        { seed: false, publish: false },
      ),
  },
  {
    view: "Project switcher",
    item: "Rows with status, needs-you badge, check, ⌘ hint; offline rows inert; Open another project; prev/next hint",
    run: () =>
      withParity(async (parity) => {
        const { host, panel, world } = parity;
        world.advanceClock(-0.25);
        await otherProject(parity, "web");
        world.advanceClock(0.25);
        await otherProject(parity);
        await host.publish();
        await host.refresh();
        await panel.click("tandem ▾ 2");
        const open = await panel.render();
        expect(open.text.slice(0, open.text.indexOf("tandem ▾"))).toEqual([
          " ",
          "api",
          "0 running · 1 needs you",
          "1",
          "⌘1",
          "✓",
          "repo",
          "1 running · 2 needs you",
          "2",
          "⌘2",
          " ",
          "web",
          "offline",
          "1",
          "⌘3",
          "+ Open another project…",
          "⌘⇧[ / ⌘⇧] previous / next project",
        ]);
        expect(labels(open).slice(0, 3)).toEqual([
          "  api 0 running · 1 needs you 1 ⌘1",
          "✓ repo 1 running · 2 needs you 2 ⌘2",
          "+ Open another project…",
        ]);
        world.advanceClock(-0.5);
        await host.publish();
        let mark = host.events.length;
        await panel.click(/ api /);
        expect(host.toasts(mark).map((toast) => toast.message)).toEqual([
          "Project switcher is stale; wait for the coordinator snapshot",
        ]);
        world.advanceClock(0.5);
        await host.publish();
        await host.refresh();
        await panel.click("tandem ▾ 2");
        mark = world.trace().length;
        await panel.click(/ api /);
        expect(traceSince(world, mark)).toContain("tern focus ok");
        expect((await panel.render()).text).not.toContain("+ Open another project…");
        await panel.click("tandem ▾ 2");
        await panel.click("+ Open another project…");
        expect(world.sentKeys()).toEqual([
          { paneId: "101", text: "Help me open another project in Tandem.\r" },
        ]);
      }),
  },
  {
    view: "Keys and palette",
    item: "⌘⇧B, ⌘⇧P, ⌘⇧U, ⌘1–9, ⌘⇧[ ]; five palette commands; project commands hidden",
    run: () =>
      withParity(async (parity) => {
        const { host, world } = parity;
        await otherProject(parity);
        await host.publish();
        await host.refresh();
        const commands = await host.commands();
        expect(
          commands.filter((command) => command.visible).map((command) => command.title),
        ).toEqual([
          "Tandem: New request…",
          "Tandem: Open task…",
          "Tandem: Toggle board",
          "Tandem: Show PRs",
          "Tandem: Usage",
        ]);
        const registered = new Set(commands.map((command) => `plugin.tandem.${command.id}`));
        const bound = [...new Set(Object.values(TERN_KEYBINDS))];
        expect(bound.filter((id) => !registered.has(id))).toEqual([]);
        expect(
          commands.filter((command) => !command.visible).map((command) => command.title),
        ).toEqual([
          ...Array.from({ length: 9 }, (_, index) => `Tandem: Project ${index + 1}`),
          "Tandem: Previous project",
          "Tandem: Next project",
        ]);
        await host.focus(101);
        await host.command("board");
        expect(blockKinds(world)).toContain("tandem.board");
        await host.command("board");
        expect(blockKinds(world)).not.toContain("tandem.board");
        await host.command("prs");
        expect((await host.screen(host.pane("pr")).render()).title).toBe("#281 ▾");
        await host.command("usage");
        expect(blockKinds(world)).toContain("tandem.usage");
        await host.focus(101);
        const mark = world.trace().length;
        await host.command("project-1");
        expect(traceSince(world, mark)).toContain("tern focus ok");
        await host.command("open-task");
        const picker = host.screen(host.pane("task-picker"));
        expect((await picker.render()).text).toContain("Search tasks by title, id or stage");
      }),
  },
  {
    view: "Links",
    item: "tandem://task|brief|pr in coordinator replies",
    run: () =>
      withParity(async ({ host, world, briefId }) => {
        const links = nativeReplyLinks(
          [
            {
              role: "assistant",
              content: `Task port is implementing, ${briefId} needs approval and PR #281 is ready.`,
            },
          ],
          await world.store.list(),
          await briefs(world).list(),
          world.repoPath,
        );
        expect(links.map((link) => link.label)).toEqual([
          "Task port",
          `Brief ${briefId}`,
          "PR #281",
        ]);
        for (const link of links) expect(await host.link(link.url)).toBe(true);
        expect((await host.screen(host.pane("task")).render()).title).toBe("Port the terminal");
        expect((await host.screen(host.pane("brief")).render()).title).toBe(
          "Brief · Request brief",
        );
        expect((await host.screen(host.pane("pr")).render()).title).toBe("#281 ▾");
        expect(await host.link("https://example.com/not-tandem")).toBe(false);
        expect(await host.link("tandem://pr/not-a-number")).toBe(false);
      }),
  },
  {
    view: "Inbox alerts",
    item: "Needs you, Done, Stuck through OSC 777 from the helper pane",
    run: () =>
      withParity(async ({ host, panel, world }) => {
        const port = await world.store.read("port");
        if (port === undefined) throw new Error("missing seeded task");
        await world.store.update(port.id, port.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          stage: "blocked",
          previousStage: "implementing",
          blockReason: "tests keep failing",
        }));
        const docs = await world.store.read("docs");
        if (docs === undefined) throw new Error("missing seeded task");
        await world.store.update(docs.id, docs.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          pullRequest: {
            repository: "acme/app",
            number: 283,
            state: "draft",
            head: "feature-283",
            base: "main",
          },
        }));
        await briefs(world).create({ repoPath: world.repoPath, content: content("Add search") });
        await host.publish();
        expect(world.ttyWrites().map((write) => `${write.paneId} ${write.text}`)).toEqual([
          "102 \x1b]777;notify;Tandem: Done;Write docs\x07",
          "102 \x1b]777;notify;Tandem: Stuck;Port the terminal\x07",
          "102 \x1b]777;notify;Tandem: Needs you;Add search\x07",
        ]);
        await host.refresh();
        expect((await panel.render()).text).toContain("🔔︎ 3");
      }),
  },
  {
    view: "Task page",
    item: "Header (title, id, model, elapsed, branch); Right now; Agent progress track",
    run: () =>
      withParity(async ({ host, panel }) => {
        await panel.click(/^● Ship the port/);
        const view = await host.screen(host.pane("task")).render();
        expect(view.title).toBe("Ship the port");
        expect(view.text.slice(0, 18)).toEqual([
          "Ship the port",
          "task #ship",
          "← Orchestrator",
          "Model unavailable",
          "0s elapsed",
          "Branch unavailable",
          "Right now",
          "▸ ready to publish",
          "Agent progress",
          "✓ Implement",
          "→",
          "✓ Validate",
          "→",
          "✓ Review",
          "→",
          "Fix · round 0 of 1",
          "→",
          "Ready",
        ]);
        expect(styleOf(view, "✓ Implement")).toContain("success");
      }),
  },
  {
    view: "Task page",
    item: "Tabs Overview, Brief, Progress, Diff, PR, Cost",
    run: () =>
      withParity(async ({ host, panel, world }) => {
        await panel.click(/^● Ship the port/);
        const task = host.screen(host.pane("task"));
        const body = async () => {
          const view = await task.render();
          return view.text.slice(
            view.text.indexOf("Cost") + 1,
            view.text.indexOf("Message the worker…"),
          );
        };
        expect(labels(await task.render()).slice(1, 7)).toEqual([
          "Overview",
          "Brief",
          "Progress",
          "Diff",
          "PR",
          "Cost",
        ]);
        const at = world.clock().slice(11, 16);
        expect(await body()).toEqual([
          "Summary",
          "Ship the port",
          "To-dos · 0 of 0",
          "No worker to-dos yet.",
          "Recent events",
          at,
          "queued → ready",
          at,
          "awaiting-approval → queued",
          at,
          "Started · awaiting-approval",
        ]);
        await task.click("Brief");
        expect(await body()).toEqual(["No brief is linked to this task yet."]);
        await task.click("Progress");
        expect(await body()).toEqual([
          "Timeline",
          at,
          "Started · awaiting-approval",
          at,
          "awaiting-approval → queued",
          at,
          "queued → ready",
          "Validation checks",
          "No validation evidence yet.",
          "Review findings",
          "No saved findings.",
        ]);
        await task.click("Diff");
        const diff = await body();
        expect(diff).toContain("src/port.ts ●1");
        expect(diff).toContain("Why guard here?");
        await task.click("PR");
        const pr = await body();
        expect(pr).toContain("Ports the terminal backend.");
        expect(pr).toContain("Conversation");
        await task.click("Cost");
        expect(await body()).toEqual(["Usage receipt unavailable. No recorded task usage yet."]);
      }),
  },
  {
    view: "Task page",
    item: "Stuck banner with Restart and Steer…; message box with model",
    run: () =>
      withParity(async ({ host, panel, world }) => {
        const worktree = await world.grantLease({ name: "login", holder: "login" });
        const login = await world.store.read("login");
        if (login === undefined) throw new Error("missing seeded task");
        await world.store.update(login.id, login.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          worktree,
        }));
        await seedScenarioRuntime(
          world,
          scenarioRuntimeTask({ taskId: "login", taskName: "login", worktree }),
        );
        await panel.click(/^● Fix login/);
        const task = host.screen(host.pane("task"));
        const view = await task.render();
        const banner = view.text.indexOf("Stuck");
        expect(view.text.slice(banner, banner + 4)).toEqual([
          "Stuck",
          "worker stopped twice",
          "Restart",
          "Steer…",
        ]);
        expect(view.text.slice(-4)).toEqual([
          "Message the worker…",
          "Model unavailable",
          "Steers the worker; it reads this at its next safe step",
          "Send ↑",
        ]);
        await task.click("Steer…");
        expect((await task.render()).focused).toBe("Message the worker…");
        await task.type("try the other port");
        expect((await task.render()).text).toContain("try the other port");
        let mark = host.events.length;
        await task.press({ name: "enter" });
        expect(host.toasts(mark)).toEqual([]);
        const steered = await world.store.read("login");
        expect(JSON.stringify(steered?.communication)).toContain("try the other port");
        expect((await task.render()).text).not.toContain("try the other port");
        mark = host.events.length;
        const ledger = world.trace().length;
        await task.click("Restart");
        expect(host.toasts(mark)).toEqual([]);
        expect((await world.store.read("login"))?.stage).toBe("implementing");
        expect(traceSince(world, ledger)).toEqual(
          expect.arrayContaining(["tern new ok", "tern run ok"]),
        );
        await host.publish();
        await host.refresh();
        expect((await task.render()).text).not.toContain("Stuck");
      }),
  },
  {
    view: "Task page",
    item: "Unavailable; busy flag during an action; failure toasts; ← Orchestrator",
    run: () =>
      withParity(async ({ host, panel, world }) => {
        await host.unpublishDetail({ task: "docs" });
        await panel.click(/^● Write docs/);
        expect((await host.screen(host.pane("task")).render()).text).toEqual([
          "Task unavailable",
          "← Orchestrator",
          "Task view unavailable. Waiting for its saved detail file.",
        ]);
        await host.publish();
        await panel.click(/^● Port the terminal/);
        const task = host.screen(host.pane("task"));
        await task.click(/^Message the worker…/);
        await task.type("use the new API");
        await task.click("Send ↑", { hold: true });
        expect((await task.render()).text).toContain("Sending…");
        await host.settle();
        expect((await task.render()).text).toContain("Send ↑");
        expect(JSON.stringify((await world.store.read("port"))?.communication)).toContain(
          "use the new API",
        );
        await host.corruptTaskView("port");
        await host.refresh();
        const stale = await task.render();
        expect(stale.text).toContain(
          "Saved view unavailable. Actions are disabled until fresh data arrives.",
        );
        expect(stale.title).toBe("Port the terminal");
        const port = await world.store.read("port");
        if (port === undefined) throw new Error("missing seeded task");
        await world.store.update(port.id, port.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          pullRequest: {
            repository: "acme/app",
            number: 283,
            state: "draft",
            head: "feature-283",
            base: "main",
          },
        }));
        await host.publish();
        await host.refresh();
        await task.click("PR");
        const mark = host.events.length;
        await task.click("Open PR #283");
        expect(host.toasts(mark).map((toast) => `${toast.title}: ${toast.message}`)).toEqual([
          "Tandem action failed: Native pr detail is not ready",
        ]);
        expect(blockKinds(world)).toEqual(["tandem.panel", "tandem.task"]);
        await task.click("← Orchestrator");
        expect(blockKinds(world)).toEqual(["tandem.panel"]);
      }),
  },
  {
    view: "Brief pane",
    item: "Loading text; NEW markers; hover + and comment card; Approve; Request changes (N); Edit in browser ↗",
    run: () =>
      withParity(async ({ host, panel, world, briefId }) => {
        const fresh = await briefs(world).create({
          repoPath: world.repoPath,
          content: content("Add search"),
        });
        await host.unpublishDetail({ brief: fresh.id });
        expect(await host.link(`tandem://brief/${fresh.id}`)).toBe(true);
        const loading = host.screen(host.pane("brief"));
        expect((await loading.render()).text).toEqual([
          "Brief",
          "×",
          "Loading brief… Waiting for a published revision.",
        ]);
        await loading.click("×");
        const store = briefs(world);
        const saved = await store.read(briefId);
        if (saved === undefined) throw new Error("missing seeded brief");
        await store.update(briefId, saved.revision, (current) =>
          reviseRequestBriefRecord(current, content("Add dark mode with a toggle"), world.clock()),
        );
        await host.publish();
        await host.refresh();
        await panel.click(/^● Add dark mode/);
        const brief = host.screen(host.pane("brief"));
        const view = await brief.render();
        expect(view.text[0]).toBe("Brief · Request brief · rev 2 · 1 changes");
        expect(
          view.text.slice(
            view.text.indexOf("Add dark mode with a toggle"),
            view.text.indexOf("Add dark mode with a toggle") + 3,
          ),
        ).toEqual(["Add dark mode with a toggle", "NEW", "+"]);
        expect(labels(view)).not.toContain("Edit in browser ↗");
        await brief.click("+", { nth: 2 });
        await brief.focusField("Comment on this line…");
        await brief.type("Default to the system theme");
        let editing = await brief.render();
        expect(editing.text).toContain("Comment on this line…");
        await brief.click("Comment");
        editing = await brief.render();
        expect(editing.text).toContain("you · pending");
        expect(labels(editing)).toContain("Request changes (1)");
        await brief.click("Request changes (1)");
        expect(blockKinds(world)).not.toContain("tandem.brief");
        expect(world.sentKeys().map((sent) => sent.text)).toEqual([
          expect.stringContaining("Default to the system theme"),
        ]);
        const approved = await briefs(world).create({
          repoPath: world.repoPath,
          content: content("Add export"),
        });
        await host.publish();
        await host.refresh();
        expect(await host.link(`tandem://brief/${approved.id}`)).toBe(true);
        const pending = host.screen(host.pane("brief"));
        await pending.click("Approve", { hold: true });
        const sending = await pending.render();
        expect(sending.text).toContain("Sending…");
        expect(labels(sending)).not.toContain("Approve");
        expect(labels(sending).filter((label) => label.startsWith("Request changes"))).toEqual([]);
        await host.settle();
        expect(blockKinds(world)).not.toContain("tandem.brief");
        expect((await briefs(world).read(approved.id))?.approval).toBeDefined();
      }),
  },
  {
    view: "Brief pane",
    item: "Guard toasts (unfinished comment, empty request, missing context); stale revision refused",
    run: () =>
      withParity(async ({ host, panel, world, briefId }) => {
        await panel.click(/^● Add dark mode/);
        const brief = host.screen(host.pane("brief"));
        let mark = host.events.length;
        await brief.click("Request changes (0)");
        expect(host.toasts(mark).map((toast) => `${toast.title}: ${toast.message}`)).toEqual([
          "Add a comment: Explain what should change before requesting changes.",
        ]);
        await brief.click("+", { nth: 2 });
        mark = host.events.length;
        await brief.click("Approve");
        expect(host.toasts(mark).map((toast) => `${toast.title}: ${toast.message}`)).toEqual([
          "Finish your line comment: Choose Comment or Cancel before submitting the brief.",
        ]);
        await brief.focusField("Comment on this line…");
        await brief.type("Keep the old palette");
        await brief.click("Comment");
        const store = briefs(world);
        const saved = await store.read(briefId);
        if (saved === undefined) throw new Error("missing seeded brief");
        await store.update(briefId, saved.revision, (current) =>
          reviseRequestBriefRecord(current, content("Add dark mode later"), world.clock()),
        );
        await host.publish();
        await host.refresh();
        const stale = await brief.render();
        expect(stale.text).toContain(
          "A newer revision is available. Your comments still describe this revision.",
        );
        expect(labels(stale)).toContain("Discard comments and refresh");
        mark = host.events.length;
        await brief.click("Request changes (1)");
        expect(host.toasts(mark).map((toast) => `${toast.title}: ${toast.message}`)).toEqual([
          "Brief action completed: The brief changed after this action; the current brief was left open. Do not resubmit this action.",
        ]);
        expect(world.sentKeys()).toEqual([
          {
            paneId: "101",
            text: `From the open review page:\n\nBrief ${briefId}, revision 1: Request changes\n\nLine 2 [TL;DR:0:0] (Add dark mode):\nKeep the old palette\r`,
          },
        ]);
        expect(blockKinds(world)).toContain("tandem.brief");
        const after = await brief.render();
        expect(after.text.slice(0, 4)).toEqual([
          "Brief · Request brief · rev 1 · 0 changes",
          "×",
          "The brief changed after this action; the current brief was left open. Do not resubmit this action.",
          "A newer revision is available. Your comments still describe this revision.",
        ]);
        expect(labels(after).filter((label) => !["×", "+", "Remove"].includes(label))).toEqual([]);
        await brief.click("×");
        await panel.click(/^● Add dark mode/);
        const reopened = host.screen(host.pane("brief"));
        expect((await reopened.render()).text[0]).toBe("Brief · Request brief · rev 2 · 1 changes");
        await host.corruptBriefView(briefId);
        await host.refresh();
        const unavailable = await reopened.render();
        expect(unavailable.text).toContain(
          "Brief unavailable. Actions are disabled until the view file recovers.",
        );
        expect(labels(unavailable)).not.toContain("Approve");
        expect(labels(unavailable).filter((label) => label.startsWith("Request changes"))).toEqual(
          [],
        );
      }),
  },
  {
    view: "PR pane",
    item: "Header with title, draft badge, Open PR ↗, who-acts-next, unresolved jump, commits, +/−",
    run: () =>
      withParity(async ({ host, panel, world }) => {
        world.github.openPullRequest({
          repo: "acme/app",
          number: 284,
          title: "Draft work",
          draft: true,
          patch: PATCH,
        });
        await withPrWatches(world.home, ({ put }) => {
          put({
            ref: { repo: "acme/app", number: 284 },
            origin: "user",
            repoPath: world.repoPath,
            startedAt: world.clock(),
            log: [],
          });
        });
        await host.publish();
        await host.refresh();
        await panel.click("⎇");
        const pr = host.screen(host.pane("pr"));
        const view = await pr.render();
        expect(view.title).toBe("#281 ▾");
        expect(view.text.slice(0, 6)).toEqual([
          "#281 ▾",
          "×",
          "#281 Ship the port",
          "open",
          "Open PR ↗",
          "Waiting for PR watch",
        ]);
        expect(view.text.slice(11, 16)).toEqual([
          "1 unresolved comments",
          "task ship ↗",
          "1 commits · +1 −0",
          "Description",
          "Diff",
        ]);
        const mark = host.events.length;
        await pr.click("Open PR ↗");
        expect(opened(host, mark)).toEqual([PR_URL]);
        await pr.click("1 unresolved comments");
        expect((await pr.render()).revealed).toContain("Why guard here?");
        await pr.click("#281 ▾");
        expect((await pr.render()).text.slice(0, 3)).toEqual([
          "#281 Ship the port",
          "#282 Bump deps",
          "#284 Draft work",
        ]);
        await pr.click("#284 Draft work");
        expect(blockKinds(world)).toEqual(["tandem.panel", "tandem.pr"]);
        const draft = await host.screen(host.pane("pr")).render();
        expect(draft.title).toBe("#284 ▾");
        expect(draft.text.slice(2, 6)).toEqual([
          "#284 Draft work",
          "draft",
          "Open PR ↗",
          "Waiting on you: publish it (draft → ready)",
        ]);
        expect(draft.text).toContain(
          "Read-only: this watched PR has no Tandem task. Start a PR review task to comment or post a review.",
        );
        await host.screen(host.pane("pr")).click("#284 ▾");
        await host.screen(host.pane("pr")).click("#281 Ship the port");
        await host.screen(host.pane("pr")).click("task ship ↗");
        expect((await host.screen(host.pane("task")).render()).title).toBe("Ship the port");
      }),
  },
  {
    view: "PR pane",
    item: "CI pills: passed, running spinner with live elapsed, failed with view log",
    run: () =>
      withParity(async ({ host, panel }) => {
        await panel.click("⎇");
        const pr = host.screen(host.pane("pr"));
        const view = await pr.render();
        expect(view.text.slice(6, 11)).toEqual([
          "✓ lint",
          "e2e · running",
          "1:30",
          "✗ unit",
          "view log",
        ]);
        expect(styleOf(view, "✓ lint")).toContain("success");
        expect(styleOf(view, "✗ unit")).toContain("danger");
        await host.refresh();
        await host.refresh();
        expect((await pr.render()).text[8]).toBe("1:32");
        const mark = host.events.length;
        await pr.click("view log");
        expect(opened(host, mark)).toEqual(["https://ci.example/unit"]);
      }),
  },
  {
    view: "PR pane",
    item: "Description with Conversation; Tour only when a tour exists; Diff with file switcher, own rows, thread cards, Reply, new comment cards, worker-destination hint",
    run: () =>
      withParity(async ({ host, panel, world }) => {
        const ship = await world.store.read("ship");
        if (ship === undefined) throw new Error("missing seeded task");
        await world.store.update(ship.id, ship.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          stage: "implementing",
        }));
        await host.publish();
        await host.refresh();
        await panel.click("⎇");
        const pr = host.screen(host.pane("pr"));
        const body = async () => {
          const view = await pr.render();
          return view.text.slice(view.text.indexOf("Diff") + 1);
        };
        expect(
          labels(await pr.render()).filter((label) =>
            ["Description", "Tour", "Diff"].includes(label),
          ),
        ).toEqual(["Description", "Diff"]);
        expect(await body()).toEqual([
          "Ports the terminal backend.",
          "Conversation",
          `sam · ${world.clock()}`,
          "Looks close.",
        ]);
        await pr.click("Diff");
        expect(await body()).toEqual([
          "src/port.ts ●1",
          "+1 −0 · src/port.ts",
          "@@ -1 +1 @@ ",
          "1",
          "1",
          "export function port() {",
          "+",
          "2",
          "  guard();",
          "+",
          `jules · ${world.clock()}`,
          "Why guard here?",
          "unresolved",
          "Reply",
          "2",
          "3",
          "}",
          "+",
          "Hover a line and click + to comment. Your comments go to the worker as fix requests.",
        ]);
        await pr.click("Reply");
        expect(await body()).toContain("Comment…");
        await pr.type("Because the port can race");
        await pr.click("Comment");
        await pr.click("+", { nth: 1 });
        await pr.type("Rename port");
        await pr.click("Comment");
        const sent = await body();
        expect(sent.filter((text) => text.startsWith("you · "))).toEqual([
          "you · sent to worker",
          "you · sent to worker",
        ]);
        const task = await world.store.read("ship");
        expect(
          task?.communication?.messages.map((message) => message.text.split(" This task's")[0]),
        ).toEqual([
          "PR fix request: Reply to acme/app#281 thread thread-1, root comment n1 (GitHub 11), src/port.ts:2: Because the port can race",
          "PR fix request: src/port.ts:1: Rename port",
        ]);
        await seedReview(world);
        await host.publish();
        await host.refresh();
        await host.screen(host.pane("pr")).click("×");
        expect(await host.link("tandem://pr/290")).toBe(true);
        const review = host.screen(host.pane("pr"));
        expect(
          labels(await review.render()).filter((label) =>
            ["Description", "Tour", "Diff"].includes(label),
          ),
        ).toEqual(["Description", "Tour", "Diff"]);
        await review.click("Tour");
        const tour = await review.render();
        expect(
          tour.text.slice(tour.text.indexOf("Diff") + 1, tour.text.indexOf("Your review")),
        ).toEqual([
          "1 · The guard",
          "Every call now passes the guard.",
          "src/port.ts:2–2 Guard: Runs first.",
          "src/port.ts:2–2",
          "2",
          "  guard();",
          "Reviewer · nit",
          "Name the guard.",
        ]);
      }),
  },
  {
    view: "PR pane",
    item: "pr-review verdict and Post; Posting…; Review already posted; posted or unconfirmed toasts",
    run: async () => {
      await withParity(async ({ host, world }) => {
        const reviewed = await seedReview(world);
        await host.publish();
        await host.refresh();
        await host.link("tandem://pr/290");
        let pr = host.screen(host.pane("pr"));
        const footer = async () => {
          const view = await pr.render();
          return view.text.slice(view.text.indexOf("Your review"));
        };
        expect((await pr.render()).text[5]).toBe(
          "Waiting on you: choose comments and post your review",
        );
        expect(await footer()).toEqual([
          "Your review",
          "Looks good overall",
          "Overall review…",
          "✓ comment",
          "approve",
          "request-changes",
          "Post",
          `Reviewed commit ${reviewed.head} · Only drafts marked Keep and your new comments will be posted.`,
        ]);
        await pr.click("Diff");
        await pr.click("Keep");
        await pr.click("approve");
        await pr.click("Post", { hold: true });
        expect((await footer()).slice(0, 5)).toEqual([
          "Your review",
          "Posting…",
          "comment",
          "✓ approve",
          "request-changes",
        ]);
        const mark = host.events.length;
        await host.settle();
        expect(host.toasts(mark)).toEqual([
          {
            pane: pr.pane,
            level: "info",
            title: "Review posted",
            message: "Posted 1 comment: https://github.com/acme/app/pull/290#pullrequestreview-1",
          },
        ]);
        expect(blockKinds(world)).toEqual(["tandem.panel"]);
        expect(reviewed.postedReviews.map((review) => review.url)).toEqual([
          "https://github.com/acme/app/pull/290#pullrequestreview-1",
        ]);
        const task = await world.store.read("review-290");
        expect(task?.prReview?.rounds.at(-1)?.posted?.verdict).toBe("approve");
        await host.publish();
        await host.refresh();
        await host.link("tandem://pr/290");
        pr = host.screen(host.pane("pr"));
        expect((await pr.render()).text[5]).toBe("You posted this review");
        expect(await footer()).toContain("Review already posted");
        expect(labels(await pr.render())).not.toContain("Post");
      });
      await withParity(async ({ host, world }) => {
        const reviewed = await seedReview(world);
        await host.publish();
        await host.refresh();
        await host.link("tandem://pr/290");
        const pr = host.screen(host.pane("pr"));
        const moved = world.github.push(reviewed);
        const mark = host.events.length;
        await pr.click("Post");
        expect(host.toasts(mark)).toEqual([
          {
            pane: pr.pane,
            level: "info",
            title: "Review wasn't confirmed as posted",
            message: `The PR moved to ${moved.slice(0, 12)} since this review, so the comments could land on the wrong lines. Ask for a re-review first.`,
          },
        ]);
        expect(reviewed.postedReviews).toEqual([]);
        await host.publish();
        await host.refresh();
        expect((await pr.render()).text[5]).toBe(
          "Waiting on you: choose comments and post your review",
        );
        const again = host.events.length;
        await pr.click("Post");
        expect(host.toasts(again).map((toast) => toast.title)).toEqual([
          "Review wasn't confirmed as posted",
        ]);
        expect(reviewed.postedReviews).toEqual([]);
      });
    },
  },
  {
    view: "Board",
    item: "Header view-only; four lanes; cards; stuck tag; All quiet; PR card link",
    run: () =>
      withParity(async ({ host, panel, world }) => {
        await panel.click("▦");
        const board = host.screen(host.pane("board"));
        const view = await board.render();
        expect(view.title).toBe("Tandem board");
        expect(view.text).toEqual([
          "Board · tandem",
          "view-only · ⌘⇧B or Esc to close",
          "← Orchestrator",
          "● Working",
          "1",
          "Port the terminal",
          "branch unavailable",
          "for 0s",
          "0s",
          "model unavailable",
          "cost unavailable",
          "● Needs you",
          "2",
          "Add dark mode",
          "branch unavailable",
          "brief waiting for approval",
          "model unavailable",
          "cost unavailable",
          "Fix login",
          "stuck",
          "branch unavailable",
          "worker stopped twice",
          "0s",
          "model unavailable",
          "cost unavailable",
          "● In review",
          "0",
          "All quiet",
          "● Ready to merge",
          "2",
          "Ship the port",
          "branch unavailable",
          "waiting for PR watch",
          "0s",
          "model unavailable",
          "cost unavailable",
          "#281 open ↗",
          "#282 feature-282",
          "branch unavailable",
          "2 checks pending",
          "model unavailable",
          "cost unavailable",
        ]);
        expect(labels(view)).toEqual(["← Orchestrator", "#281 open ↗"]);
        await board.click("#281 open ↗");
        expect(
          world.ternBlocks().flatMap((block) => (block.browserUrl ? [block.browserUrl] : [])),
        ).toEqual([PR_URL]);
        expect(await board.press({ name: "escape" })).toBe(true);
        expect(blockKinds(world)).toEqual(["tandem.panel"]);
      }),
  },
  {
    view: "Usage",
    item: "Limits first; Provider limits unavailable; today and week totals; breakdown; No recorded usage",
    run: () =>
      withParity(async ({ host, panel, world }) => {
        await panel.click("5h unavailable");
        const usage = host.screen(host.pane("usage"));
        const view = await usage.render();
        expect(view.title).toBe("Tandem usage");
        expect(view.text).toEqual([
          "Usage · tandem",
          "← Orchestrator",
          "Limits",
          "Provider limits unavailable",
          `View updated at ${world.clock().slice(0, 10)} ${world.clock().slice(11, 19)} UTC`,
          "Provider limit refresh failed; last known limits may be stale",
          "$0.00",
          "cost today",
          "0m",
          "agent time today",
          "2",
          "tasks done today",
          "$0.00",
          "this week",
          "Cost by model · today",
          "No recorded usage",
          "Cost by model · week",
          "No recorded usage",
          "Time per stage",
          "Stage",
          "Today",
          "Week",
        ]);
        await usage.click("← Orchestrator");
        expect(blockKinds(world)).toEqual(["tandem.panel"]);
      }),
  },
  {
    view: "Catch-up",
    item: "Shown after 1 hour away when something changed; four sections with None; Open what needs me; Dismiss; Esc",
    run: () =>
      withParity(async (parity) => {
        const { host, world } = parity;
        const other = await otherProject(parity);
        await host.focus(Number(parity.project.coordinator.paneId));
        await host.stepAway(other, 30, true);
        expect(blockKinds(world)).toEqual(["tandem.panel"]);
        await host.stepAway(other, 120, false);
        expect(blockKinds(world)).toEqual(["tandem.panel"]);
        await host.stepAway(other, 120, true);
        const catchup = host.screen(host.pane("catchup"));
        const view = await catchup.render();
        expect(view.title).toBe("Welcome back · Tandem");
        expect(view.text).toEqual([
          "Welcome back · tandem",
          "Esc dismiss",
          "Since you left",
          "Merged",
          "None",
          "Needs you",
          "Add dark mode: brief waiting for approval",
          "Ship the port: done, waiting for you",
          "Blocked",
          "Fix login: worker stopped twice",
          "Where we left off",
          "None",
          "Open what needs me",
          "Dismiss",
        ]);
        expect(labels(view)).toEqual(["Open what needs me", "Dismiss"]);
        await catchup.click("Open what needs me");
        expect(blockKinds(world)).toEqual(["tandem.brief", "tandem.panel"]);
        const brief = host.screen(host.pane("brief"));
        expect((await brief.render()).title).toBe("Brief · Request brief");
        await brief.click("×");
        await host.stepAway(other, 120, true);
        expect(await host.screen(host.pane("catchup")).press({ name: "escape" })).toBe(true);
        expect(blockKinds(world)).toEqual(["tandem.panel"]);
        await host.stepAway(other, 120, true);
        await host.screen(host.pane("catchup")).click("Dismiss");
        expect(blockKinds(world)).toEqual(["tandem.panel"]);
      }),
  },
  {
    view: "Generic",
    item: "Tandem view did not open; Tandem kept an uncertain view; paused-views warning on return",
    run: async () => {
      // A Luau failure that changed nothing still toasts once the open path settles it.
      await withParity(async ({ host, panel, world }) => {
        await host.fault("newBlock", true);
        const mark = host.events.length;
        await panel.click(/^● Fix login/);
        const failed = host
          .toasts(mark)
          .filter((toast) => toast.title === "Tandem view did not open");
        expect(failed).toHaveLength(1);
        expect(failed[0]?.message).toEndWith("Native block could not open");
        expect(blockKinds(world)).toEqual(["tandem.panel"]);
      });
      // A route Tern never delivered leaves no receipt, so the open stays quarantined.
      await withParity(async ({ host, panel, world }) => {
        await panel.click(/^● Port the terminal/);
        const task = host.screen(host.pane("task"));
        host.dropRoutes = true;
        await panel.click(/^● Fix login/);
        host.dropRoutes = false;
        let mark = host.events.length;
        await panel.click(/^● Write docs/);
        expect(host.toasts(mark).map((toast) => toast.title)).toEqual([
          "Tandem couldn't run that action",
        ]);
        expect(blockKinds(world)).toEqual(["tandem.panel", "tandem.task"]);
        mark = host.events.length;
        await task.click("← Orchestrator");
        expect(host.toasts(mark)).toEqual([
          {
            pane: task.pane,
            level: "warning",
            title: "Tandem kept an uncertain view",
            message:
              "Returned to your conversation. An earlier view could not be verified, so its views and recovery record were kept. Continue here or use Tern's tab switcher; opening new native views stays paused until exact recovery evidence is available.",
          },
        ]);
        expect(blockKinds(world)).toEqual(["tandem.panel", "tandem.task"]);
      });
    },
  },
  {
    view: "Setup",
    item: "One consent for sidebar autohide and keys",
    run: () =>
      withParity(
        async ({ host, world }) => {
          const question =
            "Hide Tern's sidebar and use Tandem's board, PR, usage and project shortcuts? These settings apply to every Tern window. Your custom shortcuts stay unchanged. Palette commands and panel buttons work either way.";
          const unchanged =
            "Tern's sidebar and shortcuts are unchanged. Tandem is available from the palette and panel buttons. To change this later, switch to Herdr and select Tern again in setup.\n";
          const installed = { keybinds: TERN_KEYBINDS, tabs_autohide: true };
          expect(await host.offerTernPreferences("approved", true)).toEqual({
            ready: true,
            questions: [question],
            printed: [],
            settings: installed,
          });
          expect(await host.offerTernPreferences("approved", false)).toEqual({
            ready: true,
            questions: [],
            printed: [],
            settings: installed,
          });
          expect(await host.offerTernPreferences("declined", false)).toEqual({
            ready: true,
            questions: [question],
            printed: [unchanged],
            settings: undefined,
          });
          expect(await host.offerTernPreferences("declined", true)).toEqual({
            ready: true,
            questions: [],
            printed: [],
            settings: undefined,
          });
          expect(world.ternPluginLinks()).toHaveLength(1);
        },
        { seed: false, publish: false },
      ),
  },
];
