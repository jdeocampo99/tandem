import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { focusedProject, type PanelView, panelView } from "../../src/board/panel.ts";
import { type BoardSnapshot, writeBoardSnapshot } from "../../src/board/snapshot.ts";
import { boardView } from "../../src/board/view.ts";
import { runTerminal } from "../../src/main.ts";
import {
  navigationSteps,
  type PanelDeps,
  type PanelEffect,
  type PanelFrame,
  type PanelInput,
  type PanelState,
  panelActionSteps,
  panelStep,
  parsePanelInput,
  renderPanel,
  runPanel,
} from "../../src/terminal/panel.ts";
import { NOW, state, watch } from "../board/fixtures.ts";
import { task } from "../session/fixtures.ts";

const APP = "/work/app";
const TANDEM = "/work/tandem";
const COORDINATORS = [
  { repoPath: APP, project: "app", workspaceId: "w2", paneId: "w2:p1" },
  { repoPath: TANDEM, project: "tandem", workspaceId: "w1", paneId: "w1:p1" },
];
const SNAPSHOT: BoardSnapshot = {
  version: 1,
  writtenAt: NOW,
  board: boardView(
    state({
      tasks: [
        task({ id: "task-stop", repoPath: APP, stage: "blocked", objective: "Stopped work" }),
        task({ id: "task-impl", repoPath: APP, stage: "implementing", objective: "Working" }),
        task({ id: "task-queued", repoPath: APP, stage: "queued", objective: "Queued" }),
      ],
      workerPanes: new Map([["task-impl", { workspaceId: "w3", paneId: "w3:p2" }]]),
      watches: [watch(412, { color: "yellow", status: "👀 review", note: "" }, { repoPath: APP })],
    }),
    NOW,
  ),
  coordinators: COORDINATORS,
};
const VIEW = panelView(SNAPSHOT, { project: APP, query: "", now: NOW, readFailed: false });
const START: PanelState = {
  project: APP,
  query: undefined,
  selected: undefined,
  seen: undefined,
  help: false,
  expanded: new Set(),
};

function frame(view: PanelView = VIEW, popup = false): PanelFrame {
  return {
    view,
    hits: renderPanel(view, START, { width: 46, color: false, popup: false }).hits,
    popup,
    now: 0,
  };
}

/** Feeds keys in order and returns the state and every effect they asked for. */
function press(
  inputs: readonly PanelInput[],
  options: Readonly<{ popup?: boolean; from?: PanelState; at?: readonly number[] }> = {},
): Readonly<{ state: PanelState; effects: PanelEffect[] }> {
  let current = options.from ?? START;
  const effects: PanelEffect[] = [];
  inputs.forEach((input, index) => {
    const step = panelStep(current, input, {
      ...frame(VIEW, options.popup ?? false),
      now: options.at?.[index] ?? 0,
    });
    current = step.state;
    if (step.effect !== undefined) effects.push(step.effect);
  });
  return { state: current, effects };
}

const keys = (text: string) => parsePanelInput(text, true).inputs;

test("raw input splits into keys, arrows, left clicks, and focus changes", () => {
  expect(keys("j\x1b[B\r\x1b\x7f\x03\x1b[<0;5;1M\x1b[<0;5;1m\x1b[<2;1;1M\x1b[I\x1b[O😀")).toEqual([
    { kind: "char", char: "j" },
    { kind: "down" },
    { kind: "enter" },
    { kind: "escape" },
    { kind: "backspace" },
    { kind: "interrupt" },
    { kind: "click", x: 5, y: 1 },
    { kind: "focus", focused: true },
    { kind: "focus", focused: false },
    { kind: "char", char: "😀" },
  ]);
});

test("an escape sequence split across reads waits for its rest instead of reading as Esc", () => {
  const first = parsePanelInput("j\x1b[<0;5", false);
  expect(first).toEqual({ inputs: [{ kind: "char", char: "j" }], pending: "\x1b[<0;5" });
  expect(parsePanelInput(`${first.pending};1M`, false)).toEqual({
    inputs: [{ kind: "click", x: 5, y: 1 }],
    pending: "",
  });
  expect(parsePanelInput("\x1b", false)).toEqual({ inputs: [], pending: "\x1b" });
  expect(parsePanelInput("\x1b", true)).toEqual({ inputs: [{ kind: "escape" }], pending: "" });
  expect(parsePanelInput("\x1b[<0;5", true)).toEqual({ inputs: [], pending: "" });
});

