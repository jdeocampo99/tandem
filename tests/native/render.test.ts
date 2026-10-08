import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeViewsPublication } from "../../src/board/native-views.ts";
import { blockArgs } from "../../src/native/block.ts";
import { publishViews, viewDetailPath, viewIndexPath } from "../../src/native/store.ts";
import { QUICK_TASK_FILE, setupFile, ViewFile } from "../../src/native/view-file.ts";
import { SETUP_MODES, type SetupMode } from "../../src/onboarding/setup-view.ts";
import { quickTaskView } from "../../src/tasks/quick.ts";
import { luauBinary } from "../luau.ts";
import { setupViewFixture } from "../onboarding/setup-fixture.ts";
import { taskScreenPublication } from "../tasks/task-screen-fixture.ts";
import { nativeScreensFixture } from "../tern-view/screens-fixture.ts";

const PLUGIN = fileURLToPath(new URL("../../tern-plugin/", import.meta.url));
const DRIVER = fileURLToPath(new URL("./render.luau", import.meta.url));
const JSON_CODEC = fileURLToPath(new URL("../evals/tern-parity/json.luau", import.meta.url));

type Node = Readonly<{ k: string; p?: Record<string, unknown>; c?: readonly Node[] | object }>;
type Drawn = Readonly<{ title?: string; tree?: Record<string, Node>; error?: string }>;
type Case = Readonly<{
  block: string;
  args: readonly string[];
  steps: readonly Readonly<Record<string, string | false>>[];
}>;

let home: string;
let project: string;
let files: Record<
  "index" | "task" | "brief" | "pr",
  { path: string; text: string; file: ViewFile }
>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "tdm-render-"));
  project = join(home, "repo");
  const fixture = taskScreenPublication(project);
  const screens = nativeScreensFixture();
  const publication: NativeViewsPublication = {
    ...fixture,
    bundle: {
      ...fixture.bundle,
      board: screens.board,
      usage: screens.usage,
      catchup: { ...screens.catchup, project },
    },
  };
  await publishViews(home, project, async () => publication);
  const views = join(home, "tern");
  expect((await readdir(views)).length).toBe(1);
  const read = async (path: string) => {
    const text = await readFile(path, "utf8");
    return { path, text, file: ViewFile.parse(JSON.parse(text)) };
  };
  files = {
    index: await read(viewIndexPath(home, project)),
    task: await read(viewDetailPath(home, project, "task-102.json")),
    brief: await read(viewDetailPath(home, project, "brief-req-tern.json")),
    pr: await read(viewDetailPath(home, project, "pr-owner%2Frepo-281.json")),
  };
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function args(viewPath: string): string[] {
  return blockArgs(viewPath, {
    coordinator: "20",
    cwd: project,
    home,
    index: viewIndexPath(home, project),
  });
}

/** The same file with `model` replaced and `seq` moved by `step`. */
function rewrite(kind: keyof typeof files, model: unknown, step = 1, epoch?: string): string {
  const { file } = files[kind];
  return JSON.stringify({ ...file, epoch: epoch ?? file.epoch, seq: file.seq + step, model });
}

function text(node: Node | undefined): string[] {
  if (node === undefined) return [];
  const own = ["text", "label", "placeholder"].flatMap((key) => {
    const value = node.p?.[key];
    return typeof value === "string" && value !== "" ? [value] : [];
  });
  // The JSON encoder writes an empty child list as `{}`.
  return [...own, ...(Array.isArray(node.c) ? node.c.flatMap(text) : [])];
}

function strings(drawn: Drawn): string[] {
  expect(drawn.error).toBeUndefined();
  return ["layer", "main", "dock"].flatMap((slot) => text(drawn.tree?.[slot]));
}

