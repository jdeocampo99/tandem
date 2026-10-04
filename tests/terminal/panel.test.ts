import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type PanelView, panelView } from "../../src/board/panel.ts";
import { type BoardSnapshot, writeBoardSnapshot } from "../../src/board/snapshot.ts";
import { boardView } from "../../src/board/view.ts";
import { runTerminal } from "../../src/main.ts";
import {
  navigationSteps,
  type PanelEffect,
  type PanelFrame,
  type PanelInput,
  type PanelState,
  panelStep,
  parsePanelInput,
  renderPanel,
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
const VIEW = panelView(SNAPSHOT, { project: APP, query: "", now: NOW });
const START: PanelState = {
  project: APP,
  query: undefined,
  selected: undefined,
  seen: undefined,
  help: false,
};

function frame(view: PanelView = VIEW, popup = false): PanelFrame {
  return { view, hits: renderPanel(view, START, { width: 46, color: false }).hits, popup, now: 0 };
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

const keys = (text: string) => parsePanelInput(text);

test("raw input splits into keys, arrows, left clicks, and focus changes", () => {
  expect(
    parsePanelInput("j\x1b[B\r\x1b\x7f\x03\x1b[<0;5;1M\x1b[<0;5;1m\x1b[<2;1;1M\x1b[I\x1b[O"),
  ).toEqual([
    { kind: "char", char: "j" },
    { kind: "down" },
    { kind: "enter" },
    { kind: "escape" },
    { kind: "backspace" },
    { kind: "interrupt" },
    { kind: "click", x: 5, y: 1 },
    { kind: "focus", focused: true },
    { kind: "focus", focused: false },
  ]);
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

test("a click on a chip switches, a click on a row selects it, and a double-click goes", () => {
  const { hits } = frame();
  const tandemChip = hits.find((hit) => hit.kind === "chip" && hit.repoPath === TANDEM);
  const working = hits.find(
    (hit) => hit.kind === "row" && hit.key === "task:task-impl:implementing",
  );
  if (tandemChip === undefined || working === undefined) throw new Error("missing hit");
  expect(press([{ kind: "click", x: tandemChip.from, y: tandemChip.y }]).effects).toEqual([
    { kind: "switch", repoPath: TANDEM },
  ]);
  const click = { kind: "click", x: 3, y: working.y } as const;
  const once = press([click]);
  expect(once.state.selected).toBe("task:task-impl:implementing");
  expect(once.effects).toEqual([]);
  expect(press([click, click], { at: [0, 300] }).effects).toEqual([
    { kind: "go", target: { kind: "pane", workspaceId: "w3", paneId: "w3:p2" } },
  ]);
  expect(press([click, click], { at: [0, 900] }).effects).toEqual([]);
});

test("the key help hides on the first key, and losing focus remembers what was seen", () => {
  expect(press(keys("j"), { from: { ...START, help: true } }).state.help).toBe(false);
  const left = press([{ kind: "focus", focused: false }]).state;
  expect(left.seen?.size).toBe(VIEW.sections.flatMap((section) => section.rows).length);
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
    { argv: herdr("workspace", "focus", "w2"), required: true },
    { argv: herdr("agent", "focus", "w2:p1"), required: false },
  ]);
  expect(
    navigationSteps(
      { kind: "go", target: { kind: "pane", workspaceId: "w3", paneId: "w3:p2" } },
      "tandem",
      COORDINATORS,
    ),
  ).toEqual([
    { argv: herdr("workspace", "focus", "w3"), required: true },
    { argv: herdr("agent", "focus", "w3:p2"), required: false },
  ]);
  expect(
    navigationSteps({ kind: "go", target: { kind: "url", url: "https://x/1" } }, "tandem", []),
  ).toEqual([{ argv: ["open", "https://x/1"], required: true }]);
  expect(navigationSteps({ kind: "switch", repoPath: TANDEM }, "tandem", COORDINATORS)).toEqual([
    { argv: herdr("workspace", "focus", "w1"), required: true },
  ]);
  expect(navigationSteps({ kind: "switch", repoPath: "/offline" }, "tandem", COORDINATORS)).toEqual(
    [],
  );
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