test("Enter goes to the chat for what needs you, the agent for running work, and the browser for PRs", () => {
  expect(press(keys("\r")).effects).toEqual([
    { kind: "go", target: { kind: "chat", repoPath: APP } },
  ]);
  expect(press(keys("j\r")).effects).toEqual([
    { kind: "go", target: { kind: "pane", workspaceId: "w3", paneId: "w3:p2" } },
  ]);
  expect(press(keys("jj\r")).effects).toEqual([]);
  expect(press(keys("jjj\r")).effects).toEqual([
    { kind: "go", target: { kind: "url", url: "https://github.com/acme/app/pull/412" } },
  ]);
  expect(press(keys("jjjjjjk")).state.selected).toBe(press(keys("jj")).state.selected);
});

test("number keys and brackets switch project; Esc closes only a popup", () => {
  expect(press(keys("1")).effects).toEqual([{ kind: "switch", repoPath: TANDEM }]);
  expect(press(keys("1")).state.project).toBe(TANDEM);
  expect(press(keys("9")).effects).toEqual([]);
  expect(press(keys("]")).effects).toEqual([{ kind: "switch", repoPath: TANDEM }]);
  expect(press(keys("[")).effects).toEqual([{ kind: "switch", repoPath: TANDEM }]);
  expect(press(keys("\x1b"), { popup: true }).effects).toEqual([{ kind: "close" }]);
  expect(press(keys("\x1b")).effects).toEqual([]);
  expect(press(keys("q")).effects).toEqual([]);
});

test("search takes every key as text until Esc clears it; arrows still move and Enter goes", () => {
  const searching = press(keys("/j1[q"));
  expect(searching.state.query).toBe("j1[q");
  expect(searching.effects).toEqual([]);
  expect(press(keys("\x7f\x7f"), { from: searching.state }).state.query).toBe("j1");
  expect(press(keys("\x1b"), { from: searching.state, popup: true })).toEqual({
    state: { ...searching.state, query: undefined },
    effects: [],
  });
  expect(press(keys("\x1b[B\r"), { from: { ...START, query: "" } }).effects).toEqual([
    { kind: "go", target: { kind: "pane", workspaceId: "w3", paneId: "w3:p2" } },
  ]);
});

test("going or switching closes the search, so the panel is not left swallowing keys", () => {
  const searching = { ...START, query: "" };
  const went = press(keys("\r"), { from: searching });
  expect(went.effects).toHaveLength(1);
  expect(went.state.query).toBeUndefined();
  const { hits } = frame();
  const tandemChip = hits.find((hit) => hit.kind === "chip" && hit.repoPath === TANDEM);
  if (tandemChip === undefined) throw new Error("missing chip");
  const switched = press([{ kind: "click", x: tandemChip.from, y: tandemChip.y }], {
    from: searching,
  });
  expect(switched.effects).toEqual([{ kind: "switch", repoPath: TANDEM }]);
  expect(switched.state.query).toBeUndefined();
  const nowhere = press(keys("\x1b[B\x1b[B\r"), { from: searching });
  expect(nowhere.state.query).toBe("");
});

test("a search with no results says so, and project headings keep their own case", () => {
  const draw = (query: string) => {
    const view = panelView(SNAPSHOT, { project: APP, query, now: NOW, readFailed: false });
    return renderPanel(view, { ...START, query }, { width: 46, color: false, popup: false }).lines;
  };
  expect(draw("zzz")).toContain("no matches");
  expect(draw("")).not.toContain("no matches");
  expect(draw("working")).toContain("app");
  expect(draw("")).toContain("NEEDS YOU");
});

test("the key help offers Esc close only in a popup", () => {
  const help = (popup: boolean) =>
    renderPanel(VIEW, { ...START, help: true }, { width: 46, color: false, popup }).lines.join(
      "\n",
    );
  expect(help(true)).toContain("Esc close · x hide");
  expect(help(false)).not.toContain("Esc");
  expect(help(false)).toContain("x hide");
});

test("a click on a chip switches, a click on a row selects it, and a double-click goes", () => {
  const { hits } = frame();
  const tandemChip = hits.find((hit) => hit.kind === "chip" && hit.repoPath === TANDEM);
  const working = hits.find((hit) => hit.kind === "row" && hit.key === "task:task-impl");
  if (tandemChip === undefined || working === undefined) throw new Error("missing hit");
  expect(press([{ kind: "click", x: tandemChip.from, y: tandemChip.y }]).effects).toEqual([
    { kind: "switch", repoPath: TANDEM },
  ]);
  const click = { kind: "click", x: 3, y: working.y } as const;
  const once = press([click]);
  expect(once.state.selected).toBe("task:task-impl");
  expect(once.effects).toEqual([]);
  expect(press([click, click], { at: [0, 300] }).effects).toEqual([
    { kind: "go", target: { kind: "pane", workspaceId: "w3", paneId: "w3:p2" } },
  ]);
  expect(press([click, click], { at: [0, 900] }).effects).toEqual([]);
});