async function render(cases: readonly Case[]): Promise<Drawn[][]> {
  const lua = (value: unknown): string => {
    if (typeof value === "string") {
      let level = "";
      while (value.includes(`]${level}]`)) level += "=";
      return `[${level}[\n${value}]${level}]`;
    }
    if (typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return `{${value.map(lua).join(",")}}`;
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `[ ${lua(key)} ]=${lua(entry)}`)
      .join(",")}}`;
  };
  const modules: Record<string, string> = {};
  for (const name of await readdir(PLUGIN))
    if (name.endsWith(".luau"))
      modules[`./${name.slice(0, -5)}`] = await readFile(join(PLUGIN, name), "utf8");
  const source = `${await readFile(JSON_CODEC, "utf8")}\nlocal MODULES = ${lua(modules)}\nlocal CASES = ${lua(cases)}\n${await readFile(DRIVER, "utf8")}`;
  const script = join(home, "render.luau");
  await Bun.write(script, source);
  const child = Bun.spawn([luauBinary(), script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const drawn: Drawn[][] = cases.map(() => []);
  for (const line of stdout.split("\n")) {
    const match = /^@@(\d+)\t(\d+)\t(.*)$/u.exec(line);
    if (match === null) continue;
    drawn[Number(match[1]) - 1]?.push(JSON.parse(match[3] ?? "") as Drawn);
  }
  return drawn;
}

test("every view the store writes draws through its real screen", async () => {
  const index = files.index.path;
  const shown = await render([
    { block: "panel", args: args(index), steps: [{ [index]: files.index.text }] },
    { block: "board", args: args(index), steps: [{ [index]: files.index.text }] },
    { block: "usage", args: args(index), steps: [{ [index]: files.index.text }] },
    { block: "catchup", args: args(index), steps: [{ [index]: files.index.text }] },
    { block: "task-picker", args: args(index), steps: [{ [index]: files.index.text }] },
    {
      block: "task",
      args: args(files.task.path),
      steps: [{ [index]: files.index.text, [files.task.path]: files.task.text }],
    },
    {
      block: "brief",
      args: args(files.brief.path),
      steps: [{ [index]: files.index.text, [files.brief.path]: files.brief.text }],
    },
    {
      block: "pr",
      args: args(files.pr.path),
      steps: [{ [index]: files.index.text, [files.pr.path]: files.pr.text }],
    },
  ]);
  const [panel, board, usage, catchup, picker, task, brief, pr] = shown.map((steps) => {
    const [first] = steps;
    if (first === undefined) throw new Error("block drew nothing");
    return first;
  });
  expect(strings(panel ?? {})).toEqual([
    "tandem",
    "5h unavailable",
    "🔔︎ 0",
    "⎇",
    "▦",
    "⚙",
    "Needs you · 0",
    "Running · 1",
    "●",
    "Tern backend adapter",
    "fixing",
    "12m",
    "opus · editing adapter.ts",
    "Ready · 0",
    "Recently done · 0",
  ]);
  expect(strings(board ?? {})).toEqual(expect.arrayContaining(["● Working", "● Ready to merge"]));
  expect(strings(usage ?? {})).toEqual(expect.arrayContaining(["5-hour window", "Weekly"]));
  expect(strings(catchup ?? {})).toEqual(
    expect.arrayContaining([
      "Since you left",
      "Approve brief: Tern backend: brief waiting for approval",
    ]),
  );
  expect(strings(picker ?? {})).toEqual(
    expect.arrayContaining(["Tern backend adapter", "Fix the settings page"]),
  );
  expect(task?.title).toBe("Tern backend adapter");
  expect(strings(task ?? {})).toContain("task #102");
  expect(strings(task ?? {})).not.toContain(
    "Saved view unavailable. Actions are disabled until fresh data arrives.",
  );
  expect(brief?.title).toBe("Brief · Request brief");
  expect(strings(brief ?? {})).toEqual(expect.arrayContaining(["Approve"]));
  expect(pr?.title).toBe("#281 ▾");
});

test("a model that cannot draw keeps the last good one and shows the unavailable state", async () => {
  const index = files.index.path;
  const realModel = files.index.file.model;
  const [panel, fresh, wrongKind, task, brief, pr] = await render([
    {
      block: "panel",
      args: args(index),
      steps: [
        { [index]: files.index.text },
        { [index]: rewrite("index", { panel: { header: 7 } }) },
        { [index]: files.index.text },
        { [index]: "{broken" },
        { [index]: rewrite("index", realModel, 1, "a-new-store") },
        { [index]: false },
      ],
    },
    {
      block: "panel",
      args: args(index),
      steps: [
        { [index]: rewrite("index", { panel: [] }) },
        { [index]: rewrite("index", realModel, 2) },
      ],
    },
    {
      block: "panel",
      args: args(index),
      steps: [
        { [index]: files.index.text },
        {
          [index]: JSON.stringify({
            ...files.index.file,
            kind: "task",
            seq: files.index.file.seq + 1,
          }),
        },
      ],
    },
    {
      block: "task",
      args: args(files.task.path),
      steps: [
        { [index]: files.index.text, [files.task.path]: rewrite("task", { header: {} }) },
        { [files.task.path]: rewrite("task", files.task.file.model, 2) },
      ],
    },
    {
      block: "brief",
      args: args(files.brief.path),
      steps: [
        { [files.brief.path]: files.brief.text },
        { [files.brief.path]: rewrite("brief", { title: "Broken", lines: 3 }) },
        { [files.brief.path]: rewrite("brief", files.brief.file.model, 2) },
      ],
    },
    {
      block: "pr",
      args: args(files.pr.path),
      steps: [
        { [index]: files.index.text, [files.pr.path]: files.pr.text },
        { [files.pr.path]: rewrite("pr", { header: { number: 9 }, files: 4 }) },
      ],
    },
  ]);
  const unavailable = "View unavailable · actions paused";
  const [good, broken, older, torn, newStore, missing] = (panel ?? []).map(strings);
  expect(good).not.toContain(unavailable);
  expect(broken).toEqual([...(good ?? []).slice(0, 6), unavailable, ...(good ?? []).slice(6)]);
  // An older `seq` from the same store never replaces what is shown.
  expect(older).toEqual(broken);
  expect(torn).toEqual(broken);
  expect(newStore).toEqual(good);
  expect(missing).toEqual(broken);

  const [never, recovered] = (fresh ?? []).map(strings);
  expect(never).toEqual(["Waiting for Tandem's project snapshot…"]);
  expect(recovered).toEqual(good);

  // A newer file of another kind is not this block's view, however well its model draws.
  expect((wrongKind ?? []).map(strings)).toEqual([good ?? [], broken ?? []]);

  const [taskBroken, taskGood] = task ?? [];
  expect(strings(taskBroken ?? {})).toEqual([
    "Task unavailable",
    "← Orchestrator",
    "Task view unavailable. Waiting for its saved detail file.",
  ]);
  expect(strings(taskGood ?? {})).toContain("task #102");

  const [briefGood, briefBroken, briefNext] = (brief ?? []).map(strings);
  expect(briefGood).toContain("Approve");
  expect(briefBroken).toContain(
    "Brief unavailable. Actions are disabled until the view file recovers.",
  );
  expect(briefBroken).not.toContain("Approve");
  expect(briefBroken).toContain(briefGood?.find((line) => line.startsWith("Brief · ")));
  expect(briefNext).toContain("Approve");

  const [prGood, prBroken] = pr ?? [];
  expect(strings(prGood ?? {})).toContain("#281 ▾");
  expect(prBroken?.title).toBe("#281 ▾");
  expect(strings(prBroken ?? {})).toContain("#281 ▾");
});

test("the quick task composer draws its published project and holds Start until text is set", async () => {
  await publishViews(home, project, async () => ({
    quickTask: quickTaskView({ repoPath: project, branch: "main" }),
  }));
  const path = viewDetailPath(home, project, QUICK_TASK_FILE);
  const [drawn] = await render([
    { block: "quick-task", args: args(path), steps: [{ [path]: await readFile(path, "utf8") }] },
  ]);
  const shown = strings(drawn?.at(-1) ?? {});
  expect(drawn?.at(-1)?.title).toBe("Quick task");
  expect(shown).toEqual([
    "Quick task",
    "×",
    "Small, well-defined changes. No interview.",
    "Describe the change",
    "repo · main",
    "Start  ⌘↵",
  ]);
});

test("the setup block draws the published setup and settings views", async () => {
  const shown: Record<SetupMode, string[]> = { setup: [], settings: [] };
  for (const mode of SETUP_MODES) {
    await publishViews(home, project, async () => ({ setup: setupViewFixture(mode) }));
    const path = viewDetailPath(home, project, setupFile(mode));
    const [drawn] = await render([
      { block: "setup", args: args(path), steps: [{ [path]: await readFile(path, "utf8") }] },
    ]);
    shown[mode] = strings(drawn?.at(-1) ?? {});
  }
  expect(shown.setup).toContain("Set up Tandem");
  expect(shown.setup).toContain("Customize");
  expect(shown.settings).toContain("Settings");
  expect(shown.settings).not.toContain("Customize");
});