test("the key help hides on x or the first key, and the next key clears a notice", () => {
  expect(press(keys("x"), { from: { ...START, help: true } }).state.help).toBe(false);
  expect(press(keys("j"), { from: { ...START, help: true } }).state.help).toBe(false);
  expect(press(keys("j"), { from: { ...START, notice: "⚠ oops" } }).state.notice).toBeUndefined();
});

test("losing focus remembers every project's rows as seen", () => {
  const left = press([{ kind: "focus", focused: false }]).state;
  expect(left.seen).toEqual(new Set(VIEW.signatures));
});

test("the selection stays on its task when the task changes stage", () => {
  const selected = press(keys("j")).state;
  expect(selected.selected).toBe("task:task-impl");
  const later = panelView(
    {
      ...SNAPSHOT,
      board: boardView(
        state({
          tasks: [
            task({ id: "task-stop", repoPath: APP, stage: "blocked", objective: "Stopped work" }),
            task({ id: "task-impl", repoPath: APP, stage: "validating", objective: "Working" }),
          ],
        }),
        NOW,
      ),
    },
    { project: APP, query: "", now: NOW, readFailed: false },
  );
  const step = panelStep(selected, { kind: "char", char: "j" }, { ...frame(later), now: 0 });
  expect(step.state.selected).toBe("task:task-impl");
});

test("rows taller than the terminal scroll to keep the selection in sight, with clicks matching", () => {
  const last = VIEW.sections.at(-1)?.rows.at(-1)?.key;
  const rendered = renderPanel(
    VIEW,
    { ...START, selected: last },
    {
      width: 46,
      height: 6,
      color: false,
      popup: false,
    },
  );
  expect(rendered.lines).toHaveLength(6);
  const rowHits = rendered.hits.filter((hit) => hit.kind === "row");
  expect(rowHits.every((hit) => hit.y >= 3 && hit.y <= 6)).toBe(true);
  const selectedHit = rowHits.find((hit) => hit.kind === "row" && hit.key === last);
  expect(rendered.lines[(selectedHit?.y ?? 0) - 1]).toContain("#412");
});

test("chip click areas stop at the panel's edge", () => {
  const hits = renderPanel(VIEW, START, { width: 10, color: false, popup: false }).hits;
  expect(hits.filter((hit) => hit.kind === "chip").every((hit) => hit.to <= 10)).toBe(true);
});

test("going focuses the workspace, then the agent pane when Herdr knows it; PRs open in the browser", () => {
  const herdr = (...args: string[]) => ["herdr", "--session", "tandem", ...args];
  expect(
    navigationSteps(
      { kind: "go", target: { kind: "chat", repoPath: APP } },
      "tandem",
      COORDINATORS,
    ),
  ).toEqual([
    { argv: herdr("workspace", "focus", "w2"), failure: "⚠ Herdr couldn't focus it" },
    { argv: herdr("agent", "focus", "w2:p1") },
  ]);
  expect(
    navigationSteps(
      { kind: "go", target: { kind: "pane", workspaceId: "w3", paneId: "w3:p2" } },
      "tandem",
      COORDINATORS,
    ),
  ).toEqual([
    { argv: herdr("workspace", "focus", "w3"), failure: "⚠ Herdr couldn't focus it" },
    { argv: herdr("agent", "focus", "w3:p2") },
  ]);
  expect(
    navigationSteps({ kind: "go", target: { kind: "url", url: "https://x/1" } }, "tandem", []),
  ).toEqual([{ argv: ["open", "https://x/1"], failure: "⚠ couldn't open the link" }]);
  expect(navigationSteps({ kind: "switch", repoPath: TANDEM }, "tandem", COORDINATORS)).toEqual([
    { argv: herdr("workspace", "focus", "w1"), failure: "⚠ Herdr couldn't focus it" },
    { argv: herdr("agent", "focus", "w1:p1") },
  ]);
  expect(navigationSteps({ kind: "switch", repoPath: "/offline" }, "tandem", COORDINATORS)).toEqual(
    [],
  );
});

test("Herdr's focus names the project: its coordinator's or worker's workspace, else its directory", () => {
  expect(focusedProject(SNAPSHOT, { workspaceId: "w2", cwd: "/pool/wt-1" })).toBe(APP);
  expect(focusedProject(SNAPSHOT, { workspaceId: "w3", cwd: "/pool/wt-2" })).toBe(APP);
  expect(focusedProject(SNAPSHOT, { workspaceId: "w9", cwd: `${TANDEM}/src` })).toBe(TANDEM);
  expect(focusedProject(SNAPSHOT, { cwd: `${APP}/docs` })).toBe(APP);
});

test("the home key goes to the focused project's chat; prev and next wrap around open projects", () => {
  const herdr = (...args: string[]) => ["herdr", "--session", "tandem", ...args];
  const focusFailure = "⚠ Herdr couldn't focus it";
  const inWorker = { workspaceId: "w3", cwd: "/pool/wt-2" };
  expect(panelActionSteps("home", SNAPSHOT, inWorker, "tandem")).toEqual([
    { argv: herdr("workspace", "focus", "w2"), failure: focusFailure },
    { argv: herdr("agent", "focus", "w2:p1") },
  ]);
  expect(panelActionSteps("next", SNAPSHOT, inWorker, "tandem")).toEqual([
    { argv: herdr("workspace", "focus", "w1"), failure: focusFailure },
    { argv: herdr("agent", "focus", "w1:p1") },
  ]);
  expect(panelActionSteps("prev", SNAPSHOT, { workspaceId: "w1", cwd: "/" }, "tandem")).toEqual([
    { argv: herdr("workspace", "focus", "w2"), failure: focusFailure },
    { argv: herdr("agent", "focus", "w2:p1") },
  ]);
  const alone = { ...SNAPSHOT, coordinators: COORDINATORS.slice(0, 1) };
  expect(panelActionSteps("next", alone, inWorker, "tandem")).toEqual([
    { argv: herdr("workspace", "focus", "w2"), failure: focusFailure },
    { argv: herdr("agent", "focus", "w2:p1") },
  ]);
  const OTHER = "/work/other";
  const offlineHere = {
    ...SNAPSHOT,
    board: { ...SNAPSHOT.board, projectPaths: [TANDEM, APP, OTHER] },
    coordinators: [
      ...COORDINATORS.slice(0, 1),
      { repoPath: OTHER, project: "other", workspaceId: "w5", paneId: "w5:p1" },
    ],
  };
  const inTandem = { cwd: `${TANDEM}/src` };
  expect(panelActionSteps("next", offlineHere, inTandem, "tandem")).toEqual([
    { argv: herdr("workspace", "focus", "w2"), failure: focusFailure },
    { argv: herdr("agent", "focus", "w2:p1") },
  ]);
  expect(panelActionSteps("prev", offlineHere, inTandem, "tandem")).toEqual([
    { argv: herdr("workspace", "focus", "w5"), failure: focusFailure },
    { argv: herdr("agent", "focus", "w5:p1") },
  ]);
});

test("tandem panel home finds the project from Herdr's plugin context, not the inherited workspace", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-panel-action-"));
  try {
    await writeBoardSnapshot(home, SNAPSHOT);
    const ran: (readonly string[])[] = [];
    const result = await runTerminal(["panel", "home", "--home", home], {
      cwd: "/plugin",
      processEnvironment: {
        HERDR_SESSION: "tandem",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
          workspace_id: "w3",
          focused_pane_cwd: "/pool/wt-2",
        }),
      },
      run: async (request) => {
        ran.push(request.argv);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result).toEqual({ exitCode: 0, status: "panel" });
    expect(ran).toEqual([
      ["herdr", "--session", "tandem", "workspace", "focus", "w2"],
      ["herdr", "--session", "tandem", "agent", "focus", "w2:p1"],
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("tandem panel draws from the snapshot file alone, never opening the state store", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-panel-"));
  try {
    await writeBoardSnapshot(home, SNAPSHOT);
    const output: string[] = [];
    const input = new PassThrough();
    const result = await runTerminal(["panel", "--home", home], {
      input,
      cwd: APP,
      processEnvironment: {},
      stdout: (text) => output.push(text),
    });
    expect(result).toEqual({ exitCode: 0, status: "panel" });
    expect(output.join("")).toContain("Stopped work");
    expect(await readdir(home)).toEqual(["board-snapshot.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** A fake terminal: keys go in through `input`, and every write and raw-mode change is kept. */
function fakeTerminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    raw: [] as boolean[],
    setRawMode(raw: boolean) {
      input.raw.push(raw);
    },
  });
  const written: string[] = [];
  let stop = (): void => {};
  return {
    input,
    written,
    stop: () => stop(),
    deps: (overrides: Partial<PanelDeps> = {}): PanelDeps => ({
      input,
      write: (text) => written.push(text),
      size: () => ({ columns: 46, rows: 40 }),
      color: false,
      clock: () => new Date(NOW),
      readSnapshot: async () => SNAPSHOT,
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      sessionId: "tandem",
      cwd: APP,
      focus: { cwd: APP },
      popup: false,
      helpUnseen: false,
      rememberHelpSeen: async () => {},
      onExitSignal: (handler) => {
        stop = handler;
        return () => {
          stop = () => {};
        };
      },
      ...overrides,
    }),
  };
}

test("a signal closes the panel and puts the terminal back", async () => {
  const terminal = fakeTerminal();
  const running = runPanel(terminal.deps());
  await Bun.sleep(5);
  terminal.stop();
  await running;
  expect(terminal.input.raw).toEqual([true, false]);
  expect(terminal.written.at(-1)).toContain("\x1b[?1049l");
});

test("a drawing failure still puts the terminal back before it surfaces", async () => {
  const terminal = fakeTerminal();
  let calls = 0;
  const running = runPanel(
    terminal.deps({
      size: () => {
        calls += 1;
        if (calls > 1) throw new Error("no size");
        return { columns: 46, rows: 40 };
      },
    }),
  );
  await Bun.sleep(5);
  terminal.input.write("j");
  await expect(running).rejects.toThrow("no size");
  expect(terminal.input.raw).toEqual([true, false]);
  expect(terminal.written.at(-1)).toContain("\x1b[?1049l");
});

test("a go that Herdr cannot carry out says so in the footer", async () => {
  const terminal = fakeTerminal();
  const running = runPanel(
    terminal.deps({ run: async () => ({ code: 1, stdout: "", stderr: "no such workspace" }) }),
  );
  await Bun.sleep(5);
  terminal.input.write("\r");
  await Bun.sleep(5);
  terminal.stop();
  await running;
  expect(terminal.written.join("")).toContain("⚠ Herdr couldn't focus it");
});

const WORKING = panelView(
  {
    ...SNAPSHOT,
    board: boardView(
      state({
        tasks: [
          task({ id: "task-impl", repoPath: APP, stage: "implementing", objective: "Working" }),
          task({ id: "task-queued", repoPath: APP, stage: "queued", objective: "Queued" }),
        ],
        activities: new Map([
          [
            "task-impl",
            {
              tool: "edit",
              toolTarget: "src/very/deeply/nested/module/directory/session-handler.ts",
              toolStartedAt: "2030-01-01T11:59:56.000Z",
              todos: [
                { content: "Read the brief", status: "completed" },
                { content: "Write the test", status: "in_progress" },
                { content: "Make it pass", status: "pending" },
              ],
            },
          ],
        ]),
      }),
      NOW,
    ),
  },
  { project: APP, query: "", now: NOW, readFailed: false },
);

test("Space shows and hides the selected running row's steps; rows without steps ignore it", () => {
  const working = { ...frame(WORKING), view: WORKING };
  const draw = (from: PanelState) =>
    renderPanel(WORKING, from, { width: 46, color: false, popup: false }).lines.join("\n");
  const shown = panelStep(START, { kind: "char", char: " " }, working).state;
  expect(draw(shown)).toContain(
    ["      ☑ Read the brief", "      ▸ Write the test", "      ☐ Make it pass"].join("\n"),
  );
  const hidden = panelStep(shown, { kind: "char", char: " " }, working).state;
  expect(draw(hidden)).not.toContain("☑");
  const queued = WORKING.sections.flatMap((section) => section.rows)[1]?.key;
  const onQueued = panelStep({ ...START, selected: queued }, { kind: "char", char: " " }, working);
  expect(onQueued.state.expanded.size).toBe(0);
  const searching = panelStep({ ...START, query: "" }, { kind: "char", char: " " }, working);
  expect(searching.state).toMatchObject({ query: " ", expanded: new Set() });
});

test("the tool line cuts its target from the left, keeping the file name, to fit the width", () => {
  const { lines } = renderPanel(WORKING, START, { width: 46, color: false, popup: false });
  const at = lines.findIndex((line) => line.includes("▸ edit"));
  expect(lines[at]).toBe("    ▸ edit …/directory/session-handler.ts · 4s");
  expect(Bun.stringWidth(lines[at] ?? "")).toBe(46);
  expect(lines[at - 1]).toBe("    Write the test");
});
